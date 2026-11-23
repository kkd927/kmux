import type { WorkflowJSON } from "@flowgram.ai/free-layout-editor";
import {
  type AgentSelector,
  type FlowEditorDocumentV1,
  type WorkflowDefinitionV1,
  type WorkflowNodeDefinition
} from "@kmux/orchestration";
import {
  loopMaxGateRoute,
  structuredLoopOwnedNodeIds,
  workflowNodeOwners,
  type WorkflowScopeId
} from "@kmux/orchestration/scopes";
import { normalizeWorkflowCanvasPort } from "./workflowCanvasPorts";

type FlowgramEdge = WorkflowJSON["edges"][number];
type FlowgramNode = WorkflowJSON["nodes"][number];

const PRESENTATION_EDGE_PREFIX = "presentation:";
export const LOOP_START_ANCHOR_TYPE = "kmux-loop-start-anchor";
export const LOOP_END_ANCHOR_TYPE = "kmux-loop-end-anchor";
export const LOOP_FRAME_MIN_SIZE = { width: 620, height: 360 };
export const LOOP_FRAME_DEFAULT_SIZE = { width: 820, height: 580 };
const LOOP_ANCHOR_SIZE = 64;
const LOOP_ANCHOR_GAP = 48;

export function toFlowgramDocument(
  document: FlowEditorDocumentV1
): WorkflowJSON {
  const entries = new Map(document.nodes.map((entry) => [entry.id, entry]));
  const owners = workflowNodeOwners(
    document.nodes.map((entry) => entry.definition)
  );
  const edgesForScope = (ownerId: string | null) =>
    document.edges
      .filter((edge) => {
        const fromOwner = owners.get(edge.from.nodeId) ?? null;
        const toOwner = owners.get(edge.to.nodeId) ?? null;
        if (fromOwner === toOwner) return fromOwner === ownerId;
        return ownerId === null;
      })
      .map(toFlowgramEdge);
  const projectNode = (
    entry: FlowEditorDocumentV1["nodes"][number]
  ): WorkflowJSON["nodes"][number] => {
    const definition = entry.definition;
    const ownedNodeIds = structuredLoopOwnedNodeIds(definition);
    const semanticBlocks = ownedNodeIds.flatMap((nodeId) => {
      const child = entries.get(nodeId);
      return child && owners.get(nodeId) === definition.id
        ? [projectNode(child)]
        : [];
    });
    // Migrate older auto-sized containers once. Saved frames and anchor positions
    // subsequently stay independent of their children.
    if (definition.kind === "loop" && !entry.size && semanticBlocks.length) {
      const dx = Math.max(
        0,
        184 -
          Math.min(
            ...semanticBlocks.map((block) =>
              finiteCoordinate(block.meta?.position?.x, 184)
            )
          )
      );
      const dy = Math.max(
        0,
        156 -
          Math.min(
            ...semanticBlocks.map((block) =>
              finiteCoordinate(block.meta?.position?.y, 156)
            )
          )
      );
      for (const block of semanticBlocks) {
        block.meta = {
          ...block.meta,
          position: {
            x: finiteCoordinate(block.meta?.position?.x, 184) + dx,
            y: finiteCoordinate(block.meta?.position?.y, 156) + dy
          }
        };
      }
    }
    const boundary =
      definition.kind === "loop"
        ? loopBoundaryProjection(
            definition,
            semanticBlocks,
            entries,
            entry.loopAnchors
          )
        : undefined;
    const blocks = boundary
      ? [boundary.start, ...semanticBlocks, boundary.end]
      : semanticBlocks;
    const frameSize =
      definition.kind === "loop"
        ? (validFrameSize(entry.size) ?? initialLoopFrameSize(blocks))
        : undefined;
    return {
      id: entry.id,
      type: definition.kind,
      meta: {
        position: { ...entry.position },
        ...(frameSize ? { size: frameSize } : {})
      },
      data: {
        definition,
        portKeys: outputPorts(definition),
        ...(frameSize ? { frameSize } : {})
      },
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(definition.kind === "loop"
        ? {
            edges: [
              ...edgesForScope(definition.id),
              ...presentationEdgesForScope(document, definition.id),
              ...(boundary?.edges ?? [])
            ]
          }
        : {})
    };
  };

  return {
    nodes: document.nodes
      .filter((entry) => !owners.has(entry.id))
      .map(projectNode),
    edges: edgesForScope(null)
  };
}

