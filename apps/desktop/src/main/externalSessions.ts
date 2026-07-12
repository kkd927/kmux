import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

import type {
  ExternalAgentSessionRef,
  ExternalAgentSessionVendor,
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";
import {
  type AgentStorageRoots,
  isCodexSubagentSessionMetadata,
  readAntigravityConversationMetadataFromRoot,
  resolveAgentStorageRoots
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
  antigravitySessionIndexPath?: string;
}

export interface ExternalSessionResumeSpec {
  key: string;
  vendor: ExternalAgentSessionVendor;
  agentSessionRef: ExternalAgentSessionRef;
  title: string;
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

interface CandidateFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface SessionFileCacheEntry {
  signature: string;
  record: ExternalSessionRecord | null;
}

const DEFAULT_MAX_FILES_PER_VENDOR = 100;
const SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 96;
const MAX_CONVERSATION_PREVIEW_LENGTH = 220;
const MAX_JSONL_SCAN_BYTES = 256 * 1024;
const CODEX_IDENTITY_SCAN_BYTES = 64 * 1024;
const MAX_SESSION_FILE_CACHE_ENTRIES = 512;

export function createExternalSessionIndexer(
  options: ExternalSessionIndexerOptions
): {
  listExternalAgentSessions(): ExternalAgentSessionsSnapshot;
  resolveExternalAgentSession(key: string): ExternalSessionResumeSpec | null;
} {
  const now = options.now ?? (() => new Date());
  const maxFilesPerVendor =
    options.maxFilesPerVendor ?? DEFAULT_MAX_FILES_PER_VENDOR;
  const canRunCommand = createCommandAvailability(options);
  const sessionFileCache = new Map<string, SessionFileCacheEntry>();
  const agentStorageRoots =
    options.agentStorageRoots ??
    resolveAgentStorageRoots({
      homeDir: options.homeDir,
      env: options.env
    });

  function listRecords(currentNow: Date): ExternalSessionRecord[] {
    const cutoffMs = currentNow.getTime() - SESSION_LOOKBACK_MS;
    const records = dedupeLatestSessionRecords(
      [
        ...listCodexSessions(
          agentStorageRoots.codex.sessionsDir,
          maxFilesPerVendor,
          sessionFileCache
        ),
        ...listClaudeSessions(
          agentStorageRoots.claude.projectsDir,
          maxFilesPerVendor,
          sessionFileCache
        ),
        ...listAntigravitySessions(
          agentStorageRoots.antigravity.root,
          resolveAntigravityIndexPath(options),
          maxFilesPerVendor
        )
      ].filter((record) => record.updatedAtMs >= cutoffMs)
    );
    records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    return records;
  }

  return {
    listExternalAgentSessions() {
      const currentNow = now();
      return {
        sessions: listRecords(currentNow).map((record) =>
          toViewModel(
            record,
            currentNow,
            canResumeRecord(record, canRunCommand)
          )
        ),
        updatedAt: currentNow.toISOString()
      };
    },
    resolveExternalAgentSession(key) {
      const record = listRecords(now()).find((entry) => entry.key === key);
      return record && canResumeRecord(record, canRunCommand)
        ? toResumeSpec(record)
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

function listAntigravitySessions(
  antigravityRoot: string,
  indexPath: string,
  maxFiles: number
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

  for (const session of readAntigravityConversationMetadataFromRoot(
    antigravityRoot,
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
  for (const session of readAntigravitySessionIndex(indexPath).sessions) {
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
  root: string,
  maxSessions: number,
  cache: Map<string, SessionFileCacheEntry>
): ExternalSessionRecord[] {
  const recordsByKey = new Map<string, ExternalSessionRecord>();
  const candidates = collectCandidateFiles(
    root,
    (path) => basename(path).startsWith("rollout-") && path.endsWith(".jsonl")
  );

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
  const records = parseJsonlEdges(candidate.path);
  let sawSessionMeta = false;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let metadataTitle: string | undefined;
  let messageTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;

  for (const record of records) {
    const object = asObject(record);
    const payload = asObject(object?.payload);
    const timestamp = pickFirstString(object, ["timestamp"]);
    if (timestamp) {
      updatedAt = maxIsoTimestamp(updatedAt, timestamp);
    }
    if (object?.type === "session_meta" && payload && !sawSessionMeta) {
      sawSessionMeta = true;
      if (isCodexSubagentSessionMetadata(payload)) {
        return null;
      }
      sessionId = pickFirstString(payload, ["id", "session_id", "sessionId"]);
      cwd = pickFirstString(payload, ["cwd"]);
      createdAt =
        pickFirstString(payload, ["timestamp", "createdAt", "startTime"]) ??
        timestamp;
      updatedAt =
        pickFirstString(payload, ["timestamp", "updatedAt", "lastUpdated"]) ??
        updatedAt;
    }
    if (payload?.type === "thread_name_updated") {
      metadataTitle =
        sanitizeTitle(
          pickFirstString(payload, ["thread_name", "threadName", "name"])
        ) ?? metadataTitle;
    }
    if (payload?.type === "user_message") {
      messageTitle ??= codexUserPromptTitle(payload.message);
    }
    if (
      object?.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      messageTitle ??= codexUserPromptTitle(payload.content);
    }
    recentConversation =
      codexConversationPreview(object, payload) ?? recentConversation;
    model = codexModelFromRecord(object, payload) ?? model;
  }

  if (!sessionId) {
    return null;
  }
  return buildRecord({
    vendor: "codex",
    sessionId,
    cwd,
    createdAt,
    updatedAt: recentJsonlActivityTimestamp(updatedAt, candidate.mtimeMs),
    title: metadataTitle ?? messageTitle,
    recentConversation,
    model,
    mtimeMs: candidate.mtimeMs
  });
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
  root: string,
  maxFiles: number,
  cache: Map<string, SessionFileCacheEntry>
): ExternalSessionRecord[] {
  return collectCandidateFiles(
    root,
    (path) => path.endsWith(".jsonl") && dirname(dirname(path)) === root
  )
    .slice(0, maxFiles)
    .flatMap((candidate) => {
      const cached = readCachedSessionRecord(cache, candidate);
      if (cached) {
        return cached.record ? [cached.record] : [];
      }
      const records = parseJsonlEdges(candidate.path);
      let sessionId: string | undefined;
      let cwd: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;
      let metadataTitle: string | undefined;
      let promptTitle: string | undefined;
      let recentConversation: string | undefined;
      let model: string | undefined;

      for (const record of records) {
        const object = asObject(record);
        if (!object) {
          continue;
        }
        sessionId ??= pickFirstString(object, [
          "sessionId",
          "session_id",
          "id"
        ]);
        cwd ??= pickFirstString(object, ["cwd", "projectRoot"]);
        const timestamp = pickFirstString(object, [
          "timestamp",
          "createdAt",
          "updatedAt"
        ]);
        if (timestamp) {
          createdAt ??= timestamp;
          updatedAt = maxIsoTimestamp(updatedAt, timestamp);
        }
        metadataTitle = claudeSessionMetadataTitle(object) ?? metadataTitle;
        const type = pickFirstString(object, ["type", "role"]);
        if (type === "user" || type === "human") {
          promptTitle ??= claudeUserPromptTitle(object);
        }
        recentConversation =
          claudeConversationPreview(object) ?? recentConversation;
        model = claudeModelFromRecord(object) ?? model;
      }

      if (!sessionId) {
        sessionId = basename(candidate.path, ".jsonl");
      }
      const record = buildRecord({
        vendor: "claude",
        sessionId,
        cwd,
        createdAt,
        updatedAt: recentJsonlActivityTimestamp(updatedAt, candidate.mtimeMs),
        title: metadataTitle ?? promptTitle,
        recentConversation,
        model,
        mtimeMs: candidate.mtimeMs
      });
      cacheSessionRecord(cache, candidate, record);
      return [record];
    });
}

function codexUserPromptTitle(value: unknown): string | undefined {
  return sanitizeTitle(extractCodexPromptText(value));
}

function codexConversationPreview(
  object: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | undefined {
  if (object?.type === "event_msg") {
    if (payload?.type === "user_message" || payload?.type === "agent_message") {
      return sanitizeConversationPreview(
        extractCodexPromptText(payload.message)
      );
    }
    return undefined;
  }
  if (
    object?.type === "response_item" &&
    payload?.type === "message" &&
    (payload.role === "user" || payload.role === "assistant")
  ) {
    return sanitizeConversationPreview(extractCodexPromptText(payload.content));
  }
  return undefined;
}

function codexModelFromRecord(
  object: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | undefined {
  if (object?.type !== "turn_context" && payload?.type !== "token_count") {
    return undefined;
  }
  return (
    pickFirstString(payload, ["model", "model_name", "modelName"]) ??
    pickFirstString(asObject(payload?.metadata), ["model"]) ??
    pickFirstString(asObject(payload?.info), ["model"])
  );
}

function extractCodexPromptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return cleanCodexPromptText(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractCodexPromptText).filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const type = pickFirstString(object, ["type"]);
  if (type === "input_text" || type === "text") {
    return extractCodexPromptText(object.text);
  }
  return extractCodexPromptText(
    object.content ?? object.text ?? object.message
  );
}

function cleanCodexPromptText(value: string): string | undefined {
  if (isCodexInjectedInstructionsText(value)) {
    return undefined;
  }
  const cleaned = value
    .replace(
      /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
      "\n"
    )
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "\n")
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, "\n")
    .replace(/<skill>[\s\S]*?<\/skill>/gi, "\n")
    .replace(
      /<recommended_plugins(?:\s[^>]*)?>[\s\S]*?<\/recommended_plugins>/gi,
      "\n"
    )
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "\n")
    .trim();
  if (isCodexInjectedInstructionsText(cleaned)) {
    return undefined;
  }
  return cleaned || undefined;
}

function isCodexInjectedInstructionsText(value: string): boolean {
  return /^# [^\r\n]+ instructions for [^\r\n]+\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/i.test(
    value.trim()
  );
}

function claudeSessionMetadataTitle(
  object: Record<string, unknown>
): string | undefined {
  const type = pickFirstString(object, ["type", "role"]);
  if (type === "custom-title") {
    return sanitizeTitle(
      pickFirstString(object, ["customTitle", "custom_title", "title"])
    );
  }
  if (
    type === "summary" ||
    type === "session-summary" ||
    type === "session_summary" ||
    type === "title"
  ) {
    return sanitizeTitle(
      pickFirstString(object, [
        "customTitle",
        "custom_title",
        "summary",
        "title"
      ])
    );
  }
  if (type !== "user" && type !== "human" && type !== "assistant") {
    return sanitizeTitle(
      pickFirstString(object, [
        "customTitle",
        "custom_title",
        "summary",
        "title"
      ])
    );
  }
  return undefined;
}

function claudeUserPromptTitle(
  object: Record<string, unknown>
): string | undefined {
  if (object.isMeta === true) {
    return undefined;
  }
  const message = asObject(object.message);
  return sanitizeTitle(
    extractClaudePromptText(
      message?.content ?? object.content ?? object.message
    )
  );
}

function claudeConversationPreview(
  object: Record<string, unknown>
): string | undefined {
  const type = pickFirstString(object, ["type", "role"]);
  if (type !== "user" && type !== "human" && type !== "assistant") {
    return undefined;
  }
  if ((type === "user" || type === "human") && object.isMeta === true) {
    return undefined;
  }
  const message = asObject(object.message);
  return sanitizeConversationPreview(
    extractClaudePromptText(
      message?.content ?? object.content ?? object.message
    )
  );
}

function claudeModelFromRecord(
  object: Record<string, unknown>
): string | undefined {
  if (pickFirstString(object, ["type", "role"]) !== "assistant") {
    return undefined;
  }
  return (
    pickFirstString(asObject(object.message), ["model"]) ??
    pickFirstString(object, ["model"])
  );
}

function extractClaudePromptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return cleanClaudePromptText(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractClaudePromptText).filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const type = pickFirstString(object, ["type"]);
  if (type === "tool_result" || "tool_use_id" in object) {
    return undefined;
  }
  if (type === "text") {
    return extractClaudePromptText(object.text);
  }
  return extractClaudePromptText(
    object.content ?? object.text ?? object.message
  );
}

function cleanClaudePromptText(value: string): string | undefined {
  const cleaned = value
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "\n")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "\n")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, "\n")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "\n")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "\n")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "\n")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, "\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "\n")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, "\n")
    .trim();
  return cleaned || undefined;
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
  const vendorLabel = vendorLabelFor(input.vendor);
  const title =
    input.title ??
    `${vendorTitleLabelFor(input.vendor, vendorLabel)} ${input.sessionId.slice(0, 8)}`;
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

