import { deepClone } from "./canonical";
import type {
  Id,
  IsoTimestamp,
  NodeAttempt,
  NodeResult,
  ResourceLease,
  RunBudgetCounters,
  RunNode,
  RunNodeStatus,
  TerminalExecutionRef,
  WorkflowDefinitionV1,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";

export interface RuntimeContext {
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

export type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

export const TERMINAL_NODE_STATES = new Set<RunNodeStatus>([
  "succeeded",
  "failed",
  "canceled",
  "skipped"
]);

export const LOCAL_V1_DEFAULT_RUN_LIMITS: WorkflowDefinitionV1["policies"]["limits"] =
  {
    maxNodes: 128,
    maxEdges: 512,
    maxGraphDepth: 32,
    maxFanOut: 16,
    maxLoopIterations: 12,
    maxActiveAttempts: 4,
    maxAttemptsPerSession: 8,
    maxDispatches: 128,
    maxCoordinatorTurns: 32,
    maxGraphPatches: 128,
    maxWallClockMs: 24 * 60 * 60 * 1000,
    maxActiveExecutionMs: 12 * 60 * 60 * 1000,
    maxArtifactBytes: 512 * 1024 * 1024,
    maxStructuredResultBytes: 8 * 1024 * 1024
  };

export const LOCAL_V1_HOST_MAX_RUN_LIMITS: WorkflowDefinitionV1["policies"]["limits"] =
  {
    maxNodes: 1_024,
    maxEdges: 8_192,
    maxGraphDepth: 128,
    maxFanOut: 64,
    maxLoopIterations: 128,
    maxActiveAttempts: 32,
    maxAttemptsPerSession: 1_000,
    maxDispatches: 4_096,
    maxCoordinatorTurns: 512,
    maxGraphPatches: 4_096,
    maxWallClockMs: 7 * 24 * 60 * 60 * 1000,
    maxActiveExecutionMs: 3 * 24 * 60 * 60 * 1000,
    maxArtifactBytes: 8 * 1024 * 1024 * 1024,
    maxStructuredResultBytes: 64 * 1024 * 1024
  };

export function terminalExecutionIdentity(
  execution: TerminalExecutionRef
): string {
  const generation =
    execution.generation.kind === "local"
      ? `local:${execution.generation.runtimeEpoch}`
      : `remote:${execution.generation.keeperGeneration}`;
  return [
    execution.targetAuthority,
    execution.targetId,
    execution.surfaceId,
    execution.sessionId,
    generation
  ].join("|");
}

export function isCallerNode(run: WorkflowRun, node: RunNode): boolean {
  return (
    node.definition.kind === "agent" &&
    run.graph.agentBindings[node.definition.config.agentRef]?.agent.kind ===
      "caller"
  );
}

export function isDurableCallerWait(
  run: WorkflowRun,
  attempt: NodeAttempt | undefined
): boolean {
  if (!attempt) return false;
  if (
    attempt.status === "waiting-input" &&
    attempt.callerTask?.state === "waiting"
  )
    return true;
  return (
    attempt.status === "running" &&
    run.graph.nodes[attempt.nodeId]?.definition.kind === "loop" &&
    Object.values(run.attempts).some(
      (wait) =>
        wait.status === "waiting-input" &&
        wait.callerTask?.state === "waiting" &&
        wait.materializationPath?.[attempt.materializationPath?.length ?? 0]
          ?.loopNodeId === run.graph.nodes[attempt.nodeId].definition.id &&
        (attempt.materializationPath ?? []).every(
          (owner, index) =>
            owner.iterationId === wait.materializationPath?.[index]?.iterationId
        )
    )
  );
}

export function settleCompletedWorkerTerminal(
  run: Mutable<WorkflowRun>,
  attempt: Mutable<NodeAttempt>,
  settledAt: IsoTimestamp
): void {
  const dispatch = attempt.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  const control = run.inputControls[attempt.attemptId];
  if (!dispatch?.execution || !control) return;
  dispatch.terminalState =
    control.priorOwner === "user" ? "retained" : "reclaimable";
  dispatch.terminalStateChangedAt = settledAt;
  if (control.priorOwner === "user") {
    dispatch.terminalDisposition = "user-takeover";
  }
}

export function queueAutomaticRetry(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  attempt: Mutable<NodeAttempt>,
  failureClass: NonNullable<NodeResult["failureClass"]>,
  context: RuntimeContext
): boolean {
  const policy = node.definition.retryPolicy;
  if (
    !policy ||
    !attempt.settledAt ||
    run.settlingTargetOutcome ||
    isTerminalRun(run.status) ||
    attempt.ordinal >= policy.maxAttempts ||
    !policy.retryable.includes(failureClass) ||
    Object.values(run.leases).some(
      (lease) =>
        lease.owner.kind === "attempt" &&
        lease.owner.id === attempt.attemptId &&
        lease.state !== "released"
    ) ||
    Object.values(run.cancellations).some(
      (operation) =>
        operation.attemptId === attempt.attemptId &&
        operation.state !== "confirmed"
    ) ||
    Object.values(run.deliveries).some(
      (delivery) =>
        attempt.dispatchId !== undefined &&
        delivery.dispatchId === attempt.dispatchId &&
        ["pending", "accepted", "uncertain"].includes(delivery.state)
    )
  ) {
    return false;
  }
  const notBefore = new Date(
    Date.parse(attempt.settledAt) + policy.backoffMs
  ).toISOString();
  attempt.notBefore = notBefore;
  node.status = "pending";
  node.selectedPort = undefined;
  const timerId = context.id("timer");
  run.timers[timerId] = {
    timerId,
    runId: run.runId,
    attemptId: attempt.attemptId,
    kind: "retry",
    dueAt: notBefore,
    policyVersion: 1,
    state: "pending",
    effectIdempotencyKey: context.id("timer-effect")
  };
  return true;
}

export function createRunDeadlineTimer(
  runId: Id,
  createdAt: string,
  limits: WorkflowDefinitionV1["policies"]["limits"],
  context: RuntimeContext
): WorkflowRun["timers"] {
  const timerId = context.id("timer");
  return {
    [timerId]: {
      timerId,
      runId,
      kind: "run-deadline",
      dueAt: new Date(
        Date.parse(createdAt) + limits.maxWallClockMs
      ).toISOString(),
      policyVersion: 1,
      state: "pending",
      effectIdempotencyKey: context.id("timer-effect")
    }
  };
}

export function assertLeaseAvailable(
  runs: readonly WorkflowRun[],
  requested: Pick<ResourceLease, "resource" | "mode">
): void {
  for (const run of runs) {
    if (
      Object.values(run.leases).some(
        (existing) =>
          existing.state !== "released" &&
          existing.resource.kind === requested.resource.kind &&
          existing.resource.identity === requested.resource.identity &&
          (requested.mode !== "read" || existing.mode !== "read")
      )
    )
      throw new OrchestrationError(
        "conflict",
        `${requested.resource.kind} is fenced by an active or uncertain lease`
      );
  }
}

export function acquireResourceLease(input: {
  leaseRuns?: readonly WorkflowRun[];
  run: WorkflowRun;
  lease: Omit<ResourceLease, "leaseId" | "revision" | "ownerEpoch" | "state">;
  context: RuntimeContext;
}): { readonly run: WorkflowRun; readonly lease: ResourceLease } {
  assertLeaseAvailable(input.leaseRuns ?? [input.run], input.lease);
  const run = mutableClone(input.run);
  const lease: ResourceLease = {
    ...deepClone(input.lease),
    leaseId: input.context.id("lease"),
    revision: 1,
    ownerEpoch: 1,
    state: "active"
  };
  run.leases[lease.leaseId] = lease as Mutable<ResourceLease>;
  return { run, lease };
}

export function releaseLease(input: {
  run: WorkflowRun;
  leaseId: Id;
  expectedRevision: number;
  expectedOwnerEpoch: number;
  reconciled: boolean;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const lease = requireLease(run, input.leaseId);
  assertLeaseRevision(lease, input.expectedRevision, input.expectedOwnerEpoch);
  if (lease.state === "released") return run;
  if (lease.state === "uncertain" && !input.reconciled) {
    throw new OrchestrationError(
      "uncertain",
      "uncertain resources require proven reconciliation before release"
    );
  }
  lease.state = "released";
  lease.revision += 1;
  return run;
}

export function markLeaseUncertain(input: {
  run: WorkflowRun;
  leaseId: Id;
  expectedRevision: number;
  expectedOwnerEpoch: number;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const lease = requireLease(run, input.leaseId);
  assertLeaseRevision(lease, input.expectedRevision, input.expectedOwnerEpoch);
  lease.state = "uncertain";
  lease.revision += 1;
  return run;
}

export function wakeCoordinator(run: Mutable<WorkflowRun>): void {
  // The original Coordinator pulls durable mailbox events. A wake advances
  // its cursor without launching another Agent or synthesizing a turn.
  run.coordinatorEventCursor += 1;
}

export function resolveSelectedAgentId(
  run: WorkflowRun,
  binding: WorkflowDefinitionV1["agentBindings"][string]
): string {
  if (binding.agent.kind === "agent-id") return binding.agent.agentId;
  if (binding.agent.kind === "caller")
    throw new OrchestrationError(
      "invalid",
      "Calling Agent must not launch a Dispatch"
    );
  const selected = run.inputs[binding.agent.inputId];
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new OrchestrationError(
      "invalid",
      `Run input '${binding.agent.inputId}' must select an Agent`
    );
  }
  return selected;
}

export function resolveBindingInstanceKey(
  run: WorkflowRun,
  node: RunNode,
  agentRef: string,
  binding: WorkflowDefinitionV1["agentBindings"][string]
): string {
  if (binding.scope.kind === "run") {
    return `${run.runId}:binding:${agentRef}:run`;
  }
  const owningLoopNodeId = binding.scope.loopNodeId;
  const owner = node.materialization?.path.find(
    (entry) => entry.loopNodeId === owningLoopNodeId
  );
  if (!owner) {
    throw new OrchestrationError(
      "invalid",
      `Agent binding '${agentRef}' is outside owning Loop '${owningLoopNodeId}'`
    );
  }
  return `${run.runId}:binding:${agentRef}:loop:${owningLoopNodeId}:${owner.iterationId}`;
}

export function assertRunTimeBudgets(
  run: WorkflowRun,
  observedAt: string
): void {
  if (
    Date.parse(observedAt) - Date.parse(run.createdAt) >=
    run.limits.maxWallClockMs
  ) {
    throw budget("maxWallClockMs");
  }
  let activeElapsedMs = run.counters.activeExecutionMs;
  for (const attempt of Object.values(run.attempts)) {
    if (
      attempt.startedAt &&
      !attempt.settledAt &&
      [
        "preparing",
        "delivery-pending",
        "running",
        "waiting-input",
        "cancel-requested",
        "cancel-uncertain",
        "uncertain"
      ].includes(attempt.status)
    ) {
      activeElapsedMs += Math.max(
        0,
        Date.parse(observedAt) - Date.parse(attempt.startedAt)
      );
    }
  }
  if (activeElapsedMs >= run.limits.maxActiveExecutionMs) {
    throw budget("maxActiveExecutionMs");
  }
}

export function recordAttemptDuration(
  run: Mutable<WorkflowRun>,
  attempt: Mutable<NodeAttempt>,
  settledAt: string
): void {
  if (!attempt.startedAt) return;
  run.counters.activeExecutionMs += Math.max(
    0,
    Date.parse(settledAt) - Date.parse(attempt.startedAt)
  );
}

function assertLeaseRevision(
  lease: Mutable<ResourceLease>,
  expectedRevision: number,
  expectedOwnerEpoch: number
): void {
  if (
    lease.revision !== expectedRevision ||
    lease.ownerEpoch !== expectedOwnerEpoch
  ) {
    throw new OrchestrationError(
      "stale-revision",
      "stale lease revision or owner epoch",
      {
        currentRevision: lease.revision,
        currentOwnerEpoch: lease.ownerEpoch
      }
    );
  }
}

export function requireNode(
  run: Mutable<WorkflowRun>,
  nodeId: Id
): Mutable<RunNode> {
  const node = run.graph.nodes[nodeId];
  if (!node)
    throw new OrchestrationError("not-found", `node '${nodeId}' was not found`);
  return node;
}

export function requireAttempt(
  run: Mutable<WorkflowRun>,
  attemptId: Id
): Mutable<NodeAttempt> {
  const attempt = run.attempts[attemptId];
  if (!attempt)
    throw new OrchestrationError(
      "not-found",
      `attempt '${attemptId}' was not found`
    );
  return attempt;
}

function requireLease(
  run: Mutable<WorkflowRun>,
  leaseId: Id
): Mutable<ResourceLease> {
  const lease = run.leases[leaseId];
  if (!lease)
    throw new OrchestrationError(
      "not-found",
      `lease '${leaseId}' was not found`
    );
  return lease;
}

export function markReady(node: Mutable<RunNode>): void {
  node.status = "ready";
  node.stateRevision += 1;
}

export function mutableClone<T>(value: T): Mutable<T> {
  return deepClone(value) as Mutable<T>;
}

export function emptyCounters(): RunBudgetCounters {
  return {
    nodes: 0,
    edges: 0,
    dispatches: 0,
    activeAttempts: 0,
    coordinatorTurns: 0,
    graphPatches: 0,
    loopIterations: 0,
    activeExecutionMs: 0,
    artifactBytes: 0,
    structuredResultBytes: 0
  };
}

export function stale(
  operation: string,
  current: number,
  expected: number
): OrchestrationError {
  return new OrchestrationError(
    "stale-revision",
    `${operation} expected revision ${expected}, current revision is ${current}`,
    {
      currentRevision: current,
      expectedRevision: expected
    }
  );
}

export function budget(
  limit: keyof WorkflowDefinitionV1["policies"]["limits"]
): OrchestrationError {
  return new OrchestrationError(
    "budget-exhausted",
    `Run limit '${limit}' is exhausted`,
    {
      limit
    }
  );
}

export function isTerminalRun(status: WorkflowRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
