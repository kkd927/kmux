import { structuredLoopOwnedNodeIds } from "./scopes";
import {
  OrchestrationError,
  type ValidationIssue,
  type WorkflowControlEdge,
  type WorkflowNodeDefinition
} from "./types";

/** Canonical Loop boundaries and termination routes shared by publish and Patch. */
export function validateLoopTemplates(
  definitions: readonly WorkflowNodeDefinition[],
  edges: readonly WorkflowControlEdge[]
) {
  const byId = new Map(definitions.map((node) => [node.id, node]));
  const owners = new Map<string, string>();
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    path: readonly (string | number)[],
    message: string
  ) => issues.push({ code, path, message });
  for (const [index, loop] of definitions.entries()) {
    if (loop.kind !== "loop") continue;
    const base = ["nodes", index, "config"];
    for (const id of structuredLoopOwnedNodeIds(loop)) {
      if (!byId.has(id))
        add(
          "unknown_loop_body_node",
          base,
          `Loop '${loop.id}' references missing body node '${id}'`
        );
      if (owners.has(id))
        add(
          "ambiguous_loop_owner",
          base,
          `Loop body '${id}' has more than one owner`
        );
      else owners.set(id, loop.id);
    }
    const members = new Set(loop.config.body.nodeIds);
    for (const [entryIndex, id] of loop.config.body.entryNodeIds.entries()) {
      if (!members.has(id))
        add(
          "invalid_loop_entry",
          [...base, "body", "entryNodeIds", entryIndex],
          `Loop entry '${id}' is not a direct body member`
        );
    }
    const outcomes = new Set<string>();
    for (const [exitIndex, exit] of loop.config.body.exits.entries()) {
      const path = [...base, "body", "exits", exitIndex];
      if (!members.has(exit.nodeId))
        add(
          "invalid_loop_exit",
          [...path, "nodeId"],
          `Loop exit '${exit.nodeId}' is not a direct body member`
        );
      const node = byId.get(exit.nodeId);
      if (node && !isValidOutputPort(node, exit.port))
        add(
          "unknown_port",
          [...path, "port"],
          `Loop exit port '${exit.port ?? "default"}' is not declared by '${exit.nodeId}'`
        );
      if (outcomes.has(exit.outcome))
        add(
          "duplicate_loop_outcome",
          [...path, "outcome"],
          `Loop body outcome '${exit.outcome}' is duplicated`
        );
      outcomes.add(exit.outcome);
    }
    if (loop.config.mode !== "while") continue;
    if (
      !loop.config.body.exits.some(
        (exit) =>
          exit.action ||
          byId.get(exit.nodeId)?.kind === "continue" ||
          byId.get(exit.nodeId)?.kind === "break"
      ) &&
      !outcomes.has(loop.config.repeatOutcome)
    )
      add(
        "unknown_loop_outcome",
        [...base, "repeatOutcome"],
        `repeat outcome '${loop.config.repeatOutcome}' is not declared by the body`
      );
    for (const outcome of loop.config.completedOutcomes) {
      if (!outcomes.has(outcome))
        add(
          "unknown_loop_outcome",
          [...base, "completedOutcomes"],
          `completed outcome '${outcome}' is not declared by the body`
        );
    }
    const maxGate = loop.config.maxGate;
    if (!maxGate) continue;
    const gate = byId.get(maxGate.nodeId);
    if (gate?.kind !== "human-gate") {
      add(
        "invalid_loop_gate",
        [...base, "maxGate", "nodeId"],
        `Loop maximum gate '${maxGate.nodeId}' must reference a Human Gate`
      );
      continue;
    }
    if (members.has(gate.id))
      add(
        "invalid_loop_gate_member",
        [...base, "maxGate", "nodeId"],
        "the maximum-reached Human Gate must not also run in every body iteration"
      );
    const routed = new Set<string>();
    const routes = [
      { resolution: maxGate.retryResolution, path: ["retryResolution"] },
      { resolution: maxGate.abortResolution, path: ["abortResolution"] },
      ...maxGate.completedResolutions.map((route, ordinal) => ({
        resolution: route.resolution,
        path: ["completedResolutions", ordinal, "resolution"]
      }))
    ];
    for (const route of routes) {
      const path = [...base, "maxGate", ...route.path];
      if (!gate.config.resolutions.includes(route.resolution))
        add(
          "invalid_loop_gate_resolution",
          path,
          `Human Gate '${gate.id}' does not declare resolution '${route.resolution}'`
        );
      if (routed.has(route.resolution))
        add(
          "ambiguous_loop_gate_resolution",
          path,
          `Human Gate resolution '${route.resolution}' must select exactly one Loop action`
        );
      routed.add(route.resolution);
    }
    for (const resolution of gate.config.resolutions) {
      if (!routed.has(resolution))
        add(
          "unrouted_loop_gate_resolution",
          [...base, "maxGate"],
          `Human Gate resolution '${resolution}' has no Loop action`
        );
    }
  }
  for (const id of owners.keys()) {
    const visited = new Set<string>([id]);
    let parent = owners.get(id);
    while (parent) {
      if (visited.has(parent)) {
        add(
          "invalid_loop_body",
          ["nodes"],
          "Loop ownership cannot contain a cycle"
        );
        break;
      }
      visited.add(parent);
      parent = owners.get(parent);
    }
  }
  for (const [index, edge] of edges.entries()) {
    const source = byId.get(edge.from.nodeId);
    if (source?.kind === "break" || source?.kind === "continue")
      add(
        "invalid_loop_control_edge",
        ["edges", index],
        "Break and Continue finish an iteration and cannot have outgoing edges"
      );
    if (owners.get(edge.from.nodeId) !== owners.get(edge.to.nodeId))
      add(
        "invalid_loop_edge",
        ["edges", index],
        "control edges must stay within one Loop scope; connect through Loop entry/exit ports"
      );
  }
  for (const [index, node] of definitions.entries()) {
    if (node.kind !== "break" && node.kind !== "continue") continue;
    const owner = byId.get(owners.get(node.id) ?? "");
    if (
      owner?.kind !== "loop" ||
      !owner.config.body.exits.some(
        (exit) => exit.nodeId === node.id && exit.port === undefined
      )
    )
      add(
        "invalid_loop_control_scope",
        ["nodes", index],
        "Break and Continue must be declared as terminal exits of their Loop"
      );
  }
  return { owners, issues };
}

