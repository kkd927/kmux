import { canonicalJson, deepClone } from "./canonical";
import type {
  Id,
  JsonValue,
  MailboxConsumer,
  MailboxDelivery,
  MailboxEvent,
  MailboxEventType,
  WorkflowRun
} from "./types";
import { OrchestrationError } from "./types";
import {
  mutableClone,
  type RuntimeContext,
  stale,
  type Mutable
} from "./runtimeState";
import { recomputeRun } from "./runtimeScheduling";

export function beginCoordinatorTurn(input: {
  run: WorkflowRun;
  turnId: Id;
  idempotencyKey: Id;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const turn = run.coordinatorTurns.find(
    (candidate) => candidate.turnId === input.turnId
  );
  if (!turn)
    throw new OrchestrationError("not-found", "Coordinator Turn was not found");
  if (turn.idempotencyKey !== input.idempotencyKey) {
    throw new OrchestrationError(
      "conflict",
      "Coordinator Turn idempotency key mismatch"
    );
  }
  if (turn.status === "active" || turn.status === "committed") return run;
  if (run.coordinatorTurns.some((candidate) => candidate.status === "active")) {
    throw new OrchestrationError(
      "conflict",
      "only one Coordinator Turn may be active in an authority epoch"
    );
  }
  if (turn.authorityEpoch !== run.coordinationAuthorityEpoch) {
    throw new OrchestrationError(
      "unauthorized",
      "Coordinator Turn belongs to a stale authority epoch"
    );
  }
  turn.status = "active";
  return run;
}

export function commitCoordinatorTurn(input: {
  run: WorkflowRun;
  turnId: Id;
  resultingGraphRevision: number;
  summary?: string;
  context: RuntimeContext;
}): WorkflowRun {
  const run = mutableClone(input.run);
  const turn = run.coordinatorTurns.find(
    (candidate) => candidate.turnId === input.turnId
  );
  if (!turn)
    throw new OrchestrationError("not-found", "Coordinator Turn was not found");
  if (turn.status === "committed") return run;
  if (turn.status !== "active") {
    throw new OrchestrationError(
      "conflict",
      "only an active Coordinator Turn can commit"
    );
  }
  if (turn.authorityEpoch !== run.coordinationAuthorityEpoch) {
    throw new OrchestrationError(
      "unauthorized",
      "Coordinator Turn belongs to a stale authority epoch"
    );
  }
  if (input.resultingGraphRevision !== run.graph.revision) {
    throw stale(
      "Coordinator Turn",
      run.graph.revision,
      input.resultingGraphRevision
    );
  }
  turn.status = "committed";
  turn.resultingGraphRevision = run.graph.revision;
  turn.receiptId = input.context.id("coordinator-turn-receipt");
  if (input.summary !== undefined) turn.summary = input.summary;
  run.coordinatorConsumedCursor = Math.max(
    run.coordinatorConsumedCursor,
    turn.eventCursorEnd
  );
  return recomputeRun(run, input.context);
}

export function coordinatorMailboxConsumer(run: WorkflowRun): MailboxConsumer {
  const attachment = run.coordinatorAttachment;
  if (attachment?.transport !== "terminal") {
    throw new OrchestrationError(
      "unsupported",
      "This Run has no attached Coordinator terminal"
    );
  }
  return {
    kind: "coordinator",
    surfaceId: attachment.surfaceId,
    sessionId: attachment.sessionId,
    generation: deepClone(attachment.execution.generation)
  };
}

export function dispatchMailboxConsumer(
  run: WorkflowRun,
  dispatchId: Id
): MailboxConsumer {
  const dispatch = run.dispatches[dispatchId];
  if (!dispatch?.execution) {
    throw new OrchestrationError(
      "conflict",
      "Worker Dispatch has no exact terminal generation"
    );
  }
  return {
    kind: "dispatch",
    dispatchId,
    execution: deepClone(dispatch.execution)
  };
}

export function mailboxConsumerKey(consumer: MailboxConsumer): string {
  return consumer.kind === "coordinator"
    ? "coordinator"
    : `dispatch:${consumer.dispatchId}`;
}

export function claimMailboxDelivery(input: {
  run: WorkflowRun;
  consumer: MailboxConsumer;
  types?: readonly MailboxEventType[];
  context: RuntimeContext;
}): {
  readonly run: WorkflowRun;
  readonly delivery: MailboxDelivery | null;
  readonly replayed: boolean;
} {
  const key = mailboxConsumerKey(input.consumer);
  const existing = input.run.mailboxConsumers[key];
  if (
    existing &&
    canonicalJson(existing.consumer as unknown as JsonValue) !==
      canonicalJson(input.consumer as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "mailbox consumer terminal generation is stale"
    );
  }
  if (existing?.activeDelivery) {
    return {
      run: input.run,
      delivery: existing.activeDelivery,
      replayed: true
    };
  }
  const cursor = existing?.acknowledgedCursor ?? 0;
  const pending = input.run.mailboxEvents.filter(
    (event) =>
      event.sequence > cursor && mailboxEventTargets(event, input.consumer)
  );
  if (
    pending.length === 0 ||
    (input.types &&
      input.types.length > 0 &&
      !pending.some((event) => input.types!.includes(event.type)))
  ) {
    return { run: input.run, delivery: null, replayed: false };
  }
  const events = pending.slice(0, 50);
  const delivery: MailboxDelivery = {
    deliveryId: input.context.id("mailbox-delivery"),
    consumer: deepClone(input.consumer),
    cursorStart: events[0]!.sequence,
    cursorEnd: events.at(-1)!.sequence,
    eventIds: events.map((event) => event.eventId),
    claimedAt: input.context.now()
  };
  const run = mutableClone(input.run);
  run.mailboxConsumers[key] = {
    consumerKey: key,
    consumer: deepClone(input.consumer),
    acknowledgedCursor: cursor,
    activeDelivery: deepClone(delivery)
  } as Mutable<(typeof run.mailboxConsumers)[string]>;
  return { run, delivery, replayed: false };
}

/** Validate the exact receipt before any review-triggered terminal effects. */
export function mailboxDeliveryForAcknowledgement(input: {
  run: WorkflowRun;
  consumer: MailboxConsumer;
  deliveryId: Id;
}): MailboxDelivery {
  const key = mailboxConsumerKey(input.consumer);
  const sourceState = input.run.mailboxConsumers[key];
  const delivery = sourceState?.activeDelivery;
  if (
    !sourceState ||
    !delivery ||
    delivery.deliveryId !== input.deliveryId ||
    canonicalJson(sourceState.consumer as unknown as JsonValue) !==
      canonicalJson(input.consumer as unknown as JsonValue)
  ) {
    throw new OrchestrationError(
      "conflict",
      "Acknowledge only a Delivery received by this exact mailbox consumer"
    );
  }
  const events = delivery.eventIds
    .map((eventId) =>
      input.run.mailboxEvents.find((event) => event.eventId === eventId)
    )
    .filter((event): event is MailboxEvent => event !== undefined);
  if (events.length !== delivery.eventIds.length) {
    throw new OrchestrationError(
      "conflict",
      "mailbox Delivery references unavailable immutable events"
    );
  }
  return delivery;
}

/** Only accepted results may authorize policy-driven cleanup. */
export function reviewedWorkerTerminalDisposition(
  run: WorkflowRun,
  attemptId: Id
): "retain" | "release" {
  const outcome = run.attemptResults[attemptId]?.outcome;
  return (outcome === "succeeded" || outcome === "failed") &&
    run.workerTerminalPolicy?.[outcome] === "release"
    ? "release"
    : "retain";
}

export function acknowledgeMailboxDelivery(input: {
  run: WorkflowRun;
  consumer: MailboxConsumer;
  deliveryId: Id;
  context: RuntimeContext;
}): WorkflowRun {
  const delivery = mailboxDeliveryForAcknowledgement(input);
  const events = mailboxEventsForDelivery(input.run, delivery);
  const key = mailboxConsumerKey(input.consumer);
  if (input.consumer.kind === "coordinator") {
    const unsettled = events
      .filter((event) => event.type === "worker_done" && event.attemptId)
      .map((event) => input.run.attempts[event.attemptId!]?.dispatchId)
      .filter((dispatchId): dispatchId is Id => Boolean(dispatchId))
      .map((dispatchId) => input.run.dispatches[dispatchId])
      .find(
        (dispatch) =>
          dispatch &&
          dispatch.terminalState !== undefined &&
          !["retained", "released"].includes(dispatch.terminalState)
      );
    if (unsettled) {
      throw new OrchestrationError(
        "conflict",
        `Worker '${unsettled.dispatchId}' must be reused, retained, or released before acknowledging worker_done`
      );
    }
  }
  const run = mutableClone(input.run);
  const state = run.mailboxConsumers[key]!;
  state.acknowledgedCursor = delivery.cursorEnd;
  delete state.activeDelivery;
  if (input.consumer.kind === "dispatch") {
    for (const event of events) {
      if (event.type !== "reply" || !event.messageId) continue;
      const reply = run.messages.find(
        (message) => message.messageId === event.messageId
      );
      const question = reply?.replyToMessageId
        ? run.messages.find(
            (message) => message.messageId === reply.replyToMessageId
          )
        : undefined;
      const attempt = question?.attemptId
        ? run.attempts[question.attemptId]
        : undefined;
      const dispatch = attempt?.dispatchId
        ? run.dispatches[attempt.dispatchId]
        : undefined;
      if (
        attempt?.status === "waiting-input" &&
        dispatch?.dispatchId === input.consumer.dispatchId
      ) {
        attempt.status = "running";
        const node = run.graph.nodes[attempt.nodeId];
        if (node?.status === "waiting-input") {
          node.status = "running";
          node.stateRevision += 1;
        }
      }
    }
  }
  return recomputeRun(run, input.context);
}

export function mailboxEventsForDelivery(
  run: WorkflowRun,
  delivery: MailboxDelivery
): readonly MailboxEvent[] {
  const ids = new Set(delivery.eventIds);
  return run.mailboxEvents.filter((event) => ids.has(event.eventId));
}

export function pendingDispatchMailboxCount(
  run: WorkflowRun,
  dispatchId: Id
): number {
  const key = `dispatch:${dispatchId}`;
  const state = run.mailboxConsumers[key];
  const cursor = state?.acknowledgedCursor ?? 0;
  return run.mailboxEvents.filter(
    (event) =>
      event.sequence > cursor &&
      event.target.kind === "dispatch" &&
      event.target.dispatchId === dispatchId
  ).length;
}

function mailboxEventTargets(
  event: MailboxEvent,
  consumer: MailboxConsumer
): boolean {
  return consumer.kind === "coordinator"
    ? event.target.kind === "coordinator"
    : event.target.kind === "dispatch" &&
        event.target.dispatchId === consumer.dispatchId;
}

export function appendMailboxEvent(
  run: Mutable<WorkflowRun>,
  event: Omit<MailboxEvent, "eventId" | "runId" | "sequence" | "createdAt">,
  context: RuntimeContext
): MailboxEvent {
  const sequence = run.mailboxSequence + 1;
  const record: MailboxEvent = {
    eventId: context.id("mailbox-event"),
    runId: run.runId,
    sequence,
    ...deepClone(event),
    createdAt: context.now()
  };
  run.mailboxSequence = sequence;
  run.mailboxEvents.push(record as Mutable<MailboxEvent>);
  return record;
}