export function mergeFlowgramDocument(
  flow: WorkflowJSON,
  current: FlowEditorDocumentV1
): FlowEditorDocumentV1 {
  const projectedNodes = flattenFlowgramNodes(flow.nodes);
  const allEdges = flattenFlowgramEdges(flow);
  const anchorIds = new Set(
    projectedNodes
      .filter((node) => isLoopAnchor(node.type))
      .map((node) => node.id)
  );
  const projectedEdges = allEdges.filter(
    (edge) =>
      !isPresentationEdge(edge) &&
      !anchorIds.has(edge.sourceNodeID) &&
      !anchorIds.has(edge.targetNodeID)
  );
  const projectedLoopBodies = flowgramLoopBodies(flow.nodes);
  const projectedNodesById = new Map(
    projectedNodes.map((node) => [node.id, node])
  );
  const existingNodes = current.nodes.flatMap((entry) => {
    const node = projectedNodesById.get(entry.id);
    if (!node) return [];
    const position = node.meta?.position;
    return [
      {
        id: entry.id,
        position: {
          x: finiteCoordinate(position?.x, entry.position.x),
          y: finiteCoordinate(position?.y, entry.position.y)
        },
        ...loopPresentation(node, entry),
        definition: syncProjectedLoopBody(
          entry.definition,
          projectedLoopBodies.get(entry.id),
          allEdges,
          projectedNodesById
        )
      }
    ];
  });
  const existingNodeIds = new Set(existingNodes.map((entry) => entry.id));
  const addedNodes = projectedNodes.flatMap((node, index) => {
    if (existingNodeIds.has(node.id)) return [];
    const definition = node.data?.definition as
      | WorkflowNodeDefinition
      | undefined;
    if (!definition) return [];
    const position = node.meta?.position;
    return [
      {
        id: node.id,
        position: {
          x: finiteCoordinate(position?.x, 120 + index * 260),
          y: finiteCoordinate(position?.y, 120)
        },
        definition
      }
    ];
  });
  const projectedEdgesById = new Map(
    projectedEdges.map((edge, index) => [flowgramEdgeId(edge, index), edge])
  );
  const existingEdges = current.edges.flatMap((edge) => {
    const projected = projectedEdgesById.get(edge.id);
    return projected ? [fromFlowgramEdge(projected, edge.id)] : [];
  });
  const existingEdgeIds = new Set(existingEdges.map((edge) => edge.id));
  const addedEdges = projectedEdges.flatMap((edge, index) => {
    const edgeId = flowgramEdgeId(edge, index);
    return existingEdgeIds.has(edgeId) ? [] : [fromFlowgramEdge(edge, edgeId)];
  });
  return {
    ...current,
    nodes: [...existingNodes, ...addedNodes],
    edges: [...existingEdges, ...addedEdges]
  };
}

function toFlowgramEdge(
  edge: FlowEditorDocumentV1["edges"][number]
): WorkflowJSON["edges"][number] {
  return {
    sourceNodeID: edge.from.nodeId,
    targetNodeID: edge.to.nodeId,
    ...(edge.from.port ? { sourcePortID: edge.from.port } : {}),
    ...(edge.to.port ? { targetPortID: edge.to.port } : {}),
    data: { edgeId: edge.id }
  };
}

function flattenFlowgramNodes(
  nodes: WorkflowJSON["nodes"]
): WorkflowJSON["nodes"] {
  return nodes.flatMap((node) => [
    node,
    ...flattenFlowgramNodes(node.blocks ?? [])
  ]);
}

function flattenFlowgramEdges(flow: WorkflowJSON): WorkflowJSON["edges"] {
  return [
    ...flow.edges,
    ...flattenFlowgramNodes(flow.nodes).flatMap((node) => node.edges ?? [])
  ];
}

function flowgramLoopBodies(
  nodes: WorkflowJSON["nodes"]
): Map<string, readonly string[]> {
  const bodies = new Map<string, readonly string[]>();
  for (const node of flattenFlowgramNodes(nodes)) {
    if (node.type === "loop") {
      bodies.set(
        node.id,
        (node.blocks ?? [])
          .filter((block) => block.data?.projectionOnly !== true)
          .map((block) => block.id)
      );
    }
  }
  return bodies;
}

