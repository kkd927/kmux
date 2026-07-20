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

import {
  canonicalizeRemoteOperationPayload,
  decodeRemoteOperationIntentDto,
  decodeRemoteOperationPayload,
  encodeAppStateDto,
  encodeRemoteOperationIntentDto,
  payloadFromRemotePendingProductProjection,
  type AppState,
  type RemoteResourceKey,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto
} from "@kmux/core";
import {
  decodeMainRemoteOperationFact,
  encodeMainRemoteOperationFact,
  type MainRemoteOperationFact,
  type MainRemoteOperationFactDto
} from "@kmux/core/main";
import {
  formatUint64Decimal,
  parseUint64Decimal,
  type Uint64
} from "@kmux/proto";

import { durableAtomicReplace } from "./durableAtomicWrite";

const STORE_VERSION = 1;
const MAX_OPERATION_RECORD_BYTES = 256 * 1024;
const MAX_OPERATION_PAYLOAD_BYTES = 128 * 1024;
const MAX_OPERATION_RECORDS = 4096;
const RESOURCE_RECEIPT_DIRECTORY = "resources";
const MAX_RESOURCE_RECEIPT_BYTES = 256 * 1024;
const MAX_RESOURCE_RECEIPTS = 4_096;
const MAX_OPERATION_DIRECTORY_ENTRIES = MAX_OPERATION_RECORDS * 2 + 1;
const MAX_RESOURCE_DIRECTORY_ENTRIES = MAX_RESOURCE_RECEIPTS * 2;

export type AuthoritativeRemoteOperationResult =
  | {
      outcome: "succeeded";
      operationId: string;
      remoteResourceRevision: Uint64;
      resultDigest: string;
      completedAt: string;
      keeperGeneration?: string;
    }
  | {
      outcome: "failed";
      operationId: string;
      resultDigest: string;
      code: string;
      message: string;
      completedAt: string;
    };

export interface DurableRemoteOperationRecord {
  intent: RemoteOperationIntent;
  payload: RemoteOperationPayloadDto;
  pendingFact: Extract<
    MainRemoteOperationFact,
    { type: "remote-operation.pending" }
  >;
  outbox: {
    admittedAt: string;
  };
  result?: {
    authoritative: AuthoritativeRemoteOperationResult;
    fact: Exclude<
      MainRemoteOperationFact,
      { type: "remote-operation.pending" }
    >;
  };
}

export interface DurableRemoteResourceReceipt {
  resourceKey: RemoteResourceKey;
  remoteResourceRevision: Uint64;
  keeperGeneration?: string;
  processState?: "running" | "exited";
  resourceState?: "active" | "terminated";
  createOperationId: string;
  canonicalCreatePayloadHash: string;
  lastOperationId: string;
  lastOperationPayloadHash: string;
  lastResultDigest: string;
  observedAt: string;
}

interface DurableRemoteResourceReceiptDto extends Omit<
  DurableRemoteResourceReceipt,
  "remoteResourceRevision"
> {
  remoteResourceRevision: string;
}

interface DurableRemoteResourceReceiptEnvelope {
  version: 1;
  receipt: DurableRemoteResourceReceiptDto;
  receiptDigest: string;
}

type AuthoritativeRemoteOperationResultDto =
  | {
      outcome: "succeeded";
      operationId: string;
      remoteResourceRevision: string;
      resultDigest: string;
      completedAt: string;
      keeperGeneration?: string;
    }
  | {
      outcome: "failed";
      operationId: string;
      resultDigest: string;
      code: string;
      message: string;
      completedAt: string;
    };

interface DurableRemoteOperationRecordDto {
  intent: ReturnType<typeof encodeRemoteOperationIntentDto>;
  payload: RemoteOperationPayloadDto;
  pendingFact: MainRemoteOperationFactDto;
  outbox: { admittedAt: string };
  result?: {
    authoritative: AuthoritativeRemoteOperationResultDto;
    fact: MainRemoteOperationFactDto;
  };
}

interface DurableRemoteOperationEnvelope {
  version: 1;
  record: DurableRemoteOperationRecordDto;
  recordDigest: string;
}

export class DurableOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableOperationConflictError";
  }
}

export interface DurableRemoteOperationStore {
  admit(
    record: Omit<DurableRemoteOperationRecord, "result">
  ): DurableRemoteOperationRecord;
  recordResult(
    operationId: string,
    result: AuthoritativeRemoteOperationResult,
    fact: Exclude<MainRemoteOperationFact, { type: "remote-operation.pending" }>
  ): DurableRemoteOperationRecord;
  get(operationId: string): DurableRemoteOperationRecord | null;
  loadAll(): DurableRemoteOperationRecord[];
  recordResourceReceipt(
    receipt: DurableRemoteResourceReceipt
  ): DurableRemoteResourceReceipt;
  getResourceReceipt(
    resourceKey: RemoteResourceKey
  ): DurableRemoteResourceReceipt | null;
  listResourceReceipts(): DurableRemoteResourceReceipt[];
  removeResourceReceipts(resourceKeys: readonly RemoteResourceKey[]): number;
  compactAfterDurableSnapshot(
    operationIds: readonly string[],
    snapshot: AppState
  ): string[];
}

