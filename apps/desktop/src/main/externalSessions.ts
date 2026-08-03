import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  statSync
} from "node:fs";
import { basename, delimiter, join } from "node:path";

import {
  formatAgentCommandForShell,
  resolveAgentResumeCommand,
  type WorkspaceTarget
} from "@kmux/core";

import type {
  AgentScopeSettings,
  ExternalAgentSessionRef,
  ExternalAgentSessionVendor,
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";
import {
  type AgentStorageRoots,
  classifySessionInventoryCandidate,
  collectSessionInventory,
  isCodexSubagentSessionMetadata,
  parseCoreHistorySource,
  readAntigravityConversationMetadataFromInventory,
  resolveAgentSessionRoots,
  resolveAgentStorageRoots,
  type SessionInventoryCandidate,
  type SessionInventoryLimits,
  type SessionInventoryVendor
} from "@kmux/metadata";
import {
  antigravitySessionIndexPath,
  readAntigravitySessionIndex
} from "./antigravityIntegration";

export interface ExternalSessionIndexerOptions {
  homeDir: string;
  now?: () => Date;
  maxFilesPerVendor?: number;
  env?: NodeJS.ProcessEnv;
  commandAvailability?: (command: string) => boolean;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
  antigravitySessionIndexPath?: string;
  scanLimits?: Partial<SessionInventoryLimits>;
}

export interface ExternalSessionIndexer {
  listExternalAgentSessions():
    | ExternalAgentSessionsSnapshot
    | Promise<ExternalAgentSessionsSnapshot>;
  resolveExternalAgentSession(key: string): ExternalSessionResumeSpec | null;
  close?(): void;
}

export interface SynchronousExternalSessionIndexer extends ExternalSessionIndexer {
  listExternalAgentSessions(): ExternalAgentSessionsSnapshot;
}

export interface ExternalSessionResumeSpec {
  key: string;
  vendor: ExternalAgentSessionVendor;
  agentSessionRef: ExternalAgentSessionRef;
  title: string;
  target: WorkspaceTarget;
  cwd?: string;
  launch: SessionLaunchConfig;
}

interface ExternalSessionRecord {
  key: string;
  vendor: ExternalAgentSessionVendor;
  sessionId: string;
  title: string;
  recentConversation?: string;
  model?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedAtMs: number;
}

type CandidateFile = SessionInventoryCandidate;

interface SessionFileCacheEntry {
  signature: string;
  record: ExternalSessionRecord | null;
}

const DEFAULT_MAX_FILES_PER_VENDOR = 100;
const SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JSONL_SCAN_BYTES = 256 * 1024;
const CODEX_IDENTITY_SCAN_BYTES = 64 * 1024;
const MAX_SESSION_FILE_CACHE_ENTRIES = 512;
const HISTORY_PARSE_CANDIDATE_MULTIPLIER = 4;

export function createExternalSessionIndexer(
  options: ExternalSessionIndexerOptions
): SynchronousExternalSessionIndexer {
  const now = options.now ?? (() => new Date());
  const maxFilesPerVendor =
    options.maxFilesPerVendor ?? DEFAULT_MAX_FILES_PER_VENDOR;
  const scanLimits = options.scanLimits;
  const canRunCommand = createCommandAvailability(options);
  const sessionFileCache = new Map<string, SessionFileCacheEntry>();
  const agentStorageRoots =
    options.agentStorageRoots ??
    resolveAgentStorageRoots({
      homeDir: options.homeDir,
      env: options.env
    });
  const sessionRoots = resolveAgentSessionRoots({
    agentStorageRoots,
    agentSettings: options.agentSettings
  });

  function listRecords(currentNow: Date): {
    records: ExternalSessionRecord[];
    truncated: boolean;
  } {
    const cutoffMs = currentNow.getTime() - SESSION_LOOKBACK_MS;
    const codexInventory = collectVendorCandidates(
      "codex",
      sessionRoots.codex,
      maxFilesPerVendor * HISTORY_PARSE_CANDIDATE_MULTIPLIER,
      scanLimits
    );
    const claudeInventory = collectVendorCandidates(
      "claude",
      sessionRoots.claude,
      maxFilesPerVendor * HISTORY_PARSE_CANDIDATE_MULTIPLIER,
      scanLimits
    );
    const antigravityInventory = collectVendorCandidates(
      "antigravity",
      sessionRoots.antigravity,
      maxFilesPerVendor * HISTORY_PARSE_CANDIDATE_MULTIPLIER,
      scanLimits
    );
    const antigravityIndexPath =
      options.agentSettings?.antigravity?.sessionRoot === undefined
        ? resolveAntigravityIndexPath(options)
        : undefined;
    const records = dedupeLatestSessionRecords(
      [
        ...listCodexSessions(
          codexInventory.candidates,
          maxFilesPerVendor,
          sessionFileCache
        ),
        ...listClaudeSessions(
          claudeInventory.candidates,
          maxFilesPerVendor,
          sessionFileCache
        ),
        ...sessionRoots.antigravity.flatMap((root, index) =>
          listAntigravitySessions(
            root,
            index === 0 ? antigravityIndexPath : undefined,
            maxFilesPerVendor,
            antigravityInventory.candidates
          )
        )
      ].filter((record) => record.updatedAtMs >= cutoffMs)
    );
    records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    return {
      records,
      truncated:
        codexInventory.truncated ||
        claudeInventory.truncated ||
        antigravityInventory.truncated
    };
  }

  let cachedRecords: ExternalSessionRecord[] | null = null;
  const refreshRecords = (): ExternalSessionRecord[] => {
    cachedRecords = listRecords(now()).records;
    return cachedRecords;
  };

  return {
    listExternalAgentSessions() {
      const currentNow = now();
      const result = listRecords(currentNow);
      cachedRecords = result.records;
      return {
        sessions: cachedRecords.map((record) =>
          toViewModel(
            record,
            currentNow,
            canResumeRecord(record, canRunCommand, options.agentSettings),
            options.agentSettings
          )
        ),
        updatedAt: currentNow.toISOString(),
        truncated: result.truncated
      };
    },
    resolveExternalAgentSession(key) {
      const record = (cachedRecords ?? refreshRecords()).find(
        (entry) => entry.key === key
      );
      return record &&
        canResumeRecord(record, canRunCommand, options.agentSettings)
        ? toResumeSpec(record, options.agentSettings)
        : null;
    }
  };
}

function resolveAntigravityIndexPath(
  options: ExternalSessionIndexerOptions
): string {
  return (
    options.antigravitySessionIndexPath ??
    antigravitySessionIndexPath(options.homeDir, options.env)
  );
}

function dedupeLatestSessionRecords(
  records: ExternalSessionRecord[]
): ExternalSessionRecord[] {
  const latestByKey = new Map<string, ExternalSessionRecord>();
  for (const record of records) {
    const previous = latestByKey.get(record.key);
    if (!previous || record.updatedAtMs > previous.updatedAtMs) {
      latestByKey.set(record.key, record);
    }
  }
  return Array.from(latestByKey.values());
}

function collectVendorCandidates(
  vendor: SessionInventoryVendor,
  roots: readonly string[],
  parsingBudget: number,
  limits: Partial<SessionInventoryLimits> | undefined
): {
  candidates: CandidateFile[];
  truncated: boolean;
} {
  const inventory = collectSessionInventory(roots, limits);
  const candidateByPath = new Map(
    inventory.candidates.map(
      (candidate) => [candidate.path, candidate] as const
    )
  );
  const candidates = inventory.candidates
    .filter((candidate) => {
      const roles = roots.flatMap((root) => {
        const role = classifySessionInventoryCandidate(
          vendor,
          root,
          candidate.path
        );
        return role ? [role] : [];
      });
      if (vendor === "codex") {
        return roles.includes("codex-session");
      }
      if (vendor === "claude") {
        return roles.includes("claude-session");
      }
      return roles.some(
        (role) =>
          role === "antigravity-history" ||
          role === "antigravity-conversation" ||
          role === "antigravity-project-index"
      );
    })
    .map((candidate) =>
      vendor === "antigravity" && candidate.path.endsWith(".db")
        ? {
            ...candidate,
            mtimeMs: Math.max(
              candidate.mtimeMs,
              candidateByPath.get(`${candidate.path}-wal`)?.mtimeMs ?? 0
            )
          }
        : candidate
    )
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
    );
  const parsingTruncated = candidates.length > parsingBudget;
  if (parsingTruncated) {
    candidates.length = parsingBudget;
  }
  return {
    candidates,
    truncated: inventory.truncated || parsingTruncated
  };
}

