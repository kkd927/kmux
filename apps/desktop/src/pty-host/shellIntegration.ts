import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { AGENT_HOOK_RPC_TIMEOUT_MS } from "@kmux/proto";

import { resolveDefaultShellArgs } from "./shellLaunch";

export interface PreparedShellLaunch {
  shellPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface PrepareShellIntegrationLaunchOptions {
  enabled?: boolean;
}

let cachedZshWrapperDir: string | null = null;
let cachedBashWrapperDir: string | null = null;
let cachedFishWrapperDir: string | null = null;
let cleanupRegistered = false;
const SHELL_INTEGRATION_ENV_KEYS = [
  "KMUX_AGENT_BIN_DIR",
  "KMUX_BASH_INTEGRATION_SCRIPT",
  "KMUX_FISH_INTEGRATION_SCRIPT",
  "KMUX_ORIGINAL_HISTFILE",
  "KMUX_ORIGINAL_HOME",
  "KMUX_ORIGINAL_XDG_CONFIG_HOME",
  "KMUX_ORIGINAL_ZDOTDIR",
  "KMUX_SHELL_INTEGRATION",
  "KMUX_ZSH_INTEGRATION_SCRIPT",
  "__KMUX_LAST_OSC7_PWD",
  "__KMUX_OSC7_HOST",
  "__KMUX_OSC7_INSTALLED"
] as const;

export function shouldApplyShellIntegration(
  shellPath: string | undefined,
  launchArgs: string[] | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "darwin" || launchArgs !== undefined || !shellPath) {
    return false;
  }
  if (!isSupportedIntegrationShell(shellPath)) {
    return false;
  }
  return resolveDefaultShellArgs(shellPath, platform).length > 0;
}

export function prepareShellIntegrationLaunch(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: PrepareShellIntegrationLaunchOptions = {}
): PreparedShellLaunch {
  const shellIntegrationEnv = stripShellIntegrationEnv(env);

  if (!options.enabled) {
    return {
      shellPath,
      args,
      env: shellIntegrationEnv
    };
  }

  switch (basename(shellPath).toLowerCase()) {
    case "zsh":
      return prepareZshShellLaunch(shellPath, args, shellIntegrationEnv);
    case "bash":
      return prepareBashShellLaunch(shellPath, args, shellIntegrationEnv);
    case "fish":
      return prepareFishShellLaunch(shellPath, args, shellIntegrationEnv);
    default:
      return {
        shellPath,
        args,
        env: shellIntegrationEnv
      };
  }
}

function stripShellIntegrationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let nextEnv: NodeJS.ProcessEnv | null = null;
  for (const key of SHELL_INTEGRATION_ENV_KEYS) {
    if (env[key] !== undefined) {
      nextEnv ??= { ...env };
      delete nextEnv[key];
    }
  }
  return nextEnv ?? env;
}

function isSupportedIntegrationShell(shellPath: string): boolean {
  switch (basename(shellPath).toLowerCase()) {
    case "zsh":
    case "bash":
    case "fish":
      return true;
    default:
      return false;
  }
}

function prepareZshShellLaunch(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): PreparedShellLaunch {
  const homeDir = env.HOME?.trim();
  if (!homeDir) {
    return {
      shellPath,
      args,
      env
    };
  }

  const wrapperDir = ensureZshWrapperDir();
  const originalZdotdir = env.ZDOTDIR?.trim() || homeDir;

  return {
    shellPath,
    args,
    env: {
      ...env,
      KMUX_AGENT_BIN_DIR: join(wrapperDir, "bin"),
      KMUX_ORIGINAL_HISTFILE:
        env.HISTFILE?.trim() || join(originalZdotdir, ".zsh_history"),
      KMUX_SHELL_INTEGRATION: "1",
      KMUX_ORIGINAL_ZDOTDIR: originalZdotdir,
      KMUX_ZSH_INTEGRATION_SCRIPT: join(wrapperDir, "kmux.zsh"),
      ZDOTDIR: wrapperDir
    }
  };
}

function prepareBashShellLaunch(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): PreparedShellLaunch {
  const homeDir = env.HOME?.trim();
  if (!homeDir) {
    return {
      shellPath,
      args,
      env
    };
  }

  const wrapperDir = ensureBashWrapperDir();

  return {
    shellPath,
    args,
    env: {
      ...env,
      HOME: wrapperDir,
      KMUX_AGENT_BIN_DIR: join(wrapperDir, "bin"),
      KMUX_BASH_INTEGRATION_SCRIPT: join(wrapperDir, "kmux.bash"),
      KMUX_SHELL_INTEGRATION: "1",
      KMUX_ORIGINAL_HOME: homeDir
    }
  };
}

function prepareFishShellLaunch(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): PreparedShellLaunch {
  const homeDir = env.HOME?.trim();
  if (!homeDir) {
    return {
      shellPath,
      args,
      env
    };
  }

  const wrapperDir = ensureFishWrapperDir();

  return {
    shellPath,
    args,
    env: {
      ...env,
      KMUX_AGENT_BIN_DIR: join(wrapperDir, "bin"),
      KMUX_FISH_INTEGRATION_SCRIPT: join(wrapperDir, "fish", "kmux.fish"),
      KMUX_ORIGINAL_XDG_CONFIG_HOME:
        env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config"),
      KMUX_SHELL_INTEGRATION: "1",
      XDG_CONFIG_HOME: wrapperDir
    }
  };
}

