import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentStorageRoots } from "@kmux/metadata";

import { ensureClaudeHooksInstalled } from "./claudeIntegration";

function createSandboxHome(): string {
  return mkdtempSync(join(tmpdir(), "kmux-claude-integration-"));
}

const sandboxDirs: string[] = [];

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("ensureClaudeHooksInstalled", () => {
  it("uses AgentStorageRoots for the Claude settings path", () => {
    const homeDir = createSandboxHome();
    const storageHomeDir = createSandboxHome();
    sandboxDirs.push(homeDir, storageHomeDir);
    const roots = resolveAgentStorageRoots({
      homeDir: storageHomeDir
    });

    const result = ensureClaudeHooksInstalled(homeDir, {
      agentStorageRoots: roots
    });

    expect(result.changed).toBe(true);
    expect(result.settingsPath).toBe(roots.claude.settingsPath);
    expect(existsSync(roots.claude.settingsPath)).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "settings.json"))).toBe(false);
  });

  it("installs kmux-managed Claude hooks into the user settings file", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);

    const socketPath = join(homeDir, ".kmux", "control.sock");
    const agentBinDir = join(homeDir, ".local", "share", "kmux", "hooks");

    const result = ensureClaudeHooksInstalled(homeDir, {
      socketPath,
      agentBinDir
    });

    expect(result.changed).toBe(true);
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };

    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.Notification).toBeUndefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe(
      "AskUserQuestion|ExitPlanMode"
    );
    expect(settings.hooks.PostToolUse).toBeUndefined();
    expect(settings.hooks.SessionStart[0].hooks).toEqual([
      expect.objectContaining({
        command: expect.stringContaining(
          `if [ "\${_kmux_socket_path_env#/}" != "$_kmux_socket_path_env" ]; then _kmux_socket_path="$_kmux_socket_path_env"; else _kmux_socket_path='${socketPath}'`
        )
      })
    ]);
    expect(settings.hooks.SessionStart[0].hooks).toEqual([
      expect.objectContaining({
        command: expect.stringContaining(
          `if [ "\${_kmux_agent_bin_dir_env#/}" != "$_kmux_agent_bin_dir_env" ]; then _kmux_agent_bin_dir="$_kmux_agent_bin_dir_env"; else _kmux_agent_bin_dir='${agentBinDir}'`
        )
      })
    ]);
    expect(JSON.stringify(settings)).toContain("KMUX_MANAGED_CLAUDE_HOOK=1");
    expect(settings.hooks.Stop[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          '"$_kmux_agent_bin_dir/kmux-agent-hook" claude Stop || true'
        )
      })
    ]);
  });

  it("preserves user hooks and stays idempotent across repeated installs", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);
    const settingsPath = join(homeDir, ".claude", "settings.json");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });

    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Notification: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo user-notification-hook"
                  },
                  {
                    type: "command",
                    command:
                      'KMUX_MANAGED_CLAUDE_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" claude Notification || true'
                  }
                ]
              }
            ],
            PostToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo user-post-tool-use"
                  },
                  {
                    type: "command",
                    command:
                      'KMUX_MANAGED_CLAUDE_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" claude PostToolUse || true'
                  }
                ]
              }
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      'KMUX_MANAGED_CLAUDE_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" claude UserPromptSubmit || true'
                  }
                ]
              }
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo user-stop-hook"
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const firstResult = ensureClaudeHooksInstalled(homeDir);
    const secondResult = ensureClaudeHooksInstalled(homeDir);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };

    expect(firstResult.changed).toBe(true);
    expect(secondResult.changed).toBe(false);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].hooks).toEqual([
      {
        type: "command",
        command: "echo user-notification-hook"
      }
    ]);
    expect(settings.hooks.PostToolUse[0].hooks).toEqual([
      {
        type: "command",
        command: "echo user-post-tool-use"
      }
    ]);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0]?.command).toBe(
      "echo user-stop-hook"
    );
    expect(
      settings.hooks.Stop.filter((group) =>
        group.hooks.some((hook) =>
          hook.command?.includes("KMUX_MANAGED_CLAUDE_HOOK=1")
        )
      )
    ).toHaveLength(1);
  });
});