function loopBoundaryProjection(
  loop: Extract<WorkflowNodeDefinition, { kind: "loop" }>,
  blocks: WorkflowJSON["nodes"],
  entries: ReadonlyMap<string, FlowEditorDocumentV1["nodes"][number]>,
  anchors?: FlowEditorDocumentV1["nodes"][number]["loopAnchors"]
): { start: FlowgramNode; end: FlowgramNode; edges: FlowgramEdge[] } {
  const positions = blocks.map((block) => ({
    block,
    x: finiteCoordinate(block.meta?.position?.x, 80),
    y: finiteCoordinate(block.meta?.position?.y, 120),
    size: projectedNodeSize(block)
  }));
  const startPosition =
    anchors?.start ?? horizontalBoundaryPosition(positions, "start");
  const endPosition =
    anchors?.end ?? horizontalBoundaryPosition(positions, "end");
  const startId = loopAnchorId(loop.id, "start");
  const endId = loopAnchorId(loop.id, "end");
  const anchorNode = (
    id: string,
    type: typeof LOOP_START_ANCHOR_TYPE | typeof LOOP_END_ANCHOR_TYPE,
    position: { x: number; y: number }
  ): FlowgramNode => ({
    id,
    type,
    meta: { position },
    data: {
      projectionOnly: true,
      loopId: loop.id
    }
  });
  // Static task nodes share one visible output. Keep every runtime exit on
  // that line: Flowgram identifies lines by their endpoint ports and otherwise
  // deduplicates success/failure exits when opening the editor.
  const exitGroups = new Map<
    string,
    {
      nodeId: string;
      port?: string;
      exits: (typeof loop.config.body.exits)[number][];
    }
  >();
  for (const exit of loop.config.body.exits) {
    const source = entries.get(exit.nodeId)?.definition;
    if (source?.kind === "break" || source?.kind === "continue") continue;
    const port =
      source && outputPorts(source).includes(exit.port ?? "")
        ? exit.port
        : undefined;
    const key = JSON.stringify([exit.nodeId, port]);
    const group = exitGroups.get(key) ?? {
      nodeId: exit.nodeId,
      port,
      exits: []
    };
    group.exits.push({ ...exit });
    exitGroups.set(key, group);
  }
  const edges: FlowgramEdge[] = [
    ...loop.config.body.entryNodeIds.map((nodeId, index) => ({
      sourceNodeID: startId,
      targetNodeID: nodeId,
      data: {
        edgeId: `${PRESENTATION_EDGE_PREFIX}loop-start:${loop.id}:${index}`,
        projectionOnly: true
      }
    })),
    ...[...exitGroups.values()].map((group, index) => ({
      sourceNodeID: group.nodeId,
      targetNodeID: endId,
      ...(group.port ? { sourcePortID: group.port } : {}),
      data: {
        edgeId: `${PRESENTATION_EDGE_PREFIX}loop-end:${loop.id}:${index}`,
        loopExits: group.exits,
        projectionOnly: true
      }
    }))
  ];
  return {
    start: anchorNode(startId, LOOP_START_ANCHOR_TYPE, startPosition),
    end: anchorNode(endId, LOOP_END_ANCHOR_TYPE, endPosition),
    edges
  };
}

function projectedNodeSize(node: FlowgramNode): {
  width: number;
  height: number;
} {
  if (
    node.type === LOOP_START_ANCHOR_TYPE ||
    node.type === LOOP_END_ANCHOR_TYPE
  ) {
    return { width: LOOP_ANCHOR_SIZE, height: LOOP_ANCHOR_SIZE };
  }
  if (node.type === "loop") {
    return (
      validFrameSize(node.data?.frameSize) ??
      initialLoopFrameSize(node.blocks ?? [])
    );
  }
  return { width: 360, height: node.type === "agent" ? 416 : 54 };
}

