import Ajv from "ajv";
import document from "../fixtures/caller-review.workflow.json";
import canonicalSchema from "../schema/canonical-workflow-v1.schema.json";
import {
  acknowledgeMailboxDelivery,
  admitNode,
  checkpointRunForHostShutdown,
  claimMailboxDelivery,
  compileFlowEditorDocument,
  contentHash,
  coordinatorMailboxConsumer,
  isCallerNode,
  markAttemptRunning,
  openHumanGate,
  resolveHumanGate,
  materializeWorkflowRun,
  publishWorkflowVersion,
  recoverRun,
  selectWorkflowConditionPort,
  settleControlNode,
  startCallerTask,
  startStructuredLoop,
  submitAttemptResult,
  submitCallerTaskResult,
  validateWorkflowDefinition,
  type AgentResultSubmission,
  type JsonValue,
  type RuntimeContext,
  type WorkflowRun
} from "./index";

const attachment = {
  transport: "terminal" as const,
  surfaceId: "caller-surface",
  sessionId: "caller-session",
  execution: {
    targetId: "local",
    targetAuthority: "desktop:test",
    surfaceId: "caller-surface",
    sessionId: "caller-session",
    generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
    inputAuthorityRef: "unclaimed"
  },
  process: { pid: 23, startedAt: "original-process" }
};
const compiled = compileFlowEditorDocument(document as unknown as JsonValue);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
const definition = compiled.value;
function setup(withCaller = true, value = definition) {
  let serial = 0;
  const context: RuntimeContext = {
    now: () => "2026-10-05T00:00:00.000Z",
    id: (kind) => `${kind}:${++serial}`
  };
  const checked = validateWorkflowDefinition(value);
  if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
  const version = publishWorkflowVersion({
    definition: value,
    workflowVersionId: "version",
    publishedAt: context.now()
  });
  const run = materializeWorkflowRun({
    runId: "run",
    version,
    inputs: {
      task: "Review",
      implementationResult: {
        summary: "Implemented",
        changedFiles: ["work.ts"],
        tests: []
      }
    },
    ...(withCaller ? { callerAttachment: attachment } : {}),
    context
  });
  return { run, context };
}
function advance(source: WorkflowRun, context: RuntimeContext): WorkflowRun {
  let run = source;
  for (let guard = 0; guard < 40; guard++) {
    const node = Object.values(run.graph.nodes).find(
      (node) => node.status === "ready"
    );
    if (!node) return run;
    const admitted = admitNode({
      run,
      nodeId: node.nodeId,
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: node.stateRevision,
      context
    });
    run = admitted.run;
    if (node.definition.kind === "agent") {
      run = isCallerNode(run, node)
        ? startCallerTask({
            run,
            attemptId: admitted.attempt.attemptId,
            repositoryIdentity: "repository",
            context
          })
        : markAttemptRunning({
            run,
            attemptId: admitted.attempt.attemptId,
            startedAt: context.now()
          });
    } else if (node.definition.kind === "human-gate")
      run = openHumanGate({
        run,
        attemptId: admitted.attempt.attemptId,
        context
      }).run;
    else if (node.definition.kind === "loop")
      run = startStructuredLoop({
        run,
        attemptId: admitted.attempt.attemptId,
        context
      });
    else
      run = settleControlNode({
        run,
        attemptId: admitted.attempt.attemptId,
        outcome: "succeeded",
        ...(node.definition.kind === "condition"
          ? {
              selectedPort: selectWorkflowConditionPort({
                config: node.definition.config,
                inputs: admitted.attempt.resolvedInputs,
                values: {}
              })
            }
          : {}),
        context
      });
  }
  throw new Error("Driver did not quiesce");
}
function finishReview(
  source: WorkflowRun,
  agentId: string,
  count: number,
  context: RuntimeContext
) {
  const dispatch = Object.values(source.dispatches).find(
    (dispatch) =>
      dispatch.selectedAgentId === agentId &&
      source.attempts[dispatch.attemptId].status === "running"
  )!;
  const submission: AgentResultSubmission = {
    outcome: "succeeded",
    summary: "Review complete",
    data: {
      blockerCount: count,
      blockers: count
        ? [
            {
              title: "Blocker",
              file: "work.ts",
              evidence: "Missing guard",
              reasoning: "Invalid state"
            }
          ]
        : [],
      review: `${agentId} full report`
    }
  };
  return submitAttemptResult({
    run: source,
    attemptId: dispatch.attemptId,
    idempotencyKey: dispatch.attemptId,
    submissionHash: contentHash(submission as unknown as JsonValue),
    submission,
    trusted: {},
    context
  }).run;
}
const fix: AgentResultSubmission = {
  outcome: "succeeded",
  summary: "Fact-checked and fixed",
  data: {
    factCheck: "Confirmed source evidence",
    changes: ["Added guard"],
    tests: ["passed"],
    remainingBlockers: 0
  }
};
function acknowledge(source: WorkflowRun, context: RuntimeContext) {
  const claimed = claimMailboxDelivery({
    run: source,
    consumer: coordinatorMailboxConsumer(source),
    context
  });
  return acknowledgeMailboxDelivery({
    run: claimed.run,
    consumer: coordinatorMailboxConsumer(source),
    deliveryId: claimed.delivery!.deliveryId,
    context
  });
}