export interface CreateDurableRemoteOperationStoreOptions {
  maxRecords?: number;
  write?: (root: string, fileName: string, bytes: Uint8Array) => void;
  uid?: number;
}

export function createDurableRemoteOperationStore(
  rootDirectory: string,
  options: CreateDurableRemoteOperationStoreOptions = {}
): DurableRemoteOperationStore {
  const root = resolve(rootDirectory);
  const write = options.write ?? durableAtomicReplace;
  const uid = options.uid ?? currentUid();
  const maxRecords = validateMaxRecords(options.maxRecords);
  const resourceRoot = join(root, RESOURCE_RECEIPT_DIRECTORY);

  const persist = (record: DurableRemoteOperationRecord): void => {
    const encoded = encodeRecord(record);
    const bytes = new TextEncoder().encode(JSON.stringify(encoded));
    if (bytes.byteLength > MAX_OPERATION_RECORD_BYTES) {
      throw new RangeError("durable remote operation record exceeds its limit");
    }
    write(root, fileNameForOperation(record.intent.operationId), bytes);
  };

  const get = (operationId: string): DurableRemoteOperationRecord | null => {
    validateOperationId(operationId);
    const path = join(root, fileNameForOperation(operationId));
    const stats = tryLstat(path);
    if (!stats) {
      return null;
    }
    ensurePrivateStoreRoot(root, uid);
    return readRecord(path, uid, stats);
  };

  const getResourceReceipt = (
    resourceKey: RemoteResourceKey
  ): DurableRemoteResourceReceipt | null => {
    const validatedKey = validateResourceKey(resourceKey);
    const path = join(resourceRoot, fileNameForResource(validatedKey));
    const stats = tryLstat(path);
    if (!stats) return null;
    ensurePrivateStoreRoot(root, uid);
    ensurePrivateStoreRoot(resourceRoot, uid);
    return readResourceReceipt(path, uid, stats);
  };

  return Object.freeze({
    admit(
      candidate: Omit<DurableRemoteOperationRecord, "result">
    ): DurableRemoteOperationRecord {
      const record = validateAdmission(candidate);
      const existing = get(record.intent.operationId);
      if (existing) {
        if (!sameAdmission(existing, record)) {
          throw new DurableOperationConflictError(
            `operation ${record.intent.operationId} was already admitted with different content`
          );
        }
        // A previous call may have crossed rename but not directory fsync.
        persist(existing);
        return cloneRecord(existing);
      }
      ensurePrivateStoreRoot(root, uid);
      if (listOperationRecordNames(root, uid).length >= maxRecords) {
        throw new RangeError(
          "durable remote operation store contains too many records"
        );
      }
      persist(record);
      return cloneRecord(record);
    },

    recordResult(
      operationId: string,
      authoritative: AuthoritativeRemoteOperationResult,
      fact: Exclude<
        MainRemoteOperationFact,
        { type: "remote-operation.pending" }
      >
    ): DurableRemoteOperationRecord {
      const existing = get(operationId);
      if (!existing) {
        throw new DurableOperationConflictError(
          `operation ${operationId} has not been durably admitted`
        );
      }
      const result = validateResult(existing, authoritative, fact);
      if (existing.result) {
        if (!sameResult(existing.result, result)) {
          throw new DurableOperationConflictError(
            `operation ${operationId} already has a different authoritative result`
          );
        }
        persist(existing);
        return cloneRecord(existing);
      }
      const next: DurableRemoteOperationRecord = { ...existing, result };
      persist(next);
      return cloneRecord(next);
    },

    get,

    loadAll(): DurableRemoteOperationRecord[] {
      if (!existsSync(root)) {
        return [];
      }
      ensurePrivateStoreRoot(root, uid);
      const names = listOperationRecordNames(root, uid);
      if (names.length > maxRecords) {
        throw new RangeError(
          "durable remote operation store contains too many records"
        );
      }
      return names.map((name) => readRecord(join(root, name), uid));
    },

    recordResourceReceipt(
      candidate: DurableRemoteResourceReceipt
    ): DurableRemoteResourceReceipt {
      const receipt = decodeResourceReceipt(encodeResourceReceipt(candidate));
      const existing = getResourceReceipt(receipt.resourceKey);
      if (existing) {
        if (existing.remoteResourceRevision > receipt.remoteResourceRevision) {
          throw new DurableOperationConflictError(
            "remote resource receipt regressed its revision"
          );
        }
        if (
          existing.createOperationId !== receipt.createOperationId ||
          existing.canonicalCreatePayloadHash !==
            receipt.canonicalCreatePayloadHash
        ) {
          throw new DurableOperationConflictError(
            "remote resource receipt changed its permanent create identity"
          );
        }
        if (
          existing.remoteResourceRevision === receipt.remoteResourceRevision
        ) {
          if (
            canonicalJson(resourceReceiptAuthorityAtRevision(existing)) !==
              canonicalJson(resourceReceiptAuthorityAtRevision(receipt)) ||
            resourceStateRegressed(existing, receipt)
          ) {
            throw new DurableOperationConflictError(
              "remote resource receipt conflicts at the same revision"
            );
          }
          if (sameObservedResourceState(existing, receipt)) {
            // Reconnect/reconcile commonly repeats an identical authoritative
            // descriptor with only a newer observation timestamp. The receipt
            // already supplies all GC/idempotency evidence, so avoid an
            // immediate fsync for that no-op.
            return cloneResourceReceipt(existing);
          }
        }
      } else {
        ensurePrivateStoreRoot(resourceRoot, uid);
        if (
          listResourceReceiptNames(resourceRoot, uid).length >=
          MAX_RESOURCE_RECEIPTS
        ) {
          throw new RangeError(
            "remote resource receipt store contains too many records"
          );
        }
      }
      const envelope = encodeResourceReceipt(receipt);
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      if (bytes.byteLength > MAX_RESOURCE_RECEIPT_BYTES) {
        throw new RangeError("remote resource receipt exceeds its limit");
      }
      write(resourceRoot, fileNameForResource(receipt.resourceKey), bytes);
      return cloneResourceReceipt(receipt);
    },

    getResourceReceipt,

    listResourceReceipts(): DurableRemoteResourceReceipt[] {
      if (!existsSync(resourceRoot)) return [];
      ensurePrivateStoreRoot(resourceRoot, uid);
      const names = listResourceReceiptNames(resourceRoot, uid);
      if (names.length > MAX_RESOURCE_RECEIPTS) {
        throw new RangeError(
          "remote resource receipt store contains too many records"
        );
      }
      return names.map((name) =>
        readResourceReceipt(join(resourceRoot, name), uid)
      );
    },

    removeResourceReceipts(resourceKeys: readonly RemoteResourceKey[]): number {
      if (resourceKeys.length > MAX_RESOURCE_RECEIPTS) {
        throw new TypeError("resource receipt compaction batch is invalid");
      }
      const validated = resourceKeys.map(validateResourceKey);
      if (
        new Set(validated.map(resourceKeyIdentity)).size !== validated.length
      ) {
        throw new TypeError("resource receipt compaction batch is invalid");
      }
      const paths = validated
        .map((resourceKey) =>
          join(resourceRoot, fileNameForResource(resourceKey))
        )
        .filter((path) => tryLstat(path) !== undefined);
      if (paths.length === 0) return 0;
      ensurePrivateStoreRoot(root, uid);
      ensurePrivateStoreRoot(resourceRoot, uid);
      let removed = 0;
      try {
        for (const path of paths) {
          unlinkSync(path);
          removed += 1;
        }
      } finally {
        if (removed > 0) fsyncDirectory(resourceRoot);
      }
      return removed;
    },

    compactAfterDurableSnapshot(
      operationIds: readonly string[],
      snapshot: AppState
    ): string[] {
      if (
        operationIds.length > maxRecords ||
        new Set(operationIds).size !== operationIds.length
      ) {
        throw new TypeError("operation compaction batch is invalid");
      }
      // Validate the complete snapshot once for the batch. Each operation is
      // still checked against its own exact terminal projection and receipt.
      encodeAppStateDto(snapshot);
      const compacted: string[] = [];
      try {
        for (const operationId of operationIds) {
          const operation = get(operationId);
          if (!operation?.result) continue;
          if (!durableSnapshotContainsResult(snapshot, operation)) continue;
          if (
            operation.result.authoritative.outcome === "succeeded" &&
            !resourceReceiptRetainsResult(operation, getResourceReceipt)
          ) {
            continue;
          }
          unlinkSync(join(root, fileNameForOperation(operationId)));
          compacted.push(operationId);
        }
      } finally {
        if (compacted.length > 0) fsyncDirectory(root);
      }
      return compacted;
    }
  });
}

