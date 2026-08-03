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

import {
  classifySessionInventoryCandidate,
  type SessionInventoryCandidate
} from "./sessionInventory";
import {
  parseAntigravityConversationRows,
  parseCoreHistorySource,
  type AntigravityConversationStepRow,
  type CoreHistoryRecord
} from "./core/history";

const MAX_BINARY_SCAN_BYTES = 512 * 1024;

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

export function readAntigravityConversationMetadataFromInventory(
  antigravityRoot: string,
  candidates: readonly SessionInventoryCandidate[],
  options: { maxConversationFiles?: number } = {}
): AntigravityConversationMetadata[] {
  const conversations = new Map<string, AntigravityConversationMetadata>();
  const classified = candidates.flatMap((candidate) => {
    const role = classifySessionInventoryCandidate(
      "antigravity",
      antigravityRoot,
      candidate.path
    );
    return role ? [{ candidate, role }] : [];
  });

  for (const { candidate, role } of classified) {
    if (role !== "antigravity-history") {
      continue;
    }
    for (const record of parseCoreHistorySource({
      vendor: "antigravity",
      role: "antigravity-history",
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

function readAntigravityConversationMetadataUncached(
  antigravityRoot: string,
  options: { maxConversationFiles?: number }
): AntigravityConversationMetadata[] {
  const conversations = new Map<string, AntigravityConversationMetadata>();

  const historyPath = join(antigravityRoot, "history.jsonl");
  for (const record of parseCoreHistorySource({
    vendor: "antigravity",
    role: "antigravity-history",
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
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    return {};
  }

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
    const rows = [firstRow, latestRow].flatMap(coreConversationStepRow);
    const parsed = parseAntigravityConversationRows({
      logicalName: `/${basename(dbPath)}`,
      mtimeMs: 0,
      rows
    });
    return {
      ...optionalStringProperty("title", parsed?.title),
      ...optionalStringProperty(
        "recentConversation",
        parsed?.recentConversation
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
