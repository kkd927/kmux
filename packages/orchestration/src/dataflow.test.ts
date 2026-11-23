import { expect, it } from "vitest";
import {
  admitNode,
  contentHash,
  markAttemptRunning,
  submitAttemptResult,
  computeRequiredReachability,
  failNodeAdmission,
  materializeWorkflowRun,
  OrchestrationError,
  publishWorkflowVersion,
  recoverRun,
  settleControlNode,
  startStructuredLoop,
  starterWorkflowDefinition,
  type DataSource,
  type AgentBindingDefinition,
  type RepositoryStateRef,
  type InputMapping,
  type LoopNodeDefinition,
  type RuntimeContext,
  type WorkflowControlEdge,
  type WorkflowNodeDefinition,
  type WorkflowRun
} from "./index";

function inputLoop(
  mode: "while" | "for-each",
  source: DataSource
): LoopNodeDefinition {
  const shared = {
    version: 1 as const,
    body: {
      nodeIds: ["body"],
      entryNodeIds: ["body"],
      exits: [
        { nodeId: "body", outcome: "done" },
        { nodeId: "body", port: "failure", outcome: "continue" }
      ]
    },
    completedPort: "completed",
    maxReachedPort: "max-reached"
  };
  return {
    id: "loop",
    kind: "loop",
    title: "Input-dependent Loop",
    config:
      mode === "for-each"
        ? {
            ...shared,
            mode,
            collection: source,
            maxItems: 2,
            concurrency: 1,
            itemInputId: "item"
          }
        : {
            ...shared,
            mode,
            maxIterations: 2,
            repeatOutcome: "continue",
            completedOutcomes: ["done"],
            carry: [
              {
                inputId: "value",
                initial: source,
                next: { kind: "literal", value: "done" }
              }
            ]
          }
  };
}

it("preserves an explicit null Run input across materialization and recovery instead of applying its default", () => {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => "2026-09-12T00:00:00.000Z",
    id: (kind) => `${kind}:${sequence++}`
  };
  const definition = {
    ...starterWorkflowDefinition({
      definitionId: "nullable",
      name: "Nullable input"
    }),
    inputs: [
      {
        id: "value",
        required: true,
        default: "fallback",
        schema: { schema: { type: ["string", "null"] } }
      }
    ],
    outputs: [
      {
        id: "value",
        required: true,
        source: { kind: "run-input" as const, inputId: "value" }
      }
    ]
  };
  let run = recoverRun(
    materializeWorkflowRun({
      runId: "run:nullable",
      version: publishWorkflowVersion({
        definition,
        workflowVersionId: "version:nullable",
        publishedAt: context.now()
      }),
      inputs: { value: null },
      context
    }),
    context
  );
  for (const nodeId of ["start", "end"]) {
    const admitted = admitNode({
      run,
      nodeId,
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes[nodeId]!.stateRevision,
      context
    });
    run = settleControlNode({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      outcome: "succeeded",
      context
    });
  }
  expect(run.status).toBe("succeeded");
  expect(run.outputs).toEqual({ value: null });
});

it.each(["while", "for-each"] as const)(
  "waits for a %s Loop's entry data before admission",
  (mode) => {
    const loop = inputLoop(mode, { kind: "node-result", nodeId: "producer" });
    const { run, admit, context } = workflow(
      [loop, shell("body"), shell("producer")],
      [
        edge("start", "loop"),
        edge("start", "producer"),
        edge("loop", "end", "completed"),
        { ...edge("loop", "end", "max-reached"), id: "maximum:end" }
      ],
      []
    );
    expect(run.graph.nodes.loop).toMatchObject({
      status: "pending",
      attemptIds: []
    });
    expect(
      computeRequiredReachability(run).requiredNodeIds.has("producer")
    ).toBe(true);
    const producer = admit(run, "producer");
    const ready = settleControlNode({
      run: producer.run,
      attemptId: producer.attempt.attemptId,
      outcome: "succeeded",
      selectedPort: "done",
      data: mode === "for-each" ? ["seed"] : "seed",
      context
    });
    expect(ready.graph.nodes.loop?.status).toBe("ready");
    const admitted = admit(ready, "loop");
    expect(admitted.attempt.resolvedInputs).toEqual({});
    const started = startStructuredLoop({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      context
    });
    expect(started.graph.nodes.loop?.loopState).toMatchObject(
      mode === "for-each"
        ? { frozenItems: ["seed"] }
        : { carry: { value: "seed" } }
    );
  }
);

