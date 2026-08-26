import { relativeSessionInventoryPath } from "@kmux/metadata";
import type { MetadataSourceRoleId } from "@kmux/proto";

export function classifyCopilotMetadataPath(
  roots: readonly string[],
  candidatePath: string
): MetadataSourceRoleId | null {
  for (const root of roots) {
    const relative = relativeSessionInventoryPath(root, candidatePath);
    if (relative === null) continue;
    const segments = relative.split("/");
    if (
      segments.length === 2 &&
      segments[0]?.length &&
      segments[1] === "events.jsonl"
    ) {
      return "copilot-session";
    }
  }
  return null;
}

export function copilotSessionIdFromPath(value: string): string | undefined {
  const normalized = value.replace(/\\/gu, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() !== "events.jsonl") return undefined;
  const sessionId = parts.at(-2)?.trim();
  return sessionId && sessionId.length <= 512 ? sessionId : undefined;
}
