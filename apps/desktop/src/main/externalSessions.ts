import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

import type {
  ExternalAgentSessionVendor,
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";

export interface ExternalSessionIndexerOptions {
  homeDir: string;
  now?: () => Date;
  maxFilesPerVendor?: number;
  env?: NodeJS.ProcessEnv;
  commandAvailability?: (command: string) => boolean;
}

export interface ExternalSessionResumeSpec {
  key: string;
  vendor: ExternalAgentSessionVendor;
  title: string;
  cwd?: string;
  launch: SessionLaunchConfig;
}

interface ExternalSessionRecord {
  key: string;
  vendor: ExternalAgentSessionVendor;
  sessionId: string;
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedAtMs: number;
}

interface CandidateFile {
  path: string;
  mtimeMs: number;
}

const DEFAULT_MAX_FILES_PER_VENDOR = 100;
const MAX_TITLE_LENGTH = 96;
const MAX_JSONL_SCAN_BYTES = 256 * 1024;

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

  function listRecords(): ExternalSessionRecord[] {
    const records = [
      ...listCodexSessions(options.homeDir, maxFilesPerVendor),
      ...listGeminiSessions(options.homeDir, maxFilesPerVendor),
      ...listClaudeSessions(options.homeDir, maxFilesPerVendor)
    ];
    records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    return records;
  }

  return {
    listExternalAgentSessions() {
      return {
        sessions: listRecords().map((record) =>
          toViewModel(record, now(), canResumeRecord(record, canRunCommand))
        ),
        updatedAt: now().toISOString()
      };
    },
    resolveExternalAgentSession(key) {
      const record = listRecords().find((entry) => entry.key === key);
      return record && canResumeRecord(record, canRunCommand)
        ? toResumeSpec(record)
        : null;
    }
  };
}

function listCodexSessions(
  homeDir: string,
  maxFiles: number
): ExternalSessionRecord[] {
  const root = join(homeDir, ".codex", "sessions");
  return collectCandidateFiles(root, (path) =>
    basename(path).startsWith("rollout-") && path.endsWith(".jsonl")
  )
    .slice(0, maxFiles)
    .flatMap((candidate) => {
      const records = parseJsonlPrefix(candidate.path);
      let sessionId: string | undefined;
      let cwd: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;
      let title: string | undefined;

      for (const record of records) {
        const object = asObject(record);
        const payload = asObject(object?.payload);
        const timestamp = pickFirstString(object, ["timestamp"]);
        if (timestamp) {
          updatedAt = maxIsoTimestamp(updatedAt, timestamp);
        }
        if (object?.type === "session_meta" && payload) {
          sessionId = pickFirstString(payload, ["id", "session_id", "sessionId"]);
          cwd = pickFirstString(payload, ["cwd"]);
          createdAt =
            pickFirstString(payload, ["timestamp", "createdAt", "startTime"]) ??
            timestamp ??
            createdAt;
          updatedAt =
            pickFirstString(payload, ["timestamp", "updatedAt", "lastUpdated"]) ??
            updatedAt;
        }
        if (payload?.type === "thread_name_updated") {
          title =
            sanitizeTitle(
              pickFirstString(payload, ["thread_name", "threadName", "name"])
            ) ?? title;
        }
        if (payload?.type === "user_message") {
          title ??= sanitizeTitle(extractText(payload.message));
        }
        if (
          object?.type === "response_item" &&
          payload?.type === "message" &&
          payload.role === "user"
        ) {
          title ??= sanitizeTitle(extractText(payload.content));
        }
      }

      if (!sessionId) {
        return [];
      }
      return [
        buildRecord({
          vendor: "codex",
          sessionId,
          cwd,
          createdAt,
          updatedAt: recentJsonlActivityTimestamp(updatedAt, candidate.mtimeMs),
          title,
          mtimeMs: candidate.mtimeMs
        })
      ];
    });
}

