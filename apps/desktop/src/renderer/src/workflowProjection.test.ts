import { nestedReviewWorkflow } from "../../../../../packages/orchestration/fixtures/nested-review";
import {
  canonicalJson,
  initializeFlowEditorDocument,
  starterWorkflowDefinition
} from "@kmux/orchestration";

import {
  LOOP_END_ANCHOR_TYPE,
  LOOP_START_ANCHOR_TYPE,
  compileEditorCanonical,
  sameWorkflowExecution,
  sameWorkflowLayout,
  createStudioNode,
  loopAnchorId,
  mergeFlowgramDocument,
  removeStudioNode,
  replaceAgentSelector,
  replaceNodeDefinition,
  toFlowgramDocument
} from "./workflowProjection";

describe("Workflow Studio FlowGram projection", () => {
  it("reuses execution versions across JSON key ordering but detects changed node behavior", () => {
    const base = starterWorkflowDefinition({
      definitionId: "repeat",
      name: "Repeat"
    });
    const reordered = {
      ...base,
      version: 4,
      policies: {
        cancellation: base.policies.cancellation,
        failure: base.policies.failure,
        limits: base.policies.limits
      }
    };
    expect(sameWorkflowExecution(base, reordered)).toBe(true);
    expect(
      sameWorkflowExecution(base, {
        ...base,
        nodes: base.nodes.map((node) => ({ ...node, title: "Changed" }))
      })
    ).toBe(false);
  });

  it("preserves the saved layout when deciding whether an execution version can be reused", () => {
    const document = initializeFlowEditorDocument(
      starterWorkflowDefinition({ definitionId: "layout", name: "Layout" })
    );
    expect(sameWorkflowLayout(document, structuredClone(document))).toBe(true);
    expect(
      sameWorkflowLayout(document, {
        ...document,
        nodes: document.nodes.map((entry) => ({
          ...entry,
          position: { y: entry.position.y, x: entry.position.x }
        }))
      })
    ).toBe(true);

    const moved = {
      ...document,
      nodes: document.nodes.map((entry) => ({
        ...entry,
        position: { x: entry.position.x + 10, y: entry.position.y }
      }))
    };
    expect(sameWorkflowLayout(document, moved)).toBe(false);
  });

  it("assigns distinct outcomes to new End connections and preserves them on reopening", () => {
    const base = starterWorkflowDefinition({
      definitionId: "loop-end-branches",
      name: "Loop End branches"
    });
    const loop = createStudioNode("loop", "loop");
    const tasks = [
      createStudioNode("shell", "first"),
      createStudioNode("shell", "second")
    ];
    const editor = initializeFlowEditorDocument({
      ...base,
      nodes: [...base.nodes, loop, ...tasks]
    });
    const flow = toFlowgramDocument(editor);
    const container = flow.nodes.find((node) => node.id === loop.id)!;
    container.blocks!.splice(
      1,
      0,
      ...flow.nodes.filter((node) => tasks.some((task) => task.id === node.id))
    );
    flow.nodes = flow.nodes.filter(
      (node) => !tasks.some((task) => task.id === node.id)
    );
    for (const task of tasks)
      container.edges!.push({
        sourceNodeID: task.id,
        targetNodeID: loopAnchorId(loop.id, "end")
      });
    const connected = mergeFlowgramDocument(flow, editor);
    const config = connected.nodes.find((entry) => entry.id === loop.id)!
      .definition.config;
    expect(config).toMatchObject({
      body: {
        exits: [
          { nodeId: "first", outcome: "continue", action: "continue" },
          { nodeId: "second", outcome: "continue-2", action: "continue" }
        ]
      }
    });
    expect(
      compileEditorCanonical(
        mergeFlowgramDocument(toFlowgramDocument(connected), connected)
      )
    ).toEqual(compileEditorCanonical(connected));
  });
  it("preserves the authored outcome names of Break and Continue exits", () => {
    const base = starterWorkflowDefinition({
      definitionId: "loop-controls",
      name: "Loop controls"
    });
    const loop = createStudioNode("loop", "loop");
    if (loop.kind !== "loop" || loop.config.mode !== "while")
      throw new Error("Expected while Loop");
    const exits = [
      { nodeId: "stop", outcome: "clean", action: "break" as const },
      { nodeId: "again", outcome: "review-again", action: "continue" as const }
    ];
    const editor = initializeFlowEditorDocument({
      ...base,
      nodes: [
        ...base.nodes,
        {
          ...loop,
          config: {
            ...loop.config,
            repeatOutcome: "review-again",
            completedOutcomes: ["clean"],
            body: {
              nodeIds: ["stop", "again"],
              entryNodeIds: ["stop", "again"],
              exits
            }
          }
        },
        createStudioNode("break", "stop"),
        createStudioNode("continue", "again")
      ]
    });
    const merged = mergeFlowgramDocument(toFlowgramDocument(editor), editor);
    expect(
      merged.nodes.find((node) => node.id === "loop")?.definition.config
    ).toMatchObject({ body: { exits } });
  });
  it("removes only the connections owned by a removed Condition branch", () => {
    const base = starterWorkflowDefinition({
      definitionId: "branches",
      name: "Branches"
    });
    const node = createStudioNode("condition", "condition");
    const loop = createStudioNode("loop", "loop");
    if (node.kind !== "condition" || loop.kind !== "loop")
      throw new Error("Expected structured nodes");
    const editor = initializeFlowEditorDocument({
      ...base,
      nodes: [
        ...base.nodes,
        node,
        {
          ...loop,
          config: {
            ...loop.config,
            body: {
              nodeIds: [node.id],
              entryNodeIds: [node.id],
              exits: [
                { nodeId: node.id, port: "if_1", outcome: "stop" },
                { nodeId: node.id, port: "else", outcome: "continue" }
              ]
            }
          }
        }
      ],
      edges: [
        {
          id: "removed",
          from: { nodeId: node.id, port: "if_1" },
          to: { nodeId: "end" }
        },
        {
          id: "kept",
          from: { nodeId: node.id, port: "else" },
          to: { nodeId: "end" }
        }
      ]
    });
    const updated = replaceNodeDefinition(editor, {
      ...node,
      config: {
        ...node.config,
        conditions: [{ ...node.config.conditions![0]!, key: "new" }],
        ports: ["new", "else"]
      }
    });
    expect(updated.edges.map((edge) => edge.id)).toEqual(["kept"]);
    expect(
      updated.nodes.find((entry) => entry.id === loop.id)?.definition.config
    ).toMatchObject({
      body: { exits: [{ nodeId: node.id, port: "else", outcome: "continue" }] }
    });
  });
  it("round-trips canonical nodes, edges, ports, and canvas positions", () => {
    const definition = starterWorkflowDefinition({
      definitionId: "workflow:projection",
      name: "Projection"
    });
    const editor = initializeFlowEditorDocument(definition);
    const flow = toFlowgramDocument(editor);
    flow.nodes[0]!.meta!.position = { x: 42, y: 84 };
    const merged = mergeFlowgramDocument(flow, editor);

    expect(merged.nodes[0]?.position).toEqual({ x: 42, y: 84 });
    expect(compileEditorCanonical(merged)).toEqual(definition);
  });

  it("projects structured Loop bodies as nested FlowGram sub-canvases", () => {
    const definition = nestedReviewWorkflow();
    expect(definition).toBeDefined();
    if (!definition) return;

    const editor = initializeFlowEditorDocument(definition);
    const flow = toFlowgramDocument(editor);
    const items = flow.nodes.find((node) => node.id === "items");
    const reviewRounds = items?.blocks?.find(
      (node) => node.id === "review-rounds"
    );

    expect(flow.nodes.some((node) => node.id === "prepare-worktree")).toBe(
      false
    );
    expect(
      items?.blocks
        ?.filter((node) => node.data?.projectionOnly !== true)
        .map((node) => node.id)
    ).toEqual([
      "prepare-worktree",
      "analyze-fix",
      "review-rounds",
      "commit-change",
      "finalize"
    ]);
    expect(
      reviewRounds?.blocks
        ?.filter((node) => node.data?.projectionOnly !== true)
        .map((node) => node.id)
    ).toEqual([
      "review-regression",
      "review-side-effects",
      "review-test-security",
      "synthesize-fix",
      "review-result",
      "review-limit"
    ]);
    expect(items?.blocks?.at(0)).toMatchObject({
      id: loopAnchorId("items", "start"),
      type: LOOP_START_ANCHOR_TYPE,
      data: { projectionOnly: true }
    });
    expect(items?.blocks?.at(-1)).toMatchObject({
      id: loopAnchorId("items", "end"),
      type: LOOP_END_ANCHOR_TYPE,
      data: { projectionOnly: true }
    });
    expect(reviewRounds?.blocks?.at(0)).toMatchObject({
      id: loopAnchorId("review-rounds", "start"),
      type: LOOP_START_ANCHOR_TYPE,
      data: { projectionOnly: true }
    });
    expect(reviewRounds?.blocks?.at(-1)).toMatchObject({
      id: loopAnchorId("review-rounds", "end"),
      type: LOOP_END_ANCHOR_TYPE,
      data: { projectionOnly: true }
    });
    expect(items?.edges?.map((edge) => edge.data?.edgeId)).toContain(
      "prepare-analyze"
    );
    expect(reviewRounds?.edges?.map((edge) => edge.data?.edgeId)).toContain(
      "synthesis-result"
    );
    expect(reviewRounds?.edges?.map((edge) => edge.data?.edgeId)).toContain(
      "presentation:max-gate:review-rounds"
    );
    expect(reviewRounds?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeID: loopAnchorId("review-rounds", "start"),
          targetNodeID: "review-regression",
          data: expect.objectContaining({ projectionOnly: true })
        }),
        expect.objectContaining({
          sourceNodeID: loopAnchorId("review-rounds", "start"),
          targetNodeID: "review-side-effects",
          data: expect.objectContaining({ projectionOnly: true })
        }),
        expect.objectContaining({
          sourceNodeID: "review-result",
          sourcePortID: "clean",
          targetNodeID: loopAnchorId("review-rounds", "end"),
          data: expect.objectContaining({ projectionOnly: true })
        })
      ])
    );

    const merged = mergeFlowgramDocument(flow, editor);
    expect(canonicalJson(compileEditorCanonical(merged) as never)).toBe(
      canonicalJson(definition as never)
    );
  });

  it("preserves success and failure exits that share a task's visible output", () => {
    const task = createStudioNode("shell", "task");
    const loop = createStudioNode("loop", "loop");
    if (loop.kind !== "loop" || loop.config.mode !== "while")
      throw new Error("Expected while Loop");
    const definition = {
      ...starterWorkflowDefinition({
        definitionId: "workflow:exits",
        name: "Exits"
      }),
      nodes: [
        task,
        {
          ...loop,
          config: {
            ...loop.config,
            body: {
              nodeIds: [task.id],
              entryNodeIds: [task.id],
              exits: [
                { nodeId: task.id, port: "success", outcome: "continue" },
                { nodeId: task.id, port: "failure", outcome: "clean" }
              ]
            }
          }
        }
      ],
      edges: []
    };
    const editor = initializeFlowEditorDocument(definition);
    const flow = toFlowgramDocument(editor);
    expect(
      flow.nodes[0]!.edges!.filter(
        (edge) => edge.targetNodeID === loopAnchorId(loop.id, "end")
      )
    ).toHaveLength(1);
    expect(compileEditorCanonical(mergeFlowgramDocument(flow, editor))).toEqual(
      definition
    );
  });

  it("prunes nested Loop bodies without deleting a shared author binding", () => {
    const definition = nestedReviewWorkflow();
    expect(definition).toBeDefined();
    if (!definition) return;

    const editor = initializeFlowEditorDocument(definition);
    const pruned = removeStudioNode(editor, "review-rounds");
    const items = pruned.nodes.find((entry) => entry.id === "items");

    expect(pruned.nodes.some((entry) => entry.id === "review-rounds")).toBe(
      false
    );
    expect(pruned.nodes.some((entry) => entry.id === "review-regression")).toBe(
      false
    );
    expect(pruned.nodes.some((entry) => entry.id === "review-limit")).toBe(
      false
    );
    expect(
      items?.definition.kind === "loop"
        ? items.definition.config.body.nodeIds
        : []
    ).not.toContain("review-rounds");
    expect(pruned.workflow.agentBindings.author).toBeDefined();
    expect(pruned.workflow.agentBindings["reviewer-a"]).toBeUndefined();
    expect(pruned.workflow.agentBindings["reviewer-b"]).toBeUndefined();
    expect(pruned.workflow.inputs.map((input) => input.id)).toContain(
      "authorAgent"
    );
    expect(
      pruned.edges.some(
        (edge) =>
          edge.from.nodeId === "review-rounds" ||
          edge.to.nodeId === "review-rounds"
      )
    ).toBe(false);
  });

  it("merges FlowGram container drag changes back into structured Loop bodies", () => {
    const definition = nestedReviewWorkflow();
    expect(definition).toBeDefined();
    if (!definition) return;

    const editor = initializeFlowEditorDocument(definition);
    const flow = toFlowgramDocument(editor);
    const items = flow.nodes.find((node) => node.id === "items");
    const fetched = flow.nodes.find((node) => node.id === "load-items");
    const prepared = items?.blocks?.find(
      (node) => node.id === "prepare-worktree"
    );
    expect(items).toBeDefined();
    expect(fetched).toBeDefined();
    expect(prepared).toBeDefined();
    if (!items || !fetched || !prepared) return;

    flow.nodes = flow.nodes.filter((node) => node.id !== "load-items");
    flow.nodes.push(prepared);
    items.blocks = [
      ...(items.blocks ?? []).filter((node) => node.id !== "prepare-worktree"),
      fetched
    ];

    items.edges!.push({
      sourceNodeID: loopAnchorId("items", "start"),
      targetNodeID: "load-items"
    });
    const merged = mergeFlowgramDocument(flow, editor);
    const mergedTickets = merged.nodes.find((entry) => entry.id === "items");
    expect(
      mergedTickets?.definition.kind === "loop"
        ? mergedTickets.definition.config.body.nodeIds
        : []
    ).toContain("load-items");
    expect(
      mergedTickets?.definition.kind === "loop"
        ? mergedTickets.definition.config.body.entryNodeIds
        : []
    ).toContain("load-items");
    expect(
      mergedTickets?.definition.kind === "loop"
        ? mergedTickets.definition.config.body.nodeIds
        : []
    ).not.toContain("prepare-worktree");
  });
  it("authors and removes Loop entry and exit connections without leaking anchors into canonical edges", () => {
    const definition = starterWorkflowDefinition({
      definitionId: "loop-drag",
      name: "Loop drag"
    });
    const loop = createStudioNode("loop", "loop");
    const agent = createStudioNode("agent", "agent");
    const editor = initializeFlowEditorDocument({
      ...definition,
      nodes: [...definition.nodes, loop, agent]
    });
    const flow = toFlowgramDocument(editor);
    const container = flow.nodes.find((node) => node.id === "loop")!;
    const body = flow.nodes.find((node) => node.id === "agent")!;
    flow.nodes = flow.nodes.filter((node) => node !== body);
    container.blocks!.splice(1, 0, body);
    container.edges!.push(
      {
        sourceNodeID: loopAnchorId("loop", "start"),
        sourcePortID: "__kmux_canvas_bottom",
        targetNodeID: "agent"
      },
      {
        sourceNodeID: "agent",
        targetNodeID: loopAnchorId("loop", "end"),
        targetPortID: "__kmux_canvas_top"
      }
    );
    const connected = mergeFlowgramDocument(flow, editor);
    expect(
      connected.nodes.find((node) => node.id === "loop")!.definition.config
    ).toMatchObject({
      body: {
        nodeIds: ["agent"],
        entryNodeIds: ["agent"],
        exits: [{ nodeId: "agent", outcome: "continue" }]
      }
    });
    expect(compileEditorCanonical(connected).edges).toEqual(definition.edges);
    const disconnectedFlow = toFlowgramDocument(connected);
    disconnectedFlow.nodes.find((node) => node.id === "loop")!.edges = [];
    const disconnected = mergeFlowgramDocument(disconnectedFlow, connected);
    expect(
      disconnected.nodes.find((node) => node.id === "loop")!.definition.config
    ).toMatchObject({
      body: { nodeIds: ["agent"], entryNodeIds: [], exits: [] }
    });
  });

  it("restores a manually sized Loop and moved anchors independently of its children", () => {
    const definition = nestedReviewWorkflow()!;
    const editor = initializeFlowEditorDocument(definition);
    const flow = toFlowgramDocument(editor);
    const container = flow.nodes.find((node) => node.id === "items")!;
    container.data!.frameSize = { width: 1800, height: 900 };
    container.blocks![0]!.meta!.position = { x: 35, y: 190 };
    container.blocks!.at(-1)!.meta!.position = { x: 1500, y: 700 };
    const saved = mergeFlowgramDocument(flow, editor);
    const moved = toFlowgramDocument(saved);
    const loop = moved.nodes.find((node) => node.id === "items")!;
    loop.blocks!.find(
      (node) => node.id === "prepare-worktree"
    )!.meta!.position = { x: 4000, y: -500 };
    const restored = toFlowgramDocument(
      mergeFlowgramDocument(moved, saved)
    ).nodes.find((node) => node.id === "items")!;
    expect(restored.meta!.size).toEqual({ width: 1800, height: 900 });
    expect(restored.blocks![0]!.meta!.position).toEqual({ x: 35, y: 190 });
    expect(restored.blocks!.at(-1)!.meta!.position).toEqual({
      x: 1500,
      y: 700
    });
    expect(compileEditorCanonical(saved)).toEqual(definition);
  });
});

