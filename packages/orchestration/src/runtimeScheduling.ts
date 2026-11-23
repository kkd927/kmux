import { contentHash, deepClone } from "./canonical";
import type {
  Id,
  InputMapping,
  JsonValue,
  NodeAttempt,
  NodeResult,
  RunNode,
  WorkflowDefinitionV1,
  WorkflowControlEdge,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";
import { validateJsonSchemaValue } from "./schema";
import {
  admissionInputMappings,
  loopIterationOutputMappings
} from "./dataflow";
import {
  TERMINAL_NODE_STATES,
  type RuntimeContext,
  mutableClone,
  isTerminalRun,
  type Mutable,
  budget,
  recordAttemptDuration,
  markReady,
  wakeCoordinator
} from "./runtimeState";

export interface RequiredReachability {
  readonly requiredNodeIds: ReadonlySet<Id>;
  readonly unresolvedControlNodeIds: ReadonlySet<Id>;
}

export function computeRequiredReachability(
  run: WorkflowRun
): RequiredReachability {
  const roots = new Set<string>();
  for (const node of Object.values(run.graph.nodes)) {
    if (
      node.definition.kind === "end" ||
      node.definition.completionRoot ||
      node.definition.requiredSideEffect
    ) {
      roots.add(node.nodeId);
    }
  }
  for (const output of run.declaredOutputs) {
    if (
      output.required &&
      (output.source.kind === "node-result" ||
        output.source.kind === "node-outcome" ||
        output.source.kind === "repository-state")
    ) {
      roots.add(output.source.nodeId);
    }
  }
  const incoming = activeIncomingEdges(run);
  const required = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (required.has(nodeId)) continue;
    required.add(nodeId);
    const node = run.graph.nodes[nodeId];
    if (!node) continue;
    if (
      (node.definition.kind === "condition" ||
        node.definition.kind === "loop") &&
      node.selectedPort === undefined &&
      !TERMINAL_NODE_STATES.has(node.status)
    ) {
      unresolved.add(nodeId);
    }
    for (const edge of incoming.get(nodeId) ?? []) {
      // Other candidates still drain under their recorded disposition. They
      // are not dependencies of an already satisfied any-successful join.
      if (
        node.joinResolution?.winningPredecessorId &&
        edge.from.nodeId !== node.joinResolution.winningPredecessorId
      )
        continue;
      queue.push(edge.from.nodeId);
    }
    for (const mapping of admissionInputMappings(
      node.definition,
      run.graph.agentBindings
    )) {
      if (
        mapping.required &&
        (mapping.source.kind === "node-result" ||
          mapping.source.kind === "node-outcome" ||
          mapping.source.kind === "repository-state")
      ) {
        const sourceNode = resolveSourceNode(run, mapping.source.nodeId, node);
        if (sourceNode) queue.push(sourceNode.nodeId);
      }
    }
  }
  return { requiredNodeIds: required, unresolvedControlNodeIds: unresolved };
}

export function recomputeRun(
  source: WorkflowRun,
  context: RuntimeContext
): WorkflowRun {
  const run = mutableClone(source);
  if (isTerminalRun(run.status)) return run;
  if (run.callerUnavailable && run.status !== "settling") {
    run.status = "needs-attention";
    return run;
  }
  // Admission failures and unsatisfied joins can settle without an executor
  // wake. Resolve their downstream transitions independently of node order.
  // Each pass consumes pending nodes or advances a budget-bounded Loop.
  for (;;) {
    const loopAdvanced = advanceStructuredLoops(run, context);
    const pending = Object.values(run.graph.nodes).filter(
      (node) => node.status === "pending"
    ).length;
    propagateUnselectedBranches(run);
    updateNodeReadiness(run, context);
    const remaining = Object.values(run.graph.nodes).filter(
      (node) => node.status === "pending"
    ).length;
    if (!loopAdvanced && remaining >= pending) break;
  }

  if (run.status === "settling") {
    if (settlementIsDrained(run)) {
      run.status = run.settlingTargetOutcome ?? "failed";
      run.settledAt = context.now();
    }
    return run;
  }

  const reachability = computeRequiredReachability(run);
  const requiredNodes = [...reachability.requiredNodeIds]
    .map((id) => run.graph.nodes[id])
    .filter((node): node is Mutable<RunNode> => node !== undefined);
  const hasUnresolved = reachability.unresolvedControlNodeIds.size > 0;
  const requiredFailed = requiredNodes.some(
    (node) =>
      (node.status === "failed" || node.status === "canceled") &&
      isUnhandledRequiredFailure(run, node)
  );
  if (requiredFailed) {
    beginSettlement(run, "failed", context);
    return run;
  }
  const allRequiredSettled =
    requiredNodes.length > 0 &&
    requiredNodes.every((node) => TERMINAL_NODE_STATES.has(node.status));
  const noActiveAttempts = !Object.values(run.attempts).some((attempt) =>
    [
      "preparing",
      "delivery-pending",
      "running",
      "waiting-input",
      "cancel-requested",
      "cancel-uncertain",
      "uncertain"
    ].includes(attempt.status)
  );
  const noOpenGates = !Object.values(run.gates).some(
    (gate) => gate.state === "open"
  );
  const noUnresolvedTurns = !run.coordinatorTurns.some(
    (turn) =>
      turn.status === "pending" ||
      turn.status === "active" ||
      turn.status === "uncertain"
  );
  const noUnsettledWorkerTerminals = !hasUnsettledWorkerTerminals(run);

  if (
    run.graph.authoringState === "sealed" &&
    allRequiredSettled &&
    !hasUnresolved &&
    noActiveAttempts &&
    noOpenGates &&
    noUnresolvedTurns &&
    noUnsettledWorkerTerminals &&
    settlementIsDrained(run)
  ) {
    const outputs = resolveRunOutputs(run);
    if (outputs !== undefined) {
      run.outputs = outputs;
      run.status = "succeeded";
      run.settledAt = context.now();
      return run;
    }
  }

  const hasReady = Object.values(run.graph.nodes).some(
    (node) => node.status === "ready"
  );
  const hasActive = Object.values(run.attempts).some((attempt) =>
    ["preparing", "delivery-pending", "running", "waiting-input"].includes(
      attempt.status
    )
  );
  if (
    Object.values(run.attempts).some(
      (attempt) =>
        attempt.status === "uncertain" || attempt.status === "cancel-uncertain"
    ) ||
    Object.values(run.leases).some(
      (lease) =>
        lease.owner.kind === "attempt" &&
        ["uncertain", "reconciling"].includes(lease.state)
    ) ||
    Object.values(run.graph.nodes).some(
      (node) => node.status === "needs-attention"
    )
  ) {
    run.status = "needs-attention";
  } else if (Object.values(run.gates).some((gate) => gate.state === "open")) {
    run.status = "waiting-gate";
  } else if (run.graph.authoringState === "open" && !hasReady && !hasActive) {
    run.status = run.coordinatorTurns.some(
      (turn) => turn.status === "pending" || turn.status === "active"
    )
      ? "waiting-for-coordinator"
      : "needs-attention";
  } else {
    run.status = "running";
  }
  return run;
}