it.each(["while", "for-each"] as const)(
  "fails missing %s Loop entry data before creating an attempt",
  (mode) => {
    const { run } = workflow(
      [
        inputLoop(mode, { kind: "run-input", inputId: "optionalValue" }),
        shell("body")
      ],
      [
        edge("start", "loop"),
        edge("loop", "end", "completed"),
        { ...edge("loop", "end", "max-reached"), id: "maximum:end" }
      ],
      []
    );
    expect(run.graph.nodes.loop).toMatchObject({
      status: "failed",
      attemptIds: [],
      admissionFailure: {
        class: "input-mapping",
        mappingTarget:
          mode === "for-each"
            ? "config.collection"
            : "config.carry.value.initial"
      }
    });
    expect(run.status).toBe("failed");
  }
);

it.each([
  [[], "succeeded", "completed"],
  [[1, 2, 3], "succeeded", "max-reached"],
  [false, "failed", "failure"]
] as const)(
  "propagates immediate collection settlement for %j without an executor wake",
  (collection, status, port) => {
    const { run, admit, settle, context } = workflow(
      [
        inputLoop("for-each", {
          kind: "literal",
          value: collection === false ? false : [...collection]
        }),
        shell("body")
      ],
      [
        edge("start", "loop"),
        edge("loop", "end", "completed"),
        { ...edge("loop", "end", "max-reached"), id: "maximum:end" }
      ],
      []
    );
    const admitted = admit(run, "loop");
    const ended = startStructuredLoop({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      context
    });
    expect(ended.graph.nodes.loop).toMatchObject({
      status,
      selectedPort: port
    });
    expect(
      Object.values(ended.graph.nodes).filter((node) => node.materialization)
    ).toHaveLength(0);
    expect(ended.counters.activeAttempts).toBe(0);
    if (status === "failed") expect(ended.status).toBe("failed");
    else {
      expect(ended.graph.nodes.end?.status).toBe("ready");
      expect(settle(ended, "end").status).toBe("succeeded");
    }
  }
);

for (const mode of ["while", "for-each"] as const) {
  it.each([false, true])(
    `waits for scoped ${mode} output and rejects missing data: %s`,
    (missingOutput) => {
      const base = inputLoop(mode, {
        kind: "literal",
        value: mode === "while" ? "seed" : ["item"]
      });
      const outputSource: DataSource = {
        kind: "node-result",
        nodeId: "producer",
        path: ["value"]
      };
      const body = {
        ...base.config.body,
        nodeIds: ["body", "producer"],
        entryNodeIds: ["body", "producer"]
      };
      const loop: LoopNodeDefinition = {
        ...base,
        config:
          base.config.mode === "while"
            ? {
                ...base.config,
                body,
                carry: [
                  {
                    inputId: "value",
                    initial: { kind: "literal", value: "seed" },
                    next: outputSource
                  }
                ]
              }
            : {
                ...base.config,
                body,
                accumulator: { outputId: "values", source: outputSource }
              }
      };
      const { run, admit, settle, context } = workflow(
        [loop, shell("body"), shell("producer")],
        [
          edge("start", "loop"),
          edge("loop", "end", "completed"),
          { ...edge("loop", "end", "max-reached"), id: "maximum:end" }
        ],
        [
          {
            target: "value",
            required: true,
            missing: "fail",
            source: {
              kind: "node-result",
              nodeId: "loop",
              path: mode === "while" ? ["carry", "value"] : ["accumulated"]
            }
          }
        ]
      );
      const admitted = admit(run, "loop");
      const started = startStructuredLoop({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        context
      });
      const bodyNode = Object.values(started.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "body"
      )!;
      const producerNode = Object.values(started.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "producer"
      )!;
      const waiting = settle(started, bodyNode.nodeId);
      expect(waiting.graph.nodes.loop).toMatchObject({
        status: "running",
        loopState: { completedIterationIds: [] }
      });
      expect(waiting.graph.nodes.end?.status).toBe("pending");
      const producer = admit(waiting, producerNode.nodeId);
      const completed = settleControlNode({
        run: producer.run,
        attemptId: producer.attempt.attemptId,
        outcome: "succeeded",
        data: missingOutput ? {} : { value: null },
        context
      });
      if (missingOutput) {
        expect(completed.graph.nodes.loop?.status).toBe("failed");
        expect(completed.results.loop?.data).toMatchObject({
          mappingTarget:
            mode === "while"
              ? "config.carry.value.next"
              : "config.accumulator.source"
        });
        expect(completed.status).toBe("failed");
      } else {
        expect(completed.graph.nodes.loop?.status).toBe("succeeded");
        expect(settle(completed, "end").outputs).toEqual({
          value: mode === "while" ? null : [null]
        });
      }
    }
  );
}

