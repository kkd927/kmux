import {
  LOCAL_V1_HOST_MAX_RUN_LIMITS,
  type AdHocTask,
  type CreateAdaptiveRunCommand,
  type Dispatch,
  type NodeAttempt,
  type OrchestrationSnapshot,
  type PromptDelivery,
  type WorkflowRun,
  type OrchestrationRunSummary
} from "@kmux/orchestration";
import { OrchestrationError } from "@kmux/orchestration";

export function summarize(run: WorkflowRun): OrchestrationRunSummary {
  const activeTurn = run.coordinatorTurns.find(
    (turn) => turn.status === "active"
  );
  return {
    runId: run.runId,
    workerTerminalPolicy: run.workerTerminalPolicy,
    source: structuredClone(run.source),
    status: run.status,
    ...(run.outputs ? { outputs: run.outputs } : {}),
    ...(run.callerUnavailable
      ? { callerUnavailable: run.callerUnavailable }
      : {}),
    graphRevision: run.graph.revision,
    authoringState: run.graph.authoringState,
    counters: run.counters,
    coordinationAuthorityEpoch: run.coordinationAuthorityEpoch,
    coordinatorEventCursor: run.coordinatorEventCursor,
    coordinatorConsumedCursor: run.coordinatorConsumedCursor,
    ...(run.coordinatorAttachment
      ? { coordinatorTransport: run.coordinatorAttachment.transport }
      : {}),
    ...(activeTurn
      ? {
          activeCoordinatorTurn: {
            turnId: activeTurn.turnId
          }
        }
      : {}),
    nodeStates: Object.fromEntries(
      Object.values(run.graph.nodes).map((node) => [node.nodeId, node.status])
    ),
    workers: Object.values(run.graph.nodes)
      .filter((node) => node.definition.kind === "agent")
      .map((node) => {
        const attemptId = node.activeAttemptId ?? node.attemptIds.at(-1);
        const attempt = attemptId ? run.attempts[attemptId] : undefined;
        const dispatch = attempt?.dispatchId
          ? run.dispatches[attempt.dispatchId]
          : undefined;
        const execution = dispatch?.execution;
        const issue =
          node.admissionFailure ??
          attempt?.preparationIssue ??
          attempt?.completionIssue;
        const stage = node.admissionFailure
          ? "admission-failed"
          : issue
            ? issue.code
            : !attempt && activeTurn
              ? "coordinator-active"
              : node.status === "pending"
                ? "awaiting-dependencies"
                : node.status === "ready"
                  ? run.counters.activeAttempts >= run.limits.maxActiveAttempts
                    ? "awaiting-capacity"
                    : "awaiting-admission"
                  : attempt?.status === "preparing"
                    ? execution
                      ? "agent-readiness"
                      : "resource-preparation"
                    : (attempt?.status ?? node.status);
        return {
          nodeId: node.nodeId,
          stage,
          ...(dispatch?.terminalState
            ? { terminalState: dispatch.terminalState }
            : {}),
          ...(attempt
            ? { attemptId: attempt.attemptId, dispatchId: attempt.dispatchId }
            : {}),
          ...(execution
            ? {
                surfaceId: execution.surfaceId,
                sessionId: execution.sessionId,
                generation: execution.generation
              }
            : {}),
          ...(issue
            ? { issue: { code: issue.code, message: issue.message } }
            : {})
        };
      })
  };
}

export function taskProjection(run: WorkflowRun, task: AdHocTask) {
  const node = task.nodeId ? run.graph.nodes[task.nodeId] : undefined;
  const attemptId = node?.activeAttemptId ?? node?.attemptIds.at(-1);
  const attempt = attemptId ? run.attempts[attemptId] : undefined;
  const dispatch = attempt?.dispatchId
    ? run.dispatches[attempt.dispatchId]
    : undefined;
  const result = attempt ? run.attemptResults[attempt.attemptId] : undefined;
  return {
    taskId: task.taskId,
    runId: task.runId,
    title: task.title,
    spec: task.spec,
    dependencies: task.dependencies,
    status: node?.status ?? "pending",
    ...(attempt ? { attemptId: attempt.attemptId } : {}),
    ...(dispatch ? { dispatchId: dispatch.dispatchId } : {}),
    ...(attempt?.preparationIssue
      ? { issue: attempt.preparationIssue }
      : attempt?.completionIssue
        ? { issue: attempt.completionIssue }
        : node?.admissionFailure
          ? { issue: node.admissionFailure }
          : {}),
    ...(result
      ? {
          outcome: result.outcome,
          summary: result.summary,
          ...(result.reportPath ? { reportPath: result.reportPath } : {})
        }
      : {})
  };
}

