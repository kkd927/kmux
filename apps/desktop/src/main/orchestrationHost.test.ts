import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  contentHash,
  initializeFlowEditorDocument,
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  starterWorkflowDefinition,
  type FlowEditorDocumentV1,
  type JsonValue,
  type OrchestrationStore,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "@kmux/orchestration";

import { LocalOrchestrationHost } from "./orchestrationHost";
import type { LocalAgentExecutionDriver } from "./orchestrationContracts";

const workerBinding = () => ({
  agent: { kind: "agent-id" as const, agentId: "codex" },
  scope: { kind: "run" as const },
  authorityMode: "ambient" as const,
  targetPolicy: "local" as const,
  surfacePolicy: "create" as const,
  sessionPolicy: "fresh" as const,
  worktreePolicy: "current" as const,
  inputMode: "orchestrated" as const
});

const terminalCoordinator = (sessionId: string) => ({
  transport: "terminal" as const,
  surfaceId: `surface:${sessionId}`,
  sessionId,
  execution: {
    targetId: "local",
    targetAuthority: "desktop:test",
    surfaceId: `surface:${sessionId}`,
    sessionId,
    generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
    inputAuthorityRef: "unclaimed"
  },
  process: { pid: 1, startedAt: "2026-08-26T00:00:00.000Z" }
});

function configureTerminalFixture(
  host: LocalOrchestrationHost,
  driver: Partial<LocalAgentExecutionDriver> = {}
) {
  const execution = terminalCoordinator("contract-worker").execution;
  host.configureExecution({
    getWorkerTerminalPolicy: () => ({ succeeded: "release", failed: "retain" }),
    driver: {
      execute: async ({ attemptId }) => {
        await host.persistAttemptInputControl({
          attemptId,
          execution,
          launchReceipt: {
            requested: {},
            effective: {},
            evidence: "executor-applied",
            agentDescriptorRevision: "fixture"
          }
        });
        const pending = await host.persistPendingPromptDelivery({
          attemptId,
          execution,
          readiness: {
            receiptId: `ready:${attemptId}`,
            execution,
            agentId: "codex",
            agentInstanceId: "contract-worker",
            readyEpoch: `ready:${attemptId}`,
            state: "ready-for-input",
            observedAt: new Date().toISOString()
          },
          operationId: `delivery:${attemptId}`,
          payloadHash: contentHash(attemptId)
        });
        await host.settlePromptDelivery({
          operationId: pending.operationId,
          payloadHash: pending.payloadHash,
          outcome: "written",
          receiptId: `written:${attemptId}`
        });
      },
      readWorker: async ({ dispatchId }) => ({
        dispatchId,
        source: "terminal",
        status: "available",
        vt: `History for ${dispatchId}`,
        truncated: false
      }),
      releaseWorkerTerminal: async () => "released",
      ...driver
    },
    trustedResultAssembler: { assemble: async () => ({}) },
    isExecutionCurrent: () => true
  });
}

