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

import type { SessionInventoryCandidate } from "@kmux/metadata";
import type { CoreHistoryRecord } from "@kmux/metadata";
import { classifyAntigravityMetadataPath } from "./inventory";
import {
  parseAntigravityConversationRows,
  parseAntigravityHistoryRecords,
  type AntigravityConversationStepRow
} from "./history";

const MAX_BINARY_SCAN_BYTES = 512 * 1024;
const MAX_SHARED_TEXT_READ_BYTES = 256 * 1024;
const MAX_SHARED_PROJECT_INDEX_BYTES = 1024 * 1024;
const ANTIGRAVITY_CONVERSATION_QUERY_ID = "antigravity.conversation.steps.v1";

const nodeRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json")
);

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

export interface AntigravitySharedInventoryReader {
  readText(request: {
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<string>;
  query?(request: {
    path: string;
    queryPlanId: string;
    maxRows: number;
  }): Promise<{
    queryPlanId: string;
    rows: AntigravityConversationStepRow[];
  }>;
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

export function readAntigravityConversationMetadataFromInventory(
  antigravityRoot: string,
  candidates: readonly SessionInventoryCandidate[],
  options: { maxConversationFiles?: number } = {}
): AntigravityConversationMetadata[] {
  const conversations = new Map<string, AntigravityConversationMetadata>();
  const classified = candidates.flatMap((candidate) => {
    const role = classifyAntigravityMetadataPath(
      [antigravityRoot],
      candidate.path
    );
    return role ? [{ candidate, role }] : [];
  });

  for (const { candidate, role } of classified) {
    if (role !== "antigravity-history") {
      continue;
    }
    for (const record of parseAntigravityHistoryRecords({
      logicalName: candidate.path,
      mtimeMs: candidate.mtimeMs,
      records: parseJsonlFile(candidate.path)
    })) {
      upsertConversation(
        conversations,
        coreHistoryToAntigravityConversation(record)
      );
    }
  }

  const projectIndex = classified.find(
    ({ role }) => role === "antigravity-project-index"
  )?.candidate;
  const projectWorkspaces = projectIndex
    ? new Map(
        Array.from(readStringMap(projectIndex.path).entries()).map(
          ([workspace, projectId]) => [projectId, workspace] as const
        )
      )
    : new Map<string, string>();
  const conversationCandidates = classified
    .filter(({ role }) => role === "antigravity-conversation")
    .map(({ candidate }) => candidate)
    .map((candidate) => ({
      ...candidate,
      mtimeMs: sqliteEffectiveMtimeMs(candidate.path, candidate.mtimeMs)
    }))
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
    )
    .slice(0, options.maxConversationFiles);

  for (const candidate of conversationCandidates) {
    const conversationId = basename(candidate.path, ".db");
    if (!isUuidLike(conversationId)) {
      continue;
    }
    const effectiveMtimeMs = candidate.mtimeMs;
    const details = extractConversationDetailsFromDb(candidate.path);
    let createdAt: string | undefined;
    try {
      createdAt = new Date(statSync(candidate.path).birthtimeMs).toISOString();
    } catch {
      // The database can disappear between inventory and parsing.
    }
    upsertConversation(conversations, {
      conversationId,
      ...optionalStringProperty(
        "workspace",
        inferAntigravityConversationWorkspace(candidate.path, projectWorkspaces)
      ),
      ...(details.title ? { title: details.title } : {}),
      ...(details.recentConversation
        ? { recentConversation: details.recentConversation }
        : {}),
      ...(createdAt ? { createdAt } : {}),
      updatedAt: new Date(effectiveMtimeMs).toISOString(),
      mtimeMs: effectiveMtimeMs
    });
  }

  return Array.from(conversations.values()).sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.conversationId.localeCompare(right.conversationId)
  );
}

export async function readAntigravityConversationMetadataFromSharedInventory(
  antigravityRoot: string,
  candidates: readonly SessionInventoryCandidate[],
  reader: AntigravitySharedInventoryReader,
  options: {
    maxConversationFiles?: number;
    includeConversationDetails?: boolean;
  } = {}
): Promise<AntigravityConversationMetadata[]> {
  const conversations = new Map<string, AntigravityConversationMetadata>();
  const candidateByPath = new Map(
    candidates.map((candidate) => [candidate.path, candidate] as const)
  );
  const classified = candidates.flatMap((candidate) => {
    const role = classifyAntigravityMetadataPath(
      [antigravityRoot],
      candidate.path
    );
    return role ? [{ candidate, role }] : [];
  });

  for (const { candidate, role } of classified) {
    if (role !== "antigravity-history") continue;
    const records = parseJsonlText(
      await readSharedJsonlEdges(reader, candidate)
    );
    for (const record of parseAntigravityHistoryRecords({
      logicalName: candidate.path,
      mtimeMs: candidate.mtimeMs,
      records
    })) {
      upsertConversation(
        conversations,
        coreHistoryToAntigravityConversation(record)
      );
    }
  }

  const projectIndex = classified.find(
    ({ role }) => role === "antigravity-project-index"
  )?.candidate;
  const projectWorkspaces = projectIndex
    ? new Map(
        Array.from(
          readStringMapText(
            projectIndex.size <= MAX_SHARED_PROJECT_INDEX_BYTES
              ? await readSharedTextPrefix(
                  reader,
                  projectIndex.path,
                  projectIndex.size,
                  projectIndex.size
                )
              : ""
          ).entries()
        ).map(([workspace, projectId]) => [projectId, workspace] as const)
      )
    : new Map<string, string>();
  const conversationCandidates = classified
    .filter(({ role }) => role === "antigravity-conversation")
    .map(({ candidate }) => ({
      ...candidate,
      mtimeMs: Math.max(
        candidate.mtimeMs,
        candidateByPath.get(`${candidate.path}-wal`)?.mtimeMs ?? 0
      )
    }))
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
    )
    .slice(0, options.maxConversationFiles);