export function workerProjection(run: WorkflowRun, dispatchId: string) {
  const dispatch = run.dispatches[dispatchId];
  if (!dispatch) {
    throw new OrchestrationError(
      "not-found",
      `Dispatch '${dispatchId}' was not found`
    );
  }
  const attempt = run.attempts[dispatch.attemptId];
  const node = run.graph.nodes[dispatch.nodeId];
  const result = run.attemptResults[dispatch.attemptId];
  const terminalState = dispatch.terminalState;
  const nextAction =
    terminalState === "active"
      ? [
          `kmux orchestration check --dispatch ${dispatchId}`,
          `kmux orchestration worker-done --task ${dispatch.nodeId} --dispatch ${dispatchId} ...`
        ]
      : terminalState === "reclaimable"
        ? [
            `kmux orchestration worker-start --reuse ${dispatchId} ...`,
            `kmux orchestration worker-retain --dispatch ${dispatchId}`,
            `kmux orchestration worker-release --dispatch ${dispatchId}`
          ]
        : terminalState === "release-unknown"
          ? [
              `kmux orchestration worker-read --dispatch ${dispatchId}`,
              `kmux orchestration worker-release --dispatch ${dispatchId}`
            ]
          : terminalState === "release-pending"
            ? ["wait for the exact release operation to settle"]
            : [`kmux orchestration worker-read --dispatch ${dispatchId}`];
  return {
    runId: run.runId,
    taskId: dispatch.nodeId,
    dispatchId,
    attemptId: dispatch.attemptId,
    agentId: dispatch.selectedAgentId,
    ...(dispatch.lastHeartbeat
      ? { lastHeartbeat: dispatch.lastHeartbeat }
      : {}),
    ...(dispatch.historyIssue ? { historyIssue: dispatch.historyIssue } : {}),
    status: attempt?.status ?? node?.status ?? "pending",
    ...(terminalState ? { terminalState, nextAction } : {}),
    ...(dispatch.execution
      ? {
          surfaceId: dispatch.execution.surfaceId,
          sessionId: dispatch.execution.sessionId,
          generation: dispatch.execution.generation
        }
      : {}),
    ...(attempt?.preparationIssue
      ? { issue: attempt.preparationIssue }
      : attempt?.completionIssue
        ? { issue: attempt.completionIssue }
        : node?.admissionFailure
          ? { issue: node.admissionFailure }
          : {}),
    ...(result ? { result } : {})
  };
}

export function locateDispatch(
  snapshot: OrchestrationSnapshot,
  dispatchId: string
): { readonly run: WorkflowRun; readonly dispatch: Dispatch } {
  const matches = Object.values(snapshot.runs).flatMap((run) => {
    const dispatch = run.dispatches[dispatchId];
    return dispatch ? [{ run, dispatch }] : [];
  });
  if (matches.length !== 1) {
    throw new OrchestrationError(
      matches.length === 0 ? "not-found" : "conflict",
      `Dispatch '${dispatchId}' is not uniquely addressable`
    );
  }
  return matches[0]!;
}

export function requireRun(
  snapshot: OrchestrationSnapshot,
  runId: string
): WorkflowRun {
  const run = snapshot.runs[runId];
  if (!run)
    throw new OrchestrationError("not-found", `Run '${runId}' was not found`);
  return run;
}

export function visibleRuns(
  snapshot: OrchestrationSnapshot,
  principal: string
): WorkflowRun[] {
  const runs = Object.values(snapshot.runs);
  if (principal === "user:local") return runs;
  const delegatedRunIds = new Set(
    Object.values(snapshot.capabilities)
      .filter((capability) => capability.principal === principal)
      .map((capability) => capability.runId)
  );
  return runs.filter((run) => delegatedRunIds.has(run.runId));
}

export function requireVisibleRun(
  snapshot: OrchestrationSnapshot,
  runId: string,
  principal: string
): WorkflowRun {
  const run = requireRun(snapshot, runId);
  if (
    principal !== "user:local" &&
    visibleRuns(snapshot, principal).every(
      (visibleRun) => visibleRun.runId !== run.runId
    )
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "a managed Agent terminal can only inspect its delegated Runs"
    );
  }
  return run;
}

export function requireAttempt(
  snapshot: OrchestrationSnapshot,
  attemptId: string
): { readonly run: WorkflowRun; readonly attempt: NodeAttempt } {
  const matches = Object.values(snapshot.runs).flatMap((run) => {
    const attempt = run.attempts[attemptId];
    return attempt ? [{ run, attempt }] : [];
  });
  if (matches.length !== 1) {
    throw new OrchestrationError(
      matches.length === 0 ? "not-found" : "conflict",
      `attempt '${attemptId}' is not uniquely addressable`
    );
  }
  return matches[0]!;
}

export function requireDelivery(
  snapshot: OrchestrationSnapshot,
  operationId: string
): { readonly run: WorkflowRun; readonly delivery: PromptDelivery } {
  const matches = Object.values(snapshot.runs).flatMap((run) => {
    const delivery = run.deliveries[operationId];
    return delivery ? [{ run, delivery }] : [];
  });
  if (matches.length !== 1) {
    throw new OrchestrationError(
      matches.length === 0 ? "not-found" : "conflict",
      `delivery '${operationId}' is not uniquely addressable`
    );
  }
  return matches[0]!;
}

export function requireShellOperation(
  snapshot: OrchestrationSnapshot,
  operationId: string
): { readonly run: WorkflowRun } {
  const run = Object.values(snapshot.runs).find(
    (candidate) => candidate.shellOperations[operationId]
  );
  if (!run) {
    throw new OrchestrationError(
      "not-found",
      `Shell operation '${operationId}' was not found`
    );
  }
  return { run };
}

export function assertWithinHostLimits(
  requested: CreateAdaptiveRunCommand["limits"]
): void {
  for (const key of Object.keys(LOCAL_V1_HOST_MAX_RUN_LIMITS) as Array<
    keyof typeof LOCAL_V1_HOST_MAX_RUN_LIMITS
  >) {
    if (requested[key] > LOCAL_V1_HOST_MAX_RUN_LIMITS[key]) {
      throw new OrchestrationError(
        "budget-exhausted",
        `requested Run limit '${key}' exceeds the local host maximum`,
        {
          requested: requested[key],
          maximum: LOCAL_V1_HOST_MAX_RUN_LIMITS[key]
        }
      );
    }
  }
}
