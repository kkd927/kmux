import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { RemoteResourceKey, RemoteSessionStorageStatus } from "@kmux/core";
import {
  formatUint64Decimal,
  parseUint64Decimal,
  type Id,
  type RemotePersistenceLevel,
  type Uint64
} from "@kmux/proto";

import { durableAtomicReplace } from "./durableAtomicWrite";
import type { ObservedSessionKeeper } from "./remoteReconciler";

const INVENTORY_VERSION = 1;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_ID_BYTES = 256;

export type RetainedSessionReason =
  | "restore-disabled"
  | "workspace-close"
  | "unowned-observation"
  | "termination-pending";

export interface RetainedSessionTermination {
  operationId: Id;
  canonicalPayloadHash: string;
  expectedWorkspaceRevision: string;
  expectedRemoteResourceRevision: Uint64;
  nextRemoteResourceRevision: Uint64;
  admittedAt: string;
  priorReason: Exclude<RetainedSessionReason, "termination-pending">;
  resultDigest?: string;
}

export interface RetainedSessionTerminationFailure {
  operationId: Id;
  resultDigest: string;
  code: string;
  message: string;
  completedAt: string;
}

/**
 * A bounded Main-owned descriptor cache. `owned-cache` rows are deliberately
 * hidden from retained-session consumers; they let a clean restore-disabled
 * shutdown durably preserve the last authoritative descriptor before the
 * ordinary product snapshot drops its layout.
 */
export interface RetainedSessionInventoryEntry {
  resourceKey: RemoteResourceKey & { sessionId: Id };
  ownership: "owned-cache" | "retained";
  reason?: RetainedSessionReason;
  keeperGeneration: Id;
  remoteResourceRevision: Uint64;
  processState: "running" | "exited";
  persistenceLevel: RemotePersistenceLevel;
  storageStatus: RemoteSessionStorageStatus;
  checkpointAvailable: boolean;
  retainedRangeTruncated: boolean;
  exitCode?: number;
  descriptor: NonNullable<ObservedSessionKeeper["descriptor"]>;
  retainedAt?: string;
  lastObservedAt: string;
  termination?: RetainedSessionTermination;
  lastTerminationFailure?: RetainedSessionTerminationFailure;
}

export type RetainedSessionObservationUpdate =
  | {
      disposition: "owned";
      keeper: ObservedSessionKeeper;
      observedAt: string;
    }
  | {
      disposition: "retained";
      keeper: ObservedSessionKeeper;
      reason: Exclude<RetainedSessionReason, "termination-pending">;
      observedAt: string;
      retainedAt?: string;
    };

interface RetainedSessionInventoryEntryDto extends Omit<
  RetainedSessionInventoryEntry,
  "remoteResourceRevision" | "storageStatus" | "termination"
> {
  remoteResourceRevision: string;
  storageStatus: {
    state: "normal" | "degraded" | "backpressured";
    journalAdmitted: string;
    journalSynced: string;
    emergencyBytes: number;
    lastSyncDurationMs?: number;
  };
  termination?: Omit<
    RetainedSessionTermination,
    "expectedRemoteResourceRevision" | "nextRemoteResourceRevision"
  > & {
    expectedRemoteResourceRevision: string;
    nextRemoteResourceRevision: string;
  };
}

interface RetainedSessionInventoryEnvelope {
  version: 1;
  entries: RetainedSessionInventoryEntryDto[];
  entriesDigest: string;
}

export interface RetainedSessionInventoryStore {
  synchronizeObserved(
    updates: RetainedSessionObservationUpdate[]
  ): RetainedSessionInventoryEntry[];
  cacheOwned(
    keeper: ObservedSessionKeeper,
    observedAt: string
  ): RetainedSessionInventoryEntry;
  retain(
    keeper: ObservedSessionKeeper,
    reason: Exclude<RetainedSessionReason, "termination-pending">,
    observedAt: string,
    retainedAt?: string
  ): RetainedSessionInventoryEntry;
  retainCached(
    resourceKey: RemoteResourceKey & { sessionId: Id },
    reason: "restore-disabled" | "workspace-close",
    retainedAt?: string
  ): RetainedSessionInventoryEntry;
  retainCachedMany(
    resourceKeys: Array<RemoteResourceKey & { sessionId: Id }>,
    reason: "restore-disabled" | "workspace-close",
    retainedAt?: string
  ): RetainedSessionInventoryEntry[];
  markTerminationPending(
    keeper: ObservedSessionKeeper,
    observedAt: string,
    termination: RetainedSessionTermination
  ): RetainedSessionInventoryEntry;
  admitRetainedTermination(
    resourceKey: RemoteResourceKey & { sessionId: Id },
    termination: RetainedSessionTermination
  ): RetainedSessionInventoryEntry;
  recordTerminationResult(
    resourceKey: RemoteResourceKey & { sessionId: Id },
    operationId: Id,
    resultDigest: string
  ): RetainedSessionInventoryEntry;
  recordTerminationFailure(
    resourceKey: RemoteResourceKey & { sessionId: Id },
    failure: RetainedSessionTerminationFailure
  ): RetainedSessionInventoryEntry;
  clearTermination(
    keeper: ObservedSessionKeeper,
    observedAt: string,
    ownedByProduct: boolean
  ): RetainedSessionInventoryEntry;
  remove(resourceKey: RemoteResourceKey & { sessionId: Id }): boolean;
  get(
    resourceKey: RemoteResourceKey & { sessionId: Id }
  ): RetainedSessionInventoryEntry | null;
  listRetained(): RetainedSessionInventoryEntry[];
  loadAll(): RetainedSessionInventoryEntry[];
}