function listGeminiSessions(
  homeDir: string,
  maxFiles: number
): ExternalSessionRecord[] {
  const root = join(homeDir, ".gemini", "tmp");
  const projectRoots = readGeminiProjectRoots(homeDir);
  return collectCandidateFiles(root, (path) => {
    const name = basename(path);
    return name.startsWith("session-") && (name.endsWith(".json") || name.endsWith(".jsonl"));
  })
    .slice(0, maxFiles)
    .flatMap((candidate) => {
      const projectDir = dirname(dirname(candidate.path));
      const projectKey = basename(projectDir);
      const cwd = readTrimmedFile(join(projectDir, ".project_root")) ?? projectRoots.get(projectKey);
      const parsed = candidate.path.endsWith(".jsonl")
        ? parseGeminiJsonl(candidate.path)
        : parseGeminiJson(candidate.path);
      if (!parsed?.sessionId || !parsed.hasConversation) {
        return [];
      }
      return [
        buildRecord({
          vendor: "gemini",
          sessionId: parsed.sessionId,
          cwd,
          createdAt: parsed.createdAt,
          updatedAt: candidate.path.endsWith(".jsonl")
            ? recentJsonlActivityTimestamp(parsed.updatedAt, candidate.mtimeMs)
            : parsed.updatedAt,
          title: parsed.title,
          mtimeMs: candidate.mtimeMs
        })
      ];
    });
}

function listClaudeSessions(
  homeDir: string,
  maxFiles: number
): ExternalSessionRecord[] {
  const root = join(homeDir, ".claude", "projects");
  return collectCandidateFiles(root, (path) => path.endsWith(".jsonl"))
    .slice(0, maxFiles)
    .flatMap((candidate) => {
      const records = parseJsonlPrefix(candidate.path);
      let sessionId: string | undefined;
      let cwd: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;
      let title: string | undefined;

      for (const record of records) {
        const object = asObject(record);
        if (!object) {
          continue;
        }
        sessionId ??= pickFirstString(object, ["sessionId", "session_id", "id"]);
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
        const type = pickFirstString(object, ["type", "role"]);
        if (type === "user" || type === "human") {
          title ??= sanitizeTitle(extractText(object.message ?? object.content));
        }
      }

      if (!sessionId) {
        sessionId = basename(candidate.path, ".jsonl");
      }
      return [
        buildRecord({
          vendor: "claude",
          sessionId,
          cwd,
          createdAt,
          updatedAt: recentJsonlActivityTimestamp(updatedAt, candidate.mtimeMs),
          title,
          mtimeMs: candidate.mtimeMs
        })
      ];
    });
}

function parseGeminiJson(path: string): {
  sessionId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  hasConversation: boolean;
} | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseJson(contents);
  const object = asObject(parsed);
  if (!object) {
    return null;
  }
  const messages = Array.isArray(object.messages) ? object.messages : [];
  return {
    sessionId: pickFirstString(object, ["sessionId", "session_id", "id"]),
    title:
      sanitizeTitle(pickFirstString(object, ["summary", "title"])) ??
      firstUserMessageTitle(messages),
    createdAt: pickFirstString(object, ["startTime", "createdAt", "timestamp"]),
    updatedAt: pickFirstString(object, ["lastUpdated", "updatedAt"]),
    hasConversation: hasGeminiConversationMessage(messages)
  };
}

function parseGeminiJsonl(path: string): {
  sessionId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  hasConversation: boolean;
} | null {
  const records = parseJsonlPrefix(path);
  let sessionId: string | undefined;
  let title: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let hasConversation = false;

  for (const record of records) {
    const object = asObject(record);
    if (!object) {
      continue;
    }
    sessionId ??= pickFirstString(object, ["sessionId", "session_id", "id"]);
    createdAt ??= pickFirstString(object, ["startTime", "createdAt", "timestamp"]);
    updatedAt =
      pickFirstString(object, ["lastUpdated", "updatedAt", "timestamp"]) ??
      updatedAt;
    const type = pickFirstString(object, ["type", "role"]);
    if (isGeminiConversationMessage(object)) {
      hasConversation = true;
    }
    if (type === "user") {
      title ??= sanitizeTitle(extractText(object.content ?? object.message));
    }
  }

  return { sessionId, title, createdAt, updatedAt, hasConversation };
}