function validateAdmission(
  candidate: Omit<DurableRemoteOperationRecord, "result">
): Omit<DurableRemoteOperationRecord, "result"> {
  const intent = decodeRemoteOperationIntentDto(
    encodeRemoteOperationIntentDto(candidate.intent)
  );
  const payload = decodeRemoteOperationPayload(candidate.payload);
  if (payload.kind !== intent.kind) {
    throw new TypeError(
      "remote operation payload kind does not match its intent"
    );
  }
  assertPayloadResourceIdentity(intent, payload);
  const canonicalPayload = canonicalizeRemoteOperationPayload(payload);
  const payloadBytes = new TextEncoder().encode(canonicalPayload);
  if (payloadBytes.byteLength > MAX_OPERATION_PAYLOAD_BYTES) {
    throw new RangeError("remote operation payload exceeds its durable limit");
  }
  const payloadHash = sha256(canonicalPayload);
  if (payloadHash !== intent.canonicalPayloadHash) {
    throw new TypeError(
      "remote operation canonical payload hash does not match"
    );
  }
  const suppliedFact = decodeMainRemoteOperationFact(
    encodeMainRemoteOperationFact(candidate.pendingFact)
  );
  if (
    suppliedFact.type !== "remote-operation.pending" ||
    !pendingFactMatchesAdmission(suppliedFact, intent, payload)
  ) {
    throw new TypeError(
      "pending product fact does not match the admitted intent"
    );
  }
  return {
    intent,
    payload,
    pendingFact: suppliedFact,
    outbox: {
      admittedAt: requireTimestamp(candidate.outbox.admittedAt, "admittedAt")
    }
  };
}