export interface CreateRetainedSessionInventoryStoreOptions {
  now?: () => string;
  uid?: number;
  write?: (root: string, fileName: string, bytes: Uint8Array) => void;
}

export function createRetainedSessionInventoryStore(
  inventoryPath: string,
  options: CreateRetainedSessionInventoryStoreOptions = {}
): RetainedSessionInventoryStore {
  const path = resolve(inventoryPath);
  const root = dirname(path);
  const fileName = basename(path);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new TypeError("retained-session inventory path is invalid");
  }
  const uid = options.uid ?? currentUid();
  const write = options.write ?? durableAtomicReplace;
  const now = options.now ?? (() => new Date().toISOString());
  let entries = readInventory(path, uid);

  const persist = (nextEntries: RetainedSessionInventoryEntry[]): void => {
    const sorted = nextEntries
      .map(cloneEntry)
      .sort((left, right) =>
        resourceKeyId(left.resourceKey).localeCompare(
          resourceKeyId(right.resourceKey)
        )
      );
    if (sorted.length > MAX_ENTRIES) {
      throw new RangeError(
        "retained-session inventory contains too many entries"
      );
    }
    const encodedEntries = sorted.map(encodeEntry);
    for (const entry of encodedEntries) {
      if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_ENTRY_BYTES) {
        throw new RangeError(
          "retained-session inventory entry exceeds its limit"
        );
      }
    }
    const envelope: RetainedSessionInventoryEnvelope = {
      version: INVENTORY_VERSION,
      entries: encodedEntries,
      entriesDigest: sha256(canonicalJson(encodedEntries))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_INVENTORY_BYTES) {
      throw new RangeError("retained-session inventory exceeds its limit");
    }
    write(root, fileName, bytes);
    entries = sorted;
  };

  const replace = (
    entry: RetainedSessionInventoryEntry
  ): RetainedSessionInventoryEntry => {
    const validated = decodeEntry(encodeEntry(entry));
    const key = resourceKeyId(validated.resourceKey);
    const existing = entries.find(
      (candidate) => resourceKeyId(candidate.resourceKey) === key
    );
    if (existing && sameEntryExceptObservation(existing, validated)) {
      const current = laterObservation(existing, validated);
      entries = entries.map((candidate) =>
        resourceKeyId(candidate.resourceKey) === key ? current : candidate
      );
      return cloneEntry(current);
    }
    const next = entries.filter(
      (candidate) => resourceKeyId(candidate.resourceKey) !== key
    );
    next.push(validated);
    persist(next);
    return cloneEntry(validated);
  };

  const get = (
    resourceKey: RemoteResourceKey & { sessionId: Id }
  ): RetainedSessionInventoryEntry | null => {
    const key = resourceKeyId(validateResourceKey(resourceKey));
    const entry = entries.find(
      (candidate) => resourceKeyId(candidate.resourceKey) === key
    );
    return entry ? cloneEntry(entry) : null;
  };

  const synchronizeObserved = (
    updates: RetainedSessionObservationUpdate[]
  ): RetainedSessionInventoryEntry[] => {
    if (!Array.isArray(updates) || updates.length > MAX_ENTRIES) {
      throw new RangeError(
        "retained-session observation batch exceeds its limit"
      );
    }
    const byKey = new Map(
      entries.map((entry) => [resourceKeyId(entry.resourceKey), entry])
    );
    const seen = new Set<string>();
    let changed = false;
    const synchronized = updates.map((update) => {
      const observed = entryFromKeeper(update.keeper, update.observedAt);
      const key = resourceKeyId(observed.resourceKey);
      if (seen.has(key)) {
        throw new TypeError(
          "retained-session observation batch contains a duplicate resource"
        );
      }
      seen.add(key);
      const existing = byKey.get(key);
      let candidate: RetainedSessionInventoryEntry;
      if (existing?.termination) {
        candidate = {
          ...observed,
          ownership: "retained",
          reason: "termination-pending",
          retainedAt:
            existing.retainedAt ??
            (update.disposition === "retained" && update.retainedAt
              ? requireTimestamp(update.retainedAt, "retainedAt")
              : now()),
          termination: existing.termination
        };
      } else if (update.disposition === "owned") {
        candidate = { ...observed, ownership: "owned-cache" };
      } else {
        requireRetentionReason(update.reason, false);
        const retainedReason =
          update.reason === "unowned-observation" &&
          (existing?.reason === "restore-disabled" ||
            existing?.reason === "workspace-close")
            ? existing.reason
            : update.reason;
        candidate = {
          ...observed,
          ownership: "retained",
          reason: retainedReason,
          retainedAt:
            existing?.retainedAt ??
            requireTimestamp(update.retainedAt ?? now(), "retainedAt"),
          ...(existing?.lastTerminationFailure === undefined
            ? {}
            : {
                lastTerminationFailure: existing.lastTerminationFailure
              })
        };
      }
      const validated = decodeEntry(encodeEntry(candidate));
      const effective =
        existing && sameEntryExceptObservation(existing, validated)
          ? laterObservation(existing, validated)
          : validated;
      if (!existing || !sameEntryExceptObservation(existing, validated)) {
        changed = true;
      }
      byKey.set(key, effective);
      return cloneEntry(effective);
    });
    if (changed) {
      persist([...byKey.values()]);
    } else {
      // Observation timestamps stay current for the live UI without forcing
      // an fsync on every otherwise-identical reconnect. The next material
      // inventory write carries the newest timestamp durably.
      entries = [...byKey.values()].sort((left, right) =>
        resourceKeyId(left.resourceKey).localeCompare(
          resourceKeyId(right.resourceKey)
        )
      );
    }
    return synchronized;
  };

  const retainCachedMany = (
    resourceKeys: Array<RemoteResourceKey & { sessionId: Id }>,
    reason: "restore-disabled" | "workspace-close",
    retainedAt = now()
  ): RetainedSessionInventoryEntry[] => {
    requireRetentionReason(reason, false);
    const at = requireTimestamp(retainedAt, "retainedAt");
    const keys = resourceKeys.map((resourceKey) =>
      resourceKeyId(validateResourceKey(resourceKey))
    );
    if (new Set(keys).size !== keys.length) {
      throw new TypeError(
        "retained-session batch contains a duplicate resource"
      );
    }
    const byKey = new Map(
      entries.map((entry) => [resourceKeyId(entry.resourceKey), entry])
    );
    const retained = keys.map((key) => {
      const existing = byKey.get(key);
      if (!existing) {
        throw new Error(
          "no authoritative remote descriptor is cached for retention"
        );
      }
      return decodeEntry(
        encodeEntry({
          ...existing,
          ownership: "retained",
          reason: existing.termination ? "termination-pending" : reason,
          retainedAt: existing.retainedAt ?? at
        })
      );
    });
    for (const entry of retained) {
      byKey.set(resourceKeyId(entry.resourceKey), entry);
    }
    if (
      retained.some((entry) => {
        const existing = entries.find(
          (candidate) =>
            resourceKeyId(candidate.resourceKey) ===
            resourceKeyId(entry.resourceKey)
        );
        return !existing || !sameEntryExceptObservation(existing, entry);
      })
    ) {
      persist([...byKey.values()]);
    }
    return retained.map(cloneEntry);
  };

  return Object.freeze({
    synchronizeObserved,

    cacheOwned(
      keeper: ObservedSessionKeeper,
      observedAt: string
    ): RetainedSessionInventoryEntry {
      return synchronizeObserved([
        { disposition: "owned", keeper, observedAt }
      ])[0]!;
    },

    retain(
      keeper: ObservedSessionKeeper,
      reason: Exclude<RetainedSessionReason, "termination-pending">,
      observedAt: string,
      retainedAt = now()
    ): RetainedSessionInventoryEntry {
      return synchronizeObserved([
        {
          disposition: "retained",
          keeper,
          reason,
          observedAt,
          retainedAt
        }
      ])[0]!;
    },

    retainCached(
      resourceKey: RemoteResourceKey & { sessionId: Id },
      reason: "restore-disabled" | "workspace-close",
      retainedAt = now()
    ): RetainedSessionInventoryEntry {
      requireRetentionReason(reason, false);
      const [retained] = retainCachedMany([resourceKey], reason, retainedAt);
      return retained;
    },

    retainCachedMany,

    markTerminationPending(
      keeper: ObservedSessionKeeper,
      observedAt: string,
      termination: RetainedSessionTermination
    ): RetainedSessionInventoryEntry {
      const observed = entryFromKeeper(keeper, observedAt);
      const validatedTermination = decodeTermination(
        encodeTermination(termination)
      );
      const existing = get(observed.resourceKey);
      if (
        existing?.termination &&
        !sameTerminationAdmission(existing.termination, validatedTermination)
      ) {
        throw new Error(
          "retained session already has another termination operation"
        );
      }
      if (
        !existing?.termination &&
        observed.remoteResourceRevision !==
          validatedTermination.expectedRemoteResourceRevision &&
        !observedMatchesTerminationTombstone(observed, validatedTermination)
      ) {
        throw new Error(
          "retained termination expected another remote resource revision"
        );
      }
      return replace({
        ...observed,
        ownership: "retained",
        reason: "termination-pending",
        retainedAt: existing?.retainedAt ?? now(),
        termination: existing?.termination ?? validatedTermination
      });
    },

    admitRetainedTermination(
      resourceKey: RemoteResourceKey & { sessionId: Id },
      termination: RetainedSessionTermination
    ): RetainedSessionInventoryEntry {
      const existing = get(resourceKey);
      if (!existing || existing.ownership !== "retained") {
        throw new Error(
          "retained termination requires a retained-session descriptor"
        );
      }
      const validatedTermination = decodeTermination(
        encodeTermination(termination)
      );
      if (existing.termination) {
        if (
          !sameTerminationAdmission(existing.termination, validatedTermination)
        ) {
          throw new Error(
            "retained session already has another termination operation"
          );
        }
        return existing;
      }
      if (
        existing.processState !== "running" ||
        existing.remoteResourceRevision !==
          validatedTermination.expectedRemoteResourceRevision
      ) {
        throw new Error(
          "retained termination requires the current running descriptor revision"
        );
      }
      const {
        lastTerminationFailure: _lastTerminationFailure,
        ...withoutFailure
      } = existing;
      return replace({
        ...withoutFailure,
        reason: "termination-pending",
        termination: validatedTermination
      });
    },

    recordTerminationResult(
      resourceKey: RemoteResourceKey & { sessionId: Id },
      operationId: Id,
      resultDigest: string
    ): RetainedSessionInventoryEntry {
      const existing = get(resourceKey);
      if (
        !existing?.termination ||
        existing.termination.operationId !== operationId
      ) {
        throw new Error(
          "retained termination result has no matching admission"
        );
      }
      const digest = requireDigest(resultDigest, "resultDigest");
      if (
        existing.termination.resultDigest !== undefined &&
        existing.termination.resultDigest !== digest
      ) {
        throw new Error(
          "retained termination result conflicts with its prior result"
        );
      }
      return replace({
        ...existing,
        termination: { ...existing.termination, resultDigest: digest }
      });
    },

    recordTerminationFailure(
      resourceKey: RemoteResourceKey & { sessionId: Id },
      failure: RetainedSessionTerminationFailure
    ): RetainedSessionInventoryEntry {
      const existing = get(resourceKey);
      const validatedFailure = decodeTerminationFailure(failure);
      if (
        !existing?.termination ||
        existing.termination.operationId !== validatedFailure.operationId
      ) {
        throw new Error(
          "retained termination failure has no matching admission"
        );
      }
      const { termination: _termination, ...withoutTermination } = existing;
      return replace({
        ...withoutTermination,
        reason: existing.termination.priorReason,
        lastTerminationFailure: validatedFailure
      });
    },

    clearTermination(
      keeper: ObservedSessionKeeper,
      observedAt: string,
      ownedByProduct: boolean
    ): RetainedSessionInventoryEntry {
      const observed = entryFromKeeper(keeper, observedAt);
      const existing = get(observed.resourceKey);
      return replace(
        ownedByProduct
          ? { ...observed, ownership: "owned-cache" }
          : {
              ...observed,
              ownership: "retained",
              reason:
                existing?.termination?.priorReason ??
                (existing?.reason === "termination-pending"
                  ? "unowned-observation"
                  : (existing?.reason ?? "unowned-observation")),
              retainedAt: existing?.retainedAt ?? now(),
              ...(existing?.lastTerminationFailure === undefined
                ? {}
                : {
                    lastTerminationFailure: existing.lastTerminationFailure
                  })
            }
      );
    },

    remove(resourceKey: RemoteResourceKey & { sessionId: Id }): boolean {
      const key = resourceKeyId(validateResourceKey(resourceKey));
      const next = entries.filter(
        (candidate) => resourceKeyId(candidate.resourceKey) !== key
      );
      if (next.length === entries.length) return false;
      persist(next);
      return true;
    },

    get,

    listRetained(): RetainedSessionInventoryEntry[] {
      return entries
        .filter((entry) => entry.ownership === "retained")
        .map(cloneEntry);
    },

    loadAll(): RetainedSessionInventoryEntry[] {
      return entries.map(cloneEntry);
    }
  });
}

