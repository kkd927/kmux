import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'kmux_dispatch_cli_hook() {'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'kmux_run_cli_hook_with_runtime "$(command -v node)" "$@" && return 0'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'env ELECTRON_RUN_AS_NODE=1 "$_kmux_runtime" "$KMUX_CLI_PATH" agent hook "$@" >/dev/null 2>&1'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'env ELECTRON_RUN_AS_NODE=1 "$_kmux_runtime" --import "$KMUX_CLI_TSX_LOADER_PATH" "$KMUX_CLI_PATH" agent hook "$@" >/dev/null 2>&1'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'PATH="$(kmux_filter_path "${PATH:-}")"'
    );
    expect(readFileSync(agentHookHelper, "utf8")).toContain(
      'cd "${KMUX_CLI_CWD}" || exit 1'
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
      'env ELECTRON_RUN_AS_NODE=1 "$KMUX_NODE_RUNTIME" <<'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      "kmux_sync_codex_home() {"
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      'export CODEX_HOME="$KMUX_WRAPPER_CODEX_HOME"'
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      '"SessionStart": ['
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).not.toContain(
      '"UserPromptSubmit": ['
    );
    expect(readFileSync(join(wrapperDir, "bin", "codex"), "utf8")).toContain(
      '"$KMUX_REAL_CODEX" --enable codex_hooks "$@" || KMUX_EXIT_CODE=$?'
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
});
