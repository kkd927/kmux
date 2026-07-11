import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";

const MAX_BINARY_SCAN_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 96;
const MAX_PROMPT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PROMPT_FIELD_BYTES = 128 * 1024;
const MAX_PROMPT_PARSE_DEPTH = 8;

const nodeRequire = createRequire(import.meta.url);

type DatabaseSyncConstructor = typeof NodeSqliteDatabaseSync;
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>;

type ConversationSignatureEntry =
  | string
  | {
      entry: string;
      effectiveMtimeMs: number;
      signature: string;
    };

export interface AntigravityConversationMetadata {
  conversationId: string;
  workspace?: string;
  title?: string;
  recentConversation?: string;
  createdAt?: string;
  updatedAt?: string;
  mtimeMs: number;
}

const conversationMetadataCache = new Map<
  string,
  { signature: string; records: AntigravityConversationMetadata[] }
>();
let cachedDatabaseSync: DatabaseSyncConstructor | null | undefined;

export function readAntigravityConversationMetadata(
  homeDirectory: string,
  options: { maxConversationFiles?: number } = {}
): AntigravityConversationMetadata[] {
  const antigravityRoot = join(homeDirectory, ".gemini", "antigravity-cli");
  return readAntigravityConversationMetadataFromRoot(antigravityRoot, options);
}

export function readAntigravityConversationMetadataFromRoot(
  antigravityRoot: string,
  options: { maxConversationFiles?: number } = {}
): AntigravityConversationMetadata[] {
  const cacheKey = `${antigravityRoot}:${options.maxConversationFiles ?? "all"}`;
  const signature = antigravityStorageSignature(
    antigravityRoot,
    options.maxConversationFiles
  );
  const cached = conversationMetadataCache.get(cacheKey);
  if (cached?.signature === signature) {
    return cloneConversationMetadata(cached.records);
  }

  const records = readAntigravityConversationMetadataUncached(
    antigravityRoot,
    options
  );
  conversationMetadataCache.set(cacheKey, {
    signature,
    records
  });
  return cloneConversationMetadata(records);
}

function readAntigravityConversationMetadataUncached(
  antigravityRoot: string,
  options: { maxConversationFiles?: number }
): AntigravityConversationMetadata[] {
  const conversations = new Map<string, AntigravityConversationMetadata>();

  for (const record of parseJsonlFile(join(antigravityRoot, "history.jsonl"))) {
    if (!isRecord(record)) {
      continue;
    }
    const workspace = normalizePathValue(
      pickFirstString(record, ["workspace"])
    );
    const conversationId = pickFirstString(record, ["conversationId"]);
    if (!conversationId) {
      continue;
    }
    upsertConversation(
      conversations,
      buildHistoryConversationRecord(conversationId, record, workspace)
    );
  }

  const projectWorkspaces = readAntigravityProjectWorkspaces(antigravityRoot);
  for (const conversation of listAntigravityConversationFiles(
    antigravityRoot,
    projectWorkspaces,
    options.maxConversationFiles
  )) {
    upsertConversation(conversations, conversation);
  }

  return Array.from(conversations.values()).sort(
    (left, right) => right.mtimeMs - left.mtimeMs
  );
}

function cloneConversationMetadata(
  records: AntigravityConversationMetadata[]
): AntigravityConversationMetadata[] {
  return records.map((record) => ({ ...record }));
}

function antigravityStorageSignature(
  antigravityRoot: string,
  maxConversationFiles: number | undefined
): string {
  return [
    fileSignature(join(antigravityRoot, "history.jsonl")),
    fileSignature(join(antigravityRoot, "cache", "projects.json")),
    conversationsSignature(
      join(antigravityRoot, "conversations"),
      maxConversationFiles
    )
  ].join("|");
}