describe("Studio Agent input lifecycle", () => {
  it("clears provider-specific launch preferences only when the selected Agent changes", () => {
    const definition = nestedReviewWorkflow()!;
    let editor = initializeFlowEditorDocument(definition);
    editor = replaceAgentSelector(editor, "author", {
      kind: "agent-id",
      agentId: "first"
    });
    editor = {
      ...editor,
      workflow: {
        ...editor.workflow,
        agentBindings: {
          ...editor.workflow.agentBindings,
          author: {
            ...editor.workflow.agentBindings.author!,
            launch: { model: "first-model", effort: "high" }
          }
        }
      },
      nodes: editor.nodes.map((entry) =>
        entry.definition.kind === "agent" &&
        entry.definition.config.agentRef === "author"
          ? {
              ...entry,
              definition: {
                ...entry.definition,
                config: {
                  ...entry.definition.config,
                  launch: { model: "node-model", effort: "low" }
                }
              }
            }
          : entry
      )
    };
    const same = replaceAgentSelector(editor, "author", {
      kind: "agent-id",
      agentId: "first"
    });
    expect(same.workflow.agentBindings.author?.launch).toEqual(
      editor.workflow.agentBindings.author?.launch
    );
    expect(same.nodes).toEqual(editor.nodes);
    const changed = replaceAgentSelector(editor, "author", {
      kind: "agent-id",
      agentId: "second"
    });
    expect(changed.workflow.agentBindings.author?.launch).toBeUndefined();
    for (const entry of changed.nodes.filter(
      (entry) =>
        entry.definition.kind === "agent" &&
        entry.definition.config.agentRef === "author"
    )) {
      expect(entry.definition.config).toMatchObject({ launch: undefined });
    }
    expect(
      changed.nodes.filter(
        (entry) =>
          entry.definition.kind !== "agent" ||
          entry.definition.config.agentRef !== "author"
      )
    ).toEqual(
      editor.nodes.filter(
        (entry) =>
          entry.definition.kind !== "agent" ||
          entry.definition.config.agentRef !== "author"
      )
    );
  });
  it("preserves shared input references on provider selection and node deletion", () => {
    let editor = initializeFlowEditorDocument(nestedReviewWorkflow()!);
    const selector = "agent-selector-custom";
    editor = replaceAgentSelector(editor, "author", {
      kind: "run-input",
      inputId: selector
    });
    editor = {
      ...editor,
      workflow: {
        ...editor.workflow,
        agentBindings: {
          ...editor.workflow.agentBindings,
          "reviewer-a": {
            ...editor.workflow.agentBindings["reviewer-a"]!,
            worktreeInput: {
              target: "worktree",
              source: { kind: "run-input", inputId: selector },
              required: true,
              missing: "fail"
            }
          }
        }
      }
    };
    const changed = replaceAgentSelector(editor, "author", {
      kind: "agent-id",
      agentId: "custom-provider"
    });
    expect(changed.workflow.inputs.map((input) => input.id)).toContain(
      selector
    );
    expect(changed.workflow.agentBindings.author).toMatchObject({
      agent: { kind: "agent-id", agentId: "custom-provider" },
      capabilities: ["terminal", "filesystem-write"]
    });
    // A Run selector is editable again after choosing a concrete provider.
    const selectedAgain = replaceAgentSelector(changed, "author", {
      kind: "run-input",
      inputId: "agent-selector-next"
    });
    expect(
      selectedAgain.workflow.inputs.find(
        (input) => input.id === "agent-selector-next"
      )
    ).toMatchObject({ required: true, schema: { schema: { type: "string" } } });
    const pruned = removeStudioNode(
      removeStudioNode(editor, "analyze-fix"),
      "synthesize-fix"
    );
    expect(pruned.workflow.inputs.map((input) => input.id)).toContain(selector);
    const unreferenced = removeStudioNode(pruned, "review-regression");
    // User-declared inputs survive removal of the only Agent role referencing them.
    expect(unreferenced.workflow.inputs.map((input) => input.id)).toContain(
      "regressionReviewerAgent"
    );
  });
});