function horizontalBoundaryPosition(
  positions: readonly {
    x: number;
    y: number;
    size: { width: number; height: number };
  }[],
  side: "start" | "end"
): { x: number; y: number } {
  if (positions.length === 0) {
    return side === "start" ? { x: 24, y: 164 } : { x: 672, y: 164 };
  }
  const edgeX =
    side === "start"
      ? Math.min(...positions.map((position) => position.x))
      : Math.max(
          ...positions.map((position) => position.x + position.size.width)
        );
  const candidates = positions.filter((position) =>
    side === "start"
      ? Math.abs(position.x - edgeX) < 1
      : Math.abs(position.x + position.size.width - edgeX) < 1
  );
  const top = Math.min(...candidates.map((position) => position.y));
  const bottom = Math.max(
    ...candidates.map((position) => position.y + position.size.height)
  );
  return {
    x:
      side === "start"
        ? edgeX - LOOP_ANCHOR_SIZE - LOOP_ANCHOR_GAP
        : edgeX + LOOP_ANCHOR_GAP,
    y: (top + bottom - LOOP_ANCHOR_SIZE) / 2
  };
}

export function loopAnchorId(loopId: string, side: "start" | "end"): string {
  return `__kmux_loop_${side}:${loopId}`;
}

function syncProjectedLoopBody(
  definition: WorkflowNodeDefinition,
  projectedNodeIds: readonly string[] | undefined,
  edges: WorkflowJSON["edges"],
  projectedNodes: ReadonlyMap<string, FlowgramNode>
): WorkflowNodeDefinition {
  if (definition.kind !== "loop" || !projectedNodeIds) return definition;
  const maxGateNodeId =
    definition.config.mode === "while"
      ? definition.config.maxGate?.nodeId
      : undefined;
  const projectedBodyNodeIds = projectedNodeIds.filter(
    (nodeId) => nodeId !== maxGateNodeId
  );
  const bodyNodeIds = new Set(projectedBodyNodeIds);
  const startId = loopAnchorId(definition.id, "start");
  const endId = loopAnchorId(definition.id, "end");
  const entryNodeIds = edges.flatMap((edge) =>
    edge.sourceNodeID === startId && bodyNodeIds.has(edge.targetNodeID)
      ? [edge.targetNodeID]
      : []
  );
  const controls = projectedBodyNodeIds.flatMap<
    (typeof definition.config.body.exits)[number]
  >((nodeId) => {
    const type = projectedNodes.get(nodeId)?.type;
    const control = type === "break" || type === "continue" ? type : undefined;
    const saved = definition.config.body.exits.find(
      (exit) => exit.nodeId === nodeId && exit.port === undefined
    );
    return control
      ? [
          {
            ...(saved ?? { nodeId, outcome: `${control}:${nodeId}` }),
            action: control
          }
        ]
      : [];
  });
  const reservedOutcomes = new Set([
    ...controls.map((exit) => exit.outcome),
    ...edges.flatMap((edge) => {
      if (edge.targetNodeID !== endId) return [];
      const saved = edge.data?.loopExits as
        | typeof definition.config.body.exits
        | undefined;
      const single = edge.data?.loopExit as
        | (typeof definition.config.body.exits)[number]
        | undefined;
      return (
        saved?.map((exit) => exit.outcome) ?? (single ? [single.outcome] : [])
      );
    })
  ]);
  const exits = edges.flatMap((edge) => {
    if (edge.targetNodeID !== endId || !bodyNodeIds.has(edge.sourceNodeID))
      return [];
    const savedExits = edge.data?.loopExits as
      | typeof definition.config.body.exits
      | undefined;
    if (savedExits?.length)
      return savedExits.map((exit) => ({ ...exit, nodeId: edge.sourceNodeID }));
    const saved = edge.data?.loopExit as
      | (typeof definition.config.body.exits)[number]
      | undefined;
    const port = normalizeWorkflowCanvasPort(edge.sourcePortID) ?? saved?.port;
    const baseOutcome =
      saved?.outcome ??
      (definition.config.mode === "while"
        ? port &&
          [
            definition.config.repeatOutcome,
            ...definition.config.completedOutcomes
          ].includes(port)
          ? port
          : definition.config.repeatOutcome
        : "completed");
    let outcome = baseOutcome;
    if (!saved) {
      let ordinal = 2;
      while (reservedOutcomes.has(outcome))
        outcome = `${baseOutcome.slice(0, 115)}-${ordinal++}`;
      reservedOutcomes.add(outcome);
    }
    return [
      {
        nodeId: edge.sourceNodeID,
        ...(port ? { port } : {}),
        outcome,
        ...(saved?.action
          ? { action: saved.action }
          : definition.config.mode === "while" && !saved
            ? { action: "continue" as const }
            : {})
      }
    ];
  });
  return {
    ...definition,
    config: {
      ...definition.config,
      body: {
        ...definition.config.body,
        nodeIds: [...projectedBodyNodeIds],
        entryNodeIds: [...new Set(entryNodeIds)],
        exits: [
          ...exits,
          ...controls.filter(
            (control) => !exits.some((exit) => exit.nodeId === control.nodeId)
          )
        ]
      }
    }
  };
}

