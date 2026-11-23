import { describe, expect, it } from "vitest";
import {
  admitNode,
  applyGraphPatch,
  createAdaptiveRun,
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  materializeWorkflowRun,
  parseGraphPatch,
  publishWorkflowVersion,
  settleControlNode,
  startStructuredLoop,
  starterWorkflowDefinition,
  type GraphPatch,
  type InputMapping,
  type LoopNodeDefinition,
  type RuntimeContext,
  type WorkflowNodeDefinition,
  type WorkflowRun
} from "./index";

function harness(limits = LOCAL_V1_DEFAULT_RUN_LIMITS) {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => "2026-09-12T00:00:00.000Z",
    id: (kind) => `${kind}:${sequence++}`
  };
  const run = createAdaptiveRun({
    runId: "run:patch",
    objective: "Bounded work",
    limits,
    context
  });
  const command = (
    source: WorkflowRun,
    operations: GraphPatch["operations"]
  ): GraphPatch => ({
    runId: source.runId,
    expectedGraphRevision: source.graph.revision,
    authorityEpoch: source.coordinationAuthorityEpoch,
    authorPrincipal: "user:local",
    capabilityRef: "capability:patch",
    idempotencyKey: `patch:${sequence++}`,
    operations
  });
  const patch = (source: WorkflowRun, operations: GraphPatch["operations"]) =>
    applyGraphPatch(source, command(source, operations), context).run;
  const admit = (source: WorkflowRun, nodeId: string) =>
    admitNode({
      run: source,
      nodeId,
      expectedGraphRevision: source.graph.revision,
      expectedNodeStateRevision: source.graph.nodes[nodeId]!.stateRevision,
      context
    });
  const settle = (source: WorkflowRun, nodeId: string) => {
    const admitted = admit(source, nodeId);
    return settleControlNode({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      outcome: "succeeded",
      data: admitted.attempt.resolvedInputs,
      context
    });
  };
  return { run, context, command, patch, admit, settle };
}

function node(
  id: string,
  inputMappings?: InputMapping[]
): WorkflowNodeDefinition {
  return {
    id,
    kind: "end",
    title: id,
    config: { version: 1 },
    ...(inputMappings ? { inputMappings } : {})
  };
}
const mapping = (source: string, required = true): InputMapping => ({
  target: "value",
  source: { kind: "node-result", nodeId: source },
  required,
  ...(required
    ? { missing: "fail" as const }
    : { missing: "use-default" as const, default: "fallback" })
});
function loop(id = "loop", members = ["first", "last"]): LoopNodeDefinition {
  return {
    id,
    kind: "loop",
    title: id,
    completionRoot: true,
    config: {
      version: 1,
      mode: "for-each",
      maxItems: 2,
      concurrency: 1,
      collection: { kind: "literal", value: ["alpha", "beta"] },
      itemInputId: "item",
      body: {
        nodeIds: members,
        entryNodeIds: [members[0]!],
        exits: [{ nodeId: members.at(-1)!, outcome: "done" }]
      },
      completedPort: "completed",
      maxReachedPort: "max-reached",
      accumulator: {
        outputId: "receipts",
        source: { kind: "node-result", nodeId: members.at(-1)! }
      }
    }
  };
}
const addNodes = (
  ...nodes: WorkflowNodeDefinition[]
): GraphPatch["operations"] =>
  nodes.map((node) => ({ kind: "add-node", node }));

