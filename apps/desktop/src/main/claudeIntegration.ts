import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

const CLAUDE_SETTINGS_PATH_SEGMENTS = [".claude", "settings.json"] as const;
const KMUX_MANAGED_CLAUDE_HOOK_MARKER = "KMUX_MANAGED_CLAUDE_HOOK=1";

type ClaudeHookEvent =
  | "PermissionRequest"
  | "Notification"
  | "PreToolUse"
  | "Stop";

type JsonObject = Record<string, unknown>;

interface HookCommandDefinition extends JsonObject {
  type?: unknown;
  command?: unknown;
}

interface HookMatcherGroup extends JsonObject {
  matcher?: unknown;
  hooks?: unknown;
}

interface ManagedClaudeHookDefinition {
  eventName: ClaudeHookEvent;
  matcher?: string;
}

export interface ClaudeIntegrationInstallResult {
  changed: boolean;
  settingsPath: string;
  warning?: string;
}

const MANAGED_CLAUDE_HOOKS: ManagedClaudeHookDefinition[] = [
  { eventName: "PermissionRequest" },
  { eventName: "Notification" },
  { eventName: "PreToolUse", matcher: "AskUserQuestion" },
  { eventName: "Stop" }
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

function buildClaudeHookCommand(eventName: ClaudeHookEvent): string {
  return [
    `${KMUX_MANAGED_CLAUDE_HOOK_MARKER};`,
    '[ -n "${KMUX_SOCKET_PATH:-}" ] || exit 0;',
    '[ -n "${KMUX_AGENT_BIN_DIR:-}" ] || exit 0;',
    '[ -x "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" ] || exit 0;',
    `"${"${KMUX_AGENT_BIN_DIR}"}/kmux-agent-hook" claude ${eventName} || true`
  ].join(" ");
}

function buildManagedMatcherGroup({
  eventName,
  matcher
}: ManagedClaudeHookDefinition): HookMatcherGroup {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: buildClaudeHookCommand(eventName)
      }
    ]
  };
}

function isManagedClaudeHookCommand(
  hook: unknown,
  eventName: ClaudeHookEvent
): hook is HookCommandDefinition {
  return (
    isPlainObject(hook) &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    hook.command.includes(KMUX_MANAGED_CLAUDE_HOOK_MARKER) &&
    hook.command.includes(` claude ${eventName}`)
  );
}

function mergeManagedMatcherGroups(
  existingGroups: unknown,
  definition: ManagedClaudeHookDefinition
): HookMatcherGroup[] {
  const nextGroups: HookMatcherGroup[] = [];
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group as HookMatcherGroup);
      continue;
    }

    const filteredHooks = group.hooks.filter(
      (hook) => !isManagedClaudeHookCommand(hook, definition.eventName)
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

  nextGroups.push(buildManagedMatcherGroup(definition));
  return nextGroups;
}

function parseClaudeSettings(settingsPath: string): JsonObject | null {
  if (!existsSync(settingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function ensureClaudeHooksInstalled(
  homeDir: string | undefined
): ClaudeIntegrationInstallResult {
  const normalizedHomeDir = homeDir?.trim();
  const settingsPath = normalizedHomeDir
    ? join(normalizedHomeDir, ...CLAUDE_SETTINGS_PATH_SEGMENTS)
    : join(...CLAUDE_SETTINGS_PATH_SEGMENTS);

  if (!normalizedHomeDir) {
    return {
      changed: false,
      settingsPath,
      warning:
        "[agent-hooks] Claude integration was skipped because HOME could not be resolved."
    };
  }

  const existingSettings = parseClaudeSettings(settingsPath);
  if (!existingSettings) {
    return {
      changed: false,
      settingsPath,
      warning: `[agent-hooks] Claude integration was skipped because ${settingsPath} is not valid JSON.`
    };
  }

  const existingHooks = isPlainObject(existingSettings.hooks)
    ? existingSettings.hooks
    : {};
  const nextHooks: JsonObject = { ...existingHooks };
  for (const definition of MANAGED_CLAUDE_HOOKS) {
    nextHooks[definition.eventName] = mergeManagedMatcherGroups(
      existingHooks[definition.eventName],
      definition
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