function isLoopAnchor(type: string | number): boolean {
  return type === LOOP_START_ANCHOR_TYPE || type === LOOP_END_ANCHOR_TYPE;
}

function validFrameSize(
  value: unknown
): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const size = value as { width?: number; height?: number };
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height))
    return undefined;
  return {
    width: Math.max(LOOP_FRAME_MIN_SIZE.width, size.width!),
    height: Math.max(LOOP_FRAME_MIN_SIZE.height, size.height!)
  };
}

function initialLoopFrameSize(blocks: WorkflowJSON["nodes"]): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(
      LOOP_FRAME_DEFAULT_SIZE.width,
      ...blocks.map(
        (block) =>
          finiteCoordinate(block.meta?.position?.x, 0) +
          projectedNodeSize(block).width +
          32
      )
    ),
    height: Math.max(
      LOOP_FRAME_DEFAULT_SIZE.height,
      ...blocks.map(
        (block) =>
          finiteCoordinate(block.meta?.position?.y, 0) +
          projectedNodeSize(block).height +
          48
      )
    )
  };
}

function loopPresentation(
  node: FlowgramNode,
  previous: FlowEditorDocumentV1["nodes"][number]
): Partial<FlowEditorDocumentV1["nodes"][number]> {
  if (node.type !== "loop") return {};
  const start = node.blocks?.find(
    (block) => block.type === LOOP_START_ANCHOR_TYPE
  )?.meta?.position;
  const end = node.blocks?.find((block) => block.type === LOOP_END_ANCHOR_TYPE)
    ?.meta?.position;
  return {
    size:
      validFrameSize(node.data?.frameSize) ??
      previous.size ??
      LOOP_FRAME_DEFAULT_SIZE,
    ...(start && end
      ? {
          loopAnchors: {
            start: {
              x: finiteCoordinate(start.x, 24),
              y: finiteCoordinate(start.y, 164)
            },
            end: {
              x: finiteCoordinate(end.x, 672),
              y: finiteCoordinate(end.y, 164)
            }
          }
        }
      : previous.loopAnchors
        ? { loopAnchors: previous.loopAnchors }
        : {})
  };
}

function flowgramEdgeId(
  edge: WorkflowJSON["edges"][number],
  index: number
): string {
  return typeof edge.data?.edgeId === "string"
    ? edge.data.edgeId
    : stableEdgeId(edge, index);
}

function fromFlowgramEdge(
  edge: WorkflowJSON["edges"][number],
  edgeId: string
): FlowEditorDocumentV1["edges"][number] {
  const sourcePort = normalizeWorkflowCanvasPort(edge.sourcePortID);
  const targetPort = normalizeWorkflowCanvasPort(edge.targetPortID);
  return {
    id: edgeId,
    from: {
      nodeId: edge.sourceNodeID,
      ...(sourcePort === undefined ? {} : { port: sourcePort })
    },
    to: {
      nodeId: edge.targetNodeID,
      ...(targetPort === undefined ? {} : { port: targetPort })
    }
  };
}

