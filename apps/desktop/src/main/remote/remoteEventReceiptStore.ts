import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  decodeRemoteSpoolEventDto,
  formatUint64Decimal,
  incrementUint64,
  parseUint64Decimal,
  type Id,
  type RemoteSpoolEventDto,
  type Uint64
} from "@kmux/proto";

import { durableAtomicReplace } from "./durableAtomicWrite";

const STORE_VERSION = 1;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;

export interface RemoteEventReceiptRecord {
  desktopInstallationId: Id;
  targetId: Id;
  appliedThrough: Uint64;
  pending?: RemoteSpoolEventDto;
}

interface RemoteEventReceiptRecordDto extends Omit<
  RemoteEventReceiptRecord,
  "appliedThrough"
> {
  appliedThrough: string;
}

interface RemoteEventReceiptEnvelope {
  version: typeof STORE_VERSION;
  record: RemoteEventReceiptRecordDto;
  recordDigest: string;
}

export interface RemoteEventReceiptStore {
  load(desktopInstallationId: Id, targetId: Id): RemoteEventReceiptRecord;
  stage(event: RemoteSpoolEventDto): RemoteEventReceiptRecord;
  complete(event: RemoteSpoolEventDto): RemoteEventReceiptRecord;
}

export class RemoteEventReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteEventReceiptConflictError";
  }
}

export function createRemoteEventReceiptStore(
  rootDirectory: string
): RemoteEventReceiptStore {
  const root = resolve(rootDirectory);

  const persist = (
    record: RemoteEventReceiptRecord
  ): RemoteEventReceiptRecord => {
    const dto = encodeRecord(record);
    const recordDigest = sha256(canonicalJson(dto));
    const envelope: RemoteEventReceiptEnvelope = {
      version: STORE_VERSION,
      record: dto,
      recordDigest
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new RangeError("remote event receipt exceeds its size limit");
    }
    durableAtomicReplace(
      root,
      receiptFileName(record.desktopInstallationId, record.targetId),
      bytes
    );
    return cloneRecord(record);
  };

  return Object.freeze({
    load(desktopInstallationId: Id, targetId: Id) {
      validateId(desktopInstallationId, "desktopInstallationId");
      validateId(targetId, "targetId");
      return loadRecord(root, desktopInstallationId, targetId);
    },

    stage(event: RemoteSpoolEventDto) {
      const candidate = validateEvent(event);
      const record = loadRecord(
        root,
        candidate.resourceKey.desktopInstallationId,
        candidate.resourceKey.targetId
      );
      const sequence = parseUint64Decimal(candidate.sequence);
      if (sequence <= record.appliedThrough) {
        return record;
      }
      if (record.pending) {
        if (!sameEvent(record.pending, candidate)) {
          throw new RemoteEventReceiptConflictError(
            "another remote event is already staged for this target"
          );
        }
        return record;
      }
      if (sequence !== incrementUint64(record.appliedThrough)) {
        throw new RemoteEventReceiptConflictError(
          "remote event sequence is not contiguous with the durable cursor"
        );
      }
      return persist({
        ...record,
        pending: structuredClone(candidate)
      });
    },

    complete(event: RemoteSpoolEventDto) {
      const candidate = validateEvent(event);
      const record = loadRecord(
        root,
        candidate.resourceKey.desktopInstallationId,
        candidate.resourceKey.targetId
      );
      const sequence = parseUint64Decimal(candidate.sequence);
      if (sequence <= record.appliedThrough) {
        if (record.pending && sameEvent(record.pending, candidate)) {
          throw new RemoteEventReceiptConflictError(
            "an applied remote event remained staged"
          );
        }
        return record;
      }
      if (!record.pending || !sameEvent(record.pending, candidate)) {
        throw new RemoteEventReceiptConflictError(
          "remote event completion does not match the staged event"
        );
      }
      if (sequence !== incrementUint64(record.appliedThrough)) {
        throw new RemoteEventReceiptConflictError(
          "remote event completion is not contiguous with the durable cursor"
        );
      }
      return persist({
        desktopInstallationId: record.desktopInstallationId,
        targetId: record.targetId,
        appliedThrough: sequence
      });
    }
  });
}