export function retainedTerminationHasDurableTombstone(
  entry: RetainedSessionInventoryEntry,
  keeper: ObservedSessionKeeper
): boolean {
  const termination = entry.termination;
  const descriptor = keeper.descriptor;
  return Boolean(
    termination?.resultDigest &&
    descriptor &&
    keeper.processState === "exited" &&
    keeper.resourceKey.desktopInstallationId ===
      entry.resourceKey.desktopInstallationId &&
    keeper.resourceKey.targetId === entry.resourceKey.targetId &&
    keeper.resourceKey.workspaceId === entry.resourceKey.workspaceId &&
    keeper.resourceKey.sessionId === entry.resourceKey.sessionId &&
    keeper.remoteResourceRevision === termination.nextRemoteResourceRevision &&
    descriptor.lastOperationId === termination.operationId &&
    descriptor.lastOperationPayloadHash === termination.canonicalPayloadHash &&
    descriptor.lastResultDigest === termination.resultDigest
  );
}

function observedMatchesTerminationTombstone(
  observed: Omit<RetainedSessionInventoryEntry, "ownership">,
  termination: RetainedSessionTermination
): boolean {
  return Boolean(
    termination.resultDigest &&
    observed.processState === "exited" &&
    observed.remoteResourceRevision ===
      termination.nextRemoteResourceRevision &&
    observed.descriptor.lastOperationId === termination.operationId &&
    observed.descriptor.lastOperationPayloadHash ===
      termination.canonicalPayloadHash &&
    observed.descriptor.lastResultDigest === termination.resultDigest
  );
}