function ensureZshWrapperDir(): string {
  if (cachedZshWrapperDir) {
    return cachedZshWrapperDir;
  }

  const wrapperDir = mkdtempSync(join(tmpdir(), "kmux-zsh-"));
  writeAgentWrappers(wrapperDir);
  writeFileSync(
    join(wrapperDir, ".zshenv"),
    buildZshWrapper(".zshenv"),
    "utf8"
  );
  writeFileSync(
    join(wrapperDir, ".zprofile"),
    buildZshWrapper(".zprofile"),
    "utf8"
  );
  writeFileSync(
    join(wrapperDir, ".zshrc"),
    buildZshWrapper(".zshrc", {
      restoreOriginalZdotdir: true,
      sourceIntegrationScript: true
    }),
    "utf8"
  );
  writeFileSync(
    join(wrapperDir, "kmux.zsh"),
    buildZshIntegrationScript(),
    "utf8"
  );

  cachedZshWrapperDir = wrapperDir;
  registerCleanup();
  return wrapperDir;
}

function ensureBashWrapperDir(): string {
  if (cachedBashWrapperDir) {
    return cachedBashWrapperDir;
  }

  const wrapperDir = mkdtempSync(join(tmpdir(), "kmux-bash-"));
  writeAgentWrappers(wrapperDir);
  writeFileSync(
    join(wrapperDir, ".bash_profile"),
    buildBashProfileWrapper(),
    "utf8"
  );
  writeFileSync(join(wrapperDir, ".bashrc"), buildBashRcWrapper(), "utf8");
  writeFileSync(
    join(wrapperDir, "kmux.bash"),
    buildBashIntegrationScript(),
    "utf8"
  );

  cachedBashWrapperDir = wrapperDir;
  registerCleanup();
  return wrapperDir;
}

function ensureFishWrapperDir(): string {
  if (cachedFishWrapperDir) {
    return cachedFishWrapperDir;
  }

  const wrapperDir = mkdtempSync(join(tmpdir(), "kmux-fish-"));
  writeAgentWrappers(wrapperDir);
  const fishConfigDir = join(wrapperDir, "fish");
  mkdirSync(fishConfigDir, { recursive: true });
  writeFileSync(join(fishConfigDir, "config.fish"), buildFishWrapper(), "utf8");
  writeFileSync(
    join(fishConfigDir, "kmux.fish"),
    buildFishIntegrationScript(),
    "utf8"
  );

  cachedFishWrapperDir = wrapperDir;
  registerCleanup();
  return wrapperDir;
}

function registerCleanup(): void {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", () => {
      if (cachedZshWrapperDir) {
        rmSync(cachedZshWrapperDir, { force: true, recursive: true });
      }
      if (cachedBashWrapperDir) {
        rmSync(cachedBashWrapperDir, { force: true, recursive: true });
      }
      if (cachedFishWrapperDir) {
        rmSync(cachedFishWrapperDir, { force: true, recursive: true });
      }
    });
  }
}

