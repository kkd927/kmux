import {
  createEmptyOrchestrationSnapshot,
  initializeFlowEditorDocument,
  prepareWorkflowInvocation,
  starterWorkflowDefinition,
  type JsonValue,
  type OrchestrationSnapshot,
  type RuntimeContext,
  type WorkflowDefinitionV1,
  type WorkflowDraft
} from "./index";
let serial = 0;
const context: RuntimeContext = {
  now: () => "2026-10-05T00:00:00.000Z",
  id: (kind) => `${kind}:${++serial}`
};
const definition = starterWorkflowDefinition({
  definitionId: "workflow:one",
  name: "Saved flow"
});
function draft(
  value: WorkflowDefinitionV1,
  id = "draft:one",
  revision = 1
): WorkflowDraft {
  return {
    draftId: id,
    definitionId: value.definitionId,
    revision,
    createdAt: context.now(),
    updatedAt: context.now(),
    canonicalDraft: value as unknown as JsonValue,
    editorDocument: initializeFlowEditorDocument(value) as unknown as JsonValue
  };
}
function snapshot(drafts: WorkflowDraft[]): OrchestrationSnapshot {
  return {
    ...createEmptyOrchestrationSnapshot(),
    workflowDrafts: Object.fromEntries(
      drafts.map((draft) => [draft.draftId, draft])
    )
  };
}
describe("saved Workflow invocation", () => {
  it("rejects a changed or replaced draft when execution was requested from an exact saved revision", () => {
    const current = draft(definition, "draft:one", 2);
    const state = snapshot([current]);
    expect(() =>
      prepareWorkflowInvocation(state, definition.definitionId, context, {
        draftId: "draft:one",
        revision: 1
      })
    ).toThrow(/changed before execution/);
    expect(() =>
      prepareWorkflowInvocation(state, definition.definitionId, context, {
        draftId: "draft:other",
        revision: 2
      })
    ).toThrow(/changed before execution/);
    expect(
      prepareWorkflowInvocation(state, definition.definitionId, context, {
        draftId: current.draftId,
        revision: current.revision
      }).definitionId
    ).toBe(definition.definitionId);
  });

  it("pins changed layout in a new immutable version even when execution is unchanged", () => {
    const original = draft(definition);
    const first = prepareWorkflowInvocation(
      snapshot([original]),
      definition.definitionId,
      context
    );
    const document = initializeFlowEditorDocument(definition);
    const changed = {
      ...original,
      revision: 2,
      editorDocument: {
        ...document,
        nodes: document.nodes.map((node, index) =>
          index === 0 ? { ...node, position: { x: 500, y: 600 } } : node
        )
      } as unknown as JsonValue
    };
    const state = {
      ...snapshot([changed]),
      workflowVersions: { [first.workflowVersionId]: first }
    };
    const next = prepareWorkflowInvocation(
      state,
      definition.definitionId,
      context
    );
    expect(next.version).toBe(2);
    expect(next.workflowVersionId).not.toBe(first.workflowVersionId);
    expect(next.editorDocument).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ position: { x: 500, y: 600 } })
      ])
    });
    expect(first.editorDocument).toEqual(original.editorDocument);
  });

  it("pins the latest saved definition and reuses a matching immutable version", () => {
    let state = snapshot([draft(definition)]);
    const first = prepareWorkflowInvocation(state, "Saved flow", context);
    state = {
      ...state,
      workflowVersions: { [first.workflowVersionId]: first }
    };
    expect(
      prepareWorkflowInvocation(state, "workflow:one", context)
        .workflowVersionId
    ).toBe(first.workflowVersionId);
    const changed = { ...definition, name: "Updated flow" };
    state = {
      ...state,
      workflowDrafts: { "draft:one": draft(changed, "draft:one", 2) }
    };
    const next = prepareWorkflowInvocation(state, "Updated flow", context);
    expect(next.version).toBe(2);
    expect(next.definition.name).toBe("Updated flow");
    expect(first.definition.name).toBe("Saved flow");
    expect(() =>
      prepareWorkflowInvocation(state, "Saved flow", context)
    ).toThrow(/not found/);
  });
  it("requires an ID for duplicate titles and gives exact IDs priority over titles", () => {
    const second = { ...definition, definitionId: "workflow:two" };
    let state = snapshot([draft(definition), draft(second, "draft:two")]);
    expect(() =>
      prepareWorkflowInvocation(state, "Saved flow", context)
    ).toThrow(/ambiguous/);
    expect(
      prepareWorkflowInvocation(state, "workflow:one", context).definitionId
    ).toBe("workflow:one");
    const legacy = prepareWorkflowInvocation(
      snapshot([draft(second)]),
      "workflow:two",
      context
    );
    state = {
      ...snapshot([draft(definition)]),
      workflowVersions: { [legacy.workflowVersionId]: legacy }
    };
    expect(() =>
      prepareWorkflowInvocation(state, "Saved flow", context)
    ).toThrow(/ambiguous/);
    state = snapshot([
      draft(definition),
      draft({ ...second, name: "workflow:one" }, "draft:two")
    ]);
    expect(
      prepareWorkflowInvocation(state, "workflow:one", context).definitionId
    ).toBe("workflow:one");
  });
  it("rejects a broken latest draft rather than running an older published version", () => {
    const saved = draft(definition);
    const first = prepareWorkflowInvocation(
      snapshot([saved]),
      definition.definitionId,
      context
    );
    const state = {
      ...snapshot([{ ...saved, revision: 2, editorDocument: {} }]),
      workflowVersions: { [first.workflowVersionId]: first }
    };
    expect(() =>
      prepareWorkflowInvocation(state, definition.definitionId, context)
    ).toThrow(/invalid/);
  });
});

it("ignores unrelated invalid drafts during title lookup", () => {
  const broken = {
    ...draft(
      { ...definition, definitionId: "workflow:broken" },
      "draft:broken"
    ),
    canonicalDraft: null
  };
  expect(
    prepareWorkflowInvocation(
      snapshot([draft(definition), broken]),
      "Saved flow",
      context
    ).definitionId
  ).toBe(definition.definitionId);
});