function validateResult(
  operation: DurableRemoteOperationRecord,
  authoritative: AuthoritativeRemoteOperationResult,
  fact: Exclude<MainRemoteOperationFact, { type: "remote-operation.pending" }>
): NonNullable<DurableRemoteOperationRecord["result"]> {
  const decodedFact = decodeMainRemoteOperationFact(
    encodeMainRemoteOperationFact(fact)
  );
  if (decodedFact.type === "remote-operation.pending") {
    throw new TypeError("a pending fact cannot be recorded as a result");
  }
  if (
    authoritative.operationId !== operation.intent.operationId ||
    decodedFact.operationId !== operation.intent.operationId
  ) {
    throw new TypeError("authoritative result operation ID does not match");
  }
  if (authoritative.outcome === "succeeded") {
    if (
      decodedFact.type !== "remote-operation.succeeded" ||
      decodedFact.remoteResourceRevision !==
        authoritative.remoteResourceRevision ||
      decodedFact.resultDigest !== authoritative.resultDigest ||
      decodedFact.completedAt !== authoritative.completedAt ||
      decodedFact.keeperGeneration !== authoritative.keeperGeneration ||
      authoritative.remoteResourceRevision !==
        operation.intent.nextRemoteResourceRevision
    ) {
      throw new TypeError(
        "authoritative success does not match its product fact"
      );
    }
  } else if (
    decodedFact.type !== "remote-operation.failed" ||
    decodedFact.resultDigest !== authoritative.resultDigest ||
    decodedFact.code !== authoritative.code ||
    decodedFact.message !== authoritative.message ||
    decodedFact.completedAt !== authoritative.completedAt
  ) {
    throw new TypeError(
      "authoritative failure does not match its product fact"
    );
  }
  return {
    authoritative: structuredClone(authoritative),
    fact: decodedFact
  };
}

function pendingFactMatchesAdmission(
  fact: Extract<MainRemoteOperationFact, { type: "remote-operation.pending" }>,
  intent: RemoteOperationIntent,
  payload: RemoteOperationPayloadDto
): boolean {
  const projection = fact.projection;
  if (!projection.pendingProduct) {
    return (
      payload.kind !== "workspace.create" &&
      payload.kind !== "session.create" &&
      payload.kind !== "session.restart" &&
      payload.kind !== "session.adopt" &&
      payload.kind !== "session.terminate" &&
      payload.kind !== "workspace.terminate" &&
      canonicalJson({
        operationId: projection.operationId,
        kind: projection.kind,
        resourceKey: projection.resourceKey,
        expectedWorkspaceRevision: projection.expectedWorkspaceRevision,
        expectedRemoteResourceRevision:
          projection.expectedRemoteResourceRevision.toString(10),
        nextRemoteResourceRevision:
          projection.nextRemoteResourceRevision.toString(10),
        canonicalPayloadHash: projection.canonicalPayloadHash,
        state: projection.state,
        createdAt: projection.createdAt
      }) === canonicalJson(expectedPendingAdmission(intent))
    );
  }
  const projectedPayload = payloadFromRemotePendingProductProjection(
    projection.pendingProduct
  );
  return (
    canonicalizeRemoteOperationPayload(projectedPayload) ===
      canonicalizeRemoteOperationPayload(payload) &&
    canonicalJson({
      operationId: projection.operationId,
      kind: projection.kind,
      resourceKey: projection.resourceKey,
      expectedWorkspaceRevision: projection.expectedWorkspaceRevision,
      expectedRemoteResourceRevision:
        projection.expectedRemoteResourceRevision.toString(10),
      nextRemoteResourceRevision:
        projection.nextRemoteResourceRevision.toString(10),
      canonicalPayloadHash: projection.canonicalPayloadHash,
      state: projection.state,
      createdAt: projection.createdAt
    }) === canonicalJson(expectedPendingAdmission(intent))
  );
}

function expectedPendingAdmission(
  intent: RemoteOperationIntent
): Record<string, unknown> {
  return {
    operationId: intent.operationId,
    kind: intent.kind,
    resourceKey: intent.resourceKey,
    expectedWorkspaceRevision: intent.expectedWorkspaceRevision,
    expectedRemoteResourceRevision:
      intent.expectedRemoteResourceRevision.toString(10),
    nextRemoteResourceRevision: intent.nextRemoteResourceRevision.toString(10),
    canonicalPayloadHash: intent.canonicalPayloadHash,
    state:
      intent.kind === "session.terminate" ||
      intent.kind === "workspace.terminate"
        ? "termination-pending"
        : "pending",
    createdAt: intent.createdAt
  };
}