it("switches a catalog Agent to the existing caller without retaining launch or iteration bindings", () => {
  let document = initializeFlowEditorDocument(nestedReviewWorkflow());
  const prior = document.workflow.agentBindings.author;
  document = {
    ...document,
    workflow: {
      ...document.workflow,
      agentBindings: {
        ...document.workflow.agentBindings,
        author: {
          ...prior,
          launch: { model: "provider-model", effort: "high" }
        }
      }
    },
    nodes: document.nodes.map((entry) =>
      entry.definition.kind === "agent" &&
      entry.definition.config.agentRef === "author"
        ? {
            ...entry,
            definition: {
              ...entry.definition,
              config: {
                ...entry.definition.config,
                launch: { model: "node-model", effort: "high" }
              }
            }
          }
        : entry
    )
  };
  const changed = replaceAgentSelector(document, "author", { kind: "caller" });
  expect(changed.workflow.agentBindings.author).toMatchObject({
    agent: { kind: "caller" },
    scope: { kind: "run" },
    targetPolicy: "local",
    worktreePolicy: "current",
    sessionPolicy: "reuse",
    surfacePolicy: "create-or-reuse"
  });
  expect(changed.workflow.agentBindings.author.launch).toBeUndefined();
  const callerNode = changed.nodes.find(
    (entry) =>
      entry.definition.kind === "agent" &&
      entry.definition.config.agentRef === "author"
  )!.definition;
  expect(
    callerNode.kind === "agent" && callerNode.config.launch
  ).toBeUndefined();
  expect(compileEditorCanonical(changed).agentBindings.author.agent).toEqual({
    kind: "caller"
  });
});
