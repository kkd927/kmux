import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentStorageRoots } from "@kmux/metadata";

import { shellAbsolutePathAssignment } from "./agentHookCommand";

const GEMINI_SETTINGS_PATH_SEGMENTS = [".gemini", "settings.json"] as const;
const KMUX_MANAGED_GEMINI_HOOK_MARKER = "KMUX_MANAGED_GEMINI_HOOK=1";

type GeminiHookEvent =
  | "AfterAgent"
  | "AfterTool"
  | "BeforeAgent"
  | "BeforeTool"
  | "Notification"
  | "SessionEnd"
  | "SessionStart";
type JsonObject = Record<string, unknown>;

interface HookCommandDefinition extends JsonObject {
  type?: unknown;
  command?: unknown;
}

interface HookMatcherGroup extends JsonObject {
  matcher?: unknown;
  hooks?: unknown;
}

interface ManagedGeminiHookDefinition {
  eventName: GeminiHookEvent;
  matcher?: string;
}

export interface GeminiIntegrationInstallResult {
  changed: boolean;
  settingsPath: string;
  warning?: string;
}

export interface GeminiHookRuntimePaths {
  socketPath?: string;
  agentBinDir?: string;
  agentStorageRoots?: AgentStorageRoots;
}

const MANAGED_GEMINI_HOOKS: ManagedGeminiHookDefinition[] = [
  { eventName: "AfterAgent" },
  { eventName: "SessionStart" },
  { eventName: "Notification", matcher: "ToolPermission" }
];
const DEPRECATED_MANAGED_GEMINI_HOOKS: ManagedGeminiHookDefinition[] = [
  { eventName: "BeforeAgent" },
  { eventName: "BeforeTool" },
  { eventName: "AfterTool" },
  { eventName: "SessionEnd" }
];

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
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

function buildGeminiHookCommand(
  eventName: GeminiHookEvent,
  runtimePaths: GeminiHookRuntimePaths = {}
): string {
  return [
    `${KMUX_MANAGED_GEMINI_HOOK_MARKER};`,
    shellAbsolutePathAssignment(
      "_kmux_socket_path",
      "KMUX_SOCKET_PATH",
      runtimePaths.socketPath
    ),
    shellAbsolutePathAssignment(
      "_kmux_agent_bin_dir",
      "KMUX_AGENT_BIN_DIR",
      runtimePaths.agentBinDir
    ),
    'if [ -n "$_kmux_socket_path" ] &&',
    '[ -n "$_kmux_agent_bin_dir" ] &&',
    '[ -x "$_kmux_agent_bin_dir/kmux-agent-hook" ]; then',
    `KMUX_SOCKET_PATH="$_kmux_socket_path" KMUX_AGENT_BIN_DIR="$_kmux_agent_bin_dir" KMUX_AGENT_HOOK_OUTPUT_MODE=json "$_kmux_agent_bin_dir/kmux-agent-hook" gemini ${eventName} || true;`,
    "fi"
  ].join(" ");
}

function buildManagedMatcherGroup({
  eventName,
  matcher
}: ManagedGeminiHookDefinition,
runtimePaths: GeminiHookRuntimePaths): HookMatcherGroup {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        name: `kmux-gemini-${eventName.toLowerCase()}`,
        command: buildGeminiHookCommand(eventName, runtimePaths)
      }
    ]
  };
}

function isManagedGeminiHookCommand(
  hook: unknown,
  eventName: GeminiHookEvent
): hook is HookCommandDefinition {
  return (
    isPlainObject(hook) &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    hook.command.includes(KMUX_MANAGED_GEMINI_HOOK_MARKER) &&
    hook.command.includes(` gemini ${eventName}`)
  );
}

function mergeManagedMatcherGroups(
  existingGroups: unknown,
  definition: ManagedGeminiHookDefinition,
  runtimePaths: GeminiHookRuntimePaths
): HookMatcherGroup[] {
  const nextGroups: HookMatcherGroup[] = [];
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group as HookMatcherGroup);
      continue;
    }

    const filteredHooks = group.hooks.filter(
      (hook) => !isManagedGeminiHookCommand(hook, definition.eventName)
    );
    if (filteredHooks.length === 0) {
      continue;
    }
    if (filteredHooks.length === group.hooks.length) {
      nextGroups.push(group as HookMatcherGroup);
      continue;
    }
    nextGroups.push({
      ...group,
      hooks: filteredHooks
    });
  }

  nextGroups.push(buildManagedMatcherGroup(definition, runtimePaths));
  return nextGroups;
}

function pruneManagedMatcherGroups(
  existingGroups: unknown,
  eventName: GeminiHookEvent
): HookMatcherGroup[] {
  const nextGroups: HookMatcherGroup[] = [];
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group as HookMatcherGroup);
      continue;
    }

    const filteredHooks = group.hooks.filter(
      (hook) => !isManagedGeminiHookCommand(hook, eventName)
    );
    if (filteredHooks.length === 0) {
      continue;
    }
    if (filteredHooks.length === group.hooks.length) {
      nextGroups.push(group as HookMatcherGroup);
      continue;
    }
    nextGroups.push({
      ...group,
      hooks: filteredHooks
    });
  }
  return nextGroups;
}

function parseGeminiSettings(settingsPath: string): JsonObject | null {
  if (!existsSync(settingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(
      stripJsonComments(readFileSync(settingsPath, "utf8")).trim() || "{}"
    ) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function ensureGeminiHooksInstalled(
  homeDir: string | undefined,
  runtimePaths: GeminiHookRuntimePaths = {}
): GeminiIntegrationInstallResult {
  const normalizedHomeDir = homeDir?.trim();
  const settingsPath =
    runtimePaths.agentStorageRoots?.gemini.settingsPath ??
    (normalizedHomeDir
      ? join(normalizedHomeDir, ...GEMINI_SETTINGS_PATH_SEGMENTS)
      : join(...GEMINI_SETTINGS_PATH_SEGMENTS));

  if (!normalizedHomeDir && !runtimePaths.agentStorageRoots) {
    return {
      changed: false,
      settingsPath,
      warning:
        "[agent-hooks] Gemini integration was skipped because HOME could not be resolved."
    };
  }

  const existingSettings = parseGeminiSettings(settingsPath);
  if (!existingSettings) {
    return {
      changed: false,
      settingsPath,
      warning: `[agent-hooks] Gemini integration was skipped because ${settingsPath} is not valid JSON.`
    };
  }

  const existingHooks = isPlainObject(existingSettings.hooks)
    ? existingSettings.hooks
    : {};
  const nextHooks: JsonObject = { ...existingHooks };
  for (const definition of DEPRECATED_MANAGED_GEMINI_HOOKS) {
    const prunedGroups = pruneManagedMatcherGroups(
      nextHooks[definition.eventName],
      definition.eventName
    );
    if (prunedGroups.length === 0) {
      delete nextHooks[definition.eventName];
    } else {
      nextHooks[definition.eventName] = prunedGroups;
    }
  }
  for (const definition of MANAGED_GEMINI_HOOKS) {
    nextHooks[definition.eventName] = mergeManagedMatcherGroups(
      nextHooks[definition.eventName],
      definition,
      runtimePaths
    );
  }

  const nextSettings: JsonObject = {
    ...existingSettings,
    hooks: nextHooks
  };

  if (JSON.stringify(existingSettings) === JSON.stringify(nextSettings)) {
    return {
      changed: false,
      settingsPath
    };
  }

  atomicWrite(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return {
    changed: true,
    settingsPath
  };
}