function vendorTitleLabelFor(
  vendor: ExternalAgentSessionVendor,
  compactLabel: ExternalAgentSessionVm["vendorLabel"]
): string {
  return vendor === "antigravity" ? "Antigravity" : compactLabel;
}

function toViewModel(
  record: ExternalSessionRecord,
  now: Date,
  canResume: boolean
): ExternalAgentSessionVm {
  return {
    key: record.key,
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
    resumeCommandPreview: buildResumeCommandPreview(record)
  };
}

function toResumeSpec(
  record: ExternalSessionRecord
): ExternalSessionResumeSpec {
  const launch = buildResumeLaunch(record);
  return {
    key: record.key,
    vendor: record.vendor,
    agentSessionRef: {
      vendor: record.vendor,
      externalKey: record.key,
      sessionId: record.sessionId
    },
    title: record.title,
    cwd: record.cwd,
    launch
  };
}

function buildResumeLaunch(record: ExternalSessionRecord): SessionLaunchConfig {
  const command = resumeCommandParts(record);
  return {
    cwd: record.cwd,
    initialInput: `${command.map(shellQuote).join(" ")}\r`,
    title: record.title
  };
}

function buildResumeCommandPreview(record: ExternalSessionRecord): string {
  return resumeCommandParts(record).join(" ");
}

