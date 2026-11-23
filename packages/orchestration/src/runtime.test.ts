import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireResourceLease,
  admitNode,
  applyGraphPatch,
  assertRuntimeInputAuthority,
  acknowledgeMailboxDelivery,
  claimMailboxDelivery,
  coordinatorMailboxConsumer,
  contentHash,
  createAdaptiveRun,
  failAttemptPreparation,
  failNodeAdmission,
  fireDueTimers,
  dispatchMailboxConsumer,
  markAttemptRunning,
  markAttemptPreparationNeedsAttention,
  markCancellationUncertain,
  markLeaseUncertain,
  markWorkerTerminalReleaseUnknown,
  materializeWorkflowRun,
  openHumanGate,
  observeAgentExecutionLost,
  postOrchestrationMessage,
  prepareAgentPromptDelivery,
  prepareAttemptInputControl,
  publishWorkflowVersion,
  workflowContentHash,
  recoverRun,
  recordWorkerTerminalHistory,
  recordShellExecutionIntent,
  recordAttemptInputIntervention,
  requestAttemptCancellation,
  requestAttemptInputDisposition,
  requestAttemptRetry,
  resolveHumanGate,
  resolveUncertainAttempt,
  confirmAttemptCancellation,
  releaseLease,
  selectConditionPort,
  settleControlNode,
  settleAttemptInputDisposition,
  startStructuredLoop,
  settleAgentPromptDelivery,
  bindShellExecution,
  settleShellExecution,
  submitAttemptResult,
  type GraphPatch,
  type RuntimeContext,
  type RunLimits,
  type WorkflowNodeDefinition,
  type WorkflowRun,
  workflowExpressionValues
} from "./index";
import { OrchestrationError } from "./types";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures"
);

function createContext() {
  let sequence = 0;
  let time = Date.parse("2026-08-26T00:00:00.000Z");
  const context: RuntimeContext = {
    now: () => new Date(time++).toISOString(),
    id: (kind) => `${kind}:${++sequence}`
  };
  return { context, setTime: (value: string) => (time = Date.parse(value)) };
}

const testLaunchReceipt = () => ({
  requested: {},
  effective: {},
  evidence: "executor-applied" as const,
  agentDescriptorRevision: "codex-test-v1"
});

const limits = (overrides: Partial<RunLimits> = {}): RunLimits => ({
  maxNodes: 64,
  maxEdges: 128,
  maxGraphDepth: 16,
  maxFanOut: 8,
  maxLoopIterations: 8,
  maxActiveAttempts: 4,
  maxAttemptsPerSession: 1,
  maxDispatches: 32,
  maxCoordinatorTurns: 16,
  maxGraphPatches: 32,
  maxWallClockMs: 86_400_000,
  maxActiveExecutionMs: 43_200_000,
  maxArtifactBytes: 100 * 1024 * 1024,
  maxStructuredResultBytes: 1024 * 1024,
  ...overrides
});

const startNode = (id: string): WorkflowNodeDefinition => ({
  id,
  kind: "start",
  title: id,
  config: { version: 1 }
});
const shellNode = (id: string): WorkflowNodeDefinition => ({
  id,
  kind: "shell",
  title: id,
  config: {
    version: 1,
    command: {
      kind: "structured",
      executable: "/usr/bin/printf",
      args: [{ kind: "literal", value: "{}" }]
    },
    targetPolicy: "local",
    surfacePolicy: "create",
    cwdPolicy: "workspace",
    resultMode: "json-stdout",
    maxOutputBytes: 1024
  }
});
const endNode = (
  id: string,
  extra: Partial<WorkflowNodeDefinition> = {}
): WorkflowNodeDefinition =>
  ({
    id,
    kind: "end",
    title: id,
    config: { version: 1 },
    completionRoot: true,
    ...extra
  }) as WorkflowNodeDefinition;

function adaptiveRun(context: RuntimeContext, runLimits = limits()) {
  return createAdaptiveRun({
    runId: "run:adaptive",
    objective: "Do the work",
    limits: runLimits,
    context
  });
}

function patch(
  run: WorkflowRun,
  context: RuntimeContext,
  operations: GraphPatch["operations"],
  key = `patch:${run.graph.revision}`
): WorkflowRun {
  return applyGraphPatch(
    run,
    {
      runId: run.runId,
      expectedGraphRevision: run.graph.revision,
      authorityEpoch: run.coordinationAuthorityEpoch,
      authorPrincipal: "coordinator:1",
      capabilityRef: "graph-capability:1",
      idempotencyKey: key,
      operations
    },
    context
  ).run;
}

function runControlNode(
  run: WorkflowRun,
  nodeId: string,
  context: RuntimeContext,
  options: {
    outcome?: "succeeded" | "failed" | "canceled";
    selectedPort?: string;
  } = {}
): WorkflowRun {
  const node = run.graph.nodes[nodeId]!;
  const admitted = admitNode({
    run,
    nodeId,
    expectedGraphRevision: run.graph.revision,
    expectedNodeStateRevision: node.stateRevision,
    context
  });
  run = markAttemptRunning({
    run: admitted.run,
    attemptId: admitted.attempt.attemptId,
    startedAt: context.now()
  });
  return settleControlNode({
    run,
    attemptId: admitted.attempt.attemptId,
    outcome: options.outcome ?? "succeeded",
    selectedPort: options.selectedPort,
    context
  });
}

function activeMailboxWorker(context: RuntimeContext) {
  const coordinatorExecution = {
    targetId: "local",
    targetAuthority: "desktop:1",
    surfaceId: "surface:coordinator",
    sessionId: "session:coordinator",
    generation: { kind: "local" as const, runtimeEpoch: "epoch:coordinator" },
    inputAuthorityRef: "authority:coordinator"
  };
  let run = createAdaptiveRun({
    runId: "run:mailbox",
    objective: "Exercise the durable mailbox",
    limits: limits(),
    coordinatorAttachment: {
      transport: "terminal",
      surfaceId: coordinatorExecution.surfaceId,
      sessionId: coordinatorExecution.sessionId,
      execution: coordinatorExecution,
      process: { pid: 1, startedAt: context.now() }
    },
    context
  });
  run = patch(run, context, [
    {
      kind: "add-binding",
      agentRef: "worker",
      binding: {
        agent: { kind: "agent-id", agentId: "codex" },
        scope: { kind: "run" },
        authorityMode: "ambient",
        targetPolicy: "local",
        surfacePolicy: "create",
        sessionPolicy: "fresh",
        worktreePolicy: "current",
        inputMode: "interactive-recorded"
      }
    },
    {
      kind: "add-node",
      node: {
        id: "worker",
        kind: "agent",
        title: "Worker",
        config: {
          version: 1,
          agentRef: "worker",
          prompt: "Handle mailbox messages",
          lifecycleMode: "managed",
          coding: true
        },
        completionRoot: true
      }
    }
  ]);
  const admitted = admitNode({
    run,
    nodeId: "worker",
    expectedGraphRevision: run.graph.revision,
    expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
    context
  });
  const execution = {
    targetId: "local",
    targetAuthority: "desktop:1",
    surfaceId: "surface:worker",
    sessionId: "session:worker",
    generation: { kind: "local" as const, runtimeEpoch: "epoch:worker" },
    inputAuthorityRef: "authority:worker"
  };
  const controlled = prepareAttemptInputControl({
    run: admitted.run,
    attemptId: admitted.attempt.attemptId,
    execution,
    launchReceipt: testLaunchReceipt(),
    context
  });
  const payloadHash = contentHash("Handle mailbox messages\n");
  const prepared = prepareAgentPromptDelivery({
    run: controlled,
    attemptId: admitted.attempt.attemptId,
    execution,
    readiness: {
      receiptId: "readiness:mailbox",
      execution,
      agentId: "codex",
      agentInstanceId: "agent-instance:mailbox",
      readyEpoch: "ready-epoch:mailbox",
      state: "ready-for-input",
      observedAt: context.now()
    },
    launchReceipt: testLaunchReceipt(),
    payloadHash,
    operationId: "delivery:mailbox",
    context
  });
  run = settleAgentPromptDelivery({
    run: prepared.run,
    operationId: "delivery:mailbox",
    payloadHash,
    outcome: "written",
    receiptId: "pty:mailbox",
    context
  });
  return {
    run,
    attemptId: admitted.attempt.attemptId,
    dispatchId: admitted.attempt.dispatchId!,
    execution
  };
}

