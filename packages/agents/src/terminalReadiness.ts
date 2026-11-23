import { stripVTControlCharacters } from "node:util";
import type {
  AgentTerminalReadiness,
  AgentTerminalReadinessCapability
} from "./contracts";

export function classifyAgentTerminalSnapshot(input: {
  readonly visible: string;
  readonly agentProcessDetected: boolean;
  readonly capability?: AgentTerminalReadinessCapability;
}): AgentTerminalReadiness {
  const visible = stripVTControlCharacters(input.visible).replace(/\r/gu, "");
  if (!input.agentProcessDetected) {
    // Only the current shell output can establish a startup failure. Old
    // scrollback and an Agent's discussion of shell errors are not evidence.
    const tail = visible.trimEnd().split("\n").slice(-4).join("\n");
    return /(?:command not found|no such file or directory|permission denied|bad interpreter)/iu.test(
      tail
    )
      ? {
          state: "blocked",
          reason: "Agent CLI exited before reaching its input-ready screen"
        }
      : null;
  }
  return input.capability
    ? input.capability.classify(visible)
    : classifyEmptyTerminalPrompt(visible);
}

export function classifyEmptyTerminalPrompt(
  visible: string
): AgentTerminalReadiness {
  return /(?:^|\n)\s*(?:>|❯|›)\s*$/u.test(visible) ? { state: "ready" } : null;
}

export function blockedTerminalInput(): AgentTerminalReadiness {
  return {
    state: "blocked",
    reason: "Agent CLI is waiting for login or permission input"
  };
}