function fileSignature(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return `${filePath}:${stats.size}:${Number(stats.mtimeMs)}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function conversationsSignature(
  conversationsRoot: string,
  maxConversationFiles: number | undefined
): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(conversationsRoot);
  } catch {
    return `${conversationsRoot}:missing`;
  }

  const signatures: ConversationSignatureEntry[] = entries.flatMap(
    (entry): ConversationSignatureEntry[] => {
      if (!entry.endsWith(".db")) {
        return [];
      }
      const path = join(conversationsRoot, entry);
      try {
        const stats = statSync(path);
        if (!stats.isFile()) {
          return [];
        }
        const effectiveMtimeMs = sqliteEffectiveMtimeMs(
          path,
          Number(stats.mtimeMs)
        );
        return [
          {
            entry,
            effectiveMtimeMs,
            signature: `${entry}:${stats.size}:${Number(stats.mtimeMs)}:${fileSignature(`${path}-wal`)}`
          }
        ];
      } catch {
        return [`${entry}:missing`];
      }
    }
  );

  return signatures
    .sort((left, right) => {
      if (typeof left === "string" || typeof right === "string") {
        return String(left).localeCompare(String(right));
      }
      return (
        right.effectiveMtimeMs - left.effectiveMtimeMs ||
        left.entry.localeCompare(right.entry)
      );
    })
    .slice(0, maxConversationFiles)
    .map((entry) => (typeof entry === "string" ? entry : entry.signature))
    .join(",");
}

export function readAntigravityWorkspaceByConversation(
  homeDirectory: string
): Map<string, string> {
  return readAntigravityWorkspaceByConversationFromRoot(
    join(homeDirectory, ".gemini", "antigravity-cli")
  );
}

export function readAntigravityWorkspaceByConversationFromRoot(
  antigravityRoot: string
): Map<string, string> {
  return new Map(
    readAntigravityConversationMetadataFromRoot(antigravityRoot)
      .filter((conversation) => conversation.workspace)
      .map((conversation) => [
        conversation.conversationId,
        conversation.workspace as string
      ])
  );
}

function buildHistoryConversationRecord(
  conversationId: string,
  record: Record<string, unknown> | undefined,
  workspace: string | undefined
): AntigravityConversationMetadata {
  const timestampMs = numericField(record, "timestamp");
  const timestamp =
    typeof timestampMs === "number"
      ? new Date(timestampMs).toISOString()
      : undefined;
  const display = pickFirstString(record, ["display"]);
  const title = sanitizeTitle(display);
  const recentConversation = sanitizePreview(display);
  return {
    conversationId,
    ...(workspace ? { workspace } : {}),
    ...(title ? { title } : {}),
    ...(recentConversation ? { recentConversation } : {}),
    ...(timestamp ? { createdAt: timestamp, updatedAt: timestamp } : {}),
    mtimeMs: timestampMs ?? 0
  };
}

function listAntigravityConversationFiles(
  antigravityRoot: string,
  projectWorkspaces: Map<string, string>,
  maxFiles: number | undefined
): AntigravityConversationMetadata[] {
  const conversationsRoot = join(antigravityRoot, "conversations");
  let entries: string[] = [];
  try {
    entries = readdirSync(conversationsRoot);
  } catch {
    return [];
  }

  const candidates = entries.flatMap((entry) => {
    if (!entry.endsWith(".db")) {
      return [];
    }
    const path = join(conversationsRoot, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        return [];
      }
      return [
        {
          path,
          createdAt: new Date(stats.birthtimeMs).toISOString(),
          mtimeMs: sqliteEffectiveMtimeMs(path, Number(stats.mtimeMs))
        }
      ];
    } catch {
      return [];
    }
  });

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .flatMap((candidate) => {
      const conversationId = basename(candidate.path, ".db");
      if (!isUuidLike(conversationId)) {
        return [];
      }
      const details = extractConversationDetailsFromDb(candidate.path);
      return [
        {
          conversationId,
          ...optionalStringProperty(
            "workspace",
            inferAntigravityConversationWorkspace(
              candidate.path,
              projectWorkspaces
            )
          ),
          ...(details.title ? { title: details.title } : {}),
          ...(details.recentConversation
            ? { recentConversation: details.recentConversation }
            : {}),
          createdAt: candidate.createdAt,
          updatedAt: new Date(candidate.mtimeMs).toISOString(),
          mtimeMs: candidate.mtimeMs
        }
      ];
    });
}

function sqliteEffectiveMtimeMs(
  databasePath: string,
  databaseMtimeMs: number
): number {
  try {
    const walStats = statSync(`${databasePath}-wal`);
    return walStats.isFile()
      ? Math.max(databaseMtimeMs, Number(walStats.mtimeMs))
      : databaseMtimeMs;
  } catch {
    return databaseMtimeMs;
  }
}

function readAntigravityProjectWorkspaces(
  antigravityRoot: string
): Map<string, string> {
  return new Map(
    Array.from(
      readStringMap(join(antigravityRoot, "cache", "projects.json")).entries()
    ).map(([workspace, projectId]) => [projectId, workspace] as const)
  );
}

function inferAntigravityConversationWorkspace(
  dbPath: string,
  projectWorkspaces: Map<string, string>
): string | undefined {
  if (projectWorkspaces.size === 0) {
    return undefined;
  }
  const searchable = readFilePrefix(dbPath);
  for (const [projectId, workspace] of projectWorkspaces.entries()) {
    const normalizedWorkspace = normalizePathValue(workspace);
    if (normalizedWorkspace && searchable.includes(projectId)) {
      return normalizedWorkspace;
    }
  }
  return undefined;
}

function upsertConversation(
  conversations: Map<string, AntigravityConversationMetadata>,
  record: AntigravityConversationMetadata
): void {
  const previous = conversations.get(record.conversationId);
  if (!previous) {
    conversations.set(record.conversationId, record);
    return;
  }
  conversations.set(record.conversationId, {
    conversationId: record.conversationId,
    workspace: record.workspace ?? previous.workspace,
    title: record.title ?? previous.title,
    recentConversation:
      record.recentConversation ?? previous.recentConversation,
    createdAt: earliestIsoTimestamp(previous.createdAt, record.createdAt),
    updatedAt: latestIsoTimestamp(previous.updatedAt, record.updatedAt),
    mtimeMs: Math.max(previous.mtimeMs, record.mtimeMs)
  });
}

function parseJsonlFile(filePath: string): unknown[] {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function readFilePrefix(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(MAX_BINARY_SCAN_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function readStringMap(filePath: string): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed).flatMap(([key, value]) => {
        if (typeof value !== "string" || !key.trim() || !value.trim()) {
          return [];
        }
        return [[key.trim(), value.trim()]];
      })
    );
  } catch {
    return new Map();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickFirstString(
  object: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!object) {
    return undefined;
  }
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numericField(
  object: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizePathValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.replace(/\/+$/u, "") : undefined;
}

function sanitizeTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 3)}...`
    : normalized;
}

