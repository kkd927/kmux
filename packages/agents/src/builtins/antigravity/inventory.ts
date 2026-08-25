import { relativeSessionInventoryPath } from "@kmux/metadata";
import type { MetadataSourceRoleId } from "@kmux/proto";

export function classifyAntigravityMetadataPath(
  roots: readonly string[],
  candidatePath: string
): MetadataSourceRoleId | null {
  for (const root of roots) {
    const relative = relativeSessionInventoryPath(root, candidatePath);
    if (relative === null) continue;
    const segments = relative.split("/").filter(Boolean);
    const fileName = segments.at(-1) ?? "";
    if (relative === "history.jsonl") return "antigravity-history";
    if (
      segments.length >= 4 &&
      segments.at(-3) === ".system_generated" &&
      segments.at(-2) === "logs" &&
      fileName === "transcript.jsonl"
    ) {
      return "antigravity-transcript";
    }
    if (
      segments.length === 2 &&
      segments[0] === "conversations" &&
      fileName.endsWith(".db")
    ) {
      return "antigravity-conversation";
    }
    if (relative === "cache/projects.json") {
      return "antigravity-project-index";
    }
  }
  return null;
}
