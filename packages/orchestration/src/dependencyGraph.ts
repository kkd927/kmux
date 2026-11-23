import {
  admissionInputMappings,
  loopIterationOutputMappings
} from "./dataflow";
import type { WorkflowNodeDefinition, WorkflowControlEdge } from "./types";

/** Control edges, Loop entries and required data sources share structural limits. */
export function workflowDependencyGraph(
  nodes: readonly WorkflowNodeDefinition[],
  edges: readonly WorkflowControlEdge[],
  options: {
    resolveSource?: (
      consumerId: string,
      sourceId: string
    ) => string | undefined;
    includeLoopEntries?: boolean;
    resolveLoopExit?: (loopId: string, templateId: string) => readonly string[];
  } = {}
): Map<string, Set<string>> {
  const graph = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // A Loop result is available after its body exits, not when the container
  // starts. Expand completion dependencies through nested exits so a body
  // cannot wait on its own Loop result or on work downstream of that result.
  const completionSources = (sourceId: string): Set<string> => {
    const sources = new Set<string>();
    const pending = [sourceId];
    while (pending.length) {
      const id = pending.pop()!;
      if (sources.has(id)) continue;
      sources.add(id);
      const node = byId.get(id);
      if (node?.kind !== "loop") continue;
      const exits = node.config.body.exits.map((exit) => exit.nodeId);
      for (const mapping of loopIterationOutputMappings(node)) {
        if ("nodeId" in mapping.source) exits.push(mapping.source.nodeId);
      }
      if (node.config.mode === "while" && node.config.maxGate)
        exits.push(node.config.maxGate.nodeId);
      for (const exit of exits)
        pending.push(...(options.resolveLoopExit?.(id, exit) ?? [exit]));
    }
    return sources;
  };
  const depend = (sourceId: string, targetId: string) => {
    for (const id of completionSources(sourceId)) graph.get(id)?.add(targetId);
  };
  for (const edge of edges) depend(edge.from.nodeId, edge.to.nodeId);
  for (const node of nodes) {
    if (node.kind === "loop" && options.includeLoopEntries !== false) {
      for (const entry of node.config.body.entryNodeIds)
        graph.get(node.id)?.add(entry);
      if (node.config.mode === "while" && node.config.maxGate)
        graph.get(node.id)?.add(node.config.maxGate.nodeId);
    }
    for (const mapping of admissionInputMappings(node)) {
      if (!mapping.required || !("nodeId" in mapping.source)) continue;
      const sourceId = options.resolveSource
        ? options.resolveSource(node.id, mapping.source.nodeId)
        : mapping.source.nodeId;
      if (sourceId) depend(sourceId, node.id);
    }
  }
  return graph;
}

export function findCycle(
  graph: ReadonlyMap<string, ReadonlySet<string>>
): string[] | undefined {
  const active = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (active.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (visited.has(node)) return undefined;
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

export function maximumDepth(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  starts: readonly string[]
): number {
  const memo = new Map<string, number>();
  const visit = (node: string): number => {
    const existing = memo.get(node);
    if (existing !== undefined) return existing;
    let depth = 1;
    for (const target of graph.get(node) ?? [])
      depth = Math.max(depth, 1 + visit(target));
    memo.set(node, depth);
    return depth;
  };
  return Math.max(0, ...starts.map(visit));
}