describe("pure orchestration Runtime", () => {
  it("runs saved Workflow versions as sealed graphs while preserving their content hash", () => {
    const { context } = createContext();
    const source = JSON.parse(
      readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
    );
    const version = {
      ...publishWorkflowVersion({
        definition: source,
        workflowVersionId: "legacy:adaptive",
        publishedAt: context.now()
      }),
      definition: source,
      contentHash: workflowContentHash(source)
    };
    const input = {
      runId: "run:legacy",
      version,
      inputs: { task: "Review" },
      context
    };
    const run = materializeWorkflowRun(input);
    expect(run.graph.authoringState).toBe("sealed");
    expect(run.source).toMatchObject({ contentHash: version.contentHash });
    expect(run.graph.nodes.start?.status).toBe("ready");
    expect(() =>
      applyGraphPatch(
        run,
        {
          runId: run.runId,
          idempotencyKey: "patch:legacy",
          ops: []
        } as unknown as GraphPatch,
        context
      )
    ).toThrow("sealed Run Graph rejects authoring Patches");
  });

  it("executes the declarative branch deterministically and settles only sealed required reachability", () => {
    const { context } = createContext();
    const definition = JSON.parse(
      readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
    );
    const version = publishWorkflowVersion({
      definition,
      workflowVersionId: "workflow-version:1",
      publishedAt: context.now()
    });
    let run = materializeWorkflowRun({
      runId: "run:declarative",
      version,
      inputs: { task: "Implement OAuth" },
      context
    });

    expect(run.graph.authoringState).toBe("sealed");
    expect(run.graph.nodes.start?.status).toBe("ready");
    run = runControlNode(run, "start", context);
    expect(run.graph.nodes.implement?.status).toBe("ready");

    const implement = admitNode({
      run,
      nodeId: "implement",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.implement!.stateRevision,
      context
    });
    run = markAttemptRunning({
      run: implement.run,
      attemptId: implement.attempt.attemptId,
      startedAt: context.now()
    });
    const submission = {
      outcome: "succeeded" as const,
      summary: "Implemented OAuth",
      data: { acceptedImportantCount: 0 }
    };
    run = submitAttemptResult({
      run,
      attemptId: implement.attempt.attemptId,
      idempotencyKey: "result:implement:1",
      submissionHash: contentHash(submission),
      submission,
      trusted: {},
      context
    }).run;
    expect(run.graph.nodes.judge?.status).toBe("ready");

    const condition = selectConditionPort({
      expression: "nodes.implement.result.data.acceptedImportantCount > 0",
      values: {
        nodes: {
          implement: {
            result: { data: { acceptedImportantCount: 0 } }
          }
        }
      },
      ports: ["important", "clean"]
    });
    expect(condition.port).toBe("clean");
    run = runControlNode(run, "judge", context, {
      selectedPort: condition.port
    });
    expect(run.graph.nodes["needs-fix"]?.status).toBe("skipped");
    expect(run.graph.nodes.done?.status).toBe("ready");

    run = runControlNode(run, "done", context);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toEqual({
      implementation: { acceptedImportantCount: 0 }
    });
  });

  it("linearizes a Patch racing admission and freezes ready/preparing definitions", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    const worker: WorkflowNodeDefinition = {
      id: "worker",
      kind: "agent",
      title: "Worker",
      config: {
        version: 1,
        agentRef: "author",
        prompt: "Original task",
        lifecycleMode: "managed",
        coding: true
      },
      completionRoot: true,
      onFailure: "fail-run",
      onCancel: "fail-run"
    };
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create-or-reuse",
          sessionPolicy: "reuse",
          worktreePolicy: "dedicated-top-level",
          inputMode: "orchestrated"
        }
      },
      { kind: "add-node", node: startNode("start") },
      { kind: "add-node", node: worker },
      {
        kind: "add-edge",
        edge: {
          id: "start-worker",
          from: { nodeId: "start" },
          to: { nodeId: "worker" }
        },
        expectedTargetNodeStateRevision: 0
      }
    ]);

    const replaced = {
      ...worker,
      config: { ...worker.config, prompt: "Patched before admission" }
    } as WorkflowNodeDefinition;
    run = patch(
      run,
      context,
      [
        {
          kind: "replace-pending-node",
          node: replaced,
          expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision
        }
      ],
      "patch:replace"
    );
    run = runControlNode(run, "start", context);
    const beforeAdmission = run;
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    expect(admitted.attempt.effectiveDefinitionHash).toBe(
      beforeAdmission.graph.nodes.worker!.definitionHash
    );

    expect(() =>
      patch(
        admitted.run,
        context,
        [
          {
            kind: "replace-pending-node",
            node: worker,
            expectedNodeStateRevision:
              admitted.run.graph.nodes.worker!.stateRevision
          }
        ],
        "patch:too-late"
      )
    ).toThrow(/definition-frozen/);

    expect(() =>
      admitNode({
        run: beforeAdmission,
        nodeId: "worker",
        expectedGraphRevision: beforeAdmission.graph.revision - 1,
        expectedNodeStateRevision:
          beforeAdmission.graph.nodes.worker!.stateRevision,
        context
      })
    ).toThrow(/current revision/);
  });

  it("resolves binding launch defaults with node overrides and preserves a distinct effective receipt", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          launch: { model: "gpt-5.5", effort: "medium" },
          targetPolicy: "local",
          surfacePolicy: "create",
          sessionPolicy: "fresh",
          worktreePolicy: "current",
          inputMode: "orchestrated"
        }
      },
      {
        kind: "add-node",
        node: {
          id: "worker",
          kind: "agent",
          title: "Worker",
          config: {
            version: 1,
            agentRef: "author",
            launch: { effort: "high" },
            prompt: "Implement",
            lifecycleMode: "managed",
            coding: false
          },
          completionRoot: true
        }
      }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    const dispatch = admitted.run.dispatches[admitted.attempt.dispatchId!]!;
    expect(dispatch.requestedBinding.launch).toEqual({
      model: "gpt-5.5",
      effort: "medium"
    });
    expect(dispatch.requestedLaunch).toEqual({
      model: "gpt-5.5",
      effort: "high"
    });

    const execution = {
      targetId: "local",
      targetAuthority: "desktop:1",
      surfaceId: "surface:launch",
      sessionId: "session:launch",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:launch" },
      inputAuthorityRef: "authority:launch"
    };
    const readiness = {
      receiptId: "readiness:launch",
      execution,
      agentId: "codex",
      agentInstanceId: "thread:launch",
      readyEpoch: "ready:launch",
      state: "ready-for-input" as const,
      observedAt: context.now()
    };
    expect(() =>
      prepareAgentPromptDelivery({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        execution,
        readiness,
        launchReceipt: {
          requested: { model: "gpt-5.5", effort: "medium" },
          effective: { model: "gpt-5.5", effort: "medium" },
          evidence: "provider-verified",
          agentDescriptorRevision: "codex-v4"
        },
        payloadHash: contentHash("Implement\n"),
        context
      })
    ).toThrow(/does not preserve/u);

    const prepared = prepareAgentPromptDelivery({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      execution,
      readiness,
      launchReceipt: {
        requested: { model: "gpt-5.5", effort: "high" },
        effective: { model: "gpt-5.5-2026-08", effort: "high" },
        evidence: "executor-applied",
        agentDescriptorRevision: "codex-v4"
      },
      payloadHash: contentHash("Implement\n"),
      context
    });
    const verified = settleAgentPromptDelivery({
      run: prepared.run,
      operationId: prepared.delivery.operationId,
      payloadHash: contentHash("Implement\n"),
      outcome: "written",
      receiptId: "turn:launch",
      launchReceipt: {
        requested: { model: "gpt-5.5", effort: "high" },
        effective: { model: "gpt-5.5-2026-08", effort: "high" },
        evidence: "provider-verified",
        agentDescriptorRevision: "codex-v4"
      },
      context
    });
    expect(
      verified.dispatches[dispatch.dispatchId]?.launchReceipt
    ).toMatchObject({
      requested: { model: "gpt-5.5", effort: "high" },
      effective: { model: "gpt-5.5-2026-08", effort: "high" },
      evidence: "provider-verified"
    });
  });

  it("makes an exact-reuse preparation issue durable and explicitly retryable", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "worker",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          launch: { model: "gpt-5.6-luna", effort: "low" },
          targetPolicy: "local",
          surfacePolicy: "create",
          sessionPolicy: "reuse",
          worktreePolicy: "current",
          inputMode: "orchestrated"
        }
      },
      {
        kind: "add-node",
        node: {
          id: "worker",
          kind: "agent",
          title: "Worker",
          config: {
            version: 1,
            agentRef: "worker",
            prompt: "Implement",
            lifecycleMode: "managed",
            coding: false
          },
          completionRoot: true
        }
      }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    const flagged = markAttemptPreparationNeedsAttention({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      code: "agent-launch-reuse-mismatch",
      reason: "requested launch fields do not match the reusable session",
      context
    });

    expect(flagged.status).toBe("needs-attention");
    expect(flagged.graph.nodes.worker?.status).toBe("needs-attention");
    expect(flagged.attempts[admitted.attempt.attemptId]).toMatchObject({
      status: "failed",
      preparationIssue: {
        code: "agent-launch-reuse-mismatch",
        message: "requested launch fields do not match the reusable session"
      }
    });

    const retried = requestAttemptRetry({
      run: flagged,
      attemptId: admitted.attempt.attemptId,
      idempotencyKey: "retry:launch",
      principal: "user:local",
      context
    });
    expect(retried.run.graph.nodes.worker?.status).toBe("ready");
    expect(retried.operation.state).toBe("queued");
  });

  it("persists generation-bound delivery before write and fences session capacity", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    const worker = {
      id: "worker",
      kind: "agent",
      title: "Worker",
      config: {
        version: 1,
        agentRef: "author",
        prompt: "Implement the task",
        lifecycleMode: "managed",
        coding: true
      },
      completionRoot: true
    } satisfies WorkflowNodeDefinition;
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create-or-reuse",
          sessionPolicy: "reuse",
          worktreePolicy: "current",
          inputMode: "orchestrated"
        }
      },
      { kind: "add-node", node: worker }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
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
      observedAt: context.now()
    };
    const payloadHash = contentHash("Implement the task\n");
    const bootstrapRun = prepareAttemptInputControl({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      execution,
      launchReceipt: testLaunchReceipt(),
      context
    });
    const prepared = prepareAgentPromptDelivery({
      run: bootstrapRun,
      attemptId: admitted.attempt.attemptId,
      execution,
      readiness,
      launchReceipt: testLaunchReceipt(),
      payloadHash,
      operationId: "delivery:1",
      context
    });
    expect(prepared.run.attempts[admitted.attempt.attemptId]?.status).toBe(
      "delivery-pending"
    );
    expect(prepared.delivery.state).toBe("pending");
    for (const markFailed of [
      failAttemptPreparation,
      markAttemptPreparationNeedsAttention
    ]) {
      expect(() =>
        markFailed({
          run: prepared.run,
          attemptId: admitted.attempt.attemptId,
          code: "transport-lost",
          reason: "response lost after a possible write",
          context
        })
      ).toThrow(/reconcile any pending delivery first/u);
    }
    expect(
      Object.values(prepared.run.leases).find(
        (lease) => lease.resource.kind === "terminal-session"
      )
    ).toMatchObject({ state: "active", capacityClaim: 1 });

    const replay = prepareAgentPromptDelivery({
      run: prepared.run,
      attemptId: admitted.attempt.attemptId,
      execution,
      readiness,
      launchReceipt: testLaunchReceipt(),
      payloadHash,
      operationId: "delivery:1",
      context
    });
    expect(replay.delivery).toEqual(prepared.delivery);

    const lost = observeAgentExecutionLost({
      run: prepared.run,
      execution,
      reason: "Provider process exited",
      context
    });
    expect(lost.attempts[admitted.attempt.attemptId]).toMatchObject({
      status: "uncertain",
      completionIssue: { code: "worker-lost" }
    });
    expect(lost.deliveries["delivery:1"]?.state).toBe("uncertain");
    expect(
      Object.values(lost.leases).every((lease) => lease.state === "uncertain")
    ).toBe(true);
    expect(
      observeAgentExecutionLost({
        run: lost,
        execution,
        reason: "Channel closed",
        context
      })
    ).toBe(lost);
    expect(
      observeAgentExecutionLost({
        run: prepared.run,
        execution: {
          ...execution,
          generation: { kind: "local", runtimeEpoch: "different" }
        },
        reason: "Stale process",
        context
      })
    ).toBe(prepared.run);
    const lateAck = settleAgentPromptDelivery({
      run: lost,
      operationId: "delivery:1",
      payloadHash,
      outcome: "written",
      receiptId: "pty-write:late",
      context
    });
    expect(lateAck.deliveries["delivery:1"]?.state).toBe("written");
    expect(lateAck.attempts[admitted.attempt.attemptId]?.status).toBe(
      "uncertain"
    );
    expect(lateAck.status).toBe("needs-attention");

    run = settleAgentPromptDelivery({
      run: replay.run,
      operationId: "delivery:1",
      payloadHash,
      outcome: "written",
      receiptId: "pty-write:1",
      context
    });
    expect(run.attempts[admitted.attempt.attemptId]?.status).toBe("running");
    expect(run.deliveries["delivery:1"]).toMatchObject({
      state: "written",
      receiptId: "pty-write:1"
    });

    expect(() =>
      assertRuntimeInputAuthority({
        run,
        attemptId: admitted.attempt.attemptId,
        expectedExecution: execution
      })
    ).not.toThrow();
  });

  it("records interactive input without persisting its raw bytes", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    const worker = {
      id: "worker",
      kind: "agent",
      title: "Worker",
      config: {
        version: 1,
        agentRef: "author",
        prompt: "Work interactively",
        lifecycleMode: "managed",
        coding: false
      },
      completionRoot: true
    } satisfies WorkflowNodeDefinition;
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create",
          sessionPolicy: "fresh",
          worktreePolicy: "current",
          inputMode: "interactive-recorded"
        }
      },
      { kind: "add-node", node: worker }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:1",
      surfaceId: "surface:interactive",
      sessionId: "session:interactive",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:interactive" },
      inputAuthorityRef: "authority:interactive"
    };
    const readiness = {
      receiptId: "readiness:interactive",
      execution,
      agentId: "codex",
      agentInstanceId: "agent-instance:interactive",
      readyEpoch: "ready-epoch:interactive",
      state: "ready-for-input" as const,
      observedAt: context.now()
    };
    const payloadHash = contentHash("Work interactively\n");
    run = settleAgentPromptDelivery({
      run: prepareAgentPromptDelivery({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        execution,
        readiness,
        launchReceipt: testLaunchReceipt(),
        payloadHash,
        operationId: "delivery:interactive",
        context
      }).run,
      operationId: "delivery:interactive",
      payloadHash,
      outcome: "written",
      context
    });
    const intervention = recordAttemptInputIntervention({
      run,
      attemptId: admitted.attempt.attemptId,
      expectedExecution: execution,
      idempotencyKey: "input:interactive:1",
      operationId: "input-operation:interactive:1",
      principal: "user:local",
      kind: "interactive-input",
      payloadHash: contentHash("secret terminal input"),
      payloadBytes: 21,
      context
    });
    expect(intervention.intervention).toMatchObject({
      kind: "interactive-input",
      payloadBytes: 21
    });
    expect(JSON.stringify(intervention.run)).not.toContain(
      "secret terminal input"
    );
  });

  it("fans out within concurrency policy and records predictable any-successful join outcomes", () => {
    const { context } = createContext();
    let base = adaptiveRun(context);
    const branchA = {
      ...startNode("a"),
      onFailure: "skip-descendants" as const
    };
    const branchB = {
      ...startNode("b"),
      onFailure: "skip-descendants" as const
    };
    base = patch(base, context, [
      { kind: "add-node", node: startNode("start") },
      { kind: "add-node", node: branchA },
      { kind: "add-node", node: branchB },
      {
        kind: "add-node",
        node: endNode("join", {
          completionRoot: false,
          joinPolicy: "any-successful",
          anySuccessfulDisposition: "wait"
        })
      },
      { kind: "add-node", node: endNode("done") },
      {
        kind: "add-edge",
        edge: { id: "s-a", from: { nodeId: "start" }, to: { nodeId: "a" } },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: { id: "s-b", from: { nodeId: "start" }, to: { nodeId: "b" } },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: { id: "a-j", from: { nodeId: "a" }, to: { nodeId: "join" } },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: { id: "b-j", from: { nodeId: "b" }, to: { nodeId: "join" } },
        expectedTargetNodeStateRevision: 1
      },
      {
        kind: "add-edge",
        edge: { id: "j-d", from: { nodeId: "join" }, to: { nodeId: "done" } },
        expectedTargetNodeStateRevision: 0
      }
    ]);
    base = runControlNode(base, "start", context);

    const admittedA = admitNode({
      run: base,
      nodeId: "a",
      expectedGraphRevision: base.graph.revision,
      expectedNodeStateRevision: base.graph.nodes.a!.stateRevision,
      context
    });
    const admittedB = admitNode({
      run: admittedA.run,
      nodeId: "b",
      expectedGraphRevision: admittedA.run.graph.revision,
      expectedNodeStateRevision: admittedA.run.graph.nodes.b!.stateRevision,
      context
    });
    expect(admittedB.run.counters.activeAttempts).toBe(2);

    let success = markAttemptRunning({
      run: admittedB.run,
      attemptId: admittedA.attempt.attemptId,
      startedAt: context.now()
    });
    success = settleControlNode({
      run: success,
      attemptId: admittedA.attempt.attemptId,
      outcome: "succeeded",
      context
    });
    expect(success.graph.nodes.join?.status).toBe("ready");
    expect(success.graph.nodes.join?.joinResolution).toMatchObject({
      policy: "any-successful",
      outcome: "satisfied"
    });
    expect(success.graph.nodes.b?.status).toBe("preparing");

    let failed = runControlNode(base, "a", context, { outcome: "failed" });
    failed = runControlNode(failed, "b", context, { outcome: "failed" });
    expect(failed.graph.nodes.join?.status).toBe("failed");
    expect(failed.graph.nodes.join?.joinResolution).toEqual({
      policy: "any-successful",
      selectedPredecessors: ["a", "b"],
      outcome: "unsatisfied",
      version: 1
    });
  });

  it("does not let an unselected multi-hop branch strand a downstream join", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    run = patch(run, context, [
      { kind: "add-node", node: startNode("choice") },
      { kind: "add-node", node: startNode("left") },
      { kind: "add-node", node: startNode("left-deep") },
      { kind: "add-node", node: startNode("right") },
      { kind: "add-node", node: endNode("join") },
      {
        kind: "add-edge",
        edge: {
          id: "choice-left",
          from: { nodeId: "choice", port: "left" },
          to: { nodeId: "left" }
        },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: {
          id: "left-deep",
          from: { nodeId: "left" },
          to: { nodeId: "left-deep" }
        },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: {
          id: "deep-join",
          from: { nodeId: "left-deep" },
          to: { nodeId: "join" }
        },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: {
          id: "choice-right",
          from: { nodeId: "choice", port: "right" },
          to: { nodeId: "right" }
        },
        expectedTargetNodeStateRevision: 0
      },
      {
        kind: "add-edge",
        edge: {
          id: "right-join",
          from: { nodeId: "right" },
          to: { nodeId: "join" }
        },
        expectedTargetNodeStateRevision: 1
      }
    ]);

    run = runControlNode(run, "choice", context, { selectedPort: "right" });
    expect(run.graph.nodes.left?.status).toBe("skipped");
    expect(run.graph.nodes["left-deep"]?.skipProvenance).toEqual({
      sourceNodeId: "choice",
      selectedPort: "right"
    });
    run = runControlNode(run, "right", context);
    expect(run.graph.nodes.join?.status).toBe("ready");
    expect(run.graph.nodes.join?.selectedPredecessors).toEqual(["right"]);
  });

  it("validates root-node mappings before making an adaptive task ready", () => {
    const { context } = createContext();
    const run = patch(adaptiveRun(context), context, [
      {
        kind: "add-node",
        node: endNode("mapped-root", {
          inputMappings: [
            {
              target: "analysis",
              source: { kind: "run-input", inputId: "missingAnalysis" },
              required: true,
              missing: "fail"
            }
          ],
          onFailure: "wake-coordinator"
        })
      }
    ]);
    expect(run.graph.nodes["mapped-root"]).toMatchObject({
      status: "failed",
      admissionFailure: {
        class: "input-mapping",
        code: "missing-required-input",
        mappingTarget: "analysis"
      },
      attemptIds: []
    });
    expect(run.coordinatorEventCursor).toBe(2);
    expect(run.status).toBe("waiting-for-coordinator");
  });

  it.each(["fail-run", "wake-coordinator"] as const)(
    "records permanent admission failure with %s policy and no phantom attempt",
    (onFailure) => {
      const { context } = createContext();
      const run = patch(adaptiveRun(context), context, [
        {
          kind: "add-node",
          node: endNode("blocked", { onFailure })
        }
      ]);
      const error = new OrchestrationError(
        "budget-exhausted",
        "Dispatch limit exhausted",
        { limit: "maxDispatches" }
      );
      const failed = failNodeAdmission({
        run,
        nodeId: "blocked",
        error,
        context
      });
      expect(failed.graph.nodes.blocked).toMatchObject({
        status: "failed",
        selectedPort: "failure",
        attemptIds: [],
        admissionFailure: {
          class: "admission",
          code: "budget-exhausted",
          details: { limit: "maxDispatches" }
        }
      });
      expect(failed.attempts).toEqual({});
      expect(failed.dispatches).toEqual({});
      expect(failed.counters.activeAttempts).toBe(0);
      expect(failed.status).toBe(
        onFailure === "fail-run" ? "failed" : "waiting-for-coordinator"
      );
      expect(run.graph.nodes.blocked?.status).toBe("ready");
      expect(() =>
        failNodeAdmission({
          run: failed,
          nodeId: "blocked",
          error,
          context
        })
      ).toThrow(/only a ready node/);
    }
  );

  it("does not turn temporary capacity or stale admission into a permanent failure", () => {
    const { context } = createContext();
    const run = patch(adaptiveRun(context), context, [
      { kind: "add-node", node: startNode("waiting") }
    ]);
    for (const error of [
      new OrchestrationError("budget-exhausted", "Capacity full", {
        limit: "maxActiveAttempts"
      }),
      new OrchestrationError("stale-revision", "Readiness changed")
    ]) {
      expect(() =>
        failNodeAdmission({ run, nodeId: "waiting", error, context })
      ).toThrow(error);
    }
    expect(run.graph.nodes.waiting?.status).toBe("ready");
  });

  it("fails a permanently missing required mapping before admission", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    run = patch(run, context, [
      { kind: "add-node", node: startNode("source") },
      {
        kind: "add-node",
        node: endNode("mapped", {
          inputMappings: [
            {
              target: "requiredValue",
              source: {
                kind: "node-result",
                nodeId: "source",
                path: ["missing"]
              },
              required: true,
              missing: "fail"
            }
          ],
          onFailure: "fail-run"
        })
      },
      {
        kind: "add-edge",
        edge: {
          id: "source-mapped",
          from: { nodeId: "source" },
          to: { nodeId: "mapped" }
        },
        expectedTargetNodeStateRevision: 0
      }
    ]);

    run = runControlNode(run, "source", context);
    expect(run.graph.nodes.mapped).toMatchObject({
      status: "failed",
      admissionFailure: {
        class: "input-mapping",
        code: "missing-required-input",
        mappingTarget: "requiredValue"
      }
    });
    expect(run.graph.nodes.mapped?.attemptIds).toEqual([]);
    expect(run.status).not.toBe("running");
  });

  it.each(["saved", "adaptive"] as const)(
    "materializes a %s structured Loop body per iteration and selects max-reached",
    (sourceKind) => {
      const { context } = createContext();
      const base = JSON.parse(
        readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
      );
      base.nodes = [
        startNode("start"),
        {
          id: "loop",
          kind: "loop",
          title: "Review rounds",
          config: {
            version: 1,
            mode: "while",
            maxIterations: 2,
            body: {
              nodeIds: ["review-result"],
              entryNodeIds: ["review-result"],
              exits: [
                {
                  nodeId: "review-result",
                  port: "continue",
                  outcome: "continue"
                },
                { nodeId: "review-result", port: "clean", outcome: "clean" }
              ]
            },
            repeatOutcome: "continue",
            completedOutcomes: ["clean"],
            completedPort: "completed",
            maxReachedPort: "max-reached"
          }
        },
        {
          id: "review-result",
          kind: "condition",
          title: "Review result",
          config: {
            version: 1,
            expressionVersion: 1,
            expression: "true",
            ports: ["continue", "clean"]
          }
        },
        endNode("clean"),
        endNode("max")
      ];
      base.edges = [
        { id: "s-l", from: { nodeId: "start" }, to: { nodeId: "loop" } },
        {
          id: "l-c",
          from: { nodeId: "loop", port: "completed" },
          to: { nodeId: "clean" }
        },
        {
          id: "l-m",
          from: { nodeId: "loop", port: "max-reached" },
          to: { nodeId: "max" }
        }
      ];
      base.inputs = [];
      base.outputs = [];
      base.agentBindings = {};
      const version = publishWorkflowVersion({
        definition: base,
        workflowVersionId: "workflow-version:loop",
        publishedAt: context.now()
      });
      let run =
        sourceKind === "saved"
          ? materializeWorkflowRun({
              runId: "run:loop",
              version,
              inputs: {},
              context
            })
          : patch(adaptiveRun(context), context, [
              ...version.definition.nodes.map((node) => ({
                kind: "add-node" as const,
                node
              })),
              ...version.definition.edges.map((edge) => ({
                kind: "add-edge" as const,
                edge,
                expectedTargetNodeStateRevision: 0
              }))
            ]);
      run = runControlNode(run, "start", context);
      const admitted = admitNode({
        run,
        nodeId: "loop",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.loop!.stateRevision,
        context
      });
      run = startStructuredLoop({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        context
      });
      const first = Object.values(run.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "review-result"
      )!;
      run = runControlNode(run, first.nodeId, context, {
        selectedPort: "continue"
      });
      const rounds = Object.values(run.graph.nodes).filter(
        (node) => node.materialization?.templateNodeId === "review-result"
      );
      expect(rounds).toHaveLength(2);
      run = runControlNode(run, rounds[1]!.nodeId, context, {
        selectedPort: "continue"
      });
      expect(run.graph.nodes.loop?.loopState).toMatchObject({
        iteration: 2,
        outcome: "max-reached"
      });
      expect(run.graph.nodes.max?.status).toBe("ready");
      expect(run.graph.nodes.clean?.status).toBe("skipped");
    }
  );

  it.each(["saved", "adaptive"] as const)(
    "anchors exact author binding identity to the %s outer Loop across nested review and recovery",
    (sourceKind) => {
      const { context } = createContext();
      const base = JSON.parse(
        readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
      );
      const agent = (id: string): WorkflowNodeDefinition => ({
        id,
        kind: "agent",
        title: id,
        config: {
          version: 1,
          agentRef: "author",
          prompt: id,
          lifecycleMode: "managed",
          coding: true
        },
        onFailure: "fail-run",
        onCancel: "fail-run"
      });
      base.inputs = [];
      base.outputs = [];
      base.agentBindings = {
        author: {
          agent: { kind: "agent-id", agentId: "fixture-agent" },
          scope: { kind: "loop-iteration", loopNodeId: "tickets" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create-or-reuse",
          sessionPolicy: "reuse",
          worktreePolicy: "current",
          inputMode: "orchestrated"
        }
      };
      base.nodes = [
        startNode("start"),
        {
          id: "tickets",
          kind: "loop",
          title: "Tickets",
          config: {
            version: 1,
            mode: "for-each",
            collection: { kind: "literal", value: ["A", "B"] },
            itemInputId: "ticket",
            maxItems: 2,
            concurrency: 1,
            body: {
              nodeIds: ["analyze", "review"],
              entryNodeIds: ["analyze"],
              exits: [
                { nodeId: "review", port: "completed", outcome: "complete" },
                { nodeId: "review", port: "max-reached", outcome: "bounded" }
              ]
            },
            completedPort: "completed",
            maxReachedPort: "max-reached"
          }
        },
        agent("analyze"),
        {
          id: "review",
          kind: "loop",
          title: "Review",
          config: {
            version: 1,
            mode: "while",
            maxIterations: 1,
            body: {
              nodeIds: ["synthesize", "review-result"],
              entryNodeIds: ["synthesize"],
              exits: [
                {
                  nodeId: "review-result",
                  port: "continue",
                  outcome: "continue"
                },
                { nodeId: "review-result", port: "clean", outcome: "clean" }
              ]
            },
            repeatOutcome: "continue",
            completedOutcomes: ["clean"],
            completedPort: "completed",
            maxReachedPort: "max-reached",
            carry: [
              {
                inputId: "reviewDisposition",
                initial: {
                  kind: "literal",
                  value: { unresolvedFindingIds: [] }
                },
                next: { kind: "node-result", nodeId: "synthesize" }
              }
            ]
          }
        },
        agent("synthesize"),
        {
          id: "review-result",
          kind: "condition",
          title: "Clean",
          config: {
            version: 1,
            expressionVersion: 1,
            expression: "false",
            ports: ["continue", "clean"]
          }
        },
        endNode("done"),
        endNode("bounded")
      ];
      base.edges = [
        {
          id: "start-tickets",
          from: { nodeId: "start" },
          to: { nodeId: "tickets" }
        },
        {
          id: "tickets-done",
          from: { nodeId: "tickets", port: "completed" },
          to: { nodeId: "done" }
        },
        {
          id: "tickets-bounded",
          from: { nodeId: "tickets", port: "max-reached" },
          to: { nodeId: "bounded" }
        },
        {
          id: "analyze-review",
          from: { nodeId: "analyze" },
          to: { nodeId: "review" }
        },
        {
          id: "synthesis-result",
          from: { nodeId: "synthesize" },
          to: { nodeId: "review-result" }
        }
      ];
      const version = publishWorkflowVersion({
        definition: base,
        workflowVersionId: "workflow-version:binding-scope",
        publishedAt: context.now()
      });
      let run =
        sourceKind === "saved"
          ? materializeWorkflowRun({
              runId: "run:binding-scope",
              version,
              inputs: {},
              context
            })
          : patch(adaptiveRun(context), context, [
              ...Object.entries(version.definition.agentBindings).map(
                ([agentRef, binding]) => ({
                  kind: "add-binding" as const,
                  agentRef,
                  binding
                })
              ),
              ...version.definition.nodes.map((node) => ({
                kind: "add-node" as const,
                node
              })),
              ...version.definition.edges.map((edge) => ({
                kind: "add-edge" as const,
                edge,
                expectedTargetNodeStateRevision: 0
              }))
            ]);
      run = runControlNode(run, "start", context);
      const outer = admitNode({
        run,
        nodeId: "tickets",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.tickets!.stateRevision,
        context
      });
      run = startStructuredLoop({
        run: outer.run,
        attemptId: outer.attempt.attemptId,
        context
      });
      const firstAnalyze = Object.values(run.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "analyze"
      )!;
      const admittedAnalyze = admitNode({
        run,
        nodeId: firstAnalyze.nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: firstAnalyze.stateRevision,
        context
      });
      const firstAnalyzeDispatch =
        admittedAnalyze.run.dispatches[admittedAnalyze.attempt.dispatchId!]!;
      const recovered = recoverRun(admittedAnalyze.run, context);
      expect(
        recovered.dispatches[admittedAnalyze.attempt.dispatchId!]
          ?.bindingInstanceKey
      ).toBe(firstAnalyzeDispatch.bindingInstanceKey);

      run = markAttemptRunning({
        run: admittedAnalyze.run,
        attemptId: admittedAnalyze.attempt.attemptId,
        startedAt: context.now()
      });
      const analyzed = { outcome: "succeeded" as const, summary: "analyzed" };
      run = submitAttemptResult({
        run,
        attemptId: admittedAnalyze.attempt.attemptId,
        idempotencyKey: "result:analyze:1",
        submissionHash: contentHash(analyzed),
        submission: analyzed,
        trusted: {},
        context
      }).run;
      const firstReview = Object.values(run.graph.nodes).find(
        (node) =>
          node.materialization?.templateNodeId === "review" &&
          node.status === "ready"
      )!;
      const admittedReview = admitNode({
        run,
        nodeId: firstReview.nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: firstReview.stateRevision,
        context
      });
      run = startStructuredLoop({
        run: admittedReview.run,
        attemptId: admittedReview.attempt.attemptId,
        context
      });
      const firstSynthesize = Object.values(run.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "synthesize"
      )!;
      const admittedSynthesize = admitNode({
        run,
        nodeId: firstSynthesize.nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: firstSynthesize.stateRevision,
        context
      });
      expect(
        workflowExpressionValues(
          admittedSynthesize.run,
          admittedSynthesize.attempt
        )
      ).toMatchObject({
        nodes: {
          analyze: { status: "succeeded" },
          synthesize: { status: "preparing" }
        }
      });
      expect(
        admittedSynthesize.run.dispatches[
          admittedSynthesize.attempt.dispatchId!
        ]?.bindingInstanceKey
      ).toBe(firstAnalyzeDispatch.bindingInstanceKey);
      run = markAttemptRunning({
        run: admittedSynthesize.run,
        attemptId: admittedSynthesize.attempt.attemptId,
        startedAt: context.now()
      });
      const synthesized = {
        outcome: "succeeded" as const,
        summary: "synthesized",
        data: { unresolvedFindingIds: ["review:important:1"] }
      };
      run = submitAttemptResult({
        run,
        attemptId: admittedSynthesize.attempt.attemptId,
        idempotencyKey: "result:synthesize:1",
        submissionHash: contentHash(synthesized),
        submission: synthesized,
        trusted: {},
        context
      }).run;
      const condition = Object.values(run.graph.nodes).find(
        (node) =>
          node.materialization?.templateNodeId === "review-result" &&
          node.status === "ready"
      )!;
      run = runControlNode(run, condition.nodeId, context, {
        selectedPort: "clean"
      });
      expect(run.results[firstReview.nodeId]?.data).toMatchObject({
        carry: {
          reviewDisposition: {
            unresolvedFindingIds: ["review:important:1"]
          }
        }
      });
      const secondAnalyze = Object.values(run.graph.nodes).find(
        (node) =>
          node.materialization?.templateNodeId === "analyze" &&
          node.status === "ready"
      )!;
      const admittedSecondAnalyze = admitNode({
        run,
        nodeId: secondAnalyze.nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: secondAnalyze.stateRevision,
        context
      });
      const scoped = workflowExpressionValues(
        admittedSecondAnalyze.run,
        admittedSecondAnalyze.attempt
      );
      expect(scoped).toMatchObject({
        nodes: {
          analyze: { status: "preparing" },
          [firstAnalyze.nodeId]: { status: "succeeded" }
        }
      });
      expect(scoped).not.toHaveProperty("nodes.synthesize");
      expect(
        admittedSecondAnalyze.run.dispatches[
          admittedSecondAnalyze.attempt.dispatchId!
        ]?.bindingInstanceKey
      ).not.toBe(firstAnalyzeDispatch.bindingInstanceKey);
    }
  );

  it("persists exact Shell intent/process evidence and recovers an executing command as outcome-unknown", () => {
    const { context } = createContext();
    const base = JSON.parse(
      readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
    );
    base.inputs = [];
    base.outputs = [];
    base.agentBindings = {};
    base.nodes = [
      startNode("start"),
      {
        id: "shell",
        kind: "shell",
        title: "Shell",
        config: {
          version: 1,
          command: {
            kind: "structured",
            executable: "/usr/bin/printf",
            args: [{ kind: "literal", value: "{}" }]
          },
          targetPolicy: "local",
          surfacePolicy: "create",
          cwdPolicy: "workspace",
          resultMode: "json-stdout",
          maxOutputBytes: 1024
        },
        resultSchema: { schema: { type: "object" } },
        onFailure: "fail-run"
      },
      endNode("end")
    ];
    base.edges = [
      { id: "s-shell", from: { nodeId: "start" }, to: { nodeId: "shell" } },
      { id: "shell-end", from: { nodeId: "shell" }, to: { nodeId: "end" } }
    ];
    const version = publishWorkflowVersion({
      definition: base,
      workflowVersionId: "workflow-version:shell",
      publishedAt: context.now()
    });
    let run = materializeWorkflowRun({
      runId: "run:shell",
      version,
      inputs: {},
      context
    });
    run = runControlNode(run, "start", context);
    const admitted = admitNode({
      run,
      nodeId: "shell",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.shell!.stateRevision,
      context
    });
    run = recordShellExecutionIntent({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      operationId: "shell-operation:1",
      commandHash: contentHash("printf"),
      context
    });
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:test",
      surfaceId: "surface:shell",
      sessionId: "session:shell",
      generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
      inputAuthorityRef: "input:shell"
    };
    run = bindShellExecution({
      run,
      operationId: "shell-operation:1",
      execution,
      processId: 991,
      startedAt: context.now()
    });
    expect(run.shellOperations["shell-operation:1"]).toMatchObject({
      state: "executing",
      processId: 991,
      execution
    });
    const recovered = recoverRun(run, context);
    expect(recovered.shellOperations["shell-operation:1"]?.state).toBe(
      "outcome-unknown"
    );
    expect(recovered.attempts[admitted.attempt.attemptId]?.status).toBe(
      "uncertain"
    );

    const settled = settleShellExecution({
      run,
      operationId: "shell-operation:1",
      exitCode: 0,
      outputHash: contentHash("{}"),
      outputBytes: 2,
      submission: { outcome: "succeeded", summary: "done", data: {} },
      context
    });
    expect(settled.results.shell?.shellExecutionReceipt).toMatchObject({
      operationId: "shell-operation:1",
      exitCode: 0,
      execution
    });
  });

  it("allows shared reads and fences concurrent writers across Runs", () => {
    const { context } = createContext();
    const first = adaptiveRun(context);
    const second = { ...adaptiveRun(context), runId: "other" };
    const lease = {
      resource: { kind: "worktree" as const, identity: "repo:w" },
      owner: { kind: "attempt" as const, id: "reader" },
      mode: "read" as const,
      capacityClaim: 1
    };
    const reader = acquireResourceLease({ run: first, lease, context }).run;
    expect(
      acquireResourceLease({
        run: second,
        leaseRuns: [reader, second],
        lease,
        context
      }).lease.mode
    ).toBe("read");
    expect(() =>
      acquireResourceLease({
        run: second,
        leaseRuns: [reader, second],
        lease: { ...lease, mode: "write" },
        context
      })
    ).toThrow(/fenced/);
    const writer = acquireResourceLease({
      run: first,
      lease: { ...lease, mode: "write" },
      context
    }).run;
    expect(() =>
      acquireResourceLease({
        run: second,
        leaseRuns: [writer, second],
        lease,
        context
      })
    ).toThrow(/fenced/);
  });

  it("fences revisioned leases through uncertainty and requires reconciliation", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    const acquired = acquireResourceLease({
      run,
      lease: {
        resource: { kind: "worktree", identity: "local:repo:wt" },
        owner: { kind: "attempt", id: "attempt:1", generation: "epoch:1" },
        mode: "write",
        capacityClaim: 1
      },
      context
    });
    run = markLeaseUncertain({
      run: acquired.run,
      leaseId: acquired.lease.leaseId,
      expectedRevision: 1,
      expectedOwnerEpoch: 1
    });
    expect(() =>
      acquireResourceLease({
        run,
        lease: {
          resource: { kind: "worktree", identity: "local:repo:wt" },
          owner: { kind: "attempt", id: "attempt:2" },
          mode: "write",
          capacityClaim: 1
        },
        context
      })
    ).toThrow(/fenced/);
    expect(() =>
      releaseLease({
        run,
        leaseId: acquired.lease.leaseId,
        expectedRevision: 2,
        expectedOwnerEpoch: 1,
        reconciled: false
      })
    ).toThrow(/reconciliation/);
    expect(() =>
      releaseLease({
        run,
        leaseId: acquired.lease.leaseId,
        expectedRevision: 1,
        expectedOwnerEpoch: 1,
        reconciled: true
      })
    ).toThrow(/stale lease/);
    run = releaseLease({
      run,
      leaseId: acquired.lease.leaseId,
      expectedRevision: 2,
      expectedOwnerEpoch: 1,
      reconciled: true
    });
    expect(run.leases[acquired.lease.leaseId]?.state).toBe("released");
  });

  it("keeps cancellation nonterminal and resources fenced until exact confirmation or reconciliation", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    const worker: WorkflowNodeDefinition = {
      id: "worker",
      kind: "agent",
      title: "Worker",
      config: {
        version: 1,
        agentRef: "author",
        prompt: "Work",
        lifecycleMode: "managed",
        coding: true
      },
      completionRoot: true,
      onCancel: "fail-run"
    };
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create",
          sessionPolicy: "fresh",
          worktreePolicy: "dedicated-top-level",
          inputMode: "orchestrated"
        }
      },
      { kind: "add-node", node: worker }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    run = markAttemptRunning({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      startedAt: context.now()
    });
    const leased = acquireResourceLease({
      run,
      lease: {
        resource: { kind: "worktree", identity: "local:repo:worker" },
        owner: { kind: "attempt", id: admitted.attempt.attemptId },
        mode: "write",
        capacityClaim: 1
      },
      context
    });
    const cancellation = requestAttemptCancellation({
      run: leased.run,
      attemptId: admitted.attempt.attemptId,
      idempotencyKey: "cancel:worker",
      context
    });

    const confirmed = confirmAttemptCancellation({
      run: cancellation.run,
      operationId: cancellation.operation.operationId,
      executorReceiptId: "executor-receipt:1",
      context
    });
    expect(confirmed.attempts[admitted.attempt.attemptId]?.status).toBe(
      "canceled"
    );
    expect(confirmed.leases[leased.lease.leaseId]?.state).toBe("released");

    const uncertain = markCancellationUncertain({
      run: cancellation.run,
      operationId: cancellation.operation.operationId
    });
    expect(uncertain.attempts[admitted.attempt.attemptId]?.status).toBe(
      "cancel-uncertain"
    );
    expect(uncertain.leases[leased.lease.leaseId]?.state).toBe("uncertain");
    expect(uncertain.status).toBe("needs-attention");
    expect(
      recoverRun(uncertain, context).leases[leased.lease.leaseId]?.state
    ).toBe("uncertain");
    const reconciled = resolveUncertainAttempt({
      run: uncertain,
      attemptId: admitted.attempt.attemptId,
      resolution: "mark-failed",
      summary: "operator verified that the worker was lost",
      context
    });
    expect(reconciled.attempts[admitted.attempt.attemptId]?.status).toBe(
      "failed"
    );
    expect(reconciled.leases[leased.lease.leaseId]?.state).toBe("abandoned");
  });

  it.each(["confirmed", "uncertain"] as const)(
    "preserves selected failure while sibling cancellation is %s",
    (cancellationOutcome) => {
      const { context } = createContext();
      let run = adaptiveRun(context);
      run = patch(run, context, [
        { kind: "add-node", node: startNode("start") },
        {
          kind: "add-node",
          node: { ...startNode("fails"), onFailure: "fail-run" }
        },
        { kind: "add-node", node: shellNode("sibling") },
        { kind: "add-node", node: endNode("done") },
        {
          kind: "add-edge",
          edge: {
            id: "start-fails",
            from: { nodeId: "start" },
            to: { nodeId: "fails" }
          },
          expectedTargetNodeStateRevision: 0
        },
        {
          kind: "add-edge",
          edge: {
            id: "start-sibling",
            from: { nodeId: "start" },
            to: { nodeId: "sibling" }
          },
          expectedTargetNodeStateRevision: 0
        },
        {
          kind: "add-edge",
          edge: {
            id: "sibling-done",
            from: { nodeId: "sibling" },
            to: { nodeId: "done" }
          },
          expectedTargetNodeStateRevision: 0
        }
      ]);
      run = runControlNode(run, "start", context);
      const failing = admitNode({
        run,
        nodeId: "fails",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.fails!.stateRevision,
        context
      });
      const sibling = admitNode({
        run: failing.run,
        nodeId: "sibling",
        expectedGraphRevision: failing.run.graph.revision,
        expectedNodeStateRevision:
          failing.run.graph.nodes.sibling!.stateRevision,
        context
      });
      run = markAttemptRunning({
        run: sibling.run,
        attemptId: failing.attempt.attemptId,
        startedAt: context.now()
      });
      run = markAttemptRunning({
        run,
        attemptId: sibling.attempt.attemptId,
        startedAt: context.now()
      });
      run = settleControlNode({
        run,
        attemptId: failing.attempt.attemptId,
        outcome: "failed",
        context
      });
      expect(run.status).toBe("settling");
      expect(run.attempts[sibling.attempt.attemptId]?.status).toBe(
        "cancel-requested"
      );
      const cancellation = Object.values(run.cancellations).find(
        (operation) => operation.attemptId === sibling.attempt.attemptId
      )!;
      if (cancellationOutcome === "confirmed") {
        run = confirmAttemptCancellation({
          run,
          operationId: cancellation.operationId,
          executorReceiptId: "executor:canceled",
          context
        });
        expect(run.status).toBe("failed");
        expect(run.settlingTargetOutcome).toBe("failed");
        return;
      }
      run = markCancellationUncertain({
        run,
        operationId: cancellation.operationId
      });
      expect(run.status).toBe("settling");
      expect(run.settledAt).toBeUndefined();
      run = resolveUncertainAttempt({
        run,
        attemptId: sibling.attempt.attemptId,
        resolution: "mark-failed",
        summary: "Exact process reconciliation proved the sibling lost",
        context
      });
      expect(run.status).toBe("failed");
      expect(run.cancellations[cancellation.operationId]?.state).toBe(
        "confirmed"
      );
    }
  );

  it("settles an active structured Loop locally when another required node fails", () => {
    const { context } = createContext();
    const base = JSON.parse(
      readFileSync(resolve(fixtureRoot, "workflow-v1.valid.json"), "utf8")
    );
    base.inputs = [];
    base.outputs = [];
    base.agentBindings = {};
    base.nodes = [
      startNode("start"),
      {
        id: "fails",
        kind: "condition",
        title: "Fails",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "true",
          ports: ["success", "failure"]
        },
        onFailure: "fail-run"
      },
      {
        id: "loop",
        kind: "loop",
        title: "Review rounds",
        config: {
          version: 1,
          mode: "while",
          maxIterations: 2,
          body: {
            nodeIds: ["body"],
            entryNodeIds: ["body"],
            exits: [
              { nodeId: "body", port: "continue", outcome: "continue" },
              { nodeId: "body", port: "clean", outcome: "clean" }
            ]
          },
          repeatOutcome: "continue",
          completedOutcomes: ["clean"],
          completedPort: "completed",
          maxReachedPort: "max-reached"
        }
      },
      {
        id: "body",
        kind: "condition",
        title: "Body",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "false",
          ports: ["continue", "clean"]
        }
      },
      endNode("done", { joinPolicy: "all-settled" })
    ];
    base.edges = [
      { id: "start-fails", from: { nodeId: "start" }, to: { nodeId: "fails" } },
      { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
      {
        id: "fails-success",
        from: { nodeId: "fails", port: "success" },
        to: { nodeId: "done" }
      },
      {
        id: "fails-failure",
        from: { nodeId: "fails", port: "failure" },
        to: { nodeId: "done" }
      },
      {
        id: "loop-done",
        from: { nodeId: "loop", port: "completed" },
        to: { nodeId: "done" }
      },
      {
        id: "loop-max",
        from: { nodeId: "loop", port: "max-reached" },
        to: { nodeId: "done" }
      }
    ];
    const version = publishWorkflowVersion({
      definition: base,
      workflowVersionId: "workflow-version:control-cancel",
      publishedAt: context.now()
    });
    let run = materializeWorkflowRun({
      runId: "run:control-cancel",
      version,
      inputs: {},
      context
    });
    run = runControlNode(run, "start", context);
    const failing = admitNode({
      run,
      nodeId: "fails",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.fails!.stateRevision,
      context
    });
    const loop = admitNode({
      run: failing.run,
      nodeId: "loop",
      expectedGraphRevision: failing.run.graph.revision,
      expectedNodeStateRevision: failing.run.graph.nodes.loop!.stateRevision,
      context
    });
    run = markAttemptRunning({
      run: loop.run,
      attemptId: failing.attempt.attemptId,
      startedAt: context.now()
    });
    run = startStructuredLoop({
      run,
      attemptId: loop.attempt.attemptId,
      context
    });
    run = settleControlNode({
      run,
      attemptId: failing.attempt.attemptId,
      outcome: "failed",
      context
    });

    expect(run.status).toBe("failed");
    expect(run.attempts[loop.attempt.attemptId]?.status).toBe("canceled");
    expect(run.graph.nodes.loop?.status).toBe("canceled");
    expect(
      Object.values(run.cancellations).some(
        (operation) => operation.attemptId === loop.attempt.attemptId
      )
    ).toBe(false);
  });

  it("keeps Human Gate resolutions and typed Coordinator questions durable", () => {
    const { context } = createContext();
    let run = adaptiveRun(context);
    run = patch(run, context, [
      {
        kind: "add-node",
        node: {
          id: "approval",
          kind: "human-gate",
          title: "Approval",
          config: {
            version: 1,
            question: "Ship this change?",
            resolutions: ["approve", "reject"],
            approverPolicy: "local-user"
          },
          completionRoot: true
        }
      }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "approval",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.approval!.stateRevision,
      context
    });
    const opened = openHumanGate({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      context
    });
    expect(opened.run.status).toBe("waiting-gate");
    const cancellation = requestAttemptCancellation({
      run: opened.run,
      attemptId: admitted.attempt.attemptId,
      idempotencyKey: "cancel:gate",
      context
    });
    const recoveredCancellation = recoverRun(cancellation.run, context);
    expect(
      recoveredCancellation.attempts[admitted.attempt.attemptId]?.status
    ).toBe("cancel-requested");
    const canceled = confirmAttemptCancellation({
      run: recoveredCancellation,
      operationId: cancellation.operation.operationId,
      executorReceiptId: "control:gate",
      context
    });
    expect(canceled.gates[opened.gate.gateId]?.state).toBe("canceled");
    expect(canceled.counters.activeAttempts).toBe(0);
    run = resolveHumanGate({
      run: opened.run,
      gateId: opened.gate.gateId,
      resolution: "approve",
      principal: "user:local",
      context
    });
    expect(run.gates[opened.gate.gateId]?.resolvedBy).toBe("user:local");

    const question = postOrchestrationMessage({
      run,
      kind: "question",
      principal: "session:worker",
      body: { text: "Which release channel?" },
      context
    });
    expect(question.run.messages).toHaveLength(1);
    expect(question.run.mailboxEvents).toEqual([
      expect.objectContaining({
        type: "question",
        messageId: question.message.messageId,
        target: { kind: "coordinator" }
      })
    ]);
  });

  it("replays one 50-event FIFO Delivery and uses filters only as a wake condition", () => {
    const { context } = createContext();
    const worker = activeMailboxWorker(context);
    let run = worker.run;
    for (let index = 0; index < 55; index += 1) {
      run = postOrchestrationMessage({
        run,
        kind: "guidance",
        principal: "session:coordinator",
        attemptId: worker.attemptId,
        body: { text: `guidance ${index}` },
        wakeCoordinator: false,
        context
      }).run;
    }
    const question = postOrchestrationMessage({
      run,
      kind: "question",
      principal: "session:worker",
      attemptId: worker.attemptId,
      body: { text: "Which channel?" },
      context
    });
    expect(question.run.attempts[worker.attemptId]?.status).toBe(
      "waiting-input"
    );
    const reply = postOrchestrationMessage({
      run: question.run,
      kind: "reply",
      principal: "session:coordinator",
      attemptId: worker.attemptId,
      replyToMessageId: question.message.messageId,
      body: { text: "stable" },
      wakeCoordinator: false,
      context
    });
    const consumer = dispatchMailboxConsumer(reply.run, worker.dispatchId);
    const first = claimMailboxDelivery({
      run: reply.run,
      consumer,
      types: ["reply"],
      context
    });
    expect(first.delivery?.eventIds).toHaveLength(50);
    expect(
      first.delivery?.eventIds.map(
        (id) =>
          first.run.mailboxEvents.find((event) => event.eventId === id)?.type
      )
    ).toEqual(Array.from({ length: 50 }, () => "guidance"));

    const replay = claimMailboxDelivery({
      run: first.run,
      consumer,
      types: ["reply"],
      context
    });
    expect(replay.replayed).toBe(true);
    expect(replay.delivery).toEqual(first.delivery);

    run = acknowledgeMailboxDelivery({
      run: replay.run,
      consumer,
      deliveryId: replay.delivery!.deliveryId,
      context
    });
    const second = claimMailboxDelivery({
      run,
      consumer,
      types: ["reply"],
      context
    });
    expect(second.delivery?.eventIds).toHaveLength(6);
    expect(
      second.delivery?.eventIds.map(
        (id) =>
          second.run.mailboxEvents.find((event) => event.eventId === id)?.type
      )
    ).toEqual([
      "guidance",
      "guidance",
      "guidance",
      "guidance",
      "guidance",
      "reply"
    ]);
    run = acknowledgeMailboxDelivery({
      run: second.run,
      consumer,
      deliveryId: second.delivery!.deliveryId,
      context
    });
    expect(run.attempts[worker.attemptId]?.status).toBe("running");
  });

  it("blocks worker_done on unread mail and Coordinator ack on an undisposed Worker", () => {
    const { context } = createContext();
    const worker = activeMailboxWorker(context);
    let run = postOrchestrationMessage({
      run: worker.run,
      kind: "guidance",
      principal: "session:coordinator",
      attemptId: worker.attemptId,
      body: { text: "Check this before completing" },
      wakeCoordinator: false,
      context
    }).run;
    const submission = {
      outcome: "succeeded" as const,
      summary: "Mailbox processed"
    };
    expect(() =>
      submitAttemptResult({
        run,
        attemptId: worker.attemptId,
        idempotencyKey: "result:mailbox:blocked",
        submissionHash: contentHash(submission),
        submission,
        trusted: {},
        context
      })
    ).toThrow(`check --dispatch ${worker.dispatchId}`);

    const workerConsumer = dispatchMailboxConsumer(run, worker.dispatchId);
    const workerDelivery = claimMailboxDelivery({
      run,
      consumer: workerConsumer,
      context
    });
    run = acknowledgeMailboxDelivery({
      run: workerDelivery.run,
      consumer: workerConsumer,
      deliveryId: workerDelivery.delivery!.deliveryId,
      context
    });
    const question = postOrchestrationMessage({
      run,
      kind: "question",
      principal: "session:worker",
      attemptId: worker.attemptId,
      body: { text: "Can I finish?" },
      context
    });
    run = postOrchestrationMessage({
      run: question.run,
      kind: "reply",
      principal: "session:coordinator",
      attemptId: worker.attemptId,
      replyToMessageId: question.message.messageId,
      body: { text: "yes" },
      wakeCoordinator: false,
      context
    }).run;
    const replyDelivery = claimMailboxDelivery({
      run,
      consumer: workerConsumer,
      context
    });
    run = acknowledgeMailboxDelivery({
      run: replyDelivery.run,
      consumer: workerConsumer,
      deliveryId: replyDelivery.delivery!.deliveryId,
      context
    });
    run = submitAttemptResult({
      run,
      attemptId: worker.attemptId,
      idempotencyKey: "result:mailbox:ok",
      submissionHash: contentHash(submission),
      submission,
      trusted: {},
      context
    }).run;
    expect(run.dispatches[worker.dispatchId]?.terminalState).toBe(
      "reclaimable"
    );
    expect(() =>
      postOrchestrationMessage({
        run,
        kind: "guidance",
        principal: "session:coordinator",
        attemptId: worker.attemptId,
        body: { text: "too late" },
        wakeCoordinator: false,
        context
      })
    ).toThrow(/completed Dispatches/u);
    const coordinator = coordinatorMailboxConsumer(run);
    const completed = claimMailboxDelivery({
      run,
      consumer: coordinator,
      context
    });
    expect(
      completed.delivery?.eventIds.map(
        (id) =>
          completed.run.mailboxEvents.find((event) => event.eventId === id)
            ?.type
      )
    ).toEqual(["question", "worker_done"]);
    expect(() =>
      acknowledgeMailboxDelivery({
        run: completed.run,
        consumer: coordinator,
        deliveryId: completed.delivery!.deliveryId,
        context
      })
    ).toThrow(/must be reused, retained, or released/u);

    run = requestAttemptInputDisposition({
      run: completed.run,
      attemptId: worker.attemptId,
      disposition: "retain",
      idempotencyKey: "retain:mailbox",
      context
    });
    run = settleAttemptInputDisposition({
      run,
      attemptId: worker.attemptId,
      expectedRevision: run.inputControls[worker.attemptId]!.revision,
      disposition: "retain",
      context
    });
    expect(
      acknowledgeMailboxDelivery({
        run,
        consumer: coordinator,
        deliveryId: completed.delivery!.deliveryId,
        context
      }).mailboxConsumers.coordinator?.activeDelivery
    ).toBeUndefined();
  });

  it("rejects a stale terminal generation for Worker mailbox replay or ack", () => {
    const { context } = createContext();
    const worker = activeMailboxWorker(context);
    const posted = postOrchestrationMessage({
      run: worker.run,
      kind: "guidance",
      principal: "session:coordinator",
      attemptId: worker.attemptId,
      body: { text: "Generation-bound" },
      wakeCoordinator: false,
      context
    });
    const consumer = dispatchMailboxConsumer(posted.run, worker.dispatchId);
    const claimed = claimMailboxDelivery({
      run: posted.run,
      consumer,
      context
    });
    const stale = {
      ...consumer,
      execution: {
        ...worker.execution,
        generation: { kind: "local" as const, runtimeEpoch: "epoch:stale" }
      }
    };
    expect(() =>
      claimMailboxDelivery({ run: claimed.run, consumer: stale, context })
    ).toThrow(/generation is stale/u);
    expect(() =>
      acknowledgeMailboxDelivery({
        run: claimed.run,
        consumer: stale,
        deliveryId: claimed.delivery!.deliveryId,
        context
      })
    ).toThrow(/exact mailbox consumer/u);
  });

  it("preserves history across an explicit release-unknown retry", () => {
    const { context } = createContext();
    const worker = activeMailboxWorker(context);
    const submission = {
      outcome: "succeeded" as const,
      summary: "Ready for cleanup"
    };
    let run = submitAttemptResult({
      run: worker.run,
      attemptId: worker.attemptId,
      idempotencyKey: "result:release",
      submissionHash: contentHash(submission),
      submission,
      trusted: {},
      context
    }).run;
    run = requestAttemptInputDisposition({
      run,
      attemptId: worker.attemptId,
      disposition: "release",
      idempotencyKey: "release:first",
      context
    });
    expect(run.dispatches[worker.dispatchId]?.terminalState).toBe(
      "release-pending"
    );
    const archive = {
      artifact: {
        artifactId: "artifact:history",
        kind: "worker-output",
        contentHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        sizeBytes: 32
      },
      source: "terminal",
      status: "available",
      truncated: false
    } as const;
    run = recordWorkerTerminalHistory({
      run,
      dispatchId: worker.dispatchId,
      history: archive
    });
    run = markWorkerTerminalReleaseUnknown({
      run,
      dispatchId: worker.dispatchId,
      context
    });
    expect(run.dispatches[worker.dispatchId]).toMatchObject({
      terminalState: "release-unknown",
      terminalHistory: archive
    });
    run = requestAttemptInputDisposition({
      run,
      attemptId: worker.attemptId,
      disposition: "release",
      idempotencyKey: "release:retry",
      context
    });
    run = settleAttemptInputDisposition({
      run,
      attemptId: worker.attemptId,
      expectedRevision: run.inputControls[worker.attemptId]!.revision,
      disposition: "release",
      context
    });
    expect(run.dispatches[worker.dispatchId]).toMatchObject({
      terminalState: "released",
      terminalHistory: archive
    });
  });

  it("atomically transfers one reclaimable terminal generation on exact reuse", () => {
    const { context } = createContext();
    const worker = activeMailboxWorker(context);
    const submission = {
      outcome: "succeeded" as const,
      summary: "Reusable"
    };
    let run = submitAttemptResult({
      run: worker.run,
      attemptId: worker.attemptId,
      idempotencyKey: "result:reuse",
      submissionHash: contentHash(submission),
      submission,
      trusted: {},
      context
    }).run;
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "worker:reused",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "existing",
          sessionPolicy: "existing",
          existingSurfaceId: worker.execution.surfaceId,
          worktreePolicy: "current",
          inputMode: "interactive-recorded"
        }
      },
      {
        kind: "add-node",
        node: {
          id: "worker:reused",
          kind: "agent",
          title: "Reused Worker",
          config: {
            version: 1,
            agentRef: "worker:reused",
            prompt: "Continue in the exact session",
            lifecycleMode: "managed",
            coding: true
          },
          completionRoot: true
        }
      }
    ]);
    const admitted = admitNode({
      run,
      nodeId: "worker:reused",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision:
        run.graph.nodes["worker:reused"]!.stateRevision,
      context
    });
    const transfer = {
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      execution: worker.execution,
      launchReceipt: testLaunchReceipt(),
      context
    };
    expect(() => prepareAttemptInputControl(transfer)).toThrow(
      "Worker history must be preserved before terminal reuse"
    );
    expect(admitted.run.dispatches[worker.dispatchId]?.terminalState).toBe(
      "reclaimable"
    );
    const history = {
      artifact: {
        artifactId: "artifact:reuse-history",
        kind: "worker-output",
        contentHash: contentHash("previous Dispatch output"),
        sizeBytes: 24
      },
      source: "terminal",
      status: "available",
      truncated: false
    } as const;
    run = recordWorkerTerminalHistory({
      run: admitted.run,
      dispatchId: worker.dispatchId,
      history
    });
    run = prepareAttemptInputControl({ ...transfer, run });
    expect(run.dispatches[worker.dispatchId]).toMatchObject({
      terminalState: "released",
      terminalDisposition: "reuse",
      reusedByDispatchId: admitted.attempt.dispatchId,
      terminalHistory: history
    });
    expect(run.dispatches[admitted.attempt.dispatchId!]).toMatchObject({
      terminalState: "active",
      reusedFromDispatchId: worker.dispatchId
    });
  });

  it.each(["checkpoint", "needs-attention"] as const)(
    "keeps a %s timeout observable without assuming execution stopped",
    (onTimeout) => {
      const { context, setTime } = createContext();
      let run = patch(adaptiveRun(context), context, [
        {
          kind: "add-node",
          node: {
            ...shellNode("timed"),
            completionRoot: true,
            timeoutPolicy: { timeoutMs: 1000, onTimeout }
          }
        }
      ]);
      const admitted = admitNode({
        run,
        nodeId: "timed",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.timed!.stateRevision,
        context
      });
      const attemptId = admitted.attempt.attemptId;
      run = markAttemptRunning({
        run: admitted.run,
        attemptId,
        startedAt: context.now()
      });
      setTime(admitted.attempt.dueAt!);
      run = fireDueTimers({ run, observedAt: context.now(), context });
      expect(run.status).toBe(
        onTimeout === "checkpoint" ? "running" : "needs-attention"
      );
      expect(run.attempts[attemptId]!.status).toBe("running");
      expect(Object.values(run.cancellations)).toHaveLength(0);
      const submission = {
        outcome: "succeeded" as const,
        summary: "Real result arrived after timeout"
      };
      run = submitAttemptResult({
        run,
        attemptId,
        idempotencyKey: "late-result",
        submissionHash: contentHash(submission),
        submission,
        trusted: {},
        context
      }).run;
      expect(run.results.timed).toMatchObject({ outcome: "succeeded" });
    }
  );

  it.each(["fail", "cancel-and-retry"] as const)(
    "dispatches timeout %s through exact cancellation before settlement or bounded retry",
    (onTimeout) => {
      const { context, setTime } = createContext();
      let run = patch(adaptiveRun(context), context, [
        {
          kind: "add-node",
          node: {
            ...shellNode("timed"),
            completionRoot: true,
            timeoutPolicy: { timeoutMs: 1000, onTimeout },
            retryPolicy: {
              maxAttempts: 2,
              retryable: ["timeout"],
              backoffMs: 500,
              placement: "same"
            }
          }
        }
      ]);
      const admitted = admitNode({
        run,
        nodeId: "timed",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.timed!.stateRevision,
        context
      });
      const attemptId = admitted.attempt.attemptId;
      const leased = acquireResourceLease({
        run: admitted.run,
        lease: {
          resource: { kind: "worktree", identity: "local:timeout" },
          owner: { kind: "attempt", id: attemptId },
          mode: "write",
          capacityClaim: 1
        },
        context
      });
      run = markAttemptRunning({
        run: leased.run,
        attemptId,
        startedAt: context.now()
      });
      setTime(admitted.attempt.dueAt!);
      run = fireDueTimers({ run, observedAt: context.now(), context });
      const operation = Object.values(run.cancellations)[0]!;
      expect(operation).toMatchObject({
        attemptId,
        state: "requested",
        timeout: { onTimeout }
      });
      expect(run.attempts[attemptId]!.status).toBe("cancel-requested");
      expect(run.leases[leased.lease.leaseId]!.state).toBe("active");
      expect(
        Object.values(
          fireDueTimers({ run, observedAt: context.now(), context })
            .cancellations
        )
      ).toHaveLength(1);
      const uncertain = recoverRun(
        markCancellationUncertain({ run, operationId: operation.operationId }),
        context
      );
      expect(uncertain.leases[leased.lease.leaseId]!.state).toBe("uncertain");
      expect(uncertain.graph.nodes.timed!.attemptIds).toEqual([attemptId]);
      expect(() =>
        confirmAttemptCancellation({
          run: uncertain,
          operationId: operation.operationId,
          executorReceiptId: "unproven",
          context
        })
      ).toThrow(/reconciliation/);
      const uncertainPlacement = markLeaseUncertain({
        run,
        leaseId: leased.lease.leaseId,
        expectedRevision: leased.lease.revision,
        expectedOwnerEpoch: leased.lease.ownerEpoch
      });
      const placementFenced = confirmAttemptCancellation({
        run: uncertainPlacement,
        operationId: operation.operationId,
        executorReceiptId: "execution-ended-placement-unresolved",
        context
      });
      expect(placementFenced.leases[leased.lease.leaseId]!.state).toBe(
        "uncertain"
      );
      expect(
        Object.values(placementFenced.timers).filter(
          (timer) => timer.kind === "retry"
        )
      ).toHaveLength(0);
      run = confirmAttemptCancellation({
        run,
        operationId: operation.operationId,
        executorReceiptId: "exact-termination",
        context
      });
      expect(run.attemptResults[attemptId]).toMatchObject({
        outcome: "failed",
        failureClass: "timeout"
      });
      expect(run.leases[leased.lease.leaseId]!.state).toBe("released");
      expect(
        confirmAttemptCancellation({
          run,
          operationId: operation.operationId,
          executorReceiptId: "exact-termination",
          context
        })
      ).toEqual(run);
      if (onTimeout === "fail") {
        expect(run.status).toBe("failed");
        expect(run.results.timed).toMatchObject({ failureClass: "timeout" });
        return;
      }
      const timer = Object.values(run.timers).find(
        (entry) => entry.kind === "retry"
      )!;
      run = recoverRun(run, context);
      expect(run.graph.nodes.timed!.status).toBe("pending");
      expect(run.timers[timer.timerId]!.dueAt).toBe(timer.dueAt);
      setTime(timer.dueAt);
      run = fireDueTimers({ run, observedAt: context.now(), context });
      const retried = admitNode({
        run,
        nodeId: "timed",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.timed!.stateRevision,
        context
      });
      expect(retried.attempt).toMatchObject({
        ordinal: 2,
        retryOfAttemptId: attemptId
      });
      setTime(retried.attempt.dueAt!);
      run = fireDueTimers({
        run: retried.run,
        observedAt: context.now(),
        context
      });
      const last = Object.values(run.cancellations).find(
        (entry) => entry.attemptId === retried.attempt.attemptId
      )!;
      run = confirmAttemptCancellation({
        run,
        operationId: last.operationId,
        executorReceiptId: "exact-second-termination",
        context
      });
      expect(run.graph.nodes.timed!.attemptIds).toHaveLength(2);
      expect(run.status).toBe("failed");
    }
  );

  it.each(["same", "approval-for-change", "allow-fresh"] as const)(
    "enforces %s retry placement before terminal ownership and prompt effects",
    (placement) => {
      const { context } = createContext();
      let run = patch(
        adaptiveRun(context, limits({ maxAttemptsPerSession: 3 })),
        context,
        [
          {
            kind: "add-binding",
            agentRef: "worker",
            binding: {
              agent: { kind: "agent-id", agentId: "copilot" },
              scope: { kind: "run" },
              authorityMode: "ambient",
              targetPolicy: "local",
              surfacePolicy: "create",
              sessionPolicy: "fresh",
              worktreePolicy: "current",
              inputMode: "orchestrated"
            }
          },
          {
            kind: "add-node",
            node: {
              id: "worker",
              kind: "agent",
              title: "Retry worker",
              completionRoot: true,
              config: {
                version: 1,
                agentRef: "worker",
                prompt: "Work",
                lifecycleMode: "managed",
                coding: false
              },
              retryPolicy: {
                maxAttempts: 3,
                backoffMs: 0,
                retryable: ["executor-error"],
                placement
              }
            }
          }
        ]
      );
      const first = admitNode({
        run,
        nodeId: "worker",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
        context
      });
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:retry",
        surfaceId: "surface:retry",
        sessionId: "session:retry",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:retry" },
        inputAuthorityRef: "authority:retry"
      };
      const readiness = {
        receiptId: "ready:first",
        execution,
        agentId: "copilot",
        agentInstanceId: "instance:retry",
        verifiedProviderSessionId: "provider:retry",
        readyEpoch: "epoch:first",
        state: "ready-for-input" as const,
        observedAt: context.now()
      };
      const repositoryStateInput = {
        targetId: "local",
        repositoryId: "repository:retry",
        headOid: "head:retry",
        worktreeRef: {
          targetId: "local",
          worktreeId: "worktree:retry",
          pathToken: "path:retry"
        },
        capturedAt: context.now(),
        consistency: "fenced-live-worktree" as const
      };
      const payloadHash = contentHash("Task one");
      const delivered = prepareAgentPromptDelivery({
        run: first.run,
        attemptId: first.attempt.attemptId,
        execution,
        readiness,
        repositoryStateInput,
        launchReceipt: testLaunchReceipt(),
        payloadHash,
        context
      });
      run = settleAgentPromptDelivery({
        run: delivered.run,
        operationId: delivered.delivery.operationId,
        payloadHash,
        outcome: "written",
        context
      });
      const failed = {
        outcome: "failed" as const,
        failureClass: "executor-error" as const,
        summary: "Try again"
      };
      run = submitAttemptResult({
        run,
        attemptId: first.attempt.attemptId,
        idempotencyKey: "failed:first",
        submissionHash: contentHash(failed),
        submission: failed,
        trusted: {},
        context
      }).run;
      run = recordWorkerTerminalHistory({
        run,
        dispatchId: first.attempt.dispatchId!,
        history: {
          artifact: {
            artifactId: "artifact:retry-history",
            kind: "worker-output",
            contentHash: contentHash("failed Dispatch output"),
            sizeBytes: 22
          },
          source: "terminal",
          status: "available",
          truncated: false
        }
      });
      run = fireDueTimers({ run, observedAt: context.now(), context });
      const second = admitNode({
        run,
        nodeId: "worker",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
        context
      });
      const retry = {
        run: second.run,
        attemptId: second.attempt.attemptId,
        execution,
        launchReceipt: testLaunchReceipt(),
        context
      };
      const changedExecution = {
        ...execution,
        generation: { kind: "local" as const, runtimeEpoch: "replacement" }
      };
      const prepareChanged = () =>
        prepareAttemptInputControl({ ...retry, execution: changedExecution });
      if (placement === "allow-fresh") expect(prepareChanged).not.toThrow();
      else
        expect(prepareChanged).toThrow(/previous Agent and terminal placement/);
      const prompt = {
        ...retry,
        readiness: {
          ...readiness,
          receiptId: "ready:second",
          readyEpoch: "epoch:second"
        },
        repositoryStateInput,
        payloadHash: contentHash("Task two")
      };
      const changedInstance = () =>
        prepareAgentPromptDelivery({
          ...prompt,
          readiness: { ...prompt.readiness, agentInstanceId: "replacement" }
        });
      const changedWorktree = () =>
        prepareAgentPromptDelivery({
          ...prompt,
          repositoryStateInput: {
            ...repositoryStateInput,
            worktreeRef: {
              ...repositoryStateInput.worktreeRef,
              pathToken: "replacement"
            }
          }
        });
      if (placement === "allow-fresh") {
        expect(changedInstance).not.toThrow();
        expect(changedWorktree).not.toThrow();
      } else {
        expect(changedInstance).toThrow(
          /previous provider instance and worktree/
        );
        expect(changedWorktree).toThrow(
          /previous provider instance and worktree/
        );
      }
      const prepared = prepareAgentPromptDelivery(prompt);
      expect(prepared.delivery.operationId).not.toBe(
        delivered.delivery.operationId
      );
      expect(prepared.delivery.execution).toEqual(execution);
      expect(prepared.run.attempts[second.attempt.attemptId]).toMatchObject({
        ordinal: 2,
        retryOfAttemptId: first.attempt.attemptId
      });
      expect(
        prepared.run.attemptResults[first.attempt.attemptId]
      ).toMatchObject(failed);
      // A user retry after an unavailable preparation still targets the original placement.
      const flagged = markAttemptPreparationNeedsAttention({
        run: second.run,
        attemptId: second.attempt.attemptId,
        code: "agent-retry-placement-unavailable",
        reason: "Terminal unavailable",
        context
      });
      run = requestAttemptRetry({
        run: flagged,
        attemptId: second.attempt.attemptId,
        idempotencyKey: "retry:after-attention",
        principal: "user:local",
        context
      }).run;
      const third = admitNode({
        run,
        nodeId: "worker",
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
        context
      });
      const afterAttention = () =>
        prepareAttemptInputControl({
          ...retry,
          run: third.run,
          attemptId: third.attempt.attemptId,
          execution: changedExecution
        });
      if (placement === "allow-fresh") expect(afterAttention).not.toThrow();
      else
        expect(afterAttention).toThrow(/previous Agent and terminal placement/);
      if (placement === "approval-for-change") {
        const approval = {
          run: flagged,
          attemptId: second.attempt.attemptId,
          idempotencyKey: "retry:approved-placement",
          principal: "user:local",
          placementChangeApproved: true as const,
          context
        };
        expect(() =>
          requestAttemptRetry({ ...approval, principal: "session:worker" })
        ).toThrow(/explicit user approval/);
        const approved = requestAttemptRetry(approval);
        expect(() =>
          requestAttemptRetry({
            ...approval,
            run: approved.run,
            placementChangeApproved: undefined
          })
        ).toThrow(/idempotency key/);
        const replacement = admitNode({
          run: approved.run,
          nodeId: "worker",
          expectedGraphRevision: approved.run.graph.revision,
          expectedNodeStateRevision:
            approved.run.graph.nodes.worker!.stateRevision,
          context
        });
        expect(() =>
          prepareAttemptInputControl({
            ...retry,
            run: replacement.run,
            attemptId: replacement.attempt.attemptId,
            execution: changedExecution
          })
        ).not.toThrow();
      }
    }
  );

  it("keeps retry deadlines and budgets durable across restart", () => {
    const { context } = createContext();
    let run = adaptiveRun(context, limits({ maxGraphPatches: 1 }));
    const worker: WorkflowNodeDefinition = {
      id: "worker",
      kind: "agent",
      title: "Worker",
      config: {
        version: 1,
        agentRef: "author",
        prompt: "Work",
        lifecycleMode: "managed",
        coding: true
      },
      retryPolicy: {
        maxAttempts: 2,
        retryable: ["executor-error"],
        backoffMs: 60_000,
        placement: "same"
      },
      completionRoot: true,
      onFailure: "fail-run"
    };
    run = patch(run, context, [
      {
        kind: "add-binding",
        agentRef: "author",
        binding: {
          agent: { kind: "agent-id", agentId: "codex" },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: "create",
          sessionPolicy: "fresh",
          worktreePolicy: "dedicated-top-level",
          inputMode: "orchestrated"
        }
      },
      { kind: "add-node", node: worker }
    ]);
    expect(() => patch(run, context, [], "patch:over-budget")).toThrow(
      /maxGraphPatches/
    );

    const admitted = admitNode({
      run,
      nodeId: "worker",
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes.worker!.stateRevision,
      context
    });
    run = markAttemptRunning({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      startedAt: context.now()
    });
    const failed = {
      outcome: "failed" as const,
      failureClass: "executor-error" as const,
      summary: "retry me"
    };
    run = submitAttemptResult({
      run,
      attemptId: admitted.attempt.attemptId,
      idempotencyKey: "result:failed",
      submissionHash: contentHash(failed),
      submission: failed,
      trusted: {},
      context
    }).run;
    const retryTimer = Object.values(run.timers).find(
      (timer) => timer.kind === "retry"
    )!;
    expect(run.graph.nodes.worker?.status).toBe("pending");
    const recovered = recoverRun(run, context);
    expect(recovered.timers[retryTimer.timerId]?.dueAt).toBe(retryTimer.dueAt);
    expect(recovered.counters.graphPatches).toBe(1);

    const early = fireDueTimers({
      run: recovered,
      observedAt: new Date(Date.parse(retryTimer.dueAt) - 1).toISOString(),
      context
    });
    expect(early.graph.nodes.worker?.status).toBe("pending");
    const due = fireDueTimers({
      run: early,
      observedAt: retryTimer.dueAt,
      context
    });
    expect(due.graph.nodes.worker?.status).toBe("ready");
    expect(due.counters.graphPatches).toBe(1);
  });
});