it("exposes the latest carry at an ungated while iteration maximum", () => {
  const base = inputLoop("while", { kind: "literal", value: "seed" });
  if (base.config.mode !== "while") throw new Error("while fixture required");
  const loop: LoopNodeDefinition = {
    ...base,
    config: {
      ...base.config,
      maxIterations: 1,
      repeatOutcome: "done",
      completedOutcomes: ["continue"]
    }
  };
  const { run, admit, settle, context } = workflow(
    [loop, shell("body")],
    [
      edge("start", "loop"),
      edge("loop", "end", "completed"),
      { ...edge("loop", "end", "max-reached"), id: "maximum:end" }
    ],
    [
      {
        target: "value",
        required: true,
        missing: "fail",
        source: {
          kind: "node-result",
          nodeId: "loop",
          path: ["carry", "value"]
        }
      }
    ]
  );
  const admitted = admit(run, "loop");
  const started = startStructuredLoop({
    run: admitted.run,
    attemptId: admitted.attempt.attemptId,
    context
  });
  const body = Object.values(started.graph.nodes).find(
    (node) => node.materialization?.templateNodeId === "body"
  )!;
  const maximum = settle(started, body.nodeId);
  expect(maximum.graph.nodes.loop).toMatchObject({
    status: "succeeded",
    selectedPort: "max-reached"
  });
  expect(settle(maximum, "end").outputs).toEqual({ value: "done" });
});