function entryFromKeeper(
  keeper: ObservedSessionKeeper,
  observedAt: string
): Omit<RetainedSessionInventoryEntry, "ownership"> {
  if (!keeper.descriptor) {
    throw new Error(
      "retained sessions require authoritative descriptor evidence"
    );
  }
  return decodeEntry(
    encodeEntry({
      resourceKey: keeper.resourceKey,
      ownership: "owned-cache",
      keeperGeneration: keeper.generation,
      remoteResourceRevision: keeper.remoteResourceRevision,
      processState: keeper.processState,
      persistenceLevel: keeper.persistenceLevel,
      storageStatus: keeper.storageStatus,
      checkpointAvailable: keeper.checkpointAvailable,
      retainedRangeTruncated: keeper.retainedRangeTruncated,
      ...(keeper.exitCode === undefined ? {} : { exitCode: keeper.exitCode }),
      descriptor: keeper.descriptor,
      lastObservedAt: requireTimestamp(observedAt, "lastObservedAt")
    })
  );
}

function encodeEntry(
  entry: RetainedSessionInventoryEntry
): RetainedSessionInventoryEntryDto {
  return {
    resourceKey: structuredClone(entry.resourceKey),
    ownership: entry.ownership,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    keeperGeneration: entry.keeperGeneration,
    remoteResourceRevision: formatUint64Decimal(entry.remoteResourceRevision),
    processState: entry.processState,
    persistenceLevel: entry.persistenceLevel,
    storageStatus: {
      state: entry.storageStatus.state,
      journalAdmitted: formatUint64Decimal(entry.storageStatus.journalAdmitted),
      journalSynced: formatUint64Decimal(entry.storageStatus.journalSynced),
      emergencyBytes: entry.storageStatus.emergencyBytes,
      ...(entry.storageStatus.lastSyncDurationMs === undefined
        ? {}
        : { lastSyncDurationMs: entry.storageStatus.lastSyncDurationMs })
    },
    checkpointAvailable: entry.checkpointAvailable,
    retainedRangeTruncated: entry.retainedRangeTruncated,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    descriptor: structuredClone(entry.descriptor),
    ...(entry.retainedAt === undefined ? {} : { retainedAt: entry.retainedAt }),
    lastObservedAt: entry.lastObservedAt,
    ...(entry.termination === undefined
      ? {}
      : { termination: encodeTermination(entry.termination) }),
    ...(entry.lastTerminationFailure === undefined
      ? {}
      : {
          lastTerminationFailure: encodeTerminationFailure(
            entry.lastTerminationFailure
          )
        })
  };
}

