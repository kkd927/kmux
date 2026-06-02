import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

const ANTIGRAVITY_HOOKS_PATH_SEGMENTS = [
  ".gemini",
  "config",
  "hooks.json"
] as const;
const ANTIGRAVITY_SESSION_INDEX_VERSION = 1;
const ANTIGRAVITY_SESSION_INDEX_FILENAME = "antigravity-sessions.json";
const KMUX_MANAGED_ANTIGRAVITY_HOOK_MARKER = "KMUX_MANAGED_ANTIGRAVITY_HOOK=1";

type AntigravityHookEvent =
  | "PreInvocation"
  | "PreToolUse"
  | "PostToolUse"
  | "PostInvocation"
  | "Stop";
type JsonObject = Record<string, unknown>;

interface HookCommandDefinition extends JsonObject {
  type?: unknown;
  command?: unknown;
}

export interface AntigravityIntegrationInstallResult {
  changed: boolean;
  hooksPath: string;
  warning?: string;
}

export interface AntigravityHookRuntimePaths {
  socketPath?: string;
  agentBinDir?: string;
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

const MANAGED_ANTIGRAVITY_HOOK_EVENTS: AntigravityHookEvent[] = [
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "PostInvocation",
  "Stop"
];

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

function antigravityHookFallbackJson(eventName: AntigravityHookEvent): string {
  if (eventName === "PreToolUse" || eventName === "Stop") {
    return JSON.stringify({ decision: "allow" });
  }
  return JSON.stringify({});
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellParameterDefault(
  envName: "KMUX_SOCKET_PATH" | "KMUX_AGENT_BIN_DIR",
  fallback: string | undefined
): string {
  return fallback?.trim()
    ? `\${${envName}:-${shellSingleQuote(fallback.trim())}}`
    : `"\${${envName}:-}"`;
}

function buildAntigravityHookCommand(
  eventName: AntigravityHookEvent,
  runtimePaths: AntigravityHookRuntimePaths = {}
): string {
  const fallbackCommand = `printf '%s\\n' '${antigravityHookFallbackJson(eventName)}'`;
  return [
    `${KMUX_MANAGED_ANTIGRAVITY_HOOK_MARKER};`,
    `_kmux_socket_path=${shellParameterDefault("KMUX_SOCKET_PATH", runtimePaths.socketPath)};`,
    `_kmux_agent_bin_dir=${shellParameterDefault("KMUX_AGENT_BIN_DIR", runtimePaths.agentBinDir)};`,
    'if [ -n "$_kmux_socket_path" ] &&',
    '[ -n "$_kmux_agent_bin_dir" ] &&',
    '[ -x "$_kmux_agent_bin_dir/kmux-agent-hook" ]; then',
    `KMUX_SOCKET_PATH="$_kmux_socket_path" KMUX_AGENT_BIN_DIR="$_kmux_agent_bin_dir" KMUX_AGENT_HOOK_OUTPUT_MODE=json "$_kmux_agent_bin_dir/kmux-agent-hook" antigravity ${eventName} || ${fallbackCommand};`,
    "else",
    `${fallbackCommand};`,
    "fi"
  ].join(" ");
}

function buildManagedHookCommand(
  eventName: AntigravityHookEvent,
  runtimePaths: AntigravityHookRuntimePaths
): HookCommandDefinition {
  return {
    type: "command",
    command: buildAntigravityHookCommand(eventName, runtimePaths)
  };
}

function buildManagedEventConfig(
  eventName: AntigravityHookEvent,
  runtimePaths: AntigravityHookRuntimePaths
): unknown[] {
  const hook = buildManagedHookCommand(eventName, runtimePaths);
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    return [
      {
        matcher: ".*",
        hooks: [hook]
      }
    ];
  }
  return [hook];
}

function isManagedAntigravityHookCommand(
  hook: unknown
): hook is HookCommandDefinition {
  return (
    isPlainObject(hook) &&
    typeof hook.command === "string" &&
    hook.command.includes(KMUX_MANAGED_ANTIGRAVITY_HOOK_MARKER)
  );
}

function pruneManagedAntigravityHooksFromConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    const nextItems = value
      .map((item) => pruneManagedAntigravityHooksFromConfig(item))
      .filter((item) => item !== null);
    return nextItems.length > 0 ? nextItems : null;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (isManagedAntigravityHookCommand(value)) {
    return null;
  }
  const nextObject: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const pruned = pruneManagedAntigravityHooksFromConfig(nestedValue);
    if (pruned !== null) {
      nextObject[key] = pruned;
    }
  }
  if (Array.isArray(value.hooks) && !Array.isArray(nextObject.hooks)) {
    return null;
  }
  return nextObject;
}

function parseJsonFile(path: string): JsonObject | null {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function ensureAntigravityHooksInstalled(
  homeDir: string | undefined,
  runtimePaths: AntigravityHookRuntimePaths = {}
): AntigravityIntegrationInstallResult {
  const normalizedHomeDir = homeDir?.trim();
  const hooksPath = normalizedHomeDir
    ? join(normalizedHomeDir, ...ANTIGRAVITY_HOOKS_PATH_SEGMENTS)
    : join(...ANTIGRAVITY_HOOKS_PATH_SEGMENTS);

  if (!normalizedHomeDir) {
    return {
      changed: false,
      hooksPath,
      warning:
        "[agent-hooks] Antigravity integration was skipped because HOME could not be resolved."
    };
  }

  const existingHooks = parseJsonFile(hooksPath);
  if (!existingHooks) {
    return {
      changed: false,
      hooksPath,
      warning: `[agent-hooks] Antigravity integration was skipped because ${hooksPath} is not valid JSON.`
    };
  }

  const prunedHooks = pruneManagedAntigravityHooksFromConfig(existingHooks);
  const nextHooks = isPlainObject(prunedHooks) ? { ...prunedHooks } : {};
  nextHooks["kmux-antigravity"] = Object.fromEntries(
    MANAGED_ANTIGRAVITY_HOOK_EVENTS.map((eventName) => [
      eventName,
      buildManagedEventConfig(eventName, runtimePaths)
    ])
  );

  if (JSON.stringify(existingHooks) === JSON.stringify(nextHooks)) {
    return { changed: false, hooksPath };
  }

  atomicWrite(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`);
  return { changed: true, hooksPath };
}

export function antigravitySessionIndexPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configDir = env.KMUX_CONFIG_DIR ?? join(homeDir, ".config", "kmux");
  return join(configDir, ANTIGRAVITY_SESSION_INDEX_FILENAME);
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
