import {
  canonicalJson,
  contentHash,
  deepClone,
  workflowContentHash
} from "./canonical";
import type {
  CoordinatorAttachment,
  GraphPatch,
  GraphPatchReceipt,
  Id,
  JsonValue,
  OrchestrationSnapshot,
  RunNode,
  WorkflowDefinitionV1,
  WorkflowControlEdge,
  WorkflowRun,
  WorkflowVersion
} from "./types";
import { OrchestrationError } from "./types";
import { validateJsonSchemaValue } from "./schema";
import { compileLoopTemplates } from "./loopTemplates";
import { workflowRequiresCaller } from "./editorDocument";
import { structuredLoopOwnedNodeIds } from "./scopes";
import {
  findCycle,
  maximumDepth,
  workflowDependencyGraph
} from "./dependencyGraph";
import {
  type RuntimeContext,
  emptyCounters,
  createRunDeadlineTimer,
  stale,
  budget,
  assertRunTimeBudgets,
  mutableClone,
  type Mutable,
  requireNode,
  TERMINAL_NODE_STATES
} from "./runtimeState";
import { beginCoordinatorTurn } from "./runtimeMailbox";
import { recomputeRun, resolveSourceNode } from "./runtimeScheduling";

export function createEmptyOrchestrationSnapshot(): OrchestrationSnapshot {
  return {
    storeVersion: 1,
    revision: 0,
    workflowVersions: {},
    workflowDrafts: {},
    runs: {},
    auditEvents: [],
    capabilities: {},
    currentRunByPrincipal: {},
    idempotency: {}
  };
}

export function createAdaptiveRun(input: {
  runId: Id;
  objective: string;
  inputs?: Readonly<Record<string, JsonValue>>;
  limits: WorkflowDefinitionV1["policies"]["limits"];
  coordinatorAttachment?: NonNullable<WorkflowRun["coordinatorAttachment"]>;
  context: RuntimeContext;
}): WorkflowRun {
  const createdAt = input.context.now();
  const run: WorkflowRun = {
    runId: input.runId,
    workerTerminalPolicy: { succeeded: "retain", failed: "retain" },
    source: { kind: "ad-hoc", objective: input.objective },
    createdAt,
    startedAt: createdAt,
    status: "waiting-for-coordinator",
    graph: {
      revision: 0,
      authoringState: "open",
      nodes: {},
      edges: [],
      bodyTemplates: {},
      bodyTemplateEdges: [],
      agentBindings: {},
      patches: []
    },
    inputs: input.inputs ?? {},
    declaredOutputs: [],
    limits: deepClone(input.limits),
    counters: { ...emptyCounters(), coordinatorTurns: 1 },
    coordinationAuthorityEpoch: 1,
    coordinatorEventCursor: 1,
    coordinatorConsumedCursor: 0,
    attempts: {},
    shellOperations: {},
    dispatches: {},
    readinessReceipts: {},
    deliveries: {},
    results: {},
    attemptResults: {},
    resultReceipts: {},
    cancellations: {},
    manualRetries: {},
    leases: {},
    inputControls: {},
    inputInterventions: [],
    messages: [],
    mailboxSequence: 0,
    mailboxEvents: [],
    mailboxConsumers: {},
    gates: {},
    coordinatorTurns: [
      {
        turnId: input.context.id("coordinator-turn"),
        runId: input.runId,
        authorityEpoch: 1,
        wakeReason: "objective",
        eventCursorStart: 1,
        eventCursorEnd: 1,
        startingGraphRevision: 0,
        status: "pending",
        idempotencyKey: input.context.id("coordinator-turn-key")
      }
    ],
    ...(input.coordinatorAttachment
      ? { coordinatorAttachment: deepClone(input.coordinatorAttachment) }
      : {}),
    tasks: {},
    timers: createRunDeadlineTimer(
      input.runId,
      createdAt,
      input.limits,
      input.context
    )
  };
  if (!input.coordinatorAttachment) return run;
  const turn = run.coordinatorTurns[0]!;
  // An authenticated invocation from an Agent is already the initial
  // Coordinator Turn. Do not manufacture a second Coordinator node or inject
  // another prompt into that same foreground Agent. The host generation-fences
  // the terminal and commits this turn when the first Worker is dispatched.
  return beginCoordinatorTurn({
    run,
    turnId: turn.turnId,
    idempotencyKey: turn.idempotencyKey
  });
}