function advanceStructuredLoops(
  run: Mutable<WorkflowRun>,
  context: RuntimeContext
): boolean {
  let changed = true;
  let advanced = false;
  let passes = 0;
  while (changed && passes++ < 64) {
    changed = false;
    for (const loop of Object.values(run.graph.nodes)) {
      if (
        loop.definition.kind !== "loop" ||
        loop.status !== "running" ||
        !loop.activeAttemptId ||
        !loop.loopState
      ) {
        continue;
      }
      const attempt = run.attempts[loop.activeAttemptId];
      if (!attempt) continue;
      if (loop.loopState.awaitingGateNodeId) {
        const gateNode = run.graph.nodes[loop.loopState.awaitingGateNodeId];
        if (!gateNode || !TERMINAL_NODE_STATES.has(gateNode.status)) continue;
        const resolution = gateNode.selectedPort;
        const config = loop.definition.config;
        if (config.mode !== "while" || !config.maxGate || !resolution) continue;
        loop.loopState.awaitingGateNodeId = undefined;
        if (resolution === config.maxGate.retryResolution) {
          loop.loopState.iteration = 0;
          loop.loopState.invocation = (loop.loopState.invocation ?? 0) + 1;
          materializeLoopIteration(run, loop, undefined, context);
        } else if (
          config.maxGate.completedResolutions.some(
            (candidate) => candidate.resolution === resolution
          )
        ) {
          const completion = config.maxGate.completedResolutions.find(
            (candidate) => candidate.resolution === resolution
          )!;
          settleStructuredLoop(
            run,
            loop,
            attempt,
            "succeeded",
            completion.port,
            context,
            {
              disposition: resolution,
              carry: deepClone(loop.loopState.carry ?? {})
            }
          );
        } else if (resolution === config.maxGate.abortResolution) {
          settleStructuredLoop(
            run,
            loop,
            attempt,
            "canceled",
            "canceled",
            context,
            { disposition: resolution }
          );
        }
        changed = true;
        continue;
      }
      const active = [...(loop.loopState.activeIterationIds ?? [])];
      for (const iterationId of active) {
        const exit = completedLoopBodyExit(run, loop, iterationId);
        if (!exit) continue;
        const outputMappings = loopIterationOutputMappings(loop.definition);
        const outputReadiness = resolveMappingReadiness(
          run,
          exit.node,
          outputMappings
        );
        if (outputReadiness.state === "waiting") continue;
        if (outputReadiness.state === "failed") {
          settleStructuredLoop(
            run,
            loop,
            attempt,
            "failed",
            "failure",
            context,
            {
              error: `required Loop output '${outputReadiness.mappingTarget}' is unresolved`,
              mappingTarget: outputReadiness.mappingTarget
            }
          );
          changed = true;
          break;
        }
        const outputs = resolveNodeInputs(run, exit.node, outputMappings);
        loop.loopState.activeIterationIds = (
          loop.loopState.activeIterationIds ?? []
        ).filter((value) => value !== iterationId);
        loop.loopState.completedIterationIds = [
          ...(loop.loopState.completedIterationIds ?? []),
          iterationId
        ];
        if (
          loop.definition.config.mode === "for-each" &&
          loop.definition.config.accumulator
        ) {
          loop.loopState.accumulated = [
            ...(loop.loopState.accumulated ?? []),
            deepClone(outputs["config.accumulator.source"]!)
          ];
        }
        if (loop.definition.config.loopOutputs?.length) {
          loop.loopState.outputHistory = [
            ...(loop.loopState.outputHistory ?? []),
            {
              invocation: loop.loopState.invocation ?? 0,
              iteration: exit.node.materialization!.iteration,
              values: Object.fromEntries(
                loop.definition.config.loopOutputs.map((output) => [
                  output.name,
                  deepClone(outputs[`config.loopOutputs.${output.name}`]!)
                ])
              )
            }
          ];
        }
        if (
          loop.definition.config.mode === "for-each" &&
          exit.action === "break"
        ) {
          // Stop admitting new items. Already running Agent terminals drain normally.
          loop.loopState.breakRequested = true;
          loop.loopState.outcome = "break";
        }
        if (loop.definition.config.mode === "while") {
          const config = loop.definition.config;
          // A Loop's carry is the durable output of the body iteration, not
          // merely the seed for another iteration. Capture it before routing
          // the exit so clean completion and a subsequent max-reached Human
          // Gate both expose the exact latest body result downstream.
          for (const carry of config.carry ?? []) {
            loop.loopState.carry = {
              ...(loop.loopState.carry ?? {}),
              [carry.inputId]: deepClone(
                outputs[`config.carry.${carry.inputId}.next`]!
              )
            };
          }
          if (
            exit.action === "continue" ||
            (!exit.action && exit.outcome === config.repeatOutcome)
          ) {
            if (
              loop.loopState.iteration < config.maxIterations &&
              run.counters.loopIterations < run.limits.maxLoopIterations
            ) {
              materializeLoopIteration(run, loop, undefined, context);
            } else if (config.maxGate) {
              materializeLoopMaxGate(run, loop, config.maxGate.nodeId, context);
            } else {
              loop.loopState.outcome = "max-reached";
              settleStructuredLoop(
                run,
                loop,
                attempt,
                "succeeded",
                config.maxReachedPort,
                context,
                {
                  iterations: loop.loopState.iteration,
                  outcome: "max-reached",
                  carry: deepClone(loop.loopState.carry ?? {})
                }
              );
            }
          } else if (
            exit.action === "break" ||
            config.completedOutcomes.includes(exit.outcome)
          ) {
            loop.loopState.outcome = "break";
            settleStructuredLoop(
              run,
              loop,
              attempt,
              "succeeded",
              config.completedPort,
              context,
              {
                iterations: loop.loopState.iteration,
                outcome: exit.outcome,
                carry: deepClone(loop.loopState.carry ?? {})
              }
            );
          } else {
            settleStructuredLoop(
              run,
              loop,
              attempt,
              "failed",
              "failure",
              context,
              { error: `unsupported Loop body outcome '${exit.outcome}'` }
            );
          }
        }
        changed = true;
      }
      if (
        loop.definition.config.mode === "for-each" &&
        loop.status === "running"
      ) {
        fillForEachCapacity(run, loop, context);
        const itemCount = loop.loopState.frozenItems?.length ?? 0;
        if (
          (loop.loopState.breakRequested ||
            loop.loopState.iteration >= itemCount) &&
          (loop.loopState.activeIterationIds?.length ?? 0) === 0
        ) {
          settleStructuredLoop(
            run,
            loop,
            attempt,
            "succeeded",
            loop.definition.config.completedPort,
            context,
            {
              items: deepClone(loop.loopState.frozenItems ?? []),
              accumulated: deepClone(loop.loopState.accumulated ?? [])
            }
          );
          changed = true;
        }
      }
    }
    advanced ||= changed;
  }
  return advanced;
}

