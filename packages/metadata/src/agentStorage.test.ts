import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentStorageRoots } from "./agentStorage";

describe("agent storage roots", () => {
  it("keeps Linux vendor roots at verified home-directory defaults", () => {
    const roots = resolveAgentStorageRoots({
      homeDir: "/home/test"
    });

    expect(roots).toEqual({
      homeDir: "/home/test",
      codex: {
        root: "/home/test/.codex",
        sessionsDir: "/home/test/.codex/sessions",
        authPath: "/home/test/.codex/auth.json"
      },
      claude: {
        root: "/home/test/.claude",
        projectsDir: "/home/test/.claude/projects",
        credentialsPath: "/home/test/.claude/.credentials.json",
        settingsPath: "/home/test/.claude/settings.json"
      },
      antigravity: {
        root: "/home/test/.gemini/antigravity-cli",
        oauthTokenPath:
          "/home/test/.gemini/antigravity-cli/antigravity-oauth-token",
        brainDir: "/home/test/.gemini/antigravity-cli/brain",
        historyPath: "/home/test/.gemini/antigravity-cli/history.jsonl",
        cacheProjectsPath:
          "/home/test/.gemini/antigravity-cli/cache/projects.json",
        conversationsDir: "/home/test/.gemini/antigravity-cli/conversations",
        hooksPath: "/home/test/.gemini/config/hooks.json"
      }
    });
  });

  it("falls back to HOME when an explicit home dir is not supplied", () => {
    const roots = resolveAgentStorageRoots({
      env: {
        HOME: "/Users/test"
      }
    });

    expect(roots.codex.sessionsDir).toBe(
      join("/Users/test", ".codex", "sessions")
    );
    expect(roots.antigravity.brainDir).toBe(
      join("/Users/test", ".gemini", "antigravity-cli", "brain")
    );
  });

  it("ignores blank or relative home directory inputs", () => {
    const roots = resolveAgentStorageRoots({
      homeDir: " relative-home ",
      env: {
        HOME: "/home/fallback"
      }
    });

    expect(roots.homeDir).toBe("/home/fallback");
    expect(roots.codex.authPath).toBe(
      join("/home/fallback", ".codex", "auth.json")
    );

    const envFallbackRoots = resolveAgentStorageRoots({
      homeDir: "   ",
      env: {
        HOME: "relative-home"
      }
    });

    expect(envFallbackRoots.homeDir).not.toBe("relative-home");
    expect(envFallbackRoots.codex.authPath).not.toBe(
      join("relative-home", ".codex", "auth.json")
    );
  });
});
