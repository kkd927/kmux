import { loopMaxGateRoute, workflowNodeOwners } from "./scopes";
import type { WorkflowDefinitionV1 } from "./types";

export { resolveWorkflowAgentLaunchPreferences } from "./launchPreferences";

export interface FlowEditorDocumentV1 {
  readonly documentVersion: 1;
  readonly workflow: Omit<WorkflowDefinitionV1, "nodes" | "edges">;
  readonly nodes: readonly {
    readonly id: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly size?: { readonly width: number; readonly height: number };
    readonly loopAnchors?: {
      readonly start: { readonly x: number; readonly y: number };
      readonly end: { readonly x: number; readonly y: number };
    };
    readonly definition: WorkflowDefinitionV1["nodes"][number];
  }[];
  readonly edges: WorkflowDefinitionV1["edges"];
}

export function initializeFlowEditorDocument(
  definition: WorkflowDefinitionV1
): FlowEditorDocumentV1 {
  const { nodes, edges, ...workflow } = structuredClone(definition);
  const positions = horizontalEditorPositions(nodes, edges);
  return {
    documentVersion: 1,
    workflow,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: 120 + index * 400, y: 120 },
      definition: node
    })),
    edges
  };
}

function horizontalEditorPositions(
  nodes: readonly WorkflowDefinitionV1["nodes"][number][],
  edges: WorkflowDefinitionV1["edges"]
): Map<string, { x: number; y: number }> {
  const owners = workflowNodeOwners(nodes);
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string | null, { width: number; height: number }>();
  const visiting = new Set<string>();

  const layoutScope = (
    scope: string | null
  ): { width: number; height: number } => {
    const cached = sizes.get(scope);
    if (cached) return cached;
    if (scope !== null && visiting.has(scope)) {
      return { width: 424, height: 244 };
    }
    if (scope !== null) visiting.add(scope);
    const scopedNodes = nodes.filter(
      (node) => (owners.get(node.id) ?? null) === scope
    );
    const nodeSizes = new Map(
      scopedNodes.map((node) => [
        node.id,
        node.kind === "loop"
          ? layoutScope(node.id)
          : { width: 360, height: node.kind === "agent" ? 416 : 54 }
      ])
    );
    const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
    const scopedEdges = edges.filter(
      (edge) =>
        scopedNodeIds.has(edge.from.nodeId) && scopedNodeIds.has(edge.to.nodeId)
    );
    const scopeLoop =
      scope === null ? undefined : nodes.find((node) => node.id === scope);
    const maxGateRoute = scopeLoop ? loopMaxGateRoute(scopeLoop) : undefined;
    const layoutEdges: WorkflowDefinitionV1["edges"] = [
      ...scopedEdges,
      ...(maxGateRoute
        ? [
            {
              id: `presentation:max-gate:${maxGateRoute.loopNodeId}`,
              from: {
                nodeId: maxGateRoute.sourceNodeId,
                ...(maxGateRoute.sourcePort
                  ? { port: maxGateRoute.sourcePort }
                  : {})
              },
              to: { nodeId: maxGateRoute.gateNodeId }
            }
          ]
        : [])
    ];
    const ranks = topologicalRanks(scopedNodes, layoutEdges);
    const size =
      scope === null
        ? layoutRootScope(ranks, nodeSizes, positions)
        : layoutLoopScope(ranks, nodeSizes, positions);
    sizes.set(scope, size);
    if (scope !== null) visiting.delete(scope);
    return size;
  };

  layoutScope(null);
  return positions;
}

function topologicalRanks(
  nodes: readonly WorkflowDefinitionV1["nodes"][number][],
  edges: WorkflowDefinitionV1["edges"]
): readonly (readonly string[])[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId))
      continue;
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.set(edge.from.nodeId, [
      ...(outgoing.get(edge.from.nodeId) ?? []),
      edge.to.nodeId
    ]);
  }
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const rank = new Map(queue.map((nodeId) => [nodeId, 0]));
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    for (const targetId of outgoing.get(nodeId) ?? []) {
      rank.set(
        targetId,
        Math.max(rank.get(targetId) ?? 0, (rank.get(nodeId) ?? 0) + 1)
      );
      const remaining = (indegree.get(targetId) ?? 1) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) queue.push(targetId);
    }
  }
  const unresolvedRank = Math.max(0, ...rank.values()) + 1;
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const nodeRank = rank.get(node.id) ?? unresolvedRank;
    byRank.set(nodeRank, [...(byRank.get(nodeRank) ?? []), node.id]);
  }
  return [...byRank.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, nodeIdsAtRank]) => nodeIdsAtRank);
}