function listAntigravitySessions(
  antigravityRoot: string,
  indexPath: string | undefined,
  maxFiles: number,
  candidates: readonly CandidateFile[]
): ExternalSessionRecord[] {
  const merged = new Map<
    string,
    {
      conversationId: string;
      cwd?: string;
      title?: string;
      recentConversation?: string;
      createdAt?: string;
      updatedAt?: string;
      mtimeMs: number;
    }
  >();

  const upsert = (record: {
    conversationId: string;
    cwd?: string;
    title?: string;
    recentConversation?: string;
    createdAt?: string;
    updatedAt?: string;
    mtimeMs: number;
  }) => {
    const previous = merged.get(record.conversationId);
    if (!previous) {
      merged.set(record.conversationId, record);
      return;
    }
    merged.set(record.conversationId, {
      conversationId: record.conversationId,
      cwd: record.cwd ?? previous.cwd,
      title: record.title ?? previous.title,
      recentConversation:
        record.recentConversation ?? previous.recentConversation,
      createdAt: earliestIsoTimestamp(previous.createdAt, record.createdAt),
      updatedAt: latestIsoTimestamp(previous.updatedAt, record.updatedAt),
      mtimeMs: Math.max(previous.mtimeMs, record.mtimeMs)
    });
  };

  for (const session of readAntigravityConversationMetadataFromInventory(
    antigravityRoot,
    candidates,
    {
      maxConversationFiles: maxFiles
    }
  )) {
    upsert({
      conversationId: session.conversationId,
      cwd: session.workspace,
      title: session.title,
      recentConversation: session.recentConversation,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      mtimeMs: session.mtimeMs
    });
  }
  for (const session of indexPath
    ? readAntigravitySessionIndex(indexPath).sessions
    : []) {
    const updatedAtMs = Date.parse(session.updatedAt);
    upsert({
      conversationId: session.conversationId,
      cwd: session.cwd ?? session.workspacePaths?.[0],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      mtimeMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0
    });
  }

  return Array.from(merged.values()).map((session) =>
    buildRecord({
      vendor: "antigravity",
      sessionId: session.conversationId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      mtimeMs: session.mtimeMs,
      title: session.title,
      recentConversation: session.recentConversation
    })
  );
}