function sameEntryExceptObservation(
  left: RetainedSessionInventoryEntry,
  right: RetainedSessionInventoryEntry
): boolean {
  const { lastObservedAt: _leftObservedAt, ...leftStable } = encodeEntry(left);
  const { lastObservedAt: _rightObservedAt, ...rightStable } =
    encodeEntry(right);
  return canonicalJson(leftStable) === canonicalJson(rightStable);
}

function laterObservation(
  existing: RetainedSessionInventoryEntry,
  candidate: RetainedSessionInventoryEntry
): RetainedSessionInventoryEntry {
  return Date.parse(candidate.lastObservedAt) >
    Date.parse(existing.lastObservedAt)
    ? candidate
    : existing;
}

function decodeEntry(value: unknown): RetainedSessionInventoryEntry {
  const record = requireRecord(value, "retained-session entry");
  assertExactKeys(record, [
    "resourceKey",
    "ownership",
    "reason",
    "keeperGeneration",
    "remoteResourceRevision",
    "processState",
    "persistenceLevel",
    "storageStatus",
    "checkpointAvailable",
    "retainedRangeTruncated",
    "exitCode",
    "descriptor",
    "retainedAt",
    "lastObservedAt",
    "termination",
    "lastTerminationFailure"
  ]);
  const ownership = record.ownership;
  if (ownership !== "owned-cache" && ownership !== "retained") {
    throw new TypeError("retained-session ownership is invalid");
  }
  const reason =
    record.reason === undefined
      ? undefined
      : requireRetentionReason(record.reason, true);
  if (
    (ownership === "owned-cache" &&
      (reason !== undefined ||
        record.retainedAt !== undefined ||
        record.termination !== undefined ||
        record.lastTerminationFailure !== undefined)) ||
    (ownership === "retained" &&
      (reason === undefined || record.retainedAt === undefined))
  ) {
    throw new TypeError("retained-session ownership metadata is inconsistent");
  }
  const termination =
    record.termination === undefined
      ? undefined
      : decodeTermination(record.termination);
  const lastTerminationFailure =
    record.lastTerminationFailure === undefined
      ? undefined
      : decodeTerminationFailure(record.lastTerminationFailure);
  if ((reason === "termination-pending") !== (termination !== undefined)) {
    throw new TypeError(
      "retained-session termination metadata is inconsistent"
    );
  }
  if (termination && lastTerminationFailure) {
    throw new TypeError(
      "retained-session termination cannot be pending and failed together"
    );
  }
  const processState = record.processState;
  if (processState !== "running" && processState !== "exited") {
    throw new TypeError("retained-session process state is invalid");
  }
  const exitCode = requireExitCode(record.exitCode);
  if (processState === "running" && exitCode !== undefined) {
    throw new TypeError("a running retained session cannot have an exit code");
  }
  const descriptor = decodeDescriptor(record.descriptor);
  const persistenceLevel = requirePersistenceLevel(record.persistenceLevel);
  const storageStatus = decodeRetainedStorageStatus(record.storageStatus);
  const checkpointAvailable = requireOptionalBoolean(
    record.checkpointAvailable,
    "checkpointAvailable"
  );
  const retainedRangeTruncated = requireOptionalBoolean(
    record.retainedRangeTruncated,
    "retainedRangeTruncated"
  );
  return {
    resourceKey: validateResourceKey(record.resourceKey),
    ownership,
    ...(reason === undefined ? {} : { reason }),
    keeperGeneration: requireId(record.keeperGeneration, "keeperGeneration"),
    remoteResourceRevision: parseUint64Decimal(record.remoteResourceRevision),
    processState,
    persistenceLevel,
    storageStatus,
    checkpointAvailable,
    retainedRangeTruncated,
    ...(exitCode === undefined ? {} : { exitCode }),
    descriptor,
    ...(record.retainedAt === undefined
      ? {}
      : { retainedAt: requireTimestamp(record.retainedAt, "retainedAt") }),
    lastObservedAt: requireTimestamp(record.lastObservedAt, "lastObservedAt"),
    ...(termination === undefined ? {} : { termination }),
    ...(lastTerminationFailure === undefined ? {} : { lastTerminationFailure })
  };
}