function loadRecord(
  root: string,
  desktopInstallationId: Id,
  targetId: Id
): RemoteEventReceiptRecord {
  const path = join(root, receiptFileName(desktopInstallationId, targetId));
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) {
      return {
        desktopInstallationId,
        targetId,
        appliedThrough: parseUint64Decimal("0")
      };
    }
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("remote event receipt is not a private regular file");
  }
  if (stats.size > MAX_RECORD_BYTES) {
    throw new RangeError("remote event receipt exceeds its size limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new RangeError("remote event receipt exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("remote event receipt is not valid JSON");
  }
  const envelope = requireRecord(value, "remote event receipt envelope");
  assertExactKeys(envelope, ["version", "record", "recordDigest"]);
  if (envelope.version !== STORE_VERSION) {
    throw new Error("remote event receipt version is unsupported");
  }
  const dto = requireRecord(envelope.record, "remote event receipt record");
  if (
    typeof envelope.recordDigest !== "string" ||
    envelope.recordDigest !== sha256(canonicalJson(dto))
  ) {
    throw new Error("remote event receipt digest does not match");
  }
  const record = decodeRecord(dto);
  if (
    record.desktopInstallationId !== desktopInstallationId ||
    record.targetId !== targetId
  ) {
    throw new Error("remote event receipt scope does not match its file");
  }
  return record;
}

function encodeRecord(
  record: RemoteEventReceiptRecord
): RemoteEventReceiptRecordDto {
  validateId(record.desktopInstallationId, "desktopInstallationId");
  validateId(record.targetId, "targetId");
  if (record.pending) {
    const pending = validateEvent(record.pending);
    if (
      pending.resourceKey.desktopInstallationId !==
        record.desktopInstallationId ||
      pending.resourceKey.targetId !== record.targetId ||
      parseUint64Decimal(pending.sequence) !==
        incrementUint64(record.appliedThrough)
    ) {
      throw new Error(
        "staged remote event is outside its receipt scope or cursor"
      );
    }
  }
  return {
    desktopInstallationId: record.desktopInstallationId,
    targetId: record.targetId,
    appliedThrough: formatUint64Decimal(record.appliedThrough),
    ...(record.pending === undefined
      ? {}
      : { pending: structuredClone(record.pending) })
  };
}

function decodeRecord(
  value: Record<string, unknown>
): RemoteEventReceiptRecord {
  assertExactKeys(value, [
    "desktopInstallationId",
    "targetId",
    "appliedThrough",
    "pending"
  ]);
  const desktopInstallationId = validateId(
    value.desktopInstallationId,
    "desktopInstallationId"
  );
  const targetId = validateId(value.targetId, "targetId");
  const appliedThrough = parseUint64Decimal(value.appliedThrough);
  const pending =
    value.pending === undefined ? undefined : validateEvent(value.pending);
  const record: RemoteEventReceiptRecord = {
    desktopInstallationId,
    targetId,
    appliedThrough,
    ...(pending === undefined ? {} : { pending })
  };
  encodeRecord(record);
  return record;
}

function validateEvent(value: unknown): RemoteSpoolEventDto {
  return structuredClone(decodeRemoteSpoolEventDto(value));
}

function cloneRecord(
  record: RemoteEventReceiptRecord
): RemoteEventReceiptRecord {
  return {
    desktopInstallationId: record.desktopInstallationId,
    targetId: record.targetId,
    appliedThrough: record.appliedThrough,
    ...(record.pending === undefined
      ? {}
      : { pending: structuredClone(record.pending) })
  };
}

function sameEvent(
  left: RemoteSpoolEventDto,
  right: RemoteSpoolEventDto
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function receiptFileName(desktopInstallationId: Id, targetId: Id): string {
  return `${sha256(`${desktopInstallationId}\0${targetId}`).slice(0, 32)}.json`;
}

function validateId(value: unknown, field: string): Id {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_ID_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
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
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`unexpected remote event receipt field ${key}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
