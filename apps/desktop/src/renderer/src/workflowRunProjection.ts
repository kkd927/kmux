import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition
} from "@kmux/orchestration/editor";
import {
  type FlowEditorDocumentV1,
  type JsonValue,
  type WorkflowDefinitionV1,
  type WorkflowRun,
  type RunNode,
  type NodeAttempt
} from "@kmux/orchestration";

/** The display skeleton excludes materialized copies, which are projected separately. */
export function workflowRunDiagramDefinition(
  run: WorkflowRun
): WorkflowDefinitionV1 | null {
  const roots = Object.values(run.graph.nodes).filter(
    (node) => !node.materialization
  );
  const nodes: WorkflowDefinitionV1["nodes"] = [
    ...roots.map((node) => node.definition),
    ...Object.values(run.graph.bodyTemplates)
  ];
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...starterWorkflowDefinition({
      definitionId: run.runId,
      name: "Run diagram"
    }),
    agentBindings: run.graph.agentBindings,
    nodes,
    edges: [...run.graph.edges, ...run.graph.bodyTemplateEdges].filter(
      (edge) => ids.has(edge.from.nodeId) && ids.has(edge.to.nodeId)
    )
  };
}

export interface WorkflowRunExecutionProjection {
  readonly nodeId: string;
  readonly status: RunNode["status"];
  readonly iterationPath: string;
  readonly attemptId?: string;
  readonly attemptOrdinal?: number;
}

export function projectWorkflowRunExecutions(
  nodes: Readonly<Record<string, RunNode>>,
  attempts: Readonly<Record<string, NodeAttempt>>
): ReadonlyMap<string, readonly WorkflowRunExecutionProjection[]> {
  const projected = new Map<string, WorkflowRunExecutionProjection[]>();
  for (const node of Object.values(nodes)) {
    const id = node.materialization?.templateNodeId ?? node.nodeId;
    const attemptId = node.activeAttemptId ?? node.attemptIds.at(-1);
    const attempt = attemptId ? attempts[attemptId] : undefined;
    const values = projected.get(id) ?? [];
    values.push({
      nodeId: node.nodeId,
      status: node.status,
      iterationPath:
        node.materialization?.path
          .map((scope) => `${scope.loopNodeId} ${scope.iteration + 1}`)
          .join(" / ") ?? "",
      ...(attempt
        ? { attemptId: attempt.attemptId, attemptOrdinal: attempt.ordinal }
        : {})
    });
    projected.set(id, values);
  }
  return projected;
}

/** Only presentation coordinates may flow from a pinned editor snapshot into a Run. */
export function workflowRunDiagramDocument(
  definition: WorkflowDefinitionV1,
  editorDocument?: JsonValue
): FlowEditorDocumentV1 {
  const document = initializeFlowEditorDocument(definition);
  if (
    !editorDocument ||
    typeof editorDocument !== "object" ||
    Array.isArray(editorDocument) ||
    editorDocument.documentVersion !== 1 ||
    !Array.isArray(editorDocument.nodes)
  )
    return document;
  const positions = new Map<string, { x: number; y: number }>();
  for (const entry of editorDocument.nodes) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string"
    )
      continue;
    const position = entry.position;
    if (
      !position ||
      typeof position !== "object" ||
      Array.isArray(position) ||
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    )
      continue;
    positions.set(entry.id, { x: position.x, y: position.y });
  }
  return {
    ...document,
    nodes: document.nodes.map((entry) => ({
      ...entry,
      position: positions.get(entry.id) ?? entry.position
    }))
  };
}
export function isTerminalWorkflowRun(status: WorkflowRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