describe("existing calling Agent Workflow", () => {
  it("rejects missing caller before admission and accepts caller in both schema consumers", () => {
    expect(() => setup(false)).toThrow(/requires a calling Agent/);
    expect(
      new Ajv({ strict: false }).compile(canonicalSchema)(definition)
    ).toBe(true);
    const bad = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.kind === "agent" && node.config.agentRef === "calling-agent"
          ? { ...node, config: { ...node.config, launch: { model: "other" } } }
          : node
      )
    };
    expect(validateWorkflowDefinition(bad)).toMatchObject({ ok: false });
  });
  it("waits for both reviews and exits cleanly without calling the original Agent", () => {
    const { run: initial, context } = setup();
    let run = advance(initial, context);
    run = advance(finishReview(run, "codex", 0, context), context);
    expect(
      Object.values(run.attempts).some((attempt) => attempt.callerTask)
    ).toBe(false);
    expect(run.status).toBe("running");
    run = advance(finishReview(run, "antigravity", 0, context), context);
    expect(run.status).toBe("succeeded");
    expect(run.outputs?.reviewResult).toMatchObject({
      iterations: 1,
      outcome: "clean"
    });
    expect(Object.values(run.dispatches)).toHaveLength(2);
  });
  it("delivers both full reviews, survives restart and requires ack plus a typed idempotent completion", () => {
    const { run: initial, context } = setup();
    let run = advance(initial, context);
    run = advance(finishReview(run, "codex", 1, context), context);
    expect(
      Object.values(run.attempts).some((attempt) => attempt.callerTask)
    ).toBe(false);
    run = advance(finishReview(run, "antigravity", 0, context), context);
    const attempt = Object.values(run.attempts).find(
      (attempt) => attempt.callerTask
    )!;
    const requestId = attempt.callerTask!.requestId;
    expect(attempt.resolvedInputs).toMatchObject({
      codexReview: { blockerCount: 1, review: "codex full report" },
      antigravityReview: { blockerCount: 0, review: "antigravity full report" }
    });
    expect(Object.values(run.dispatches)).toHaveLength(2);
    expect(() =>
      submitCallerTaskResult({
        run,
        attemptId: attempt.attemptId,
        requestId,
        submission: fix,
        context
      })
    ).toThrow(/acknowledge/);
    const pending = claimMailboxDelivery({
      run,
      consumer: coordinatorMailboxConsumer(run),
      context
    });
    run = recoverRun(checkpointRunForHostShutdown(pending.run), context);
    expect(run.status).toBe("running");
    const replay = claimMailboxDelivery({
      run,
      consumer: coordinatorMailboxConsumer(run),
      context
    });
    expect(replay.delivery?.deliveryId).toBe(pending.delivery?.deliveryId);
    run = acknowledge(run, context);
    expect(run.attempts[attempt.attemptId].status).toBe("waiting-input");
    expect(() =>
      submitCallerTaskResult({
        run,
        attemptId: attempt.attemptId,
        requestId,
        submission: { ...fix, data: {} },
        context
      })
    ).toThrow(/schema/);
    expect(() =>
      submitCallerTaskResult({
        run,
        attemptId: attempt.attemptId,
        requestId: "stale",
        submission: fix,
        context
      })
    ).toThrow(/stale/);
    const result = submitCallerTaskResult({
      run,
      attemptId: attempt.attemptId,
      requestId,
      submission: fix,
      context
    });
    expect(
      submitCallerTaskResult({
        run: result.run,
        attemptId: attempt.attemptId,
        requestId,
        submission: fix,
        context
      }).receipt
    ).toEqual(result.receipt);
    expect(() =>
      submitCallerTaskResult({
        run: result.run,
        attemptId: attempt.attemptId,
        requestId,
        submission: { ...fix, summary: "changed" },
        context
      })
    ).toThrow(/different content/);
    run = advance(result.run, context);
    expect(
      new Set(
        Object.values(run.dispatches).map(
          (dispatch) => dispatch.bindingInstanceKey
        )
      ).size
    ).toBe(4);
    run = advance(finishReview(run, "codex", 0, context), context);
    run = advance(finishReview(run, "antigravity", 0, context), context);
    expect(run.outputs?.reviewResult).toMatchObject({
      iterations: 2,
      outcome: "clean"
    });
  });
  it.each([0, 1])(
    "reviews the second fix and routes final blocker count %s without another fix",
    (finalBlockers) => {
      const { run: initial, context } = setup();
      let run = advance(initial, context);
      for (let round = 0; round < 2; round++) {
        run = advance(finishReview(run, "codex", 0, context), context);
        run = advance(finishReview(run, "antigravity", 1, context), context);
        const attempt = Object.values(run.attempts).find(
          (attempt) => attempt.callerTask?.state === "waiting"
        )!;
        run = acknowledge(run, context);
        run = advance(
          submitCallerTaskResult({
            run,
            attemptId: attempt.attemptId,
            requestId: attempt.callerTask!.requestId,
            submission: fix,
            context
          }).run,
          context
        );
      }
      // Two fixes must not complete the Workflow before the third review.
      expect(Object.values(run.dispatches)).toHaveLength(6);
      expect(run.status).toBe("running");
      run = advance(finishReview(run, "codex", 0, context), context);
      run = advance(
        finishReview(run, "antigravity", finalBlockers, context),
        context
      );
      expect(run.status).toBe(finalBlockers ? "waiting-gate" : "succeeded");
      if (finalBlockers) {
        const gate = Object.values(run.gates).find(
          (gate) => gate.state === "open"
        )!;
        run = advance(
          resolveHumanGate({
            run,
            gateId: gate.gateId,
            resolution: "stop",
            principal: "user:local",
            context
          }),
          context
        );
      }
      expect(run.outputs?.reviewResult).toMatchObject({
        iterations: 3,
        outcome: finalBlockers ? "max-reached" : "clean"
      });
      expect(Object.values(run.dispatches)).toHaveLength(6);
      expect(
        Object.values(run.attempts).filter((attempt) => attempt.callerTask)
      ).toHaveLength(2);
    }
  );
});

