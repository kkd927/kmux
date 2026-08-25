import { extname } from "node:path";

import type { MetadataSourceRoleId } from "@kmux/proto";

export function classifyCodexMetadataPath(
  candidatePath: string
): MetadataSourceRoleId | null {
  const extension = extname(candidatePath).toLowerCase();
  return extension === ".jsonl" || extension === ".ndjson"
    ? "codex-session"
    : null;
}
