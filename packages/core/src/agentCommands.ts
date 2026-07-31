import type {
  AgentScope,
  AgentScopeSettings,
  AgentsSettings,
  AgentVendor
} from "@kmux/proto";

const NATIVE_AGENT_COMMANDS: Record<AgentVendor, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy"
};

export function resolveAgentCommand(
  settings: AgentScopeSettings | undefined,
  vendor: AgentVendor,
  operationArgs: readonly string[] = []
): string[] {
  const configured = settings?.[vendor];
  return [
    configured?.command ?? NATIVE_AGENT_COMMANDS[vendor],
    ...(configured?.args ?? []),
    ...operationArgs
  ];
}

export function resolveAgentResumeCommand(
  settings: AgentScopeSettings | undefined,
  vendor: AgentVendor,
  sessionId: string
): string[] {
  return resolveAgentCommand(
    settings,
    vendor,
    agentResumeOperationArgs(vendor, sessionId)
  );
}

export function resolveAgentScopeSettings(
  agents: AgentsSettings | undefined,
  scope: AgentScope
): AgentScopeSettings | undefined {
  if (scope === "ssh") {
    return agents?.ssh;
  }
  if (!agents) {
    return undefined;
  }
  const settings: AgentScopeSettings = {};
  for (const vendor of ["claude", "codex", "antigravity"] as const) {
    if (agents[vendor] !== undefined) {
      settings[vendor] = agents[vendor];
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function agentResumeOperationArgs(
  vendor: AgentVendor,
  sessionId: string
): string[] {
  switch (vendor) {
    case "claude":
      return ["--resume", sessionId];
    case "codex":
      return ["resume", sessionId];
    case "antigravity":
      return ["--conversation", sessionId];
  }
}

export function formatAgentCommandForShell(parts: readonly string[]): string {
  return parts.map(shellQuoteAgentCommandPart).join(" ");
}

export function shellQuoteAgentCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}
