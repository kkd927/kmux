import { expect, it } from "vitest";
import {
  admitNode,
  confirmAttemptCancellation,
  contentHash,
  materializeWorkflowRun,
  prepareAgentPromptDelivery,
  publishWorkflowVersion,
  recoverRun,
  settleAgentPromptDelivery,
  settleControlNode,
  starterWorkflowDefinition,
  submitAttemptResult,
  markCancellationUncertain,
  markLeaseUncertain,
  releaseLease,
  requestAttemptInputDisposition,
  recomputeRun,
  settleAttemptInputDisposition,
  type WorkflowRun,
  type WorkflowDefinitionV1,
  type RuntimeContext,
  type AgentResultSubmission
} from "./index";

function race(
  disposition: "wait" | "cancel",
  options: { startSecond?: boolean; requiredSecond?: boolean } = {}
) {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => new Date(1_800_000_000_000 + sequence++).toISOString(),
    id: (kind) => `${kind}:${sequence++}`
  };
  const base = starterWorkflowDefinition({
    definitionId: "race",
    name: "Race"
  });
  const definition: WorkflowDefinitionV1 = {
    ...base,
    agentBindings: {
      worker: {
        agent: { kind: "agent-id", agentId: "fixture-agent" },
        scope: { kind: "run" },
        authorityMode: "ambient",
        targetPolicy: "local",
        surfacePolicy: "create",
        sessionPolicy: "fresh",
        worktreePolicy: "current",
        inputMode: "orchestrated"
      }
    },
    nodes: [
      ...base.nodes.map((node) =>
        node.kind === "end"
          ? {
              ...node,
              joinPolicy: "any-successful" as const,
              anySuccessfulDisposition: disposition
            }
          : node
      ),
      ...["a", "b"].map((id) => ({
        id,
        title: id,
        kind: "agent" as const,
        ...(id === "b" && options.requiredSecond
          ? { requiredSideEffect: true }
          : {}),
        config: {
          version: 1 as const,
          agentRef: "worker",
          prompt: "Work",
          lifecycleMode: "managed" as const,
          coding: false
        }
      }))
    ],
    edges: ["a", "b"].flatMap((id) => [
      {
        id: `start:${id}`,
        from: { nodeId: "start", port: "success" },
        to: { nodeId: id }
      },
      {
        id: `${id}:end`,
        from: { nodeId: id, port: "success" },
        to: { nodeId: "end" }
      }
    ])
  };
  let run = materializeWorkflowRun({
    runId: "run:race",
    version: publishWorkflowVersion({
      definition,
      workflowVersionId: "version:race",
      publishedAt: context.now()
    }),
    inputs: {},
    context
  });
  const admit = (source: WorkflowRun, nodeId: string) =>
    admitNode({
      run: source,
      nodeId,
      expectedGraphRevision: source.graph.revision,
      expectedNodeStateRevision: source.graph.nodes[nodeId]!.stateRevision,
      context
    });
  const start = admit(run, "start");
  run = settleControlNode({
    run: start.run,
    attemptId: start.attempt.attemptId,
    outcome: "succeeded",
    context
  });
  for (const id of options.startSecond === false ? ["a"] : ["a", "b"]) {
    const next = admit(run, id);
    const execution = {
      targetId: "local",
      targetAuthority: "desktop:fixture",
      surfaceId: `surface:${id}`,
      sessionId: `session:${id}`,
      generation: { kind: "local" as const, runtimeEpoch: `epoch:${id}` },
      inputAuthorityRef: `authority:${id}`
    };
    const payloadHash = contentHash(`Task ${id}`);
    const prepared = prepareAgentPromptDelivery({
      run: next.run,
      attemptId: next.attempt.attemptId,
      execution,
      readiness: {
        receiptId: `readiness:${id}`,
        execution,
        agentId: "fixture-agent",
        agentInstanceId: `instance:${id}`,
        readyEpoch: `ready:${id}`,
        state: "ready-for-input",
        observedAt: context.now()
      },
      launchReceipt: {
        requested: {},
        effective: {},
        evidence: "executor-applied",
        agentDescriptorRevision: "fixture-v1"
      },
      payloadHash,
      context
    });
    run = settleAgentPromptDelivery({
      run: prepared.run,
      operationId: prepared.delivery.operationId,
      payloadHash,
      outcome: "written",
      context
    });
  }
  const result = (
    source: WorkflowRun,
    id: string,
    outcome: AgentResultSubmission["outcome"]
  ) => {
    const attemptId = source.graph.nodes[id]!.attemptIds[0]!;
    const submission = { outcome, summary: `${id}: ${outcome}` };
    let next = submitAttemptResult({
      run: source,
      attemptId,
      submission,
      submissionHash: contentHash(submission),
      idempotencyKey: `result:${id}`,
      trusted: {},
      context
    }).run;
    next = requestAttemptInputDisposition({
      run: next,
      attemptId,
      disposition: "retain",
      idempotencyKey: `retain:${id}`,
      context
    });
    return settleAttemptInputDisposition({
      run: next,
      attemptId,
      expectedRevision: next.inputControls[attemptId]!.revision,
      disposition: "retain",
      context
    });
  };
  const end = (source: WorkflowRun) => {
    const next = admit(source, "end");
    return settleControlNode({
      run: next.run,
      attemptId: next.attempt.attemptId,
      outcome: "succeeded",
      context
    });
  };
  return { run, result, end, context };
}