export function materializeWorkflowRun(input: {
  runId: Id;
  version: WorkflowVersion;
  inputs: Readonly<Record<string, JsonValue>>;
  callerAttachment?: CoordinatorAttachment;
  context: RuntimeContext;
}): WorkflowRun {
  if (
    workflowContentHash(input.version.definition) !== input.version.contentHash
  ) {
    throw new OrchestrationError(
      "conflict",
      "workflow version content hash does not match its definition"
    );
  }
  if (
    workflowRequiresCaller(input.version.definition) &&
    !input.callerAttachment
  ) {
    throw new OrchestrationError(
      "invalid",
      "This Workflow requires a calling Agent. Invoke it from an existing Agent conversation using kmux-orchestration."
    );
  }
  const resolvedInputs: Record<string, JsonValue> = {};
  for (const workflowInput of input.version.definition.inputs) {
    const provided = input.inputs[workflowInput.id];
    const value = provided === undefined ? workflowInput.default : provided;
    if (workflowInput.required && value === undefined) {
      throw new OrchestrationError(
        "invalid",
        `required workflow input '${workflowInput.id}' is missing`
      );
    }
    if (value !== undefined && workflowInput.schema) {
      const validated = validateJsonSchemaValue(workflowInput.schema, value);
      if (!validated.ok) {
        throw new OrchestrationError(
          "invalid",
          `workflow input '${workflowInput.id}' does not match its schema`,
          { issues: validated.issues as unknown as JsonValue }
        );
      }
    }
    if (value !== undefined)
      resolvedInputs[workflowInput.id] = deepClone(value);
  }
  const createdAt = input.context.now();
  const compiled = compileLoopTemplates(
    input.version.definition.nodes,
    input.version.definition.edges
  );
  const initialDefinitions = compiled.roots;
  const nodes = Object.fromEntries(
    initialDefinitions.map((definition) => [
      definition.id,
      {
        nodeId: definition.id,
        definition: deepClone(definition),
        definitionHash: contentHash(definition as unknown as JsonValue),
        stateRevision: 0,
        status: "pending" as const,
        selectedPredecessors: [],
        attemptIds: []
      }
    ])
  );
  let run: WorkflowRun = {
    runId: input.runId,
    workerTerminalPolicy: { succeeded: "retain", failed: "retain" },
    ...(input.callerAttachment
      ? { coordinatorAttachment: deepClone(input.callerAttachment) }
      : {}),
    source: {
      kind: "workflow-version",
      workflowVersionId: input.version.workflowVersionId,
      contentHash: input.version.contentHash
    },
    createdAt,
    startedAt: createdAt,
    status: "running",
    graph: {
      revision: 1,
      authoringState: "sealed",
      nodes,
      edges: deepClone(compiled.edges),
      bodyTemplates: deepClone(compiled.bodyTemplates),
      bodyTemplateEdges: deepClone(compiled.bodyTemplateEdges),
      agentBindings: deepClone(input.version.definition.agentBindings),
      patches: [],
      sealedAt: createdAt,
      sealReceiptId: input.context.id("seal-receipt")
    },
    inputs: resolvedInputs,
    declaredOutputs: deepClone(input.version.definition.outputs),
    limits: deepClone(input.version.definition.policies.limits),
    counters: {
      ...emptyCounters(),
      nodes: initialDefinitions.length,
      edges: compiled.edges.length
    },
    coordinationAuthorityEpoch: 1,
    coordinatorEventCursor: 0,
    coordinatorConsumedCursor: 0,
    attempts: {},
    shellOperations: {},
    dispatches: {},
    readinessReceipts: {},
    deliveries: {},
    results: {},
    attemptResults: {},
    resultReceipts: {},
    cancellations: {},
    manualRetries: {},
    leases: {},
    inputControls: {},
    inputInterventions: [],
    messages: [],
    mailboxSequence: 0,
    mailboxEvents: [],
    mailboxConsumers: {},
    gates: {},
    coordinatorTurns: [],
    tasks: {},
    timers: createRunDeadlineTimer(
      input.runId,
      createdAt,
      input.version.definition.policies.limits,
      input.context
    )
  };
  run = recomputeRun(run, input.context);
  return run;
}

