import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  unlinkSync,
  type Stats
} from "node:fs";
import { basename, join, resolve } from "node:path";

import type { RemoteResourceKey } from "@kmux/core";
import {
  decodeSshWorkspaceAdditionPatch,
  decodeSshWorkspaceReplacementPatch,
  type SshWorkspaceAdditionPatchDto,
  type SshWorkspaceReplacementPatchDto
} from "@kmux/core/main";
import type { Id } from "@kmux/proto";

import { durableAtomicReplace } from "./durableAtomicWrite";

const CONVERSION_WAL_VERSION = 1;
const MAX_CONVERSION_RECORD_BYTES = 1024 * 1024;
const MAX_CONVERSION_RECORDS = 64;
const MAX_CONVERSION_DIRECTORY_ENTRIES = MAX_CONVERSION_RECORDS * 2;
const MAX_CLEANUP_TARGETS = 4_096;

export type ConversionWalState =
  | "preparing"
  | "remote-created"
  | "commit-decided"
  | "committed"
  | "cleanup-complete";

export interface ConversionPreservationWhitelist {
  workspaceId: Id;
  windowId: Id;
  name: string;
  nameLocked: boolean;
  pinned: boolean;
}

export interface ConversionLocalCleanupTarget {
  sessionId: Id;
  surfaceId: Id;
  runtimeEpoch?: Id;
}

export interface ConversionPreparingRecord {
  version: 1;
  state: "preparing";
  continuation: "convert" | "create";
  transactionId: Id;
  workspaceCreateOperationId: Id;
  sessionCreateOperationId: Id;
  workspaceResourceKey: RemoteResourceKey;
  sessionResourceKey: RemoteResourceKey & { sessionId: Id };
  sourceWorkspaceRevision: string;
  effectiveConnectionPolicyHash: string;
  preservation: ConversionPreservationWhitelist;
  cleanupSet: ConversionLocalCleanupTarget[];
  connectionName: string;
  defaultCwd: string;
  launch: {
    cwd: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    title?: string;
  };
  preparedAt: string;
}

export interface ConversionRemoteCreatedEvidence {
  remoteSnapshotHash: string;
  workspaceDescriptorHash: string;
  sessionDescriptorHash: string;
  keeperGeneration: Id;
  remoteResourceRevision: string;
  remoteCreatedAt: string;
}

export interface ConversionRemoteCreatedRecord
  extends
    Omit<ConversionPreparingRecord, "state">,
    ConversionRemoteCreatedEvidence {
  state: "remote-created";
}

export interface ConversionCommitDecision {
  replacementPatch:
    | SshWorkspaceReplacementPatchDto
    | SshWorkspaceAdditionPatchDto;
  replacementPatchHash: string;
  decidedAt: string;
}

export interface ConversionCommitDecidedRecord
  extends
    Omit<ConversionRemoteCreatedRecord, "state">,
    ConversionCommitDecision {
  state: "commit-decided";
}

export interface ConversionCommittedEvidence {
  desktopSnapshotHash: string;
  remotePromotionHash: string;
  committedAt: string;
}

export interface ConversionCommittedRecord
  extends
    Omit<ConversionCommitDecidedRecord, "state">,
    ConversionCommittedEvidence {
  state: "committed";
}

export interface ConversionCleanupAcknowledgement {
  sessionId: Id;
  surfaceId: Id;
  runtimeEpoch?: Id;
  outcome: "terminated" | "already-exited";
}

export interface ConversionCleanupCompleteRecord extends Omit<
  ConversionCommittedRecord,
  "state"
> {
  state: "cleanup-complete";
  cleanupAcknowledgements: ConversionCleanupAcknowledgement[];
  cleanupCompletedAt: string;
}

export type ConversionWalRecord =
  | ConversionPreparingRecord
  | ConversionRemoteCreatedRecord
  | ConversionCommitDecidedRecord
  | ConversionCommittedRecord
  | ConversionCleanupCompleteRecord;

interface ConversionWalEnvelope {
  version: 1;
  record: ConversionWalRecord;
  recordDigest: string;
}

export class ConversionWalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionWalConflictError";
  }
}

