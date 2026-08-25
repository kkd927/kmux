import { extname } from "node:path";

import type { MetadataSourceRoleId } from "@kmux/proto";

export function classifyClaudeMetadataPath(
  candidatePath: string
): MetadataSourceRoleId | null {
  const extension = extname(candidatePath).toLowerCase();
  if (extension !== ".jsonl" && extension !== ".ndjson") return null;
  return candidatePath.replace(/\\/gu, "/").includes("/subagents/")
    ? "claude-subagent"
    : "claude-session";
}