function assertPayloadResourceIdentity(
  intent: RemoteOperationIntent,
  payload: RemoteOperationPayloadDto
): void {
  if (
    "workspaceId" in payload &&
    payload.workspaceId !== intent.resourceKey.workspaceId
  ) {
    throw new TypeError("payload workspace ID does not match its resource key");
  }
  if (
    "sessionId" in payload &&
    payload.sessionId !== intent.resourceKey.sessionId
  ) {
    throw new TypeError("payload session ID does not match its resource key");
  }
  const sessionScoped =
    payload.kind === "session.create" ||
    payload.kind === "session.restart" ||
    payload.kind === "session.adopt" ||
    payload.kind === "session.terminate" ||
    payload.kind === "launch-input";
  if (sessionScoped !== (intent.resourceKey.sessionId !== undefined)) {
    throw new TypeError("remote resource key has the wrong session scope");
  }
}

function encodeRecord(
  record: DurableRemoteOperationRecord
): DurableRemoteOperationEnvelope {
  const dto: DurableRemoteOperationRecordDto = {
    intent: encodeRemoteOperationIntentDto(record.intent),
    payload: decodeRemoteOperationPayload(record.payload),
    pendingFact: encodeMainRemoteOperationFact(record.pendingFact),
    outbox: structuredClone(record.outbox),
    ...(record.result
      ? {
          result: {
            authoritative: encodeAuthoritativeResult(
              record.result.authoritative
            ),
            fact: encodeMainRemoteOperationFact(record.result.fact)
          }
        }
      : {})
  };
  return {
    version: STORE_VERSION,
    record: dto,
    recordDigest: sha256(canonicalJson(dto))
  };
}

function decodeRecord(value: unknown): DurableRemoteOperationRecord {
  const envelope = requireRecord(value, "durable operation envelope");
  assertExactKeys(envelope, ["version", "record", "recordDigest"]);
  if (envelope.version !== STORE_VERSION) {
    throw new TypeError("unsupported durable remote operation store version");
  }
  const recordDto = requireRecord(envelope.record, "durable operation record");
  const expectedDigest = sha256(canonicalJson(recordDto));
  if (envelope.recordDigest !== expectedDigest) {
    throw new TypeError("durable remote operation record digest mismatch");
  }
  assertExactKeys(recordDto, [
    "intent",
    "payload",
    "pendingFact",
    "outbox",
    "result"
  ]);
  const intent = decodeRemoteOperationIntentDto(recordDto.intent);
  const pendingFact = decodeMainRemoteOperationFact(recordDto.pendingFact);
  if (pendingFact.type !== "remote-operation.pending") {
    throw new TypeError("durable admission must contain a pending fact");
  }
  const outbox = requireRecord(recordDto.outbox, "durable outbox admission");
  assertExactKeys(outbox, ["admittedAt"]);
  const admission = validateAdmission({
    intent,
    payload: decodeRemoteOperationPayload(recordDto.payload),
    pendingFact,
    outbox: {
      admittedAt: requireTimestamp(outbox.admittedAt, "admittedAt")
    }
  });
  if (recordDto.result === undefined) {
    return admission;
  }
  const resultRecord = requireRecord(recordDto.result, "durable result");
  assertExactKeys(resultRecord, ["authoritative", "fact"]);
  const authoritative = decodeAuthoritativeResult(resultRecord.authoritative);
  const fact = decodeMainRemoteOperationFact(resultRecord.fact);
  if (fact.type === "remote-operation.pending") {
    throw new TypeError("durable result contains a pending fact");
  }
  return {
    ...admission,
    result: validateResult(admission, authoritative, fact)
  };
}

function readRecord(
  path: string,
  uid: number | undefined,
  knownStats?: Stats
): DurableRemoteOperationRecord {
  const stats = knownStats ?? lstatSync(path);
  assertPrivateRegularFile(stats, uid);
  if (stats.size > MAX_OPERATION_RECORD_BYTES) {
    throw new RangeError("durable remote operation record exceeds its limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_OPERATION_RECORD_BYTES) {
    throw new RangeError("durable remote operation record exceeds its limit");
  }
  try {
    const record = decodeRecord(JSON.parse(bytes.toString("utf8")));
    if (basename(path) !== fileNameForOperation(record.intent.operationId)) {
      throw new Error(
        "durable operation file name does not match its operation ID"
      );
    }
    return record;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `invalid durable remote operation record ${path}: ${reason}`
    );
  }
}

function encodeResourceReceipt(
  receipt: DurableRemoteResourceReceipt
): DurableRemoteResourceReceiptEnvelope {
  const authority = {
    resourceKey: structuredClone(receipt.resourceKey),
    remoteResourceRevision: formatUint64Decimal(receipt.remoteResourceRevision),
    createOperationId: receipt.createOperationId,
    canonicalCreatePayloadHash: receipt.canonicalCreatePayloadHash,
    lastOperationId: receipt.lastOperationId,
    lastOperationPayloadHash: receipt.lastOperationPayloadHash,
    lastResultDigest: receipt.lastResultDigest,
    observedAt: receipt.observedAt
  };
  const dto: DurableRemoteResourceReceiptDto = isSessionResourceReceipt(receipt)
    ? {
        ...authority,
        resourceKey: structuredClone(receipt.resourceKey),
        keeperGeneration: receipt.keeperGeneration,
        processState: receipt.processState
      }
    : {
        ...authority,
        resourceKey: structuredClone(receipt.resourceKey),
        resourceState: receipt.resourceState
      };
  return {
    version: STORE_VERSION,
    receipt: dto,
    receiptDigest: sha256(canonicalJson(dto))
  };
}