it.each([
  [true, false, "from-input"],
  [false, false, "from-input"],
  [true, true, "from-input"],
  [false, false, "current"]
] as const)(
  "admits binding worktree inputs (receipt=%s, repeated target=%s, policy=%s)",
  (withReceipt, repeatedTarget, policy) => {
    let serial = 0;
    const context: RuntimeContext = {
      now: () => "2026-10-15T00:00:00.000Z",
      id: (kind) => `${kind}:${++serial}`
    };
    const binding: AgentBindingDefinition = {
      agent: { kind: "agent-id", agentId: "codex" },
      scope: { kind: "run" },
      authorityMode: "ambient",
      targetPolicy: "local",
      surfacePolicy: "create",
      sessionPolicy: "fresh",
      worktreePolicy: "current",
      inputMode: "orchestrated"
    };
    const node = (id: string): WorkflowNodeDefinition => ({
      id,
      kind: "agent",
      title: id,
      config: {
        version: 1,
        agentRef: id,
        prompt: id,
        lifecycleMode: "managed",
        coding: false
      }
    });
    const base = starterWorkflowDefinition({
      definitionId: "binding-input",
      name: "Binding input"
    });
    const definition = {
      ...base,
      agentBindings: {
        producer: binding,
        worker: {
          ...binding,
          worktreePolicy: policy,
          worktreeInput: {
            target: "worktree",
            source: { kind: "repository-state" as const, nodeId: "producer" },
            required: true,
            missing: "fail" as const
          }
        }
      },
      nodes: [
        ...base.nodes,
        {
          ...node("worker"),
          ...(repeatedTarget
            ? {
                inputMappings: [
                  {
                    target: "worktree",
                    source: {
                      kind: "literal" as const,
                      value: "untrusted-node-override"
                    },
                    required: true,
                    missing: "fail" as const
                  }
                ]
              }
            : {})
        },
        node("producer")
      ],
      edges: [
        edge("start", "producer"),
        edge("start", "worker"),
        edge("worker", "end")
      ]
    };
    let run = materializeWorkflowRun({
      runId: "run:binding",
      version: publishWorkflowVersion({
        definition,
        workflowVersionId: "version:binding",
        publishedAt: context.now()
      }),
      inputs: {},
      context
    });
    const admit = (nodeId: string) =>
      admitNode({
        run,
        nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: run.graph.nodes[nodeId]!.stateRevision,
        context
      });
    const start = admit("start");
    run = settleControlNode({
      run: start.run,
      attemptId: start.attempt.attemptId,
      outcome: "succeeded",
      context
    });
    expect(run.graph.nodes.worker).toMatchObject({
      status: policy === "from-input" ? "pending" : "ready",
      attemptIds: []
    });
    expect(
      computeRequiredReachability(run).requiredNodeIds.has("producer")
    ).toBe(policy === "from-input");
    const producer = admit("producer");
    run = markAttemptRunning({
      run: producer.run,
      attemptId: producer.attempt.attemptId,
      startedAt: context.now()
    });
    const receipt: RepositoryStateRef = {
      targetId: "local",
      repositoryId: "repo",
      worktreeRef: {
        targetId: "local",
        worktreeId: "worktree",
        pathToken: "trusted-path"
      },
      headOid: "head",
      capturedAt: context.now(),
      consistency: "fenced-live-worktree"
    };
    const submission = { outcome: "succeeded" as const, summary: "Prepared" };
    run = submitAttemptResult({
      run,
      attemptId: producer.attempt.attemptId,
      idempotencyKey: "prepared",
      submissionHash: contentHash(submission),
      submission,
      trusted: withReceipt ? { repositoryState: receipt } : {},
      context
    }).run;
    if (withReceipt || policy === "current") {
      const worker = admit("worker");
      expect(worker.attempt.resolvedInputs).toEqual(
        policy === "from-input" ? { worktree: receipt } : {}
      );
    } else {
      expect(run.graph.nodes.worker).toMatchObject({
        status: "failed",
        attemptIds: [],
        admissionFailure: { mappingTarget: "worktree" }
      });
      expect(
        Object.values(run.dispatches).filter(
          (dispatch) => dispatch.nodeId === "worker"
        )
      ).toHaveLength(0);
    }
  }
);

const edge = (
  from: string,
  to: string,
  port?: string
): WorkflowControlEdge => ({
  id: `${from}:${to}`,
  from: { nodeId: from, ...(port ? { port } : {}) },
  to: { nodeId: to }
});
const outcome = (nodeId: string, path?: string[]): InputMapping => ({
  target: path ? "detail" : nodeId,
  source: { kind: "node-outcome", nodeId, ...(path ? { path } : {}) },
  required: true,
  missing: "fail"
});
const shell = (
  id: string,
  inputMappings: InputMapping[] = []
): WorkflowNodeDefinition => ({
  id,
  kind: "shell",
  title: id,
  onFailure: "skip-descendants",
  inputMappings,
  config: {
    version: 1,
    command: { kind: "structured", executable: "/usr/bin/true", args: [] },
    targetPolicy: "local",
    surfacePolicy: "create",
    cwdPolicy: "workspace",
    resultMode: "exit-code",
    maxOutputBytes: 1024
  }
});
const missing: InputMapping = {
  target: "requiredValue",
  source: { kind: "run-input", inputId: "optionalValue" },
  required: true,
  missing: "fail"
};

