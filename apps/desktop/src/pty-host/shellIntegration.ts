import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  "KMUX_BASH_INTEGRATION_SCRIPT",
  "KMUX_FISH_INTEGRATION_SCRIPT",
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

  return {
    shellPath,
    args,
    env: {
      ...env,
      KMUX_SHELL_INTEGRATION: "1",
      KMUX_ORIGINAL_ZDOTDIR: env.ZDOTDIR?.trim() || homeDir,
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
  }

  if (options.restoreOriginalZdotdir) {
    lines.push('  _kmux_restored_zdotdir="${ZDOTDIR:-$KMUX_ORIGINAL_ZDOTDIR}"');
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
