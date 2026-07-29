import {
  lstatSync,
  opendirSync,
  realpathSync,
  type Dirent,
  type Stats
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface SessionInventoryLimits {
  maxDepth: number;
  maxDirectories: number;
  maxEntries: number;
}

export const SESSION_INVENTORY_LIMITS: Readonly<SessionInventoryLimits> =
  Object.freeze({
    maxDepth: 10,
    maxDirectories: 4_096,
    maxEntries: 65_536
  });

export interface SessionInventoryCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

export type SessionInventoryDiagnosticKind =
  | "max-depth"
  | "max-directories"
  | "max-entries"
  | "root-unavailable"
  | "directory-unreadable"
  | "entry-unreadable";

export interface SessionInventoryDiagnostic {
  root: string;
  path: string;
  kind: SessionInventoryDiagnosticKind;
  message?: string;
}

export interface SessionInventory {
  candidates: SessionInventoryCandidate[];
  truncated: boolean;
  diagnostics: SessionInventoryDiagnostic[];
}

export type SessionInventoryVendor = "codex" | "claude" | "antigravity";

export type SessionInventoryCandidateRole =
  | "codex-session"
  | "claude-session"
  | "claude-subagent"
  | "antigravity-history"
  | "antigravity-transcript"
  | "antigravity-conversation"
  | "antigravity-project-index";

export function collectSessionInventory(
  roots: readonly string[],
  limits: Partial<SessionInventoryLimits> = {}
): SessionInventory {
  const resolvedLimits = resolveInventoryLimits(limits);
  const candidates: SessionInventoryCandidate[] = [];
  const diagnostics: SessionInventoryDiagnostic[] = [];
  const seenRootPaths = new Set<string>();
  const seenRootIdentities = new Set<string>();
  let truncated = false;

  for (const configuredRoot of roots) {
    if (
      typeof configuredRoot !== "string" ||
      !configuredRoot.trim() ||
      !isAbsolute(configuredRoot)
    ) {
      throw new TypeError("session inventory roots must be absolute paths");
    }
    const normalizedRoot = resolve(configuredRoot);
    const diagnosticCount = diagnostics.length;
    const actualRoot = resolveInventoryRoot(normalizedRoot, diagnostics);
    if (!actualRoot) {
      truncated ||= diagnostics.length > diagnosticCount;
      continue;
    }
    if (
      seenRootPaths.has(actualRoot.path) ||
      seenRootIdentities.has(actualRoot.identity)
    ) {
      continue;
    }
    seenRootPaths.add(actualRoot.path);
    seenRootIdentities.add(actualRoot.identity);

    const rootResult = collectInventoryRoot(
      actualRoot.path,
      resolvedLimits
    );
    candidates.push(...rootResult.candidates);
    diagnostics.push(...rootResult.diagnostics);
    truncated ||= rootResult.truncated;
  }

  const uniqueCandidates = dedupeCandidates(candidates);
  uniqueCandidates.sort(compareInventoryCandidates);
  return { candidates: uniqueCandidates, truncated, diagnostics };
}

export function classifySessionInventoryCandidate(
  vendor: SessionInventoryVendor,
  root: string,
  candidatePath: string
): SessionInventoryCandidateRole | null {
  const relative = relativeInventoryPath(root, candidatePath);
  if (relative === null) {
    return null;
  }
  const segments = relative.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";

  if (vendor === "codex") {
    return fileName.endsWith(".jsonl") ? "codex-session" : null;
  }
  if (vendor === "claude") {
    if (!fileName.endsWith(".jsonl")) {
      return null;
    }
    return segments.slice(0, -1).includes("subagents")
      ? "claude-subagent"
      : "claude-session";
  }
  if (relative === "history.jsonl") {
    return "antigravity-history";
  }
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
  return null;
}

function collectInventoryRoot(
  root: string,
  limits: SessionInventoryLimits
): SessionInventory {
  const candidates: SessionInventoryCandidate[] = [];
  const diagnostics: SessionInventoryDiagnostic[] = [];
  const pending = [{ path: root, depth: 0 }];
  const visitedDirectories = new Set<string>();
  let discoveredDirectories = 1;
  let visitedEntries = 0;
  let truncated = false;

  rootScan: while (pending.length > 0) {
    const directory = pending.shift();
    if (!directory) {
      break;
    }
    let directoryStats: Stats;
    try {
      directoryStats = lstatSync(directory.path);
    } catch (error) {
      diagnostics.push(
        inventoryDiagnostic(root, directory.path, "directory-unreadable", error)
      );
      truncated = true;
      continue;
    }
    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory()
    ) {
      continue;
    }
    const identity = fileIdentity(directoryStats, directory.path);
    if (visitedDirectories.has(identity)) {
      continue;
    }
    visitedDirectories.add(identity);

    let handle;
    try {
      handle = opendirSync(directory.path);
    } catch (error) {
      diagnostics.push(
        inventoryDiagnostic(root, directory.path, "directory-unreadable", error)
      );
      truncated = true;
      continue;
    }
    try {
      while (true) {
        let entry: Dirent | null;
        try {
          entry = handle.readSync();
        } catch (error) {
          diagnostics.push(
            inventoryDiagnostic(
              root,
              directory.path,
              "directory-unreadable",
              error
            )
          );
          truncated = true;
          break;
        }
        if (entry === null) {
          break;
        }
        visitedEntries += 1;
        if (visitedEntries > limits.maxEntries) {
          diagnostics.push(
            inventoryDiagnostic(root, directory.path, "max-entries")
          );
          truncated = true;
          break rootScan;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const entryPath = join(directory.path, entry.name);
        let stats: Stats;
        try {
          stats = lstatSync(entryPath);
        } catch (error) {
          diagnostics.push(
            inventoryDiagnostic(root, entryPath, "entry-unreadable", error)
          );
          truncated = true;
          continue;
        }
        if (stats.isSymbolicLink()) {
          continue;
        }
        if (stats.isDirectory()) {
          if (directory.depth >= limits.maxDepth) {
            diagnostics.push(
              inventoryDiagnostic(root, entryPath, "max-depth")
            );
            truncated = true;
            continue;
          }
          if (discoveredDirectories >= limits.maxDirectories) {
            diagnostics.push(
              inventoryDiagnostic(root, entryPath, "max-directories")
            );
            truncated = true;
            continue;
          }
          discoveredDirectories += 1;
          pending.push({ path: entryPath, depth: directory.depth + 1 });
          continue;
        }
        if (stats.isFile()) {
          candidates.push({
            path: entryPath,
            mtimeMs: Number(stats.mtimeMs),
            size: Number(stats.size)
          });
        }
      }
    } finally {
      try {
        handle.closeSync();
      } catch (error) {
        diagnostics.push(
          inventoryDiagnostic(
            root,
            directory.path,
            "directory-unreadable",
            error
          )
        );
        truncated = true;
      }
    }
  }

  return { candidates, truncated, diagnostics };
}

function resolveInventoryRoot(
  root: string,
  diagnostics: SessionInventoryDiagnostic[]
): { path: string; identity: string } | null {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(root);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    diagnostics.push(inventoryDiagnostic(root, root, "root-unavailable", error));
    return null;
  }
  try {
    const stats = lstatSync(canonicalPath);
    if (!stats.isDirectory()) {
      return null;
    }
    return {
      path: canonicalPath,
      identity: fileIdentity(stats, canonicalPath)
    };
  } catch (error) {
    diagnostics.push(
      inventoryDiagnostic(root, canonicalPath, "root-unavailable", error)
    );
    return null;
  }
}

