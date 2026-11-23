import {
  canonicalJson,
  builtInWorkflowTemplate,
  compileFlowEditorDocument,
  initializeFlowEditorDocument,
  SHELL_TEMPLATE_ID,
  starterWorkflowDefinition
} from "./index";

describe("Flow editor document v1", () => {
  it("round-trips the canonical workflow without changing its semantics", () => {
    const definition = starterWorkflowDefinition({
      definitionId: "workflow:round-trip",
      name: "Round trip"
    });
    const editor = initializeFlowEditorDocument(definition);
    const compiled = compileFlowEditorDocument(editor as never);

    expect(editor.nodes[0]?.position.y).toBe(editor.nodes[1]?.position.y);
    expect(editor.nodes[0]!.position.x).toBeLessThan(
      editor.nodes[1]!.position.x
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(canonicalJson(compiled.value as never)).toBe(
      canonicalJson(definition as never)
    );
  });

  it("reports malformed editor state instead of manufacturing a workflow", () => {
    expect(compileFlowEditorDocument({ documentVersion: 2 })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid_editor_document" }]
    });
  });

  it("round-trips the built-in Shell template through the FlowGram document", () => {
    const template = builtInWorkflowTemplate(SHELL_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (!template) return;
    const editor = initializeFlowEditorDocument(template);
    const compiled = compileFlowEditorDocument(editor as never);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(canonicalJson(compiled.value as never)).toBe(
      canonicalJson(template as never)
    );
  });
});