/** One partition for saved definitions and newly authored adaptive Loop bodies. */
export function compileLoopTemplates(
  definitions: readonly WorkflowNodeDefinition[],
  edges: readonly WorkflowControlEdge[]
) {
  const { owners, issues } = validateLoopTemplates(definitions, edges);
  if (issues.length)
    throw new OrchestrationError("invalid", issues[0]!.message);
  const isBodyEdge = (edge: WorkflowControlEdge) =>
    owners.has(edge.from.nodeId) || owners.has(edge.to.nodeId);
  return {
    owners,
    roots: definitions.filter((node) => !owners.has(node.id)),
    bodyTemplates: Object.fromEntries(
      definitions
        .filter((node) => owners.has(node.id))
        .map((node) => [node.id, node])
    ),
    edges: edges.filter((edge) => !isBodyEdge(edge)),
    bodyTemplateEdges: edges.filter(isBodyEdge)
  };
}

export function isValidOutputPort(
  node: WorkflowNodeDefinition,
  port: string | undefined
): boolean {
  if (node.kind === "condition")
    return (
      port !== undefined &&
      (node.config.ports.includes(port) || node.config.errorPort === port)
    );
  if (node.kind === "loop")
    return (
      port !== undefined &&
      [
        node.config.completedPort,
        node.config.maxReachedPort,
        ...(node.config.mode === "while" && node.config.maxGate
          ? node.config.maxGate.completedResolutions.map(
              (resolution) => resolution.port
            )
          : [])
      ].includes(port)
    );
  if (node.kind === "human-gate")
    return port !== undefined && node.config.resolutions.includes(port);
  return (
    port === undefined ||
    port === "success" ||
    port === "failure" ||
    port === "canceled"
  );
}
