import { ensureAgentIntegrations } from "@kmux/agent-integration";
import { builtinLocalAgentIntegrationPaths } from "@kmux/agents/builtin-runtime";
import type { AgentStorageRoots } from "@kmux/metadata";

export function ensureLocalAgentIntegrations(options: {
  env?: NodeJS.ProcessEnv;
  homeDir: string;
  agentStorageRoots: AgentStorageRoots;
}) {
  return ensureAgentIntegrations({
    env: options.env,
    homeDir: options.homeDir,
    paths: builtinLocalAgentIntegrationPaths(options)
  });
}