function sanitizePreview(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const maxLength = 220;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function optionalStringProperty<K extends string>(
  key: K,
  value: string | undefined
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function earliestIsoTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestIsoTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value
  );
}

function extractConversationDetailsFromDb(dbPath: string): {
  title?: string;
  recentConversation?: string;
} {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    return {};
  }

  let db: DatabaseSyncInstance | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const firstRow = db
      .prepare(
        "SELECT step_payload FROM steps WHERE idx = 0 AND step_type = 14 LIMIT 1"
      )
      .get() as unknown;
    const latestRow = db
      .prepare(
        "SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1"
      )
      .get() as unknown;
    const firstPrompt = promptFromStepRow(firstRow);
    const latestPrompt = promptFromStepRow(latestRow);
    return {
      ...optionalStringProperty("title", sanitizeTitle(firstPrompt)),
      ...optionalStringProperty(
        "recentConversation",
        sanitizePreview(latestPrompt)
      )
    };
  } catch {
    // Database sync might fail if the file is locked, busy, or corrupted
  } finally {
    try {
      db?.close();
    } catch {
      // Closing is best-effort because this reader is optional metadata.
    }
  }
  return {};
}

function promptFromStepRow(row: unknown): string | undefined {
  const payload = isRecord(row) ? row.step_payload : undefined;
  return payload instanceof Uint8Array
    ? extractPromptFromPayload(Buffer.from(payload))
    : undefined;
}

function loadDatabaseSync(): DatabaseSyncConstructor | undefined {
  if (cachedDatabaseSync !== undefined) {
    return cachedDatabaseSync ?? undefined;
  }
  try {
    const sqliteModule = nodeRequire("node:sqlite") as {
      DatabaseSync?: unknown;
    };
    cachedDatabaseSync =
      typeof sqliteModule.DatabaseSync === "function"
        ? (sqliteModule.DatabaseSync as DatabaseSyncConstructor)
        : null;
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync ?? undefined;
}

function readVarint(
  buffer: Buffer,
  offset: number
): { value: number; nextOffset: number } | undefined {
  let value = 0;
  let multiplier = 1;
  for (
    let bytesRead = 0;
    bytesRead < 10 && offset < buffer.length;
    bytesRead += 1
  ) {
    const byte = buffer[offset++];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
    multiplier *= 128;
  }
  return undefined;
}

function isPrintableUtf8(str: string): boolean {
  if (str.length < 2) return false;
  const printableRegex = /^[\s\w\p{L}\p{N}\p{P}\p{S}]+$/u;
  return printableRegex.test(str);
}

function extractPromptFromPayload(
  payload: Buffer,
  depth = 0
): string | undefined {
  if (
    payload.length > MAX_PROMPT_PAYLOAD_BYTES ||
    depth > MAX_PROMPT_PARSE_DEPTH
  ) {
    return undefined;
  }
  let offset = 0;
  while (offset < payload.length) {
    const tagResult = readVarint(payload, offset);
    if (!tagResult || tagResult.value === 0) {
      break;
    }
    offset = tagResult.nextOffset;
    const tag = tagResult.value;
    const wireType = tag & 0x07;
    const fieldNumber = tag >> 3;

    if (wireType === 2) {
      // length-delimited
      const lengthResult = readVarint(payload, offset);
      if (!lengthResult) {
        break;
      }
      offset = lengthResult.nextOffset;
      const len = lengthResult.value;
      if (offset + len > payload.length) {
        break;
      }
      if (len > MAX_PROMPT_FIELD_BYTES) {
        offset += len;
        continue;
      }
      if (fieldNumber === 2) {
        // field 2 is the prompt text
        const str = payload.subarray(offset, offset + len).toString("utf8");
        if (isPrintableUtf8(str)) {
          return str.trim();
        }
      }
      // Recurse into the submessage
      const nested = extractPromptFromPayload(
        payload.subarray(offset, offset + len),
        depth + 1
      );
      if (nested) {
        return nested;
      }
      offset += len;
    } else if (wireType === 0) {
      // varint
      const valueResult = readVarint(payload, offset);
      if (!valueResult) {
        break;
      }
      offset = valueResult.nextOffset;
    } else if (wireType === 1) {
      // 64-bit
      offset += 8;
    } else if (wireType === 5) {
      // 32-bit
      offset += 4;
    } else {
      break;
    }
  }
  return undefined;
}
