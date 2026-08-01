import { join } from "node:path";

import { ensureAgentIntegrationVendor } from "@kmux/agent-integration";
import type { AgentStorageRoots } from "@kmux/metadata";

export interface ClaudeIntegrationInstallResult {
  changed: boolean;
  settingsPath: string;
  warning?: string;
}

export interface ClaudeHookRuntimePaths {
  /** Retained for source compatibility; transport is selected at launch time. */
  socketPath?: string;
  /** Retained for source compatibility; hook commands resolve the launch environment first. */
  agentBinDir?: string;
  agentStorageRoots?: AgentStorageRoots;
}

export function ensureClaudeHooksInstalled(
  homeDir: string | undefined,
  runtimePaths: ClaudeHookRuntimePaths = {}
): ClaudeIntegrationInstallResult {
  const normalizedHomeDir = homeDir?.trim();
  const settingsPath =
    runtimePaths.agentStorageRoots?.claude.settingsPath ??
    (normalizedHomeDir
      ? join(normalizedHomeDir, ".claude", "settings.json")
      : join(".claude", "settings.json"));
  const result = ensureAgentIntegrationVendor("claude", settingsPath);
  return {
    changed: result.status === "changed",
    settingsPath,
    ...(result.warning ? { warning: result.warning } : {})
  };
}
