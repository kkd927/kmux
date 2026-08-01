import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { AgentScopeSettings } from "@kmux/proto";

export interface AgentStorageRoots {
  homeDir: string;
  codex: {
    root: string;
    sessionsDir: string;
    authPath: string;
    hooksPath: string;
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

export interface AgentSessionRoots {
  codex: string[];
  claude: string[];
  antigravity: string[];
}

export function resolveAgentStorageRoots(
  options: ResolveAgentStorageRootsOptions = {}
): AgentStorageRoots {
  const homeDir = resolveHomeDir(options.homeDir, options.env);
  const codexRoot =
    normalizedAbsolutePath(options.env?.CODEX_HOME) ?? join(homeDir, ".codex");
  const claudeRoot = join(homeDir, ".claude");
  const geminiRoot = join(homeDir, ".gemini");
  const antigravityRoot = join(geminiRoot, "antigravity-cli");

  return {
    homeDir,
    codex: {
      root: codexRoot,
      sessionsDir: join(codexRoot, "sessions"),
      authPath: join(codexRoot, "auth.json"),
      hooksPath: join(codexRoot, "hooks.json")
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
  agentSettings?: AgentScopeSettings;
}): AgentSessionRoots {
  const { agentStorageRoots, agentSettings } = options;
  return {
    codex: resolveSessionRootList(
      agentStorageRoots.codex.sessionsDir,
      agentSettings?.codex?.sessionRoot,
      agentStorageRoots.homeDir
    ),
    claude: resolveSessionRootList(
      agentStorageRoots.claude.projectsDir,
      agentSettings?.claude?.sessionRoot,
      agentStorageRoots.homeDir
    ),
    antigravity: resolveSessionRootList(
      agentStorageRoots.antigravity.root,
      agentSettings?.antigravity?.sessionRoot,
      agentStorageRoots.homeDir
    )
  };
}

function resolveSessionRootList(
  defaultRoot: string,
  configuredRoot: string | undefined,
  homeDir: string
): string[] {
  const root = expandConfiguredSessionRoot(
    configuredRoot ?? defaultRoot,
    homeDir
  );
  if (root === null) {
    return [];
  }
  return [actualSessionRoot(root) ?? root];
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

function actualSessionRoot(root: string): string | null {
  try {
    const path = realpathSync.native(root);
    return statSync(path).isDirectory() ? path : null;
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