function workflow(
  nodes: WorkflowNodeDefinition[],
  edges: WorkflowControlEdge[],
  mappings: InputMapping[]
) {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => new Date(1_800_000_000_000 + sequence++).toISOString(),
    id: (kind) => `${kind}:${sequence++}`
  };
  const base = starterWorkflowDefinition({
    definitionId: "outcomes",
    name: "Outcomes"
  });
  const definition = {
    ...base,
    inputs: [{ id: "optionalValue", required: false }],
    // A consumer may precede its dependencies in the canonical node array.
    nodes: [
      ...base.nodes.map((node) =>
        node.kind === "end"
          ? {
              ...node,
              joinPolicy: "all-settled" as const,
              inputMappings: mappings
            }
          : node
      ),
      ...nodes
    ],
    edges,
    outputs: mappings.map((mapping) => ({
      id: mapping.target,
      required: mapping.required,
      source: mapping.source
    }))
  };
  const initial = materializeWorkflowRun({
    runId: "run:outcomes",
    version: publishWorkflowVersion({
      definition,
      workflowVersionId: "version:outcomes",
      publishedAt: context.now()
    }),
    inputs: {},
    context
  });
  const admit = (run: WorkflowRun, nodeId: string) =>
    admitNode({
      run,
      nodeId,
      expectedGraphRevision: run.graph.revision,
      expectedNodeStateRevision: run.graph.nodes[nodeId]!.stateRevision,
      context
    });
  const settle = (run: WorkflowRun, nodeId: string, selectedPort?: string) => {
    const admitted = admit(run, nodeId);
    return settleControlNode({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      outcome: "succeeded",
      selectedPort,
      context
    });
  };
  return { run: settle(initial, "start"), admit, settle, context };
}

it.each(["mapping", "admission"] as const)(
  "maps %s failure receipts without creating an attempt or ordinary result",
  (failure) => {
    const mappings = [
      outcome("blocked"),
      outcome(
        "blocked",
        failure === "mapping"
          ? ["admissionFailure", "mappingTarget"]
          : ["admissionFailure", "details", "limit.name"]
      )
    ];
    const {
      run: started,
      admit,
      settle,
      context
    } = workflow(
      [shell("blocked", failure === "mapping" ? [missing] : [])],
      [edge("start", "blocked"), edge("blocked", "end", "failure")],
      mappings
    );
    const run =
      failure === "mapping"
        ? started
        : failNodeAdmission({
            run: started,
            nodeId: "blocked",
            error: new OrchestrationError(
              "budget-exhausted",
              "Dispatch budget exhausted",
              { "limit.name": "maxDispatches" }
            ),
            context
          });
    expect(run.graph.nodes.blocked).toMatchObject({
      status: "failed",
      attemptIds: []
    });
    expect(run.results.blocked).toBeUndefined();
    expect(run.graph.nodes.end?.status).toBe("ready");
    const recovered = recoverRun(run, context);
    const inputs = admit(recovered, "end").attempt.resolvedInputs;
    expect(inputs.blocked).toMatchObject({
      outcome: "failed",
      admissionFailure: run.graph.nodes.blocked!.admissionFailure
    });
    expect(inputs.detail).toBe(
      failure === "mapping" ? "requiredValue" : "maxDispatches"
    );
    const done = settle(recovered, "end");
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual(inputs);
  }
);

it("maps a skipped branch's provenance while ordinary success mappings use their declared default", () => {
  const { run, admit, settle } = workflow(
    [
      {
        id: "choice",
        kind: "condition",
        title: "Choice",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "true",
          ports: ["selected", "other"]
        }
      },
      shell("skipped")
    ],
    [
      edge("start", "choice"),
      edge("choice", "end", "selected"),
      edge("choice", "skipped", "other"),
      edge("skipped", "end")
    ],
    [
      outcome("skipped"),
      {
        target: "result",
        source: { kind: "node-result", nodeId: "skipped" },
        required: false,
        missing: "use-default",
        default: "unavailable"
      }
    ]
  );
  const selected = settle(run, "choice", "selected");
  expect(selected.graph.nodes.skipped).toMatchObject({
    status: "skipped",
    attemptIds: []
  });
  expect(selected.results.skipped).toBeUndefined();
  expect(admit(selected, "end").attempt.resolvedInputs).toEqual({
    skipped: {
      outcome: "skipped",
      summary: "node skipped",
      skipProvenance: { sourceNodeId: "choice", selectedPort: "selected" }
    },
    result: "unavailable"
  });
});