it("pins the first committed winner and waits for other owned attempts to settle", () => {
  const { run, result, end, context } = race("wait");
  const first = result(run, "a", "succeeded");
  expect(first.graph.nodes.end?.joinResolution).toMatchObject({
    winningPredecessorId: "a",
    otherPredecessorIds: ["b"],
    disposition: "wait"
  });
  const waiting = end(first);
  expect(waiting.status).not.toBe("succeeded");
  expect(Object.values(waiting.cancellations)).toHaveLength(0);
  expect(waiting.graph.nodes.b?.status).toBe("running");
  const finished = result(waiting, "b", "succeeded");
  expect(finished.status).toBe("succeeded");
  expect(recoverRun(finished, context).graph.nodes.end?.joinResolution).toEqual(
    first.graph.nodes.end?.joinResolution
  );
});

it("keeps a race satisfiable after a failed candidate, and records unsatisfied only after all candidates fail", () => {
  const { run, result } = race("wait");
  const first = result(run, "a", "failed");
  expect(first.status).toBe("running");
  expect(first.graph.nodes.end?.status).toBe("pending");
  const succeeded = result(first, "b", "succeeded");
  expect(succeeded.graph.nodes.end?.joinResolution).toMatchObject({
    winningPredecessorId: "b",
    outcome: "satisfied"
  });
  const failed = result(first, "b", "failed");
  expect(failed.status).toBe("failed");
  expect(failed.graph.nodes.end?.joinResolution).toMatchObject({
    outcome: "unsatisfied",
    selectedPredecessors: ["a", "b"]
  });
});

it("cancels a losing execution once and cannot finish until exact cancellation is confirmed", () => {
  const { run, result, end, context } = race("cancel");
  const first = result(run, "a", "succeeded");
  const operation = Object.values(first.cancellations)[0]!;
  expect(operation).toMatchObject({
    joinNodeId: "end",
    state: "requested",
    attemptId: run.graph.nodes.b!.activeAttemptId
  });
  const draining = end(first);
  expect(draining.status).not.toBe("succeeded");
  expect(Object.values(draining.cancellations)).toHaveLength(1);
  expect(
    Object.values(draining.leases).some(
      (lease) =>
        lease.owner.id === operation.attemptId && lease.state === "active"
    )
  ).toBe(true);
  const uncertain = markCancellationUncertain({
    run: draining,
    operationId: operation.operationId
  });
  expect(uncertain.status).not.toBe("succeeded");
  expect(() =>
    confirmAttemptCancellation({
      run: uncertain,
      operationId: operation.operationId,
      executorReceiptId: "unproven",
      context
    })
  ).toThrow(/reconciliation/);
  const done = confirmAttemptCancellation({
    run: draining,
    operationId: operation.operationId,
    executorReceiptId: "process-group-stopped",
    context
  });
  expect(done.status).toBe("succeeded");
  expect(done.attemptResults[operation.attemptId]).toMatchObject({
    outcome: "canceled"
  });
  expect(
    Object.values(done.leases)
      .filter((lease) => lease.owner.id === operation.attemptId)
      .every((lease) => lease.state === "released")
  ).toBe(true);
});

it("requires reconciliation of uncertain resources even when every join candidate has submitted a result", () => {
  const { run, result, end, context } = race("wait");
  const first = end(result(run, "a", "succeeded"));
  const attemptId = first.graph.nodes.b!.activeAttemptId!;
  const lease = Object.values(first.leases).find(
    (entry) => entry.owner.id === attemptId
  )!;
  const uncertain = markLeaseUncertain({
    run: first,
    leaseId: lease.leaseId,
    expectedRevision: lease.revision,
    expectedOwnerEpoch: lease.ownerEpoch
  });
  const completedTasks = result(uncertain, "b", "succeeded");
  expect(completedTasks.status).toBe("needs-attention");
  expect(completedTasks.attemptResults[attemptId]?.outcome).toBe("succeeded");
  const reconciled = releaseLease({
    run: completedTasks,
    leaseId: lease.leaseId,
    expectedRevision: completedTasks.leases[lease.leaseId]!.revision,
    expectedOwnerEpoch: lease.ownerEpoch,
    reconciled: true
  });
  expect(recomputeRun(reconciled, context).status).toBe("succeeded");
});

it.each(["cancel"] as const)(
  "does not start an optional losing candidate after an early %s join",
  (disposition) => {
    const { run, result, end } = race(disposition, { startSecond: false });
    const finished = end(result(run, "a", "succeeded"));
    expect(finished.status).toBe("succeeded");
    expect(finished.graph.nodes.b).toMatchObject({
      status: "skipped",
      attemptIds: []
    });
    expect(Object.values(finished.dispatches)).toHaveLength(1);
  }
);

it("cannot silently skip required side effects when a join selects another candidate", () => {
  const canceled = race("cancel", { startSecond: false, requiredSecond: true });
  expect(canceled.result(canceled.run, "a", "succeeded").status).toBe(
    "canceled"
  );
});