function encodeTermination(
  termination: RetainedSessionTermination
): RetainedSessionInventoryEntryDto["termination"] {
  return {
    operationId: termination.operationId,
    canonicalPayloadHash: termination.canonicalPayloadHash,
    expectedWorkspaceRevision: termination.expectedWorkspaceRevision,
    expectedRemoteResourceRevision: formatUint64Decimal(
      termination.expectedRemoteResourceRevision
    ),
    nextRemoteResourceRevision: formatUint64Decimal(
      termination.nextRemoteResourceRevision
    ),
    admittedAt: termination.admittedAt,
    priorReason: termination.priorReason,
    ...(termination.resultDigest === undefined
      ? {}
      : { resultDigest: termination.resultDigest })
  };
}

function decodeTermination(value: unknown): RetainedSessionTermination {
  const record = requireRecord(value, "retained termination");
  assertExactKeys(record, [
    "operationId",
    "canonicalPayloadHash",
    "expectedWorkspaceRevision",
    "expectedRemoteResourceRevision",
    "nextRemoteResourceRevision",
    "admittedAt",
    "priorReason",
    "resultDigest"
  ]);
  const expectedRemoteResourceRevision = parseUint64Decimal(
    record.expectedRemoteResourceRevision
  );
  const nextRemoteResourceRevision = parseUint64Decimal(
    record.nextRemoteResourceRevision
  );
  if (
    expectedRemoteResourceRevision === BigInt("18446744073709551615") ||
    nextRemoteResourceRevision !== expectedRemoteResourceRevision + 1n
  ) {
    throw new TypeError(
      "retained termination revisions must advance by exactly one"
    );
  }
  const priorReason = requireRetentionReason(record.priorReason, false);
  if (priorReason === "termination-pending") {
    throw new TypeError("retained termination prior reason is invalid");
  }
  return {
    operationId: requireId(record.operationId, "operationId"),
    canonicalPayloadHash: requireDigest(
      record.canonicalPayloadHash,
      "canonicalPayloadHash"
    ),
    expectedWorkspaceRevision: requireDigest(
      record.expectedWorkspaceRevision,
      "expectedWorkspaceRevision"
    ),
    expectedRemoteResourceRevision,
    nextRemoteResourceRevision,
    admittedAt: requireTimestamp(record.admittedAt, "admittedAt"),
    priorReason,
    ...(record.resultDigest === undefined
      ? {}
      : { resultDigest: requireDigest(record.resultDigest, "resultDigest") })
  };
}

function encodeTerminationFailure(
  failure: RetainedSessionTerminationFailure
): RetainedSessionTerminationFailure {
  return decodeTerminationFailure(failure);
}