export function replaceNodeDefinition(
  document: FlowEditorDocumentV1,
  definition: WorkflowNodeDefinition
): FlowEditorDocumentV1 {
  const previous = document.nodes.find(
    (entry) => entry.id === definition.id
  )?.definition;
  const removed = new Set(
    previous?.kind === "condition" && definition.kind === "condition"
      ? previous.config.ports.filter(
          (port) => !definition.config.ports.includes(port)
        )
      : []
  );
  return {
    ...document,
    edges: document.edges.filter(
      (edge) =>
        !(
          edge.from.nodeId === definition.id &&
          edge.from.port &&
          removed.has(edge.from.port)
        )
    ),
    nodes: document.nodes.map((entry) =>
      entry.id === definition.id
        ? { ...entry, id: definition.id, definition }
        : entry.definition.kind === "loop" && removed.size
          ? {
              ...entry,
              definition: {
                ...entry.definition,
                config: {
                  ...entry.definition.config,
                  body: {
                    ...entry.definition.config.body,
                    exits: entry.definition.config.body.exits.filter(
                      (exit) =>
                        !(
                          exit.nodeId === definition.id &&
                          exit.port &&
                          removed.has(exit.port)
                        )
                    )
                  }
                }
              }
            }
          : entry
    )
  };
}

export function removeStudioNode(
  document: FlowEditorDocumentV1,
  nodeId: string
): FlowEditorDocumentV1 {
  const entries = new Map(document.nodes.map((entry) => [entry.id, entry]));
  const removedNodeIds = new Set<string>();
  const collect = (candidateId: string) => {
    if (removedNodeIds.has(candidateId)) return;
    removedNodeIds.add(candidateId);
    const definition = entries.get(candidateId)?.definition;
    if (definition?.kind === "loop") {
      structuredLoopOwnedNodeIds(definition).forEach(collect);
    }
  };
  collect(nodeId);

  const removedAgentRefs = new Set(
    document.nodes.flatMap((entry) =>
      removedNodeIds.has(entry.id) && entry.definition.kind === "agent"
        ? [entry.definition.config.agentRef]
        : []
    )
  );
  const survivingAgentRefs = new Set(
    document.nodes.flatMap((entry) =>
      !removedNodeIds.has(entry.id) && entry.definition.kind === "agent"
        ? [entry.definition.config.agentRef]
        : []
    )
  );
  const removedInputIds = new Set<string>();
  const agentBindings = Object.fromEntries(
    Object.entries(document.workflow.agentBindings).flatMap(
      ([agentRef, binding]) => {
        if (
          removedAgentRefs.has(agentRef) &&
          !survivingAgentRefs.has(agentRef)
        ) {
          if (binding.agent.kind === "run-input") {
            removedInputIds.add(binding.agent.inputId);
          }
          return [];
        }
        return [[agentRef, binding]];
      }
    )
  );
  const nodes = document.nodes.flatMap((entry) => {
    if (removedNodeIds.has(entry.id)) return [];
    if (entry.definition.kind !== "loop") return [entry];
    const body = entry.definition.config.body;
    const config = {
      ...entry.definition.config,
      body: {
        ...body,
        nodeIds: body.nodeIds.filter(
          (candidateId) => !removedNodeIds.has(candidateId)
        ),
        entryNodeIds: body.entryNodeIds.filter(
          (candidateId) => !removedNodeIds.has(candidateId)
        ),
        exits: body.exits.filter((exit) => !removedNodeIds.has(exit.nodeId))
      },
      ...(entry.definition.config.mode === "while" &&
      entry.definition.config.maxGate &&
      removedNodeIds.has(entry.definition.config.maxGate.nodeId)
        ? { maxGate: undefined }
        : {})
    } as typeof entry.definition.config;
    return [
      {
        ...entry,
        definition: { ...entry.definition, config }
      }
    ];
  });

  return {
    ...document,
    workflow: {
      ...document.workflow,
      inputs: document.workflow.inputs.filter(
        (input) =>
          !removedInputIds.has(input.id) ||
          !input.id.startsWith("agent-selector-") ||
          referencesRunInput(
            [nodes, agentBindings, document.workflow.outputs],
            input.id
          )
      ),
      agentBindings
    },
    nodes,
    edges: document.edges.filter(
      (edge) =>
        !removedNodeIds.has(edge.from.nodeId) &&
        !removedNodeIds.has(edge.to.nodeId)
    )
  };
}

/** Layout and generated version numbers do not change execution behavior. */
export function sameWorkflowExecution(
  left: WorkflowDefinitionV1,
  right: WorkflowDefinitionV1
): boolean {
  const key = (definition: WorkflowDefinitionV1) =>
    stableWorkflowJson({ ...definition, version: 1 });
  return key(left) === key(right);
}

