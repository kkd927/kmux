import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  gemini: {
    root: string;
    tmpDir: string;
    historyDir: string;
    oauthCredentialsPath: string;
    settingsPath: string;
  };
  antigravity: {
    root: string;
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
    gemini: {
      root: geminiRoot,
      tmpDir: join(geminiRoot, "tmp"),
      historyDir: join(geminiRoot, "history"),
      oauthCredentialsPath: join(geminiRoot, "oauth_creds.json"),
      settingsPath: join(geminiRoot, "settings.json")
    },
    antigravity: {
      root: antigravityRoot,
      brainDir: join(antigravityRoot, "brain"),
      historyPath: join(antigravityRoot, "history.jsonl"),
      cacheProjectsPath: join(antigravityRoot, "cache", "projects.json"),
      conversationsDir: join(antigravityRoot, "conversations"),
      hooksPath: join(geminiRoot, "config", "hooks.json")
    }
  };
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