export interface ConversionWalStore {
  begin(
    record: Omit<ConversionPreparingRecord, "version" | "state">
  ): ConversionPreparingRecord;
  recordRemoteCreated(
    transactionId: Id,
    evidence: ConversionRemoteCreatedEvidence
  ): ConversionRemoteCreatedRecord;
  decideCommit(
    transactionId: Id,
    decision: ConversionCommitDecision
  ): ConversionCommitDecidedRecord;
  recordCommitted(
    transactionId: Id,
    evidence: ConversionCommittedEvidence
  ): ConversionCommittedRecord;
  recordCleanupComplete(
    transactionId: Id,
    cleanupAcknowledgements: ConversionCleanupAcknowledgement[],
    cleanupCompletedAt: string
  ): ConversionCleanupCompleteRecord;
  get(transactionId: Id): ConversionWalRecord | null;
  loadAll(): ConversionWalRecord[];
  compact(transactionId: Id): void;
}

export interface CreateConversionWalStoreOptions {
  maxRecords?: number;
  write?: (root: string, fileName: string, bytes: Uint8Array) => void;
  uid?: number;
}

export function createConversionWalStore(
  rootDirectory: string,
  options: CreateConversionWalStoreOptions = {}
): ConversionWalStore {
  const root = resolve(rootDirectory);
  const write = options.write ?? durableAtomicReplace;
  const uid = options.uid ?? currentUid();
  const maxRecords = requireBoundedCount(
    options.maxRecords ?? MAX_CONVERSION_RECORDS,
    "maxRecords",
    MAX_CONVERSION_RECORDS
  );

  const persist = (value: ConversionWalRecord): ConversionWalRecord => {
    const record = decodeConversionWalRecord(value);
    const envelope = encodeEnvelope(record);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_CONVERSION_RECORD_BYTES) {
      throw new RangeError("conversion WAL record exceeds its limit");
    }
    write(root, fileNameForTransaction(record.transactionId), bytes);
    return cloneRecord(record);
  };

  const get = (transactionId: Id): ConversionWalRecord | null => {
    validateId(transactionId, "transactionId");
    const path = join(root, fileNameForTransaction(transactionId));
    const stats = tryLstat(path);
    if (!stats) return null;
    ensurePrivateRoot(root, uid);
    return readRecord(path, uid, stats);
  };

  return Object.freeze({
    begin(
      candidate: Omit<ConversionPreparingRecord, "version" | "state">
    ): ConversionPreparingRecord {
      const record = decodeConversionWalRecord({
        version: 1,
        state: "preparing",
        ...candidate
      });
      if (record.state !== "preparing") {
        throw new TypeError("conversion begin record is not preparing");
      }
      const existing = get(record.transactionId);
      if (existing) {
        if (!samePrefix(existing, record, "preparing")) {
          throw new ConversionWalConflictError(
            `conversion ${record.transactionId} was already prepared differently`
          );
        }
        persist(existing);
        return requireState(cloneRecord(existing), "preparing");
      }
      ensurePrivateRoot(root, uid);
      if (listRecordNames(root, uid).length >= maxRecords) {
        throw new RangeError("conversion WAL contains too many records");
      }
      return requireState(persist(record), "preparing");
    },

    recordRemoteCreated(
      transactionId: Id,
      evidence: ConversionRemoteCreatedEvidence
    ) {
      return requireState(
        advance(
          transactionId,
          "preparing",
          "remote-created",
          evidence,
          get,
          persist
        ),
        "remote-created"
      );
    },

    decideCommit(transactionId: Id, decision: ConversionCommitDecision) {
      return requireState(
        advance(
          transactionId,
          "remote-created",
          "commit-decided",
          decision,
          get,
          persist
        ),
        "commit-decided"
      );
    },

    recordCommitted(transactionId: Id, evidence: ConversionCommittedEvidence) {
      return requireState(
        advance(
          transactionId,
          "commit-decided",
          "committed",
          evidence,
          get,
          persist
        ),
        "committed"
      );
    },

    recordCleanupComplete(
      transactionId: Id,
      cleanupAcknowledgements: ConversionCleanupAcknowledgement[],
      cleanupCompletedAt: string
    ) {
      return requireState(
        advance(
          transactionId,
          "committed",
          "cleanup-complete",
          { cleanupAcknowledgements, cleanupCompletedAt },
          get,
          persist
        ),
        "cleanup-complete"
      );
    },

    get,

    loadAll(): ConversionWalRecord[] {
      if (!existsSync(root)) return [];
      ensurePrivateRoot(root, uid);
      const names = listRecordNames(root, uid);
      if (names.length > maxRecords) {
        throw new RangeError("conversion WAL contains too many records");
      }
      return names.map((name) => readRecord(join(root, name), uid));
    },

    compact(transactionId: Id): void {
      const existing = get(transactionId);
      if (!existing) return;
      if (existing.state !== "cleanup-complete") {
        throw new ConversionWalConflictError(
          "conversion WAL can compact only cleanup-complete records"
        );
      }
      unlinkSync(join(root, fileNameForTransaction(transactionId)));
      fsyncDirectory(root);
    }
  });
}

