import type { AgentTerminalReadiness } from "../../contracts";
import { classifyEmptyTerminalPrompt } from "../../terminalReadiness";

export function classifyAntigravityTerminalReadiness(
  visible: string
): AgentTerminalReadiness {
  return /(?:^|\n)\s*>\s*\n\s*─{3,}\s*\n\s*\?\s+for\s+shor(?:tcuts)?[^\n]*\s*$/iu.test(
    visible
  )
    ? { state: "ready" }
    : classifyEmptyTerminalPrompt(visible);
}