function decodeTerminationFailure(
  value: unknown
): RetainedSessionTerminationFailure {
  const record = requireRecord(value, "retained termination failure");
  assertExactKeys(record, [
    "operationId",
    "resultDigest",
    "code",
    "message",
    "completedAt"
  ]);
  return {
    operationId: requireId(record.operationId, "operationId"),
    resultDigest: requireDigest(record.resultDigest, "resultDigest"),
    code: requireString(record.code, "termination failure code", 256),
    message: requireString(
      record.message,
      "termination failure message",
      4 * 1024
    ),
    completedAt: requireTimestamp(record.completedAt, "completedAt")
  };
}

function sameTerminationAdmission(
  left: RetainedSessionTermination,
  right: RetainedSessionTermination
): boolean {
  const { resultDigest: _leftResult, ...leftAdmission } =
    encodeTermination(left)!;
  const { resultDigest: _rightResult, ...rightAdmission } =
    encodeTermination(right)!;
  return canonicalJson(leftAdmission) === canonicalJson(rightAdmission);
}

function decodeDescriptor(
  value: unknown
): NonNullable<ObservedSessionKeeper["descriptor"]> {
  const record = requireRecord(value, "retained remote descriptor");
  assertExactKeys(record, [
    "createOperationId",
    "canonicalCreatePayloadHash",
    "lastOperationId",
    "lastOperationPayloadHash",
    "lastResultDigest",
    "launch",
    "lifecycleState",
    "conversionTransactionId",
    "remoteSnapshotHash",
    "provisionalCreatedAt",
    "everGrantedWriterLease"
  ]);
  if (
    record.lifecycleState !== "committed" &&
    record.lifecycleState !== "provisional" &&
    record.lifecycleState !== "abandoned"
  ) {
    throw new TypeError("retained descriptor lifecycle state is invalid");
  }
  if (typeof record.everGrantedWriterLease !== "boolean") {
    throw new TypeError("retained descriptor writer-lease evidence is invalid");
  }
  const launch = decodeLaunch(record.launch);
  return {
    createOperationId: requireId(record.createOperationId, "createOperationId"),
    canonicalCreatePayloadHash: requireDigest(
      record.canonicalCreatePayloadHash,
      "canonicalCreatePayloadHash"
    ),
    lastOperationId: requireId(record.lastOperationId, "lastOperationId"),
    lastOperationPayloadHash: requireDigest(
      record.lastOperationPayloadHash,
      "lastOperationPayloadHash"
    ),
    lastResultDigest: requireDigest(
      record.lastResultDigest,
      "lastResultDigest"
    ),
    launch,
    lifecycleState: record.lifecycleState,
    ...(record.conversionTransactionId === undefined
      ? {}
      : {
          conversionTransactionId: requireId(
            record.conversionTransactionId,
            "conversionTransactionId"
          )
        }),
    ...(record.remoteSnapshotHash === undefined
      ? {}
      : {
          remoteSnapshotHash: requireDigest(
            record.remoteSnapshotHash,
            "remoteSnapshotHash"
          )
        }),
    ...(record.provisionalCreatedAt === undefined
      ? {}
      : {
          provisionalCreatedAt: requireTimestamp(
            record.provisionalCreatedAt,
            "provisionalCreatedAt"
          )
        }),
    everGrantedWriterLease: record.everGrantedWriterLease
  };
}

function decodeLaunch(
  value: unknown
): NonNullable<ObservedSessionKeeper["descriptor"]>["launch"] {
  const record = requireRecord(value, "retained launch");
  assertExactKeys(record, ["cwd", "shell", "args", "env", "title"]);
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) ||
      record.args.length > 256 ||
      record.args.some((item) => typeof item !== "string"))
  ) {
    throw new TypeError("retained launch arguments are invalid");
  }
  const env =
    record.env === undefined
      ? undefined
      : requireRecord(record.env, "launch.env");
  if (env && Object.keys(env).length > 256) {
    throw new TypeError("retained launch environment is oversized");
  }
  return {
    cwd: requireString(record.cwd, "launch.cwd", 32 * 1024),
    ...(record.shell === undefined
      ? {}
      : { shell: requireString(record.shell, "launch.shell", 32 * 1024) }),
    ...(record.args === undefined
      ? {}
      : {
          args: record.args.map((item) =>
            requireString(item, "launch argument", 32 * 1024)
          )
        }),
    ...(env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).map(([key, item]) => [
              requireString(key, "launch env key", 256),
              requireString(item, "launch env value", 32 * 1024)
            ])
          )
        }),
    ...(record.title === undefined
      ? {}
      : { title: requireString(record.title, "launch.title", 4 * 1024) })
  };
}