function advance(
  transactionId: Id,
  expectedState: ConversionWalState,
  nextState: ConversionWalState,
  extension: object,
  get: (transactionId: Id) => ConversionWalRecord | null,
  persist: (record: ConversionWalRecord) => ConversionWalRecord
): ConversionWalRecord {
  const existing = get(transactionId);
  if (!existing) {
    throw new ConversionWalConflictError(
      `conversion ${transactionId} has not been prepared`
    );
  }
  const next = decodeConversionWalRecord({
    ...existing,
    ...extension,
    state: nextState
  });
  if (existing.state === nextState) {
    if (canonicalJson(existing) !== canonicalJson(next)) {
      throw new ConversionWalConflictError(
        `conversion ${transactionId} already has different ${nextState} evidence`
      );
    }
    return persist(existing);
  }
  if (existing.state !== expectedState) {
    throw new ConversionWalConflictError(
      `conversion ${transactionId} cannot advance from ${existing.state} to ${nextState}`
    );
  }
  return persist(next);
}

export function decodeConversionWalRecord(value: unknown): ConversionWalRecord {
  const record = requireRecord(value, "conversion WAL record");
  const state = requireStateName(record.state);
  const commonKeys = [
    "version",
    "state",
    "continuation",
    "transactionId",
    "workspaceCreateOperationId",
    "sessionCreateOperationId",
    "workspaceResourceKey",
    "sessionResourceKey",
    "sourceWorkspaceRevision",
    "effectiveConnectionPolicyHash",
    "preservation",
    "cleanupSet",
    "connectionName",
    "defaultCwd",
    "launch",
    "preparedAt"
  ];
  const remoteKeys = [
    "remoteSnapshotHash",
    "workspaceDescriptorHash",
    "sessionDescriptorHash",
    "keeperGeneration",
    "remoteResourceRevision",
    "remoteCreatedAt"
  ];
  const decisionKeys = [
    "replacementPatch",
    "replacementPatchHash",
    "decidedAt"
  ];
  const committedKeys = [
    "desktopSnapshotHash",
    "remotePromotionHash",
    "committedAt"
  ];
  const cleanupKeys = ["cleanupAcknowledgements", "cleanupCompletedAt"];
  const allowed = [
    ...commonKeys,
    ...(state === "preparing" ? [] : remoteKeys),
    ...(state === "commit-decided" ||
    state === "committed" ||
    state === "cleanup-complete"
      ? decisionKeys
      : []),
    ...(state === "committed" || state === "cleanup-complete"
      ? committedKeys
      : []),
    ...(state === "cleanup-complete" ? cleanupKeys : [])
  ];
  assertExactKeys(record, allowed);
  if (record.version !== CONVERSION_WAL_VERSION) {
    throw new TypeError("unsupported conversion WAL version");
  }
  const workspaceResourceKey = decodeResourceKey(
    record.workspaceResourceKey,
    false
  );
  const sessionResourceKey = decodeResourceKey(record.sessionResourceKey, true);
  if (
    workspaceResourceKey.desktopInstallationId !==
      sessionResourceKey.desktopInstallationId ||
    workspaceResourceKey.targetId !== sessionResourceKey.targetId ||
    workspaceResourceKey.workspaceId !== sessionResourceKey.workspaceId
  ) {
    throw new TypeError("conversion resource keys do not share one scope");
  }
  const preservationRecord = requireRecord(
    record.preservation,
    "conversion preservation whitelist"
  );
  assertExactKeys(preservationRecord, [
    "workspaceId",
    "windowId",
    "name",
    "nameLocked",
    "pinned"
  ]);
  if (
    typeof preservationRecord.nameLocked !== "boolean" ||
    typeof preservationRecord.pinned !== "boolean"
  ) {
    throw new TypeError("conversion preservation flags are invalid");
  }
  const preservation: ConversionPreservationWhitelist = {
    workspaceId: validateId(preservationRecord.workspaceId, "workspaceId"),
    windowId: validateId(preservationRecord.windowId, "windowId"),
    name: requireText(preservationRecord.name, "name", 4 * 1024),
    nameLocked: preservationRecord.nameLocked,
    pinned: preservationRecord.pinned
  };
  const continuation = requireContinuation(record.continuation);
  if (
    (continuation === "convert" &&
      preservation.workspaceId !== workspaceResourceKey.workspaceId) ||
    (continuation === "create" &&
      preservation.workspaceId === workspaceResourceKey.workspaceId)
  ) {
    throw new TypeError("conversion preservation workspace does not match");
  }
  const cleanupSet = decodeCleanupSet(record.cleanupSet);
  if (continuation === "create" && cleanupSet.length !== 0) {
    throw new TypeError("SSH workspace creation cannot clean local sessions");
  }
  const launch = decodeLaunch(record.launch);
  const common: ConversionPreparingRecord = {
    version: 1,
    state: "preparing",
    continuation,
    transactionId: validateId(record.transactionId, "transactionId"),
    workspaceCreateOperationId: validateId(
      record.workspaceCreateOperationId,
      "workspaceCreateOperationId"
    ),
    sessionCreateOperationId: validateId(
      record.sessionCreateOperationId,
      "sessionCreateOperationId"
    ),
    workspaceResourceKey,
    sessionResourceKey,
    sourceWorkspaceRevision: requireDigest(
      record.sourceWorkspaceRevision,
      "sourceWorkspaceRevision"
    ),
    effectiveConnectionPolicyHash: requireDigest(
      record.effectiveConnectionPolicyHash,
      "effectiveConnectionPolicyHash"
    ),
    preservation,
    cleanupSet,
    connectionName: requireText(
      record.connectionName,
      "connectionName",
      4 * 1024
    ),
    defaultCwd: requirePath(record.defaultCwd, "defaultCwd"),
    launch,
    preparedAt: requireTimestamp(record.preparedAt, "preparedAt")
  };
  if (state === "preparing") return common;

  const remote: ConversionRemoteCreatedRecord = {
    ...common,
    state: "remote-created",
    remoteSnapshotHash: requireDigest(
      record.remoteSnapshotHash,
      "remoteSnapshotHash"
    ),
    workspaceDescriptorHash: requireDigest(
      record.workspaceDescriptorHash,
      "workspaceDescriptorHash"
    ),
    sessionDescriptorHash: requireDigest(
      record.sessionDescriptorHash,
      "sessionDescriptorHash"
    ),
    keeperGeneration: validateId(record.keeperGeneration, "keeperGeneration"),
    remoteResourceRevision: requireUint64String(
      record.remoteResourceRevision,
      "remoteResourceRevision"
    ),
    remoteCreatedAt: requireTimestamp(record.remoteCreatedAt, "remoteCreatedAt")
  };
  if (state === "remote-created") return remote;

  const replacementPatch =
    continuation === "convert"
      ? decodeSshWorkspaceReplacementPatch(record.replacementPatch)
      : decodeSshWorkspaceAdditionPatch(record.replacementPatch);
  const replacementPatchHash = requireDigest(
    record.replacementPatchHash,
    "replacementPatchHash"
  );
  if (replacementPatchHash !== sha256(canonicalJson(replacementPatch))) {
    throw new TypeError("conversion replacement patch hash does not match");
  }
  const patchSourceMatches =
    continuation === "convert"
      ? decodeSshWorkspaceReplacementPatch(replacementPatch).workspaceId ===
        preservation.workspaceId
      : decodeSshWorkspaceAdditionPatch(replacementPatch).sourceWorkspaceId ===
        preservation.workspaceId;
  if (
    replacementPatch.workspaceId !== workspaceResourceKey.workspaceId ||
    replacementPatch.expectedSourceWorkspaceRevision !==
      common.sourceWorkspaceRevision ||
    !patchSourceMatches
  ) {
    throw new TypeError("conversion replacement patch source does not match");
  }
  const decided: ConversionCommitDecidedRecord = {
    ...remote,
    state: "commit-decided",
    replacementPatch,
    replacementPatchHash,
    decidedAt: requireTimestamp(record.decidedAt, "decidedAt")
  };
  if (state === "commit-decided") return decided;

  const committed: ConversionCommittedRecord = {
    ...decided,
    state: "committed",
    desktopSnapshotHash: requireDigest(
      record.desktopSnapshotHash,
      "desktopSnapshotHash"
    ),
    remotePromotionHash: requireDigest(
      record.remotePromotionHash,
      "remotePromotionHash"
    ),
    committedAt: requireTimestamp(record.committedAt, "committedAt")
  };
  if (state === "committed") return committed;

  const cleanupAcknowledgements = decodeCleanupAcknowledgements(
    record.cleanupAcknowledgements,
    cleanupSet
  );
  return {
    ...committed,
    state: "cleanup-complete",
    cleanupAcknowledgements,
    cleanupCompletedAt: requireTimestamp(
      record.cleanupCompletedAt,
      "cleanupCompletedAt"
    )
  };
}

