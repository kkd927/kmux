import { describe, expect, it, vi } from "vitest";

import {
  admitNode,
  applyGraphPatch,
  createAdaptiveRun,
  failAttemptPreparation,
  prepareAgentPromptDelivery,
  prepareAttemptInputControl,
  contentHash,
  recordWorkerTerminalHistory,
  requestAttemptRetry,
  type AgentBindingDefinition,
  type RuntimeContext,
  type WorkflowRun
} from "@kmux/orchestration";

import {
  AgentPreparationNeedsAttentionError,
  formatWorkerMailboxNudge,
  LocalAgentNodeExecutor
} from "./localAgentNodeExecutor";
import type { PtyHostManager } from "./ptyHost";
import { LocalAgentReadinessRegistry } from "./localAgentReadiness";

function agentAttempt(
  sessionPolicy: "fresh" | "reuse" = "fresh",
  selection: Partial<
    Pick<AgentBindingDefinition, "agent" | "capabilities">
  > = {},
  coding = true
): {
  run: WorkflowRun;
  attemptId: string;
} {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => "2026-08-26T00:00:00.000Z",
    id: (kind) => `${kind}:${++sequence}`
  };
  let run = createAdaptiveRun({
    runId: "run:1",
    objective: "implement",
    inputs: { workerAgent: "codex" },
    limits: {
      maxNodes: 8,
      maxEdges: 8,
      maxGraphDepth: 4,
      maxFanOut: 4,
      maxLoopIterations: 2,
      maxActiveAttempts: 2,
      maxAttemptsPerSession: 8,
      maxDispatches: 8,
      maxCoordinatorTurns: 4,
      maxGraphPatches: 4,
      maxWallClockMs: 60_000,
      maxActiveExecutionMs: 60_000,
      maxArtifactBytes: 1024 * 1024,
      maxStructuredResultBytes: 1024 * 1024
    },
    context
  });
  run = applyGraphPatch(
    run,
    {
      runId: run.runId,
      expectedGraphRevision: 0,
      authorityEpoch: 1,
      authorPrincipal: "user:local",
      capabilityRef: "graph:1",
      idempotencyKey: "patch:1",
      operations: [
        {
          kind: "add-binding",
          agentRef: "worker",
          binding: {
            agent: { kind: "agent-id", agentId: "codex" },
            scope: { kind: "run" },
            authorityMode: "ambient",
            targetPolicy: "local",
            surfacePolicy: "create",
            sessionPolicy,
            worktreePolicy: "current",
            inputMode: "orchestrated",
            ...selection
          }
        },
        {
          kind: "add-node",
          node: {
            id: "work",
            kind: "agent",
            title: "Work",
            config: {
              version: 1,
              agentRef: "worker",
              prompt: "Implement safely",
              lifecycleMode: "managed",
              coding
            },
            completionRoot: true,
            onFailure: "wake-coordinator"
          }
        }
      ]
    },
    context
  ).run;
  const admitted = admitNode({
    run,
    nodeId: "work",
    expectedGraphRevision: run.graph.revision,
    expectedNodeStateRevision: run.graph.nodes.work!.stateRevision,
    context
  });
  return { run: admitted.run, attemptId: admitted.attempt.attemptId };
}