describe("native Task placement and decisions", () => {
  it.each([
    ["current", "current"],
    ["new-child", "dedicated-child"],
    ["new-top-level", "dedicated-top-level"]
  ] as const)(
    "uses %s placement through the shared Agent binding",
    async (worktree, policy) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-native-placement-"));
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "state.json")
      });
      const principal = "session:contract-coordinator";
      configureTerminalFixture(host);
      try {
        await host.handle(
          {
            method: "orchestration.run.create",
            params: {
              runId: "run:placement",
              objective: "Placement",
              inputs: {},
              limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
              coordinatorAttachment: terminalCoordinator(
                "contract-coordinator"
              ),
              idempotencyKey: "run"
            }
          },
          principal
        );
        const started = await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId: "run:placement",
              spec: "Work in the requested worktree",
              agentId: "codex",
              worktree,
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "start"
            }
          },
          principal
        );
        const run = await host.handle(
          {
            method: "orchestration.run.get",
            params: { runId: "run:placement" }
          },
          principal
        );
        expect(
          run.dispatches[started.dispatchId!]!.requestedBinding.worktreePolicy
        ).toBe(policy);
        await expect(
          host.handle(
            {
              method: "orchestration.worker.start",
              params: {
                runId: run.runId,
                taskId: started.taskId,
                agentId: "codex",
                retryDispatchId: started.dispatchId!,
                worktree: "current",
                coding: false,
                allowParallelAgent: false,
                preferences: {},
                requestId: "retry-moved"
              }
            },
            principal
          )
        ).rejects.toMatchObject({ code: "invalid" });
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("persists a Task-owned Human Gate and admits its dependent Worker only after a local-user choice", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-native-gate-"));
    const filePath = join(root, "state.json");
    let host = await LocalOrchestrationHost.open({ filePath });
    const principal = "session:contract-coordinator";
    const runId = "run:gate";
    configureTerminalFixture(host);
    const getRun = () =>
      host.handle(
        { method: "orchestration.run.get", params: { runId } },
        principal
      );
    try {
      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId,
            objective: "Choose before merging",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("contract-coordinator"),
            idempotencyKey: "run"
          }
        },
        principal
      );
      for (const taskId of ["choice", "merge"])
        await host.handle(
          {
            method: "orchestration.task.create",
            params: {
              runId,
              taskId,
              spec: taskId,
              dependencies: taskId === "merge" ? ["choice"] : [],
              requestId: taskId
            }
          },
          principal
        );
      const request = {
        method: "orchestration.gate.create" as const,
        params: {
          runId,
          taskId: "choice",
          question: "Select A or B",
          options: ["A", "B"],
          requestId: "gate"
        }
      };
      await expect(host.handle(request, "session:other")).rejects.toMatchObject(
        { code: "unauthorized" }
      );
      await host.handle(request, principal);
      await host.drive();
      await host.handle(request, principal);
      expect(Object.values((await getRun()).gates)).toHaveLength(1);
      await expect(
        host.handle(
          {
            ...request,
            params: { ...request.params, question: "Different choice" }
          },
          principal
        )
      ).rejects.toMatchObject({ code: "conflict" });
      const originalGate = Object.values((await getRun()).gates)[0]!;
      await host.checkpointForShutdown();
      host = await LocalOrchestrationHost.open({ filePath });
      configureTerminalFixture(host);
      const listed = await host.handle(
        {
          method: "orchestration.gate.list",
          params: { runId, taskId: "choice", state: "open" }
        },
        principal
      );
      expect(listed.gates).toMatchObject([
        { gateId: originalGate.gateId, state: "open" }
      ]);
      const starting = host.handle(
        {
          method: "orchestration.worker.start",
          params: {
            runId,
            taskId: "merge",
            agentId: "codex",
            coding: false,
            allowParallelAgent: false,
            preferences: {},
            requestId: "start:merge"
          }
        },
        principal
      );
      for (let i = 0; i < 100 && !(await getRun()).graph.nodes.merge; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await host.drive();
      expect((await getRun()).graph.nodes.merge?.status).toBe("pending");
      expect(Object.values((await getRun()).dispatches)).toHaveLength(0);
      await expect(
        host.handle(
          {
            method: "orchestration.gate.resolve",
            params: { runId, gateId: originalGate.gateId, resolution: "A" }
          },
          principal
        )
      ).rejects.toMatchObject({ code: "unauthorized" });
      await host.handle(
        {
          method: "orchestration.gate.resolve",
          params: { runId, gateId: originalGate.gateId, resolution: "A" }
        },
        "user:local"
      );
      expect(await starting).toMatchObject({
        taskId: "merge",
        status: "running"
      });
      expect((await getRun()).gates[originalGate.gateId]).toMatchObject({
        state: "resolved",
        resolution: "A",
        resolvedBy: "user:local"
      });
    } finally {
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function publishAndStart(
  host: LocalOrchestrationHost,
  definition: WorkflowDefinitionV1,
  runId: string
) {
  const draftId = `draft:${definition.definitionId}`;
  await host.handle(
    {
      method: "workflow.draft.create",
      params: {
        draftId,
        definitionId: definition.definitionId,
        name: definition.name,
        canonicalDraft: definition as unknown as JsonValue,
        editorDocument: initializeFlowEditorDocument(
          definition
        ) as unknown as JsonValue
      }
    },
    "user:local"
  );
  const validation = await host.handle(
    { method: "workflow.draft.validate", params: { draftId } },
    "user:local"
  );
  expect(validation, JSON.stringify(validation)).toMatchObject({
    publishable: true,
    canonical: { ok: true },
    semanticallyEquivalent: true
  });
  const published = (await host.handle(
    {
      method: "workflow.publish",
      params: {
        draftId,
        expectedRevision: 1
      }
    },
    "user:local"
  )) as { version: { workflowVersionId: string } };
  await host.handle(
    {
      method: "workflow.run",
      params: {
        workflowVersionId: published.version.workflowVersionId,
        runId,
        inputs: {}
      }
    },
    "user:local"
  );
}

function admissionWorkflow(workerIds: string[]): WorkflowDefinitionV1 {
  const base = starterWorkflowDefinition({
    definitionId: "admission",
    name: "Admission"
  });
  return {
    ...base,
    agentBindings: { worker: workerBinding() },
    nodes: [
      ...base.nodes.map((node) =>
        node.kind === "end"
          ? { ...node, joinPolicy: "all-successful" as const }
          : node
      ),
      ...workerIds.map((id) => ({
        id,
        kind: "agent" as const,
        title: id,
        config: {
          version: 1 as const,
          agentRef: "worker",
          prompt: "Fixture task",
          lifecycleMode: "managed" as const,
          coding: false
        },
        onFailure: "skip-descendants" as const
      }))
    ],
    edges: workerIds.flatMap((id) => [
      { id: `start-${id}`, from: { nodeId: "start" }, to: { nodeId: id } },
      { id: `${id}-end`, from: { nodeId: id }, to: { nodeId: "end" } }
    ])
  };
}

function rawLoopWorkflow(expression: string): WorkflowDefinitionV1 {
  const base = starterWorkflowDefinition({
    definitionId: "raw-loop",
    name: "Raw Loop"
  });
  return {
    ...base,
    inputs: [],
    outputs: [],
    agentBindings: {},
    nodes: [
      base.nodes.find((node) => node.kind === "start")!,
      {
        id: "loop",
        kind: "loop",
        title: "Loop",
        config: {
          version: 1,
          mode: "while",
          maxIterations: 2,
          body: {
            nodeIds: ["review", "judge"],
            entryNodeIds: ["review"],
            exits: [
              { nodeId: "judge", port: "repeat", outcome: "repeat" },
              { nodeId: "judge", port: "clean", outcome: "clean" }
            ]
          },
          repeatOutcome: "repeat",
          completedOutcomes: ["clean"],
          completedPort: "clean",
          maxReachedPort: "limit"
        }
      },
      {
        id: "review",
        kind: "condition",
        title: "Review",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "true",
          ports: ["ok", "unused"]
        }
      },
      {
        id: "judge",
        kind: "condition",
        title: "Judge",
        config: {
          version: 1,
          expressionVersion: 1,
          expression,
          ports: ["repeat", "clean"]
        },
        joinPolicy: "any-successful",
        anySuccessfulDisposition: "wait"
      },
      {
        id: "end",
        kind: "end",
        title: "End",
        completionRoot: true,
        joinPolicy: "any-successful",
        anySuccessfulDisposition: "wait",
        config: { version: 1 }
      }
    ],
    edges: [
      { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
      {
        id: "review-judge",
        from: { nodeId: "review", port: "ok" },
        to: { nodeId: "judge" }
      },
      {
        id: "review-judge-unused",
        from: { nodeId: "review", port: "unused" },
        to: { nodeId: "judge" }
      },
      ...["clean", "limit"].map((port) => ({
        id: `loop-${port}`,
        from: { nodeId: "loop", port },
        to: { nodeId: "end" }
      }))
    ]
  };
}

describe("local authenticated orchestration host", () => {
  it.each([false, true])(
    "settles raw Loop conditions instead of leaving preparation active (invalid=%s)",
    async (invalid) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-raw-loop-"));
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json")
      });
      const runId = "run:raw-loop";
      try {
        await publishAndStart(
          host,
          rawLoopWorkflow(
            invalid
              ? 'nodes.review.result.data.missing == "value"'
              : 'nodes.review.status == "succeeded"'
          ),
          runId
        );
        await host.drive();
        const run = (await host.handle(
          { method: "orchestration.run.get", params: { runId } },
          "user:local"
        )) as WorkflowRun;
        expect(run.status).toBe(invalid ? "failed" : "succeeded");
        expect(run.counters.activeAttempts).toBe(0);
        const judges = Object.values(run.graph.nodes).filter(
          (node) => node.materialization?.templateNodeId === "judge"
        );
        expect(judges).toHaveLength(invalid ? 1 : 2);
        for (const judge of judges) {
          expect(judge.status).toBe(invalid ? "failed" : "succeeded");
          if (invalid)
            expect(
              run.attempts[judge.attemptIds[0]!]?.preparationIssue
            ).toMatchObject({ code: "control-evaluation-failed" });
        }
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("cancels a waiting control node without Agent or Shell terminal ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-control-cancel-"));
    const host = await LocalOrchestrationHost.open({
      filePath: join(root, "orchestration.json")
    });
    const base = starterWorkflowDefinition({
      definitionId: "control-cancel",
      name: "Control cancellation"
    });
    const definition: WorkflowDefinitionV1 = {
      ...base,
      inputs: [],
      outputs: [],
      agentBindings: {},
      nodes: [
        ...base.nodes,
        {
          id: "gate",
          kind: "human-gate",
          title: "Approval",
          config: {
            version: 1,
            question: "Continue?",
            resolutions: ["approve", "reject"],
            approverPolicy: "local-user"
          }
        }
      ],
      edges: [
        { id: "start-gate", from: { nodeId: "start" }, to: { nodeId: "gate" } },
        {
          id: "gate-end",
          from: { nodeId: "gate", port: "approve" },
          to: { nodeId: "end" }
        }
      ]
    };
    try {
      await publishAndStart(host, definition, "run:control-cancel");
      await host.drive();
      const getRun = async () =>
        (await host.handle(
          {
            method: "orchestration.run.get",
            params: { runId: "run:control-cancel" }
          },
          "user:local"
        )) as WorkflowRun;
      const run = await getRun();
      expect(run.status).toBe("waiting-gate");
      const attemptId = run.graph.nodes.gate!.activeAttemptId!;
      await expect(
        host.handle(
          {
            method: "orchestration.attempt.cancel",
            params: { attemptId, idempotencyKey: "cancel:gate" }
          },
          "user:local"
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      const canceled = await getRun();
      expect(canceled.attempts[attemptId]?.status).toBe("canceled");
      expect(Object.values(canceled.gates)).toEqual([
        expect.objectContaining({ state: "canceled" })
      ]);
      expect(canceled.counters.activeAttempts).toBe(0);
      await expect(
        host.handle(
          {
            method: "orchestration.attempt.cancel",
            params: { attemptId, idempotencyKey: "cancel:gate" }
          },
          "user:local"
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
    } finally {
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "preserves a preparation-failed Dispatch before exact retry (archive fails=%s)",
    async (archiveFails) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-failed-retry-history-"));
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json")
      });
      const runId = "run:failed-retry-history";
      const principal = "session:contract-coordinator";
      const execution = terminalCoordinator("contract-worker").execution;
      let count = 0;
      let text = "Original preparation failure";
      configureTerminalFixture(host, {
        execute: async ({ attemptId }) => {
          try {
            await host.persistAttemptInputControl({
              attemptId,
              execution,
              launchReceipt: {
                requested: {},
                effective: {},
                evidence: "executor-applied",
                agentDescriptorRevision: "fixture"
              }
            });
          } catch (error) {
            await host.failPreparation({
              attemptId,
              reason: (error as Error).message
            });
            return;
          }
          count++;
          if (count === 1)
            await host.failPreparation({
              attemptId,
              reason: "worktree fenced"
            });
          else {
            text = "Retry output";
            await host.failPreparation({
              attemptId,
              reason: "Retry reached the existing terminal"
            });
          }
        },
        readWorker: async () => {
          if (archiveFails) throw new Error("archive unavailable");
          return {
            source: "terminal",
            status: "available",
            vt: text,
            truncated: false
          };
        }
      });
      try {
        await host.handle(
          {
            method: "orchestration.run.create",
            params: {
              runId,
              objective: "Retry a failed preparation",
              inputs: {},
              limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
              coordinatorAttachment: terminalCoordinator(
                "contract-coordinator"
              ),
              idempotencyKey: "create"
            }
          },
          principal
        );
        const first = (await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              spec: "Read only",
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "first"
            }
          },
          principal
        )) as { taskId: string; dispatchId: string };
        const retry = host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              taskId: first.taskId,
              retryDispatchId: first.dispatchId,
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "retry"
            }
          },
          principal
        );
        await expect(retry).resolves.toMatchObject({ status: "failed" });
        const run = (await host.handle(
          { method: "orchestration.run.get", params: { runId } },
          principal
        )) as WorkflowRun;
        if (archiveFails) {
          expect(count).toBe(1);
          expect(run.dispatches[first.dispatchId]).toMatchObject({
            terminalState: "reclaimable",
            historyIssue: "archive unavailable"
          });
        } else {
          expect(count).toBe(2);
          expect(run.dispatches[first.dispatchId]?.terminalState).toBe(
            "released"
          );
          await expect(
            host.handle(
              {
                method: "orchestration.worker.read",
                params: {
                  dispatchId: first.dispatchId,
                  lines: 100,
                  maxBytes: 4096
                }
              },
              principal
            )
          ).resolves.toMatchObject({
            archived: true,
            vt: "Original preparation failure"
          });
        }
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("keeps precreated dependent Tasks dispatchable after each acknowledgement, including restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-pending-tasks-"));
    const filePath = join(root, "orchestration.json");
    let host = await LocalOrchestrationHost.open({ filePath });
    const runId = "run:pending-tasks";
    const principal = "session:contract-coordinator";
    const run = async () =>
      (await host.handle(
        { method: "orchestration.run.get", params: { runId } },
        principal
      )) as WorkflowRun;
    configureTerminalFixture(host);
    try {
      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId,
            objective: "Implement, review, correct, and re-review",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("contract-coordinator"),
            idempotencyKey: "create"
          }
        },
        principal
      );
      const tasks = ["implementation", "review", "correction", "rereview"];
      for (const [index, taskId] of tasks.entries()) {
        await host.handle(
          {
            method: "orchestration.task.create",
            params: {
              runId,
              taskId,
              spec: taskId,
              dependencies: index ? [tasks[index - 1]!] : [],
              requestId: `create:${taskId}`
            }
          },
          principal
        );
      }
      for (const [index, taskId] of tasks.entries()) {
        const worker = (await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              taskId,
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: `start:${taskId}`
            }
          },
          principal
        )) as { dispatchId: string; attemptId: string };
        await host.handle(
          {
            method: "orchestration.worker.done",
            params: {
              taskId,
              dispatchId: worker.dispatchId,
              outcome: "succeeded",
              summary: `${taskId} completed`
            }
          },
          "session:contract-worker"
        );
        const inbox = (await host.handle(
          {
            method: "orchestration.inbox.check",
            params: { runId, wait: false, timeoutMs: 0 }
          },
          principal
        )) as { delivery: { deliveryId: string } };
        await host.handle(
          {
            method: "orchestration.inbox.check",
            params: {
              runId,
              wait: false,
              timeoutMs: 0,
              ack: inbox.delivery.deliveryId
            }
          },
          principal
        );
        expect((await run()).graph.authoringState).toBe(
          index === tasks.length - 1 ? "sealed" : "open"
        );
        if (index === 0) {
          await host.checkpointForShutdown();
          host = await LocalOrchestrationHost.open({ filePath });
          configureTerminalFixture(host);
        }
      }
      expect((await run()).status).toBe("succeeded");
    } finally {
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "normal",
    "read-failure",
    "missing",
    "save-failure",
    "artifact-save-failure"
  ] as const)(
    "preserves history before stopping a Worker, or keeps its terminal open (%s)",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-stop-history-"));
      const filePath = join(root, "orchestration.json");
      let host = await LocalOrchestrationHost.open({ filePath });
      const runId = "run:stop-history";
      const principal = "session:contract-coordinator";
      const getRun = async () =>
        (await host.handle(
          { method: "orchestration.run.get", params: { runId } },
          principal
        )) as WorkflowRun;
      const cancel = vi.fn(
        async ({ run, attemptId }: { run: WorkflowRun; attemptId: string }) => {
          const dispatchId = run.attempts[attemptId]!.dispatchId!;
          expect(run.dispatches[dispatchId]!.terminalHistory).toBeDefined();
          return { executorReceiptId: "cancel:confirmed" };
        }
      );
      configureTerminalFixture(host, {
        cancel,
        readWorker: async ({ dispatchId }) => {
          if (mode === "read-failure") throw new Error("read failed");
          return {
            dispatchId,
            source: "terminal",
            status: mode === "missing" ? "missing" : "available",
            vt: "Worker output before stop",
            truncated: false
          };
        }
      });
      try {
        await host.handle(
          {
            method: "orchestration.run.create",
            params: {
              runId,
              objective: "Stop without losing history",
              inputs: {},
              limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
              coordinatorAttachment: terminalCoordinator(
                "contract-coordinator"
              ),
              idempotencyKey: "create"
            }
          },
          principal
        );
        const worker = (await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              spec: "Running Worker",
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "start"
            }
          },
          principal
        )) as { dispatchId: string; attemptId: string };
        if (mode === "save-failure") {
          const store = (host as unknown as { store: OrchestrationStore })
            .store;
          const transact = store.transact.bind(store);
          vi.spyOn(store, "transact").mockImplementation((audit, mutation) =>
            audit.type === "orchestration.worker.history-preserved"
              ? Promise.reject(new Error("save failed"))
              : transact(audit, mutation)
          );
        }
        if (mode === "artifact-save-failure")
          writeFileSync(
            join(root, "orchestration-artifacts"),
            "not a directory"
          );
        const response = await host.handle(
          {
            method: "orchestration.attempt.cancel",
            params: { attemptId: worker.attemptId, idempotencyKey: "stop" }
          },
          principal
        );
        if (mode !== "normal") {
          expect(response).toMatchObject({
            outcome: "uncertain",
            message: expect.stringContaining("terminal kept open")
          });
          expect(cancel).not.toHaveBeenCalled();
          expect((await getRun()).dispatches[worker.dispatchId]).toMatchObject({
            terminalState: "active",
            historyIssue: expect.any(String)
          });
        } else {
          expect(response).toMatchObject({ outcome: "confirmed" });
          expect(cancel).toHaveBeenCalledOnce();
          expect((await getRun()).attempts[worker.attemptId]!.status).toBe(
            "canceled"
          );
          await host.checkpointForShutdown();
          host = await LocalOrchestrationHost.open({ filePath });
          await expect(
            host.handle(
              {
                method: "orchestration.worker.read",
                params: {
                  dispatchId: worker.dispatchId,
                  lines: 100,
                  maxBytes: 4096
                }
              },
              "user:local"
            )
          ).resolves.toMatchObject({
            archived: true,
            status: "available",
            vt: "Worker output before stop"
          });
        }
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "archives the previous Dispatch before terminal reuse (read fails=%s)",
    async (readFails) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-reuse-history-"));
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json")
      });
      const runId = "run:reuse-history";
      const principal = "session:contract-coordinator";
      let text = "First Task output";
      let failRead = readFails;
      const readWorker = vi.fn(async () => {
        if (failRead) throw new Error("read failed");
        return {
          source: "terminal",
          status: "available",
          vt: text,
          truncated: false
        };
      });
      configureTerminalFixture(host, { readWorker });
      try {
        await host.handle(
          {
            method: "orchestration.run.create",
            params: {
              runId,
              objective: "Reuse without mixing Task histories",
              inputs: {},
              limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
              coordinatorAttachment: terminalCoordinator(
                "contract-coordinator"
              ),
              idempotencyKey: "create"
            }
          },
          principal
        );
        await host.handle(
          {
            method: "orchestration.task.create",
            params: {
              runId,
              taskId: "next",
              spec: "Next Task",
              dependencies: [],
              requestId: "next"
            }
          },
          principal
        );
        const first = (await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              spec: "First Task",
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "first"
            }
          },
          principal
        )) as { taskId: string; dispatchId: string };
        await host.handle(
          {
            method: "orchestration.worker.done",
            params: {
              taskId: first.taskId,
              dispatchId: first.dispatchId,
              outcome: "succeeded",
              summary: "First Task done"
            }
          },
          "session:contract-worker"
        );
        const reuse = {
          method: "orchestration.worker.start" as const,
          params: {
            runId,
            taskId: "next",
            reuseDispatchId: first.dispatchId,
            agentId: "codex",
            coding: false,
            allowParallelAgent: false,
            preferences: {},
            requestId: "reuse"
          }
        };
        if (readFails) {
          await expect(host.handle(reuse, principal)).rejects.toThrow(
            /terminal kept open/u
          );
          const run = (await host.handle(
            { method: "orchestration.run.get", params: { runId } },
            principal
          )) as WorkflowRun;
          expect(Object.keys(run.dispatches)).toHaveLength(1);
          expect(run.dispatches[first.dispatchId]).toMatchObject({
            terminalState: "reclaimable",
            historyIssue: "read failed"
          });
          failRead = false;
          await host.handle(reuse, principal);
          const recovered = (await host.handle(
            { method: "orchestration.run.get", params: { runId } },
            principal
          )) as WorkflowRun;
          expect(
            recovered.dispatches[first.dispatchId]!.terminalHistory
          ).toBeDefined();
          expect(
            recovered.dispatches[first.dispatchId]!.historyIssue
          ).toBeUndefined();
        } else {
          const second = (await host.handle(reuse, principal)) as {
            dispatchId: string;
          };
          text = "Next Task output";
          await expect(
            host.handle(
              {
                method: "orchestration.worker.read",
                params: {
                  dispatchId: first.dispatchId,
                  lines: 100,
                  maxBytes: 4096
                }
              },
              principal
            )
          ).resolves.toMatchObject({ archived: true, vt: "First Task output" });
          await expect(host.handle(reuse, principal)).resolves.toMatchObject({
            dispatchId: second.dispatchId
          });
          expect(readWorker).toHaveBeenCalledOnce();
        }
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["succeeded", "retain", "normal"],
    ["failed", "retain", "normal"],
    ["succeeded", "release", "normal"],
    ["failed", "release", "normal"],
    ["succeeded", "release", "read-failure"],
    ["succeeded", "release", "missing"],
    ["succeeded", "release", "save-failure"],
    ["succeeded", "release", "artifact-save-failure"]
  ] as const)(
    "settles reviewed %s Workers using the snapshotted %s policy (%s)",
    async (outcome, disposition, archiveMode) => {
      const root = mkdtempSync(join(tmpdir(), "kmux-worker-policy-"));
      const filePath = join(root, "orchestration.json");
      let host = await LocalOrchestrationHost.open({ filePath });
      let policy: WorkflowRun["workerTerminalPolicy"] = {
        succeeded: outcome === "succeeded" ? disposition : "retain",
        failed: outcome === "failed" ? disposition : "retain"
      };
      let currentGeneration = true;
      const execution = terminalCoordinator("policy-worker").execution;
      const releaseWorkerTerminal = vi.fn(async () => "released" as const);
      host.configureExecution({
        getWorkerTerminalPolicy: () => policy,
        driver: {
          execute: async ({ attemptId }) => {
            await host.persistAttemptInputControl({
              attemptId,
              execution,
              launchReceipt: {
                requested: {},
                effective: {},
                evidence: "executor-applied",
                agentDescriptorRevision: "fixture"
              }
            });
            const delivery = await host.persistPendingPromptDelivery({
              attemptId,
              execution,
              readiness: {
                receiptId: "ready:policy",
                execution,
                agentId: "codex",
                agentInstanceId: "instance:policy",
                readyEpoch: "ready:policy",
                state: "ready-for-input",
                observedAt: new Date().toISOString()
              },
              operationId: "delivery:policy",
              payloadHash: contentHash("task")
            });
            await host.settlePromptDelivery({
              operationId: delivery.operationId,
              payloadHash: delivery.payloadHash,
              outcome: "written",
              receiptId: "receipt:policy"
            });
          },
          releaseWorkerTerminal,
          readWorker: async (): Promise<JsonValue> => {
            if (archiveMode === "read-failure") throw new Error("read failed");
            if (archiveMode === "missing") return { vt: "", status: "missing" };
            return { vt: "archived Worker history" };
          }
        },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => currentGeneration
      });
      const principal = "session:policy-coordinator";
      const runId = "run:policy";
      const getRun = async () =>
        (await host.handle(
          {
            method: "orchestration.run.get",
            params: { runId }
          },
          "user:local"
        )) as WorkflowRun;
      const check = (ack?: string) =>
        host.handle(
          {
            method: "orchestration.inbox.check",
            params: { runId, wait: false, timeoutMs: 0, ack }
          },
          principal
        );
      try {
        await host.handle(
          {
            method: "orchestration.run.create",
            params: {
              runId,
              objective: "Review before cleanup",
              inputs: {},
              limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
              coordinatorAttachment: terminalCoordinator("policy-coordinator"),
              idempotencyKey: "create:policy"
            }
          },
          principal
        );
        const savedPolicy = structuredClone(policy);
        policy = {
          succeeded: disposition === "retain" ? "release" : "retain",
          failed: disposition === "retain" ? "release" : "retain"
        };
        const worker = (await host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId,
              spec: "Short task",
              agentId: "codex",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "start:policy"
            }
          },
          principal
        )) as { dispatchId: string; taskId: string; attemptId: string };
        expect((await getRun()).workerTerminalPolicy).toEqual(savedPolicy);
        const beforeHeartbeat = await getRun();
        const heartbeat = {
          method: "orchestration.worker.heartbeat" as const,
          params: {
            taskId: worker.taskId,
            dispatchId: worker.dispatchId,
            phase: "Reviewing sources"
          }
        };
        await expect(
          host.handle(heartbeat, "session:another-worker")
        ).rejects.toThrow();
        await expect(
          host.handle(
            {
              ...heartbeat,
              params: { ...heartbeat.params, taskId: "task:wrong" }
            },
            "session:policy-worker"
          )
        ).rejects.toThrow(/do not match/u);
        currentGeneration = false;
        await expect(
          host.handle(heartbeat, "session:policy-worker")
        ).rejects.toThrow(/stale/u);
        currentGeneration = true;
        await host.handle(heartbeat, "session:policy-worker");
        const alive = await getRun();
        expect(alive.dispatches[worker.dispatchId]?.lastHeartbeat).toEqual({
          phase: "Reviewing sources",
          receivedAt: expect.any(String)
        });
        expect(alive.attempts[worker.attemptId]?.status).toBe(
          beforeHeartbeat.attempts[worker.attemptId]?.status
        );
        expect(alive.mailboxEvents).toEqual(beforeHeartbeat.mailboxEvents);
        expect(alive.coordinatorTurns).toEqual(
          beforeHeartbeat.coordinatorTurns
        );
        if (archiveMode === "save-failure") {
          const store = (host as unknown as { store: OrchestrationStore })
            .store;
          const transact = store.transact.bind(store);
          vi.spyOn(store, "transact").mockImplementation((audit, mutation) => {
            if (audit.type === "orchestration.worker.history-preserved")
              return Promise.reject(new Error("save failed"));
            return transact(audit, mutation);
          });
        }
        await host.handle(
          {
            method: "orchestration.worker.done",
            params: {
              taskId: worker.taskId,
              dispatchId: worker.dispatchId,
              outcome,
              summary: "Explicit result",
              reportPath: "/reports/review.md"
            }
          },
          "session:policy-worker"
        );
        if (archiveMode === "artifact-save-failure") {
          writeFileSync(
            join(root, "orchestration-artifacts"),
            "not a directory"
          );
        }
        expect(
          (await getRun()).dispatches[worker.dispatchId]?.terminalState
        ).toBe("reclaimable");
        const receipt = (await check()) as {
          delivery: {
            deliveryId: string;
            events: ReadonlyArray<{ result?: { reportPath?: string } }>;
          };
        };
        expect(
          receipt.delivery.events.some(
            (event) => event.result?.reportPath === "/reports/review.md"
          )
        ).toBe(true);
        await expect(
          host.handle(heartbeat, "session:policy-worker")
        ).rejects.toThrow();
        expect(releaseWorkerTerminal).not.toHaveBeenCalled();
        await expect(check("wrong-receipt")).rejects.toThrow(
          /exact mailbox consumer/u
        );
        currentGeneration = false;
        await expect(check(receipt.delivery.deliveryId)).rejects.toThrow(
          /stale/u
        );
        currentGeneration = true;
        expect(releaseWorkerTerminal).not.toHaveBeenCalled();
        // An older Coordinator's explicit release cannot override Keep open.
        if (disposition === "retain" && outcome === "succeeded") {
          await host.handle(
            {
              method: "orchestration.input.disposition",
              params: {
                attemptId: worker.attemptId,
                disposition: "release",
                idempotencyKey: "release:policy"
              }
            },
            principal
          );
        }
        if (archiveMode !== "normal") {
          await expect(check(receipt.delivery.deliveryId)).rejects.toThrow(
            /terminal kept open/u
          );
          expect((await getRun()).dispatches[worker.dispatchId]).toMatchObject({
            terminalState: "retained",
            historyIssue: expect.any(String)
          });
          expect(releaseWorkerTerminal).not.toHaveBeenCalled();
        }
        await check(receipt.delivery.deliveryId);
        let run = await getRun();
        const expectedDisposition =
          archiveMode === "normal" ? disposition : "retain";
        expect(run.dispatches[worker.dispatchId]?.terminalState).toBe(
          expectedDisposition === "retain" ? "retained" : "released"
        );
        expect(
          run.mailboxConsumers.coordinator?.activeDelivery
        ).toBeUndefined();
        expect(run.graph.authoringState).toBe("sealed");
        expect(releaseWorkerTerminal).toHaveBeenCalledTimes(
          expectedDisposition === "release" ? 1 : 0
        );
        if (expectedDisposition === "release") {
          expect(
            run.dispatches[worker.dispatchId]?.terminalHistory
          ).toMatchObject({
            source: "terminal",
            status: "available",
            artifact: { kind: "worker-output" }
          });
        }
        await host.checkpointForShutdown();
        host = await LocalOrchestrationHost.open({ filePath });
        run = await getRun();
        expect(run.workerTerminalPolicy).toEqual(savedPolicy);
        if (expectedDisposition === "release") {
          await expect(
            host.handle(
              {
                method: "orchestration.worker.read",
                params: { dispatchId: worker.dispatchId, lines: 1, maxBytes: 7 }
              },
              "user:local"
            )
          ).resolves.toMatchObject({
            archived: true,
            source: "terminal",
            status: "available",
            truncated: true,
            vt: "history"
          });
          const history = run.dispatches[worker.dispatchId]!.terminalHistory!;
          const digest = history.artifact.contentHash.slice(7);
          writeFileSync(
            join(
              root,
              "orchestration-artifacts",
              digest.slice(0, 2),
              `${digest}.bin`
            ),
            "corrupted archive"
          );
          await expect(
            host.handle(
              {
                method: "orchestration.worker.read",
                params: { dispatchId: worker.dispatchId, lines: 1, maxBytes: 7 }
              },
              "user:local"
            )
          ).resolves.toMatchObject({
            archived: true,
            source: "terminal",
            status: "unreadable"
          });
        }
        expect(run.attemptResults[worker.attemptId]?.reportPath).toBe(
          "/reports/review.md"
        );
        expect(run.dispatches[worker.dispatchId]?.lastHeartbeat?.phase).toBe(
          "Reviewing sources"
        );
        expect(run.dispatches[worker.dispatchId]?.terminalState).toBe(
          expectedDisposition === "retain" ? "retained" : "released"
        );
      } finally {
        await host.checkpointForShutdown();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("verifies the current Coordinator process before mutating a Run when --run is omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-current-run-guard-"));
    const host = await LocalOrchestrationHost.open({
      filePath: join(root, "orchestration.json")
    });
    const verifyCoordinatorCaller = vi.fn(async () => {
      throw new Error("not the original Coordinator process");
    });
    host.configureExecution({
      driver: { execute: async () => undefined },
      trustedResultAssembler: { assemble: async () => ({}) },
      isExecutionCurrent: () => true,
      verifyCoordinatorCaller
    });
    try {
      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId: "run:guarded-current",
            objective: "Reject another process before it changes this Run",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("guarded-current"),
            idempotencyKey: "create:guarded-current"
          }
        },
        "session:guarded-current"
      );

      await expect(
        host.handle(
          {
            method: "orchestration.task.create",
            params: {
              taskId: "task:must-not-exist",
              spec: "This mutation must be rejected before commit",
              dependencies: [],
              requestId: "task:guarded"
            }
          },
          "session:guarded-current",
          42
        )
      ).rejects.toThrow("not the original Coordinator process");
      expect(verifyCoordinatorCaller).toHaveBeenCalledWith(
        terminalCoordinator("guarded-current"),
        42
      );

      const run = (await host.handle(
        {
          method: "orchestration.run.get",
          params: { runId: "run:guarded-current" }
        },
        "user:local"
      )) as WorkflowRun;
      expect(run.tasks).toEqual({});
    } finally {
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks accidental same-Agent duplicates, lets the Coordinator cancel, and retries the exact Dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-exact-worker-retry-"));
    const sessionId = "coordinator-retry";
    const principal = `session:${sessionId}`;
    let executionCount = 0;
    let releaseFirstExecution: (() => void) | undefined;
    let firstExecutionStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstExecutionStarted = resolve;
    });
    const host = await LocalOrchestrationHost.open({
      filePath: join(root, "orchestration.json")
    });
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:test",
      surfaceId: "surface:worker",
      sessionId: "session:worker",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:worker" },
      inputAuthorityRef: "authority:worker"
    };
    const cancel = vi.fn(async () => {
      releaseFirstExecution?.();
      return { executorReceiptId: "cancel:confirmed" };
    });
    host.configureExecution({
      driver: {
        execute: async ({ attemptId }) => {
          executionCount += 1;
          if (executionCount === 1) {
            await host.persistAttemptInputControl({
              attemptId,
              execution,
              launchReceipt: {
                requested: {},
                effective: {},
                evidence: "executor-applied",
                agentDescriptorRevision: "fixture"
              }
            });
            firstExecutionStarted?.();
            await new Promise<void>((resolve) => {
              releaseFirstExecution = resolve;
            });
            return;
          }
          await host.failPreparation({
            attemptId,
            reason: "Fixture retry reached the existing Worker path"
          });
        },
        cancel,
        readWorker: async () => ({
          source: "terminal",
          status: "available",
          vt: "Before cancellation"
        })
      },
      trustedResultAssembler: { assemble: async () => ({}) },
      isExecutionCurrent: () => true
    });

    try {
      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId: "run:exact-retry",
            objective: "Use one Worker terminal until it settles",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator(sessionId),
            idempotencyKey: "create:exact-retry"
          }
        },
        principal
      );

      const firstStart = host.handle(
        {
          method: "orchestration.worker.start",
          params: {
            runId: "run:exact-retry",
            spec: "Review without opening a duplicate Worker",
            agentId: "agy",
            coding: false,
            allowParallelAgent: false,
            preferences: {},
            requestId: "start:first"
          }
        },
        principal
      );
      await firstStarted;

      const activeRun = (await host.handle(
        {
          method: "orchestration.run.get",
          params: { runId: "run:exact-retry" }
        },
        principal
      )) as WorkflowRun;
      const [firstAttempt] = Object.values(activeRun.attempts);
      const firstDispatch = firstAttempt?.dispatchId
        ? activeRun.dispatches[firstAttempt.dispatchId]
        : undefined;
      expect(firstDispatch).toBeDefined();

      await expect(
        host.handle(
          {
            method: "orchestration.worker.start",
            params: {
              runId: "run:exact-retry",
              spec: "This accidental retry must not create another pane",
              agentId: "agy",
              coding: false,
              allowParallelAgent: false,
              preferences: {},
              requestId: "start:duplicate"
            }
          },
          principal
        )
      ).rejects.toMatchObject({ code: "conflict" });

      await expect(
        host.handle(
          {
            method: "orchestration.attempt.cancel",
            params: {
              attemptId: firstAttempt!.attemptId,
              idempotencyKey: "cancel:first"
            }
          },
          principal
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      await expect(firstStart).resolves.toMatchObject({
        taskId: firstDispatch!.nodeId,
        dispatchId: firstDispatch!.dispatchId,
        status: "canceled"
      });
      expect(cancel).toHaveBeenCalledTimes(1);

      const retried = await host.handle(
        {
          method: "orchestration.worker.start",
          params: {
            runId: "run:exact-retry",
            taskId: firstDispatch!.nodeId,
            agentId: "agy",
            coding: false,
            retryDispatchId: firstDispatch!.dispatchId,
            allowParallelAgent: false,
            preferences: {},
            requestId: "retry:first"
          }
        },
        principal
      );
      expect(retried).toMatchObject({
        taskId: firstDispatch!.nodeId,
        status: "failed"
      });

      const retriedRun = (await host.handle(
        {
          method: "orchestration.run.get",
          params: { runId: "run:exact-retry" }
        },
        principal
      )) as WorkflowRun;
      expect(Object.keys(retriedRun.tasks)).toEqual([firstDispatch!.nodeId]);
      expect(Object.values(retriedRun.attempts)).toHaveLength(2);
      expect(
        Object.values(retriedRun.attempts).find(
          (attempt) => attempt.attemptId !== firstAttempt!.attemptId
        )
      ).toMatchObject({ retryOfAttemptId: firstAttempt!.attemptId });
    } finally {
      releaseFirstExecution?.();
      await host.drive();
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops admission during shutdown while a new Host can resume durably queued work", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-shutdown-admission-"));
    const filePath = join(root, "orchestration.json");
    try {
      const host = await LocalOrchestrationHost.open({ filePath });
      await host.checkpointForShutdown();
      await publishAndStart(
        host,
        starterWorkflowDefinition({
          definitionId: "queued",
          name: "Queued at shutdown"
        }),
        "run:queued"
      );
      await host.drive();
      const queued = (await host.handle(
        { method: "orchestration.run.get", params: { runId: "run:queued" } },
        "user:local"
      )) as WorkflowRun;
      expect(Object.values(queued.attempts)).toHaveLength(0);
      const resumed = await LocalOrchestrationHost.open({ filePath });
      await resumed.drive();
      const completed = (await resumed.handle(
        { method: "orchestration.run.get", params: { runId: "run:queued" } },
        "user:local"
      )) as WorkflowRun;
      expect(completed.status).toBe("succeeded");
      await resumed.checkpointForShutdown();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("creates the built-in Shell template as an ordinary editable Draft from the canonical source", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-workflow-template-"));
    try {
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json"),
        now: () => "2026-08-29T00:00:00.000Z"
      });
      const templates = (await host.handle(
        { method: "workflow.template.list", params: {} },
        "user:local"
      )) as unknown as Array<{ templateId: string; name: string }>;
      expect(templates).toEqual([
        expect.objectContaining({
          templateId: "shell-command",
          name: "Shell command"
        })
      ]);
      const preview = (await host.handle(
        {
          method: "workflow.template.get",
          params: {
            templateId: templates[0]!.templateId,
            definitionId: "workflow:shell-preview"
          }
        },
        "user:local"
      )) as {
        canonicalDraft: { definitionId: string; name: string };
        editorDocument: unknown;
      };
      expect(preview.canonicalDraft).toMatchObject({
        definitionId: "workflow:shell-preview",
        name: "Shell command"
      });
      const draft = (await host.handle(
        {
          method: "workflow.draft.create_from_template",
          params: {
            templateId: templates[0]!.templateId,
            draftId: "draft:shell",
            definitionId: "workflow:shell"
          }
        },
        "user:local"
      )) as { revision: number; canonicalDraft: unknown };
      expect(draft.revision).toBe(1);
      expect(
        await host.handle(
          {
            method: "workflow.draft.validate",
            params: { draftId: "draft:shell" }
          },
          "user:local"
        )
      ).toMatchObject({ publishable: true, semanticallyEquivalent: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists invalid Drafts but publishes and runs only an equivalent valid immutable version", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-workflow-catalog-"));
    const filePath = join(root, "orchestration.json");
    let sequence = 0;
    const options = {
      filePath,
      now: () => "2026-08-26T00:00:00.000Z",
      id: (kind: string) => `${kind}:${++sequence}`
    };
    try {
      let host = await LocalOrchestrationHost.open(options);
      const created = (await host.handle(
        {
          method: "workflow.draft.create",
          params: {
            draftId: "draft:catalog",
            definitionId: "workflow:catalog",
            name: "Catalog workflow"
          }
        },
        "user:local"
      )) as {
        revision: number;
        canonicalDraft: unknown;
        editorDocument: unknown;
      };
      expect(created.revision).toBe(1);
      expect(
        await host.handle(
          {
            method: "workflow.draft.validate",
            params: { draftId: "draft:catalog" }
          },
          "user:local"
        )
      ).toMatchObject({ publishable: true, semanticallyEquivalent: true });

      const invalid = (await host.handle(
        {
          method: "workflow.draft.update",
          params: {
            draftId: "draft:catalog",
            expectedRevision: 1,
            canonicalDraft: { invalid: true },
            editorDocument: created.editorDocument as never
          }
        },
        "user:local"
      )) as { revision: number };
      expect(invalid.revision).toBe(2);
      await expect(
        host.handle(
          {
            method: "workflow.draft.validate",
            params: { draftId: "draft:catalog", expectedRevision: 1 }
          },
          "user:local"
        )
      ).rejects.toMatchObject({ code: "stale-revision" });

      await expect(
        host.handle(
          {
            method: "workflow.publish",
            params: { draftId: "draft:catalog", expectedRevision: 2 }
          },
          "user:local"
        )
      ).rejects.toMatchObject({ code: "invalid" });

      host = await LocalOrchestrationHost.open(options);
      const sourceEditor = created.editorDocument as FlowEditorDocumentV1;
      const publishedEditor = {
        ...sourceEditor,
        nodes: sourceEditor.nodes.map((entry, index) => ({
          ...entry,
          position: { x: 160, y: index * 400 + 100 }
        }))
      };
      const repaired = (await host.handle(
        {
          method: "workflow.draft.update",
          params: {
            draftId: "draft:catalog",
            expectedRevision: 2,
            canonicalDraft: created.canonicalDraft as never,
            editorDocument: publishedEditor as unknown as JsonValue
          }
        },
        "user:local"
      )) as { revision: number };
      const published = (await host.handle(
        {
          method: "workflow.publish",
          params: {
            draftId: "draft:catalog",
            expectedRevision: repaired.revision
          }
        },
        "user:local"
      )) as {
        version: { workflowVersionId: string; version: number };
        draft: { revision: number };
      };
      expect(published).toMatchObject({
        version: { version: 1 },
        draft: { revision: 4 }
      });
      await expect(
        host.handle(
          {
            method: "workflow.publish",
            params: { draftId: "draft:catalog", expectedRevision: 3 }
          },
          "user:local"
        )
      ).rejects.toMatchObject({ code: "stale-revision" });

      host = await LocalOrchestrationHost.open(options);
      await host.handle(
        {
          method: "workflow.draft.update",
          params: {
            draftId: "draft:catalog",
            expectedRevision: 4,
            canonicalDraft: { invalid: true },
            editorDocument: created.editorDocument as never
          }
        },
        "user:local"
      );
      expect(
        await host.handle(
          {
            method: "workflow.version.get",
            params: {
              workflowVersionId: published.version.workflowVersionId
            }
          },
          "user:local"
        )
      ).toMatchObject({
        definition: created.canonicalDraft,
        editorDocument: publishedEditor
      });

      host.configureExecution({
        driver: { execute: async () => undefined },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => true
      });
      await host.handle(
        {
          method: "workflow.run",
          params: {
            workflowVersionId: published.version.workflowVersionId,
            runId: "run:catalog",
            inputs: {}
          }
        },
        "user:local"
      );
      await host.drive();
      expect(
        await host.handle(
          {
            method: "orchestration.status",
            params: { runId: "run:catalog" }
          },
          "user:local"
        )
      ).toMatchObject({ status: "succeeded" });

      expect(
        await host.handle(
          { method: "orchestration.run.list", params: {} },
          "session:unaffiliated"
        )
      ).toEqual([]);
      for (const principal of ["session:unaffiliated", "client:local"]) {
        await expect(
          host.handle(
            {
              method: "workflow.draft.create",
              params: {
                draftId: "draft:unaffiliated",
                definitionId: "workflow:unaffiliated",
                name: "Unaffiliated"
              }
            },
            principal
          )
        ).rejects.toMatchObject({ code: "unauthorized" });
        await expect(
          host.handle(
            {
              method: "orchestration.gate.resolve",
              params: {
                runId: "run:catalog",
                gateId: "gate:test",
                resolution: "approve"
              }
            },
            principal
          )
        ).rejects.toMatchObject({ code: "unauthorized" });
      }

      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId: "run:delegated-agent",
            objective: "Do not mutate the saved catalog",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("delegated-agent"),
            idempotencyKey: "create:delegated-agent"
          }
        },
        "session:delegated-agent"
      );
      await expect(
        host.handle(
          {
            method: "workflow.draft.create",
            params: {
              draftId: "draft:forbidden",
              definitionId: "workflow:forbidden",
              name: "Forbidden"
            }
          },
          "session:delegated-agent"
        )
      ).rejects.toMatchObject({ code: "unauthorized" });

      const delegatedRuns = (await host.handle(
        { method: "orchestration.run.list", params: {} },
        "session:delegated-agent"
      )) as readonly { runId: string }[];
      expect(delegatedRuns.map((run) => run.runId)).toEqual([
        "run:delegated-agent"
      ]);
      await expect(
        host.handle(
          { method: "orchestration.run.get", params: { runId: "run:catalog" } },
          "session:delegated-agent"
        )
      ).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues at capacity without starving other Runs and resumes as each preparation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-admission-capacity-"));
    const releases = new Map<string, () => void>();
    const executions: Promise<void>[] = [];
    const host = await LocalOrchestrationHost.open({
      filePath: join(root, "orchestration.json")
    });
    try {
      const definition = admissionWorkflow(["a", "b", "c"]);
      await publishAndStart(
        host,
        {
          ...definition,
          policies: {
            ...definition.policies,
            limits: { ...definition.policies.limits, maxActiveAttempts: 2 }
          }
        },
        "run:a-capacity"
      );
      await publishAndStart(
        host,
        starterWorkflowDefinition({ definitionId: "other", name: "Other Run" }),
        "run:z-other"
      );
      host.configureExecution({
        driver: {
          execute: ({ run, attemptId }) => {
            const execution = new Promise<void>((resolve) =>
              releases.set(run.attempts[attemptId]!.nodeId, resolve)
            ).then(() =>
              host.failPreparation({
                attemptId,
                reason: "Fixture preparation ended before launch"
              })
            );
            executions.push(execution);
            return execution;
          }
        },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => true
      });
      await expect(host.drive()).resolves.toBeUndefined();
      expect([...releases.keys()]).toEqual(["a", "b"]);
      expect(
        await host.handle(
          { method: "orchestration.status", params: { runId: "run:z-other" } },
          "user:local"
        )
      ).toMatchObject({ status: "succeeded" });
      expect(
        await host.handle(
          {
            method: "orchestration.status",
            params: { runId: "run:a-capacity" }
          },
          "user:local"
        )
      ).toMatchObject({
        counters: { activeAttempts: 2 },
        workers: expect.arrayContaining([
          { nodeId: "c", stage: "awaiting-capacity" }
        ])
      });

      releases.get("a")!();
      await vi.waitFor(() => expect(releases.has("c")).toBe(true));
      const run = (await host.handle(
        {
          method: "orchestration.run.get",
          params: { runId: "run:a-capacity" }
        },
        "user:local"
      )) as unknown as WorkflowRun;
      expect(run.graph.nodes.b?.status).toBe("preparing");
      expect(run.graph.nodes.c?.attemptIds).toHaveLength(1);
      expect(run.counters.activeAttempts).toBe(2);
    } finally {
      for (const release of releases.values()) release();
      await Promise.allSettled(executions);
      await host.drive();
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists permanent admission failure without launching it or starving another Run", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-admission-failure-"));
    const filePath = join(root, "orchestration.json");
    const host = await LocalOrchestrationHost.open({ filePath });
    const executions: string[] = [];
    try {
      const definition = admissionWorkflow(["a", "b"]);
      await publishAndStart(
        host,
        {
          ...definition,
          nodes: definition.nodes.map((node) =>
            node.id === "b" ? { ...node, onFailure: "fail-run" } : node
          ),
          policies: {
            ...definition.policies,
            limits: { ...definition.policies.limits, maxDispatches: 1 }
          }
        },
        "run:a-failure"
      );
      await publishAndStart(
        host,
        starterWorkflowDefinition({ definitionId: "other", name: "Other Run" }),
        "run:z-other"
      );
      host.configureExecution({
        driver: {
          execute: async ({ run, attemptId }) => {
            executions.push(run.attempts[attemptId]!.nodeId);
            await host.failPreparation({
              attemptId,
              reason: "Fixture preparation ended before launch"
            });
          }
        },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => true
      });
      await expect(host.drive()).resolves.toBeUndefined();
      await vi.waitFor(async () =>
        expect(
          await host.handle(
            {
              method: "orchestration.status",
              params: { runId: "run:a-failure" }
            },
            "user:local"
          )
        ).toMatchObject({
          status: "failed",
          workers: expect.arrayContaining([
            {
              nodeId: "b",
              stage: "admission-failed",
              issue: {
                code: "budget-exhausted",
                message: "Run limit 'maxDispatches' is exhausted"
              }
            }
          ])
        })
      );
      expect(executions).toEqual(["a"]);
      expect(
        await host.handle(
          { method: "orchestration.status", params: { runId: "run:z-other" } },
          "user:local"
        )
      ).toMatchObject({ status: "succeeded" });
      await host.checkpointForShutdown();
      const recovered = await LocalOrchestrationHost.open({ filePath });
      const run = (await recovered.handle(
        { method: "orchestration.run.get", params: { runId: "run:a-failure" } },
        "user:local"
      )) as unknown as WorkflowRun;
      expect(run.graph.nodes.b).toMatchObject({
        status: "failed",
        attemptIds: [],
        admissionFailure: {
          class: "admission",
          code: "budget-exhausted",
          details: { limit: "maxDispatches" }
        }
      });
      expect(run.counters.dispatches).toBe(1);
      expect(run.counters.activeAttempts).toBe(0);
    } finally {
      await host.drive();
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let slow Agent preparation block a sealed control-only Run", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-orchestration-fairness-"));
    let releaseAgent: (() => void) | undefined;
    try {
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json")
      });
      const draft = (await host.handle(
        {
          method: "workflow.draft.create",
          params: {
            draftId: "draft:control-only",
            definitionId: "workflow:control-only",
            name: "Control only"
          }
        },
        "user:local"
      )) as { revision: number };
      const published = (await host.handle(
        {
          method: "workflow.publish",
          params: {
            draftId: "draft:control-only",
            expectedRevision: draft.revision
          }
        },
        "user:local"
      )) as { version: { workflowVersionId: string } };
      host.configureExecution({
        driver: {
          execute: () =>
            new Promise<void>((resolve) => {
              releaseAgent = resolve;
            })
        },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => true
      });
      await publishAndStart(
        host,
        admissionWorkflow(["slow-worker"]),
        "run:slow-agent"
      );
      await vi.waitFor(() => expect(releaseAgent).toBeTypeOf("function"));

      await host.handle(
        {
          method: "workflow.run",
          params: {
            workflowVersionId: published.version.workflowVersionId,
            runId: "run:control-only",
            inputs: {}
          }
        },
        "user:local"
      );
      await vi.waitFor(async () =>
        expect(
          await host.handle(
            {
              method: "orchestration.status",
              params: { runId: "run:control-only" }
            },
            "user:local"
          )
        ).toMatchObject({ status: "succeeded" })
      );
    } finally {
      releaseAgent?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saves an ad-hoc Run Graph as a durable editable Draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-run-draft-"));
    try {
      const host = await LocalOrchestrationHost.open({
        filePath: join(root, "orchestration.json"),
        now: () => "2026-08-26T00:00:00.000Z"
      });
      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId: "run:save-me",
            objective: "Turn this plan into a reusable workflow",
            inputs: { branch: "main" },
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("save-me"),
            idempotencyKey: "create:save-me"
          }
        },
        "session:save-me"
      );

      const draft = (await host.handle(
        {
          method: "workflow.draft.create_from_run",
          params: {
            runId: "run:save-me",
            draftId: "draft:from-run",
            definitionId: "workflow:from-run",
            name: "Reusable plan"
          }
        },
        "user:local"
      )) as unknown as {
        revision: number;
        canonicalDraft: {
          nodes: Array<{ kind: string }>;
          inputs: Array<{ id: string; default: unknown }>;
        };
        editorDocument: { documentVersion: number; nodes: unknown[] };
      };
      expect(draft).toMatchObject({
        revision: 1,
        canonicalDraft: {
          inputs: [{ id: "branch", default: "main" }]
        },
        editorDocument: { documentVersion: 1 }
      });
      expect(draft.canonicalDraft.nodes.map((node) => node.kind)).toEqual([
        "start",
        "end"
      ]);
      expect(draft.editorDocument.nodes).toHaveLength(2);
      expect(
        await host.handle(
          {
            method: "workflow.draft.validate",
            params: { draftId: "draft:from-run" }
          },
          "user:local"
        )
      ).toMatchObject({ publishable: true, semanticallyEquivalent: true });

      await host.handle(
        {
          method: "orchestration.run.create",
          params: {
            runId: "run:agent-owned",
            objective: "Agent-owned run",
            inputs: {},
            limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
            coordinatorAttachment: terminalCoordinator("untrusted"),
            idempotencyKey: "create:agent-owned"
          }
        },
        "session:untrusted"
      );
      await expect(
        host.handle(
          {
            method: "workflow.draft.create_from_run",
            params: {
              runId: "run:agent-owned",
              draftId: "draft:agent-forbidden",
              definitionId: "workflow:agent-forbidden",
              name: "Forbidden"
            }
          },
          "session:untrusted"
        )
      ).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("saved Workflow calling Agent protocol", () => {
  it("preflights caller, authenticates completion, preserves a pending delivery across restart, and pauses a lost generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-caller-host-"));
    const filePath = join(root, "orchestration.json");
    let host = await LocalOrchestrationHost.open({ filePath });
    let current = true;
    const launch = vi.fn(async () => undefined);
    const configure = () =>
      host.configureExecution({
        driver: { execute: launch },
        trustedResultAssembler: { assemble: async () => ({}) },
        isExecutionCurrent: () => current,
        resolveCallerRepositoryIdentity: async () => "repository:caller",
        verifyCoordinatorCaller: async (_attachment, pid) => {
          if (pid !== 23) throw new Error("wrong original process");
        }
      });
    const caller = terminalCoordinator("original");
    const definition: WorkflowDefinitionV1 = {
      ...admissionWorkflow(["caller"]),
      name: "Caller flow",
      agentBindings: {
        worker: { ...workerBinding(), agent: { kind: "caller" } }
      }
    };
    const getRun = async () =>
      (await host.handle(
        { method: "orchestration.run.get", params: { runId: "run:caller" } },
        "user:local"
      )) as WorkflowRun;
    try {
      configure();
      await host.handle(
        {
          method: "workflow.draft.create",
          params: {
            draftId: "draft:caller",
            definitionId: definition.definitionId,
            name: definition.name,
            canonicalDraft: definition as unknown as JsonValue,
            editorDocument: initializeFlowEditorDocument(
              definition
            ) as unknown as JsonValue
          }
        },
        "user:local"
      );
      await expect(
        host.handle(
          {
            method: "workflow.run",
            params: {
              workflow: definition.name,
              runId: "run:blocked",
              inputs: {}
            }
          },
          "user:local"
        )
      ).rejects.toThrow(/requires a calling Agent/);
      await expect(
        host.handle(
          { method: "orchestration.run.get", params: { runId: "run:blocked" } },
          "user:local"
        )
      ).rejects.toThrow(/not found/);
      await host.handle(
        {
          method: "workflow.run",
          params: {
            workflow: definition.name,
            runId: "run:caller",
            inputs: {},
            callerAttachment: caller
          }
        },
        "session:original",
        23
      );
      await host.drive();
      const run = await getRun();
      const attempt = Object.values(run.attempts).find(
        (attempt) => attempt.callerTask
      )!;
      expect(launch).not.toHaveBeenCalled();
      expect(run.graph.authoringState).toBe("sealed");
      const result = {
        outcome: "succeeded" as const,
        summary: "Completed",
        data: { factChecked: true }
      };
      const command = {
        method: "workflow.caller.done" as const,
        params: {
          runId: run.runId,
          attemptId: attempt.attemptId,
          requestId: attempt.callerTask!.requestId,
          result
        }
      };
      await expect(host.handle(command, "user:local")).rejects.toThrow(
        /original calling Agent/
      );
      await expect(host.handle(command, "session:other", 23)).rejects.toThrow(
        /original calling Agent/
      );
      await expect(
        host.handle(command, "session:original", 99)
      ).rejects.toThrow(/wrong original process/);
      const inbox = {
        method: "orchestration.inbox.check" as const,
        params: { runId: run.runId, wait: false, timeoutMs: 0 }
      };
      const pending = (await host.handle(inbox, "session:original", 23)) as {
        delivery: {
          deliveryId: string;
          events: ReadonlyArray<{ callerTask?: { requestId: string } }>;
        };
      };
      expect(pending.delivery.events[0].callerTask?.requestId).toBe(
        attempt.callerTask!.requestId
      );
      await host.checkpointForShutdown();
      host = await LocalOrchestrationHost.open({ filePath });
      configure();
      const replay = (await host.handle(
        inbox,
        "session:original",
        23
      )) as typeof pending;
      expect(replay.delivery.deliveryId).toBe(pending.delivery.deliveryId);
      await host.handle(
        {
          ...inbox,
          params: { ...inbox.params, ack: pending.delivery.deliveryId }
        },
        "session:original",
        23
      );
      expect((await getRun()).attempts[attempt.attemptId].status).toBe(
        "waiting-input"
      );
      const receipt = await host.handle(command, "session:original", 23);
      expect(await host.handle(command, "session:original", 23)).toEqual(
        receipt
      );
      await host.drive();
      expect((await getRun()).status).toBe("succeeded");
      await host.handle(
        {
          method: "workflow.run",
          params: {
            workflow: definition.definitionId,
            runId: "run:lost",
            inputs: {},
            callerAttachment: caller
          }
        },
        "session:original",
        23
      );
      await host.drive();
      current = false;
      await host.drive();
      const lost = (await host.handle(
        { method: "orchestration.run.get", params: { runId: "run:lost" } },
        "user:local"
      )) as WorkflowRun;
      expect(lost.status).toBe("needs-attention");
      expect(lost.callerUnavailable).toBeDefined();
      expect(Object.values(lost.leases)[0].state).toBe("uncertain");
    } finally {
      await host.checkpointForShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
