import type { AgentTerminalReadiness } from "../../contracts";
import { classifyEmptyTerminalPrompt } from "../../terminalReadiness";

export function classifyClaudeTerminalReadiness(
  visible: string
): AgentTerminalReadiness {
  return /(?:^|\n)\s*❯(?!\s*\d+[.)]\s)[^\n]*(?:\n\s*─{3,}\s*)?(?:\n\s*\?\s+for\s+shortcuts[^\n]*)?\s*$/iu.test(
    visible
  )
    ? { state: "ready" }
    : classifyEmptyTerminalPrompt(visible);
}
