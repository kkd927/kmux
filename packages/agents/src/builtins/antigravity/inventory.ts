import { relativeSessionInventoryPath } from "@kmux/metadata";
import type { MetadataSourceRoleId } from "@kmux/proto";

const UUID_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function shouldDescendAntigravityMetadataDirectory(
  relativeDirectoryPath: string,
  rootPath?: string
): boolean {
  const segments = relativeDirectoryPath
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) return true;
  const [first, second, third, fourth] = segments;
  if (first === "conversations" || first === "cache") {
    return segments.length === 1;
  }
  if (first === "brain") {
    if (segments.length <= 2) return true;
    if (segments.length === 3) return third === ".system_generated";
    if (segments.length === 4) {
      return third === ".system_generated" && fourth === "logs";
    }
    return false;
  }
  const rootBase = rootPath
    ?.replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .split("/")
    .at(-1);
  if (rootBase === "brain" || UUID_SEGMENT_PATTERN.test(first ?? "")) {
    if (segments.length === 1) return true;
    if (segments.length === 2) return second === ".system_generated";
    if (segments.length === 3) {
      return second === ".system_generated" && third === "logs";
    }
    return false;
  }
  return false;
}

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