function stableWorkflowJson(input: unknown): string {
  return JSON.stringify(input, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  );
}

/** A new run keeps the layout the user just saved; older runs keep theirs. */
export function sameWorkflowLayout(
  left: FlowEditorDocumentV1,
  right: FlowEditorDocumentV1
): boolean {
  const layout = (document: FlowEditorDocumentV1) =>
    document.nodes.map(({ id, position, size, loopAnchors }) => ({
      id,
      position,
      size,
      loopAnchors
    }));
  return stableWorkflowJson(layout(left)) === stableWorkflowJson(layout(right));
}

export function compileEditorCanonical(
  document: FlowEditorDocumentV1
): WorkflowDefinitionV1 {
  return {
    ...document.workflow,
    nodes: document.nodes.map((entry) => entry.definition),
    edges: document.edges
  };
}

export function createStudioNode(
  kind: WorkflowNodeDefinition["kind"],
  id: string
): WorkflowNodeDefinition {
  const base = { id, title: nodeKindLabel(kind) };
  switch (kind) {
    case "break":
    case "continue":
    case "start":
      return { ...base, kind, config: { version: 1 } };
    case "end":
      return {
        ...base,
        kind,
        config: { version: 1 },
        completionRoot: true
      };
    case "agent":
      return {
        ...base,
        kind,
        config: {
          version: 1,
          agentRef: `agent-${id}`,
          prompt: "Describe the task and the evidence required for completion.",
          lifecycleMode: "managed",
          coding: true
        },
        onFailure: "fail-run",
        onCancel: "fail-run"
      };
    case "shell":
      return {
        ...base,
        kind,
        config: {
          version: 1,
          command: { kind: "structured", executable: "", args: [] },
          targetPolicy: "local",
          surfacePolicy: "create",
          cwdPolicy: "workspace",
          resultMode: "json-stdout",
          maxOutputBytes: 1024 * 1024
        },
        onFailure: "fail-run",
        onCancel: "fail-run"
      };
    case "condition":
      return {
        ...base,
        kind,
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "false",
          conditions: [
            {
              key: "if_1",
              left: { kind: "node-result", nodeId: "" },
              operator: "eq",
              right: { kind: "literal", value: 0 }
            }
          ],
          ports: ["if_1", "else"]
        }
      };
    case "loop":
      return {
        ...base,
        kind,
        config: {
          version: 1,
          mode: "while",
          maxIterations: 3,
          body: { nodeIds: [], entryNodeIds: [], exits: [] },
          repeatOutcome: "continue",
          completedOutcomes: [],
          completedPort: "completed",
          maxReachedPort: "max-reached"
        }
      };
    case "human-gate":
      return {
        ...base,
        kind,
        config: {
          version: 1,
          question: "Approve this step?",
          resolutions: ["approve", "reject"],
          approverPolicy: "local-user"
        }
      };
  }
}

