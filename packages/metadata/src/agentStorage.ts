import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { AgentVendor } from "@kmux/proto";

export interface AgentStorageRoots {
  homeDir: string;
  codex: {
    root: string;
    sessionsDir: string;
    authPath: string;
  };
  claude: {
    root: string;
    projectsDir: string;
    credentialsPath: string;
    settingsPath: string;
  };
  antigravity: {
    root: string;
    oauthTokenPath: string;
    brainDir: string;
    historyPath: string;
    cacheProjectsPath: string;
    conversationsDir: string;
    hooksPath: string;
  };
}

export interface ResolveAgentStorageRootsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export type AdditionalAgentSessionRoots = Partial<
  Record<AgentVendor, readonly string[]>
>;

export interface AgentSessionRoots {
  codex: string[];
  claude: string[];
  antigravity: string[];
}

export function resolveAgentStorageRoots(
  options: ResolveAgentStorageRootsOptions = {}
): AgentStorageRoots {
  const homeDir = resolveHomeDir(options.homeDir, options.env);
  const codexRoot = join(homeDir, ".codex");
  const claudeRoot = join(homeDir, ".claude");
  const geminiRoot = join(homeDir, ".gemini");
  const antigravityRoot = join(geminiRoot, "antigravity-cli");

  return {
    homeDir,
    codex: {
      root: codexRoot,
      sessionsDir: join(codexRoot, "sessions"),
      authPath: join(codexRoot, "auth.json")
    },
    claude: {
      root: claudeRoot,
      projectsDir: join(claudeRoot, "projects"),
      credentialsPath: join(claudeRoot, ".credentials.json"),
      settingsPath: join(claudeRoot, "settings.json")
    },
    antigravity: {
      root: antigravityRoot,
      oauthTokenPath: join(antigravityRoot, "antigravity-oauth-token"),
      brainDir: join(antigravityRoot, "brain"),
      historyPath: join(antigravityRoot, "history.jsonl"),
      cacheProjectsPath: join(antigravityRoot, "cache", "projects.json"),
      conversationsDir: join(antigravityRoot, "conversations"),
      hooksPath: join(geminiRoot, "config", "hooks.json")
    }
  };
}

export function resolveAgentSessionRoots(options: {
  agentStorageRoots: AgentStorageRoots;
  additionalSessionRoots?: AdditionalAgentSessionRoots;
}): AgentSessionRoots {
  const { agentStorageRoots, additionalSessionRoots = {} } = options;
  return {
    codex: resolveSessionRootList(
      agentStorageRoots.codex.sessionsDir,
      additionalSessionRoots.codex,
      agentStorageRoots.homeDir
    ),
    claude: resolveSessionRootList(
      agentStorageRoots.claude.projectsDir,
      additionalSessionRoots.claude,
      agentStorageRoots.homeDir
    ),
    antigravity: resolveSessionRootList(
      agentStorageRoots.antigravity.root,
      additionalSessionRoots.antigravity,
      agentStorageRoots.homeDir
    )
  };
}

function resolveSessionRootList(
  defaultRoot: string,
  additionalRoots: readonly string[] | undefined,
  homeDir: string
): string[] {
  const roots = [defaultRoot, ...(additionalRoots ?? [])]
    .map((root) => expandConfiguredSessionRoot(root, homeDir))
    .filter((root): root is string => root !== null);
  const seenPaths = new Set<string>();
  const seenIdentities = new Set<string>();
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    const actual = actualSessionRoot(root);
    const canonicalPath = actual?.path ?? root;
    if (seenPaths.has(canonicalPath)) {
      continue;
    }
    if (actual?.identity && seenIdentities.has(actual.identity)) {
      continue;
    }
    seenPaths.add(canonicalPath);
    if (actual?.identity) {
      seenIdentities.add(actual.identity);
    }
    resolvedRoots.push(canonicalPath);
  }
  return resolvedRoots;
}

function expandConfiguredSessionRoot(
  root: string,
  homeDir: string
): string | null {
  const trimmed = root.trim();
  if (trimmed.startsWith("~/")) {
    return resolve(homeDir, trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : null;
}

function actualSessionRoot(
  root: string
): { path: string; identity: string } | null {
  try {
    const path = realpathSync.native(root);
    const stats = statSync(path);
    return {
      path,
      identity: `${String(stats.dev)}:${String(stats.ino)}`
    };
  } catch {
    return null;
  }
}

function resolveHomeDir(
  homeDir: string | undefined,
  env: NodeJS.ProcessEnv | undefined
): string {
  return (
    normalizedAbsolutePath(homeDir) ??
    normalizedAbsolutePath(env?.HOME) ??
    homedir()
  );
}

function normalizedAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}
