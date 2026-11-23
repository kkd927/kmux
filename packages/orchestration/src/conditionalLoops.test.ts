import Ajv from "ajv";
import canonicalSchema from "../schema/canonical-workflow-v1.schema.json";
import {
  admitNode,
  materializeWorkflowRun,
  publishWorkflowVersion,
  selectWorkflowConditionPort,
  settleControlNode,
  startStructuredLoop,
  starterWorkflowDefinition,
  validateWorkflowDefinition,
  type JsonValue,
  type RuntimeContext,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "./index";

function fixture(
  mode: "while" | "for-each",
  concurrency = 1
): WorkflowDefinitionV1 {
  const base = starterWorkflowDefinition({
    definitionId: "conditional-loop",
    name: "Conditional loop"
  });
  return {
    ...base,
    nodes: [
      base.nodes[0]!,
      {
        id: "loop",
        kind: "loop",
        title: "Review rounds",
        config: {
          version: 1,
          ...(mode === "while"
            ? {
                mode,
                maxIterations: 3,
                repeatOutcome: "continue",
                completedOutcomes: []
              }
            : {
                mode,
                collection: { kind: "literal", value: [1, 2, 3, 4, 5] },
                maxItems: 5,
                concurrency,
                itemInputId: "item"
              }),
          completedPort: "completed",
          maxReachedPort: "limit",
          body: {
            nodeIds: ["review", "condition", "break", "continue"],
            entryNodeIds: ["review"],
            exits: [
              { nodeId: "break", outcome: "stop", action: "break" },
              { nodeId: "continue", outcome: "continue", action: "continue" }
            ]
          },
          loopOutputs: [
            {
              name: "latestReview",
              source: { kind: "node-result", nodeId: "review" },
              mode: "last"
            },
            {
              name: "counts",
              source: {
                kind: "node-result",
                nodeId: "review",
                path: ["blockerCount"]
              },
              mode: "collect"
            }
          ]
        }
      },
      {
        id: "review",
        kind: "shell",
        title: "Review",
        inputMappings: [
          {
            target: "index",
            source: { kind: "loop-index", loopNodeId: "loop" },
            required: true,
            missing: "fail"
          }
        ],
        resultSchema: {
          schema: {
            type: "object",
            properties: { blockerCount: { type: "integer" } },
            required: ["blockerCount"]
          }
        },
        config: {
          version: 1,
          command: { kind: "structured", executable: "fixture", args: [] },
          targetPolicy: "local",
          surfacePolicy: "create",
          cwdPolicy: "workspace",
          resultMode: "json-stdout",
          maxOutputBytes: 1024
        }
      },
      {
        id: "condition",
        kind: "condition",
        title: "Blockers",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "false",
          ports: ["clean", "else"],
          conditions: [
            {
              key: "clean",
              left: {
                kind: "node-result",
                nodeId: "review",
                path: ["blockerCount"]
              },
              operator: "eq",
              right: { kind: "literal", value: 0 }
            }
          ]
        }
      },
      { id: "break", kind: "break", title: "Break", config: { version: 1 } },
      {
        id: "continue",
        kind: "continue",
        title: "Continue",
        config: { version: 1 }
      },
      base.nodes[1]!,
      { ...base.nodes[1]!, id: "limit" }
    ],
    edges: [
      { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
      {
        id: "review-condition",
        from: { nodeId: "review" },
        to: { nodeId: "condition" }
      },
      {
        id: "condition-break",
        from: { nodeId: "condition", port: "clean" },
        to: { nodeId: "break" }
      },
      {
        id: "condition-continue",
        from: { nodeId: "condition", port: "else" },
        to: { nodeId: "continue" }
      },
      {
        id: "loop-end",
        from: { nodeId: "loop", port: "completed" },
        to: { nodeId: "end" }
      },
      {
        id: "loop-limit",
        from: { nodeId: "loop", port: "limit" },
        to: { nodeId: "limit" }
      }
    ]
  } as WorkflowDefinitionV1;
}

function context(): RuntimeContext {
  let sequence = 0;
  return {
    now: () => "2026-10-04T00:00:00.000Z",
    id: (kind) => `${kind}:${++sequence}`
  };
}
function step(
  run: WorkflowRun,
  nodeId: string,
  ctx: RuntimeContext,
  data?: JsonValue
): WorkflowRun {
  const admitted = admitNode({
    run,
    nodeId,
    expectedGraphRevision: run.graph.revision,
    expectedNodeStateRevision: run.graph.nodes[nodeId]!.stateRevision,
    context: ctx
  });
  const node = admitted.run.graph.nodes[nodeId]!;
  return node.definition.kind === "loop"
    ? startStructuredLoop({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        context: ctx
      })
    : settleControlNode({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        outcome: "succeeded",
        data,
        ...(node.definition.kind === "condition"
          ? {
              selectedPort: selectWorkflowConditionPort({
                config: node.definition.config,
                inputs: admitted.attempt.resolvedInputs,
                values: {}
              })
            }
          : {}),
        context: ctx
      });
}
function initial(
  mode: "while" | "for-each",
  ctx: RuntimeContext,
  concurrency = 1
): WorkflowRun {
  const version = publishWorkflowVersion({
    definition: fixture(mode, concurrency),
    workflowVersionId: "version",
    publishedAt: ctx.now()
  });
  return step(
    step(
      materializeWorkflowRun({
        version,
        runId: "run",
        inputs: {},
        context: ctx
      }),
      "start",
      ctx
    ),
    "loop",
    ctx
  );
}
function iteration(
  run: WorkflowRun,
  index: number,
  blockers: number,
  ctx: RuntimeContext
): WorkflowRun {
  const find = (kind: string) =>
    Object.values(run.graph.nodes).find(
      (node) =>
        node.materialization?.iteration === index &&
        node.materialization.templateNodeId === kind
    )!.nodeId;
  const review = find("review");
  run = step(run, review, ctx, { blockerCount: blockers });
  expect(
    run.attempts[run.graph.nodes[review]!.attemptIds[0]!]!.resolvedInputs.index
  ).toBe(index);
  run = step(run, find("condition"), ctx);
  return step(run, find(blockers === 0 ? "break" : "continue"), ctx);
}

describe("Flowgram conditional Loop contracts", () => {
  it("resolves nested Workflow input and Loop carry fields for the admitted condition", () => {
    const base = fixture("while");
    const definition: WorkflowDefinitionV1 = {
      ...base,
      inputs: [{ id: "request", required: true }],
      nodes: base.nodes.map((node) =>
        node.kind === "loop" && node.config.mode === "while"
          ? {
              ...node,
              config: {
                ...node.config,
                carry: [
                  {
                    inputId: "threshold",
                    initial: { kind: "literal", value: { value: 0 } },
                    next: { kind: "literal", value: { value: 0 } }
                  }
                ]
              }
            }
          : node.kind === "condition"
            ? {
                ...node,
                config: {
                  ...node.config,
                  conditions: [
                    {
                      key: "clean",
                      left: {
                        kind: "run-input",
                        inputId: "request",
                        path: ["review", "blockerCount"]
                      },
                      operator: "eq",
                      right: {
                        kind: "loop-carry",
                        loopNodeId: "loop",
                        inputId: "threshold",
                        path: ["value"]
                      }
                    }
                  ]
                }
              }
            : node
      )
    };
    const validate = new Ajv({ strict: false }).compile(canonicalSchema);
    expect(validate(definition), JSON.stringify(validate.errors)).toBe(true);
    const ctx = context();
    const version = publishWorkflowVersion({
      definition,
      workflowVersionId: "nested-fields",
      publishedAt: ctx.now()
    });
    let run = step(
      step(
        materializeWorkflowRun({
          version,
          runId: "nested-fields",
          inputs: { request: { review: { blockerCount: 0 } } },
          context: ctx
        }),
        "start",
        ctx
      ),
      "loop",
      ctx
    );
    const find = (id: string) =>
      Object.values(run.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === id
      )!.nodeId;
    run = step(run, find("review"), ctx, { blockerCount: 0 });
    const conditionId = find("condition");
    run = step(run, conditionId, ctx);
    expect(
      run.attempts[run.graph.nodes[conditionId]!.attemptIds[0]!]!.resolvedInputs
    ).toEqual({ "condition.clean.left": 0, "condition.clean.right": 0 });
    run = step(run, find("break"), ctx);
    expect(run.graph.nodes.loop?.selectedPort).toBe("completed");
  });
  it.each(["while", "for-each"] as const)(
    "publishes %s through both schemas and preserves the final review on Break",
    (mode) => {
      const definition = fixture(mode);
      const validate = new Ajv({ strict: false }).compile(canonicalSchema);
      expect(validate(definition), JSON.stringify(validate.errors)).toBe(true);
      expect(validateWorkflowDefinition(definition)).toMatchObject({
        ok: true
      });
      const ctx = context();
      let run = iteration(initial(mode, ctx), 0, 4, ctx);
      // Serialize between iterations: current-round references must survive restoration.
      run = iteration(JSON.parse(JSON.stringify(run)), 1, 0, ctx);
      expect(run.graph.nodes.loop).toMatchObject({
        status: "succeeded",
        selectedPort: "completed",
        loopState: { iteration: 2, outcome: "break" }
      });
      expect(run.results.loop?.data).toMatchObject({
        latestReview: { blockerCount: 0 },
        counts: [4, 0]
      });
      expect(
        Object.values(run.graph.nodes).filter(
          (node) => node.materialization?.templateNodeId === "review"
        )
      ).toHaveLength(2);
    }
  );

  it("routes to the iteration limit after exactly three unsuccessful reviews", () => {
    const ctx = context();
    let run = initial("while", ctx);
    for (let index = 0; index < 3; index++) run = iteration(run, index, 2, ctx);
    expect(run.graph.nodes.loop).toMatchObject({
      selectedPort: "limit",
      loopState: { iteration: 3, outcome: "max-reached" }
    });
    expect(run.results.loop?.data).toMatchObject({ counts: [2, 2, 2] });
  });

  it("drains already started array items after Break and keeps output order", () => {
    const ctx = context();
    let run = initial("for-each", ctx, 3);
    run = iteration(run, 1, 0, ctx);
    expect(run.graph.nodes.loop?.status).toBe("running");
    run = iteration(run, 2, 7, ctx);
    run = iteration(run, 0, 4, ctx);
    expect(run.graph.nodes.loop).toMatchObject({
      status: "succeeded",
      loopState: { iteration: 3 }
    });
    expect(run.results.loop?.data).toMatchObject({ counts: [4, 0, 7] });
  });

  it("fails a missing review field instead of interpreting it as zero blockers", () => {
    const ctx = context();
    let run = initial("while", ctx);
    const review = Object.values(run.graph.nodes).find(
      (node) => node.materialization?.templateNodeId === "review"
    )!;
    run = step(run, review.nodeId, ctx, {});
    expect(
      Object.values(run.graph.nodes).find(
        (node) => node.materialization?.templateNodeId === "condition"
      )
    ).toMatchObject({
      status: "failed",
      admissionFailure: { class: "input-mapping" }
    });
  });

  it("selects the first matching branch and rejects incompatible numeric operands", () => {
    const config = fixture("while").nodes.find(
      (node) => node.kind === "condition"
    )!.config;
    if (!("conditions" in config)) throw new Error("Expected Condition");
    const multiple = {
      ...config,
      conditions: [
        ...config.conditions!,
        { ...config.conditions![0]!, key: "another" }
      ],
      ports: ["clean", "another", "else"]
    };
    expect(
      selectWorkflowConditionPort({
        config: multiple,
        inputs: {
          "condition.clean.left": 0,
          "condition.clean.right": 0,
          "condition.another.left": 0,
          "condition.another.right": 0
        },
        values: {}
      })
    ).toBe("clean");
    expect(() =>
      selectWorkflowConditionPort({
        config,
        inputs: { "condition.clean.left": "0", "condition.clean.right": 0 },
        values: {}
      })
    ).toThrow("incompatible");
  });

  it("evaluates the typed array and boolean operators offered by Flowgram", () => {
    const original = fixture("while").nodes.find(
      (node) => node.kind === "condition"
    )!;
    if (original.kind !== "condition") throw new Error("Expected Condition");
    const evaluate = (
      operator: NonNullable<
        typeof original.config.conditions
      >[number]["operator"],
      left: JsonValue,
      right?: JsonValue
    ) =>
      selectWorkflowConditionPort({
        config: {
          ...original.config,
          conditions: [{ ...original.config.conditions![0]!, operator }]
        },
        inputs: {
          "condition.clean.left": left,
          ...(right === undefined ? {} : { "condition.clean.right": right })
        },
        values: {}
      });
    expect(evaluate("contains", [{ id: 1 }, 2], [{ id: 1 }])).toBe("clean");
    expect(evaluate("not_contains", [1, 2], [3])).toBe("clean");
    expect(evaluate("eq", [{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe("clean");
    expect(evaluate("neq", [1, 2], [2, 1])).toBe("clean");
    expect(evaluate("is_false", false)).toBe("clean");
    expect(evaluate("is_empty", {})).toBe("clean");
    expect(evaluate("in", 2, [1, 2])).toBe("clean");
    expect(evaluate("nin", "a", ["b"])).toBe("clean");
  });

  it("rejects unresolved condition variables and nonterminal Loop control nodes at publication", () => {
    const valid = fixture("while");
    const invalidReference = {
      ...valid,
      nodes: valid.nodes.map((node) =>
        node.kind === "condition"
          ? {
              ...node,
              config: {
                ...node.config,
                conditions: [
                  {
                    ...node.config.conditions![0]!,
                    left: { kind: "node-result", nodeId: "missing" }
                  }
                ]
              }
            }
          : node
      )
    };
    expect(validateWorkflowDefinition(invalidReference)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_node" })
      ])
    });
    const invalidEdge = {
      ...valid,
      edges: [
        ...valid.edges,
        {
          id: "break-forward",
          from: { nodeId: "break" },
          to: { nodeId: "continue" }
        }
      ]
    };
    expect(validateWorkflowDefinition(invalidEdge)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_loop_control_edge" })
      ])
    });
  });
});