function decodeResourceReceipt(value: unknown): DurableRemoteResourceReceipt {
  const envelope = requireRecord(value, "remote resource receipt envelope");
  assertExactKeys(envelope, ["version", "receipt", "receiptDigest"]);
  if (envelope.version !== STORE_VERSION) {
    throw new TypeError("unsupported remote resource receipt version");
  }
  const receipt = requireRecord(envelope.receipt, "remote resource receipt");
  if (envelope.receiptDigest !== sha256(canonicalJson(receipt))) {
    throw new TypeError("remote resource receipt digest mismatch");
  }
  const resourceKey = validateResourceKey(receipt.resourceKey);
  const common = {
    resourceKey,
    remoteResourceRevision: parseUint64Decimal(receipt.remoteResourceRevision),
    createOperationId: requireId(
      receipt.createOperationId,
      "createOperationId"
    ),
    canonicalCreatePayloadHash: requireDigest(
      receipt.canonicalCreatePayloadHash,
      "canonicalCreatePayloadHash"
    ),
    lastOperationId: requireId(receipt.lastOperationId, "lastOperationId"),
    lastOperationPayloadHash: requireDigest(
      receipt.lastOperationPayloadHash,
      "lastOperationPayloadHash"
    ),
    lastResultDigest: requireDigest(
      receipt.lastResultDigest,
      "lastResultDigest"
    ),
    observedAt: requireTimestamp(receipt.observedAt, "observedAt")
  };
  if (resourceKey.sessionId !== undefined) {
    assertExactKeys(receipt, [
      "resourceKey",
      "remoteResourceRevision",
      "keeperGeneration",
      "processState",
      "createOperationId",
      "canonicalCreatePayloadHash",
      "lastOperationId",
      "lastOperationPayloadHash",
      "lastResultDigest",
      "observedAt"
    ]);
    if (
      receipt.processState !== "running" &&
      receipt.processState !== "exited"
    ) {
      throw new TypeError("remote resource receipt process state is invalid");
    }
    return {
      ...common,
      resourceKey: { ...resourceKey, sessionId: resourceKey.sessionId },
      keeperGeneration: requireId(receipt.keeperGeneration, "keeperGeneration"),
      processState: receipt.processState
    };
  }
  assertExactKeys(receipt, [
    "resourceKey",
    "remoteResourceRevision",
    "resourceState",
    "createOperationId",
    "canonicalCreatePayloadHash",
    "lastOperationId",
    "lastOperationPayloadHash",
    "lastResultDigest",
    "observedAt"
  ]);
  if (
    receipt.resourceState !== "active" &&
    receipt.resourceState !== "terminated"
  ) {
    throw new TypeError("remote resource receipt resource state is invalid");
  }
  return {
    ...common,
    resourceKey,
    resourceState: receipt.resourceState
  };
}

