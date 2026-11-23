import type {
  CancellationOperation,
  Id,
  ManualRetryOperation,
  NodeAttempt,
  NodeResult,
  TerminalExecutionRef,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";
import {
  type RuntimeContext,
  mutableClone,
  requireAttempt,
  requireNode,
  type Mutable,
  isTerminalRun,
  recordAttemptDuration,
  queueAutomaticRetry,
  isDurableCallerWait,
  terminalExecutionIdentity
} from "./runtimeState";
import { recomputeRun, applyFailurePolicy } from "./runtimeScheduling";

export function requestAttemptCancellation(input: {
  run: WorkflowRun;
  attemptId: Id;
  idempotencyKey: Id;
  context: RuntimeContext;
}): {
  readonly run: WorkflowRun;
  readonly operation: CancellationOperation;
} {
  const replay = Object.values(input.run.cancellations).find(
    (operation) => operation.idempotencyKey === input.idempotencyKey
  );
  if (replay) {
    if (replay.attemptId !== input.attemptId) {
      throw new OrchestrationError(
        "conflict",
        "cancellation idempotency key was reused for another attempt"
      );
    }
    return { run: input.run, operation: replay };
  }
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (
    ![
      "preparing",
      "delivery-pending",
      "running",
      "waiting-input",
      "waiting-gate"
    ].includes(attempt.status)
  ) {
    throw new OrchestrationError(
      "conflict",
      `attempt '${attempt.attemptId}' cannot request cancellation from '${attempt.status}'`
    );
  }
  const node = requireNode(run, attempt.nodeId);
  const operation: CancellationOperation = {
    operationId: input.context.id("cancellation"),
    attemptId: attempt.attemptId,
    idempotencyKey: input.idempotencyKey,
    requestedAt: input.context.now(),
    state: "requested"
  };
  run.cancellations[operation.operationId] =
    operation as Mutable<CancellationOperation>;
  attempt.status = "cancel-requested";
  node.status = "cancel-requested";
  node.stateRevision += 1;
  return { run, operation };
}

export function requestAttemptRetry(input: {
  run: WorkflowRun;
  attemptId: Id;
  idempotencyKey: Id;
  principal: Id;
  placementChangeApproved?: true;
  context: RuntimeContext;
}): {
  readonly run: WorkflowRun;
  readonly operation: ManualRetryOperation;
} {
  const replay = Object.values(input.run.manualRetries).find(
    (operation) => operation.idempotencyKey === input.idempotencyKey
  );
  if (replay) {
    if (
      replay.priorAttemptId !== input.attemptId ||
      Boolean(replay.placementChangeApproved) !==
        Boolean(input.placementChangeApproved)
    ) {
      throw new OrchestrationError(
        "conflict",
        "retry idempotency key was reused with different content"
      );
    }
    return { run: input.run, operation: replay };
  }
  if (input.run.status === "settling" || isTerminalRun(input.run.status)) {
    throw new OrchestrationError(
      "conflict",
      "a settling or terminal Run cannot be reopened; create a continuation Run"
    );
  }
  const sourceAttempt = input.run.attempts[input.attemptId];
  const sourceNode = sourceAttempt
    ? input.run.graph.nodes[sourceAttempt.nodeId]
    : undefined;
  if (!sourceAttempt || !sourceNode) {
    throw new OrchestrationError("not-found", "retry attempt was not found");
  }
  if (input.placementChangeApproved) {
    if (input.principal !== "user:local") {
      throw new OrchestrationError(
        "unauthorized",
        "placement changes require explicit user approval"
      );
    }
    if (
      sourceNode.definition.kind !== "agent" ||
      sourceNode.definition.retryPolicy?.placement !== "approval-for-change"
    ) {
      throw new OrchestrationError(
        "invalid",
        "this Task does not allow an approved placement change"
      );
    }
    const binding =
      input.run.graph.agentBindings[sourceNode.definition.config.agentRef];
    if (
      binding?.surfacePolicy === "existing" ||
      binding?.sessionPolicy === "existing"
    ) {
      throw new OrchestrationError(
        "unsupported",
        "an existing-session binding cannot move to a new terminal"
      );
    }
  }
  const preparationNeedsAttention =
    sourceAttempt.status === "failed" &&
    sourceAttempt.preparationIssue !== undefined &&
    sourceNode.status === "needs-attention";
  if (
    (!preparationNeedsAttention &&
      (!["failed", "canceled"].includes(sourceAttempt.status) ||
        sourceNode.status !== sourceAttempt.status)) ||
    sourceNode.activeAttemptId ||
    sourceNode.attemptIds.at(-1) !== sourceAttempt.attemptId
  ) {
    throw new OrchestrationError(
      "conflict",
      "only the latest settled failed or canceled attempt can be retried"
    );
  }
  if (
    Object.values(input.run.leases).some(
      (lease) =>
        lease.owner.kind === "attempt" &&
        lease.owner.id === sourceAttempt.attemptId &&
        lease.state !== "released"
    ) ||
    Object.values(input.run.cancellations).some(
      (operation) =>
        operation.attemptId === sourceAttempt.attemptId &&
        operation.state !== "confirmed"
    ) ||
    Object.values(input.run.deliveries).some((delivery) => {
      const dispatch = sourceAttempt.dispatchId
        ? input.run.dispatches[sourceAttempt.dispatchId]
        : undefined;
      return (
        delivery.dispatchId === dispatch?.dispatchId &&
        ["pending", "accepted", "uncertain"].includes(delivery.state)
      );
    })
  ) {
    throw new OrchestrationError(
      "uncertain",
      "retry is fenced until prior execution, delivery, cancellation, and leases reconcile"
    );
  }
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  const node = requireNode(run, attempt.nodeId);
  const operation: ManualRetryOperation = {
    operationId: input.context.id("manual-retry"),
    priorAttemptId: attempt.attemptId,
    nodeId: node.nodeId,
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.principal,
    requestedAt: input.context.now(),
    ...(input.placementChangeApproved
      ? { placementChangeApproved: true as const }
      : {}),
    state: "queued"
  };
  run.manualRetries[operation.operationId] =
    operation as Mutable<ManualRetryOperation>;
  node.status = "pending";
  node.selectedPort = undefined;
  node.joinResolution = undefined;
  node.admissionFailure = undefined;
  node.stateRevision += 1;
  delete run.results[node.nodeId];
  return {
    run: recomputeRun(run, input.context),
    operation
  };
}

export function confirmAttemptCancellation(input: {
  run: WorkflowRun;
  operationId: Id;
  executorReceiptId: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const operation = run.cancellations[input.operationId];
  if (!operation) {
    throw new OrchestrationError(
      "not-found",
      "cancellation operation was not found"
    );
  }
  if (operation.state === "confirmed") return run;
  if (operation.state !== "requested") {
    throw new OrchestrationError(
      "conflict",
      "an uncertain cancellation requires reconciliation, not optimistic confirmation"
    );
  }
  const attempt = requireAttempt(run, operation.attemptId);
  if (attempt.status !== "cancel-requested") {
    throw new OrchestrationError(
      "conflict",
      "exact attempt is no longer cancellation-pending"
    );
  }
  const node = requireNode(run, attempt.nodeId);
  const settledAt = input.context.now();
  operation.state = "confirmed";
  operation.settledAt = settledAt;
  operation.executorReceiptId = input.executorReceiptId;
  const outcome = operation.timeout ? "failed" : "canceled";
  attempt.status = outcome;
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = outcome;
  node.activeAttemptId = undefined;
  node.selectedPort = operation.timeout ? "failure" : "canceled";
  node.stateRevision += 1;
  run.counters.activeAttempts -= 1;
  if (node.definition.kind === "human-gate") {
    for (const gate of Object.values(run.gates)) {
      if (gate.nodeId === node.nodeId && gate.state === "open") {
        gate.state = "canceled";
        gate.canceledAt = settledAt;
      }
    }
  }
  for (const shellOperation of Object.values(run.shellOperations)) {
    if (
      shellOperation.attemptId === attempt.attemptId &&
      (shellOperation.state === "intent-recorded" ||
        shellOperation.state === "executing")
    ) {
      shellOperation.state = "canceled";
      shellOperation.settledAt = settledAt;
    }
  }

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
  for (const delivery of Object.values(run.deliveries)) {
    if (
      delivery.dispatchId === attempt.dispatchId &&
      ["pending", "accepted", "uncertain"].includes(delivery.state)
    ) {
      delivery.state = "failed";
    }
  }
  const dispatch = attempt.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  if (dispatch?.terminalState) {
    dispatch.terminalState = "released";
    dispatch.terminalStateChangedAt = settledAt;
    dispatch.terminalDisposition = "release";
    const control = run.inputControls[attempt.attemptId];
    if (control) {
      control.owner = "released";
      control.disposition = "release";
      control.dispositionAt = settledAt;
      control.updatedAt = settledAt;
      control.revision += 1;
    }
  }
  if (operation.timeout) {
    const result: NodeResult = {
      nodeId: node.nodeId,
      attemptId: attempt.attemptId,
      outcome: "failed",
      failureClass: "timeout",
      summary:
        "Attempt timed out; the executor confirmed exact execution cancellation."
    };
    run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;
    if (
      operation.timeout.onTimeout === "cancel-and-retry" &&
      queueAutomaticRetry(run, node, attempt, "timeout", input.context)
    ) {
      return recomputeRun(run, input.context);
    }
    run.results[node.nodeId] = result as Mutable<NodeResult>;
  } else {
    const result: NodeResult = {
      nodeId: node.nodeId,
      attemptId: attempt.attemptId,
      outcome: "canceled",
      summary: operation.joinNodeId
        ? `Canceled after join '${operation.joinNodeId}' selected another successful predecessor`
        : "The executor confirmed exact execution cancellation",
      data: { cancellationOperationId: operation.operationId }
    };
    run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;
    run.results[node.nodeId] = result as Mutable<NodeResult>;
  }
  applyFailurePolicy(run, node, input.context);
  return recomputeRun(run, input.context);
}

export function markCancellationUncertain(input: {
  issue?: string;
  run: WorkflowRun;
  operationId: Id;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const operation = run.cancellations[input.operationId];
  if (!operation) {
    throw new OrchestrationError(
      "not-found",
      "cancellation operation was not found"
    );
  }
  if (operation.state === "uncertain") return run;
  if (operation.state !== "requested") {
    throw new OrchestrationError(
      "immutable",
      "confirmed cancellation is immutable"
    );
  }
  operation.state = "uncertain";
  if (input.issue) operation.issue = input.issue;
  const attempt = requireAttempt(run, operation.attemptId);
  attempt.status = "cancel-uncertain";
  const node = requireNode(run, attempt.nodeId);
  node.status = "uncertain";
  node.stateRevision += 1;
  for (const shellOperation of Object.values(run.shellOperations)) {
    if (
      shellOperation.attemptId === attempt.attemptId &&
      (shellOperation.state === "intent-recorded" ||
        shellOperation.state === "executing")
    ) {
      shellOperation.state = "outcome-unknown";
    }
  }

  for (const lease of Object.values(run.leases)) {
    if (
      lease.owner.kind === "attempt" &&
      lease.owner.id === attempt.attemptId &&
      lease.state !== "released"
    ) {
      lease.state = "uncertain";
      lease.revision += 1;
    }
  }
  if (run.status !== "settling") run.status = "needs-attention";
  return run;
}

export function resolveUncertainAttempt(input: {
  run: WorkflowRun;
  attemptId: Id;
  resolution: "mark-failed" | "mark-canceled";
  summary: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const attempt = requireAttempt(run, input.attemptId);
  if (attempt.status !== "uncertain" && attempt.status !== "cancel-uncertain") {
    throw new OrchestrationError(
      "conflict",
      "only an uncertain attempt can be resolved manually"
    );
  }
  const node = requireNode(run, attempt.nodeId);
  if (node.activeAttemptId !== attempt.attemptId) {
    throw new OrchestrationError(
      "immutable",
      "uncertain attempt is no longer the active node attempt"
    );
  }
  const settledAt = input.context.now();
  const outcome = input.resolution === "mark-failed" ? "failed" : "canceled";
  attempt.status = outcome;
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = outcome;
  node.activeAttemptId = undefined;
  node.selectedPort = outcome;
  node.stateRevision += 1;
  run.counters.activeAttempts = Math.max(0, run.counters.activeAttempts - 1);
  const result: NodeResult = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome,
    ...(outcome === "failed" ? { failureClass: "lost-worker" as const } : {}),
    summary: input.summary.slice(0, 8_192)
  };
  run.results[node.nodeId] = result as Mutable<NodeResult>;
  run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;

  for (const operation of Object.values(run.cancellations)) {
    if (
      operation.attemptId === attempt.attemptId &&
      operation.state === "uncertain"
    ) {
      operation.state = "confirmed";
      operation.settledAt = settledAt;
    }
  }
  for (const shellOperation of Object.values(run.shellOperations)) {
    if (
      shellOperation.attemptId === attempt.attemptId &&
      (shellOperation.state === "intent-recorded" ||
        shellOperation.state === "executing" ||
        shellOperation.state === "outcome-unknown" ||
        shellOperation.state === "needs-attention")
    ) {
      shellOperation.state = "confirmed-absent";
      shellOperation.settledAt = settledAt;
    }
  }
  for (const delivery of Object.values(run.deliveries)) {
    if (
      delivery.dispatchId === attempt.dispatchId &&
      ["pending", "accepted", "uncertain"].includes(delivery.state)
    ) {
      delivery.state = "failed";
    }
  }
  for (const lease of Object.values(run.leases)) {
    if (
      lease.owner.kind === "attempt" &&
      lease.owner.id === attempt.attemptId &&
      lease.state !== "released"
    ) {
      lease.state = "abandoned";
      lease.revision += 1;
    }
  }
  applyFailurePolicy(run, node, input.context);
  return recomputeRun(run, input.context);
}

function isPendingControlCancellation(
  run: WorkflowRun,
  attempt: NodeAttempt
): boolean {
  const kind = run.graph.nodes[attempt.nodeId]?.definition.kind;
  // Control nodes have no external process. Their durable cancellation can
  // be confirmed by the host after restart without terminal attestation.
  return (
    attempt.status === "cancel-requested" &&
    kind !== undefined &&
    kind !== "agent" &&
    kind !== "shell" &&
    Object.values(run.cancellations).some(
      (operation) =>
        operation.attemptId === attempt.attemptId &&
        operation.state === "requested"
    )
  );
}

export function checkpointRunForHostShutdown(source: WorkflowRun): WorkflowRun {
  const run = mutableClone(source);
  if (isTerminalRun(run.status)) return run;
  for (const attempt of Object.values(run.attempts)) {
    if (
      isDurableCallerWait(run, attempt) ||
      isPendingControlCancellation(run, attempt)
    )
      continue;
    if (
      [
        "preparing",
        "delivery-pending",
        "running",
        "waiting-input",
        "cancel-requested",
        "cancel-uncertain"
      ].includes(attempt.status)
    ) {
      attempt.status = "uncertain";
      const node = requireNode(run, attempt.nodeId);
      node.status = "uncertain";
      node.stateRevision += 1;
    }
  }
  for (const delivery of Object.values(run.deliveries)) {
    if (delivery.state === "pending" || delivery.state === "accepted") {
      delivery.state = "uncertain";
    }
  }
  for (const lease of Object.values(run.leases)) {
    if (
      lease.state === "active" &&
      lease.owner.kind === "attempt" &&
      !isDurableCallerWait(run, run.attempts[lease.owner.id])
    ) {
      lease.state = "uncertain";
      lease.revision += 1;
    }
  }
  if (
    Object.values(run.attempts).some(
      (attempt) => attempt.status === "uncertain"
    )
  ) {
    run.status = "needs-attention";
  }
  return run;
}

/** Lost foreground evidence is not proof of cancellation or of no side effects. */
export function observeAgentExecutionLost(input: {
  run: WorkflowRun;
  execution: TerminalExecutionRef;
  reason: string;
  context: RuntimeContext;
}): WorkflowRun {
  const identity = terminalExecutionIdentity(input.execution);
  const affected = Object.values(input.run.attempts).filter((attempt) => {
    const dispatch = attempt.dispatchId
      ? input.run.dispatches[attempt.dispatchId]
      : undefined;
    return (
      ["delivery-pending", "running", "waiting-input"].includes(
        attempt.status
      ) &&
      dispatch?.execution &&
      terminalExecutionIdentity(dispatch.execution) === identity
    );
  });
  if (!affected.length) return input.run;
  const run = mutableClone(input.run);
  for (const source of affected) {
    const attempt = requireAttempt(run, source.attemptId);
    markAttemptUncertain(run, attempt);
    attempt.completionIssue = {
      code: "worker-lost",
      message: input.reason.slice(0, 4_096),
      observedAt: input.context.now()
    };
    for (const delivery of Object.values(run.deliveries)) {
      if (
        delivery.dispatchId === attempt.dispatchId &&
        ["pending", "accepted"].includes(delivery.state)
      )
        delivery.state = "uncertain";
    }
  }
  run.status = "needs-attention";
  return recomputeRun(run, input.context);
}

function markAttemptUncertain(
  run: Mutable<WorkflowRun>,
  attempt: Mutable<NodeAttempt>
) {
  attempt.status = "uncertain";
  const node = requireNode(run, attempt.nodeId);
  node.status = "uncertain";
  node.stateRevision += 1;

  for (const lease of Object.values(run.leases)) {
    if (
      lease.owner.kind === "attempt" &&
      lease.owner.id === attempt.attemptId &&
      lease.state !== "released"
    ) {
      lease.state = "uncertain";
      lease.revision += 1;
    }
  }
}

export function recoverRun(
  source: WorkflowRun,
  context: RuntimeContext
): WorkflowRun {
  const run = mutableClone(source);
  for (const operation of Object.values(run.shellOperations)) {
    if (
      operation.state === "intent-recorded" ||
      operation.state === "executing"
    ) {
      operation.state = "outcome-unknown";
      operation.settledAt = context.now();
    }
  }
  for (const attempt of Object.values(run.attempts)) {
    if (
      isDurableCallerWait(run, attempt) ||
      isPendingControlCancellation(run, attempt)
    )
      continue;
    if (
      attempt.status === "preparing" ||
      attempt.status === "delivery-pending" ||
      attempt.status === "running" ||
      attempt.status === "waiting-input" ||
      attempt.status === "cancel-requested" ||
      attempt.status === "cancel-uncertain"
    ) {
      markAttemptUncertain(run, attempt);
    }
  }
  if (
    Object.values(run.deliveries).some(
      (delivery) =>
        delivery.state === "pending" || delivery.state === "accepted"
    )
  ) {
    for (const delivery of Object.values(run.deliveries)) {
      if (delivery.state === "pending" || delivery.state === "accepted")
        delivery.state = "uncertain";
    }
  }
  if (
    Object.values(run.attempts).some(
      (attempt) => attempt.status === "uncertain"
    )
  ) {
    run.status = "needs-attention";
  }
  return recomputeRun(run, context);
}