export function fillForEachCapacity(
  run: Mutable<WorkflowRun>,
  loop: Mutable<RunNode>,
  context: RuntimeContext
): void {
  if (
    loop.definition.kind !== "loop" ||
    loop.definition.config.mode !== "for-each"
  )
    return;
  const itemCount = loop.loopState?.frozenItems?.length ?? 0;
  while (
    (loop.loopState?.activeIterationIds?.length ?? 0) <
      loop.definition.config.concurrency &&
    !loop.loopState?.breakRequested &&
    (loop.loopState?.iteration ?? 0) < itemCount
  ) {
    const index = loop.loopState!.iteration;
    materializeLoopIteration(
      run,
      loop,
      loop.loopState!.frozenItems![index],
      context
    );
  }
}

export function materializeLoopIteration(
  run: Mutable<WorkflowRun>,
  loop: Mutable<RunNode>,
  _item: JsonValue | undefined,
  context: RuntimeContext
): void {
  if (loop.definition.kind !== "loop" || !loop.loopState) return;
  const body = loop.definition.config.body;
  if (run.counters.loopIterations >= run.limits.maxLoopIterations) {
    throw budget("maxLoopIterations");
  }
  if (run.counters.nodes + body.nodeIds.length > run.limits.maxNodes) {
    throw budget("maxNodes");
  }
  const templates = body.nodeIds.map((nodeId) => {
    const template = run.graph.bodyTemplates[nodeId];
    if (!template) {
      throw new OrchestrationError(
        "invalid",
        `Loop body template '${nodeId}' is unavailable`
      );
    }
    return template;
  });
  const iteration = loop.loopState.iteration;
  const iterationId = context.id("loop-iteration");
  const path = [
    ...(loop.materialization?.path ?? []),
    {
      loopNodeId: loop.definition.id,
      iterationId,
      iteration
    }
  ];
  const runtimeIds = new Map<string, string>();
  for (const template of templates) {
    const runtimeId = `${loop.nodeId}:iteration:${iteration}:${iterationId}:${template.id}`;
    runtimeIds.set(template.id, runtimeId);
    run.graph.nodes[runtimeId] = {
      nodeId: runtimeId,
      definition: deepClone(template) as Mutable<typeof template>,
      definitionHash: contentHash(template as unknown as JsonValue),
      stateRevision: 0,
      status: "pending",
      selectedPredecessors: [],
      attemptIds: [],
      materialization: {
        templateNodeId: template.id,
        ownerLoopNodeId: loop.nodeId,
        iterationId,
        iteration,
        path: deepClone(path),
        bodyEntry: body.entryNodeIds.includes(template.id)
      }
    };
  }
  const bodyEdges = run.graph.bodyTemplateEdges.filter(
    (edge) => runtimeIds.has(edge.from.nodeId) && runtimeIds.has(edge.to.nodeId)
  );
  if (run.counters.edges + bodyEdges.length > run.limits.maxEdges) {
    throw budget("maxEdges");
  }
  for (const edge of bodyEdges) {
    run.graph.edges.push({
      id: `${iterationId}:${edge.id}`,
      from: {
        nodeId: runtimeIds.get(edge.from.nodeId)!,
        ...(edge.from.port ? { port: edge.from.port } : {})
      },
      to: {
        nodeId: runtimeIds.get(edge.to.nodeId)!,
        ...(edge.to.port ? { port: edge.to.port } : {})
      }
    });
  }
  loop.loopState.iteration += 1;
  loop.loopState.activeIterationIds = [
    ...(loop.loopState.activeIterationIds ?? []),
    iterationId
  ];
  run.counters.loopIterations += 1;
  run.counters.nodes += templates.length;
  run.counters.edges += bodyEdges.length;
  run.graph.revision += 1;
}

