import type { AgentScope, AgentVendor, KmuxSettings } from "@kmux/proto";

const NATIVE_AGENT_COMMANDS: Record<AgentVendor, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy"
};

export function resolveAgentCommand(
  settings: Pick<KmuxSettings, "agents"> | undefined,
  scope: AgentScope,
  vendor: AgentVendor,
  operationArgs: readonly string[] = []
): string[] {
  const configured = settings?.agents?.[scope]?.[vendor];
  return [
    configured?.command ?? NATIVE_AGENT_COMMANDS[vendor],
    ...(configured?.args ?? []),
    ...operationArgs
  ];
}

export function resolveAgentResumeCommand(
  settings: Pick<KmuxSettings, "agents"> | undefined,
  scope: AgentScope,
  vendor: AgentVendor,
  sessionId: string
): string[] {
  return resolveAgentCommand(
    settings,
    scope,
    vendor,
    agentResumeOperationArgs(vendor, sessionId)
  );
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
