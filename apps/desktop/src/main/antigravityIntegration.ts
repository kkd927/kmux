import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { ensureAgentIntegrationVendor } from "@kmux/agent-integration";
import type { AgentStorageRoots } from "@kmux/metadata";

const ANTIGRAVITY_HOOKS_PATH_SEGMENTS = [
  ".gemini",
  "config",
  "hooks.json"
] as const;
const ANTIGRAVITY_SESSION_INDEX_VERSION = 1;
const ANTIGRAVITY_SESSION_INDEX_FILENAME = "antigravity-sessions.json";
type JsonObject = Record<string, unknown>;

export interface AntigravityIntegrationInstallResult {
  changed: boolean;
  hooksPath: string;
  warning?: string;
}

export interface AntigravityHookRuntimePaths {
  socketPath?: string;
  agentBinDir?: string;
  agentStorageRoots?: AgentStorageRoots;
}

export interface AntigravitySessionIndexRecord {
  conversationId: string;
  cwd?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface AntigravitySessionIndexEnvelope {
  version: 1;
  sessions: AntigravitySessionIndexRecord[];
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
  }
}

export function ensureAntigravityHooksInstalled(
  homeDir: string | undefined,
  runtimePaths: AntigravityHookRuntimePaths = {}
): AntigravityIntegrationInstallResult {
  const normalizedHomeDir = homeDir?.trim();
  const hooksPath =
    runtimePaths.agentStorageRoots?.antigravity.hooksPath ??
    (normalizedHomeDir
      ? join(normalizedHomeDir, ...ANTIGRAVITY_HOOKS_PATH_SEGMENTS)
      : join(...ANTIGRAVITY_HOOKS_PATH_SEGMENTS));

  const result = ensureAgentIntegrationVendor("antigravity", hooksPath);
  return {
    changed: result.status === "changed",
    hooksPath,
    ...(result.warning ? { warning: result.warning } : {})
  };
}

export function antigravitySessionIndexPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configDir =
    normalizedAbsolutePath(env.KMUX_CONFIG_DIR) ??
    join(normalizedAbsolutePath(homeDir) ?? homedir(), ".config", "kmux");
  return join(configDir, ANTIGRAVITY_SESSION_INDEX_FILENAME);
}

function normalizedAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

export function recordAntigravitySessionFromHook(options: {
  indexPath: string;
  agent: string;
  payload: Record<string, unknown>;
  now?: () => Date;
}): void {
  if (normalizeAntigravityAgentName(options.agent) !== "antigravity") {
    return;
  }
  const conversationId = stringField(options.payload, "conversationId");
  if (!conversationId) {
    return;
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const workspacePaths = arrayOfStrings(options.payload.workspacePaths);
  const cwd = firstString(
    stringField(options.payload, "cwd"),
    workspacePaths[0]
  );
  const previousEnvelope = readAntigravitySessionIndex(options.indexPath);
  const existing = previousEnvelope.sessions.find(
    (session) => session.conversationId === conversationId
  );
  const nextRecord: AntigravitySessionIndexRecord = {
    conversationId,
    ...(cwd || existing?.cwd
      ? { cwd: cwd ?? existing?.cwd }
      : existing?.workspacePaths?.[0]
        ? { cwd: existing.workspacePaths[0] }
        : {}),
    ...(workspacePaths.length > 0 || existing?.workspacePaths
      ? {
          workspacePaths:
            workspacePaths.length > 0
              ? workspacePaths
              : (existing?.workspacePaths ?? [])
        }
      : {}),
    ...optionalStringProperty(
      "transcriptPath",
      stringField(options.payload, "transcriptPath") ?? existing?.transcriptPath
    ),
    ...optionalStringProperty(
      "artifactDirectoryPath",
      stringField(options.payload, "artifactDirectoryPath") ??
        existing?.artifactDirectoryPath
    ),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const nextSessions = [
    nextRecord,
    ...previousEnvelope.sessions.filter(
      (session) => session.conversationId !== conversationId
    )
  ].slice(0, 500);

  atomicWrite(
    options.indexPath,
    `${JSON.stringify(
      {
        version: ANTIGRAVITY_SESSION_INDEX_VERSION,
        sessions: nextSessions
      } satisfies AntigravitySessionIndexEnvelope,
      null,
      2
    )}\n`
  );
}

export function readAntigravitySessionIndex(
  indexPath: string
): AntigravitySessionIndexEnvelope {
  if (!existsSync(indexPath)) {
    return { version: ANTIGRAVITY_SESSION_INDEX_VERSION, sessions: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
    if (!isPlainObject(parsed) || !Array.isArray(parsed.sessions)) {
      return { version: ANTIGRAVITY_SESSION_INDEX_VERSION, sessions: [] };
    }
    return {
      version: ANTIGRAVITY_SESSION_INDEX_VERSION,
      sessions: parsed.sessions.flatMap((session) => {
        const record = isPlainObject(session) ? session : null;
        const conversationId = stringField(
          record ?? undefined,
          "conversationId"
        );
        const updatedAt = stringField(record ?? undefined, "updatedAt");
        if (!conversationId || !updatedAt) {
          return [];
        }
        const workspacePaths = arrayOfStrings(record?.workspacePaths);
        return [
          {
            conversationId,
            ...optionalStringProperty(
              "cwd",
              stringField(record ?? undefined, "cwd")
            ),
            ...(workspacePaths.length > 0 ? { workspacePaths } : {}),
            ...optionalStringProperty(
              "transcriptPath",
              stringField(record ?? undefined, "transcriptPath")
            ),
            ...optionalStringProperty(
              "artifactDirectoryPath",
              stringField(record ?? undefined, "artifactDirectoryPath")
            ),
            createdAt:
              stringField(record ?? undefined, "createdAt") ?? updatedAt,
            updatedAt
          }
        ];
      })
    };
  } catch {
    return { version: ANTIGRAVITY_SESSION_INDEX_VERSION, sessions: [] };
  }
}

function normalizeAntigravityAgentName(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  if (
    normalized === "agy" ||
    normalized === "antigravity" ||
    normalized === "antigravity-cli"
  ) {
    return "antigravity";
  }
  return normalized;
}

function optionalStringProperty<TKey extends string>(
  key: TKey,
  value: string | undefined
): { [K in TKey]?: string } {
  return (value ? { [key]: value } : {}) as { [K in TKey]?: string };
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];
}