export function conversionPatchHash(
  patch: SshWorkspaceReplacementPatchDto | SshWorkspaceAdditionPatchDto
): string {
  const record = requireRecord(patch, "conversion replacement patch");
  const decoded = Object.hasOwn(record, "sourceWorkspaceId")
    ? decodeSshWorkspaceAdditionPatch(structuredClone(patch))
    : decodeSshWorkspaceReplacementPatch(structuredClone(patch));
  return sha256(canonicalJson(decoded));
}

function encodeEnvelope(record: ConversionWalRecord): ConversionWalEnvelope {
  const decoded = decodeConversionWalRecord(record);
  return {
    version: 1,
    record: decoded,
    recordDigest: sha256(canonicalJson(decoded))
  };
}

function decodeEnvelope(value: unknown): ConversionWalRecord {
  const envelope = requireRecord(value, "conversion WAL envelope");
  assertExactKeys(envelope, ["version", "record", "recordDigest"]);
  if (envelope.version !== 1) {
    throw new TypeError("unsupported conversion WAL envelope version");
  }
  const record = decodeConversionWalRecord(envelope.record);
  if (envelope.recordDigest !== sha256(canonicalJson(record))) {
    throw new TypeError("conversion WAL record digest mismatch");
  }
  return record;
}

function readRecord(
  path: string,
  uid: number | undefined,
  knownStats?: Stats
): ConversionWalRecord {
  const stats = knownStats ?? lstatSync(path);
  assertPrivateRegularFile(stats, uid);
  if (stats.size > MAX_CONVERSION_RECORD_BYTES) {
    throw new RangeError("conversion WAL record exceeds its limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_CONVERSION_RECORD_BYTES) {
    throw new RangeError("conversion WAL record exceeds its limit");
  }
  try {
    const record = decodeEnvelope(JSON.parse(bytes.toString("utf8")));
    if (basename(path) !== fileNameForTransaction(record.transactionId)) {
      throw new Error("conversion WAL file name does not match transaction ID");
    }
    return record;
  } catch (error) {
    throw new Error(
      `invalid conversion WAL record ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function decodeCleanupSet(value: unknown): ConversionLocalCleanupTarget[] {
  if (!Array.isArray(value) || value.length > MAX_CLEANUP_TARGETS) {
    throw new TypeError("conversion cleanup set must be a bounded array");
  }
  const result = value.map((item) => {
    const record = requireRecord(item, "conversion cleanup target");
    assertExactKeys(record, ["sessionId", "surfaceId", "runtimeEpoch"]);
    return {
      sessionId: validateId(record.sessionId, "sessionId"),
      surfaceId: validateId(record.surfaceId, "surfaceId"),
      ...(record.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: validateId(record.runtimeEpoch, "runtimeEpoch") })
    };
  });
  const keys = result.map((item) => item.sessionId);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("conversion cleanup set contains duplicate sessions");
  }
  return result.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId)
  );
}

function decodeCleanupAcknowledgements(
  value: unknown,
  cleanupSet: ConversionLocalCleanupTarget[]
): ConversionCleanupAcknowledgement[] {
  if (!Array.isArray(value) || value.length !== cleanupSet.length) {
    throw new TypeError("conversion cleanup acknowledgements are incomplete");
  }
  const result = value.map((item) => {
    const record = requireRecord(item, "conversion cleanup acknowledgement");
    assertExactKeys(record, [
      "sessionId",
      "surfaceId",
      "runtimeEpoch",
      "outcome"
    ]);
    if (
      record.outcome !== "terminated" &&
      record.outcome !== "already-exited"
    ) {
      throw new TypeError("conversion cleanup outcome is invalid");
    }
    return {
      sessionId: validateId(record.sessionId, "sessionId"),
      surfaceId: validateId(record.surfaceId, "surfaceId"),
      ...(record.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: validateId(record.runtimeEpoch, "runtimeEpoch") }),
      outcome: record.outcome as ConversionCleanupAcknowledgement["outcome"]
    };
  });
  const expected = new Set(
    cleanupSet.map(
      (item) =>
        `${item.sessionId}\0${item.surfaceId}\0${item.runtimeEpoch ?? ""}`
    )
  );
  for (const acknowledgement of result) {
    if (
      !expected.delete(
        `${acknowledgement.sessionId}\0${acknowledgement.surfaceId}\0${acknowledgement.runtimeEpoch ?? ""}`
      )
    ) {
      throw new TypeError("conversion cleanup acknowledgement is unexpected");
    }
  }
  if (expected.size !== 0) {
    throw new TypeError("conversion cleanup acknowledgements are incomplete");
  }
  return result.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId)
  );
}

function decodeLaunch(value: unknown): ConversionPreparingRecord["launch"] {
  const record = requireRecord(value, "conversion launch");
  assertExactKeys(record, ["cwd", "shell", "args", "env", "title"]);
  const args = record.args;
  if (
    args !== undefined &&
    (!Array.isArray(args) ||
      args.length > 256 ||
      args.some((argument) => typeof argument !== "string"))
  ) {
    throw new TypeError("conversion launch args are invalid");
  }
  const env = record.env;
  if (
    env !== undefined &&
    (!env || typeof env !== "object" || Array.isArray(env))
  ) {
    throw new TypeError("conversion launch env is invalid");
  }
  const decodedEnv =
    env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(env as Record<string, unknown>).map(([key, item]) => [
            requireText(key, "environment key", 256),
            requireText(item, "environment value", 32 * 1024)
          ])
        );
  if (decodedEnv && Object.keys(decodedEnv).length > 256) {
    throw new TypeError("conversion launch env exceeds its bound");
  }
  return {
    cwd: requirePath(record.cwd, "launch.cwd"),
    ...(record.shell === undefined
      ? {}
      : { shell: requirePath(record.shell, "launch.shell") }),
    ...(args === undefined
      ? {}
      : {
          args: args.map((argument) =>
            requireText(argument, "launch argument", 32 * 1024)
          )
        }),
    ...(decodedEnv === undefined ? {} : { env: decodedEnv }),
    ...(record.title === undefined
      ? {}
      : { title: requireText(record.title, "launch.title", 4 * 1024) })
  };
}

function decodeResourceKey<const RequireSession extends boolean>(
  value: unknown,
  requireSession: RequireSession
): RemoteResourceKey &
  (RequireSession extends true ? { sessionId: Id } : object) {
  const record = requireRecord(value, "conversion resource key");
  assertExactKeys(record, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  const sessionId =
    record.sessionId === undefined
      ? undefined
      : validateId(record.sessionId, "sessionId");
  if (requireSession !== (sessionId !== undefined)) {
    throw new TypeError("conversion resource key has the wrong scope");
  }
  return {
    desktopInstallationId: validateId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: validateId(record.targetId, "targetId"),
    workspaceId: validateId(record.workspaceId, "workspaceId"),
    ...(sessionId === undefined ? {} : { sessionId })
  } as RemoteResourceKey &
    (RequireSession extends true ? { sessionId: Id } : object);
}

function samePrefix(
  existing: ConversionWalRecord,
  candidate: ConversionWalRecord,
  state: ConversionWalState
): boolean {
  const existingPrefix = { ...existing, state } as Record<string, unknown>;
  const candidatePrefix = { ...candidate, state } as Record<string, unknown>;
  for (const key of Object.keys(existingPrefix)) {
    if (!(key in candidatePrefix)) delete existingPrefix[key];
  }
  return canonicalJson(existingPrefix) === canonicalJson(candidatePrefix);
}

function requireState<T extends ConversionWalState>(
  record: ConversionWalRecord,
  state: T
): Extract<ConversionWalRecord, { state: T }> {
  if (record.state !== state) {
    throw new ConversionWalConflictError(
      `conversion is ${record.state}, not ${state}`
    );
  }
  return record as Extract<ConversionWalRecord, { state: T }>;
}

function requireStateName(value: unknown): ConversionWalState {
  if (
    value !== "preparing" &&
    value !== "remote-created" &&
    value !== "commit-decided" &&
    value !== "committed" &&
    value !== "cleanup-complete"
  ) {
    throw new TypeError("conversion WAL state is invalid");
  }
  return value;
}

function requireContinuation(value: unknown): "convert" | "create" {
  if (value !== "convert" && value !== "create") {
    throw new TypeError("conversion continuation is invalid");
  }
  return value;
}

function listRecordNames(root: string, uid: number | undefined): string[] {
  const names: string[] = [];
  let removedTemporary = false;
  for (const name of readBoundedDirectoryNames(root)) {
    if (/^[a-f0-9]{64}\.json$/u.test(name)) {
      names.push(name);
      continue;
    }
    if (/^\.[a-f0-9]{64}\.json\.tmp-[a-zA-Z0-9-]{1,128}$/u.test(name)) {
      const path = join(root, name);
      assertPrivateRegularFile(lstatSync(path), uid);
      unlinkSync(path);
      removedTemporary = true;
      continue;
    }
    throw new Error(`conversion WAL file name is invalid: ${name}`);
  }
  if (removedTemporary) fsyncDirectory(root);
  return names;
}

function readBoundedDirectoryNames(root: string): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= MAX_CONVERSION_DIRECTORY_ENTRIES) {
        throw new RangeError(
          "conversion WAL directory exceeds its entry limit"
        );
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function ensurePrivateRoot(root: string, uid: number | undefined): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("conversion WAL root must be a real directory");
  }
  assertPrivate(stats, uid, "conversion WAL root");
}

function assertPrivateRegularFile(stats: Stats, uid: number | undefined): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("conversion WAL record must be a regular file");
  }
  assertPrivate(stats, uid, "conversion WAL record");
}

function assertPrivate(
  stats: Stats,
  uid: number | undefined,
  field: string
): void {
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${field} has the wrong owner`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${field} has group or other permissions`);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function tryLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function fileNameForTransaction(transactionId: Id): string {
  return `${sha256(validateId(transactionId, "transactionId"))}.json`;
}

function cloneRecord(record: ConversionWalRecord): ConversionWalRecord {
  return decodeEnvelope(encodeEnvelope(record));
}

function validateId(value: unknown, field: string): Id {
  return requireText(value, field, 256, true) as Id;
}

function requirePath(value: unknown, field: string): string {
  return requireText(value, field, 32 * 1024);
}

function requireText(
  value: unknown,
  field: string,
  maxBytes: number,
  rejectControls = false
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    (rejectControls && /\p{Cc}/u.test(value))
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireText(value, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireText(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireUint64String(value: unknown, field: string): string {
  const encoded = requireText(value, field, 20);
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(encoded)) {
    throw new TypeError(`${field} must be a canonical uint64`);
  }
  const parsed = BigInt(encoded);
  if (parsed > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError(`${field} exceeds uint64`);
  }
  return encoded;
}

function requireBoundedCount(
  value: number,
  field: string,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be between 1 and ${maximum}`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !keys.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected conversion WAL field: ${unexpected}`);
  }
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
      throw new TypeError(
        "canonical conversion JSON accepts safe integers only"
      );
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
  throw new TypeError("conversion value cannot be canonicalized");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