it("makes an unsatisfied join's typed outcome available to a declared failure handler regardless of array order", () => {
  const { run, admit, settle } = workflow(
    [
      {
        ...shell("race"),
        joinPolicy: "any-successful",
        anySuccessfulDisposition: "wait"
      },
      shell("a", [missing]),
      shell("b", [missing])
    ],
    [
      edge("start", "a"),
      edge("start", "b"),
      edge("a", "race", "success"),
      edge("b", "race", "success"),
      edge("race", "end", "failure")
    ],
    [outcome("race"), outcome("race", ["joinResolution", "outcome"])]
  );
  expect(run.graph.nodes.race).toMatchObject({
    status: "failed",
    attemptIds: []
  });
  expect(run.results.race).toBeUndefined();
  expect(admit(run, "end").attempt.resolvedInputs).toMatchObject({
    race: {
      outcome: "failed",
      joinResolution: {
        policy: "any-successful",
        outcome: "unsatisfied",
        selectedPredecessors: ["a", "b"],
        version: 1
      }
    },
    detail: "unsatisfied"
  });
  expect(settle(run, "end").status).toBe("succeeded");
});

it.each(["while", "for-each"] as const)(
  "advances a %s Loop after an unstarted body failure and maps its scoped outcome",
  (mode) => {
    const body = {
      nodeIds: ["body"],
      entryNodeIds: ["body"],
      exits: [
        { nodeId: "body", port: "failure", outcome: "handled" },
        { nodeId: "body", port: "success", outcome: "continue" }
      ]
    };
    const loop: LoopNodeDefinition = {
      id: "loop",
      kind: "loop",
      title: "Handle body outcomes",
      config:
        mode === "while"
          ? {
              version: 1,
              mode,
              body,
              maxIterations: 2,
              repeatOutcome: "continue",
              completedOutcomes: ["handled"],
              completedPort: "completed",
              maxReachedPort: "max-reached",
              carry: [
                {
                  inputId: "receipt",
                  initial: { kind: "literal", value: null },
                  next: { kind: "node-outcome", nodeId: "body" }
                }
              ]
            }
          : {
              version: 1,
              mode,
              body,
              maxItems: 2,
              concurrency: 1,
              collection: { kind: "literal", value: ["first", "second"] },
              itemInputId: "item",
              completedPort: "completed",
              maxReachedPort: "max-reached",
              accumulator: {
                outputId: "receipts",
                source: { kind: "node-outcome", nodeId: "body" }
              }
            }
    };
    const { run, admit, settle, context } = workflow(
      [loop, shell("body", [missing])],
      [
        edge("start", "loop"),
        edge("loop", "end", "completed"),
        { ...edge("loop", "end", "max-reached"), id: "loop:max:end" }
      ],
      [
        {
          target: "receipt",
          source: {
            kind: "node-result",
            nodeId: "loop",
            path: mode === "while" ? ["carry", "receipt"] : ["accumulated"]
          },
          required: true,
          missing: "fail"
        }
      ]
    );
    const admitted = admit(run, "loop");
    const handled = startStructuredLoop({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      context
    });
    expect(handled.graph.nodes.loop?.status).toBe("succeeded");
    const bodyNodes = Object.values(handled.graph.nodes).filter(
      (node) => node.materialization?.templateNodeId === "body"
    );
    expect(bodyNodes).toHaveLength(mode === "while" ? 1 : 2);
    for (const node of bodyNodes) {
      expect(node).toMatchObject({ status: "failed", attemptIds: [] });
      expect(handled.results[node.nodeId]).toBeUndefined();
    }
    const receipt = {
      outcome: "failed",
      admissionFailure: {
        class: "input-mapping",
        mappingTarget: "requiredValue"
      }
    };
    expect(admit(handled, "end").attempt.resolvedInputs.receipt).toMatchObject(
      mode === "while" ? receipt : [receipt, receipt]
    );
    expect(settle(handled, "end").status).toBe("succeeded");
  }
);
