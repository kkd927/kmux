import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_HOOK_RPC_TIMEOUT_MS } from "@kmux/proto";
import { describe, expect, it } from "vitest";

import {
  prepareShellIntegrationLaunch,
  shouldApplyShellIntegration
} from "./shellIntegration";

describe("shell integration launch preparation", () => {
  it("only applies to default macOS interactive shell launches", () => {
    expect(shouldApplyShellIntegration("/bin/zsh", undefined, "darwin")).toBe(
      true
    );
    expect(shouldApplyShellIntegration("/bin/bash", undefined, "darwin")).toBe(
      true
    );
    expect(
      shouldApplyShellIntegration("/opt/homebrew/bin/fish", undefined, "darwin")
    ).toBe(true);
    expect(shouldApplyShellIntegration("/bin/zsh", ["-l"], "darwin")).toBe(
      false
    );
    expect(shouldApplyShellIntegration("/bin/zsh", undefined, "linux")).toBe(
      false
    );
    expect(shouldApplyShellIntegration("/bin/sh", undefined, "darwin")).toBe(
      false
    );
  });

  it("keeps launches unchanged when kmux shell integration is disabled", () => {
    const prepared = prepareShellIntegrationLaunch("/bin/zsh", ["-l"], {
      HOME: "/Users/test"
    });

    expect(prepared).toEqual({
      shellPath: "/bin/zsh",
      args: ["-l"],
      env: {
        HOME: "/Users/test"
      }
    });
  });

  it("keeps custom-args launches unwrapped and strips internal markers", () => {
    const env = {
      KMUX_AGENT_BIN_DIR: "/tmp/kmux-agent-bin",
      __KMUX_OSC7_INSTALLED: "1",
      HOME: "/Users/test",
      KMUX_BASH_INTEGRATION_SCRIPT: "/tmp/kmux.bash",
      KMUX_ORIGINAL_HISTFILE: "/Users/test/.zsh_history",
      KMUX_SHELL_INTEGRATION: "1"
    };
    const prepared = prepareShellIntegrationLaunch(
      "/bin/bash",
      ["-c", 'printf %s "$HOME"'],
      env
    );

    expect(prepared).toEqual({
      shellPath: "/bin/bash",
      args: ["-c", 'printf %s "$HOME"'],
      env: {
        HOME: "/Users/test"
      }
    });
  });

  it("wraps zsh launches with kmux-managed dotfiles", () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HOME: "/Users/test",
        ZDOTDIR: "/Users/test/.config/zsh"
      },
      { enabled: true }
    );

    expect(prepared.shellPath).toBe("/bin/zsh");
    expect(prepared.args).toEqual(["-l"]);
    expect(prepared.env.KMUX_SHELL_INTEGRATION).toBe("1");
    expect(prepared.env.KMUX_ORIGINAL_HISTFILE).toBe(
      "/Users/test/.config/zsh/.zsh_history"
    );
    expect(prepared.env.KMUX_ORIGINAL_ZDOTDIR).toBe("/Users/test/.config/zsh");
    expect(prepared.env.ZDOTDIR).toMatch(/kmux-zsh-/);

    const wrapperDir = prepared.env.ZDOTDIR;
    expect(wrapperDir).toBeTruthy();
    if (!wrapperDir) {
      throw new Error("expected ZDOTDIR wrapper to be set");
    }
    expect(prepared.env.KMUX_AGENT_BIN_DIR).toBe(join(wrapperDir, "bin"));

    const zshrcWrapper = readFileSync(join(wrapperDir, ".zshrc"), "utf8");
    expect(zshrcWrapper).toContain('source "$KMUX_ZSH_INTEGRATION_SCRIPT"');
    expect(zshrcWrapper).toContain(
      'export ZDOTDIR="${_kmux_restored_zdotdir:-$KMUX_ORIGINAL_ZDOTDIR}"'
    );
    expect(zshrcWrapper).toContain(
      'export HISTFILE="${KMUX_ORIGINAL_HISTFILE:-${_kmux_restored_zdotdir:-$KMUX_ORIGINAL_ZDOTDIR}/.zsh_history}"'
    );
    expect(existsSync(join(wrapperDir, ".zlogin"))).toBe(false);
    expect(readFileSync(join(wrapperDir, ".zshenv"), "utf8")).toContain(
      'export KMUX_ORIGINAL_ZDOTDIR="$ZDOTDIR"'
    );
    expect(readFileSync(join(wrapperDir, ".zprofile"), "utf8")).toContain(
      'export KMUX_ORIGINAL_HISTFILE="$HISTFILE"'
    );

    const integrationScript = prepared.env.KMUX_ZSH_INTEGRATION_SCRIPT;
    expect(integrationScript).toBeTruthy();
    expect(existsSync(integrationScript ?? "")).toBe(true);
    const integrationContents = readFileSync(integrationScript ?? "", "utf8");
    expect(integrationContents).toContain(
      "add-zsh-hook precmd _kmux_emit_osc7"
    );
    expect(integrationContents).toContain("_kmux_prepend_agent_bin");
    expect(integrationContents).toContain('local agent_bin="${KMUX_AGENT_BIN_DIR:-}"');
    expect(integrationContents).toContain("typeset -g __KMUX_OSC7_INSTALLED=1");
    expect(integrationContents).not.toContain("typeset -gx");
    const agentHookHelper = join(wrapperDir, "bin", "kmux-agent-hook");
    expect(existsSync(agentHookHelper)).toBe(true);
    const agentHookRunner = join(wrapperDir, "bin", "kmux-agent-hook.cjs");
    expect(existsSync(agentHookRunner)).toBe(true);
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'kmux_dispatch_hook() {'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      '"$KMUX_NODE_RUNTIME" "$KMUX_AGENT_HELPER_PATH" "$@"'
    );
    expect(readFileSync(agentHookHelper, "utf8")).not.toContain(' -e ');
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'PATH="$(kmux_filter_path "${PATH:-}")"'
    );
    expect(readFileSync(agentHookHelper, "utf8")).not.toContain("KMUX_CLI_PATH");
    expect(readFileSync(agentHookRunner, "utf8")).toContain(
      'method: "agent.hook"'
    );
    expect(readFileSync(agentHookRunner, "utf8")).toContain(
      'const outputJson = process.env.KMUX_AGENT_HOOK_OUTPUT_MODE === "json";'
    );
    expect(existsSync(join(wrapperDir, "bin", "kmux-claude-launcher.cjs"))).toBe(
      false
    );
    expect(existsSync(join(wrapperDir, "bin", "claude"))).toBe(false);
    expect(existsSync(join(wrapperDir, "bin", "codex"))).toBe(true);
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'KMUX_CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'codex.wrapper.invoke'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'KMUX_DEBUG_LOG_PATH'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'TERM_SESSION_ID="${TERM_SESSION_ID:-}"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'KMUX_WRAPPER_STDIN_TTY="0"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'KMUX_WRAPPER_TTY_PATH="$(tty 2>/dev/null || true)"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'env ELECTRON_RUN_AS_NODE=1 "$KMUX_NODE_RUNTIME" <<'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      "kmux_sync_codex_home() {"
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      'export CODEX_HOME="$KMUX_WRAPPER_CODEX_HOME"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      "const managedEvents = ['SessionStart', 'UserPromptSubmit', 'Stop'];"
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      "kmux_has_notification_method_override() {"
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      "Codex downgrade needs_input notifications to BEL-only beeps"
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'set -- --enable codex_hooks "$@"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      'set -- --config tui.notification_method=osc9 "$@"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      '"$KMUX_REAL_CODEX" "$@" || KMUX_EXIT_CODE=$?'
    );
    expect(existsSync(join(wrapperDir, "bin", "gemini"))).toBe(false);
  });

  it("preserves explicit HISTFILE overrides when wrapping zsh", () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HISTFILE: "/Users/test/.local/share/zsh/history",
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    expect(prepared.env.KMUX_ORIGINAL_HISTFILE).toBe(
      "/Users/test/.local/share/zsh/history"
    );
  });

  it("wraps bash launches with a temporary home directory", () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/bash",
      ["--login"],
      {
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    expect(prepared.shellPath).toBe("/bin/bash");
    expect(prepared.args).toEqual(["--login"]);
    expect(prepared.env.HOME).toMatch(/kmux-bash-/);
    expect(prepared.env.KMUX_SHELL_INTEGRATION).toBe("1");
    expect(prepared.env.KMUX_ORIGINAL_HOME).toBe("/Users/test");

    const wrapperHome = prepared.env.HOME;
    expect(wrapperHome).toBeTruthy();
    if (!wrapperHome) {
      throw new Error("expected bash wrapper home to be set");
    }
    expect(prepared.env.KMUX_AGENT_BIN_DIR).toBe(join(wrapperHome, "bin"));

    expect(readFileSync(join(wrapperHome, ".bash_profile"), "utf8")).toContain(
      'source "$KMUX_BASH_INTEGRATION_SCRIPT"'
    );
    expect(readFileSync(join(wrapperHome, ".bashrc"), "utf8")).toContain(
      'source "$KMUX_BASH_INTEGRATION_SCRIPT"'
    );

    const integrationScript = prepared.env.KMUX_BASH_INTEGRATION_SCRIPT;
    expect(integrationScript).toBeTruthy();
    expect(readFileSync(integrationScript ?? "", "utf8")).toContain(
      'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_kmux_emit_osc7"'
    );
    expect(readFileSync(integrationScript ?? "", "utf8")).toContain(
      '_kmux_prepend_agent_bin'
    );
  });

  it("wraps fish launches with a temporary XDG config directory", () => {
    const prepared = prepareShellIntegrationLaunch(
      "/opt/homebrew/bin/fish",
      ["-l"],
      {
        HOME: "/Users/test",
        XDG_CONFIG_HOME: "/Users/test/.config"
      },
      { enabled: true }
    );

    expect(prepared.shellPath).toBe("/opt/homebrew/bin/fish");
    expect(prepared.args).toEqual(["-l"]);
    expect(prepared.env.XDG_CONFIG_HOME).toMatch(/kmux-fish-/);
    expect(prepared.env.KMUX_SHELL_INTEGRATION).toBe("1");
    expect(prepared.env.KMUX_ORIGINAL_XDG_CONFIG_HOME).toBe(
      "/Users/test/.config"
    );

    const wrapperConfigHome = prepared.env.XDG_CONFIG_HOME;
    expect(wrapperConfigHome).toBeTruthy();
    if (!wrapperConfigHome) {
      throw new Error("expected fish wrapper config root to be set");
    }
    expect(prepared.env.KMUX_AGENT_BIN_DIR).toBe(join(wrapperConfigHome, "bin"));

    expect(
      readFileSync(join(wrapperConfigHome, "fish", "config.fish"), "utf8")
    ).toContain('source "$KMUX_FISH_INTEGRATION_SCRIPT"');
    expect(
      readFileSync(join(wrapperConfigHome, "fish", "config.fish"), "utf8")
    ).toContain('for _kmux_config in "$XDG_CONFIG_HOME"/fish/conf.d/*.fish');

    const integrationScript = prepared.env.KMUX_FISH_INTEGRATION_SCRIPT;
    expect(integrationScript).toBeTruthy();
    const integrationContents = readFileSync(integrationScript ?? "", "utf8");
    expect(integrationContents).toContain("set -q KMUX_AGENT_BIN_DIR");
    expect(integrationContents).toContain(
      "function __kmux_emit_osc7 --on-event fish_prompt"
    );
    expect(integrationContents).toContain("set -g __KMUX_OSC7_INSTALLED 1");
    expect(integrationContents).not.toContain("set -gx __KMUX_OSC7");
  });

  it("forwards raw agent hooks directly to the kmux socket", async () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    const wrapperDir = prepared.env.ZDOTDIR;
    expect(wrapperDir).toBeTruthy();
    if (!wrapperDir) {
      throw new Error("expected ZDOTDIR wrapper to be set");
    }

    const agentHookHelper = join(wrapperDir, "bin", "kmux-agent-hook");
    const socketDir = mkdtempSync(join(tmpdir(), "kmux-hook-test-"));
    const socketPath = join(socketDir, "hook.sock");
    let request:
      | {
          jsonrpc?: string;
          method?: string;
          params?: Record<string, unknown>;
          id?: string;
        }
      | undefined;

    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          request = JSON.parse(line) as typeof request;
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request?.id,
                result: { ok: true }
              })}\n`
            );
            socket.end();
          }, 900);
        }
      });
      socket.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      expect(AGENT_HOOK_RPC_TIMEOUT_MS).toBeGreaterThan(900);
      const startedAt = Date.now();
      const child = spawn(agentHookHelper, ["codex", "Stop"], {
        env: {
          ...process.env,
          KMUX_AGENT_HOOK_OUTPUT_MODE: "json",
          KMUX_NODE_PATH: process.execPath,
          KMUX_SOCKET_PATH: socketPath,
          KMUX_WORKSPACE_ID: "workspace_1",
          KMUX_SURFACE_ID: "surface_1",
          KMUX_SESSION_ID: "session_1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.stdin.end(JSON.stringify({ message: "Done" }));

      const [exitCode] = (await once(child, "close")) as [number | null];
      const elapsedMs = Date.now() - startedAt;
      expect(exitCode).toBe(0);
      expect(elapsedMs).toBeGreaterThanOrEqual(850);
      expect(stdout.trim()).toBe("{}");
      expect(stderr).toBe("");
      expect(request).toMatchObject({
        jsonrpc: "2.0",
        method: "agent.hook",
        params: {
          agent: "codex",
          hookEvent: "Stop",
          workspaceId: "workspace_1",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Done"
          }
        }
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it("forces Codex to use osc9 notifications unless the caller overrides it", async () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    const wrapperDir = prepared.env.ZDOTDIR;
    expect(wrapperDir).toBeTruthy();
    if (!wrapperDir) {
      throw new Error("expected ZDOTDIR wrapper to be set");
    }

    const wrapperCodex = join(wrapperDir, "bin", "codex");
    const fakeCodexDir = mkdtempSync(join(tmpdir(), "kmux-fake-codex-"));
    const fakeCodex = join(fakeCodexDir, "codex");
    const capturePath = join(fakeCodexDir, "argv.txt");
    const fakeHome = mkdtempSync(join(tmpdir(), "kmux-fake-home-"));

    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        'capture_path="${KMUX_CAPTURE_ARGS_FILE:?}"',
        ': >"$capture_path"',
        'for arg in "$@"; do',
        '  printf "%s\\n" "$arg" >>"$capture_path"',
        "done",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodex, 0o755);

    async function runWrapper(args: string[]): Promise<string[]> {
      const child = spawn(wrapperCodex, args, {
        env: {
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeCodexDir}:${process.env.PATH ?? ""}`,
          KMUX_CAPTURE_ARGS_FILE: capturePath,
          KMUX_NODE_PATH: process.execPath,
          TERM_PROGRAM: "kmux"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      const [exitCode] = (await once(child, "close")) as [number | null];
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      return readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
    }

    try {
      const defaultArgs = await runWrapper(["status"]);
      expect(defaultArgs).toEqual([
        "--config",
        "tui.notification_method=osc9",
        "--enable",
        "codex_hooks",
        "status"
      ]);

      const explicitArgs = await runWrapper([
        "--config",
        "tui.notification_method=bel",
        "status"
      ]);
      expect(explicitArgs).toEqual([
        "--enable",
        "codex_hooks",
        "--config",
        "tui.notification_method=bel",
        "status"
      ]);
    } finally {
      rmSync(fakeCodexDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not rewrite unchanged Codex hooks.json across repeated wrapper runs", async () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    const wrapperDir = prepared.env.ZDOTDIR;
    expect(wrapperDir).toBeTruthy();
    if (!wrapperDir) {
      throw new Error("expected ZDOTDIR wrapper to be set");
    }

    const wrapperCodex = join(wrapperDir, "bin", "codex");
    const fakeCodexDir = mkdtempSync(join(tmpdir(), "kmux-fake-codex-"));
    const fakeCodex = join(fakeCodexDir, "codex");
    const fakeHome = mkdtempSync(join(tmpdir(), "kmux-fake-home-"));
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    const capturePath = join(fakeCodexDir, "argv.txt");

    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        'capture_path="${KMUX_CAPTURE_ARGS_FILE:?}"',
        ': >"$capture_path"',
        'for arg in "$@"; do',
        '  printf "%s\\n" "$arg" >>"$capture_path"',
        "done",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodex, 0o755);

    async function runWrapper(): Promise<void> {
      const child = spawn(wrapperCodex, ["status"], {
        env: {
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeCodexDir}:${process.env.PATH ?? ""}`,
          KMUX_CAPTURE_ARGS_FILE: capturePath,
          KMUX_NODE_PATH: process.execPath,
          TERM_PROGRAM: "kmux"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const [exitCode] = (await once(child, "close")) as [number | null];
      expect(exitCode).toBe(0);
    }

    try {
      await runWrapper();
      const firstContents = readFileSync(hooksPath, "utf8");
      const firstMtimeMs = statSync(hooksPath).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runWrapper();
      expect(readFileSync(hooksPath, "utf8")).toBe(firstContents);
      expect(statSync(hooksPath).mtimeMs).toBe(firstMtimeMs);
    } finally {
      rmSync(fakeCodexDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("leaves invalid Codex hooks.json untouched and skips codex_hooks enablement", async () => {
    const prepared = prepareShellIntegrationLaunch(
      "/bin/zsh",
      ["-l"],
      {
        HOME: "/Users/test"
      },
      { enabled: true }
    );

    const wrapperDir = prepared.env.ZDOTDIR;
    expect(wrapperDir).toBeTruthy();
    if (!wrapperDir) {
      throw new Error("expected ZDOTDIR wrapper to be set");
    }

    const wrapperCodex = join(wrapperDir, "bin", "codex");
    const fakeCodexDir = mkdtempSync(join(tmpdir(), "kmux-fake-codex-"));
    const fakeCodex = join(fakeCodexDir, "codex");
    const fakeHome = mkdtempSync(join(tmpdir(), "kmux-fake-home-"));
    const hooksDir = join(fakeHome, ".codex");
    const hooksPath = join(hooksDir, "hooks.json");
    const capturePath = join(fakeCodexDir, "argv.txt");

    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        'capture_path="${KMUX_CAPTURE_ARGS_FILE:?}"',
        ': >"$capture_path"',
        'for arg in "$@"; do',
        '  printf "%s\\n" "$arg" >>"$capture_path"',
        "done",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodex, 0o755);

    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hooksPath, "{broken json\n", "utf8");

    try {
      const child = spawn(wrapperCodex, ["status"], {
        env: {
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeCodexDir}:${process.env.PATH ?? ""}`,
          KMUX_CAPTURE_ARGS_FILE: capturePath,
          KMUX_NODE_PATH: process.execPath,
          TERM_PROGRAM: "kmux"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const [exitCode] = (await once(child, "close")) as [number | null];
      expect(exitCode).toBe(0);
      expect(readFileSync(hooksPath, "utf8")).toBe("{broken json\n");
      expect(
        readFileSync(capturePath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
      ).toEqual(["--config", "tui.notification_method=osc9", "status"]);
    } finally {
      rmSync(fakeCodexDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
