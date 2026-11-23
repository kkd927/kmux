import type { AgentTerminalReadiness } from "../../contracts";
import { classifyEmptyTerminalPrompt } from "../../terminalReadiness";

export function classifyCodexTerminalReadiness(
  visible: string
): AgentTerminalReadiness {
  const lines = visible.split("\n");
  const composer = lines.findLastIndex((line) => /^\s*›/u.test(line));
  if (composer === -1) return classifyEmptyTerminalPrompt(visible);
  // Dialogs share the cursor glyph. VT serialization can omit spaces between
  // positioned cells, so neither choices nor footer labels require a space.
  if (/^\s*›\s*\d+[.)]/u.test(lines[composer]!)) return null;
  const compact = (line: string) => line.replace(/\s/gu, "").toLowerCase();
  const footer = lines
    .slice(composer + 1)
    .map(compact)
    .filter(Boolean);
  if (!footer.every(isCodexFooterRow)) return null;

  const above = lines.slice(0, composer).map(compact).filter(Boolean);
  const status = above.findLast(
    (line) => !line.startsWith("└tip:") && !/^⚠.*(?:limit|warning)/u.test(line)
  );
  if (status && /^(?:[•◦]|working\().*tointerrupt\)/u.test(status)) return null;

  const header = lines.findLastIndex((line) =>
    /^[^a-z0-9]*openaicodex/iu.test(compact(line))
  );
  if (
    header !== -1 &&
    lines
      .slice(header, header + 6)
      .some((line) =>
        /(?:model|directory):loading|^loading$/u.test(compact(line))
      )
  )
    return null;
  return { state: "ready" };
}

function isCodexFooterRow(line: string): boolean {
  return (
    line.startsWith("?forshortcuts") ||
    /\d+%contextleft/u.test(line) ||
    // New Codex versions put model/effort and cwd on their own status row.
    /[·∙](?:\/|~)/u.test(line) ||
    /^⚠.*(?:limit|warning)/u.test(line)
  );
}