function listCodexSessions(
  candidates: readonly CandidateFile[],
  maxSessions: number,
  cache: Map<string, SessionFileCacheEntry>
): ExternalSessionRecord[] {
  const recordsByKey = new Map<string, ExternalSessionRecord>();

  for (const candidate of candidates) {
    const cached = readCachedSessionRecord(cache, candidate);
    const record = cached
      ? cached.record
      : parseCodexSessionCandidate(candidate);
    if (!cached) {
      cacheSessionRecord(cache, candidate, record);
    }
    if (!record) {
      continue;
    }
    const previous = recordsByKey.get(record.key);
    if (!previous || record.updatedAtMs > previous.updatedAtMs) {
      recordsByKey.set(record.key, record);
    }
    if (recordsByKey.size >= maxSessions) {
      break;
    }
  }

  return Array.from(recordsByKey.values());
}

function parseCodexSessionCandidate(
  candidate: CandidateFile
): ExternalSessionRecord | null {
  const identity = firstCodexSessionMetadata(candidate.path);
  if (identity && isCodexSubagentSessionMetadata(identity)) {
    return null;
  }
  return (
    parseCoreHistorySource({
      vendor: "codex",
      role: "codex-session",
      logicalName: basename(candidate.path),
      mtimeMs: candidate.mtimeMs,
      records: parseJsonlEdges(candidate.path)
    })[0] ?? null
  );
}

