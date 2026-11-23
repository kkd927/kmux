import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition,
  type DataSource
} from "@kmux/orchestration";
import {
  sourceSchema,
  sourceToVariablePath,
  variablePathToSource
} from "./workflowVariables";

describe("Workflow variable references", () => {
  it.each<DataSource>([
    { kind: "run-input", inputId: "review", path: ["blockerCount"] },
    {
      kind: "loop-carry",
      loopNodeId: "loop",
      inputId: "review",
      path: ["blockerCount"]
    },
    { kind: "loop-index", loopNodeId: "loop" },
    { kind: "loop-item", loopNodeId: "loop", path: ["name"] },
    { kind: "node-result", nodeId: "review_locals", path: ["index"] },
    { kind: "node-result", nodeId: "workflow_inputs", path: ["blockerCount"] }
  ])("keeps the canonical identity and nested path of %j", (source) => {
    expect(variablePathToSource(sourceToVariablePath(source))).toEqual(source);
  });
  it("infers the selected Workflow input field type", () => {
    const base = starterWorkflowDefinition({
      definitionId: "variables",
      name: "Variables"
    });
    const document = initializeFlowEditorDocument({
      ...base,
      inputs: [
        {
          id: "review",
          required: true,
          schema: {
            schema: {
              type: "object",
              properties: { blockerCount: { type: "integer" } }
            }
          }
        }
      ]
    });
    expect(
      sourceSchema(
        { kind: "run-input", inputId: "review", path: ["blockerCount"] },
        document
      )
    ).toEqual({ type: "integer" });
  });
});