function resumeCommandParts(record: ExternalSessionRecord): string[] {
  switch (record.vendor) {
    case "codex":
      return ["codex", "resume", record.sessionId];
    case "claude":
      return ["claude", "--resume", record.sessionId];
    case "antigravity":
      return ["agy", "--conversation", record.sessionId];
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function canResumeRecord(
  record: ExternalSessionRecord,
  canRunCommand: (command: string) => boolean
): boolean {
  return canRunCommand(resumeCommandParts(record)[0]);
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

function collectCandidateFiles(
  root: string,
  include: (path: string) => boolean
): CandidateFile[] {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: CandidateFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        pending.push(path);
      } else if (stats.isFile() && include(path)) {
        candidates.push({
          path,
          mtimeMs: stats.mtimeMs,
          size: stats.size
        });
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
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

function pickFirstString(
  object: Record<string, unknown> | null | undefined,
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

function sanitizeTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > MAX_TITLE_LENGTH
    ? `${compact.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : compact;
}

function sanitizeConversationPreview(
  value: string | undefined
): string | undefined {
  const compact = value?.replace(/\s+/gu, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > MAX_CONVERSATION_PREVIEW_LENGTH
    ? `${compact.slice(0, MAX_CONVERSATION_PREVIEW_LENGTH - 1)}…`
    : compact;
}

function maxIsoTimestamp(
  current: string | undefined,
  candidate: string
): string {
  if (!current) {
    return candidate;
  }
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
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

function recentJsonlActivityTimestamp(
  parsedUpdatedAt: string | undefined,
  mtimeMs: number
): string {
  const mtime = new Date(mtimeMs).toISOString();
  return parsedUpdatedAt ? maxIsoTimestamp(parsedUpdatedAt, mtime) : mtime;
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
