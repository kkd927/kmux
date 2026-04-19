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
  it("installs kmux-managed Gemini hooks into the user settings file", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);

    const result = ensureGeminiHooksInstalled(homeDir);

    expect(result.changed).toBe(true);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };

    expect(settings.hooks.BeforeAgent).toHaveLength(1);
    expect(settings.hooks.AfterAgent).toHaveLength(1);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toBe("ToolPermission");
    expect(JSON.stringify(settings)).toContain("KMUX_MANAGED_GEMINI_HOOK=1");
    expect(settings.hooks.BeforeAgent[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          'KMUX_AGENT_HOOK_OUTPUT_MODE=json "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" gemini BeforeAgent || true'
        )
      })
    ]);
    expect(settings.hooks.AfterAgent[0].hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining(
          'KMUX_AGENT_HOOK_OUTPUT_MODE=json "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" gemini AfterAgent || true'
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
    expect(settings.hooks.BeforeAgent).toHaveLength(1);
    expect(settings.hooks.AfterAgent).toHaveLength(2);
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