describe("adaptive graph compilation", () => {
  it("parses and applies long materialized IDs in replacements, edges and data references", () => {
    const h = harness();
    const firstId = `first-${"a".repeat(110)}`;
    const middleId = `middle-${"b".repeat(110)}`;
    const lastId = `last-${"c".repeat(110)}`;
    const container = loop("loop", [firstId, middleId, lastId]);
    let run = applyGraphPatch(
      h.run,
      parseGraphPatch(
        h.command(h.run, [
          ...addNodes(
            {
              ...container,
              config: {
                ...container.config,
                body: {
                  ...container.config.body,
                  entryNodeIds: [firstId, middleId]
                }
              }
            },
            node(firstId, [
              {
                target: "marker",
                source: { kind: "literal", value: "first" },
                required: true,
                missing: "fail"
              }
            ]),
            node(middleId),
            { ...node(lastId), joinPolicy: "all-successful" }
          ),
          {
            kind: "add-edge",
            edge: {
              id: "first-last",
              from: { nodeId: firstId },
              to: { nodeId: lastId }
            },
            expectedTargetNodeStateRevision: 0
          }
        ])
      ),
      h.context
    ).run;
    const admitted = h.admit(run, "loop");
    run = startStructuredLoop({
      run: admitted.run,
      attemptId: admitted.attempt.attemptId,
      context: h.context
    });
    const materialized = (templateId: string) =>
      Object.values(run.graph.nodes).find(
        (entry) => entry.materialization?.templateNodeId === templateId
      )!;
    const first = materialized(firstId);
    const middle = materialized(middleId);
    const last = materialized(lastId);
    for (const entry of [first, middle, last])
      expect(entry.nodeId.length).toBeGreaterThan(128);
    const patch = parseGraphPatch(
      h.command(run, [
        {
          kind: "replace-pending-node",
          node: {
            ...last.definition,
            id: last.nodeId,
            inputMappings: [mapping(first.nodeId)]
          } as WorkflowNodeDefinition,
          expectedNodeStateRevision: last.stateRevision
        },
        ...addNodes(node("consumer", [mapping(first.nodeId)])),
        {
          kind: "add-edge",
          edge: {
            id: "middle-last",
            from: { nodeId: middle.nodeId },
            to: { nodeId: last.nodeId }
          },
          expectedTargetNodeStateRevision: last.stateRevision + 1
        },
        {
          kind: "add-edge",
          edge: {
            id: "last-consumer",
            from: { nodeId: last.nodeId },
            to: { nodeId: "consumer" }
          },
          expectedTargetNodeStateRevision: 0
        }
      ])
    );
    run = applyGraphPatch(run, patch, h.context).run;
    expect(run.graph.nodes[last.nodeId]?.definition.id).toBe(lastId);
    expect(run.graph.bodyTemplates[lastId]?.inputMappings).toBeUndefined();
    run = h.settle(run, first.nodeId);
    expect(run.graph.nodes[last.nodeId]?.status).toBe("pending");
    run = h.settle(run, middle.nodeId);
    run = h.settle(run, last.nodeId);
    run = h.settle(run, "consumer");
    expect(run.results[last.nodeId]?.data).toEqual({
      value: { marker: "first" }
    });
    expect(run.results.consumer?.data).toEqual({ value: { marker: "first" } });
    expect(applyGraphPatch(run, patch, h.context).run).toBe(run);
  });

  it.each([
    "new-id",
    "oversize-reference",
    "invalid-reference",
    "invalid-config"
  ] as const)(
    "preserves the %s boundary while accepting expanded references",
    (variant) => {
      const h = harness();
      const identifier =
        variant === "oversize-reference"
          ? "n".repeat(32_769)
          : variant === "invalid-reference"
            ? "node:invalid name"
            : "n".repeat(150);
      const definition = {
        ...node(identifier),
        title: "Reference validation",
        ...(variant === "invalid-config" ? { config: { version: 2 } } : {})
      };
      const operation =
        variant === "new-id"
          ? { kind: "add-node", node: definition }
          : {
              kind: "replace-pending-node",
              node: definition,
              expectedNodeStateRevision: 0
            };
      expect(() =>
        parseGraphPatch({ ...h.command(h.run, []), operations: [operation] })
      ).toThrow();
    }
  );

  it.each(["loop", "after-loop", "iteration-output"])(
    "rejects a body waiting for %s completion",
    (sourceId) => {
      const h = harness();
      const definition = loop("loop", ["body"]);
      const outputDependency = sourceId === "iteration-output";
      expect(() =>
        h.patch(h.run, [
          ...addNodes(
            outputDependency
              ? ({
                  ...definition,
                  config: {
                    ...definition.config,
                    accumulator: {
                      outputId: "receipts",
                      source: { kind: "node-result", nodeId: "after-loop" }
                    }
                  }
                } as LoopNodeDefinition)
              : definition,
            node("body", outputDependency ? [] : [mapping(sourceId)]),
            node("after-loop")
          ),
          {
            kind: "add-edge",
            edge: {
              id: "done",
              from: { nodeId: "loop", port: "completed" },
              to: { nodeId: "after-loop" }
            },
            expectedTargetNodeStateRevision: 0
          }
        ])
      ).toThrow(/cycle/u);
      expect(h.run.graph.nodes).toEqual({});
    }
  );

  it.each(["saved", "adaptive"] as const)(
    "uses the same iteration materializer for a %s Loop and scoped data",
    (sourceKind) => {
      const h = harness();
      const definitions = [
        { ...node("start"), kind: "start" as const },
        loop(),
        node("first", [
          {
            target: "item",
            source: { kind: "loop-item", loopNodeId: "loop" },
            required: true,
            missing: "fail"
          }
        ]),
        node("last", [mapping("first")]),
        {
          ...node("end"),
          joinPolicy: "all-successful" as const,
          completionRoot: true
        }
      ];
      const edges = [
        { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
        { id: "first-last", from: { nodeId: "first" }, to: { nodeId: "last" } },
        {
          id: "done",
          from: { nodeId: "loop", port: "completed" },
          to: { nodeId: "end" }
        },
        {
          id: "maximum",
          from: { nodeId: "loop", port: "max-reached" },
          to: { nodeId: "end" }
        }
      ];
      let run: WorkflowRun;
      let originalPatch: GraphPatch | undefined;
      if (sourceKind === "saved") {
        run = materializeWorkflowRun({
          runId: h.run.runId,
          context: h.context,
          inputs: {},
          version: publishWorkflowVersion({
            workflowVersionId: "version:loop",
            publishedAt: h.context.now(),
            definition: {
              ...starterWorkflowDefinition({
                definitionId: "loop",
                name: "Loop"
              }),
              nodes: definitions,
              edges
            }
          })
        });
      } else {
        originalPatch = h.command(h.run, [
          ...addNodes(...definitions),
          ...edges.map((edge) => ({
            kind: "add-edge" as const,
            edge,
            expectedTargetNodeStateRevision: edge.id === "maximum" ? 1 : 0
          }))
        ]);
        run = applyGraphPatch(h.run, originalPatch, h.context).run;
      }
      expect(Object.keys(run.graph.nodes)).toEqual(["start", "loop", "end"]);
      expect(Object.keys(run.graph.bodyTemplates)).toEqual(["first", "last"]);
      expect(run.counters.nodes).toBe(3);
      expect(run.counters.edges).toBe(3);
      run = h.settle(run, "start");
      const admitted = h.admit(run, "loop");
      run = startStructuredLoop({
        run: admitted.run,
        attemptId: admitted.attempt.attemptId,
        context: h.context
      });
      if (originalPatch) {
        expect(applyGraphPatch(run, originalPatch, h.context).run).toBe(run);
        const pending = Object.values(run.graph.nodes).find(
          (entry) => entry.materialization?.templateNodeId === "last"
        )!;
        const replace = (
          definition: WorkflowNodeDefinition
        ): GraphPatch["operations"] => [
          {
            kind: "replace-pending-node",
            node: { ...definition, id: pending.nodeId },
            expectedNodeStateRevision: pending.stateRevision
          }
        ];
        expect(() =>
          h.patch(run, replace(node("last", [mapping("loop")])))
        ).toThrow(/cycle/u);
        expect(() =>
          h.patch(
            run,
            replace({
              id: "last",
              kind: "condition",
              title: "Invalid exit replacement",
              config: {
                version: 1,
                expressionVersion: 1,
                expression: "true",
                ports: ["different"]
              }
            })
          )
        ).toThrow(/Loop exit port/u);
        run = h.patch(
          run,
          replace({
            ...node("last", [mapping("first")]),
            title: "First iteration correction"
          })
        );
        expect(run.graph.nodes[pending.nodeId]?.definition.id).toBe("last");
        expect(run.graph.bodyTemplates.last?.title).toBe("last");
        // Subsequent authoring retains the active Loop's templates and history.
        run = h.patch(run, addNodes(node("follow-up")));
        run = h.settle(run, "follow-up");
      }
      for (const item of ["alpha", "beta"]) {
        const first = Object.values(run.graph.nodes).find(
          (entry) =>
            entry.materialization?.templateNodeId === "first" &&
            entry.status === "ready"
        )!;
        run = h.settle(run, first.nodeId);
        const last = Object.values(run.graph.nodes).find(
          (entry) =>
            entry.materialization?.templateNodeId === "last" &&
            entry.status === "ready"
        )!;
        run = h.settle(run, last.nodeId);
        expect(run.results[last.nodeId]?.data).toEqual({ value: { item } });
      }
      expect(run.graph.nodes.loop).toMatchObject({
        status: "succeeded",
        loopState: { iteration: 2 }
      });
      expect(run.results.loop?.data).toMatchObject({
        accumulated: [{ value: { item: "alpha" } }, { value: { item: "beta" } }]
      });
      expect(
        Object.values(run.graph.nodes).filter((entry) => entry.materialization)
      ).toHaveLength(4);
      expect(run.counters.loopIterations).toBe(2);
      run = h.settle(run, "end");
      if (sourceKind === "saved") expect(run.status).toBe("succeeded");
    }
  );

  it.each(["missing", "self", "multiple-owner", "cross-scope"] as const)(
    "rejects %s Loop structure atomically",
    (variant) => {
      const h = harness();
      const body = variant === "self" ? "loop" : "body";
      const operations = [
        ...addNodes(
          loop("loop", [body]),
          ...(variant === "missing" || variant === "self" ? [] : [node(body)])
        ),
        ...(variant === "multiple-owner"
          ? addNodes(loop("other", [body]))
          : []),
        ...(variant === "cross-scope"
          ? [
              ...addNodes(node("outside")),
              {
                kind: "add-edge" as const,
                edge: {
                  id: "escape",
                  from: { nodeId: body },
                  to: { nodeId: "outside" }
                },
                expectedTargetNodeStateRevision: 0
              }
            ]
          : [])
      ];
      const before = JSON.stringify(h.run);
      expect(() => h.patch(h.run, operations)).toThrow();
      expect(JSON.stringify(h.run)).toBe(before);
    }
  );

  it("requires a pending node's explicit revision before moving it into a Loop", () => {
    const h = harness();
    const body = node("body", [mapping("producer")]);
    const source = h.patch(h.run, addNodes(node("producer"), body));
    expect(source.graph.nodes.body?.status).toBe("pending");
    expect(() => h.patch(source, addNodes(loop("loop", ["body"])))).toThrow(
      /expected state revision/u
    );
    expect(() =>
      h.patch(source, [
        ...addNodes(loop("loop", ["body"])),
        {
          kind: "replace-pending-node",
          node: body,
          expectedNodeStateRevision: 99
        }
      ])
    ).toThrow(/revision/u);
    const updated = h.patch(source, [
      ...addNodes(loop("loop", ["body"])),
      {
        kind: "replace-pending-node",
        node: body,
        expectedNodeStateRevision: source.graph.nodes.body!.stateRevision
      }
    ]);
    expect(updated.graph.bodyTemplates.body).toEqual(body);
    expect(updated.graph.nodes.body).toBeUndefined();
    // Already accepted nodes remain counted; authoring cannot reset a budget.
    expect(updated.counters.nodes).toBe(3);
    expect(() => h.patch(updated, addNodes(node("body")))).toThrow(
      /already exists/u
    );
  });

  it("never converts eligible or settled work into a future Loop template", () => {
    const h = harness();
    const ready = h.patch(h.run, addNodes(node("body")));
    for (const source of [ready, h.settle(ready, "body")]) {
      expect(() => h.patch(source, addNodes(loop("loop", ["body"])))).toThrow(
        /unstarted pending node/u
      );
      expect(source.graph.nodes.body?.attemptIds.length).toBe(
        source === ready ? 0 : 1
      );
    }
  });

  it.each(["required-cycle", "loop-entry-cycle", "depth", "fan-out"] as const)(
    "enforces %s across required data dependencies",
    (variant) => {
      const h = harness({
        ...LOCAL_V1_DEFAULT_RUN_LIMITS,
        maxGraphDepth: variant === "depth" ? 2 : 32,
        maxFanOut: variant === "fan-out" ? 1 : 16
      });
      const nodes =
        variant === "required-cycle"
          ? [node("a", [mapping("b")]), node("b", [mapping("a")])]
          : variant === "loop-entry-cycle"
            ? [
                {
                  ...loop("loop", ["body"]),
                  config: {
                    ...loop("loop", ["body"]).config,
                    collection: { kind: "node-result" as const, nodeId: "body" }
                  }
                } as LoopNodeDefinition,
                node("body")
              ]
            : [
                node("a"),
                node("b", [mapping("a")]),
                node("c", [mapping(variant === "depth" ? "b" : "a")])
              ];
      expect(() => h.patch(h.run, addNodes(...nodes))).toThrow(
        variant === "depth"
          ? /maxGraphDepth/u
          : variant === "fan-out"
            ? /maxFanOut/u
            : /cycle/u
      );
      expect(h.run.graph.patches).toEqual([]);
      expect(h.run.graph.nodes).toEqual({});
    }
  );

  it("resolves optional defaults without introducing a required dependency cycle", () => {
    const h = harness();
    let run = h.patch(
      h.run,
      addNodes(
        node("a", [mapping("b", false)]),
        node("b", [mapping("a", false)])
      )
    );
    expect(run.graph.nodes.a?.status).toBe("ready");
    expect(run.graph.nodes.b?.status).toBe("ready");
    run = h.settle(run, "a");
    expect(run.results.a?.data).toEqual({ value: "fallback" });
  });
});