function resolveInventoryLimits(
  limits: Partial<SessionInventoryLimits>
): SessionInventoryLimits {
  return {
    maxDepth: requireInventoryBound(
      limits.maxDepth,
      SESSION_INVENTORY_LIMITS.maxDepth
    ),
    maxDirectories: requireInventoryBound(
      limits.maxDirectories,
      SESSION_INVENTORY_LIMITS.maxDirectories
    ),
    maxEntries: requireInventoryBound(
      limits.maxEntries,
      SESSION_INVENTORY_LIMITS.maxEntries
    )
  };
}

function requireInventoryBound(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("session inventory limits must be positive integers");
  }
  return value;
}

function dedupeCandidates(
  candidates: SessionInventoryCandidate[]
): SessionInventoryCandidate[] {
  const seenPaths = new Set<string>();
  const unique: SessionInventoryCandidate[] = [];
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) {
      continue;
    }
    seenPaths.add(candidate.path);
    unique.push(candidate);
  }
  return unique;
}

function compareInventoryCandidates(
  left: SessionInventoryCandidate,
  right: SessionInventoryCandidate
): number {
  return (
    right.mtimeMs - left.mtimeMs ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}

function relativeInventoryPath(
  root: string,
  candidatePath: string
): string | null {
  let actualRoot = resolve(root);
  try {
    actualRoot = realpathSync.native(actualRoot);
  } catch {
    // Classification of a disappeared root simply produces no match.
  }
  const normalizedRoot = actualRoot
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "");
  const normalizedPath = resolve(candidatePath).replace(/\\/gu, "/");
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : null;
}

function inventoryDiagnostic(
  root: string,
  path: string,
  kind: SessionInventoryDiagnosticKind,
  error?: unknown
): SessionInventoryDiagnostic {
  return {
    root,
    path,
    kind,
    ...(error instanceof Error && error.message
      ? { message: error.message }
      : {})
  };
}

function fileIdentity(
  stats: Pick<Stats, "dev" | "ino">,
  fallbackPath: string
): string {
  return stats.dev === 0 && stats.ino === 0
    ? `path:${fallbackPath}`
    : `${String(stats.dev)}:${String(stats.ino)}`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
