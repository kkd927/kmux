import { assertLeaseAvailable } from "./runtimeState";
import type { WorkerOutputArchive } from "./types";
import { canonicalJson, contentHash, deepClone } from "./canonical";
import type {
  AgentLaunchReceipt,
  AgentResultSubmission,
  AgentReadinessReceipt,
  AttemptInputControl,
  ContentHash,
  Dispatch,
  Id,
  IsoTimestamp,
  InputIntervention,
  JsonValue,
  NodeAttempt,
  NodeResult,
  PromptDelivery,
  ResourceLease,
  RepositoryStateRef,
  TerminalExecutionRef,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";
import { resolveWorkflowAgentLaunchPreferences } from "./launchPreferences";
import {
  type RuntimeContext,
  mutableClone,
  requireNode,
  stale,
  isTerminalRun,
  assertRunTimeBudgets,
  budget,
  isCallerNode,
  type Mutable,
  resolveSelectedAgentId,
  resolveBindingInstanceKey,
  requireAttempt,
  terminalExecutionIdentity,
  settleCompletedWorkerTerminal
} from "./runtimeState";
import {
  recordNodeAdmissionFailure,
  recomputeRun,
  resolveNodeInputs,
  applyFailurePolicy
} from "./runtimeScheduling";
import { submitAttemptResult } from "./runtimeTaskExecution";

/** Record a permanent pre-effect failure through the node's canonical policy. */
export function failNodeAdmission(input: {
  run: WorkflowRun;
  nodeId: Id;
  error: OrchestrationError;
  context: RuntimeContext;
}): WorkflowRun {
  const { error } = input;
  if (
    (error.code !== "invalid" &&
      error.code !== "unsupported" &&
      error.code !== "budget-exhausted") ||
    (error.code === "budget-exhausted" &&
      error.details?.limit === "maxActiveAttempts")
  ) {
    // Revision races, transient capacity and uncertain effects are not failures.
    throw error;
  }
  const run = mutableClone(input.run);
  const node = requireNode(run, input.nodeId);
  if (node.status !== "ready") {
    throw new OrchestrationError(
      "conflict",
      "only a ready node can fail admission"
    );
  }
  recordNodeAdmissionFailure(
    run,
    node,
    {
      class: "admission",
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    },
    input.context
  );
  return recomputeRun(run, input.context);
}

export function admitNode(input: {
  run: WorkflowRun;
  nodeId: Id;
  expectedGraphRevision: number;
  expectedNodeStateRevision: number;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly attempt: NodeAttempt } {
  if (input.expectedGraphRevision !== input.run.graph.revision) {
    throw stale(
      "Scheduler admission",
      input.run.graph.revision,
      input.expectedGraphRevision
    );
  }
  const sourceNode = input.run.graph.nodes[input.nodeId];
  if (!sourceNode)
    throw new OrchestrationError(
      "not-found",
      `node '${input.nodeId}' was not found`
    );
  if (sourceNode.stateRevision !== input.expectedNodeStateRevision) {
    throw stale(
      "node admission",
      sourceNode.stateRevision,
      input.expectedNodeStateRevision
    );
  }
  if (sourceNode.status !== "ready") {
    throw new OrchestrationError(
      "conflict",
      `node '${input.nodeId}' is not ready`
    );
  }
  if (input.run.status === "settling" || isTerminalRun(input.run.status)) {
    throw new OrchestrationError("conflict", "Run is not admitting new work");
  }
  if (input.run.callerUnavailable)
    throw new OrchestrationError(
      "conflict",
      "Calling Agent is unavailable; this Run requires attention"
    );
  assertRunTimeBudgets(input.run, input.context.now());
  if (input.run.counters.activeAttempts >= input.run.limits.maxActiveAttempts) {
    throw budget("maxActiveAttempts");
  }
  const isDispatch =
    sourceNode.definition.kind === "agent" &&
    !isCallerNode(input.run, sourceNode);
  if (
    isDispatch &&
    input.run.counters.dispatches >= input.run.limits.maxDispatches
  ) {
    throw budget("maxDispatches");
  }

  const run = mutableClone(input.run);
  const node = requireNode(run, input.nodeId);
  const attemptId = input.context.id("attempt");
  const attempt: Mutable<NodeAttempt> = {
    attemptId,
    runId: run.runId,
    nodeId: node.nodeId,
    ordinal: node.attemptIds.length + 1,
    status: "preparing",
    createdAt: input.context.now(),
    effectiveDefinitionHash: node.definitionHash,
    effectiveGraphRevision: run.graph.revision,
    effectiveNodeStateRevision: node.stateRevision,
    resolvedInputs: resolveNodeInputs(run, node),
    ...(node.materialization
      ? { materializationPath: deepClone(node.materialization.path) }
      : {}),
    inputInterventionIds: []
  };
  if (node.attemptIds.length > 0) {
    attempt.retryOfAttemptId = node.attemptIds[node.attemptIds.length - 1];
  }
  if (node.definition.timeoutPolicy) {
    const dueAt = new Date(
      Date.parse(attempt.createdAt) + node.definition.timeoutPolicy.timeoutMs
    ).toISOString();
    attempt.dueAt = dueAt;
    const timerId = input.context.id("timer");
    run.timers[timerId] = {
      timerId,
      runId: run.runId,
      attemptId,
      kind: "timeout",
      dueAt,
      policyVersion: 1,
      state: "pending",
      effectIdempotencyKey: input.context.id("timer-effect")
    };
  }
  run.attempts[attemptId] = attempt;
  node.attemptIds.push(attemptId);
  node.activeAttemptId = attemptId;
  node.status = "preparing";
  node.stateRevision += 1;
  run.counters.activeAttempts += 1;
  if (node.definition.kind === "agent") {
    const definition = node.definition;
    const agentRef = definition.config.agentRef;
    const binding = run.graph.agentBindings[agentRef];
    if (!binding)
      throw new OrchestrationError(
        "invalid",
        `agent binding '${agentRef}' is unresolved`
      );
    if (binding.agent.kind === "caller") {
      if (!run.coordinatorAttachment)
        throw new OrchestrationError(
          "invalid",
          "Calling Agent attachment is missing"
        );
      attempt.effectiveInputMode = "orchestrated";
      return { run, attempt: deepClone(attempt) };
    }
    const requestedLaunch = resolveWorkflowAgentLaunchPreferences(
      binding.launch,
      definition.config.launch
    );
    if (requestedLaunch.effort && !requestedLaunch.model) {
      throw new OrchestrationError(
        "invalid",
        "resolved Agent effort requires a resolved model"
      );
    }
    attempt.effectiveInputMode = binding.inputMode;
    const selectedAgentId = resolveSelectedAgentId(run, binding);
    const bindingInstanceKey = resolveBindingInstanceKey(
      run,
      node,
      agentRef,
      binding
    );
    const dispatchId = input.context.id("dispatch");
    attempt.dispatchId = dispatchId;
    run.dispatches[dispatchId] = {
      dispatchId,
      runId: run.runId,
      nodeId: node.nodeId,
      attemptId,
      agentRef,
      selectedAgentId,
      bindingInstanceKey,
      lifecycleMode: definition.config.lifecycleMode,
      requestedBinding: deepClone(binding) as Mutable<typeof binding>,
      requestedLaunch: deepClone(requestedLaunch)
    };
    run.counters.dispatches += 1;
  }
  return { run, attempt: deepClone(attempt) };
}

export function markAttemptRunning(input: {
  run: WorkflowRun;
  attemptId: Id;
  startedAt: string;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (attempt.status === "running") return run;
  if (attempt.status !== "preparing" && attempt.status !== "delivery-pending") {
    throw new OrchestrationError(
      "conflict",
      "only a preparing attempt can start"
    );
  }
  const node = requireNode(run, attempt.nodeId);
  attempt.status = "running";
  attempt.startedAt = input.startedAt;
  node.status = "running";
  node.stateRevision += 1;
  return run;
}

export function recordShellExecutionIntent(input: {
  run: WorkflowRun;
  attemptId: Id;
  operationId: Id;
  commandHash: ContentHash;
  context: RuntimeContext;
}): WorkflowRun {
  const replay = input.run.shellOperations[input.operationId];
  if (replay) {
    if (
      replay.attemptId !== input.attemptId ||
      replay.commandHash !== input.commandHash
    ) {
      throw new OrchestrationError(
        "conflict",
        "Shell operation ID was reused with different intent"
      );
    }
    return input.run;
  }
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  if (node.definition.kind !== "shell" || attempt.status !== "preparing") {
    throw new OrchestrationError(
      "conflict",
      "Shell intent requires a preparing Shell attempt"
    );
  }
  run.shellOperations[input.operationId] = {
    operationId: input.operationId,
    runId: run.runId,
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    commandHash: input.commandHash,
    state: "intent-recorded",
    createdAt: input.context.now()
  };
  return run;
}

export function bindShellExecution(input: {
  run: WorkflowRun;
  operationId: Id;
  execution: TerminalExecutionRef;
  processId: number;
  startedAt: IsoTimestamp;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const operation = run.shellOperations[input.operationId];
  if (!operation) {
    throw new OrchestrationError("not-found", "Shell operation was not found");
  }
  if (operation.state === "executing") {
    if (
      canonicalJson(operation.execution as unknown as JsonValue) !==
        canonicalJson(input.execution as unknown as JsonValue) ||
      operation.processId !== input.processId
    ) {
      throw new OrchestrationError(
        "conflict",
        "Shell operation was rebound to another process"
      );
    }
    return run;
  }
  if (operation.state !== "intent-recorded") {
    throw new OrchestrationError(
      "immutable",
      "Shell operation already settled"
    );
  }
  operation.state = "executing";
  operation.execution = deepClone(input.execution);
  operation.processId = input.processId;
  return markAttemptRunning({
    run,
    attemptId: operation.attemptId,
    startedAt: input.startedAt
  });
}

export function settleShellExecution(input: {
  run: WorkflowRun;
  operationId: Id;
  exitCode: number;
  outputHash: ContentHash;
  outputBytes: number;
  submission: AgentResultSubmission;
  context: RuntimeContext;
}): WorkflowRun {
  const source = input.run.shellOperations[input.operationId];
  if (!source) {
    throw new OrchestrationError("not-found", "Shell operation was not found");
  }
  if (source.state === "applied") {
    if (
      source.exitCode !== input.exitCode ||
      source.outputHash !== input.outputHash ||
      source.outputBytes !== input.outputBytes
    ) {
      throw new OrchestrationError(
        "conflict",
        "settled Shell operation was replayed with different evidence"
      );
    }
    return input.run;
  }
  if (source.state !== "executing" || !source.execution) {
    throw new OrchestrationError(
      "conflict",
      "Shell operation has no executing process receipt"
    );
  }
  const run = mutableClone(input.run);
  const operation = run.shellOperations[input.operationId]!;
  operation.state = "applied";
  operation.exitCode = input.exitCode;
  operation.outputHash = input.outputHash;
  operation.outputBytes = input.outputBytes;
  operation.receiptId = input.context.id("shell-receipt");
  operation.settledAt = input.context.now();
  return submitAttemptResult({
    run,
    attemptId: operation.attemptId,
    idempotencyKey: `shell-result:${operation.operationId}`,
    submissionHash: contentHash(input.submission as unknown as JsonValue),
    submission: input.submission,
    trusted: {
      shellExecutionReceipt: {
        operationId: operation.operationId,
        execution: source.execution,
        commandHash: operation.commandHash,
        exitCode: input.exitCode,
        outputHash: input.outputHash,
        outputBytes: input.outputBytes
      }
    },
    context: input.context
  }).run;
}

export function markShellExecutionOutcomeUnknown(input: {
  run: WorkflowRun;
  operationId: Id;
  reason?: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const operation = run.shellOperations[input.operationId];
  if (!operation) {
    throw new OrchestrationError("not-found", "Shell operation was not found");
  }
  if (operation.state === "applied") return run;
  operation.state = "outcome-unknown";
  if (input.reason) operation.issue = input.reason.slice(0, 4_096);
  operation.settledAt = input.context.now();
  const attempt = requireAttempt(run, operation.attemptId);
  const node = requireNode(run, attempt.nodeId);
  attempt.status = "uncertain";
  node.status = "uncertain";
  node.stateRevision += 1;
  run.status = "needs-attention";
  return run;
}

export function prepareAgentPromptDelivery(input: {
  leaseRuns?: readonly WorkflowRun[];
  run: WorkflowRun;
  attemptId: Id;
  execution: TerminalExecutionRef;
  readiness: AgentReadinessReceipt;
  expectedInputControlRevision?: number;
  payloadHash: ContentHash;
  repositoryStateInput?: RepositoryStateRef;
  launchReceipt: AgentLaunchReceipt;
  operationId?: Id;
  context: RuntimeContext;
}): {
  readonly run: WorkflowRun;
  readonly delivery: PromptDelivery;
} {
  const source = input.run.inputControls[input.attemptId]
    ? input.run
    : prepareAttemptInputControl({
        run: input.run,
        attemptId: input.attemptId,
        execution: input.execution,
        launchReceipt: input.launchReceipt,
        context: input.context
      });
  const sourceAttempt = source.attempts[input.attemptId];
  if (!sourceAttempt) {
    throw new OrchestrationError("not-found", "attempt was not found");
  }
  const sourceDispatch = sourceAttempt.dispatchId
    ? source.dispatches[sourceAttempt.dispatchId]
    : undefined;
  if (!sourceDispatch) {
    throw new OrchestrationError("invalid", "attempt has no Agent Dispatch");
  }
  assertLaunchReceipt(sourceDispatch, input.launchReceipt);
  const retryPlacement = requiredAgentPlacement(source, sourceAttempt);
  if (retryPlacement) {
    const priorReadiness = retryPlacement.readinessReceiptId
      ? source.readinessReceipts[retryPlacement.readinessReceiptId]
      : undefined;
    if (
      (priorReadiness &&
        (input.readiness.agentInstanceId !== priorReadiness.agentInstanceId ||
          input.readiness.verifiedProviderSessionId !==
            priorReadiness.verifiedProviderSessionId)) ||
      (retryPlacement.repositoryStateInput?.worktreeRef &&
        canonicalJson(retryPlacement.repositoryStateInput.worktreeRef) !==
          canonicalJson(input.repositoryStateInput?.worktreeRef ?? null))
    ) {
      throw new OrchestrationError(
        "conflict",
        "exact Agent retry requires the previous provider instance and worktree"
      );
    }
  }
  const replay = input.operationId
    ? source.deliveries[input.operationId]
    : undefined;
  if (replay) {
    if (
      replay.dispatchId !== sourceDispatch.dispatchId ||
      replay.payloadHash !== input.payloadHash ||
      replay.readinessReceiptId !== input.readiness.receiptId ||
      canonicalJson(replay.execution as unknown as JsonValue) !==
        canonicalJson(input.execution as unknown as JsonValue)
    ) {
      throw new OrchestrationError(
        "conflict",
        "prompt delivery operation ID was reused with different content"
      );
    }
    return { run: source, delivery: replay };
  }
  if (sourceAttempt.status !== "preparing") {
    throw new OrchestrationError(
      "conflict",
      "only a preparing Agent attempt can bind prompt delivery"
    );
  }
  assertRuntimeInputAuthority({
    run: source,
    attemptId: input.attemptId,
    expectedExecution: input.execution
  });
  const control = source.inputControls[input.attemptId]!;
  if (
    (input.expectedInputControlRevision !== undefined &&
      control.revision !== input.expectedInputControlRevision) ||
    (control.readinessInvalidatedAt !== undefined &&
      Date.parse(input.readiness.observedAt) <=
        Date.parse(control.readinessInvalidatedAt))
  ) {
    throw new OrchestrationError(
      "conflict",
      "input intervention requires fresh Agent readiness and repository capture"
    );
  }
  if (
    canonicalJson(input.readiness.execution as unknown as JsonValue) !==
      canonicalJson(input.execution as unknown as JsonValue) ||
    input.readiness.agentId !== sourceDispatch.selectedAgentId
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "Agent readiness does not match the Dispatch execution and binding"
    );
  }
  if (input.readiness.state !== "ready-for-input") {
    throw new OrchestrationError("conflict", "Agent is not ready for input");
  }
  if (
    Object.values(source.deliveries).some(
      (delivery) =>
        delivery.readinessReceiptId === input.readiness.receiptId &&
        delivery.dispatchId !== sourceDispatch.dispatchId
    )
  ) {
    throw new OrchestrationError(
      "conflict",
      "Agent readiness receipt has already admitted another Dispatch"
    );
  }
  const identity = terminalExecutionIdentity(input.execution);
  const attemptsInSession = Object.values(source.dispatches).filter(
    (dispatch) =>
      dispatch.dispatchId !== sourceDispatch.dispatchId &&
      dispatch.execution &&
      terminalExecutionIdentity(dispatch.execution) === identity
  ).length;
  if (attemptsInSession >= source.limits.maxAttemptsPerSession) {
    throw budget("maxAttemptsPerSession");
  }
  const capacityConflict = Object.values(source.dispatches).some((dispatch) => {
    if (
      dispatch.dispatchId === sourceDispatch.dispatchId ||
      !dispatch.execution ||
      terminalExecutionIdentity(dispatch.execution) !== identity
    ) {
      return false;
    }
    const attempt = source.attempts[dispatch.attemptId];
    return Boolean(
      attempt &&
      [
        "preparing",
        "delivery-pending",
        "running",
        "waiting-input",
        "cancel-requested",
        "cancel-uncertain",
        "uncertain"
      ].includes(attempt.status)
    );
  });
  if (capacityConflict) {
    throw new OrchestrationError(
      "conflict",
      "terminal generation already has an active managed Dispatch"
    );
  }

  const run = mutableClone(source);
  const attempt = requireAttempt(run, input.attemptId);
  const dispatch = run.dispatches[attempt.dispatchId!];
  if (!dispatch) {
    throw new OrchestrationError("invalid", "attempt has no Agent Dispatch");
  }
  const operationId = input.operationId ?? input.context.id("prompt-delivery");
  dispatch.execution = deepClone(input.execution) as Mutable<
    typeof input.execution
  >;
  dispatch.readinessReceiptId = input.readiness.receiptId;
  dispatch.deliveryOperationId = operationId;
  if (input.repositoryStateInput) {
    dispatch.repositoryStateInput = deepClone(
      input.repositoryStateInput
    ) as Mutable<RepositoryStateRef>;
  }
  run.readinessReceipts[input.readiness.receiptId] = deepClone(
    input.readiness
  ) as Mutable<AgentReadinessReceipt>;
  const delivery: Mutable<PromptDelivery> = {
    operationId,
    dispatchId: dispatch.dispatchId,
    execution: deepClone(input.execution) as Mutable<typeof input.execution>,
    readinessReceiptId: input.readiness.receiptId,
    payloadHash: input.payloadHash,
    state: "pending"
  };
  run.deliveries[operationId] = delivery;
  attempt.status = "delivery-pending";

  const terminalLease: Mutable<ResourceLease> = {
    leaseId: input.context.id("lease"),
    resource: { kind: "terminal-session", identity },
    revision: 1,
    ownerEpoch: 1,
    owner: {
      kind: "attempt",
      id: attempt.attemptId,
      generation: identity
    },
    mode: "capacity",
    capacityClaim: 1,
    state: "active"
  };
  run.leases[terminalLease.leaseId] = terminalLease;
  if (input.repositoryStateInput) {
    const repositoryIdentity =
      input.repositoryStateInput.worktreeRef?.worktreeId ??
      input.repositoryStateInput.repositoryId;
    const node = requireNode(run, attempt.nodeId);
    const worktreeLease: Mutable<ResourceLease> = {
      leaseId: input.context.id("lease"),
      resource: { kind: "worktree", identity: repositoryIdentity },
      revision: 1,
      ownerEpoch: 1,
      owner: { kind: "attempt", id: attempt.attemptId },
      mode:
        node.definition.kind === "agent" && node.definition.config.coding
          ? "write"
          : "read",
      capacityClaim: 1,
      state: "active"
    };
    assertLeaseAvailable(input.leaseRuns ?? [run], worktreeLease);
    run.leases[worktreeLease.leaseId] = worktreeLease;
  }
  return { run, delivery: deepClone(delivery) };
}

export function settleAgentPromptDelivery(input: {
  run: WorkflowRun;
  operationId: Id;
  payloadHash: ContentHash;
  outcome: "accepted" | "written" | "uncertain" | "fenced" | "failed";
  receiptId?: Id;
  launchReceipt?: AgentLaunchReceipt;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const delivery = run.deliveries[input.operationId];
  if (!delivery) {
    throw new OrchestrationError("not-found", "prompt delivery was not found");
  }
  if (delivery.payloadHash !== input.payloadHash) {
    throw new OrchestrationError(
      "conflict",
      "prompt delivery payload hash does not match"
    );
  }
  if (delivery.state === "written") {
    if (input.outcome !== "written") {
      throw new OrchestrationError(
        "immutable",
        "a written prompt delivery cannot be downgraded"
      );
    }
    return run;
  }
  const dispatch = run.dispatches[delivery.dispatchId];
  if (!dispatch) {
    throw new OrchestrationError("invalid", "prompt delivery has no Dispatch");
  }
  const attempt = requireAttempt(run, dispatch.attemptId);
  const node = requireNode(run, attempt.nodeId);
  if (input.launchReceipt) {
    upgradeAgentLaunchReceipt(dispatch, input.launchReceipt);
  }
  delivery.state = input.outcome;
  if (input.receiptId) delivery.receiptId = input.receiptId;
  // A late PTY acknowledgement proves delivery only. It cannot restore a
  // foreground process whose loss already requires explicit reconciliation.
  if (attempt.completionIssue?.code === "worker-lost") return run;
  if (input.outcome === "written") {
    attempt.status = "running";
    attempt.startedAt ??= input.context.now();
    node.status = "running";
    node.stateRevision += 1;
    return recomputeRun(run, input.context);
  }
  if (input.outcome === "accepted") return run;
  if (input.outcome === "uncertain") {
    attempt.status = "uncertain";
    node.status = "uncertain";
    for (const lease of Object.values(run.leases)) {
      if (
        lease.owner.kind === "attempt" &&
        lease.owner.id === attempt.attemptId
      ) {
        lease.state = "uncertain";
        lease.revision += 1;
      }
    }
  } else {
    attempt.status = "preparing";
    node.status = "needs-attention";
  }
  node.stateRevision += 1;
  run.status = "needs-attention";
  return run;
}

export function failAttemptPreparation(input: {
  run: WorkflowRun;
  attemptId: Id;
  reason: string;
  code?: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (attempt.status === "failed") return run;
  if (attempt.status === "running" || attempt.status === "waiting-input") {
    throw new OrchestrationError(
      "conflict",
      "a running attempt cannot be failed as a preparation error"
    );
  }
  if (attempt.status !== "preparing") {
    throw new OrchestrationError(
      "conflict",
      `attempt cannot fail preparation from '${attempt.status}'; reconcile any pending delivery first`
    );
  }
  const node = requireNode(run, attempt.nodeId);
  const settledAt = input.context.now();
  attempt.preparationIssue = {
    code: (input.code ?? "executor-preparation-failed").slice(0, 128),
    message: input.reason.slice(0, 4_096),
    observedAt: settledAt
  };
  attempt.status = "failed";
  attempt.settledAt = settledAt;
  node.status = "failed";
  node.activeAttemptId = undefined;
  node.selectedPort = "failure";
  node.stateRevision += 1;
  run.counters.activeAttempts -= 1;
  const result: NodeResult = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome: "failed",
    failureClass: "executor-error",
    summary: input.reason.slice(0, 4_096)
  };
  run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;
  run.results[node.nodeId] = result as Mutable<NodeResult>;
  settleCompletedWorkerTerminal(run, attempt, settledAt);

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
  applyFailurePolicy(run, node, input.context);
  return recomputeRun(run, input.context);
}

export function markAttemptPreparationNeedsAttention(input: {
  run: WorkflowRun;
  attemptId: Id;
  code: string;
  reason: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (
    attempt.status === "failed" &&
    attempt.preparationIssue?.code === input.code
  ) {
    return run;
  }
  if (attempt.status !== "preparing") {
    throw new OrchestrationError(
      "conflict",
      `attempt cannot require preparation attention from '${attempt.status}'; reconcile any pending delivery first`
    );
  }
  const node = requireNode(run, attempt.nodeId);
  const observedAt = input.context.now();
  attempt.status = "failed";
  attempt.settledAt = observedAt;
  attempt.preparationIssue = {
    code: input.code.slice(0, 128),
    message: input.reason.slice(0, 4_096),
    observedAt
  };
  node.status = "needs-attention";
  node.activeAttemptId = undefined;
  node.selectedPort = undefined;
  node.stateRevision += 1;
  run.counters.activeAttempts = Math.max(0, run.counters.activeAttempts - 1);
  settleCompletedWorkerTerminal(run, attempt, observedAt);

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
  run.status = "needs-attention";
  return run;
}

function assertLaunchReceipt(
  dispatch: WorkflowRun["dispatches"][string],
  receipt: AgentLaunchReceipt
): void {
  validateLaunchReceipt(dispatch, receipt);
  if (
    dispatch.launchReceipt &&
    canonicalJson(dispatch.launchReceipt as unknown as JsonValue) !==
      canonicalJson(receipt as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "conflict",
      "Agent launch receipt changed after execution binding"
    );
  }
}

function validateLaunchReceipt(
  dispatch: WorkflowRun["dispatches"][string],
  receipt: AgentLaunchReceipt
): void {
  if (
    canonicalJson(receipt.requested as unknown as JsonValue) !==
    canonicalJson(dispatch.requestedLaunch as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "conflict",
      "Agent launch receipt does not preserve the Dispatch request"
    );
  }
  if (!receipt.agentDescriptorRevision) {
    throw new OrchestrationError(
      "invalid",
      "Agent launch receipt has no descriptor revision"
    );
  }
  if (
    (receipt.requested.model || receipt.requested.effort) &&
    receipt.evidence === "unknown"
  ) {
    throw new OrchestrationError(
      "unsupported",
      "unknown launch evidence cannot admit requested model or effort"
    );
  }
  if (
    ["reuse", "existing"].includes(dispatch.requestedBinding.sessionPolicy) &&
    ((receipt.requested.model !== undefined &&
      receipt.requested.model !== receipt.effective.model) ||
      (receipt.requested.effort !== undefined &&
        receipt.requested.effort !== receipt.effective.effort))
  ) {
    throw new OrchestrationError(
      "conflict",
      "reused Agent launch configuration does not match the requested fields"
    );
  }
}

function upgradeAgentLaunchReceipt(
  dispatch: Mutable<WorkflowRun["dispatches"][string]>,
  receipt: AgentLaunchReceipt
): void {
  validateLaunchReceipt(dispatch, receipt);
  const existing = dispatch.launchReceipt;
  if (!existing) {
    throw new OrchestrationError(
      "conflict",
      "Agent launch receipt cannot be verified before execution binding"
    );
  }
  if (existing.agentDescriptorRevision !== receipt.agentDescriptorRevision) {
    throw new OrchestrationError(
      "conflict",
      "Agent descriptor revision changed during launch verification"
    );
  }
  const evidenceRank = {
    unknown: 0,
    "executor-applied": 1,
    "provider-verified": 2
  } as const;
  if (evidenceRank[receipt.evidence] < evidenceRank[existing.evidence]) {
    throw new OrchestrationError(
      "immutable",
      "Agent launch evidence cannot be downgraded"
    );
  }
  if (
    evidenceRank[receipt.evidence] === evidenceRank[existing.evidence] &&
    canonicalJson(existing as unknown as JsonValue) !==
      canonicalJson(receipt as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "conflict",
      "Agent launch receipt changed without stronger evidence"
    );
  }
  dispatch.launchReceipt = deepClone(receipt) as Mutable<AgentLaunchReceipt>;
}

export function agentRetryPlacementChangeApproved(
  run: WorkflowRun,
  attempt: NodeAttempt
): boolean {
  return Boolean(
    attempt.retryOfAttemptId &&
    Object.values(run.manualRetries).some(
      (operation) =>
        operation.priorAttemptId === attempt.retryOfAttemptId &&
        operation.nodeId === attempt.nodeId &&
        operation.placementChangeApproved &&
        operation.requestedBy === "user:local"
    )
  );
}

/** Task retries retain their placement unless a change was approved. */
export function requiredAgentPlacement(
  run: WorkflowRun,
  attempt: NodeAttempt
): Dispatch | undefined {
  if (
    agentRetryPlacementChangeApproved(run, attempt) ||
    run.graph.nodes[attempt.nodeId]?.definition.retryPolicy?.placement ===
      "allow-fresh"
  )
    return undefined;
  const visited = new Set([attempt.attemptId]);
  let previousId = attempt.retryOfAttemptId;
  while (previousId) {
    const previous = run.attempts[previousId];
    if (
      !previous ||
      previous.nodeId !== attempt.nodeId ||
      visited.has(previousId)
    )
      throw new OrchestrationError(
        "invalid",
        "Agent retry ancestry is invalid"
      );
    visited.add(previousId);
    const dispatch = previous.dispatchId
      ? run.dispatches[previous.dispatchId]
      : undefined;
    if (dispatch?.execution) return dispatch;
    previousId = previous.retryOfAttemptId;
  }
  return undefined;
}

/** The previous owner of an exact terminal transfer, including failed retries. */
export function agentTerminalTransferSource(
  run: WorkflowRun,
  attemptId: Id,
  execution: TerminalExecutionRef
): Dispatch | undefined {
  const attempt = run.attempts[attemptId];
  const dispatch = attempt?.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  if (
    !attempt ||
    !dispatch ||
    (dispatch.requestedBinding.sessionPolicy !== "existing" &&
      !attempt.retryOfAttemptId)
  )
    return;
  return Object.values(run.dispatches).findLast(
    (candidate) =>
      candidate.dispatchId !== dispatch.dispatchId &&
      candidate.execution &&
      terminalExecutionIdentity(candidate.execution) ===
        terminalExecutionIdentity(execution)
  );
}

export function prepareAttemptInputControl(input: {
  run: WorkflowRun;
  attemptId: Id;
  execution: TerminalExecutionRef;
  launchReceipt: AgentLaunchReceipt;
  priorOwnership?: {
    readonly owner: "user" | "runtime";
    readonly mode?: AttemptInputControl["mode"];
    readonly consentReceiptId?: Id;
  };
  context: RuntimeContext;
}): WorkflowRun {
  const prior = input.priorOwnership ?? { owner: "runtime" as const };
  if (prior.owner === "user" && !prior.consentReceiptId) {
    throw new OrchestrationError(
      "unauthorized",
      "a user-owned existing Surface requires a consent receipt"
    );
  }
  const sourceAttempt = input.run.attempts[input.attemptId];
  const sourceDispatch = sourceAttempt?.dispatchId
    ? input.run.dispatches[sourceAttempt.dispatchId]
    : undefined;
  if (!sourceAttempt || !sourceDispatch) {
    throw new OrchestrationError("not-found", "Agent attempt was not found");
  }
  assertLaunchReceipt(sourceDispatch, input.launchReceipt);
  const retryPlacement = requiredAgentPlacement(input.run, sourceAttempt);
  if (
    retryPlacement &&
    (canonicalJson(retryPlacement.execution as unknown as JsonValue) !==
      canonicalJson(input.execution as unknown as JsonValue) ||
      retryPlacement.selectedAgentId !== sourceDispatch.selectedAgentId ||
      retryPlacement.bindingInstanceKey !== sourceDispatch.bindingInstanceKey)
  ) {
    throw new OrchestrationError(
      "conflict",
      "exact Agent retry requires the previous Agent and terminal placement"
    );
  }
  const existing = input.run.inputControls[input.attemptId];
  const initialMode = sourceDispatch.requestedBinding.inputMode;
  if (existing) {
    if (
      canonicalJson(existing.execution as unknown as JsonValue) !==
        canonicalJson(input.execution as unknown as JsonValue) ||
      existing.mode !== initialMode ||
      existing.priorOwner !== prior.owner ||
      existing.consentReceiptId !== prior.consentReceiptId
    ) {
      throw new OrchestrationError(
        "conflict",
        "attempt input ownership was already prepared with different identity"
      );
    }
    return input.run;
  }
  if (sourceAttempt.status !== "preparing") {
    throw new OrchestrationError(
      "conflict",
      "input ownership must be prepared before Agent delivery"
    );
  }
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const dispatch = run.dispatches[attempt.dispatchId!];
  if (!dispatch) {
    throw new OrchestrationError("invalid", "attempt has no Agent Dispatch");
  }
  const timestamp = input.context.now();
  dispatch.execution = deepClone(
    input.execution
  ) as Mutable<TerminalExecutionRef>;
  dispatch.launchReceipt = deepClone(
    input.launchReceipt
  ) as Mutable<AgentLaunchReceipt>;
  const transferSource = agentTerminalTransferSource(
    run,
    attempt.attemptId,
    input.execution
  );
  const reused = transferSource
    ? run.dispatches[transferSource.dispatchId]
    : undefined;
  if (reused) {
    if (reused.terminalState !== "reclaimable") {
      throw new OrchestrationError(
        "conflict",
        "only an exact reclaimable Worker terminal can transfer to a new Attempt"
      );
    }
    if (!reused.terminalHistory) {
      throw new OrchestrationError(
        "conflict",
        "Worker history must be preserved before terminal reuse"
      );
    }
    reused.terminalState = "released";
    reused.terminalStateChangedAt = timestamp;
    reused.terminalDisposition = "reuse";
    reused.reusedByDispatchId = dispatch.dispatchId;
    dispatch.reusedFromDispatchId = reused.dispatchId;
  }
  dispatch.terminalState = "active";
  dispatch.terminalStateChangedAt = timestamp;
  run.inputControls[attempt.attemptId] = {
    attemptId: attempt.attemptId,
    execution: deepClone(input.execution),
    mode: initialMode,
    owner: "runtime",
    revision: 1,
    priorOwner: prior.owner,
    ...(prior.mode ? { priorMode: prior.mode } : {}),
    ...(prior.consentReceiptId
      ? { consentReceiptId: prior.consentReceiptId }
      : {}),
    claimedAt: timestamp,
    updatedAt: timestamp
  } as Mutable<AttemptInputControl>;
  return run;
}

export function recordAttemptInputIntervention(input: {
  run: WorkflowRun;
  attemptId: Id;
  expectedExecution: TerminalExecutionRef;
  idempotencyKey: Id;
  operationId: Id;
  principal: Id;
  kind: InputIntervention["kind"];
  payloadHash?: ContentHash;
  payloadBytes?: number;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly intervention: InputIntervention } {
  const replay = input.run.inputInterventions.find(
    (candidate) => candidate.idempotencyKey === input.idempotencyKey
  );
  if (replay) {
    if (
      replay.attemptId !== input.attemptId ||
      replay.operationId !== input.operationId ||
      replay.kind !== input.kind ||
      replay.payloadHash !== input.payloadHash
    ) {
      throw new OrchestrationError(
        "conflict",
        "input intervention idempotency key was reused with different content"
      );
    }
    return { run: input.run, intervention: replay };
  }
  if (
    input.payloadBytes !== undefined &&
    (input.payloadBytes < 0 || input.payloadBytes > 256 * 1024)
  ) {
    throw new OrchestrationError(
      "budget-exhausted",
      "recorded terminal input exceeds the local v1 256-KiB limit"
    );
  }
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (!["preparing", "running", "waiting-input"].includes(attempt.status)) {
    throw new OrchestrationError(
      "conflict",
      "only an active attempt accepts input intervention"
    );
  }
  const control = run.inputControls[attempt.attemptId];
  if (!control) {
    throw new OrchestrationError(
      "conflict",
      "attempt has no input ownership record"
    );
  }
  if (
    canonicalJson(control.execution as unknown as JsonValue) !==
    canonicalJson(input.expectedExecution as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "input intervention targets a stale execution"
    );
  }
  if (control.mode !== "interactive-recorded" || control.owner !== "runtime") {
    throw new OrchestrationError(
      "unauthorized",
      "raw user input is not enabled for this managed attempt"
    );
  }
  if (!input.payloadHash || input.payloadBytes === undefined) {
    throw new OrchestrationError(
      "invalid",
      "recorded interactive input requires a payload hash and byte count"
    );
  }
  const occurredAt = input.context.now();
  control.revision += 1;
  control.updatedAt = occurredAt;
  control.readinessInvalidatedAt = occurredAt;
  const intervention: InputIntervention = {
    interventionId: input.context.id("input-intervention"),
    attemptId: attempt.attemptId,
    execution: deepClone(input.expectedExecution),
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    principal: input.principal,
    kind: input.kind,
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
    ...(input.payloadBytes === undefined
      ? {}
      : { payloadBytes: input.payloadBytes }),
    occurredAt
  };
  run.inputInterventions.push(intervention as Mutable<InputIntervention>);
  attempt.inputInterventionIds.push(intervention.interventionId);
  return { run, intervention };
}

export function assertRuntimeInputAuthority(input: {
  run: WorkflowRun;
  attemptId: Id;
  expectedExecution: TerminalExecutionRef;
}): void {
  const control = input.run.inputControls[input.attemptId];
  if (
    !control ||
    control.owner !== "runtime" ||
    canonicalJson(control.execution as unknown as JsonValue) !==
      canonicalJson(input.expectedExecution as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "Scheduler input is fenced by current input ownership"
    );
  }
}

export function settleAttemptInputDisposition(input: {
  run: WorkflowRun;
  attemptId: Id;
  expectedRevision: number;
  disposition: "retain" | "release";
  context: RuntimeContext;
}): WorkflowRun {
  const sourceAttempt = input.run.attempts[input.attemptId];
  const sourceControl = input.run.inputControls[input.attemptId];
  if (!sourceAttempt || !sourceControl) {
    throw new OrchestrationError(
      "not-found",
      "attempt input ownership was not found"
    );
  }
  if (sourceControl.disposition === input.disposition) return input.run;
  if (sourceControl.revision !== input.expectedRevision) {
    throw stale(
      "attempt input disposition",
      sourceControl.revision,
      input.expectedRevision
    );
  }
  if (!["succeeded", "failed", "canceled"].includes(sourceAttempt.status)) {
    throw new OrchestrationError(
      "conflict",
      "input ownership cannot settle before the attempt"
    );
  }
  const run = mutableClone(input.run);
  const control = run.inputControls[input.attemptId]!;
  const attempt = run.attempts[input.attemptId]!;
  const dispatch = attempt.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  const timestamp = input.context.now();
  control.disposition = input.disposition;
  control.dispositionAt = timestamp;
  control.updatedAt = timestamp;
  control.revision += 1;
  if (input.disposition === "release") {
    control.owner = "released";
    control.mode = control.priorMode ?? control.mode;
    if (dispatch) {
      dispatch.terminalState = "released";
      dispatch.terminalStateChangedAt = timestamp;
      dispatch.terminalDisposition = "release";
    }
  } else {
    control.owner = "runtime";
    if (dispatch) {
      dispatch.terminalState = "retained";
      dispatch.terminalStateChangedAt = timestamp;
      dispatch.terminalDisposition = "retain";
    }
  }
  return recomputeRun(run, input.context);
}

export function requestAttemptInputDisposition(input: {
  run: WorkflowRun;
  attemptId: Id;
  disposition: "retain" | "release";
  idempotencyKey: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const sourceControl = input.run.inputControls[input.attemptId];
  if (!sourceControl) {
    throw new OrchestrationError(
      "not-found",
      "attempt input ownership was not found"
    );
  }
  if (sourceControl.dispositionIdempotencyKey === input.idempotencyKey) {
    if (sourceControl.requestedDisposition !== input.disposition) {
      throw new OrchestrationError(
        "conflict",
        "input disposition idempotency key was reused with another outcome"
      );
    }
    return input.run;
  }
  const sourceAttempt = input.run.attempts[input.attemptId];
  const sourceDispatch = sourceAttempt?.dispatchId
    ? input.run.dispatches[sourceAttempt.dispatchId]
    : undefined;
  if (
    !sourceAttempt ||
    !sourceDispatch ||
    !["succeeded", "failed", "canceled"].includes(sourceAttempt.status) ||
    !(
      sourceDispatch.terminalState === "reclaimable" ||
      (input.disposition === "release" &&
        sourceDispatch.terminalState === "release-unknown")
    )
  ) {
    throw new OrchestrationError(
      "conflict",
      "Worker terminal disposition requires an exact reclaimable completed Dispatch"
    );
  }
  if (sourceControl.disposition === "release") {
    throw new OrchestrationError(
      "conflict",
      "released input ownership cannot be retained by policy"
    );
  }
  if (input.disposition === "retain" && sourceControl.priorOwner === "user") {
    throw new OrchestrationError(
      "unauthorized",
      "a user-owned existing Surface must restore its prior ownership"
    );
  }
  const run = mutableClone(input.run);
  const control = run.inputControls[input.attemptId]!;
  const dispatch = run.dispatches[sourceDispatch.dispatchId]!;
  control.requestedDisposition = input.disposition;
  control.dispositionRequestId = input.context.id("input-disposition");
  control.dispositionIdempotencyKey = input.idempotencyKey;
  control.updatedAt = input.context.now();
  control.revision += 1;
  if (input.disposition === "release") {
    dispatch.terminalState = "release-pending";
    dispatch.terminalStateChangedAt = control.updatedAt;
  }
  return run;
}

export function recordWorkerTerminalHistory(input: {
  run: WorkflowRun;
  dispatchId: Id;
  history: WorkerOutputArchive;
}): WorkflowRun {
  const source = input.run.dispatches[input.dispatchId];
  if (!source) {
    throw new OrchestrationError("not-found", "Worker Dispatch was not found");
  }
  const run = mutableClone(input.run);
  run.dispatches[input.dispatchId]!.terminalHistory = deepClone(input.history);
  delete run.dispatches[input.dispatchId]!.historyIssue;
  return run;
}

export function markWorkerTerminalReleaseUnknown(input: {
  run: WorkflowRun;
  dispatchId: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const source = input.run.dispatches[input.dispatchId];
  if (!source || source.terminalState !== "release-pending") {
    throw new OrchestrationError(
      "conflict",
      "only a release-pending Worker terminal can become release-unknown"
    );
  }
  const run = mutableClone(input.run);
  const dispatch = run.dispatches[input.dispatchId]!;
  dispatch.terminalState = "release-unknown";
  dispatch.terminalStateChangedAt = input.context.now();
  return recomputeRun(run, input.context);
}

export function retainWorkerTerminalAfterTakeover(input: {
  run: WorkflowRun;
  dispatchId: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const source = input.run.dispatches[input.dispatchId];
  if (
    !source ||
    !["reclaimable", "release-pending"].includes(
      source.terminalState ?? "active"
    )
  ) {
    throw new OrchestrationError(
      "conflict",
      "Worker terminal is not eligible for takeover retention"
    );
  }
  const run = mutableClone(input.run);
  const dispatch = run.dispatches[input.dispatchId]!;
  dispatch.terminalState = "retained";
  dispatch.terminalStateChangedAt = input.context.now();
  dispatch.terminalDisposition = "user-takeover";
  const control = run.inputControls[dispatch.attemptId];
  if (control) {
    control.disposition = "retain";
    control.dispositionAt = dispatch.terminalStateChangedAt;
    control.updatedAt = dispatch.terminalStateChangedAt;
    control.revision += 1;
  }
  return recomputeRun(run, input.context);
}