  for (const candidate of conversationCandidates) {
    const conversationId = basename(candidate.path, ".db");
    if (!isUuidLike(conversationId)) continue;
    const searchable = await readSharedTextPrefix(
      reader,
      candidate.path,
      candidate.size,
      MAX_BINARY_SCAN_BYTES
    );
    const workspace = inferWorkspaceFromText(searchable, projectWorkspaces);
    const details =
      options.includeConversationDetails === false || !reader.query
        ? {}
        : await readSharedConversationDetails(reader, candidate);
    upsertConversation(conversations, {
      conversationId,
      ...optionalStringProperty("workspace", workspace),
      ...optionalStringProperty("title", details.title),
      ...optionalStringProperty(
        "recentConversation",
        details.recentConversation
      ),
      ...(candidate.birthtimeMs === undefined
        ? {}
        : { createdAt: new Date(candidate.birthtimeMs).toISOString() }),
      updatedAt: new Date(candidate.mtimeMs).toISOString(),
      mtimeMs: candidate.mtimeMs
    });
  }

  return Array.from(conversations.values()).sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.conversationId.localeCompare(right.conversationId)
  );
}

function readAntigravityConversationMetadataUncached(
  antigravityRoot: string,
  options: { maxConversationFiles?: number }
): AntigravityConversationMetadata[] {
  const conversations = new Map<string, AntigravityConversationMetadata>();

  const historyPath = join(antigravityRoot, "history.jsonl");
  for (const record of parseAntigravityHistoryRecords({
    logicalName: historyPath,
    mtimeMs: fileMtimeMs(historyPath),
    records: parseJsonlFile(historyPath)
  })) {
    upsertConversation(
      conversations,
      coreHistoryToAntigravityConversation(record)
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

function coreHistoryToAntigravityConversation(
  record: CoreHistoryRecord
): AntigravityConversationMetadata {
  return {
    conversationId: record.sessionId,
    ...(record.cwd ? { workspace: record.cwd } : {}),
    ...(record.title ? { title: record.title } : {}),
    ...(record.recentConversation
      ? { recentConversation: record.recentConversation }
      : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    mtimeMs: record.updatedAtMs
  };
}

function fileMtimeMs(filePath: string): number {
  try {
    return Number(statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
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

function readStringMapText(text: string): Map<string, string> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return new Map();
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

function parseJsonlText(text: string): unknown[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return [];
    }
  });
}

async function readSharedJsonlEdges(
  reader: AntigravitySharedInventoryReader,
  candidate: SessionInventoryCandidate
): Promise<string> {
  const prefix = await readSharedText(reader, {
    path: candidate.path,
    offset: 0,
    maxBytes: Math.max(1, Math.min(candidate.size, MAX_SHARED_TEXT_READ_BYTES))
  });
  const suffixOffset = Math.max(0, candidate.size - MAX_SHARED_TEXT_READ_BYTES);
  if (suffixOffset === 0) return prefix;
  const suffix = await readSharedText(reader, {
    path: candidate.path,
    offset: suffixOffset,
    maxBytes: Math.max(1, candidate.size - suffixOffset)
  });
  return `${prefix}\n${suffix}`;
}

async function readSharedTextPrefix(
  reader: AntigravitySharedInventoryReader,
  path: string,
  size: number,
  maximumBytes: number
): Promise<string> {
  const limit = Math.min(size, maximumBytes);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < limit) {
    const maxBytes = Math.min(MAX_SHARED_TEXT_READ_BYTES, limit - offset);
    const chunk = await readSharedText(reader, { path, offset, maxBytes });
    if (!chunk) break;
    chunks.push(chunk);
    offset += Buffer.byteLength(chunk, "utf8");
  }
  return chunks.join("");
}

async function readSharedText(
  reader: AntigravitySharedInventoryReader,
  request: { path: string; offset: number; maxBytes: number }
): Promise<string> {
  try {
    return await reader.readText(request);
  } catch {
    return "";
  }
}

function inferWorkspaceFromText(
  searchable: string,
  projectWorkspaces: ReadonlyMap<string, string>
): string | undefined {
  for (const [projectId, workspace] of projectWorkspaces) {
    const normalizedWorkspace = normalizePathValue(workspace);
    if (normalizedWorkspace && searchable.includes(projectId)) {
      return normalizedWorkspace;
    }
  }
  return undefined;
}

async function readSharedConversationDetails(
  reader: AntigravitySharedInventoryReader,
  candidate: SessionInventoryCandidate
): Promise<{ title?: string; recentConversation?: string }> {
  try {
    const result = await reader.query!({
      path: candidate.path,
      queryPlanId: ANTIGRAVITY_CONVERSATION_QUERY_ID,
      maxRows: 2
    });
    if (result.queryPlanId !== ANTIGRAVITY_CONVERSATION_QUERY_ID) return {};
    const parsed = parseAntigravityConversationRows({
      logicalName: candidate.path,
      mtimeMs: candidate.mtimeMs,
      rows: result.rows
    });
    return {
      ...optionalStringProperty("title", parsed?.title),
      ...optionalStringProperty(
        "recentConversation",
        parsed?.recentConversation
      )
    };
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePathValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.replace(/\/+$/u, "") : undefined;
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
  const rows = queryAntigravityConversationSteps(dbPath, 2);
  const parsed = parseAntigravityConversationRows({
    logicalName: `/${basename(dbPath)}`,
    mtimeMs: 0,
    rows
  });
  return {
    ...optionalStringProperty("title", parsed?.title),
    ...optionalStringProperty("recentConversation", parsed?.recentConversation)
  };
}

export function queryAntigravityConversationSteps(
  dbPath: string,
  maxRows: number
): AntigravityConversationStepRow[] {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync || !Number.isSafeInteger(maxRows) || maxRows < 1) return [];

  let db: DatabaseSyncInstance | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const firstRow = db
      .prepare(
        "SELECT idx, step_type, CASE WHEN length(step_payload) <= 131072 THEN step_payload END AS step_payload FROM steps WHERE idx = 0 AND step_type = 14 LIMIT 1"
      )
      .get() as unknown;
    const latestRow = db
      .prepare(
        "SELECT idx, step_type, CASE WHEN length(step_payload) <= 131072 THEN step_payload END AS step_payload FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1"
      )
      .get() as unknown;
    return [firstRow, latestRow]
      .flatMap(coreConversationStepRow)
      .slice(0, Math.min(maxRows, 2));
  } catch {
    // Database sync might fail if the file is locked, busy, or corrupted
  } finally {
    try {
      db?.close();
    } catch {
      // Closing is best-effort because this reader is optional metadata.
    }
  }
  return [];
}

function coreConversationStepRow(
  row: unknown
): AntigravityConversationStepRow[] {
  if (!isRecord(row)) return [];
  const index = row.idx;
  const stepType = row.step_type;
  const payload = row.step_payload;
  if (
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    !Number.isSafeInteger(stepType) ||
    (stepType as number) < 0 ||
    (payload !== null && !(payload instanceof Uint8Array))
  ) {
    return [];
  }
  return [
    {
      index: index as number,
      stepType: stepType as number,
      payloadBase64:
        payload instanceof Uint8Array
          ? Buffer.from(payload).toString("base64")
          : ""
    }
  ];
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