function materializeLoopMaxGate(
  run: Mutable<WorkflowRun>,
  loop: Mutable<RunNode>,
  gateTemplateId: string,
  context: RuntimeContext
): void {
  const template = run.graph.bodyTemplates[gateTemplateId];
  if (!template || template.kind !== "human-gate") {
    throw new OrchestrationError(
      "invalid",
      "Loop max gate template is unavailable"
    );
  }
  if (run.counters.nodes >= run.limits.maxNodes) throw budget("maxNodes");
  const iterationId = context.id("loop-gate");
  const runtimeId = `${loop.nodeId}:gate:${iterationId}:${template.id}`;
  run.graph.nodes[runtimeId] = {
    nodeId: runtimeId,
    definition: deepClone(template),
    definitionHash: contentHash(template as unknown as JsonValue),
    stateRevision: 0,
    status: "pending",
    selectedPredecessors: [],
    attemptIds: [],
    materialization: {
      templateNodeId: template.id,
      ownerLoopNodeId: loop.nodeId,
      iterationId,
      iteration: loop.loopState?.iteration ?? 0,
      path: deepClone(loop.materialization?.path ?? []),
      bodyEntry: true
    }
  };
  loop.loopState!.awaitingGateNodeId = runtimeId;
  run.counters.nodes += 1;
  run.graph.revision += 1;
}

function completedLoopBodyExit(
  run: Mutable<WorkflowRun>,
  loop: Mutable<RunNode>,
  iterationId: string
):
  | {
      readonly outcome: string;
      readonly action?: "break" | "continue";
      readonly node: Mutable<RunNode>;
    }
  | undefined {
  if (loop.definition.kind !== "loop") return undefined;
  for (const exit of loop.definition.config.body.exits) {
    const node = Object.values(run.graph.nodes).find(
      (candidate) =>
        candidate.materialization?.ownerLoopNodeId === loop.nodeId &&
        candidate.materialization.iterationId === iterationId &&
        candidate.materialization.templateNodeId === exit.nodeId
    );
    if (!node || !TERMINAL_NODE_STATES.has(node.status)) continue;
    if (exit.port !== undefined && node.selectedPort !== exit.port) continue;
    if (exit.port === undefined && node.status !== "succeeded") continue;
    const action =
      node.definition.kind === "break" || node.definition.kind === "continue"
        ? node.definition.kind
        : exit.action;
    return { outcome: exit.outcome, ...(action ? { action } : {}), node };
  }
  return undefined;
}

export function settleStructuredLoop(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  attempt: Mutable<NodeAttempt>,
  outcome: "succeeded" | "failed" | "canceled",
  selectedPort: string,
  context: RuntimeContext,
  data?: JsonValue
): Mutable<WorkflowRun> {
  const settledAt = context.now();
  if (
    node.definition.kind === "loop" &&
    node.definition.config.loopOutputs?.length
  ) {
    const history = [...(node.loopState?.outputHistory ?? [])].sort(
      (a, b) =>
        (a.invocation ?? 0) - (b.invocation ?? 0) || a.iteration - b.iteration
    );
    data = {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      ...Object.fromEntries(
        node.definition.config.loopOutputs.map((output) => [
          output.name,
          output.mode === "collect"
            ? history.map((entry) => entry.values[output.name]!)
            : (history.at(-1)?.values[output.name] ?? null)
        ])
      )
    };
  }
  attempt.status = outcome;
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = outcome;
  node.activeAttemptId = undefined;
  node.selectedPort = selectedPort;
  node.stateRevision += 1;
  run.counters.activeAttempts = Math.max(0, run.counters.activeAttempts - 1);
  const result: Mutable<NodeResult> = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome,
    summary: `loop node ${outcome}`,
    ...(data === undefined ? {} : { data: deepClone(data) })
  };
  run.attemptResults[attempt.attemptId] = result;
  run.results[node.nodeId] = result;
  applyFailurePolicy(run, node, context);
  return run;
}

