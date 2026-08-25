import type {
  AgentScope,
  AgentScopeSettings,
  AgentSettings,
  AgentsSettings
} from "@kmux/proto";

export function resolveAgentScopeSettings(
  agents: AgentsSettings | undefined,
  scope: AgentScope
): AgentScopeSettings | undefined {
  if (scope === "ssh") {
    return agents?.ssh;
  }
  if (!agents) return undefined;
  const local: AgentScopeSettings = {};
  for (const [agentId, settings] of Object.entries(agents)) {
    if (agentId === "ssh" || settings === undefined) continue;
    local[agentId] = settings as AgentSettings;
  }
  return Object.keys(local).length === 0 ? undefined : local;
}

export function formatAgentCommandForShell(parts: readonly string[]): string {
  return parts.map(shellQuoteAgentCommandPart).join(" ");
}

export function shellQuoteAgentCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}