export function applyGraphPatch(
  source: WorkflowRun,
  patch: GraphPatch,
  context: RuntimeContext
): { readonly run: WorkflowRun; readonly receipt: GraphPatchReceipt } {
  if (patch.runId !== source.runId) {
    throw new OrchestrationError(
      "unauthorized",
      "Graph Patch is scoped to another Run"
    );
  }
  const patchHash = contentHash(patch as unknown as JsonValue);
  const replay = source.graph.patches.find(
    (receipt) => receipt.idempotencyKey === patch.idempotencyKey
  );
  if (replay) {
    if (replay.patchHash !== patchHash) {
      throw new OrchestrationError(
        "conflict",
        "Graph Patch idempotency key was reused with different content"
      );
    }
    return { run: source, receipt: replay };
  }
  if (source.graph.authoringState !== "open") {
    throw new OrchestrationError(
      "sealed",
      "sealed Run Graph rejects authoring Patches"
    );
  }
  if (patch.authorityEpoch !== source.coordinationAuthorityEpoch) {
    throw new OrchestrationError(
      "unauthorized",
      "stale Coordinator authority epoch"
    );
  }
  if (patch.expectedGraphRevision !== source.graph.revision) {
    throw stale(
      "Graph Patch",
      source.graph.revision,
      patch.expectedGraphRevision
    );
  }
  if (source.counters.graphPatches >= source.limits.maxGraphPatches) {
    throw budget("maxGraphPatches");
  }
  assertRunTimeBudgets(source, context.now());

  const run = mutableClone(source);
  const priorRevision = run.graph.revision;
  for (const operation of patch.operations) {
    switch (operation.kind) {
      case "add-node": {
        if (
          run.graph.nodes[operation.node.id] ||
          run.graph.bodyTemplates[operation.node.id]
        ) {
          throw new OrchestrationError(
            "conflict",
            `node '${operation.node.id}' already exists`
          );
        }
        if (run.counters.nodes >= run.limits.maxNodes) throw budget("maxNodes");
        validatePatchedNode(operation.node, run);
        run.graph.nodes[operation.node.id] = {
          nodeId: operation.node.id,
          definition: deepClone(operation.node) as Mutable<
            typeof operation.node
          >,
          definitionHash: contentHash(operation.node as unknown as JsonValue),
          stateRevision: 0,
          status: "pending",
          selectedPredecessors: [],
          attemptIds: []
        };
        run.counters.nodes += 1;
        break;
      }
      case "replace-pending-node": {
        const existing = requireNode(run, operation.node.id);
        requireMutablePending(existing, operation.expectedNodeStateRevision);
        validatePatchedNode(operation.node, run);
        if (
          existing.materialization &&
          canonicalJson(
            existing.definition.kind === "loop"
              ? [...structuredLoopOwnedNodeIds(existing.definition)]
              : []
          ) !== canonicalJson([...structuredLoopOwnedNodeIds(operation.node)])
        ) {
          throw new OrchestrationError(
            "immutable",
            "materialized nodes cannot change their frozen Loop body templates"
          );
        }
        existing.definition = {
          ...deepClone(operation.node),
          id: existing.definition.id
        } as Mutable<typeof operation.node>;
        existing.definitionHash = contentHash(
          existing.definition as unknown as JsonValue
        );
        if (existing.materialization) {
          const definition = existing.definition;
          compileLoopTemplates(
            authoredWorkflowNodes(run).map((template) =>
              template.id === definition.id ? definition : template
            ),
            run.graph.bodyTemplateEdges
          );
        }
        existing.stateRevision += 1;
        break;
      }
      case "add-edge": {
        if (
          [...run.graph.edges, ...run.graph.bodyTemplateEdges].some(
            (edge) => edge.id === operation.edge.id
          )
        ) {
          throw new OrchestrationError(
            "conflict",
            `edge '${operation.edge.id}' already exists`
          );
        }
        if (run.counters.edges >= run.limits.maxEdges) throw budget("maxEdges");
        const target = requireNode(run, operation.edge.to.nodeId);
        requireMutablePending(
          target,
          operation.expectedTargetNodeStateRevision
        );
        requireNode(run, operation.edge.from.nodeId);
        if (operation.edge.from.nodeId === operation.edge.to.nodeId) {
          throw new OrchestrationError(
            "invalid",
            "self edges are unsupported; use a Loop node"
          );
        }
        run.graph.edges.push(
          deepClone(operation.edge) as Mutable<typeof operation.edge>
        );
        run.counters.edges += 1;
        target.stateRevision += 1;
        break;
      }
      case "add-binding": {
        if (run.graph.agentBindings[operation.agentRef]) {
          throw new OrchestrationError(
            "conflict",
            `agent binding '${operation.agentRef}' already exists`
          );
        }
        run.graph.agentBindings[operation.agentRef] = deepClone(
          operation.binding
        ) as Mutable<typeof operation.binding>;
        break;
      }
      default:
        throw new OrchestrationError(
          "unsupported",
          `Graph Patch operation '${String((operation as { kind?: unknown }).kind)}' is unsupported`
        );
    }
  }
  compilePatchedLoopTemplates(run, source, patch);
  assertGraphStructuralLimits(run);
  run.graph.revision += 1;
  run.counters.graphPatches += 1;
  const receipt: GraphPatchReceipt = {
    receiptId: context.id("graph-patch-receipt"),
    runId: run.runId,
    idempotencyKey: patch.idempotencyKey,
    patchHash,
    previousGraphRevision: priorRevision,
    graphRevision: run.graph.revision,
    appliedAt: context.now()
  };
  run.graph.patches.push(receipt as Mutable<GraphPatchReceipt>);
  return { run: recomputeRun(run, context), receipt };
}

