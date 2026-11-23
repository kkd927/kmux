import { describe, expect, it, vi } from "vitest";
import {
  contentHash,
  createAdaptiveRun,
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  type AgentBindingDefinition,
  type Dispatch,
  type NodeAttempt,
  type RetryPolicy,
  type WorkflowRun
} from "@kmux/orchestration";
import { reuseLocalAgentSurface } from "./localAgentSurfaceReuse";

function retryPlacement(
  placement: RetryPolicy["placement"] = "same",
  sessionPolicy: AgentBindingDefinition["sessionPolicy"] = "fresh"
) {
  const base = createAdaptiveRun({
    runId: "run:retry",
    objective: "Retry a review",
    inputs: {},
    limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
    context: { now: () => "2026-09-11T00:00:00.000Z", id: (kind) => kind }
  });
  const binding: AgentBindingDefinition = {
    agent: { kind: "agent-id", agentId: "antigravity" },
    scope: { kind: "run" },
    authorityMode: "ambient",
    targetPolicy: "local",
    surfacePolicy: "create",
    sessionPolicy,
    worktreePolicy: "current",
    inputMode: "orchestrated"
  };
  const first: NodeAttempt = {
    attemptId: "first",
    runId: base.runId,
    nodeId: "review",
    ordinal: 1,
    status: "failed",
    createdAt: base.createdAt,
    resolvedInputs: {},
    inputInterventionIds: [],
    effectiveDefinitionHash: contentHash({}),
    effectiveGraphRevision: 1,
    effectiveNodeStateRevision: 1,
    dispatchId: "dispatch:first"
  };
  const attempt: NodeAttempt = {
    ...first,
    attemptId: "retry",
    dispatchId: "dispatch:retry",
    ordinal: 2,
    status: "preparing",
    retryOfAttemptId: first.attemptId
  };
  const previous: Dispatch = {
    dispatchId: first.dispatchId!,
    attemptId: first.attemptId,
    nodeId: first.nodeId,
    runId: base.runId,
    agentRef: "reviewer",
    selectedAgentId: "antigravity",
    bindingInstanceKey: "binding:reviewer",
    lifecycleMode: "managed",
    requestedBinding: binding,
    requestedLaunch: { model: "fixture-model", effort: "low" },
    launchReceipt: {
      requested: { model: "fixture-model", effort: "low" },
      effective: { model: "fixture-model", effort: "low" },
      evidence: "provider-verified",
      agentDescriptorRevision: "fixture-v1"
    },
    execution: {
      targetId: "local",
      targetAuthority: "desktop:test",
      surfaceId: "surface:first",
      sessionId: "session:first",
      generation: { kind: "local", runtimeEpoch: "epoch:first" },
      inputAuthorityRef: "authority:first"
    },
    terminalState: "reclaimable"
  };
  const current: Dispatch = {
    ...previous,
    dispatchId: attempt.dispatchId!,
    attemptId: attempt.attemptId,
    execution: undefined,
    terminalState: undefined
  };
  const run: WorkflowRun = {
    ...base,
    graph: {
      ...base.graph,
      nodes: {
        review: {
          nodeId: "review",
          definitionHash: contentHash({}),
          selectedPredecessors: [],
          stateRevision: 2,
          status: "preparing",
          attemptIds: [first.attemptId, attempt.attemptId],
          definition: {
            id: "review",
            kind: "agent",
            title: "Review",
            retryPolicy: {
              placement,
              maxAttempts: 2,
              retryable: ["executor-error"],
              backoffMs: 0
            },
            config: {
              version: 1,
              agentRef: "reviewer",
              prompt: "Review",
              lifecycleMode: "managed",
              coding: false
            }
          }
        }
      }
    },
    attempts: { first, retry: attempt },
    dispatches: {
      [previous.dispatchId]: previous,
      [current.dispatchId]: current
    },
    inputControls: {
      first: {
        attemptId: "first",
        execution: previous.execution!,
        mode: "orchestrated",
        owner: "runtime",
        revision: 2,
        priorOwner: "user",
        priorMode: "interactive-recorded",
        consentReceiptId: "consent:original",
        claimedAt: base.createdAt,
        updatedAt: base.createdAt
      }
    }
  };
  return {
    run,
    attempt,
    previous,
    worktreeRoot: async () => "/trusted/worktree",
    sessionCwd: vi.fn(() => "/trusted/worktree/subdir")
  };
}