describe("LocalAgentNodeExecutor", () => {
  it("formats a body-free durable mailbox pointer", () => {
    const pointer = formatWorkerMailboxNudge({
      dispatchId: "dispatch:worker",
      operationId: "nudge:1",
      messageCount: 3
    });
    expect(pointer).toBe(
      "You have 3 orchestration messages.\nRun `kmux orchestration check --dispatch dispatch:worker`.\n[kmux-mailbox:nudge:1]\n"
    );
    expect(pointer).not.toContain("guidance body");
  });

  it.each(["settled", "registration-failed", "uncertain"] as const)(
    "returns only unused mailbox readiness when the nudge is %s",
    async (mode) => {
      const { run, attemptId } = agentAttempt();
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:1",
        surfaceId: "surface:1",
        sessionId: "session:1",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
        inputAuthorityRef: "authority:1"
      };
      const bound = prepareAttemptInputControl({
        run,
        attemptId,
        execution,
        launchReceipt: {
          requested: {},
          effective: {},
          evidence: "executor-applied",
          agentDescriptorRevision: "fixture"
        },
        context: { now: () => new Date().toISOString(), id: (kind) => kind }
      });
      const readiness = new LocalAgentReadinessRegistry({
        targetAuthority: "desktop:1",
        sessionRef: () => ({
          surfaceId: execution.surfaceId,
          sessionId: execution.sessionId,
          epoch: "epoch:1"
        })
      });
      const receipt = readiness.observe({
        event: {
          surfaceId: execution.surfaceId,
          sessionId: execution.sessionId,
          agent: "codex",
          event: "idle"
        },
        authenticatedSessionId: execution.sessionId
      })!;
      const ptyHost = {
        registerAgentReadiness: vi.fn(async () => {
          if (mode === "registration-failed")
            throw new Error("registration unavailable");
          return { outcome: "registered" };
        }),
        deliverOrchestratedInput: vi.fn(async () => ({ outcome: "unknown" }))
      } as unknown as PtyHostManager;
      const executor = new LocalAgentNodeExecutor({
        ptyHost,
        readiness,
        bindSurface: vi.fn(),
        captureRepositoryState: vi.fn(),
        mutations: {} as never,
        id: () => "unused"
      });
      const nudge = executor.nudgeWorker({
        run: bound,
        dispatchId: bound.attempts[attemptId]!.dispatchId!,
        messageCount: 1,
        operationId: "nudge:1",
        isStillPending: async () => mode !== "settled"
      });
      if (mode === "registration-failed")
        await expect(nudge).rejects.toThrow(/registration unavailable/u);
      else
        await expect(nudge).resolves.toMatchObject({
          outcome: mode === "uncertain" ? "uncertain" : "fenced"
        });
      if (mode === "uncertain") {
        expect(readiness.current({ execution, agentId: "codex" })).toBeNull();
        expect(ptyHost.deliverOrchestratedInput).toHaveBeenCalledTimes(1);
      } else {
        expect(
          readiness.current({ execution, agentId: "codex" })?.receiptId
        ).toBe(receipt.receiptId);
        expect(ptyHost.deliverOrchestratedInput).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    "terminal",
    "animated",
    "transcript",
    "truncated",
    "empty",
    "missing",
    "unreadable",
    "stale",
    "reused"
  ] as const)(
    "reads %s Worker output with an explicit source and status",
    async (mode) => {
      const { run, attemptId } = agentAttempt();
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:1",
        surfaceId: "surface:1",
        sessionId: "session:1",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
        inputAuthorityRef: "authority:1"
      };
      let bound = prepareAttemptInputControl({
        run,
        attemptId,
        execution,
        launchReceipt: {
          requested: {},
          effective: {},
          evidence: "executor-applied",
          agentDescriptorRevision: "fixture"
        },
        context: {
          now: () => "2026-09-20T00:00:00.000Z",
          id: (kind) => `${kind}:1`
        }
      });
      const dispatchId = bound.attempts[attemptId]!.dispatchId!;
      if (mode === "reused") {
        bound = {
          ...bound,
          dispatches: {
            ...bound.dispatches,
            [dispatchId]: {
              ...bound.dispatches[dispatchId]!,
              reusedByDispatchId: "dispatch:next",
              terminalState: "released"
            }
          }
        };
      }
      let current = true;
      const snapshot = vi.fn(
        async (
          _sessionId: string,
          _surfaceId: string,
          options?: { settleForMs?: number }
        ) => {
          if (mode === "animated" && (options?.settleForMs ?? 0) > 0)
            return null;
          if (mode === "unreadable") throw new Error("snapshot failed");
          if (mode === "missing") return null;
          return {
            vt: mode === "empty" ? "" : "final terminal state",
            cwd: "/repo",
            rawOutputTail: mode === "empty" ? "" : "worker-done"
          };
        }
      );
      const readTranscript = vi.fn(async () => {
        if (mode === "stale") current = false;
        return mode === "transcript" || mode === "truncated"
          ? {
              status: "available" as const,
              text: "[assistant]\nDetailed findings 한글",
              truncated: false
            }
          : { status: "unsupported" as const, text: "", truncated: false };
      });
      const executor = new LocalAgentNodeExecutor({
        ptyHost: {
          sessionRef: () => (current ? { epoch: "epoch:1" } : null),
          snapshot
        } as unknown as PtyHostManager,
        readTranscript,
        readiness: {} as LocalAgentReadinessRegistry,
        bindSurface: vi.fn(),
        captureRepositoryState: vi.fn(),
        mutations: {} as never,
        id: () => "unused"
      });
      const output = await executor.readWorker({
        run: bound,
        dispatchId,
        lines: 100,
        maxBytes: mode === "truncated" ? 5 : 1024
      });
      const expectedStatus =
        mode === "empty"
          ? "empty"
          : mode === "missing" || mode === "stale" || mode === "reused"
            ? "missing"
            : mode === "unreadable"
              ? "unreadable"
              : "available";
      expect(output).toMatchObject({
        dispatchId,
        surfaceId: "surface:1",
        sessionId: "session:1",
        status: expectedStatus,
        truncated: mode === "truncated"
      });
      if (
        mode === "transcript" ||
        mode === "truncated" ||
        mode === "stale" ||
        mode === "reused"
      ) {
        expect(snapshot).not.toHaveBeenCalled();
      }
      if (mode === "transcript")
        expect(output).toMatchObject({
          source: "transcript",
          vt: "[assistant]\nDetailed findings 한글"
        });
      if (mode === "truncated") {
        expect(output).toMatchObject({ source: "transcript", vt: "글" });
      }
      if (mode === "terminal")
        expect(output).toMatchObject({
          source: "terminal",
          cwd: "/repo",
          vt: "final terminal state",
          rawOutputTail: "worker-done",
          transcriptStatus: "unsupported"
        });
      if (mode === "reused") {
        expect(output).toMatchObject({
          status: "missing",
          source: null,
          transcriptStatus: "unsupported",
          vt: ""
        });
      }
    }
  );

  it.each(["agent-id", "run-input"] as const)(
    "rejects unadvertised %s requirements before allocating a Surface",
    async (kind) => {
      const initial = agentAttempt(
        "fresh",
        kind === "agent-id"
          ? { capabilities: ["filesystem-write"] }
          : {
              agent: {
                kind: "run-input",
                inputId: "workerAgent",
                requiredCapabilities: ["filesystem-write"]
              }
            }
      );
      const bindSurface = vi.fn();
      const markPreparationFailed = vi.fn();
      const capabilitiesForAgent = vi.fn(() => ["terminal"]);
      const executor = new LocalAgentNodeExecutor({
        capabilitiesForAgent,
        bindSurface,
        readiness: new LocalAgentReadinessRegistry({
          targetAuthority: "desktop:1",
          sessionRef: () => null
        }),
        ptyHost: {} as PtyHostManager,
        id: (kind) => kind,
        captureRepositoryState: vi.fn(),
        mutations: {
          persistInputControl: vi.fn(),
          observePreparationInput: vi.fn(),
          persistPending: vi.fn(),
          settleDelivery: vi.fn(),
          markPreparationFailed,
          markPreparationNeedsAttention: vi.fn()
        }
      });
      await executor.execute(initial);
      expect(capabilitiesForAgent).toHaveBeenCalledWith("codex");
      expect(markPreparationFailed).toHaveBeenCalledWith({
        attemptId: initial.attemptId,
        code: "agent-capability-unsupported",
        reason: expect.stringContaining("filesystem-write")
      });
      expect(bindSurface).not.toHaveBeenCalled();
    }
  );

  it.each(["fresh", "reuse"] as const)(
    "cancels only an owned native %s terminal generation",
    async (policy) => {
      const { run, attemptId } = agentAttempt(policy);
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:1",
        surfaceId: "surface:1",
        sessionId: "session:1",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
        inputAuthorityRef: "authority:1"
      };
      const bind = (owner: "runtime" | "user") =>
        prepareAttemptInputControl({
          run,
          attemptId,
          execution,
          launchReceipt: {
            requested: {},
            effective: {},
            evidence: "unknown",
            agentDescriptorRevision: "fixture"
          },
          priorOwnership:
            owner === "user"
              ? { owner, consentReceiptId: "consent:fixture" }
              : { owner },
          context: {
            now: () => "2026-08-26T00:00:00.000Z",
            id: (kind) => `${kind}:1`
          }
        });
      const boundRun = bind("runtime");
      const closeSessionGeneration = vi.fn(async () => "terminated" as const);
      const executor = new LocalAgentNodeExecutor({
        ptyHost: { closeSessionGeneration } as unknown as PtyHostManager,
        readiness: {} as LocalAgentReadinessRegistry,
        bindSurface: vi.fn(),
        captureRepositoryState: vi.fn(),
        mutations: {} as never,
        id: () => "cancel:1"
      });

      await expect(
        executor.cancel({ run: boundRun, attemptId })
      ).resolves.toEqual({ executorReceiptId: "cancel:1:terminated" });
      expect(closeSessionGeneration).toHaveBeenCalledWith({
        surfaceId: "surface:1",
        sessionId: "session:1",
        epoch: "epoch:1"
      });
      await expect(
        executor.cancel({ run: bind("user"), attemptId })
      ).rejects.toThrow(/ownership/u);
    }
  );

  it("removes the exact Worker Surface after a confirmed terminal release", async () => {
    const { run, attemptId } = agentAttempt();
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:1",
      surfaceId: "surface:1",
      sessionId: "session:1",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
      inputAuthorityRef: "authority:1"
    };
    const prepared = prepareAttemptInputControl({
      run,
      attemptId,
      execution,
      launchReceipt: {
        requested: {},
        effective: {},
        evidence: "unknown",
        agentDescriptorRevision: "fixture"
      },
      priorOwnership: { owner: "runtime" },
      context: {
        now: () => "2026-09-20T00:00:00.000Z",
        id: (kind) => `${kind}:1`
      }
    });
    const settledAt = "2026-09-20T00:00:01.000Z";
    const settled = {
      ...prepared,
      attempts: {
        ...prepared.attempts,
        [attemptId]: {
          ...prepared.attempts[attemptId]!,
          status: "succeeded" as const,
          settledAt
        }
      }
    };
    const closeSessionGeneration = vi.fn(async () => "terminated" as const);
    const removeReleasedSurface = vi.fn();
    const executor = new LocalAgentNodeExecutor({
      ptyHost: { closeSessionGeneration } as unknown as PtyHostManager,
      readiness: {} as LocalAgentReadinessRegistry,
      bindSurface: vi.fn(),
      captureRepositoryState: vi.fn(),
      mutations: {} as never,
      id: () => "unused",
      removeReleasedSurface
    });

    await expect(
      executor.releaseWorkerTerminal({ run: settled, attemptId })
    ).resolves.toBe("released");
    expect(closeSessionGeneration).toHaveBeenCalledWith(
      {
        surfaceId: "surface:1",
        sessionId: "session:1",
        epoch: "epoch:1"
      },
      10_000,
      settledAt
    );
    expect(removeReleasedSurface).toHaveBeenCalledWith(execution);
  });

  it("preserves a settled kmux-owned terminal after new user input", async () => {
    const { run, attemptId } = agentAttempt();
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:1",
      surfaceId: "surface:1",
      sessionId: "session:1",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
      inputAuthorityRef: "authority:1"
    };
    const prepared = prepareAttemptInputControl({
      run,
      attemptId,
      execution,
      launchReceipt: {
        requested: {},
        effective: {},
        evidence: "unknown",
        agentDescriptorRevision: "fixture"
      },
      priorOwnership: { owner: "runtime" },
      context: {
        now: () => "2026-09-11T00:00:00.000Z",
        id: (kind) => `${kind}:1`
      }
    });
    const bound = {
      ...prepared,
      attempts: {
        ...prepared.attempts,
        [attemptId]: {
          ...prepared.attempts[attemptId]!,
          status: "succeeded" as const,
          settledAt: "2026-09-11T00:00:01.000Z"
        }
      }
    };
    const closeSessionGeneration = vi.fn();
    const executor = new LocalAgentNodeExecutor({
      ptyHost: { closeSessionGeneration } as unknown as PtyHostManager,
      readiness: {} as LocalAgentReadinessRegistry,
      bindSurface: vi.fn(),
      captureRepositoryState: vi.fn(),
      mutations: {} as never,
      id: () => "unused",
      lastUserInputAt: () => "2026-09-11T00:00:02.000Z"
    });

    await expect(
      executor.releaseWorkerTerminal({ run: bound, attemptId })
    ).resolves.toBe("retained");
    expect(closeSessionGeneration).not.toHaveBeenCalled();
  });

  it("treats the PTY-host direct-input fence as a user takeover", async () => {
    const { run, attemptId } = agentAttempt();
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:1",
      surfaceId: "surface:1",
      sessionId: "session:1",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
      inputAuthorityRef: "authority:1"
    };
    const prepared = prepareAttemptInputControl({
      run,
      attemptId,
      execution,
      launchReceipt: {
        requested: {},
        effective: {},
        evidence: "unknown",
        agentDescriptorRevision: "fixture"
      },
      priorOwnership: { owner: "runtime" },
      context: {
        now: () => "2026-09-20T00:00:00.000Z",
        id: (kind) => `${kind}:1`
      }
    });
    const settledAt = "2026-09-20T00:00:01.000Z";
    const bound = {
      ...prepared,
      attempts: {
        ...prepared.attempts,
        [attemptId]: {
          ...prepared.attempts[attemptId]!,
          status: "succeeded" as const,
          settledAt
        }
      }
    };
    const closeSessionGeneration = vi.fn(async () => "input-observed" as const);
    const executor = new LocalAgentNodeExecutor({
      ptyHost: { closeSessionGeneration } as unknown as PtyHostManager,
      readiness: {} as LocalAgentReadinessRegistry,
      bindSurface: vi.fn(),
      captureRepositoryState: vi.fn(),
      mutations: {} as never,
      id: () => "unused"
    });

    await expect(
      executor.releaseWorkerTerminal({ run: bound, attemptId })
    ).resolves.toBe("retained");
    expect(closeSessionGeneration).toHaveBeenCalledWith(
      {
        surfaceId: "surface:1",
        sessionId: "session:1",
        epoch: "epoch:1"
      },
      10_000,
      settledAt
    );
  });

  it.each(["pty", "read-only", "launch-failed"])(
    "launches a native CLI, proves readiness, and persists before %s delivery",
    async (transport) => {
      const order: string[] = [];
      const { run, attemptId } = agentAttempt(
        "fresh",
        {},
        transport !== "read-only"
      );
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:1",
        surfaceId: "surface:1",
        sessionId: "session:1",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
        inputAuthorityRef: "authority:1"
      };
      const readiness = {
        receiptId: "readiness:1",
        execution,
        agentId: "codex",
        agentInstanceId: "agent-instance:1",
        readyEpoch: "ready-epoch:1",
        state: "ready-for-input" as const,
        observedAt: "2026-08-26T00:00:00.000Z"
      };
      const ptyHost = {
        registerAgentReadiness: vi.fn(async () => ({ outcome: "registered" })),
        deliverOrchestratedInput: vi.fn(async () => {
          order.push("write");
          return { outcome: "written", requestId: "pty-write:1" };
        })
      } as unknown as PtyHostManager;
      const settleDelivery = vi.fn(async () => {
        order.push("settle");
      });
      const markPreparationFailed = vi.fn(async () => undefined);
      const executor = new LocalAgentNodeExecutor({
        ptyHost,
        readiness: {
          waitForReadiness: vi.fn(async () => readiness)
        } as unknown as LocalAgentReadinessRegistry,
        bindSurface: vi.fn(async () => ({
          execution,
          cwd: "/repo",
          launchReceipt: {
            requested: {},
            effective: {},
            evidence: "executor-applied" as const,
            agentDescriptorRevision: "codex-test-v1"
          },
          start: async () => {
            order.push("launch");
            if (transport === "launch-failed")
              throw new Error("CLI startup failed");
          }
        })),
        captureRepositoryState: vi.fn(async () => ({
          targetId: "local",
          repositoryId: "repo:1",
          headOid: "a".repeat(40),
          capturedAt: "2026-08-26T00:00:00.000Z",
          consistency: "fenced-live-worktree" as const
        })),
        mutations: {
          observePreparationInput: async ({ onChange }) => {
            const bound = prepareAttemptInputControl({
              run,
              attemptId,
              execution,
              launchReceipt: {
                requested: {},
                effective: {},
                evidence: "executor-applied",
                agentDescriptorRevision: "codex-test-v1"
              },
              context: { now: () => readiness.observedAt, id: (kind) => kind }
            });
            onChange(bound.inputControls[attemptId]!);
            return () => undefined;
          },
          persistInputControl: vi.fn(async () => {
            order.push("ownership");
          }),
          persistPending: vi.fn(async (input) => {
            order.push("persist");
            return {
              operationId: input.operationId,
              dispatchId: "dispatch:1",
              execution,
              readinessReceiptId: readiness.receiptId,
              payloadHash: input.payloadHash,
              state: "pending" as const
            };
          }),
          settleDelivery,
          markPreparationFailed,
          markPreparationNeedsAttention: vi.fn(async () => undefined)
        },
        id: () => "delivery:1"
      });

      await executor.execute({ run, attemptId });
      if (transport === "launch-failed") {
        expect(order).toEqual(["ownership", "launch"]);
        expect(markPreparationFailed).toHaveBeenCalledWith({
          attemptId,
          code: "agent-launch-failed",
          reason: "CLI startup failed"
        });
        expect(ptyHost.deliverOrchestratedInput).not.toHaveBeenCalled();
        return;
      }
      expect(order).toEqual([
        "ownership",
        "launch",
        "persist",
        "write",
        "settle"
      ]);
      expect(markPreparationFailed).not.toHaveBeenCalled();
      if (transport === "read-only") {
        expect(ptyHost.deliverOrchestratedInput).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("Do not modify files or Git state.")
          })
        );
      }
      expect(settleDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "delivery:1",
          outcome: "written"
        })
      );
      expect(ptyHost.deliverOrchestratedInput).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "delivery:1",
          readinessReceiptId: "readiness:1",
          text: expect.stringContaining(
            `kmux orchestration worker-done --task 'work'`
          )
        })
      );
    }
  );

  it.each(["repository", "registration", "pending"] as const)(
    "retries the same idle CLI after a %s preparation failure without a second launch",
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
      try {
        let { run, attemptId } = agentAttempt();
        let sequence = 0;
        const context: RuntimeContext = {
          now: () => new Date().toISOString(),
          id: (kind) => `${kind}:retry-test:${++sequence}`
        };
        const execution = {
          targetId: "local",
          targetAuthority: "desktop:1",
          surfaceId: "surface:1",
          sessionId: "session:1",
          generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
          inputAuthorityRef: "authority:1"
        };
        const launchReceipt = {
          requested: {},
          effective: {},
          evidence: "executor-applied" as const,
          agentDescriptorRevision: "codex-test-v1"
        };
        const readiness = new LocalAgentReadinessRegistry({
          targetAuthority: "desktop:1",
          sessionRef: () => ({
            surfaceId: execution.surfaceId,
            sessionId: execution.sessionId,
            epoch: "epoch:1"
          }),
          // No output or hook occurs between preparation failure and retry.
          observeTui: async () => ({ state: "ready", observationId: "idle:1" })
        });
        let first = true;
        const failOnce = (stage: typeof failure) => {
          if (first && failure === stage) {
            first = false;
            throw new Error(`${stage} unavailable`);
          }
        };
        const start = vi.fn(async () => undefined);
        const ptyHost = {
          registerAgentReadiness: vi.fn(async () => {
            failOnce("registration");
            return { outcome: "registered" };
          }),
          deliverOrchestratedInput: vi.fn(async () => ({
            outcome: "written",
            requestId: "write:1"
          }))
        } as unknown as PtyHostManager;
        const markPreparationFailed = vi.fn(async (input) => {
          run = failAttemptPreparation({ run, ...input, context });
        });
        const executor = new LocalAgentNodeExecutor({
          ptyHost,
          readiness,
          readinessTimeoutMs: 1_000,
          bindSurface: async () => ({
            execution,
            cwd: "/repo",
            launchReceipt,
            ...(start.mock.calls.length === 0 ? { start } : {})
          }),
          captureRepositoryState: async () => {
            failOnce("repository");
            return {
              targetId: "local",
              repositoryId: "repo:1",
              headOid: "a".repeat(40),
              capturedAt: context.now(),
              consistency: "fenced-live-worktree"
            };
          },
          mutations: {
            persistInputControl: async (input) => {
              run = prepareAttemptInputControl({ run, ...input, context });
            },
            observePreparationInput: async ({ attemptId, onChange }) => {
              onChange(run.inputControls[attemptId]!);
              return () => undefined;
            },
            persistPending: async (input) => {
              failOnce("pending");
              const prepared = prepareAgentPromptDelivery({
                run,
                ...input,
                launchReceipt,
                context
              });
              run = prepared.run;
              return prepared.delivery;
            },
            settleDelivery: vi.fn(async () => undefined),
            markPreparationFailed,
            markPreparationNeedsAttention: vi.fn(async () => undefined)
          },
          id: context.id
        });
        const failed = executor.execute({ run, attemptId });
        await vi.advanceTimersByTimeAsync(500);
        await failed;
        expect(markPreparationFailed).toHaveBeenCalledTimes(1);
        expect(ptyHost.deliverOrchestratedInput).not.toHaveBeenCalled();
        expect(Object.keys(run.deliveries)).toHaveLength(0);

        // The Host archives the failed Dispatch before transferring this
        // generation. This executor fixture bypasses the Host mutation port.
        run = recordWorkerTerminalHistory({
          run,
          dispatchId: run.attempts[attemptId]!.dispatchId!,
          history: {
            artifact: {
              artifactId: "artifact:failed-preparation",
              kind: "worker-output",
              contentHash: contentHash("preparation failure"),
              sizeBytes: 19
            },
            source: "terminal",
            status: "available",
            truncated: false
          }
        });

        run = requestAttemptRetry({
          run,
          attemptId,
          idempotencyKey: "retry:1",
          principal: "user:local",
          context
        }).run;
        const retried = admitNode({
          run,
          nodeId: "work",
          expectedGraphRevision: run.graph.revision,
          expectedNodeStateRevision: run.graph.nodes.work!.stateRevision,
          context
        });
        run = retried.run;
        attemptId = retried.attempt.attemptId;
        const retry = executor.execute({ run, attemptId });
        await vi.advanceTimersByTimeAsync(1_000);
        await retry;
        expect(markPreparationFailed).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(ptyHost.deliverOrchestratedInput).toHaveBeenCalledTimes(1);
        expect(Object.values(run.deliveries)).toMatchObject([
          { execution, state: "pending" }
        ]);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("persists an exact-reuse launch mismatch as needs-attention", async () => {
    const { run, attemptId } = agentAttempt();
    const markPreparationFailed = vi.fn(async () => undefined);
    const markPreparationNeedsAttention = vi.fn(async () => undefined);
    const executor = new LocalAgentNodeExecutor({
      ptyHost: {} as PtyHostManager,
      readiness: {} as LocalAgentReadinessRegistry,
      bindSurface: vi.fn(async () => {
        throw new AgentPreparationNeedsAttentionError(
          "agent-launch-reuse-mismatch",
          "requested model does not match the reusable session"
        );
      }),
      captureRepositoryState: vi.fn(),
      mutations: {
        observePreparationInput: vi.fn(),
        persistInputControl: vi.fn(),
        persistPending: vi.fn(),
        settleDelivery: vi.fn(),
        markPreparationFailed,
        markPreparationNeedsAttention
      },
      id: () => "unused"
    });

    await executor.execute({ run, attemptId });

    expect(markPreparationNeedsAttention).toHaveBeenCalledWith({
      attemptId,
      code: "agent-launch-reuse-mismatch",
      reason: "requested model does not match the reusable session"
    });
    expect(markPreparationFailed).not.toHaveBeenCalled();
  });
});
