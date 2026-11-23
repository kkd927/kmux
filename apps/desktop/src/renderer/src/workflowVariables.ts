import type { IJsonSchema, IFlowRefValue } from "@flowgram.ai/form-materials";
import type {
  DataSource,
  FlowEditorDocumentV1,
  WorkflowNodeDefinition
} from "@kmux/orchestration";

export const WORKFLOW_INPUT_VARIABLE = "$workflow_inputs";
export const LOOP_LOCAL_VARIABLE_PREFIX = "$loop:";

export function sourceToVariablePath(
  source?: DataSource
): string[] | undefined {
  if (!source) return undefined;
  if (source.kind === "node-result")
    return source.nodeId ? [source.nodeId, ...(source.path ?? [])] : undefined;
  if (source.kind === "run-input")
    return [WORKFLOW_INPUT_VARIABLE, source.inputId, ...(source.path ?? [])];
  if (source.kind === "loop-index")
    return [`${LOOP_LOCAL_VARIABLE_PREFIX}${source.loopNodeId}`, "index"];
  if (source.kind === "loop-item")
    return [
      `${LOOP_LOCAL_VARIABLE_PREFIX}${source.loopNodeId}`,
      "item",
      ...(source.path ?? [])
    ];
  if (source.kind === "loop-carry")
    return [
      `${LOOP_LOCAL_VARIABLE_PREFIX}${source.loopNodeId}`,
      "carry",
      source.inputId,
      ...(source.path ?? [])
    ];
  return undefined;
}

export function variablePathToSource(path?: string[]): DataSource | undefined {
  if (!path?.length) return undefined;
  const [root, key, ...rest] = path;
  if (root === WORKFLOW_INPUT_VARIABLE)
    return key
      ? {
          kind: "run-input",
          inputId: key,
          ...(rest.length ? { path: rest } : {})
        }
      : undefined;
  if (root.startsWith(LOOP_LOCAL_VARIABLE_PREFIX)) {
    const loopNodeId = root.slice(LOOP_LOCAL_VARIABLE_PREFIX.length);
    if (key === "index") return { kind: "loop-index", loopNodeId };
    if (key === "item") return { kind: "loop-item", loopNodeId, path: rest };
    if (key === "carry" && rest[0])
      return {
        kind: "loop-carry",
        loopNodeId,
        inputId: rest[0],
        ...(rest.length > 1 ? { path: rest.slice(1) } : {})
      };
    return undefined;
  }
  return { kind: "node-result", nodeId: root, path: path.slice(1) };
}

export function sourceToFlowRef(source: DataSource): IFlowRefValue | undefined {
  const content = sourceToVariablePath(source);
  return content ? { type: "ref", content } : undefined;
}

export function sourceSchema(
  source: DataSource,
  document: FlowEditorDocumentV1,
  visited = new Set<string>()
): IJsonSchema {
  let schema: IJsonSchema | undefined;
  let path: readonly string[] = [];
  if (source.kind === "literal") {
    const value = source.value;
    return value === null
      ? { type: "null" }
      : Array.isArray(value)
        ? {
            type: "array",
            items: value.length
              ? sourceSchema(
                  { kind: "literal", value: value[0]! },
                  document,
                  visited
                )
              : { type: "string" }
          }
        : typeof value === "object"
          ? {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(value).map(([key, child]) => [
                  key,
                  sourceSchema(
                    { kind: "literal", value: child },
                    document,
                    visited
                  )
                ])
              )
            }
          : { type: typeof value as "string" | "number" | "boolean" };
  }
  if (source.kind === "loop-index") return { type: "integer" };
  if (source.kind === "run-input") {
    schema = document.workflow.inputs.find(
      (input) => input.id === source.inputId
    )?.schema?.schema as IJsonSchema | undefined;
    path = source.path ?? [];
  }
  if (source.kind === "node-result") {
    const node = document.nodes.find(
      (entry) => entry.id === source.nodeId
    )?.definition;
    schema = node ? nodeOutputSchema(node, document, visited) : undefined;
    path = source.path ?? [];
  }
  if (source.kind === "loop-item") {
    const loop = document.nodes.find(
      (entry) => entry.id === source.loopNodeId
    )?.definition;
    if (
      loop?.kind === "loop" &&
      loop.config.mode === "for-each" &&
      !visited.has(`${loop.id}:item`)
    ) {
      visited.add(`${loop.id}:item`);
      schema = sourceSchema(loop.config.collection, document, visited).items as
        | IJsonSchema
        | undefined;
    }
    path = source.path ?? [];
  }
  if (source.kind === "loop-carry") {
    const loop = document.nodes.find(
      (entry) => entry.id === source.loopNodeId
    )?.definition;
    const carry =
      loop?.kind === "loop" && loop.config.mode === "while"
        ? loop.config.carry?.find((entry) => entry.inputId === source.inputId)
        : undefined;
    if (carry && !visited.has(`${source.loopNodeId}:${source.inputId}`)) {
      visited.add(`${source.loopNodeId}:${source.inputId}`);
      schema = sourceSchema(carry.initial, document, visited);
    }
    path = source.path ?? [];
  }
  for (const segment of path) schema = schema?.properties?.[segment];
  return schema ?? {};
}

export function nodeOutputSchema(
  node: WorkflowNodeDefinition,
  document: FlowEditorDocumentV1,
  visited = new Set<string>()
): IJsonSchema {
  if (node.kind !== "loop")
    return (
      (node.resultSchema?.schema as IJsonSchema) ?? {
        type: "object",
        properties: {}
      }
    );
  if (visited.has(node.id)) return {};
  visited.add(node.id);
  return {
    type: "object",
    properties: Object.fromEntries(
      (node.config.loopOutputs ?? []).map((output) => {
        const schema = sourceSchema(output.source, document, new Set(visited));
        return [
          output.name,
          output.mode === "collect" ? { type: "array", items: schema } : schema
        ];
      })
    )
  };
}

export function loopLocalSchema(
  node: WorkflowNodeDefinition,
  document: FlowEditorDocumentV1
): IJsonSchema {
  if (node.kind !== "loop") return { type: "object", properties: {} };
  return {
    type: "object",
    properties: {
      index: { type: "integer" },
      ...(node.config.mode === "for-each"
        ? {
            item:
              (sourceSchema(node.config.collection, document)
                .items as IJsonSchema) ?? {}
          }
        : {}),
      ...(node.config.mode === "while" && node.config.carry?.length
        ? {
            carry: {
              type: "object",
              properties: Object.fromEntries(
                node.config.carry.map((entry) => [
                  entry.inputId,
                  sourceSchema(entry.initial, document)
                ])
              )
            } as IJsonSchema
          }
        : {})
    }
  };
}
