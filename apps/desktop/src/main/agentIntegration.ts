import { ensureAgentIntegrations } from "@kmux/agent-integration";
import type { AgentStorageRoots } from "@kmux/metadata";

export function ensureLocalAgentIntegrations(options: {
  homeDir: string;
  agentStorageRoots: AgentStorageRoots;
}) {
  return ensureAgentIntegrations({
    homeDir: options.homeDir,
    paths: {
      claude: options.agentStorageRoots.claude.settingsPath,
      codex: options.agentStorageRoots.codex.hooksPath,
      antigravity: options.agentStorageRoots.antigravity.hooksPath
    }
  });
}
