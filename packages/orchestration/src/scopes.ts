import type { WorkflowNodeDefinition } from "./types";

export type WorkflowScopeId = string | null;

export interface LoopMaxGateRoute {
  readonly loopNodeId: string;
  readonly sourceNodeId: string;
  readonly sourcePort?: string;
  readonly gateNodeId: string;
}

export function structuredLoopOwnedNodeIds(
  node: WorkflowNodeDefinition
): readonly string[] {
  if (node.kind !== "loop") return [];
  return [
    ...node.config.body.nodeIds,
    ...(node.config.mode === "while" && node.config.maxGate
      ? [node.config.maxGate.nodeId]
      : [])
  ];
}

export function workflowNodeOwners(
  nodes: readonly WorkflowNodeDefinition[]
): ReadonlyMap<string, string> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const owners = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== "loop") continue;
    for (const ownedNodeId of structuredLoopOwnedNodeIds(node)) {
      if (nodeIds.has(ownedNodeId) && !owners.has(ownedNodeId)) {
        owners.set(ownedNodeId, node.id);
      }
    }
  }
  return owners;
}

export function workflowScopePath(
  nodes: readonly WorkflowNodeDefinition[],
  scopeId: WorkflowScopeId
): readonly string[] {
  if (scopeId === null) return [];
  const owners = workflowNodeOwners(nodes);
  const path: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = scopeId;
  while (current && !visited.has(current)) {
    visited.add(current);
    path.unshift(current);
    current = owners.get(current);
  }
  return path;
}

export function loopMaxGateRoute(
  node: WorkflowNodeDefinition
): LoopMaxGateRoute | undefined {
  if (node.kind !== "loop") return undefined;
  const config = node.config;
  if (config.mode !== "while") return undefined;
  const gateNodeId = config.maxGate?.nodeId;
  if (!gateNodeId) return undefined;
  const repeatExit = config.body.exits.find(
    (exit) => exit.outcome === config.repeatOutcome
  );
  if (!repeatExit) return undefined;
  return {
    loopNodeId: node.id,
    sourceNodeId: repeatExit.nodeId,
    ...(repeatExit.port ? { sourcePort: repeatExit.port } : {}),
    gateNodeId
  };
}