function writeAgentWrappers(wrapperDir: string): void {
  const binDir = join(wrapperDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeExecutableFile(
    join(binDir, "kmux-agent-hook"),
    buildAgentHookHelperScript()
  );
  writeExecutableFile(join(binDir, "codex"), buildCodexWrapperScript());
}

function writeExecutableFile(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function buildZshWrapper(
  fileName: ".zshenv" | ".zprofile" | ".zshrc",
  options: {
    restoreOriginalZdotdir?: boolean;
    sourceIntegrationScript?: boolean;
  } = {}
): string {
  const lines = [
    'if [[ -n "${KMUX_ORIGINAL_ZDOTDIR:-}" ]]; then',
    '  _kmux_wrapper_zdotdir="$ZDOTDIR"',
    '  export ZDOTDIR="$KMUX_ORIGINAL_ZDOTDIR"',
    `  if [[ -f "$ZDOTDIR/${fileName}" ]]; then`,
    `    source "$ZDOTDIR/${fileName}"`,
    "  fi"
  ];

  if (!options.restoreOriginalZdotdir) {
    lines.push(
      '  if [[ -n "${ZDOTDIR:-}" && "$ZDOTDIR" != "$_kmux_wrapper_zdotdir" ]]; then'
    );
    lines.push('    export KMUX_ORIGINAL_ZDOTDIR="$ZDOTDIR"');
    lines.push("  fi");
    lines.push('  if [[ -n "${HISTFILE:-}" ]]; then');
    lines.push('    export KMUX_ORIGINAL_HISTFILE="$HISTFILE"');
    lines.push("  fi");
  }

  if (options.restoreOriginalZdotdir) {
    lines.push('  _kmux_restored_zdotdir="${ZDOTDIR:-$KMUX_ORIGINAL_ZDOTDIR}"');
    lines.push(
      '  if [[ "${HISTFILE:-}" == "$_kmux_wrapper_zdotdir/.zsh_history" ]]; then'
    );
    lines.push(
      '    export HISTFILE="${KMUX_ORIGINAL_HISTFILE:-${_kmux_restored_zdotdir:-$KMUX_ORIGINAL_ZDOTDIR}/.zsh_history}"'
    );
    lines.push("  fi");
  }

  if (options.sourceIntegrationScript) {
    lines.push('  if [[ -f "${KMUX_ZSH_INTEGRATION_SCRIPT:-}" ]]; then');
    lines.push('    source "$KMUX_ZSH_INTEGRATION_SCRIPT"');
    lines.push("  fi");
  }

  if (options.restoreOriginalZdotdir) {
    lines.push(
      '  export ZDOTDIR="${_kmux_restored_zdotdir:-$KMUX_ORIGINAL_ZDOTDIR}"'
    );
    lines.push("  unset _kmux_restored_zdotdir");
  } else {
    lines.push('  export ZDOTDIR="$_kmux_wrapper_zdotdir"');
  }

  lines.push("  unset _kmux_wrapper_zdotdir");
  lines.push("fi");
  lines.push("");

  return lines.join("\n");
}

function buildZshIntegrationScript(): string {
  return [
    '[[ "${KMUX_SHELL_INTEGRATION:-}" == "1" ]] || return 0',
    "[[ -o interactive ]] || return 0",
    '[[ -z "${__KMUX_OSC7_INSTALLED:-}" ]] || return 0',
    "typeset -g __KMUX_OSC7_INSTALLED=1",
    "",
    "autoload -Uz add-zsh-hook",
    "",
    "function _kmux_prepend_agent_bin() {",
    "  emulate -L zsh",
    '  local agent_bin="${KMUX_AGENT_BIN_DIR:-}"',
    '  [[ -n "$agent_bin" && -d "$agent_bin" ]] || return 0',
    '  case ":${PATH:-}:" in',
    '    *":${agent_bin}:"*) ;;',
    '    *) path=("$agent_bin" $path); export PATH ;;',
    "  esac",
    "}",
    "",
    "function _kmux_percent_encode() {",
    "  emulate -L zsh",
    "  local LC_ALL=C",
    '  local input="${1-}"',
    '  local output=""',
    "  local index char encoded",
    "  for (( index = 1; index <= ${#input}; index += 1 )); do",
    '    char="${input[index]}"',
    '    case "$char" in',
    "      [a-zA-Z0-9.~/_-])",
    '        output+="$char"',
    "        ;;",
    "      *)",
    "        printf -v encoded '%%%02X' \"'$char\"",
    '        output+="$encoded"',
    "        ;;",
    "    esac",
    "  done",
    '  print -nr -- "$output"',
    "}",
    "",
    "function _kmux_emit_osc7() {",
    "  emulate -L zsh",
    '  local pwd_path="${PWD:-}"',
    '  [[ -n "$pwd_path" ]] || return 0',
    '  [[ "$pwd_path" == "${__KMUX_LAST_OSC7_PWD:-}" ]] && return 0',
    '  typeset -g __KMUX_LAST_OSC7_PWD="$pwd_path"',
    "  local host_part path_part",
    '  host_part="$(_kmux_percent_encode "${HOST:-localhost}")"',
    '  path_part="$(_kmux_percent_encode "$pwd_path")"',
    "  printf '\\e]7;%s\\a' \"file://${host_part}${path_part}\"",
    "}",
    "",
    "_kmux_prepend_agent_bin",
    "unfunction _kmux_prepend_agent_bin",
    "",
    "add-zsh-hook precmd _kmux_emit_osc7",
    ""
  ].join("\n");
}

function buildBashProfileWrapper(): string {
  return [
    'if [[ -n "${KMUX_ORIGINAL_HOME:-}" ]]; then',
    '  export HOME="$KMUX_ORIGINAL_HOME"',
    '  if [[ -f "$HOME/.bash_profile" ]]; then',
    '    source "$HOME/.bash_profile"',
    '  elif [[ -f "$HOME/.bash_login" ]]; then',
    '    source "$HOME/.bash_login"',
    '  elif [[ -f "$HOME/.profile" ]]; then',
    '    source "$HOME/.profile"',
    "  fi",
    '  if [[ -f "${KMUX_BASH_INTEGRATION_SCRIPT:-}" ]]; then',
    '    source "$KMUX_BASH_INTEGRATION_SCRIPT"',
    "  fi",
    "fi",
    ""
  ].join("\n");
}

function buildBashRcWrapper(): string {
  return [
    'if [[ -n "${KMUX_ORIGINAL_HOME:-}" ]]; then',
    '  export HOME="$KMUX_ORIGINAL_HOME"',
    '  if [[ -f "$HOME/.bashrc" ]]; then',
    '    source "$HOME/.bashrc"',
    "  fi",
    '  if [[ -f "${KMUX_BASH_INTEGRATION_SCRIPT:-}" ]]; then',
    '    source "$KMUX_BASH_INTEGRATION_SCRIPT"',
    "  fi",
    "fi",
    ""
  ].join("\n");
}

function buildBashIntegrationScript(): string {
  return [
    '[[ "${KMUX_SHELL_INTEGRATION:-}" == "1" ]] || return 0',
    '[[ "$-" == *i* ]] || return 0',
    '[[ -z "${__KMUX_OSC7_INSTALLED:-}" ]] || return 0',
    "__KMUX_OSC7_INSTALLED=1",
    "",
    "_kmux_prepend_agent_bin() {",
    '  local agent_bin="${KMUX_AGENT_BIN_DIR:-}"',
    '  [[ -n "$agent_bin" && -d "$agent_bin" ]] || return 0',
    '  case ":${PATH:-}:" in',
    '    *":${agent_bin}:"*) ;;',
    '    *) PATH="$agent_bin${PATH:+:$PATH}" ;;',
    "  esac",
    "}",
    "",
    "_kmux_percent_encode() {",
    "  local LC_ALL=C",
    '  local input="${1-}"',
    '  local output=""',
    "  local index char encoded",
    "  for ((index = 0; index < ${#input}; index += 1)); do",
    '    char="${input:index:1}"',
    '    case "$char" in',
    "      [a-zA-Z0-9.~/_-])",
    '        output+="$char"',
    "        ;;",
    "      *)",
    "        printf -v encoded '%%%02X' \"'$char\"",
    '        output+="$encoded"',
    "        ;;",
    "    esac",
    "  done",
    '  printf "%s" "$output"',
    "}",
    "",
    "_kmux_emit_osc7() {",
    '  local pwd_path="${PWD:-}"',
    '  [[ -n "$pwd_path" ]] || return 0',
    '  [[ "$pwd_path" == "${__KMUX_LAST_OSC7_PWD:-}" ]] && return 0',
    '  __KMUX_LAST_OSC7_PWD="$pwd_path"',
    "  local host_part path_part",
    '  host_part="$(_kmux_percent_encode "${HOSTNAME:-localhost}")"',
    '  path_part="$(_kmux_percent_encode "$pwd_path")"',
    '  printf \'\\033]7;file://%s%s\\a\' "$host_part" "$path_part"',
    "}",
    "",
    '_kmux_prompt_decl="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"',
    'case "$_kmux_prompt_decl" in',
    '  "declare -a PROMPT_COMMAND="*)',
    "    _kmux_prompt_found=0",
    '    for _kmux_prompt_command in "${PROMPT_COMMAND[@]}"; do',
    '      if [[ "$_kmux_prompt_command" == "_kmux_emit_osc7" ]]; then',
    "        _kmux_prompt_found=1",
    "        break",
    "      fi",
    "    done",
    '    if [[ "$_kmux_prompt_found" -eq 0 ]]; then',
    "      PROMPT_COMMAND+=(_kmux_emit_osc7)",
    "    fi",
    "    unset _kmux_prompt_command _kmux_prompt_found",
    "    ;;",
    "  *)",
    '    case ";${PROMPT_COMMAND:-};" in',
    '      *";_kmux_emit_osc7;"*) ;;',
    '      *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_kmux_emit_osc7" ;;',
    "    esac",
    "    ;;",
    "esac",
    "unset _kmux_prompt_decl",
    "",
    "_kmux_prepend_agent_bin",
    "unset -f _kmux_prepend_agent_bin",
    "",
    "_kmux_emit_osc7",
    ""
  ].join("\n");
}

function buildFishWrapper(): string {
  return [
    "if set -q KMUX_ORIGINAL_XDG_CONFIG_HOME",
    '  set -gx XDG_CONFIG_HOME "$KMUX_ORIGINAL_XDG_CONFIG_HOME"',
    '  for _kmux_config in "$XDG_CONFIG_HOME"/fish/conf.d/*.fish',
    '    if test -f "$_kmux_config"',
    '      source "$_kmux_config"',
    "    end",
    "  end",
    "  set -e _kmux_config",
    '  if test -f "$XDG_CONFIG_HOME/fish/config.fish"',
    '    source "$XDG_CONFIG_HOME/fish/config.fish"',
    "  end",
    '  if test -f "$KMUX_FISH_INTEGRATION_SCRIPT"',
    '    source "$KMUX_FISH_INTEGRATION_SCRIPT"',
    "  end",
    "end",
    ""
  ].join("\n");
}

function buildFishIntegrationScript(): string {
  return [
    'test "$KMUX_SHELL_INTEGRATION" = "1"; or return 0',
    "status is-interactive; or return 0",
    "set -q __KMUX_OSC7_INSTALLED; and return 0",
    "set -g __KMUX_OSC7_INSTALLED 1",
    "",
    'if set -q KMUX_AGENT_BIN_DIR; and test -d "$KMUX_AGENT_BIN_DIR"',
    '  contains -- "$KMUX_AGENT_BIN_DIR" $PATH; or set -gx PATH "$KMUX_AGENT_BIN_DIR" $PATH',
    "end",
    "",
    "function __kmux_percent_encode",
    '  string escape --style=url -- $argv[1] | string replace -a "%2F" "/"',
    "end",
    "",
    "set -g __KMUX_OSC7_HOST (__kmux_percent_encode (hostname))",
    "",
    "function __kmux_emit_osc7 --on-event fish_prompt",
    '  set -l pwd_path "$PWD"',
    '  test -n "$pwd_path"; or return 0',
    '  if set -q __KMUX_LAST_OSC7_PWD; and test "$__KMUX_LAST_OSC7_PWD" = "$pwd_path"',
    "    return 0",
    "  end",
    '  set -g __KMUX_LAST_OSC7_PWD "$pwd_path"',
    '  set -l path_part (__kmux_percent_encode "$pwd_path")',
    '  printf \'\\033]7;file://%s%s\\a\' "$__KMUX_OSC7_HOST" "$path_part"',
    "end",
    "",
    "__kmux_emit_osc7",
    ""
  ].join("\n");
}

function buildPathFilteringHelperLines(): string[] {
  return [
    "kmux_filter_path() {",
    '  _kmux_input_path="${1-}"',
    '  _kmux_result=""',
    "  _kmux_result_set=0",
    "  while :; do",
    '    case "$_kmux_input_path" in',
    "      *:*)",
    '        _kmux_segment="${_kmux_input_path%%:*}"',
    '        _kmux_input_path="${_kmux_input_path#*:}"',
    "        ;;",
    "      *)",
    '        _kmux_segment="$_kmux_input_path"',
    '        _kmux_input_path=""',
    "        ;;",
    "    esac",
    '    if [ "$_kmux_segment" != "$KMUX_AGENT_BIN_DIR" ]; then',
    '      if [ "$_kmux_result_set" -eq 0 ]; then',
    '        _kmux_result="$_kmux_segment"',
    "        _kmux_result_set=1",
    "      else",
    '        _kmux_result="${_kmux_result}:$_kmux_segment"',
    "      fi",
    "    fi",
    '    [ -n "$_kmux_input_path" ] || break',
    "  done",
    '  printf "%s" "$_kmux_result"',
    "}",
    ""
  ];
}

function buildNodeRuntimeResolverLines(): string[] {
  return [
    "kmux_resolve_node_runtime() {",
    '  if [ -n "${KMUX_NODE_PATH:-}" ] && [ -x "${KMUX_NODE_PATH}" ]; then',
    '    printf "%s" "$KMUX_NODE_PATH"',
    "    return 0",
    "  fi",
    "  if command -v node >/dev/null 2>&1; then",
    "    command -v node",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    ""
  ];
}

function escapeForSingleQuotedShell(source: string): string {
  return source.replace(/'/g, `'"'"'`);
}

function buildAgentHookInlineScript(): string {
  return `
const net = require("node:net");

const outputJson = process.env.KMUX_AGENT_HOOK_OUTPUT_MODE === "json";

function emitResponse() {
  if (outputJson) {
    process.stdout.write("{}\\n");
  }
}

function finish() {
  emitResponse();
  process.exit(0);
}

function buildParams(payload) {
  return {
    agent: process.env.KMUX_HOOK_AGENT,
    hookEvent: process.env.KMUX_HOOK_EVENT,
    payload,
    workspaceId: process.env.KMUX_WORKSPACE_ID || undefined,
    paneId: process.env.KMUX_PANE_ID || undefined,
    surfaceId: process.env.KMUX_SURFACE_ID || undefined,
    sessionId: process.env.KMUX_SESSION_ID || undefined,
    authToken: process.env.KMUX_AUTH_TOKEN || undefined,
  };
}

function connectAndSend(payload) {
  const socketPath = process.env.KMUX_SOCKET_PATH;
  const agent = process.env.KMUX_HOOK_AGENT;
  const hookEvent = process.env.KMUX_HOOK_EVENT;
  if (!socketPath || !agent || !hookEvent) {
    finish();
    return;
  }

  const socket = net.createConnection(socketPath);
  let settled = false;
  let buffer = "";

  const timeout = setTimeout(() => {
    complete();
  }, ${AGENT_HOOK_RPC_TIMEOUT_MS});

  function complete() {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    socket.destroy();
    finish();
  }

  socket.on("connect", () => {
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "hook_" + Date.now().toString(36),
        method: "agent.hook",
        params: buildParams(payload),
      }) + "\\n"
    );
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.includes("\\n")) {
      complete();
    }
  });

  socket.on("error", () => {
    complete();
  });

  socket.on("close", () => {
    complete();
  });
}

function forwardFromStdin() {
  if (process.stdin.isTTY) {
    connectAndSend({});
    return;
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("error", () => {
    finish();
  });
  process.stdin.on("end", () => {
    const trimmed = input.trim();
    if (!trimmed) {
      connectAndSend({});
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        connectAndSend(parsed);
        return;
      }
    } catch {}
    connectAndSend({});
  });
  process.stdin.resume();
}

forwardFromStdin();
`.trim();
}

function buildAgentHookHelperScript(): string {
  const inlineScript = escapeForSingleQuotedShell(
    buildAgentHookInlineScript()
  );

  return [
    "#!/bin/sh",
    'KMUX_AGENT_HOOK_OUTPUT_MODE="${KMUX_AGENT_HOOK_OUTPUT_MODE:-silent}"',
    'if [ "$#" -lt 2 ]; then',
    '  if [ "$KMUX_AGENT_HOOK_OUTPUT_MODE" = "json" ]; then',
    '    printf "{}\\n"',
    "  fi",
    "  exit 0",
    "fi",
    "",
    'KMUX_AGENT_BIN_DIR="${KMUX_AGENT_BIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"',
    ...buildPathFilteringHelperLines(),
    ...buildNodeRuntimeResolverLines(),
    'PATH="$(kmux_filter_path "${PATH:-}")"',
    "export PATH",
    "kmux_dispatch_hook() {",
    '  KMUX_NODE_RUNTIME="$(kmux_resolve_node_runtime 2>/dev/null || true)"',
    '  [ -n "$KMUX_NODE_RUNTIME" ] || return 1',
    '  [ -n "${KMUX_SOCKET_PATH:-}" ] || return 1',
    '  if [ "$KMUX_AGENT_HOOK_OUTPUT_MODE" = "json" ]; then',
    `    env KMUX_HOOK_AGENT="$1" KMUX_HOOK_EVENT="$2" ELECTRON_RUN_AS_NODE=1 "$KMUX_NODE_RUNTIME" -e '${inlineScript}' 2>/dev/null`,
    "    return $?",
    "  fi",
    `  env KMUX_HOOK_AGENT="$1" KMUX_HOOK_EVENT="$2" ELECTRON_RUN_AS_NODE=1 "$KMUX_NODE_RUNTIME" -e '${inlineScript}' >/dev/null 2>&1`,
    "  return $?",
    "}",
    "",
    'if kmux_dispatch_hook "$@"; then',
    "  exit 0",
    "fi",
    "",
    'if [ "$KMUX_AGENT_HOOK_OUTPUT_MODE" = "json" ]; then',
    '  printf "{}\\n"',
    "fi",
    "",
    "exit 0",
    ""
  ].join("\n");
}

function buildCodexWrapperScript(): string {
  return [
    "#!/bin/sh",
    "set -u",
    "",
    'KMUX_AGENT_BIN_DIR="${KMUX_AGENT_BIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"',
    ...buildPathFilteringHelperLines(),
    ...buildNodeRuntimeResolverLines(),
    'PATH="$(kmux_filter_path "${PATH:-}")"',
    "export PATH",
    "",
    'KMUX_REAL_CODEX="$(command -v codex 2>/dev/null || true)"',
    'if [ -z "$KMUX_REAL_CODEX" ] || [ "$KMUX_REAL_CODEX" = "$0" ]; then',
    "  exit 127",
    "fi",
    "",
    'KMUX_NODE_RUNTIME="$(kmux_resolve_node_runtime 2>/dev/null || true)"',
    'KMUX_CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"',
    "",
    "kmux_log_codex_wrapper() {",
    '  [ -n "${KMUX_DEBUG_LOG_PATH:-}" ] || return 0',
    '  [ -n "${KMUX_NODE_RUNTIME:-}" ] || return 0',
    '  KMUX_WRAPPER_STDIN_TTY="0"',
    '  KMUX_WRAPPER_STDOUT_TTY="0"',
    '  KMUX_WRAPPER_STDERR_TTY="0"',
    '  [ -t 0 ] && KMUX_WRAPPER_STDIN_TTY="1"',
    '  [ -t 1 ] && KMUX_WRAPPER_STDOUT_TTY="1"',
    '  [ -t 2 ] && KMUX_WRAPPER_STDERR_TTY="1"',
    '  KMUX_WRAPPER_TTY_PATH="$(tty 2>/dev/null || true)"',
    '  env KMUX_DEBUG_LOG_SCOPE="codex.wrapper.invoke" \\',
    '    KMUX_DEBUG_LOG_PATH="${KMUX_DEBUG_LOG_PATH}" \\',
    '    KMUX_DEBUG_LOG_PID="$$" \\',
    '    KMUX_REAL_CODEX="${KMUX_REAL_CODEX:-}" \\',
    '    KMUX_NODE_RUNTIME="${KMUX_NODE_RUNTIME:-}" \\',
    '    KMUX_CODEX_HOME="${KMUX_CODEX_HOME:-}" \\',
    '    KMUX_USE_CODEX_HOOKS="${KMUX_USE_CODEX_HOOKS:-0}" \\',
    '    KMUX_AGENT_BIN_DIR="${KMUX_AGENT_BIN_DIR:-}" \\',
    '    KMUX_SHELL_INTEGRATION="${KMUX_SHELL_INTEGRATION:-}" \\',
    '    KMUX_ORIGINAL_HOME="${KMUX_ORIGINAL_HOME:-}" \\',
    '    KMUX_ORIGINAL_ZDOTDIR="${KMUX_ORIGINAL_ZDOTDIR:-}" \\',
    '    KMUX_ORIGINAL_XDG_CONFIG_HOME="${KMUX_ORIGINAL_XDG_CONFIG_HOME:-}" \\',
    '    PATH="${PATH:-}" \\',
    '    HOME="${HOME:-}" \\',
    '    SHELL="${SHELL:-}" \\',
    '    TERM="${TERM:-}" \\',
    '    TERM_PROGRAM="${TERM_PROGRAM:-}" \\',
    '    TERM_SESSION_ID="${TERM_SESSION_ID:-}" \\',
    '    LC_TERMINAL="${LC_TERMINAL:-}" \\',
    '    LC_TERMINAL_VERSION="${LC_TERMINAL_VERSION:-}" \\',
    '    ITERM_SESSION_ID="${ITERM_SESSION_ID:-}" \\',
    '    COLORTERM="${COLORTERM:-}" \\',
    '    TMUX="${TMUX:-}" \\',
    '    TMUX_PANE="${TMUX_PANE:-}" \\',
    '    STY="${STY:-}" \\',
    '    SSH_TTY="${SSH_TTY:-}" \\',
    '    INSIDE_EMACS="${INSIDE_EMACS:-}" \\',
    '    PWD="${PWD:-}" \\',
    '    ZDOTDIR="${ZDOTDIR:-}" \\',
    '    XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}" \\',
    '    KMUX_WORKSPACE_ID="${KMUX_WORKSPACE_ID:-}" \\',
    '    KMUX_PANE_ID="${KMUX_PANE_ID:-}" \\',
    '    KMUX_SURFACE_ID="${KMUX_SURFACE_ID:-}" \\',
    '    KMUX_SESSION_ID="${KMUX_SESSION_ID:-}" \\',
    '    KMUX_WRAPPER_STDIN_TTY="${KMUX_WRAPPER_STDIN_TTY}" \\',
    '    KMUX_WRAPPER_STDOUT_TTY="${KMUX_WRAPPER_STDOUT_TTY}" \\',
    '    KMUX_WRAPPER_STDERR_TTY="${KMUX_WRAPPER_STDERR_TTY}" \\',
    '    KMUX_WRAPPER_TTY_PATH="${KMUX_WRAPPER_TTY_PATH:-}" \\',
    "    ELECTRON_RUN_AS_NODE=1 \"$KMUX_NODE_RUNTIME\" <<'EOF' >/dev/null 2>&1 || true",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "",
    "const logPath = process.env.KMUX_DEBUG_LOG_PATH;",
    "if (!logPath) {",
    "  process.exit(0);",
    "}",
    "",
    "const record = {",
    "  scope: process.env.KMUX_DEBUG_LOG_SCOPE || 'codex.wrapper.invoke',",
    "  shellPid: process.env.KMUX_DEBUG_LOG_PID || '',",
    "  realCodex: process.env.KMUX_REAL_CODEX || '',",
    "  nodeRuntime: process.env.KMUX_NODE_RUNTIME || '',",
    "  codexHome: process.env.KMUX_CODEX_HOME || '',",
    "  useCodexHooks: process.env.KMUX_USE_CODEX_HOOKS || '0',",
    "  agentBinDir: process.env.KMUX_AGENT_BIN_DIR || '',",
    "  shellIntegration: process.env.KMUX_SHELL_INTEGRATION || '',",
    "  originalHome: process.env.KMUX_ORIGINAL_HOME || '',",
    "  originalZdotdir: process.env.KMUX_ORIGINAL_ZDOTDIR || '',",
    "  originalXdgConfigHome: process.env.KMUX_ORIGINAL_XDG_CONFIG_HOME || '',",
    "  path: process.env.PATH || '',",
    "  home: process.env.HOME || '',",
    "  shell: process.env.SHELL || '',",
    "  term: process.env.TERM || '',",
    "  termProgram: process.env.TERM_PROGRAM || '',",
    "  termSessionId: process.env.TERM_SESSION_ID || '',",
    "  lcTerminal: process.env.LC_TERMINAL || '',",
    "  lcTerminalVersion: process.env.LC_TERMINAL_VERSION || '',",
    "  itermSessionId: process.env.ITERM_SESSION_ID || '',",
    "  colorTerm: process.env.COLORTERM || '',",
    "  tmux: process.env.TMUX || '',",
    "  tmuxPane: process.env.TMUX_PANE || '',",
    "  sty: process.env.STY || '',",
    "  sshTty: process.env.SSH_TTY || '',",
    "  insideEmacs: process.env.INSIDE_EMACS || '',",
    "  pwd: process.env.PWD || '',",
    "  zdotdir: process.env.ZDOTDIR || '',",
    "  xdgConfigHome: process.env.XDG_CONFIG_HOME || '',",
    "  workspaceId: process.env.KMUX_WORKSPACE_ID || '',",
    "  paneId: process.env.KMUX_PANE_ID || '',",
    "  surfaceId: process.env.KMUX_SURFACE_ID || '',",
    "  sessionId: process.env.KMUX_SESSION_ID || '',",
    "  wrapperStdinTTY: process.env.KMUX_WRAPPER_STDIN_TTY === '1',",
    "  wrapperStdoutTTY: process.env.KMUX_WRAPPER_STDOUT_TTY === '1',",
    "  wrapperStderrTTY: process.env.KMUX_WRAPPER_STDERR_TTY === '1',",
    "  wrapperTTYPath: process.env.KMUX_WRAPPER_TTY_PATH || '',",
    "  loggerStdoutIsTTY: Boolean(process.stdout.isTTY),",
    "  loggerStdinIsTTY: Boolean(process.stdin.isTTY),",
    "};",
    "",
    "fs.mkdirSync(path.dirname(logPath), { recursive: true });",
    "fs.appendFileSync(",
    "  logPath,",
    "  `${new Date().toISOString()} pid=${process.env.KMUX_DEBUG_LOG_PID || process.pid} ${JSON.stringify(record)}\\n`,",
    "  'utf8'",
    ");",
    "EOF",
    "}",
    "",
    'KMUX_USE_CODEX_HOOKS="0"',
    'if [ -n "$KMUX_CODEX_HOME" ] && [ -n "$KMUX_NODE_RUNTIME" ]; then',
    '  KMUX_OUTPUT_HOOKS_FILE="$KMUX_CODEX_HOME/hooks.json" \\',
    "  env ELECTRON_RUN_AS_NODE=1 \"$KMUX_NODE_RUNTIME\" <<'EOF'",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "",
    "const outputPath = process.env.KMUX_OUTPUT_HOOKS_FILE;",
    "const managedHookMarker = 'KMUX_MANAGED_CODEX_HOOK=1';",
    "",
    "if (!outputPath) {",
    "  process.exit(0);",
    "}",
    "",
    "function asObject(value) {",
    "  return value && typeof value === 'object' && !Array.isArray(value)",
    "    ? value",
    "    : {};",
    "}",
    "",
    "function asArray(value) {",
    "  return Array.isArray(value) ? value : [];",
    "}",
    "",
    "function buildHookDefinition(eventName) {",
    "  return {",
    "    hooks: [",
    "      {",
    "        type: 'command',",
    "        command: managedHookMarker + '; [ -n \"${KMUX_SOCKET_PATH:-}\" ] || exit 0; [ -n \"${KMUX_AGENT_BIN_DIR:-}\" ] || exit 0; [ -x \"${KMUX_AGENT_BIN_DIR}/kmux-agent-hook\" ] || exit 0; \"${KMUX_AGENT_BIN_DIR}/kmux-agent-hook\" codex ' + eventName + ' || true',",
    "      },",
    "    ],",
    "  };",
    "}",
    "",
    "function readHooks(filePath) {",
    "  try {",
    "    return asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));",
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    "",
    "const managedEvents = ['SessionStart', 'UserPromptSubmit', 'Stop'];",
    "",
    "function isManagedHook(hook, eventName) {",
    "  return hook && typeof hook === 'object' && !Array.isArray(hook)",
    "    && Array.isArray(hook.hooks)",
    "    && hook.hooks.some((entry) =>",
    "      entry && typeof entry === 'object' && entry.type === 'command'",
    "      && typeof entry.command === 'string'",
    "      && entry.command.includes(managedHookMarker)",
    "      && entry.command.includes(' codex ' + eventName)",
    "    );",
    "}",
    "",
    "const baseHooksConfig = readHooks(outputPath);",
    "const baseHooks = asObject(baseHooksConfig.hooks);",
    "const managedHookEntries = Object.fromEntries(",
    "  managedEvents.map((eventName) => [",
    "    eventName,",
    "    [",
    "      ...asArray(baseHooks[eventName]).filter((hook) => !isManagedHook(hook, eventName)),",
    "      buildHookDefinition(eventName),",
    "    ],",
    "  ])",
    ");",
    "",
    "const mergedHooks = {",
    "  ...baseHooksConfig,",
    "  hooks: {",
    "    ...baseHooks,",
    "    ...managedHookEntries,",
    "  },",
    "};",
    "",
    "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
    "fs.writeFileSync(outputPath, JSON.stringify(mergedHooks), 'utf8');",
    "EOF",
    '  KMUX_USE_CODEX_HOOKS="1"',
    "fi",
    "# History: kmux sets TERM_PROGRAM=kmux for child PTYs. Codex TUI currently",
    "# only auto-selects OSC 9 notifications for a small terminal allowlist",
    "# (for example WezTerm/ghostty/iTerm hints). In packaged/Dock launches this",
    "# made Codex downgrade needs_input notifications to BEL-only beeps, so we",
    "# force OSC 9 for kmux-managed Codex runs until upstream supports kmux or",
    "# capability-based detection. Explicit user -c/--config overrides still win.",
    "kmux_has_notification_method_override() {",
    '  _kmux_expect_config_value="0"',
    '  for _kmux_arg in "$@"; do',
    '    if [ "$_kmux_expect_config_value" = "1" ]; then',
    '      case "$_kmux_arg" in',
    '        tui.notification_method=*) return 0 ;;',
    "      esac",
    '      _kmux_expect_config_value="0"',
    "      continue",
    "    fi",
    '    case "$_kmux_arg" in',
    '      --config|-c)',
    '        _kmux_expect_config_value="1"',
    "        ;;",
    '      --config=tui.notification_method=*|-ctui.notification_method=*)',
    "        return 0",
    "        ;;",
    "    esac",
    "  done",
    "  return 1",
    "}",
    "kmux_log_codex_wrapper",
    "",
    "KMUX_EXIT_CODE=0",
    'if [ "$KMUX_USE_CODEX_HOOKS" = "1" ]; then',
    '  set -- --enable codex_hooks "$@"',
    "fi",
    'if ! kmux_has_notification_method_override "$@"; then',
    '  set -- --config tui.notification_method=osc9 "$@"',
    "fi",
    '  "$KMUX_REAL_CODEX" "$@" || KMUX_EXIT_CODE=$?',
    'exit "$KMUX_EXIT_CODE"',
    ""
  ].join("\n");
}
