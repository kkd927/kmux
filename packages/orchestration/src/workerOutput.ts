import type { JsonValue } from "./types";

/** Bound both visible text and the raw terminal tail, including reads of saved archives. */
export function boundWorkerOutput(
  history: JsonValue,
  lines: number,
  maxBytes: number
): JsonValue {
  if (!history || typeof history !== "object" || Array.isArray(history))
    return history;
  const bounded = { ...history };
  let truncated = history.truncated === true;
  for (const key of ["vt", "rawOutputTail"] as const) {
    const text = history[key];
    if (typeof text !== "string") continue;
    const allLines = text.split(/\r?\n/u);
    const visible = allLines.slice(-Math.max(1, lines)).join("\n");
    const bytes = Buffer.from(visible, "utf8");
    let start = Math.max(0, bytes.length - Math.max(1, maxBytes));
    // Avoid beginning with an incomplete UTF-8 codepoint.
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    bounded[key] = bytes.subarray(start).toString("utf8");
    truncated ||= allLines.length > lines || start > 0;
  }
  bounded.truncated = truncated;
  const hasText = [bounded.vt, bounded.rawOutputTail].some(
    (entry) => typeof entry === "string" && entry.length > 0
  );
  bounded.source ??= "terminal";
  bounded.status ??= hasText ? "available" : "empty";
  return bounded;
}

export function workerOutputCanBeArchived(
  history: JsonValue | undefined
): boolean {
  if (!history || typeof history !== "object" || Array.isArray(history))
    return false;
  if (history.status === "missing" || history.status === "unreadable")
    return false;
  return (
    typeof history.vt === "string" || typeof history.rawOutputTail === "string"
  );
}