function updateNodeReadiness(
  run: Mutable<WorkflowRun>,
  context: RuntimeContext
): void {
  const incoming = activeIncomingEdges(run);
  for (const node of Object.values(run.graph.nodes)) {
    if (node.status !== "pending") continue;
    const retryBlocked = Object.values(run.timers).some((timer) => {
      const attempt = timer.attemptId
        ? run.attempts[timer.attemptId]
        : undefined;
      return (
        timer.kind === "retry" &&
        timer.state === "pending" &&
        attempt?.nodeId === node.nodeId
      );
    });
    if (retryBlocked) continue;
    const dependencies = incoming.get(node.nodeId) ?? [];
    node.selectedPredecessors = dependencies.map((edge) => edge.from.nodeId);
    if (
      dependencies.length === 0 &&
      node.definition.kind !== "start" &&
      run.source.kind === "workflow-version" &&
      !node.materialization?.bodyEntry
    ) {
      continue;
    }
    const predecessorStates = dependencies.map(
      (edge) => run.graph.nodes[edge.from.nodeId]?.status
    );
    const policy = node.definition.joinPolicy ?? "all-successful";
    const ready =
      dependencies.length === 0
        ? true
        : policy === "all-successful"
          ? predecessorStates.every((status) => status === "succeeded")
          : policy === "all-settled"
            ? predecessorStates.every(
                (status) => status && TERMINAL_NODE_STATES.has(status)
              )
            : predecessorStates.some((status) => status === "succeeded");
    const mappingResolution = ready
      ? resolveMappingReadiness(run, node)
      : { state: "waiting" as const };
    if (ready && mappingResolution.state === "resolved") {
      const winner =
        policy === "any-successful"
          ? dependencies.find(
              (edge) =>
                run.graph.nodes[edge.from.nodeId]?.status === "succeeded"
            )?.from.nodeId
          : undefined;
      if (dependencies.length > 1) {
        node.joinResolution = {
          policy,
          selectedPredecessors: [...node.selectedPredecessors],
          outcome: "satisfied",
          ...(winner
            ? {
                winningPredecessorId: winner,
                otherPredecessorIds: node.selectedPredecessors.filter(
                  (id) => id !== winner
                ),
                disposition: node.definition.anySuccessfulDisposition
              }
            : {}),
          version: 1
        };
      }
      markReady(node);
      if (winner && node.definition.anySuccessfulDisposition !== "wait") {
        applyEarlyJoinDisposition(run, node, context);
      }
    } else if (ready && mappingResolution.state === "failed") {
      recordNodeAdmissionFailure(
        run,
        node,
        {
          class: "input-mapping",
          code: "missing-required-input",
          mappingTarget: mappingResolution.mappingTarget,
          message: `required mapping '${mappingResolution.mappingTarget}' is unresolved`
        },
        context
      );
    } else if (
      policy === "any-successful" &&
      predecessorStates.length > 0 &&
      predecessorStates.every(
        (status) => status && TERMINAL_NODE_STATES.has(status)
      ) &&
      !predecessorStates.includes("succeeded")
    ) {
      node.status = "failed";
      node.joinResolution = {
        policy,
        selectedPredecessors: [...node.selectedPredecessors],
        outcome: "unsatisfied",
        version: 1
      };
      node.selectedPort = "failure";
      node.stateRevision += 1;
      applyFailurePolicy(run, node, context);
    }
  }
}

function applyEarlyJoinDisposition(
  run: Mutable<WorkflowRun>,
  join: Mutable<RunNode>,
  context: RuntimeContext
): void {
  const disposition = join.joinResolution?.disposition;
  if (disposition !== "cancel") return;
  const pending = [...(join.joinResolution?.otherPredecessorIds ?? [])];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const nodeId = pending[index]!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = run.graph.nodes[nodeId];
    if (!node || TERMINAL_NODE_STATES.has(node.status)) continue;
    node.joinDisposition = { joinNodeId: join.nodeId, disposition };
    const attempt = node.activeAttemptId
      ? run.attempts[node.activeAttemptId]
      : undefined;
    if (!attempt) {
      const required =
        node.definition.completionRoot || node.definition.requiredSideEffect;
      node.status = required ? "canceled" : "skipped";
      node.stateRevision += 1;
      for (const gate of Object.values(run.gates)) {
        if (gate.nodeId === node.nodeId && gate.state === "open") {
          gate.state = "canceled";
          gate.canceledAt = context.now();
        }
      }
      if (required) {
        node.selectedPort = "canceled";
        applyFailurePolicy(run, node, context);
      }
      continue;
    }
    if (node.definition.kind === "loop") {
      pending.push(
        ...Object.values(run.graph.nodes)
          .filter(
            (child) => child.materialization?.ownerLoopNodeId === node.nodeId
          )
          .map((child) => child.nodeId)
      );
    }
    if (node.definition.kind !== "agent" && node.definition.kind !== "shell") {
      settleControlForRunSettlement(run, node, attempt, context);
      continue;
    }
    if (
      !["preparing", "delivery-pending", "running", "waiting-input"].includes(
        attempt.status
      )
    )
      continue;
    const operationId = context.id("cancellation");
    run.cancellations[operationId] = {
      operationId,
      attemptId: attempt.attemptId,
      idempotencyKey: `join:${join.nodeId}:cancel:${attempt.attemptId}`,
      requestedAt: context.now(),
      state: "requested",
      joinNodeId: join.nodeId
    };
    attempt.status = "cancel-requested";
    node.status = "cancel-requested";
    node.stateRevision += 1;
  }
}

export function recordNodeAdmissionFailure(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  failure: NonNullable<RunNode["admissionFailure"]>,
  context: RuntimeContext
): void {
  node.status = "failed";
  node.selectedPort = "failure";
  node.admissionFailure = deepClone(failure) as Mutable<typeof failure>;
  node.stateRevision += 1;
  applyFailurePolicy(run, node, context);
}

function resolveMappingReadiness(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  mappings: readonly InputMapping[] = admissionInputMappings(
    node.definition,
    run.graph.agentBindings
  )
):
  | { readonly state: "resolved" }
  | { readonly state: "waiting" }
  | { readonly state: "failed"; readonly mappingTarget: string } {
  for (const mapping of mappings) {
    const value = resolveDataSource(run, mapping.source, node);
    if (
      value !== undefined ||
      mapping.missing === "omit" ||
      (mapping.missing === "use-default" && mapping.default !== undefined)
    ) {
      continue;
    }
    if (!mapping.required || mapping.missing !== "fail") continue;
    if (mapping.source.kind === "run-input") {
      return { state: "failed", mappingTarget: mapping.target };
    }
    if (
      mapping.source.kind === "node-result" ||
      mapping.source.kind === "node-outcome" ||
      mapping.source.kind === "repository-state"
    ) {
      const sourceNode = resolveSourceNode(run, mapping.source.nodeId, node);
      if (sourceNode && !TERMINAL_NODE_STATES.has(sourceNode.status)) {
        return { state: "waiting" };
      }
    }
    return { state: "failed", mappingTarget: mapping.target };
  }
  return { state: "resolved" };
}