describe("local Agent placement reuse", () => {
  it("selects retry ancestry before another live role Dispatch and retains original ownership", async () => {
    const input = retryPlacement();
    const interloper = {
      ...input.previous,
      dispatchId: "dispatch:other",
      attemptId: "other",
      execution: {
        ...input.previous.execution!,
        surfaceId: "surface:other",
        sessionId: "session:other"
      }
    };
    input.run = {
      ...input.run,
      dispatches: {
        ...input.run.dispatches,
        [interloper.dispatchId]: interloper
      }
    };
    const result = await reuseLocalAgentSurface(input);
    expect(result).toMatchObject({
      execution: input.previous.execution,
      cwd: "/trusted/worktree/subdir",
      priorOwnership: {
        owner: "user",
        mode: "interactive-recorded",
        consentReceiptId: "consent:original"
      }
    });
    expect(input.sessionCwd).toHaveBeenCalledExactlyOnceWith(
      input.previous.execution
    );
  });

  it.each(["same", "approval-for-change"] as const)(
    "does not let prefer-reuse replace unavailable %s retry placement",
    async (placement) => {
      const input = retryPlacement(placement, "prefer-reuse");
      await expect(
        reuseLocalAgentSurface({ ...input, sessionCwd: () => undefined })
      ).rejects.toMatchObject({ code: "agent-retry-placement-unavailable" });
    }
  );

  it("allows explicit fresh retry without touching the old session", async () => {
    const input = retryPlacement("allow-fresh");
    expect(await reuseLocalAgentSurface(input)).toBeUndefined();
    expect(input.sessionCwd).not.toHaveBeenCalled();
  });

  it("refuses exact reuse after the settled terminal received new user work", async () => {
    const input = retryPlacement();
    input.run = {
      ...input.run,
      attempts: {
        ...input.run.attempts,
        first: {
          ...input.run.attempts.first!,
          settledAt: "2026-09-11T00:00:01.000Z"
        }
      }
    };
    await expect(
      reuseLocalAgentSurface({
        ...input,
        lastUserInputAt: () => "2026-09-11T00:00:02.000Z"
      })
    ).rejects.toThrow(/new user input/u);
  });

  it("requires the new worktree input to match the original physical placement", async () => {
    const input = retryPlacement();
    const current = input.run.dispatches[input.attempt.dispatchId!]!;
    input.run = {
      ...input.run,
      dispatches: {
        ...input.run.dispatches,
        [current.dispatchId]: {
          ...current,
          requestedBinding: {
            ...current.requestedBinding,
            worktreePolicy: "from-input"
          }
        }
      }
    };
    input.attempt = {
      ...input.attempt,
      resolvedInputs: {
        worktree: {
          pathToken: contentHash({
            targetId: "local",
            path: "/trusted/worktree"
          })
        }
      }
    };
    expect((await reuseLocalAgentSurface(input))?.execution).toEqual(
      input.previous.execution
    );
    input.attempt = {
      ...input.attempt,
      resolvedInputs: {
        worktree: { worktreeRef: input.attempt.resolvedInputs.worktree }
      }
    };
    expect((await reuseLocalAgentSurface(input))?.execution).toEqual(
      input.previous.execution
    );
    input.attempt = {
      ...input.attempt,
      resolvedInputs: { worktree: { pathToken: "another-worktree" } }
    };
    await expect(reuseLocalAgentSurface(input)).rejects.toThrow(
      /requested worktree differs/
    );
  });

  it("keeps exact retry blocked when the provider cannot prove the requested model", async () => {
    const input = retryPlacement("same", "prefer-reuse");
    input.run = {
      ...input.run,
      dispatches: {
        ...input.run.dispatches,
        [input.previous.dispatchId]: {
          ...input.previous,
          launchReceipt: {
            ...input.previous.launchReceipt!,
            effective: { model: "another-model" }
          }
        }
      }
    };
    await expect(reuseLocalAgentSurface(input)).rejects.toThrow(
      /model or effort does not match/
    );
  });
});