function firstCodexSessionMetadata(
  sessionPath: string
): Record<string, unknown> | null {
  const records = parseJsonlLines(
    readFilePrefix(sessionPath, CODEX_IDENTITY_SCAN_BYTES)
  );
  for (const record of records) {
    const object = asObject(record);
    if (object?.type === "session_meta") {
      return asObject(object.payload);
    }
  }
  return null;
}

function listClaudeSessions(
  candidates: readonly CandidateFile[],
  maxFiles: number,
  cache: Map<string, SessionFileCacheEntry>
): ExternalSessionRecord[] {
  return candidates.slice(0, maxFiles).flatMap((candidate) => {
    const cached = readCachedSessionRecord(cache, candidate);
    if (cached) {
      return cached.record ? [cached.record] : [];
    }
    const record = parseCoreHistorySource({
      vendor: "claude",
      role: "claude-session",
      logicalName: basename(candidate.path),
      mtimeMs: candidate.mtimeMs,
      records: parseJsonlEdges(candidate.path)
    })[0];
    if (!record) return [];
    cacheSessionRecord(cache, candidate, record);
    return [record];
  });
}

function buildRecord(input: {
  vendor: ExternalAgentSessionVendor;
  sessionId: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  recentConversation?: string;
  model?: string;
  mtimeMs: number;
}): ExternalSessionRecord {
  const title =
    input.title && meaningfulSessionTitle(input.title, input.sessionId)
      ? input.title
      : `${vendorTitleLabelFor(input.vendor)} session`;
  const updatedAtMs = input.updatedAt
    ? Date.parse(input.updatedAt)
    : input.mtimeMs;
  return {
    key: `${input.vendor}:${input.sessionId}`,
    vendor: input.vendor,
    sessionId: input.sessionId,
    title,
    recentConversation: input.recentConversation,
    model: input.model,
    cwd: input.cwd,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? new Date(input.mtimeMs).toISOString(),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : input.mtimeMs
  };
}

function vendorTitleLabelFor(vendor: ExternalAgentSessionVendor): string {
  switch (vendor) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "antigravity":
      return "Antigravity";
  }
}

function meaningfulSessionTitle(title: string, sessionId: string): boolean {
  const trimmed = title.trim();
  if (
    !trimmed ||
    trimmed.includes(sessionId) ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<system-reminder")
  ) {
    return false;
  }
  return !(/^[0-9a-f_-]+$/iu.test(trimmed) && trimmed.length >= 24);
}

function toViewModel(
  record: ExternalSessionRecord,
  now: Date,
  canResume: boolean,
  agentSettings: AgentScopeSettings | undefined
): ExternalAgentSessionVm {
  return {
    key: record.key,
    target: { kind: "local" },
    vendor: record.vendor,
    vendorLabel: vendorLabelFor(record.vendor),
    title: record.title,
    recentConversation: record.recentConversation,
    model: record.model,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    relativeTimeLabel: formatRelativeTime(now, record.updatedAtMs),
    canResume,
    resumeCommandPreview: buildResumeCommandPreview(record, agentSettings)
  };
}

function toResumeSpec(
  record: ExternalSessionRecord,
  agentSettings: AgentScopeSettings | undefined
): ExternalSessionResumeSpec {
  const launch = buildResumeLaunch(record, agentSettings);
  return {
    key: record.key,
    vendor: record.vendor,
    agentSessionRef: {
      vendor: record.vendor,
      externalKey: record.key,
      sessionId: record.sessionId
    },
    title: record.title,
    target: { kind: "local" },
    cwd: record.cwd,
    launch
  };
}

function buildResumeLaunch(
  record: ExternalSessionRecord,
  agentSettings: AgentScopeSettings | undefined
): SessionLaunchConfig {
  const command = resumeCommandParts(record, agentSettings);
  return {
    cwd: record.cwd,
    initialInput: `${formatAgentCommandForShell(command)}\r`,
    title: record.title
  };
}

