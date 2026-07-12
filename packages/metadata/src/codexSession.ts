function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function isCodexSubagentSessionMetadata(
  payload: Record<string, unknown>
): boolean {
  const threadSource = firstString(payload, ["thread_source", "threadSource"]);
  if (threadSource?.toLowerCase() === "subagent") {
    return true;
  }
  return Boolean(asRecord(asRecord(payload.source)?.subagent));
}