it("preserves the exact enclosing nested Loop attempts while the caller waits", () => {
  const outer = {
    id: "outer",
    kind: "loop" as const,
    title: "Outer",
    config: {
      version: 1 as const,
      mode: "while" as const,
      maxIterations: 1,
      body: {
        nodeIds: ["loop:6b2b2949"],
        entryNodeIds: ["loop:6b2b2949"],
        exits: [
          {
            nodeId: "loop:6b2b2949",
            port: "completed",
            outcome: "done",
            action: "break" as const
          },
          {
            nodeId: "loop:6b2b2949",
            port: "max-reached",
            outcome: "limit",
            action: "break" as const
          }
        ]
      },
      repeatOutcome: "continue",
      completedOutcomes: ["done", "limit"],
      completedPort: "completed",
      maxReachedPort: "completed",
      loopOutputs: [
        {
          name: "innerResult",
          source: { kind: "node-result" as const, nodeId: "loop:6b2b2949" },
          mode: "last" as const
        }
      ]
    }
  };
  const value = {
    ...definition,
    nodes: [
      ...definition.nodes.filter((node) => node.id !== "gate:unresolved"),
      outer
    ],
    edges: [
      ...definition.edges.filter(
        (edge) =>
          edge.from.nodeId !== "start" &&
          edge.from.nodeId !== "loop:6b2b2949" &&
          edge.from.nodeId !== "gate:unresolved"
      ),
      { id: "start-outer", from: { nodeId: "start" }, to: { nodeId: "outer" } },
      {
        id: "outer-end",
        from: { nodeId: "outer", port: "completed" },
        to: { nodeId: "end" }
      }
    ],
    outputs: [
      {
        id: "reviewResult",
        required: true,
        source: { kind: "node-result" as const, nodeId: "outer" }
      }
    ],
    policies: {
      ...definition.policies,
      limits: { ...definition.policies.limits, maxLoopIterations: 3 }
    }
  };
  const { run: initial, context } = setup(true, value);
  let run = advance(initial, context);
  run = advance(finishReview(run, "codex", 1, context), context);
  run = advance(finishReview(run, "antigravity", 0, context), context);
  run = recoverRun(checkpointRunForHostShutdown(run), context);
  expect(
    Object.values(run.attempts)
      .filter(
        (attempt) => run.graph.nodes[attempt.nodeId].definition.kind === "loop"
      )
      .map((attempt) => attempt.status)
  ).toEqual(["running", "running"]);
  const attempt = Object.values(run.attempts).find(
    (attempt) => attempt.callerTask
  )!;
  run = acknowledge(run, context);
  run = advance(
    submitCallerTaskResult({
      run,
      attemptId: attempt.attemptId,
      requestId: attempt.callerTask!.requestId,
      submission: fix,
      context
    }).run,
    context
  );
  run = advance(finishReview(run, "codex", 0, context), context);
  run = advance(finishReview(run, "antigravity", 0, context), context);
  expect(run.status).toBe("succeeded");
  expect(run.outputs?.reviewResult).toMatchObject({
    innerResult: { iterations: 2, outcome: "clean" }
  });
});
