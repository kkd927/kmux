import { validateWorkflowDefinition } from "./schema";
import type {
  JsonValue,
  ValidationResult,
  WorkflowDefinitionV1
} from "./types";
export * from "./editorDocument";

export function compileFlowEditorDocument(
  input: JsonValue
): ValidationResult<WorkflowDefinitionV1> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.documentVersion !== 1 ||
    input.workflow === null ||
    typeof input.workflow !== "object" ||
    Array.isArray(input.workflow) ||
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.edges)
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_editor_document",
          path: [],
          message: "Flow editor document v1 is malformed or unsupported"
        }
      ]
    };
  }
  const nodes = input.nodes.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? entry.definition
      : null
  );
  const candidate = {
    ...input.workflow,
    nodes,
    edges: input.edges
  };
  return validateWorkflowDefinition(candidate);
}
