import { deepClone } from "./canonical";
import {
  OrchestrationError,
  type AuditEvent,
  type Id,
  type JsonValue,
  type OrchestrationSnapshot
} from "./types";
import { createEmptyOrchestrationSnapshot } from "./runtime";

export interface TransactionMetadata {
  readonly type: string;
  readonly principal: Id;
  readonly runId?: Id;
  readonly payload?: JsonValue;
  readonly expectedStoreRevision?: number;
}

interface DispatchOwner {
  runId: Id;
  dispatchId: Id;
}

function indexReclaimableTerminals(snapshot: OrchestrationSnapshot) {
  const owners = new Map<string, DispatchOwner[]>();
  for (const run of Object.values(snapshot.runs)) {
    for (const dispatch of Object.values(run.dispatches ?? {})) {
      const execution = dispatch.execution;
      if (
        execution?.generation.kind !== "local" ||
        !["reclaimable", "release-pending"].includes(
          dispatch.terminalState ?? "active"
        )
      )
        continue;
      const key = JSON.stringify([
        execution.surfaceId,
        execution.sessionId,
        execution.generation.runtimeEpoch
      ]);
      const references = owners.get(key) ?? [];
      references.push({ runId: run.runId, dispatchId: dispatch.dispatchId });
      owners.set(key, references);
    }
  }
  return owners;
}

export interface OrchestrationStore {
  takeoverCandidates(
    surfaceId: Id,
    sessionId: Id,
    epoch: Id
  ): Promise<readonly DispatchOwner[]>;
  read(): Promise<OrchestrationSnapshot>;
  waitFor<T>(
    query: (snapshot: OrchestrationSnapshot, expired: boolean) => T | undefined,
    timeoutMs: number
  ): Promise<T>;
  subscribe(listener: (snapshot: OrchestrationSnapshot) => void): () => void;
  transact<T>(
    metadata: TransactionMetadata,
    operation: (snapshot: OrchestrationSnapshot) => {
      readonly snapshot: OrchestrationSnapshot;
      readonly value: T;
    }
  ): Promise<T>;
}

export class InMemoryOrchestrationStore implements OrchestrationStore {
  private takeoverIndex: Map<string, DispatchOwner[]>;
  private snapshot: OrchestrationSnapshot;
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    snapshot: OrchestrationSnapshot = createEmptyOrchestrationSnapshot(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: (kind: string) => string = (kind) =>
      `${kind}:${crypto.randomUUID()}`
  ) {
    this.snapshot = deepClone(snapshot);
    this.takeoverIndex = indexReclaimableTerminals(snapshot);
  }

  async takeoverCandidates(
    surfaceId: Id,
    sessionId: Id,
    epoch: Id
  ): Promise<readonly DispatchOwner[]> {
    await this.tail;
    return (
      this.takeoverIndex.get(JSON.stringify([surfaceId, sessionId, epoch])) ??
      []
    );
  }

  async read(): Promise<OrchestrationSnapshot> {
    await this.tail;
    return deepClone(this.snapshot);
  }

  subscribe(listener: (snapshot: OrchestrationSnapshot) => void): () => void {
    const notify = () => listener(deepClone(this.snapshot));
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  }

  /** Evaluate a read-only projection on commit and copy just its final result. */
  async waitFor<T>(
    query: (snapshot: OrchestrationSnapshot, expired: boolean) => T | undefined,
    timeoutMs: number
  ): Promise<T> {
    await this.tail;
    return new Promise((resolve, reject) => {
      const evaluate = (expired: boolean) => {
        try {
          const result = query(this.snapshot, expired);
          if (result !== undefined) resolve(deepClone(result));
          else if (!expired) return;
          else reject(new Error("Store query timed out"));
        } catch (error) {
          reject(error);
        }
        clearTimeout(timer);
        this.listeners.delete(onCommit);
      };
      const onCommit = () => evaluate(false);
      const timer = setTimeout(() => evaluate(true), timeoutMs);
      this.listeners.add(onCommit);
      onCommit();
    });
  }

  async transact<T>(
    metadata: TransactionMetadata,
    operation: (snapshot: OrchestrationSnapshot) => {
      readonly snapshot: OrchestrationSnapshot;
      readonly value: T;
    }
  ): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.tail = this.tail.then(async () => {
      try {
        if (
          metadata.expectedStoreRevision !== undefined &&
          metadata.expectedStoreRevision !== this.snapshot.revision
        ) {
          throw new OrchestrationError(
            "stale-revision",
            `store expected revision ${metadata.expectedStoreRevision}, current revision is ${this.snapshot.revision}`
          );
        }
        const current = deepClone(this.snapshot);
        const outcome = operation(current);
        const committed = appendAuditEvent(
          outcome.snapshot,
          metadata,
          this.now(),
          this.id("event")
        );
        const takeoverIndex = indexReclaimableTerminals(committed);
        await this.persist(committed);
        this.snapshot = committed;
        this.takeoverIndex = takeoverIndex;
        resolve(outcome.value);
        for (const listener of this.listeners) {
          // Observers cannot alter a durable commit or its transaction outcome.
          try {
            listener();
          } catch {
            /* isolated observer */
          }
        }
      } catch (error) {
        reject(error);
      }
    });
    await this.tail;
    return result;
  }

  protected async persist(_snapshot: OrchestrationSnapshot): Promise<void> {}
}

export function appendAuditEvent(
  source: OrchestrationSnapshot,
  metadata: TransactionMetadata,
  occurredAt: string,
  eventId: Id
): OrchestrationSnapshot {
  const snapshot = deepClone(source) as {
    -readonly [K in keyof OrchestrationSnapshot]: OrchestrationSnapshot[K];
  };
  const sequence = source.revision + 1;
  const event: AuditEvent = {
    eventId,
    sequence,
    occurredAt,
    ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
    type: metadata.type,
    principal: metadata.principal,
    payload: metadata.payload ?? null
  };
  snapshot.revision = sequence;
  snapshot.auditEvents = [...source.auditEvents, event];
  return snapshot;
}