export function resolveNodeInputs(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  mappings: readonly InputMapping[] = node.definition.kind === "loop"
    ? (node.definition.inputMappings ?? [])
    : admissionInputMappings(node.definition, run.graph.agentBindings)
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {};
  for (const mapping of mappings) {
    const value = resolveDataSource(run, mapping.source, node);
    if (value !== undefined) resolved[mapping.target] = deepClone(value);
    else if (mapping.missing === "use-default" && mapping.default !== undefined)
      resolved[mapping.target] = deepClone(mapping.default);
    else if (mapping.required && mapping.missing === "fail")
      throw new OrchestrationError(
        "invalid",
        `required mapping '${mapping.target}' is unresolved`
      );
  }
  return resolved;
}

export function resolveDataSource(
  run: Mutable<WorkflowRun>,
  source: WorkflowDefinitionV1["outputs"][number]["source"],
  consumer?: Mutable<RunNode>
): JsonValue | undefined {
  if (source.kind === "literal") return source.value;
  if (source.kind === "run-input")
    return dataAtPath(run.inputs[source.inputId], source.path);
  if (source.kind === "loop-index") {
    return consumer?.materialization?.path.find(
      (entry) => entry.loopNodeId === source.loopNodeId
    )?.iteration;
  }
  if (source.kind === "loop-item") {
    const materialization = consumer?.materialization?.path.find(
      (entry) => entry.loopNodeId === source.loopNodeId
    );
    if (!materialization) return undefined;
    const loop = Object.values(run.graph.nodes).find(
      (candidate) =>
        candidate.definition.kind === "loop" &&
        candidate.definition.id === source.loopNodeId &&
        (candidate.nodeId === source.loopNodeId ||
          candidate.materialization?.path.some(
            (entry) => entry.iterationId === materialization.iterationId
          ))
    );
    let value: unknown =
      loop?.loopState?.frozenItems?.[materialization.iteration];
    for (const segment of source.path ?? []) {
      if (value === null || typeof value !== "object" || !(segment in value)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    return value as JsonValue | undefined;
  }
  if (source.kind === "loop-carry") {
    const loop = Object.values(run.graph.nodes).find(
      (candidate) =>
        candidate.definition.kind === "loop" &&
        candidate.definition.id === source.loopNodeId &&
        (!consumer?.materialization ||
          (candidate.materialization?.path ?? []).every(
            (entry, index) =>
              entry.iterationId ===
              consumer.materialization!.path[index]?.iterationId
          ))
    );
    return dataAtPath(loop?.loopState?.carry?.[source.inputId], source.path);
  }
  const sourceNode = resolveSourceNode(run, source.nodeId, consumer);
  if (!sourceNode) return undefined;
  if (source.kind === "node-result" && sourceNode.status !== "succeeded") {
    return undefined;
  }
  if (
    source.kind === "node-outcome" &&
    !TERMINAL_NODE_STATES.has(sourceNode.status)
  ) {
    return undefined;
  }
  const result = run.results[sourceNode.nodeId];
  if (source.kind === "repository-state") {
    return result?.repositoryState as unknown as JsonValue | undefined;
  }
  // Terminal control/admission outcomes need no attempt or Agent NodeResult.
  // Expose their durable receipts through the explicit outcome mapping only.
  let value: unknown =
    source.kind === "node-result"
      ? result?.data
      : {
          outcome: sourceNode.status,
          summary:
            result?.summary ??
            sourceNode.admissionFailure?.message ??
            (sourceNode.joinResolution?.outcome === "unsatisfied"
              ? `${sourceNode.joinResolution.policy} join has no successful predecessor`
              : `node ${sourceNode.status}`),
          ...(sourceNode.admissionFailure
            ? { admissionFailure: sourceNode.admissionFailure }
            : {}),
          ...(sourceNode.skipProvenance
            ? { skipProvenance: sourceNode.skipProvenance }
            : {}),
          ...(sourceNode.joinResolution
            ? { joinResolution: sourceNode.joinResolution }
            : {}),
          ...(sourceNode.joinDisposition
            ? { joinDisposition: sourceNode.joinDisposition }
            : {})
        };
  for (const segment of source.path ?? []) {
    if (value === null || typeof value !== "object" || !(segment in value))
      return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value as JsonValue | undefined;
}

function dataAtPath(
  value: JsonValue | undefined,
  path: readonly string[] = []
): JsonValue | undefined {
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    )
      return undefined;
    value = (value as Record<string, JsonValue>)[segment];
  }
  return value;
}

/** Raw expressions use the same lexical node scope as typed data sources. */
export function workflowExpressionValues(
  run: WorkflowRun,
  attempt?: NodeAttempt
): JsonValue {
  const consumer = attempt ? run.graph.nodes[attempt.nodeId] : undefined;
  const nodes = Object.values(run.graph.nodes);
  const entry = (node: RunNode): JsonValue => ({
    status: node.status,
    ...(run.results[node.nodeId]
      ? { result: run.results[node.nodeId] as unknown as JsonValue }
      : {})
  });
  const values = Object.fromEntries(
    nodes.map((node) => [node.nodeId, entry(node)])
  );
  for (const id of new Set(
    nodes.map((node) => node.materialization?.templateNodeId ?? node.nodeId)
  )) {
    const resolved = resolveSourceNode(run, id, consumer);
    if (resolved) values[id] = entry(resolved);
  }
  return { inputs: attempt?.resolvedInputs ?? run.inputs, nodes: values };
}

export function resolveSourceNode(
  run: WorkflowRun,
  templateNodeId: string,
  consumer?: RunNode
): RunNode | undefined {
  if (!consumer?.materialization) return run.graph.nodes[templateNodeId];
  const candidates = Object.values(run.graph.nodes).filter(
    (candidate) =>
      candidate.materialization?.templateNodeId === templateNodeId ||
      candidate.nodeId === templateNodeId
  );
  for (
    let depth = consumer.materialization.path.length;
    depth >= 0;
    depth -= 1
  ) {
    const prefix = consumer.materialization.path.slice(0, depth);
    const match = candidates.find((candidate) => {
      const path = candidate.materialization?.path ?? [];
      return (
        path.length === prefix.length &&
        path.every(
          (entry, index) => entry.iterationId === prefix[index]?.iterationId
        )
      );
    });
    if (match) return match;
  }
  return undefined;
}

function activeIncomingEdges(
  run: WorkflowRun
): Map<string, WorkflowControlEdge[]> {
  const incoming = new Map<string, WorkflowControlEdge[]>();
  for (const edge of run.graph.edges) {
    const source = run.graph.nodes[edge.from.nodeId];
    if (!source) continue;
    if (source.status === "skipped" && source.skipProvenance) continue;
    if (
      source.selectedPort !== undefined &&
      edge.from.port !== undefined &&
      source.selectedPort !== edge.from.port &&
      !failedAnyJoinCandidate(run, edge)
    ) {
      continue;
    }
    const list = incoming.get(edge.to.nodeId) ?? [];
    list.push(edge);
    incoming.set(edge.to.nodeId, list);
  }
  return incoming;
}

function failedAnyJoinCandidate(
  run: WorkflowRun,
  edge: WorkflowControlEdge
): boolean {
  const source = run.graph.nodes[edge.from.nodeId];
  return (
    (source?.status === "failed" || source?.status === "canceled") &&
    run.graph.nodes[edge.to.nodeId]?.definition.joinPolicy === "any-successful"
  );
}

function propagateUnselectedBranches(run: Mutable<WorkflowRun>): void {
  const incomingAll = new Map<string, Mutable<WorkflowDefinitionV1["edges"]>>();
  for (const edge of run.graph.edges) {
    const list = incomingAll.get(edge.to.nodeId) ?? [];
    list.push(edge);
    incomingAll.set(edge.to.nodeId, list);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(run.graph.nodes)) {
      if (node.status !== "pending") continue;
      const incoming = incomingAll.get(node.nodeId) ?? [];
      if (incoming.length === 0) continue;
      const unavailable = incoming.every((edge) => {
        const predecessor = run.graph.nodes[edge.from.nodeId];
        if (!predecessor) return true;
        return (
          predecessor.status === "skipped" ||
          (predecessor.selectedPort !== undefined &&
            edge.from.port !== undefined &&
            predecessor.selectedPort !== edge.from.port &&
            !failedAnyJoinCandidate(run, edge))
        );
      });
      if (unavailable) {
        const branch = incoming.find((edge) => {
          const predecessor = run.graph.nodes[edge.from.nodeId];
          return (
            predecessor?.selectedPort !== undefined &&
            predecessor.selectedPort !== edge.from.port
          );
        });
        node.status = "skipped";
        node.stateRevision += 1;
        if (branch) {
          const predecessor = run.graph.nodes[branch.from.nodeId]!;
          node.skipProvenance = {
            sourceNodeId: predecessor.nodeId,
            selectedPort: predecessor.selectedPort!
          };
        } else {
          const inherited = incoming
            .map((edge) => run.graph.nodes[edge.from.nodeId]?.skipProvenance)
            .find((provenance) => provenance !== undefined);
          if (inherited) node.skipProvenance = { ...inherited };
        }
        changed = true;
      }
    }
  }
}