function readInventory(
  path: string,
  uid: number | undefined
): RetainedSessionInventoryEntry[] {
  if (!existsSync(path)) return [];
  const stats = lstatSync(path);
  assertPrivateRegularFile(stats, uid);
  if (stats.size > MAX_INVENTORY_BYTES) {
    throw new RangeError("retained-session inventory exceeds its limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_INVENTORY_BYTES) {
    throw new RangeError("retained-session inventory exceeds its limit");
  }
  try {
    const envelope = requireRecord(
      JSON.parse(bytes.toString("utf8")),
      "retained-session inventory"
    );
    assertExactKeys(envelope, ["version", "entries", "entriesDigest"]);
    if (
      envelope.version !== INVENTORY_VERSION ||
      !Array.isArray(envelope.entries)
    ) {
      throw new TypeError("unsupported retained-session inventory version");
    }
    if (envelope.entries.length > MAX_ENTRIES) {
      throw new RangeError(
        "retained-session inventory contains too many entries"
      );
    }
    if (envelope.entriesDigest !== sha256(canonicalJson(envelope.entries))) {
      throw new TypeError("retained-session inventory digest mismatch");
    }
    const decoded = envelope.entries.map(decodeEntry);
    const keys = new Set<string>();
    for (const entry of decoded) {
      const key = resourceKeyId(entry.resourceKey);
      if (keys.has(key)) {
        throw new TypeError(
          "retained-session inventory contains a duplicate resource"
        );
      }
      keys.add(key);
    }
    return decoded;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid retained-session inventory ${path}: ${reason}`);
  }
}

function validateResourceKey(
  value: unknown
): RemoteResourceKey & { sessionId: Id } {
  const record = requireRecord(value, "retained resource key");
  assertExactKeys(record, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    workspaceId: requireId(record.workspaceId, "workspaceId"),
    sessionId: requireId(record.sessionId, "sessionId")
  };
}

function resourceKeyId(
  resourceKey: RemoteResourceKey & { sessionId: Id }
): string {
  return [
    resourceKey.desktopInstallationId,
    resourceKey.targetId,
    resourceKey.workspaceId,
    resourceKey.sessionId
  ].join("\0");
}

function requireRetentionReason(
  value: unknown,
  allowTermination: boolean
): RetainedSessionReason {
  if (
    value !== "restore-disabled" &&
    value !== "workspace-close" &&
    value !== "unowned-observation" &&
    (allowTermination ? value !== "termination-pending" : true)
  ) {
    throw new TypeError("retained-session reason is invalid");
  }
  return value as RetainedSessionReason;
}

function requirePersistenceLevel(value: unknown): RemotePersistenceLevel {
  if (value === undefined) return "ssh-disconnect";
  if (
    value !== "ssh-disconnect" &&
    value !== "user-logout" &&
    value !== "host-reboot"
  ) {
    throw new TypeError("retained-session persistence level is invalid");
  }
  return value;
}

function requireId(value: unknown, field: string): Id {
  return requireString(value, field, MAX_ID_BYTES);
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function decodeRetainedStorageStatus(
  value: unknown
): RemoteSessionStorageStatus {
  if (value === undefined) {
    return {
      state: "normal",
      journalAdmitted: parseUint64Decimal("0"),
      journalSynced: parseUint64Decimal("0"),
      emergencyBytes: 0
    };
  }
  const record = requireRecord(value, "retained storage status");
  assertExactKeys(record, [
    "state",
    "journalAdmitted",
    "journalSynced",
    "emergencyBytes",
    "lastSyncDurationMs"
  ]);
  if (
    record.state !== "normal" &&
    record.state !== "degraded" &&
    record.state !== "backpressured"
  ) {
    throw new TypeError("retained storage status state is invalid");
  }
  const journalAdmitted = parseUint64Decimal(record.journalAdmitted);
  const journalSynced = parseUint64Decimal(record.journalSynced);
  if (journalSynced > journalAdmitted) {
    throw new TypeError("retained journalSynced exceeds journalAdmitted");
  }
  if (
    !Number.isSafeInteger(record.emergencyBytes) ||
    (record.emergencyBytes as number) < 0 ||
    (record.emergencyBytes as number) > 4 * 1024 * 1024
  ) {
    throw new TypeError("retained emergencyBytes is invalid");
  }
  const lastSyncDurationMs = record.lastSyncDurationMs;
  if (
    lastSyncDurationMs !== undefined &&
    (typeof lastSyncDurationMs !== "number" ||
      !Number.isSafeInteger(lastSyncDurationMs) ||
      lastSyncDurationMs < 0)
  ) {
    throw new TypeError("retained lastSyncDurationMs is invalid");
  }
  return {
    state: record.state,
    journalAdmitted,
    journalSynced,
    emergencyBytes: record.emergencyBytes as number,
    ...(lastSyncDurationMs === undefined
      ? {}
      : { lastSyncDurationMs: lastSyncDurationMs as number })
  };
}

function requireOptionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function requireExitCode(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("retained-session exit code must be a safe integer");
  }
  return value as number;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected retained-session field: ${unexpected}`);
  }
}

function assertPrivateRegularFile(stats: Stats, uid: number | undefined): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("retained-session inventory must be a regular file");
  }
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error("retained-session inventory has the wrong owner");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      "retained-session inventory has group or other permissions"
    );
  }
}

function cloneEntry(
  entry: RetainedSessionInventoryEntry
): RetainedSessionInventoryEntry {
  return decodeEntry(encodeEntry(entry));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical retained JSON accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("retained value cannot be represented as canonical JSON");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
