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

import { ensureGeminiHooksInstalled } from "./geminiIntegration";

function createSandboxHome(): string {
  return mkdtempSync(join(tmpdir(), "kmux-gemini-integration-"));
}

const sandboxDirs: string[] = [];

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("ensureGeminiHooksInstalled", () => {
  it("uses AgentStorageRoots for the Gemini settings path", () => {
    const homeDir = createSandboxHome();
    const storageHomeDir = createSandboxHome();
    sandboxDirs.push(homeDir, storageHomeDir);
    const roots = resolveAgentStorageRoots({
      homeDir: storageHomeDir
    });

    const result = ensureGeminiHooksInstalled(homeDir, {
      agentStorageRoots: roots
    });

    expect(result.changed).toBe(true);
    expect(result.settingsPath).toBe(roots.gemini.settingsPath);
    expect(existsSync(roots.gemini.settingsPath)).toBe(true);
    expect(existsSync(join(homeDir, ".gemini", "settings.json"))).toBe(false);
  });

  it("installs kmux-managed Gemini hooks into the user settings file", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);

    const socketPath = join(homeDir, ".kmux", "control.sock");
    const agentBinDir = join(homeDir, ".local", "share", "kmux", "hooks");

    const result = ensureGeminiHooksInstalled(homeDir, {
      socketPath,
      agentBinDir
    });

    expect(result.changed).toBe(true);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };

    expect(settings.hooks.BeforeAgent).toBeUndefined();
    expect(settings.hooks.AfterAgent).toHaveLength(1);
    expect(settings.hooks.BeforeTool).toBeUndefined();
    expect(settings.hooks.AfterTool).toBeUndefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toBe("ToolPermission");
    expect(JSON.stringify(settings)).toContain("KMUX_MANAGED_GEMINI_HOOK=1");
    expect(settings.hooks.AfterAgent[0].hooks).toEqual([
      expect.objectContaining({
        command: expect.stringContaining(
          `if [ "\${_kmux_socket_path_env#/}" != "$_kmux_socket_path_env" ]; then _kmux_socket_path="$_kmux_socket_path_env"; else _kmux_socket_path='${socketPath}'`
        )
      })
    ]);
    expect(settings.hooks.AfterAgent[0].hooks).toEqual([
      expect.objectContaining({
        command: expect.stringContaining(
          `if [ "\${_kmux_agent_bin_dir_env#/}" != "$_kmux_agent_bin_dir_env" ]; then _kmux_agent_bin_dir="$_kmux_agent_bin_dir_env"; else _kmux_agent_bin_dir='${agentBinDir}'`
        )
      })
    ]);
    expect(settings.hooks.AfterAgent[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          'KMUX_AGENT_HOOK_OUTPUT_MODE=json "$_kmux_agent_bin_dir/kmux-agent-hook" gemini AfterAgent || true'
        )
      })
    ]);
    expect(settings.hooks.SessionEnd[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          'KMUX_AGENT_HOOK_OUTPUT_MODE=json "$_kmux_agent_bin_dir/kmux-agent-hook" gemini SessionEnd || true'
        )
      })
    ]);
  });

  it("preserves user hooks and tolerates commented settings files", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });

    writeFileSync(
      settingsPath,
      [
        "{",
        '  // existing Gemini settings',
        '  "hooks": {',
        '    "AfterAgent": [',
        "      {",
        '        "hooks": [{"type": "command", "command": "echo user-after-agent"}]',
        "      }",
        "    ],",
        '    "BeforeAgent": [',
        "      {",
        '        "hooks": [{"type": "command", "command": "KMUX_MANAGED_GEMINI_HOOK=1; kmux-agent-hook gemini BeforeAgent || true"}]',
        "      }",
        "    ],",
        '    "BeforeTool": [',
        "      {",
        '        "hooks": [{"type": "command", "command": "echo user-before-tool"}, {"type": "command", "command": "KMUX_MANAGED_GEMINI_HOOK=1; kmux-agent-hook gemini BeforeTool || true"}]',
        "      }",
        "    ],",
        '    "AfterTool": [',
        "      {",
        '        "hooks": [{"type": "command", "command": "KMUX_MANAGED_GEMINI_HOOK=1; kmux-agent-hook gemini AfterTool || true"}]',
        "      }",
        "    ]",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const firstResult = ensureGeminiHooksInstalled(homeDir);
    const secondResult = ensureGeminiHooksInstalled(homeDir);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };

    expect(firstResult.changed).toBe(true);
    expect(secondResult.changed).toBe(false);
    expect(settings.hooks.BeforeAgent).toBeUndefined();
    expect(settings.hooks.AfterAgent).toHaveLength(2);
    expect(settings.hooks.BeforeTool).toHaveLength(1);
    expect(settings.hooks.BeforeTool[0].hooks[0]?.command).toBe(
      "echo user-before-tool"
    );
    expect(settings.hooks.AfterTool).toBeUndefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.AfterAgent[0].hooks[0]?.command).toBe(
      "echo user-after-agent"
    );
    expect(
      settings.hooks.AfterAgent.filter((group) =>
        group.hooks.some((hook) =>
          hook.command?.includes("KMUX_MANAGED_GEMINI_HOOK=1")
        )
      )
    ).toHaveLength(1);
  });
});