function resolveRunOutputs(
  run: Mutable<WorkflowRun>
): Record<string, JsonValue> | undefined {
  const outputs: Record<string, JsonValue> = {};
  for (const output of run.declaredOutputs) {
    const value = resolveDataSource(run, output.source);
    if (value === undefined && output.required) return undefined;
    if (value !== undefined) {
      if (output.schema) {
        const validated = validateJsonSchemaValue(output.schema, value);
        if (!validated.ok) return undefined;
      }
      outputs[output.id] = deepClone(value);
    }
  }
  return outputs;
}

export function applyFailurePolicy(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  context: RuntimeContext
): void {
  if (node.status !== "failed" && node.status !== "canceled") return;
  // A sibling canceled as part of draining must not replace the failure that
  // selected settlement, or wake the Coordinator while the Run is closing.
  if (run.settlingTargetOutcome) return;
  // An early join deliberately cancels the losing execution. Other required
  // consumers still see its canceled outcome through required reachability.
  if (
    node.status === "canceled" &&
    node.joinDisposition?.disposition === "cancel" &&
    !node.definition.completionRoot &&
    !node.definition.requiredSideEffect &&
    run.graph.edges
      .filter((edge) => edge.from.nodeId === node.nodeId)
      .every(
        (edge) =>
          edge.to.nodeId === node.joinDisposition!.joinNodeId ||
          run.graph.nodes[edge.to.nodeId]?.joinDisposition?.joinNodeId ===
            node.joinDisposition!.joinNodeId
      )
  )
    return;
  const policy =
    node.status === "failed"
      ? node.definition.onFailure
      : node.definition.onCancel;
  if (policy === "wake-coordinator" && run.graph.authoringState === "open") {
    wakeCoordinator(run);
    run.status = "waiting-for-coordinator";
    return;
  }
  if (policy === "skip-descendants") return;
  if (policy === undefined && !isUnhandledRequiredFailure(run, node)) return;
  beginSettlement(
    run,
    node.status === "canceled" ? "canceled" : "failed",
    context
  );
}