export function sealRunGraph(input: {
  run: WorkflowRun;
  expectedGraphRevision: number;
  consumedEventCursor: number;
  authorityEpoch: number;
  idempotencyKey: Id;
  context: RuntimeContext;
}): WorkflowRun {
  if (input.run.graph.authoringState === "sealed") return input.run;
  if (input.authorityEpoch !== input.run.coordinationAuthorityEpoch) {
    throw new OrchestrationError(
      "unauthorized",
      "stale Coordinator authority epoch"
    );
  }
  if (input.expectedGraphRevision !== input.run.graph.revision) {
    throw stale(
      "graph seal",
      input.run.graph.revision,
      input.expectedGraphRevision
    );
  }
  if (input.consumedEventCursor !== input.run.coordinatorEventCursor) {
    throw stale(
      "Coordinator event cursor",
      input.run.coordinatorEventCursor,
      input.consumedEventCursor
    );
  }
  if (
    Object.values(input.run.graph.nodes).some(
      (node) =>
        (node.definition.onFailure === "wake-coordinator" ||
          node.definition.onCancel === "wake-coordinator") &&
        !TERMINAL_NODE_STATES.has(node.status)
    )
  ) {
    throw new OrchestrationError(
      "invalid",
      "graph has unresolved future Coordinator obligations"
    );
  }
  const run = mutableClone(input.run);
  run.graph.authoringState = "sealed";
  run.graph.sealedAt = input.context.now();
  run.graph.sealReceiptId = input.context.id("seal-receipt");
  run.coordinatorConsumedCursor = input.consumedEventCursor;
  return recomputeRun(run, input.context);
}