function layoutRootScope(
  ranks: readonly (readonly string[])[],
  nodeSizes: ReadonlyMap<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>
): { width: number; height: number } {
  const columnGap = 100;
  const rowGap = 80;
  const metrics = ranks.map((nodeIds) => ({
    width: Math.max(
      0,
      ...nodeIds.map((nodeId) => nodeSizes.get(nodeId)?.width ?? 360)
    ),
    height: nodeIds.reduce(
      (total, nodeId, index) =>
        total +
        (nodeSizes.get(nodeId)?.height ?? 54) +
        (index > 0 ? rowGap : 0),
      0
    )
  }));
  const contentHeight = Math.max(0, ...metrics.map((metric) => metric.height));
  let x = 120;
  ranks.forEach((nodeIds, rankIndex) => {
    let y = 120 + (contentHeight - (metrics[rankIndex]?.height ?? 0)) / 2;
    nodeIds.forEach((nodeId) => {
      const size = nodeSizes.get(nodeId) ?? { width: 360, height: 54 };
      positions.set(nodeId, {
        x,
        y
      });
      y += size.height + rowGap;
    });
    x += (metrics[rankIndex]?.width ?? 360) + columnGap;
  });
  return {
    width: Math.max(0, x - columnGap + 120),
    height: contentHeight + 240
  };
}

function layoutLoopScope(
  ranks: readonly (readonly string[])[],
  nodeSizes: ReadonlyMap<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>
): { width: number; height: number } {
  const leftPadding = 80;
  const rightPadding = 80;
  const topPadding = 120;
  const bottomPadding = 80;
  const columnGap = 72;
  const rowGap = 48;
  const metrics = ranks.map((nodeIds) => ({
    width: Math.max(
      0,
      ...nodeIds.map((nodeId) => nodeSizes.get(nodeId)?.width ?? 280)
    ),
    height: nodeIds.reduce(
      (total, nodeId, index) =>
        total +
        (nodeSizes.get(nodeId)?.height ?? 54) +
        (index > 0 ? rowGap : 0),
      0
    )
  }));
  const contentHeight = Math.max(84, ...metrics.map((metric) => metric.height));
  let x = leftPadding;
  ranks.forEach((nodeIds, rankIndex) => {
    const metric = metrics[rankIndex] ?? { width: 0, height: 54 };
    let y = topPadding + (contentHeight - metric.height) / 2;
    nodeIds.forEach((nodeId) => {
      const size = nodeSizes.get(nodeId) ?? { width: 280, height: 54 };
      positions.set(nodeId, {
        x,
        y
      });
      y += size.height + rowGap;
    });
    x += metric.width + columnGap;
  });
  const contentRight = ranks.length > 0 ? x - columnGap : leftPadding;
  const blockMarkerSize = 100;
  const blockMarkerGap = 48;
  const blockStartLeft = leftPadding - blockMarkerSize - blockMarkerGap;
  const blockEndRight = contentRight + blockMarkerGap + blockMarkerSize;
  return {
    width: Math.max(
      424,
      blockEndRight - blockStartLeft + leftPadding + rightPadding
    ),
    height: Math.max(244, topPadding + contentHeight + bottomPadding)
  };
}

export function starterWorkflowDefinition(input: {
  readonly definitionId: string;
  readonly name: string;
}): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    definitionId: input.definitionId,
    version: 1,
    name: input.name,
    inputs: [],
    outputs: [],
    agentBindings: {},
    nodes: [
      {
        id: "start",
        kind: "start",
        title: "Start",
        config: { version: 1 }
      },
      {
        id: "end",
        kind: "end",
        title: "End",
        config: { version: 1 },
        completionRoot: true
      }
    ],
    edges: [
      {
        id: "start-end",
        from: { nodeId: "start" },
        to: { nodeId: "end" }
      }
    ],
    policies: {
      limits: {
        maxNodes: 128,
        maxEdges: 512,
        maxGraphDepth: 32,
        maxFanOut: 16,
        maxLoopIterations: 12,
        maxActiveAttempts: 4,
        maxAttemptsPerSession: 8,
        maxDispatches: 128,
        maxCoordinatorTurns: 32,
        maxGraphPatches: 128,
        maxWallClockMs: 86_400_000,
        maxActiveExecutionMs: 43_200_000,
        maxArtifactBytes: 536_870_912,
        maxStructuredResultBytes: 8_388_608
      },
      failure: "fail-run",
      cancellation: "cancel-active"
    }
  };
}

export function workflowRequiresCaller(
  definition: WorkflowDefinitionV1
): boolean {
  return definition.nodes.some(
    (node) =>
      node.kind === "agent" &&
      definition.agentBindings[node.config.agentRef]?.agent.kind === "caller"
  );
}
