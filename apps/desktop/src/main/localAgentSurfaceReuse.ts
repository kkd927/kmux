import {
  contentHash,
  agentRetryPlacementChangeApproved,
  requiredAgentPlacement,
  type AgentLaunchPreferences,
  type AgentLaunchReceipt,
  type Dispatch,
  type NodeAttempt,
  type TerminalExecutionRef,
  type WorkflowRun
} from "@kmux/orchestration";

import {
  AgentPreparationNeedsAttentionError,
  type LocalAgentSurfaceBinding
} from "./localAgentNodeExecutor";
import { worktreePathToken } from "./orchestrationRepositoryState";

/** Resolve reuse before any workspace, worktree or Surface allocation. */
export async function reuseLocalAgentSurface(input: {
  readonly run: WorkflowRun;
  readonly attempt: NodeAttempt;
  /** Returns the canonical cwd only while this exact terminal generation exists. */
  readonly sessionCwd: (execution: TerminalExecutionRef) => string | undefined;
  readonly worktreeRoot: (cwd: string) => Promise<string | undefined>;
  readonly lastUserInputAt?: (
    execution: TerminalExecutionRef
  ) => string | undefined;
}): Promise<LocalAgentSurfaceBinding | undefined> {
  const { run, attempt } = input;
  const dispatch = attempt.dispatchId && run.dispatches[attempt.dispatchId];
  if (!dispatch) throw new Error("Agent attempt has no Dispatch");
  if (agentRetryPlacementChangeApproved(run, attempt)) return undefined;
  const previous = requiredAgentPlacement(run, attempt);
  const exactRetry = Boolean(previous);
  const policy = dispatch.requestedBinding.sessionPolicy;
  if (!exactRetry && policy === "fresh") return undefined;

  // Retry ancestry takes precedence over another node using the same role.
  const candidates = exactRetry
    ? [previous!]
    : Object.values(run.dispatches)
        .filter(
          (candidate) =>
            candidate.dispatchId !== dispatch.dispatchId &&
            candidate.bindingInstanceKey === dispatch.bindingInstanceKey
        )
        .reverse();
  let failure = "no reusable Agent session is available";
  for (const candidate of candidates) {
    try {
      const execution = candidate.execution;
      if (!execution) throw new Error("previous placement was not established");
      if (
        candidate.selectedAgentId !== dispatch.selectedAgentId ||
        candidate.bindingInstanceKey !== dispatch.bindingInstanceKey ||
        (dispatch.requestedBinding.existingSurfaceId &&
          execution.surfaceId !== dispatch.requestedBinding.existingSurfaceId)
      )
        throw new Error("previous placement does not match this Agent binding");
      if (candidate.terminalState !== "reclaimable") {
        throw new Error("previous Worker terminal is not reclaimable");
      }
      if (
        Object.values(run.leases).some(
          (lease) =>
            lease.owner.kind === "attempt" &&
            lease.owner.id === candidate.attemptId &&
            lease.state !== "released"
        ) ||
        Object.values(run.deliveries).some(
          (delivery) =>
            delivery.dispatchId === candidate.dispatchId &&
            ["pending", "accepted", "uncertain"].includes(delivery.state)
        ) ||
        Object.values(run.cancellations).some(
          (operation) =>
            operation.attemptId === candidate.attemptId &&
            operation.state !== "confirmed"
        )
      )
        throw new Error(
          "previous placement still has unresolved execution effects"
        );
      const cwd = input.sessionCwd(execution);
      if (!cwd) throw new Error("previous terminal generation is unavailable");
      const priorControl = run.inputControls[candidate.attemptId];
      const priorAttempt = run.attempts[candidate.attemptId];
      if (!priorControl)
        throw new Error("reusable Agent ownership is unproven");
      const lastUserInputAt = input.lastUserInputAt?.(execution);
      if (
        lastUserInputAt &&
        (!priorAttempt?.settledAt || lastUserInputAt > priorAttempt.settledAt)
      ) {
        throw new Error(
          "the terminal received new user input after the Worker settled"
        );
      }
      const root = await input.worktreeRoot(cwd);
      const pathToken =
        root &&
        contentHash({
          targetId: execution.targetId,
          path: root
        });
      if (
        candidate.repositoryStateInput?.worktreeRef &&
        candidate.repositoryStateInput.worktreeRef.pathToken !== pathToken
      )
        throw new Error("previous Agent worktree identity has changed");
      if (dispatch.requestedBinding.worktreePolicy === "from-input") {
        const worktree =
          attempt.resolvedInputs[
            dispatch.requestedBinding.worktreeInput?.target ?? "worktree"
          ];
        if (!pathToken || worktreePathToken(worktree) !== pathToken)
          throw new Error(
            "requested worktree differs from the previous placement"
          );
      }
      const launchReceipt = admitReusedAgentLaunchReceipt(
        candidate,
        dispatch.requestedLaunch
      );
      return {
        execution,
        cwd,
        launchReceipt,
        priorOwnership: {
          owner: priorControl.priorOwner,
          ...(priorControl.priorMode ? { mode: priorControl.priorMode } : {}),
          ...(priorControl.consentReceiptId
            ? { consentReceiptId: priorControl.consentReceiptId }
            : {})
        }
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (exactRetry) break;
    }
  }
  if (exactRetry || (policy !== "prefer-reuse" && candidates.length > 0)) {
    throw new AgentPreparationNeedsAttentionError(
      exactRetry
        ? "agent-retry-placement-unavailable"
        : "agent-launch-reuse-unavailable",
      exactRetry
        ? `Exact retry placement could not be proven: ${failure}. A placement change requires an explicit policy or approval.`
        : failure
    );
  }
  return undefined;
}

function admitReusedAgentLaunchReceipt(
  prior: Dispatch,
  requested: AgentLaunchPreferences
): AgentLaunchReceipt {
  const receipt = prior.launchReceipt;
  if (!receipt)
    throw new Error("reused Agent session has no proven launch receipt");
  if (
    (requested.model !== undefined &&
      (receipt.evidence === "unknown" ||
        requested.model !== receipt.effective.model)) ||
    (requested.effort !== undefined &&
      (receipt.evidence === "unknown" ||
        requested.effort !== receipt.effective.effort))
  )
    throw new Error(
      "requested model or effort does not match the reusable Agent session"
    );
  return { ...receipt, requested: { ...requested } };
}