function validatePatchedNode(
  node: WorkflowDefinitionV1["nodes"][number],
  run: Mutable<WorkflowRun>
): void {
  if (node.kind === "agent") {
    if (!run.graph.agentBindings[node.config.agentRef]) {
      throw new OrchestrationError(
        "invalid",
        `agent binding '${node.config.agentRef}' is unresolved`
      );
    }
  }
  if (
    node.kind === "loop" &&
    (node.config.mode === "for-each"
      ? node.config.maxItems
      : node.config.maxIterations) > run.limits.maxLoopIterations
  ) {
    throw budget("maxLoopIterations");
  }
}

function authoredWorkflowNodes(
  run: WorkflowRun
): WorkflowDefinitionV1["nodes"] {
  return [
    ...Object.values(run.graph.nodes).flatMap((node) =>
      !node.materialization ? [node.definition] : []
    ),
    ...Object.values(run.graph.bodyTemplates)
  ];
}

/** Partition authoring definitions without rewriting any materialized iteration. */
function compilePatchedLoopTemplates(
  run: Mutable<WorkflowRun>,
  source: WorkflowRun,
  patch: GraphPatch
): void {
  const authoredNodes = Object.values(run.graph.nodes).filter(
    (node) => !node.materialization
  );
  const isMaterializedEdge = (edge: WorkflowControlEdge) =>
    Boolean(
      run.graph.nodes[edge.from.nodeId]?.materialization ||
      run.graph.nodes[edge.to.nodeId]?.materialization
    );
  const compiled = compileLoopTemplates(authoredWorkflowNodes(run), [
    ...run.graph.edges.filter((edge) => !isMaterializedEdge(edge)),
    ...run.graph.bodyTemplateEdges
  ]);
  // Published/accepted templates are frozen. A new Loop uses new template IDs;
  // changing an old template's owner would also change future frozen iterations.
  const previousOwners = compileLoopTemplates(
    authoredWorkflowNodes(source),
    []
  ).owners;
  for (const templateId of Object.keys(source.graph.bodyTemplates)) {
    if (previousOwners.get(templateId) !== compiled.owners.get(templateId)) {
      throw new OrchestrationError(
        "immutable",
        `Loop template '${templateId}' cannot change owner or become a root node`
      );
    }
  }
  for (const node of authoredNodes) {
    if (!compiled.owners.has(node.nodeId)) continue;
    const previous = source.graph.nodes[node.nodeId];
    if (previous) {
      const replacement = patch.operations.find(
        (operation) =>
          operation.kind === "replace-pending-node" &&
          operation.node.id === node.nodeId
      );
      if (
        !replacement ||
        previous.status !== "pending" ||
        previous.attemptIds.length > 0
      ) {
        throw new OrchestrationError(
          "immutable",
          `moving node '${node.nodeId}' into a Loop requires an unstarted pending node and its expected state revision`
        );
      }
    }
    delete run.graph.nodes[node.nodeId];
  }
  run.graph.bodyTemplates = deepClone(compiled.bodyTemplates) as Mutable<
    typeof compiled.bodyTemplates
  >;
  run.graph.bodyTemplateEdges = deepClone(
    compiled.bodyTemplateEdges
  ) as Mutable<typeof compiled.bodyTemplateEdges>;
  run.graph.edges = run.graph.edges.filter(
    (edge) => isMaterializedEdge(edge) || !compiled.owners.has(edge.from.nodeId)
  );
  // Newly authored templates are counted when they materialize, as in a saved
  // Run. Previously accepted nodes/edges retain their cumulative budget usage.
  run.counters.nodes -= authoredNodes.filter(
    (node) =>
      compiled.owners.has(node.nodeId) && !source.graph.nodes[node.nodeId]
  ).length;
  run.counters.edges -= compiled.bodyTemplateEdges.filter(
    (edge) =>
      !source.graph.edges.some((prior) => prior.id === edge.id) &&
      !source.graph.bodyTemplateEdges.some((prior) => prior.id === edge.id)
  ).length;
}

