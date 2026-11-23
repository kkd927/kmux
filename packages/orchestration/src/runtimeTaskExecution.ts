import { canonicalJson, contentHash, deepClone } from "./canonical";
import type {
  AgentResultSubmission,
  ContentHash,
  HumanGate,
  Id,
  JsonValue,
  NodeResult,
  OrchestrationMessage,
  ResultSubmissionReceipt,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";
import { validateJsonSchemaValue } from "./schema";
import {
  type RuntimeContext,
  mutableClone,
  isTerminalRun,
  isDurableCallerWait,
  requireNode,
  isCallerNode,
  acquireResourceLease,
  requireAttempt,
  budget,
  type Mutable,
  recordAttemptDuration,
  settleCompletedWorkerTerminal,
  queueAutomaticRetry,
  wakeCoordinator,
  TERMINAL_NODE_STATES
} from "./runtimeState";
import {
  appendMailboxEvent,
  mailboxConsumerKey,
  coordinatorMailboxConsumer,
  pendingDispatchMailboxCount
} from "./runtimeMailbox";
import {
  recomputeRun,
  applyFailurePolicy,
  resolveDataSource,
  settleStructuredLoop,
  fillForEachCapacity,
  materializeLoopIteration,
  beginSettlement
} from "./runtimeScheduling";

export function markCallerUnavailable(
  source: WorkflowRun,
  reason: string,
  context: RuntimeContext
): WorkflowRun {
  const run = mutableClone(source);
  if (isTerminalRun(run.status) || run.callerUnavailable) return run;
  run.callerUnavailable = { reason, observedAt: context.now() };
  for (const attempt of Object.values(run.attempts)) {
    if (!isDurableCallerWait(run, attempt)) continue;
    attempt.status = "uncertain";
    const node = requireNode(run, attempt.nodeId);
    node.status = "uncertain";
    node.stateRevision += 1;
  }
  for (const lease of Object.values(run.leases)) {
    if (
      lease.state === "active" &&
      lease.owner.kind === "attempt" &&
      run.attempts[lease.owner.id]?.callerTask?.state === "waiting"
    ) {
      lease.state = "uncertain";
      lease.revision += 1;
    }
  }
  if (run.status !== "settling") run.status = "needs-attention";
  return run;
}

export function startCallerTask(input: {
  leaseRuns?: readonly WorkflowRun[];
  run: WorkflowRun;
  attemptId: Id;
  repositoryIdentity: string;
  context: RuntimeContext;
}): WorkflowRun {
  if (
    input.run.callerUnavailable ||
    input.run.status === "settling" ||
    isTerminalRun(input.run.status)
  )
    throw new OrchestrationError(
      "conflict",
      "Run is no longer accepting calling Agent tasks"
    );
  const attempt = input.run.attempts[input.attemptId];
  const node = attempt && input.run.graph.nodes[attempt.nodeId];
  if (
    !attempt ||
    !node ||
    !isCallerNode(input.run, node) ||
    !input.run.coordinatorAttachment
  )
    throw new OrchestrationError(
      "invalid",
      "Attempt does not have a calling Agent"
    );
  if (attempt.callerTask) return input.run;
  if (attempt.status !== "preparing")
    throw new OrchestrationError(
      "conflict",
      "Calling Agent attempt is not preparing"
    );
  const leased = acquireResourceLease({
    leaseRuns: input.leaseRuns,
    run: input.run,
    lease: {
      resource: { kind: "worktree", identity: input.repositoryIdentity },
      owner: { kind: "attempt", id: attempt.attemptId },
      mode:
        node.definition.kind === "agent" && node.definition.config.coding
          ? "write"
          : "read",
      capacityClaim: 1
    },
    context: input.context
  });
  const run = mutableClone(leased.run);
  const waiting = requireAttempt(run, input.attemptId);
  waiting.callerTask = {
    requestId: input.context.id("caller-task"),
    state: "waiting"
  };
  waiting.status = "waiting-input";
  waiting.startedAt = input.context.now();
  const waitingNode = requireNode(run, waiting.nodeId);
  waitingNode.status = "waiting-input";
  waitingNode.stateRevision += 1;
  appendMailboxEvent(
    run,
    {
      type: "caller_task",
      target: { kind: "coordinator" },
      attemptId: waiting.attemptId
    },
    input.context
  );
  return run;
}

export function submitCallerTaskResult(input: {
  run: WorkflowRun;
  attemptId: Id;
  requestId: Id;
  submission: AgentResultSubmission;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly receipt: ResultSubmissionReceipt } {
  if (input.run.callerUnavailable)
    throw new OrchestrationError(
      "unauthorized",
      "Original calling Agent is unavailable"
    );
  const attempt = input.run.attempts[input.attemptId];
  if (!attempt?.callerTask || attempt.callerTask.requestId !== input.requestId)
    throw new OrchestrationError(
      "conflict",
      "Calling Agent request is stale or does not match its attempt"
    );
  const event = input.run.mailboxEvents.find(
    (event) =>
      event.type === "caller_task" && event.attemptId === input.attemptId
  );
  const consumer =
    input.run.mailboxConsumers[
      mailboxConsumerKey(coordinatorMailboxConsumer(input.run))
    ];
  if (!event || !consumer || consumer.acknowledgedCursor < event.sequence)
    throw new OrchestrationError(
      "conflict",
      "Read and acknowledge the calling Agent task before submitting its result"
    );
  const result = submitAttemptResult({
    run: input.run,
    attemptId: input.attemptId,
    idempotencyKey: input.requestId,
    submissionHash: contentHash(input.submission as unknown as JsonValue),
    submission: input.submission,
    trusted: {},
    context: input.context
  });
  const run = mutableClone(result.run);
  run.attempts[input.attemptId].callerTask!.state = "completed";
  return { run, receipt: result.receipt };
}

export function submitAttemptResult(input: {
  run: WorkflowRun;
  attemptId: Id;
  idempotencyKey: Id;
  submissionHash: ContentHash;
  submission: AgentResultSubmission;
  trusted: Omit<
    NodeResult,
    keyof AgentResultSubmission | "nodeId" | "attemptId"
  >;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly receipt: ResultSubmissionReceipt } {
  const replay = input.run.resultReceipts[input.idempotencyKey];
  if (replay) {
    if (
      replay.attemptId !== input.attemptId ||
      replay.submissionHash !== input.submissionHash
    ) {
      throw new OrchestrationError(
        "conflict",
        "result idempotency key was reused with different content"
      );
    }
    return { run: input.run, receipt: replay };
  }
  const expectedHash = contentHash(input.submission as unknown as JsonValue);
  if (expectedHash !== input.submissionHash) {
    throw new OrchestrationError("invalid", "result submission hash mismatch");
  }
  const sourceAttempt = input.run.attempts[input.attemptId];
  if (!sourceAttempt)
    throw new OrchestrationError("not-found", "attempt was not found");
  const sourceNode = input.run.graph.nodes[sourceAttempt.nodeId];
  if (sourceNode?.activeAttemptId !== input.attemptId) {
    throw new OrchestrationError(
      "immutable",
      "stale attempt cannot settle its node or retry"
    );
  }
  if (
    sourceAttempt.status !== "running" &&
    sourceAttempt.status !== "waiting-input"
  ) {
    throw new OrchestrationError(
      "conflict",
      "attempt is not accepting a result"
    );
  }
  if (
    sourceAttempt.dispatchId &&
    pendingDispatchMailboxCount(input.run, sourceAttempt.dispatchId) > 0
  ) {
    throw new OrchestrationError(
      "conflict",
      `Worker mailbox is not drained; run \`kmux orchestration check --dispatch ${sourceAttempt.dispatchId}\`, process the Delivery, and ack it before worker-done`
    );
  }
  if (sourceNode.definition.resultSchema) {
    if (input.submission.data === undefined) {
      throw new OrchestrationError(
        "invalid",
        `node '${sourceNode.nodeId}' requires structured result data`
      );
    }
    const validated = validateJsonSchemaValue(
      sourceNode.definition.resultSchema,
      input.submission.data
    );
    if (!validated.ok) {
      throw new OrchestrationError(
        "invalid",
        `node '${sourceNode.nodeId}' result data does not match its schema`,
        { issues: validated.issues as unknown as JsonValue }
      );
    }
  }
  const resultSize = Buffer.byteLength(
    canonicalJson(input.submission as unknown as JsonValue)
  );
  if (
    input.run.counters.structuredResultBytes + resultSize >
    input.run.limits.maxStructuredResultBytes
  ) {
    throw budget("maxStructuredResultBytes");
  }
  const artifactBytes = (input.submission.artifacts ?? []).reduce(
    (total, artifact) => total + artifact.sizeBytes,
    0
  );
  if (
    input.run.counters.artifactBytes + artifactBytes >
    input.run.limits.maxArtifactBytes
  ) {
    throw budget("maxArtifactBytes");
  }

  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  const settledAt = input.context.now();
  const result: NodeResult = {
    ...deepClone(input.submission),
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    ...deepClone(input.trusted)
  };
  run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;
  attempt.status = input.submission.outcome;
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = input.submission.outcome;
  node.activeAttemptId = undefined;
  node.selectedPort =
    input.submission.outcome === "succeeded"
      ? "success"
      : input.submission.outcome === "failed"
        ? "failure"
        : "canceled";
  node.stateRevision += 1;
  run.counters.activeAttempts -= 1;
  run.counters.structuredResultBytes += resultSize;
  run.counters.artifactBytes += artifactBytes;
  const receipt: ResultSubmissionReceipt = {
    receiptId: input.context.id("result-receipt"),
    attemptId: attempt.attemptId,
    idempotencyKey: input.idempotencyKey,
    submissionHash: input.submissionHash,
    settledAt
  };
  run.resultReceipts[input.idempotencyKey] =
    receipt as Mutable<ResultSubmissionReceipt>;
  for (const lease of Object.values(run.leases)) {
    if (
      lease.owner.kind === "attempt" &&
      lease.owner.id === attempt.attemptId &&
      lease.state === "active"
    ) {
      lease.state = "released";
      lease.revision += 1;
    }
  }
  // Retry may return before publishing the final node result, but it still
  // needs the completed Attempt's exact terminal to be reclaimable.
  settleCompletedWorkerTerminal(run, attempt, settledAt);
  const failureClass = input.submission.failureClass ?? "executor-error";
  if (
    input.submission.outcome === "failed" &&
    queueAutomaticRetry(run, node, attempt, failureClass, input.context)
  ) {
    return { run: recomputeRun(run, input.context), receipt };
  }
  run.results[node.nodeId] = result as Mutable<NodeResult>;
  const dispatch = attempt.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  if (dispatch) {
    appendMailboxEvent(
      run,
      {
        type: "worker_done",
        target: { kind: "coordinator" },
        attemptId: attempt.attemptId
      },
      input.context
    );
  }
  if (run.graph.authoringState === "open") {
    wakeCoordinator(run);
  }
  applyFailurePolicy(run, node, input.context);
  return { run: recomputeRun(run, input.context), receipt };
}

export function settleControlNode(input: {
  run: WorkflowRun;
  attemptId: Id;
  outcome: "succeeded" | "failed" | "canceled";
  selectedPort?: string;
  data?: JsonValue;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  if (node.activeAttemptId !== attempt.attemptId) {
    throw new OrchestrationError(
      "immutable",
      "stale control attempt cannot settle a node"
    );
  }
  if (TERMINAL_NODE_STATES.has(node.status)) return run;
  const settledAt = input.context.now();
  attempt.status = input.outcome;
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = input.outcome;
  node.activeAttemptId = undefined;
  node.selectedPort =
    input.selectedPort ??
    (input.outcome === "succeeded"
      ? "success"
      : input.outcome === "failed"
        ? "failure"
        : "canceled");
  node.stateRevision += 1;
  run.counters.activeAttempts -= 1;
  const controlResult: NodeResult = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome: input.outcome,
    summary: `${node.definition.kind} node ${input.outcome}`,
    ...(input.data === undefined ? {} : { data: deepClone(input.data) })
  };
  run.attemptResults[attempt.attemptId] = controlResult as Mutable<NodeResult>;
  run.results[node.nodeId] = controlResult as Mutable<NodeResult>;
  applyFailurePolicy(run, node, input.context);
  return recomputeRun(run, input.context);
}

export function startStructuredLoop(input: {
  run: WorkflowRun;
  attemptId: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  if (node.definition.kind !== "loop") {
    throw new OrchestrationError(
      "invalid",
      "attempt does not belong to a Loop"
    );
  }
  if (attempt.status !== "preparing") {
    throw new OrchestrationError("conflict", "only a preparing Loop can start");
  }
  attempt.status = "running";
  attempt.startedAt = input.context.now();
  node.status = "running";
  node.stateRevision += 1;
  if (node.definition.config.mode === "for-each") {
    const collection = resolveDataSource(
      run,
      node.definition.config.collection,
      node
    );
    if (!Array.isArray(collection)) {
      return recomputeRun(
        settleStructuredLoop(
          run,
          node,
          attempt,
          "failed",
          "failure",
          input.context,
          { error: "for-each collection did not resolve to an array" }
        ),
        input.context
      );
    }
    if (collection.length > node.definition.config.maxItems) {
      node.loopState = {
        iteration: 0,
        invocation: 0,
        frozenItems: deepClone(collection),
        activeIterationIds: [],
        completedIterationIds: [],
        accumulated: [],
        outcome: "max-reached"
      };
      return recomputeRun(
        settleStructuredLoop(
          run,
          node,
          attempt,
          "succeeded",
          node.definition.config.maxReachedPort,
          input.context,
          {
            itemCount: collection.length,
            maximum: node.definition.config.maxItems
          }
        ),
        input.context
      );
    }
    node.loopState = {
      iteration: 0,
      invocation: 0,
      frozenItems: deepClone(collection),
      activeIterationIds: [],
      completedIterationIds: [],
      accumulated: []
    };
    fillForEachCapacity(run, node, input.context);
    if (collection.length === 0) {
      return recomputeRun(
        settleStructuredLoop(
          run,
          node,
          attempt,
          "succeeded",
          node.definition.config.completedPort,
          input.context,
          { items: [], accumulated: [] }
        ),
        input.context
      );
    }
  } else {
    const carry = Object.fromEntries(
      (node.definition.config.carry ?? []).flatMap((entry) => {
        const value = resolveDataSource(run, entry.initial, node);
        return value === undefined ? [] : [[entry.inputId, deepClone(value)]];
      })
    );
    node.loopState = {
      iteration: 0,
      invocation: 0,
      activeIterationIds: [],
      completedIterationIds: [],
      carry
    };
    materializeLoopIteration(run, node, undefined, input.context);
  }
  return recomputeRun(run, input.context);
}

export function openHumanGate(input: {
  run: WorkflowRun;
  attemptId: Id;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly gate: HumanGate } {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  if (node.definition.kind !== "human-gate") {
    throw new OrchestrationError(
      "invalid",
      "attempt does not belong to a Human Gate node"
    );
  }
  const existing = Object.values(run.gates).find(
    (gate) => gate.nodeId === node.nodeId
  );
  if (existing) return { run, gate: existing };
  const gateId = input.context.id("gate");
  const gate: Mutable<HumanGate> = {
    gateId,
    runId: run.runId,
    nodeId: node.nodeId,
    question: node.definition.config.question,
    resolutions: [...node.definition.config.resolutions],
    state: "open"
  };
  run.gates[gateId] = gate;
  node.status = "waiting-gate";
  node.stateRevision += 1;
  attempt.status = "waiting-input";
  run.status = "waiting-gate";
  return { run, gate };
}

export function resolveHumanGate(input: {
  run: WorkflowRun;
  gateId: Id;
  resolution: string;
  principal: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const gate = run.gates[input.gateId];
  if (!gate)
    throw new OrchestrationError("not-found", "Human Gate was not found");
  if (gate.state === "resolved") {
    if (gate.resolution !== input.resolution)
      throw new OrchestrationError(
        "conflict",
        "Human Gate already has another resolution"
      );
    return run;
  }
  if (gate.state === "canceled") {
    throw new OrchestrationError(
      "immutable",
      "a canceled Human Gate cannot be resolved"
    );
  }
  if (!gate.resolutions.includes(input.resolution)) {
    throw new OrchestrationError(
      "invalid",
      "Human Gate resolution is not permitted"
    );
  }
  gate.state = "resolved";
  gate.resolution = input.resolution;
  gate.resolvedBy = input.principal;
  gate.resolvedAt = input.context.now();
  const node = requireNode(run, gate.nodeId);
  const attempt = node.activeAttemptId
    ? requireAttempt(run, node.activeAttemptId)
    : undefined;
  if (!attempt)
    throw new OrchestrationError(
      "conflict",
      "Human Gate has no active attempt"
    );
  attempt.status = "succeeded";
  attempt.settledAt = gate.resolvedAt;
  recordAttemptDuration(run, attempt, gate.resolvedAt);
  node.status = "succeeded";
  node.activeAttemptId = undefined;
  node.selectedPort = input.resolution;
  node.stateRevision += 1;
  run.counters.activeAttempts -= 1;
  run.results[node.nodeId] = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome: "succeeded",
    summary: `Human Gate resolved: ${input.resolution}`,
    data: { resolution: input.resolution }
  };
  run.attemptResults[attempt.attemptId] = run.results[node.nodeId]!;
  return recomputeRun(run, input.context);
}

export function postOrchestrationMessage(input: {
  run: WorkflowRun;
  kind: OrchestrationMessage["kind"];
  principal: Id;
  body: JsonValue;
  nodeId?: Id;
  attemptId?: Id;
  replyToMessageId?: Id;
  wakeCoordinator?: boolean;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly message: OrchestrationMessage } {
  if (Buffer.byteLength(canonicalJson(input.body), "utf8") > 256 * 1024) {
    throw new OrchestrationError(
      "budget-exhausted",
      "orchestration message exceeds the local v1 256-KiB limit"
    );
  }
  const run = mutableClone(input.run);
  const attempt = input.attemptId
    ? requireAttempt(run, input.attemptId)
    : undefined;
  const nodeId = input.nodeId ?? attempt?.nodeId;
  if (nodeId && !run.graph.nodes[nodeId]) {
    throw new OrchestrationError("not-found", "message node was not found");
  }
  if (attempt && nodeId !== attempt.nodeId) {
    throw new OrchestrationError(
      "invalid",
      "message attempt does not belong to the selected node"
    );
  }
  if (
    attempt &&
    ["guidance", "reply", "question", "escalation", "heartbeat"].includes(
      input.kind
    ) &&
    !["running", "waiting-input"].includes(attempt.status)
  ) {
    throw new OrchestrationError(
      "conflict",
      "completed Dispatches do not accept new orchestration messages"
    );
  }
  const replyTo = input.replyToMessageId
    ? run.messages.find(
        (message) => message.messageId === input.replyToMessageId
      )
    : undefined;
  if (input.kind === "reply" && !replyTo) {
    throw new OrchestrationError(
      "invalid",
      "reply messages require an existing replyToMessageId"
    );
  }
  if (input.kind !== "reply" && input.replyToMessageId) {
    throw new OrchestrationError(
      "invalid",
      "replyToMessageId is only valid for reply messages"
    );
  }
  if (
    input.kind === "reply" &&
    replyTo?.kind !== "question" &&
    replyTo?.kind !== "escalation"
  ) {
    throw new OrchestrationError(
      "invalid",
      "reply messages must resolve a question or escalation"
    );
  }
  if (
    input.kind === "reply" &&
    attempt &&
    replyTo?.attemptId !== attempt.attemptId
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "reply target does not belong to this Worker Dispatch"
    );
  }
  const message: OrchestrationMessage = {
    messageId: input.context.id("message"),
    runId: run.runId,
    kind: input.kind,
    principal: input.principal,
    ...(nodeId ? { nodeId } : {}),
    ...(attempt ? { attemptId: attempt.attemptId } : {}),
    ...(replyTo ? { replyToMessageId: replyTo.messageId } : {}),
    body: deepClone(input.body),
    createdAt: input.context.now()
  };
  run.messages.push(message as Mutable<OrchestrationMessage>);
  if (input.kind === "heartbeat") {
    const dispatch = attempt?.dispatchId
      ? run.dispatches[attempt.dispatchId]
      : undefined;
    const phase =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? input.body.phase
        : undefined;
    if (
      !dispatch ||
      typeof phase !== "string" ||
      !phase.trim() ||
      phase.length > 256
    ) {
      throw new OrchestrationError(
        "invalid",
        "heartbeat requires an active Dispatch and a phase"
      );
    }
    dispatch.lastHeartbeat = {
      receivedAt: message.createdAt,
      phase: phase.trim()
    };
  }
  if (
    input.kind === "question" ||
    input.kind === "escalation" ||
    input.kind === "guidance" ||
    input.kind === "reply"
  ) {
    const dispatch = attempt?.dispatchId
      ? run.dispatches[attempt.dispatchId]
      : undefined;
    const target =
      input.kind === "question" || input.kind === "escalation"
        ? ({ kind: "coordinator" } as const)
        : dispatch
          ? ({ kind: "dispatch", dispatchId: dispatch.dispatchId } as const)
          : undefined;
    if (!target) {
      throw new OrchestrationError(
        "invalid",
        "Worker-bound mailbox messages require an active Dispatch"
      );
    }
    appendMailboxEvent(
      run,
      {
        type: input.kind,
        target,
        messageId: message.messageId,
        ...(attempt ? { attemptId: attempt.attemptId } : {})
      },
      input.context
    );
  }
  if (attempt && (input.kind === "question" || input.kind === "escalation")) {
    attempt.status = "waiting-input";
    const node = run.graph.nodes[attempt.nodeId];
    if (node && node.status === "running") {
      node.status = "waiting-input";
      node.stateRevision += 1;
    }
  }
  if (
    (input.kind === "guidance" ||
      input.kind === "reply" ||
      input.kind === "question" ||
      input.kind === "escalation") &&
    run.graph.authoringState === "open" &&
    input.wakeCoordinator !== false
  ) {
    wakeCoordinator(run);
  }
  return { run: recomputeRun(run, input.context), message };
}

export function fireDueTimers(input: {
  run: WorkflowRun;
  observedAt: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  for (const timer of Object.values(run.timers)) {
    if (
      timer.state !== "pending" ||
      Date.parse(timer.dueAt) > Date.parse(input.observedAt)
    ) {
      continue;
    }
    timer.state = "fired";
    if (timer.kind === "run-deadline") {
      beginSettlement(run, "failed", input.context);
      for (const attempt of Object.values(run.attempts)) {
        if (
          attempt.status === "cancel-requested" &&
          !Object.values(run.cancellations).some(
            (operation) => operation.attemptId === attempt.attemptId
          )
        ) {
          const operationId = input.context.id("cancellation");
          run.cancellations[operationId] = {
            operationId,
            attemptId: attempt.attemptId,
            idempotencyKey: `${timer.effectIdempotencyKey}:${attempt.attemptId}`,
            requestedAt: input.context.now(),
            state: "requested"
          };
        }
      }
    } else if (timer.kind === "timeout" && timer.attemptId) {
      const attempt = run.attempts[timer.attemptId];
      if (
        attempt &&
        ["preparing", "delivery-pending", "running", "waiting-input"].includes(
          attempt.status
        )
      ) {
        const node = requireNode(run, attempt.nodeId);
        const policy = node.definition.timeoutPolicy?.onTimeout;
        if (
          policy === "needs-attention" ||
          (policy === "wake-coordinator" && run.graph.authoringState !== "open")
        ) {
          node.status = "needs-attention";
          node.stateRevision += 1;
          run.status = "needs-attention";
        } else if (policy === "cancel-and-retry" || policy === "fail") {
          const operationId = input.context.id("cancellation");
          run.cancellations[operationId] = {
            operationId,
            attemptId: attempt.attemptId,
            idempotencyKey: timer.effectIdempotencyKey,
            requestedAt: input.context.now(),
            state: "requested",
            timeout: { timerId: timer.timerId, onTimeout: policy }
          };
          attempt.status = "cancel-requested";
          node.status = "cancel-requested";
          node.stateRevision += 1;
        } else if (
          policy === "wake-coordinator" &&
          run.graph.authoringState === "open"
        ) {
          wakeCoordinator(run);
        }
      }
    }
  }
  return recomputeRun(run, input.context);
}
