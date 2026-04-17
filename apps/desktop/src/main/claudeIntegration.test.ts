import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  it("installs kmux-managed Claude hooks into the user settings file", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);

    const result = ensureClaudeHooksInstalled(homeDir);

    expect(result.changed).toBe(true);
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };

    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(JSON.stringify(settings)).toContain("KMUX_MANAGED_CLAUDE_HOOK=1");
    expect(settings.hooks.Stop[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          '"${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" claude Stop || true'
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
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0]?.command).toBe("echo user-stop-hook");
    expect(
      settings.hooks.Stop.filter((group) =>
        group.hooks.some((hook) =>
          hook.command?.includes("KMUX_MANAGED_CLAUDE_HOOK=1")
        )
      )
    ).toHaveLength(1);
  });
});