function buildResumeCommandPreview(
  record: ExternalSessionRecord,
  agentSettings: AgentScopeSettings | undefined
): string {
  return formatAgentCommandForShell(resumeCommandParts(record, agentSettings));
}

function resumeCommandParts(
  record: ExternalSessionRecord,
  agentSettings: AgentScopeSettings | undefined
): string[] {
  return resolveAgentResumeCommand(
    agentSettings,
    record.vendor,
    record.sessionId
  );
}

function canResumeRecord(
  record: ExternalSessionRecord,
  canRunCommand: (command: string) => boolean,
  agentSettings: AgentScopeSettings | undefined
): boolean {
  return canRunCommand(resumeCommandParts(record, agentSettings)[0]);
}

function createCommandAvailability(
  options: ExternalSessionIndexerOptions
): (command: string) => boolean {
  if (options.commandAvailability) {
    return options.commandAvailability;
  }
  if (!options.env) {
    return () => true;
  }
  const cache = new Map<string, boolean>();
  return (command) => {
    const cached = cache.get(command);
    if (cached !== undefined) {
      return cached;
    }
    const available = commandExistsOnPath(command, options.env?.PATH);
    cache.set(command, available);
    return available;
  };
}

function commandExistsOnPath(
  command: string,
  pathValue: string | undefined
): boolean {
  if (command.includes("/")) {
    return isExecutableFile(command);
  }
  if (!pathValue) {
    return false;
  }
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => isExecutableFile(join(directory, command)));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function vendorLabelFor(
  vendor: ExternalAgentSessionVendor
): ExternalAgentSessionVm["vendorLabel"] {
  switch (vendor) {
    case "codex":
      return "CODEX";
    case "claude":
      return "CLAUDE";
    case "antigravity":
      return "AGY";
  }
}

function readCachedSessionRecord(
  cache: Map<string, SessionFileCacheEntry>,
  candidate: CandidateFile
): SessionFileCacheEntry | undefined {
  const cached = cache.get(candidate.path);
  if (!cached || cached.signature !== sessionFileSignature(candidate)) {
    return undefined;
  }
  cache.delete(candidate.path);
  cache.set(candidate.path, cached);
  return cached;
}

function cacheSessionRecord(
  cache: Map<string, SessionFileCacheEntry>,
  candidate: CandidateFile,
  record: ExternalSessionRecord | null
): void {
  cache.delete(candidate.path);
  cache.set(candidate.path, {
    signature: sessionFileSignature(candidate),
    record
  });
  if (cache.size > MAX_SESSION_FILE_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
}

function sessionFileSignature(candidate: CandidateFile): string {
  return `${candidate.mtimeMs}:${candidate.size}`;
}

function parseJsonlEdges(path: string): unknown[] {
  const prefix = readFilePrefix(path);
  const suffix = readFileSuffix(path);
  return parseJsonlLines(prefix === suffix ? prefix : `${prefix}\n${suffix}`);
}

function parseJsonlLines(contents: string): unknown[] {
  return contents.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = parseJson(trimmed);
    return parsed === null ? [] : [parsed];
  });
}

function readFilePrefix(path: string, maxBytes = MAX_JSONL_SCAN_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
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

function readFileSuffix(path: string): string {
  let fd: number | null = null;
  try {
    const stats = statSync(path);
    const readLength = Math.min(stats.size, MAX_JSONL_SCAN_BYTES);
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(readLength);
    const bytesRead = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      Math.max(0, stats.size - readLength)
    );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function parseJson(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  return Date.parse(right) > Date.parse(left) ? right : left;
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
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function formatRelativeTime(now: Date, updatedAtMs: number): string {
  const deltaMs = Math.max(0, now.getTime() - updatedAtMs);
  const second = 1000;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) {
    return `${Math.floor(deltaMs / second)}s`;
  }
  if (deltaMs < hour) {
    return `${Math.floor(deltaMs / minute)}m`;
  }
  if (deltaMs < day) {
    return `${Math.floor(deltaMs / hour)}h`;
  }
  return `${Math.floor(deltaMs / day)}d`;
}
