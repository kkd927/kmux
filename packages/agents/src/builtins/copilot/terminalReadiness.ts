import type { AgentTerminalReadiness } from "../../contracts";
import {
  blockedTerminalInput,
  classifyEmptyTerminalPrompt
} from "../../terminalReadiness";

export function classifyCopilotTerminalReadiness(
  visible: string
): AgentTerminalReadiness {
  if (
    /(?:^|\n)\s*Confirm folder trust\s*\n\s*Do you trust the files in this folder\?\s*\n(?:[^\n]*\n)*[^\n]*❯\s*\d+\.\s*(?:Yes|No)[^\n]*(?:\n\s*(?:\d+\.\s*(?:Yes|No)|Use |Press |Esc |Enter )[^\n]*)*\s*$/iu.test(
      visible
    ) ||
    /(?:^|\n)\s*Authentication required\.\s*Use \/login\.\s*$/iu.test(visible)
  )
    return blockedTerminalInput();
  // Preserve the input frame, but ignore presentation whitespace in its
  // footer. Narrow panes wrap labels and stack footer columns independently.
  const frame = [
    ...visible.matchAll(
      /(?:^|\n)(?:[^\n]{0,8}❯[ \t]*\n\s*─{3,}[ \t]*|\s*╻[▄─]{3,}\s*\n\s*┃[ \t]*\n\s*╹[▀─]{3,}[ \t]*)\n/gu
    )
  ].at(-1);
  const footerText = frame
    ? visible
        .slice(frame.index + frame[0].length)
        .trim()
        .replace(/[ \t]*\n[ \t]*/gu, "")
    : "";
  // The final status is Auto (optionally its resolved model) or a model label.
  // Keep word spacing here: later prose must not become part of a model ID.
  const modelStatus =
    /(?:Auto(?:[ \t]*→[ \t]*[\p{L}\p{N}._/-]+)?|[\p{L}][\p{L}\p{N}._/-]*\d[\p{L}\p{N}._/-]*)[ \t]*$/u.exec(
      footerText
    );
  const footer = (
    modelStatus ? footerText.slice(0, modelStatus.index) : footerText
  ).replace(/\s/gu, "");
  // Accept only footer labels, so a stale empty input above busy output or
  // another dialog cannot establish readiness.
  const idleFooter =
    /^(?:←|open|sidebar|·|Interactive|Allow|All|\/commands|\?help|tab|next)+$/iu.test(
      footer
    ) &&
    footer.includes("/commands") &&
    footer.includes("?help");
  return idleFooter ? { state: "ready" } : classifyEmptyTerminalPrompt(visible);
}