function readResourceReceipt(
  path: string,
  uid: number | undefined,
  knownStats?: Stats
): DurableRemoteResourceReceipt {
  const stats = knownStats ?? lstatSync(path);
  assertPrivateRegularFile(stats, uid);
  if (stats.size > MAX_RESOURCE_RECEIPT_BYTES) {
    throw new RangeError("remote resource receipt exceeds its limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_RESOURCE_RECEIPT_BYTES) {
    throw new RangeError("remote resource receipt exceeds its limit");
  }
  try {
    const receipt = decodeResourceReceipt(JSON.parse(bytes.toString("utf8")));
    if (basename(path) !== fileNameForResource(receipt.resourceKey)) {
      throw new Error(
        "remote resource receipt file name does not match its key"
      );
    }
    return receipt;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid remote resource receipt ${path}: ${reason}`);
  }
}

function listOperationRecordNames(
  root: string,
  uid: number | undefined
): string[] {
  const entries = readBoundedDirectoryNames(
    root,
    MAX_OPERATION_DIRECTORY_ENTRIES,
    "durable remote operation directory"
  );
  const names: string[] = [];
  let removedTemporaryFile = false;
  for (const name of entries) {
    if (name === RESOURCE_RECEIPT_DIRECTORY) {
      assertPrivateDirectory(lstatSync(join(root, name)), uid);
      continue;
    }
    if (/^[a-f0-9]{64}\.json$/.test(name)) {
      names.push(name);
      continue;
    }
    if (/^\.[a-f0-9]{64}\.json\.tmp-[a-zA-Z0-9-]{1,128}$/.test(name)) {
      const path = join(root, name);
      assertPrivateRegularFile(lstatSync(path), uid);
      unlinkSync(path);
      removedTemporaryFile = true;
      continue;
    }
    throw new Error(`durable remote operation file name is invalid: ${name}`);
  }
  if (removedTemporaryFile) {
    const descriptor = openSync(
      root,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  return names;
}

function listResourceReceiptNames(
  root: string,
  uid: number | undefined
): string[] {
  const names: string[] = [];
  let removedTemporaryFile = false;
  for (const name of readBoundedDirectoryNames(
    root,
    MAX_RESOURCE_DIRECTORY_ENTRIES,
    "remote resource receipt directory"
  )) {
    if (/^[a-f0-9]{64}\.json$/u.test(name)) {
      names.push(name);
      continue;
    }
    if (/^\.[a-f0-9]{64}\.json\.tmp-[a-zA-Z0-9-]{1,128}$/u.test(name)) {
      const path = join(root, name);
      assertPrivateRegularFile(lstatSync(path), uid);
      unlinkSync(path);
      removedTemporaryFile = true;
      continue;
    }
    throw new Error(`remote resource receipt file name is invalid: ${name}`);
  }
  if (removedTemporaryFile) fsyncDirectory(root);
  return names;
}

function readBoundedDirectoryNames(
  root: string,
  maximum: number,
  label: string
): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= maximum) {
        throw new RangeError(`${label} exceeds its entry limit`);
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function validateMaxRecords(value: number | undefined): number {
  const maximum = value ?? MAX_OPERATION_RECORDS;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_OPERATION_RECORDS
  ) {
    throw new TypeError(
      `maxRecords must be between 1 and ${MAX_OPERATION_RECORDS}`
    );
  }
  return maximum;
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

function encodeAuthoritativeResult(
  result: AuthoritativeRemoteOperationResult
): AuthoritativeRemoteOperationResultDto {
  return result.outcome === "succeeded"
    ? {
        ...result,
        remoteResourceRevision: result.remoteResourceRevision.toString(10)
      }
    : structuredClone(result);
}

function decodeAuthoritativeResult(
  value: unknown
): AuthoritativeRemoteOperationResult {
  const record = requireRecord(value, "authoritative operation result");
  if (record.outcome === "succeeded") {
    const fact = decodeMainRemoteOperationFact({
      type: "remote-operation.succeeded",
      operationId: record.operationId,
      remoteResourceRevision: record.remoteResourceRevision,
      resultDigest: record.resultDigest,
      completedAt: record.completedAt,
      ...(record.keeperGeneration === undefined
        ? {}
        : { keeperGeneration: record.keeperGeneration })
    });
    if (fact.type !== "remote-operation.succeeded") {
      throw new TypeError("invalid authoritative success");
    }
    assertExactKeys(record, [
      "outcome",
      "operationId",
      "remoteResourceRevision",
      "resultDigest",
      "completedAt",
      "keeperGeneration"
    ]);
    return {
      outcome: "succeeded",
      operationId: fact.operationId,
      remoteResourceRevision: fact.remoteResourceRevision,
      resultDigest: fact.resultDigest,
      completedAt: fact.completedAt,
      ...(fact.keeperGeneration === undefined
        ? {}
        : { keeperGeneration: fact.keeperGeneration })
    };
  }
  if (record.outcome === "failed") {
    const fact = decodeMainRemoteOperationFact({
      type: "remote-operation.failed",
      operationId: record.operationId,
      resultDigest: record.resultDigest,
      code: record.code,
      message: record.message,
      completedAt: record.completedAt
    });
    if (fact.type !== "remote-operation.failed") {
      throw new TypeError("invalid authoritative failure");
    }
    assertExactKeys(record, [
      "outcome",
      "operationId",
      "resultDigest",
      "code",
      "message",
      "completedAt"
    ]);
    return {
      outcome: "failed",
      operationId: fact.operationId,
      resultDigest: fact.resultDigest,
      code: fact.code,
      message: fact.message,
      completedAt: fact.completedAt
    };
  }
  throw new TypeError("authoritative operation result outcome is invalid");
}

function ensurePrivateStoreRoot(root: string, uid: number | undefined): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("durable remote operation root must be a real directory");
  }
  assertPrivate(stats, uid, "durable remote operation root");
}

function assertPrivateDirectory(stats: Stats, uid: number | undefined): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("durable remote operation child must be a real directory");
  }
  assertPrivate(stats, uid, "durable remote operation child");
}

function assertPrivateRegularFile(stats: Stats, uid: number | undefined): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("durable remote operation record must be a regular file");
  }
  assertPrivate(stats, uid, "durable remote operation record");
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

function sameAdmission(
  existing: DurableRemoteOperationRecord,
  candidate: Omit<DurableRemoteOperationRecord, "result">
): boolean {
  const { result: _result, ...existingAdmission } = existing;
  return (
    canonicalJson(encodeRecord(existingAdmission).record) ===
    canonicalJson(encodeRecord(candidate).record)
  );
}

function sameResult(
  left: NonNullable<DurableRemoteOperationRecord["result"]>,
  right: NonNullable<DurableRemoteOperationRecord["result"]>
): boolean {
  return (
    canonicalJson({
      authoritative: encodeAuthoritativeResult(left.authoritative),
      fact: encodeMainRemoteOperationFact(left.fact)
    }) ===
    canonicalJson({
      authoritative: encodeAuthoritativeResult(right.authoritative),
      fact: encodeMainRemoteOperationFact(right.fact)
    })
  );
}

function cloneRecord(
  record: DurableRemoteOperationRecord
): DurableRemoteOperationRecord {
  return decodeRecord(encodeRecord(record));
}

function cloneResourceReceipt(
  receipt: DurableRemoteResourceReceipt
): DurableRemoteResourceReceipt {
  return decodeResourceReceipt(encodeResourceReceipt(receipt));
}

function resourceReceiptAuthorityAtRevision(
  receipt: DurableRemoteResourceReceipt
): Record<string, unknown> {
  const { observedAt: _observedAt, ...stable } =
    encodeResourceReceipt(receipt).receipt;
  delete (stable as Record<string, unknown>).processState;
  delete (stable as Record<string, unknown>).resourceState;
  return stable;
}

function isSessionResourceReceipt(
  receipt: DurableRemoteResourceReceipt
): receipt is DurableRemoteResourceReceipt & {
  resourceKey: RemoteResourceKey & { sessionId: string };
  keeperGeneration: string;
  processState: "running" | "exited";
} {
  return receipt.resourceKey.sessionId !== undefined;
}

function sameObservedResourceState(
  left: DurableRemoteResourceReceipt,
  right: DurableRemoteResourceReceipt
): boolean {
  return isSessionResourceReceipt(left) && isSessionResourceReceipt(right)
    ? left.processState === right.processState
    : !isSessionResourceReceipt(left) && !isSessionResourceReceipt(right)
      ? left.resourceState === right.resourceState
      : false;
}

function resourceStateRegressed(
  left: DurableRemoteResourceReceipt,
  right: DurableRemoteResourceReceipt
): boolean {
  return isSessionResourceReceipt(left) && isSessionResourceReceipt(right)
    ? left.processState === "exited" && right.processState === "running"
    : !isSessionResourceReceipt(left) && !isSessionResourceReceipt(right)
      ? left.resourceState === "terminated" && right.resourceState === "active"
      : true;
}

function fileNameForOperation(operationId: string): string {
  validateOperationId(operationId);
  return `${sha256(operationId)}.json`;
}

function fileNameForResource(resourceKey: RemoteResourceKey): string {
  return `${sha256(resourceKeyIdentity(validateResourceKey(resourceKey)))}.json`;
}

function resourceKeyIdentity(resourceKey: RemoteResourceKey): string {
  return [
    resourceKey.desktopInstallationId,
    resourceKey.targetId,
    resourceKey.workspaceId,
    resourceKey.sessionId ?? ""
  ].join("\0");
}

function validateResourceKey(value: unknown): RemoteResourceKey {
  const record = requireRecord(value, "remote resource key");
  const hasSessionId = record.sessionId !== undefined;
  assertExactKeys(
    record,
    hasSessionId
      ? ["desktopInstallationId", "targetId", "workspaceId", "sessionId"]
      : ["desktopInstallationId", "targetId", "workspaceId"]
  );
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    workspaceId: requireId(record.workspaceId, "workspaceId"),
    ...(hasSessionId
      ? { sessionId: requireId(record.sessionId, "sessionId") }
      : {})
  };
}

function durableSnapshotContainsResult(
  snapshot: AppState,
  operation: DurableRemoteOperationRecord
): boolean {
  const projection = snapshot.remoteOperations[operation.intent.operationId];
  const result = operation.result?.authoritative;
  if (!projection || !result) return false;
  if (
    projection.operationId !== operation.intent.operationId ||
    projection.resultDigest !== result.resultDigest ||
    projection.completedAt !== result.completedAt
  ) {
    return false;
  }
  if (result.outcome === "failed") {
    return (
      projection.state === "failed" &&
      projection.failure?.code === result.code &&
      projection.failure.message === result.message
    );
  }
  return (
    projection.state === "succeeded" &&
    projection.nextRemoteResourceRevision === result.remoteResourceRevision &&
    projection.keeperGeneration === result.keeperGeneration
  );
}

function resourceReceiptRetainsResult(
  operation: DurableRemoteOperationRecord,
  getReceipt: (key: RemoteResourceKey) => DurableRemoteResourceReceipt | null
): boolean {
  const result = operation.result?.authoritative;
  if (!result || result.outcome !== "succeeded") return false;
  const receipt = getReceipt(operation.intent.resourceKey);
  if (!receipt) return false;
  if (
    operation.intent.kind === "session.create" ||
    operation.intent.kind === "workspace.create"
  ) {
    return (
      receipt.createOperationId === operation.intent.operationId &&
      receipt.canonicalCreatePayloadHash ===
        operation.intent.canonicalPayloadHash &&
      receipt.remoteResourceRevision >= result.remoteResourceRevision
    );
  }
  if (receipt.remoteResourceRevision > result.remoteResourceRevision) {
    return true;
  }
  return (
    receipt.remoteResourceRevision === result.remoteResourceRevision &&
    receipt.lastOperationId === operation.intent.operationId &&
    receipt.lastOperationPayloadHash ===
      operation.intent.canonicalPayloadHash &&
    receipt.lastResultDigest === result.resultDigest
  );
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

function validateOperationId(operationId: string): void {
  if (
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    new TextEncoder().encode(operationId).byteLength > 256 ||
    /\p{Cc}/u.test(operationId)
  ) {
    throw new TypeError("operation ID is invalid");
  }
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected durable operation field: ${unexpected}`);
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
      throw new TypeError("canonical durable JSON accepts only safe integers");
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
  throw new TypeError("durable value cannot be represented as canonical JSON");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
