import type { Locator } from "@playwright/test";
import type {
  FlowEditorDocumentV1,
  WorkflowDefinitionV1
} from "@kmux/orchestration";

export async function readWorkflowDefinition(
  studio: Locator
): Promise<WorkflowDefinitionV1> {
  const document = JSON.parse(
    await studio.getByLabel("Workflow JSON").inputValue()
  ) as FlowEditorDocumentV1;
  return {
    ...document.workflow,
    nodes: document.nodes.map((entry) => entry.definition),
    edges: document.edges
  };
}