function firstUserMessageTitle(messages: unknown[]): string | undefined {
  for (const message of messages) {
    const object = asObject(message);
    const type = pickFirstString(object, ["type", "role"]);
    if (type === "user") {
      return sanitizeTitle(extractText(object?.content ?? object?.displayContent));
    }
  }
  return undefined;
}

function hasGeminiConversationMessage(messages: unknown[]): boolean {
  return messages.some((message) => isGeminiConversationMessage(message));
}

function isGeminiConversationMessage(value: unknown): boolean {
  const object = asObject(value);
  const type = pickFirstString(object, ["type", "role"]);
  if (type !== "user" && type !== "gemini") {
    return false;
  }
  return Boolean(
    extractText(object?.content ?? object?.displayContent ?? object?.message)?.trim()
  );
}

function buildRecord(input: {
  vendor: ExternalAgentSessionVendor;
  sessionId: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  mtimeMs: number;
}): ExternalSessionRecord {
  const vendorLabel = vendorLabelFor(input.vendor);
  const title = input.title ?? `${vendorLabel} ${input.sessionId.slice(0, 8)}`;
  const updatedAtMs = input.updatedAt
    ? Date.parse(input.updatedAt)
    : input.mtimeMs;
  return {
    key: `${input.vendor}:${input.sessionId}`,
    vendor: input.vendor,
    sessionId: input.sessionId,
    title,
    cwd: input.cwd,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? new Date(input.mtimeMs).toISOString(),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : input.mtimeMs
  };
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
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    relativeTimeLabel: formatRelativeTime(now, record.updatedAtMs),
    canResume,
    resumeCommandPreview: buildResumeCommandPreview(record)
  };
}

function toResumeSpec(record: ExternalSessionRecord): ExternalSessionResumeSpec {
  const launch = buildResumeLaunch(record);
  return {
    key: record.key,
    vendor: record.vendor,
    title: record.title,
    cwd: record.cwd,
    launch
  };
}

function buildResumeLaunch(record: ExternalSessionRecord): SessionLaunchConfig {
  const command = resumeCommandParts(record);
  return {
    cwd: record.cwd,
    shell: command[0],
    args: command.slice(1),
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
    case "gemini":
      return ["gemini", "--resume", record.sessionId];
    case "claude":
      return ["claude", "--resume", record.sessionId];
  }
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
    case "gemini":
      return "GEMINI";
    case "claude":
      return "CLAUDE";
  }
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
        candidates.push({ path, mtimeMs: stats.mtimeMs });
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
}

function parseJsonlPrefix(path: string): unknown[] {
  return readFilePrefix(path)
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }
      const parsed = parseJson(trimmed);
      return parsed === null ? [] : [parsed];
    });
}

function readFilePrefix(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_JSONL_SCAN_BYTES);
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

function readGeminiProjectRoots(homeDir: string): Map<string, string> {
  const root = join(homeDir, ".gemini", "history");
  const projectRoots = new Map<string, string>();
  if (!existsSync(root)) {
    return projectRoots;
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return projectRoots;
  }
  for (const entry of entries) {
    const projectRoot = readTrimmedFile(join(root, entry, ".project_root"));
    if (projectRoot) {
      projectRoots.set(entry, projectRoot);
    }
  }
  return projectRoots;
}

function readTrimmedFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
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

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join(" ");
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  return (
    pickFirstString(object, ["text", "message", "content"]) ??
    extractText(object.content) ??
    extractText(object.parts) ??
    extractText(object.message)
  );
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

function maxIsoTimestamp(
  current: string | undefined,
  candidate: string
): string {
  if (!current) {
    return candidate;
  }
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
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
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) {
    return "now";
  }
  if (deltaMs < hour) {
    return `${Math.floor(deltaMs / minute)}m`;
  }
  if (deltaMs < day) {
    return `${Math.floor(deltaMs / hour)}h`;
  }
  if (deltaMs < 7 * day) {
    return `${Math.floor(deltaMs / day)}d`;
  }
  return new Date(updatedAtMs).toISOString().slice(0, 10);
}