function requireMutablePending(
  node: Mutable<RunNode>,
  expectedRevision: number
): void {
  if (node.stateRevision !== expectedRevision) {
    throw stale("node mutation", node.stateRevision, expectedRevision);
  }
  if (node.status !== "pending" || node.attemptIds.length > 0) {
    throw new OrchestrationError(
      "immutable",
      `node '${node.nodeId}' is definition-frozen in state '${node.status}'`
    );
  }
}

function assertGraphStructuralLimits(run: WorkflowRun): void {
  const authored = workflowDependencyGraph(
    [
      ...Object.values(run.graph.nodes).flatMap((node) =>
        node.materialization ? [] : [node.definition]
      ),
      ...Object.values(run.graph.bodyTemplates)
    ],
    [
      ...run.graph.edges.filter(
        (edge) =>
          !run.graph.nodes[edge.from.nodeId]?.materialization &&
          !run.graph.nodes[edge.to.nodeId]?.materialization
      ),
      ...run.graph.bodyTemplateEdges
    ]
  );
  // Materialized mappings resolve to exact iteration identities; historical
  // iterations and their edges still count toward live graph limits.
  const materialized = workflowDependencyGraph(
    Object.values(run.graph.nodes).map((node) => ({
      ...node.definition,
      id: node.nodeId
    })),
    run.graph.edges,
    {
      includeLoopEntries: false,
      resolveLoopExit: (loopId, templateId) => {
        const matches = Object.values(run.graph.nodes)
          .filter(
            (node) =>
              node.materialization?.ownerLoopNodeId === loopId &&
              node.materialization.templateNodeId === templateId
          )
          .map((node) => node.nodeId);
        if (matches.length) return matches;
        const enclosing = resolveSourceNode(
          run,
          templateId,
          run.graph.nodes[loopId]
        );
        return enclosing ? [enclosing.nodeId] : [];
      },
      resolveSource: (consumerId, sourceId) =>
        resolveSourceNode(run, sourceId, run.graph.nodes[consumerId])?.nodeId
    }
  );
  if (authored.size > run.limits.maxNodes) throw budget("maxNodes");
  if (
    run.graph.edges.length + run.graph.bodyTemplateEdges.length >
    run.limits.maxEdges
  )
    throw budget("maxEdges");
  for (const graph of [authored, materialized]) {
    for (const [nodeId, targets] of graph) {
      if (targets.size > run.limits.maxFanOut)
        throw new OrchestrationError(
          "budget-exhausted",
          `node '${nodeId}' exceeds Run limit 'maxFanOut'`
        );
    }
    if (graph === materialized) {
      // Loop fan-out is checked on its template entries above; unrolling a
      // bounded sequential Loop must not count old iterations as parallel work.
      // Ownership still participates in cycle/depth checks for patched bodies.
      for (const node of Object.values(run.graph.nodes)) {
        if (node.materialization?.bodyEntry)
          graph.get(node.materialization.ownerLoopNodeId)?.add(node.nodeId);
      }
    }
    const cycle = findCycle(graph);
    if (cycle)
      throw new OrchestrationError(
        "invalid",
        `arbitrary graph cycle is unsupported (${cycle.join(" -> ")}); use a Loop node`
      );
    const graphDepth = maximumDepth(graph, [...graph.keys()]);
    if (graphDepth > run.limits.maxGraphDepth)
      throw new OrchestrationError(
        "budget-exhausted",
        `graph depth ${graphDepth} exceeds Run limit 'maxGraphDepth'`
      );
  }
}