function isUnhandledRequiredFailure(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>
): boolean {
  const policy =
    node.status === "canceled"
      ? node.definition.onCancel
      : node.definition.onFailure;
  if (policy === "skip-descendants" || policy === "wake-coordinator") {
    return false;
  }
  if (node.definition.completionRoot || node.definition.requiredSideEffect)
    return true;
  const outgoing = run.graph.edges.filter(
    (edge) => edge.from.nodeId === node.nodeId
  );
  return (
    outgoing.length === 0 ||
    !outgoing.every((edge) => {
      const target = run.graph.nodes[edge.to.nodeId];
      return target?.definition.joinPolicy === "any-successful";
    })
  );
}

export function beginSettlement(
  run: Mutable<WorkflowRun>,
  outcome: "failed" | "canceled",
  context: RuntimeContext
): void {
  if (isTerminalRun(run.status)) return;
  run.status = "settling";
  run.settlingTargetOutcome ??= outcome;
  for (const node of Object.values(run.graph.nodes)) {
    if (node.status === "pending" || node.status === "ready") {
      node.status = "skipped";
      node.stateRevision += 1;
    }
    if (
      [
        "preparing",
        "running",
        "waiting-input",
        "waiting-gate",
        "needs-attention"
      ].includes(node.status)
    ) {
      const attempt = node.activeAttemptId
        ? run.attempts[node.activeAttemptId]
        : undefined;
      const executorOwned =
        node.definition.kind === "agent" || node.definition.kind === "shell";
      if (attempt && !executorOwned) {
        settleControlForRunSettlement(run, node, attempt, context);
        continue;
      }
      node.status = "cancel-requested";
      node.stateRevision += 1;
      if (
        attempt &&
        !["uncertain", "cancel-uncertain"].includes(attempt.status)
      ) {
        attempt.status = "cancel-requested";
        if (
          !Object.values(run.cancellations).some(
            (operation) => operation.attemptId === attempt.attemptId
          )
        ) {
          const operationId = context.id("cancellation");
          run.cancellations[operationId] = {
            operationId,
            attemptId: attempt.attemptId,
            idempotencyKey: context.id("cancellation-key"),
            requestedAt: context.now(),
            state: "requested"
          };
        }
      }
    }
  }
}

function settleControlForRunSettlement(
  run: Mutable<WorkflowRun>,
  node: Mutable<RunNode>,
  attempt: Mutable<NodeAttempt>,
  context: RuntimeContext
): void {
  const settledAt = context.now();
  attempt.status = "canceled";
  attempt.settledAt = settledAt;
  recordAttemptDuration(run, attempt, settledAt);
  node.status = "canceled";
  node.activeAttemptId = undefined;
  node.selectedPort = "canceled";
  node.stateRevision += 1;
  run.counters.activeAttempts = Math.max(0, run.counters.activeAttempts - 1);
  const result: NodeResult = {
    nodeId: node.nodeId,
    attemptId: attempt.attemptId,
    outcome: "canceled",
    summary:
      node.joinDisposition?.disposition === "cancel"
        ? `${node.definition.kind} node canceled by an early join`
        : `${node.definition.kind} node canceled during Run settlement`
  };
  run.results[node.nodeId] = result as Mutable<NodeResult>;
  run.attemptResults[attempt.attemptId] = result as Mutable<NodeResult>;
  if (node.definition.kind === "human-gate") {
    const gate = Object.values(run.gates).find(
      (candidate) =>
        candidate.nodeId === node.nodeId && candidate.state === "open"
    );
    if (gate) {
      gate.state = "canceled";
      gate.canceledAt = settledAt;
    }
  }
}

function settlementIsDrained(run: Mutable<WorkflowRun>): boolean {
  const hasRuntimeAttempt = Object.values(run.attempts).some((attempt) =>
    [
      "preparing",
      "delivery-pending",
      "running",
      "waiting-input",
      "cancel-requested",
      "cancel-uncertain",
      "uncertain"
    ].includes(attempt.status)
  );
  const hasUnsettledDelivery = Object.values(run.deliveries).some((delivery) =>
    ["pending", "accepted", "uncertain"].includes(delivery.state)
  );
  const hasUnsettledCancellation = Object.values(run.cancellations).some(
    (operation) =>
      operation.state === "requested" || operation.state === "uncertain"
  );
  const hasUnsettledShell = Object.values(run.shellOperations).some(
    (operation) =>
      operation.state === "intent-recorded" ||
      operation.state === "executing" ||
      operation.state === "outcome-unknown" ||
      operation.state === "needs-attention"
  );
  const hasRuntimeLease = Object.values(run.leases).some(
    (lease) =>
      lease.owner.kind === "attempt" &&
      ["active", "uncertain", "reconciling"].includes(lease.state)
  );
  return !(
    hasRuntimeAttempt ||
    hasUnsettledDelivery ||
    hasUnsettledCancellation ||
    hasUnsettledShell ||
    hasRuntimeLease ||
    hasUnsettledWorkerTerminals(run)
  );
}

function hasUnsettledWorkerTerminals(run: WorkflowRun): boolean {
  return Object.values(run.dispatches).some((dispatch) => {
    if (!dispatch.execution) return false;
    return (
      dispatch.terminalState !== undefined &&
      !["retained", "released"].includes(dispatch.terminalState)
    );
  });
}