export function nodeKindLabel(kind: WorkflowNodeDefinition["kind"]): string {
  if (kind === "shell") return "Shell Terminal";
  if (kind === "agent") return "AI Agent CLI";
  return kind
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function outputPorts(definition: WorkflowNodeDefinition): string[] {
  if (definition.kind === "condition") return [...definition.config.ports];
  if (definition.kind === "loop") {
    return [
      ...new Set([
        definition.config.completedPort,
        definition.config.maxReachedPort,
        ...(definition.config.mode === "while" && definition.config.maxGate
          ? definition.config.maxGate.completedResolutions.map(
              (resolution) => resolution.port
            )
          : [])
      ])
    ];
  }
  if (definition.kind === "human-gate") {
    return [...definition.config.resolutions];
  }
  return [];
}

function presentationEdgesForScope(
  document: FlowEditorDocumentV1,
  scopeId: WorkflowScopeId
): FlowgramEdge[] {
  if (scopeId === null) return [];
  const loop = document.nodes.find((entry) => entry.id === scopeId)?.definition;
  if (!loop) return [];
  const route = loopMaxGateRoute(loop);
  if (!route) return [];
  return [
    {
      sourceNodeID: route.sourceNodeId,
      targetNodeID: route.gateNodeId,
      ...(route.sourcePort ? { sourcePortID: route.sourcePort } : {}),
      data: {
        edgeId: `${PRESENTATION_EDGE_PREFIX}max-gate:${route.loopNodeId}`,
        projectionOnly: true,
        label: "max reached"
      }
    }
  ];
}

function isPresentationEdge(edge: FlowgramEdge): boolean {
  return (
    edge.data?.projectionOnly === true ||
    (typeof edge.data?.edgeId === "string" &&
      edge.data.edgeId.startsWith(PRESENTATION_EDGE_PREFIX))
  );
}

function finiteCoordinate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stableEdgeId(
  edge: WorkflowJSON["edges"][number],
  index: number
): string {
  return [
    "edge",
    edge.sourceNodeID,
    edge.sourcePortID ?? "default",
    edge.targetNodeID,
    edge.targetPortID ?? "default",
    index
  ].join(":");
}

/** Selecting a provider must not delete inputs still used by typed dataflow. */
export function replaceAgentSelector(
  document: FlowEditorDocumentV1,
  agentRef: string,
  selector: AgentSelector
): FlowEditorDocumentV1 {
  const binding = document.workflow.agentBindings[agentRef];
  if (!binding) return document;
  const changed =
    binding.agent.kind !== selector.kind ||
    (binding.agent.kind === "agent-id" && selector.kind === "agent-id"
      ? binding.agent.agentId !== selector.agentId
      : binding.agent.kind === "run-input" &&
        selector.kind === "run-input" &&
        binding.agent.inputId !== selector.inputId);
  const requiredCapabilities =
    binding.agent.kind === "run-input"
      ? binding.agent.requiredCapabilities
      : undefined;
  const agentBindings = {
    ...document.workflow.agentBindings,
    [agentRef]: {
      ...binding,
      ...(changed ? { launch: undefined } : {}),
      ...(selector.kind === "caller"
        ? {
            scope: { kind: "run" as const },
            targetPolicy: "local" as const,
            worktreePolicy: "current" as const,
            inputMode: "orchestrated" as const,
            surfacePolicy: "create-or-reuse" as const,
            sessionPolicy: "reuse" as const,
            existingSurfaceId: undefined,
            targetRef: undefined,
            worktreeInput: undefined,
            allowSharedWrite: undefined
          }
        : {}),
      ...(selector.kind === "agent-id" && requiredCapabilities?.length
        ? {
            capabilities: [
              ...new Set([
                ...(binding.capabilities ?? []),
                ...requiredCapabilities
              ])
            ]
          }
        : {}),
      agent:
        selector.kind === "run-input"
          ? {
              ...selector,
              ...(requiredCapabilities ? { requiredCapabilities } : {})
            }
          : selector
    }
  };
  let inputs = document.workflow.inputs;
  if (binding.agent.kind === "run-input") {
    const previousId = binding.agent.inputId;
    if (
      previousId.startsWith("agent-selector-") &&
      !referencesRunInput(
        [document.nodes, agentBindings, document.workflow.outputs],
        previousId
      )
    ) {
      inputs = inputs.filter((input) => input.id !== previousId);
    }
  }
  if (
    selector.kind === "run-input" &&
    !inputs.some((input) => input.id === selector.inputId)
  ) {
    inputs = [
      ...inputs,
      {
        id: selector.inputId,
        required: true,
        schema: { schema: { type: "string", minLength: 1 } }
      }
    ];
  }
  return {
    ...document,
    nodes: changed
      ? document.nodes.map((entry) =>
          entry.definition.kind === "agent" &&
          entry.definition.config.agentRef === agentRef
            ? {
                ...entry,
                definition: {
                  ...entry.definition,
                  config: { ...entry.definition.config, launch: undefined }
                }
              }
            : entry
        )
      : document.nodes,
    workflow: { ...document.workflow, inputs, agentBindings }
  };
}

function referencesRunInput(value: unknown, inputId: string): boolean {
  if (Array.isArray(value))
    return value.some((entry) => referencesRunInput(entry, inputId));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "run-input" && record.inputId === inputId) ||
    Object.values(record).some((entry) => referencesRunInput(entry, inputId))
  );
}
