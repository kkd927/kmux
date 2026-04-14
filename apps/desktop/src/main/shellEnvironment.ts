import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {userInfo} from "node:os";
import {basename} from "node:path";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

const PLATFORM_FALLBACK_SHELLS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/bin/zsh",
  linux: "/bin/bash"
};

export interface ResolvedShellEnv {
  shellPath: string;
  baseEnv: NodeJS.ProcessEnv;
  source: "resolved" | "fallback";
}

export interface ShellCommandExecutorOptions {
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

export type ShellCommandExecutor = (
  command: string,
  args: string[],
  options: ShellCommandExecutorOptions
) => Promise<{stdout: string; stderr: string}>;

interface ResolveShellEnvironmentOptions {
  preferredShell?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  userShell?: string;
  timeoutMs?: number;
  processExecPath?: string;
  randomToken?: string;
  exec?: ShellCommandExecutor;
}

export function resolveShellPath(
  preferredShell: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userShellPath = readUserShell()
): string {
  const configuredShell = preferredShell?.trim();
  if (configuredShell) {
    return configuredShell;
  }

  const inheritedShell = env.SHELL?.trim();
  if (inheritedShell) {
    return inheritedShell;
  }

  const accountShell = userShellPath?.trim();
  if (accountShell) {
    return accountShell;
  }

  return PLATFORM_FALLBACK_SHELLS[platform] ?? "/bin/sh";
}

export function buildShellEnvProbeArgs(
  shellPath: string,
  processExecPath: string,
  marker: string
): string[] {
  const command = buildShellEnvProbeCommand(shellPath, processExecPath, marker);

  if (isPowerShell(shellPath)) {
    return ["-Login", "-Command", command];
  }

  return ["-i", "-l", "-c", command];
}

export function parseShellEnvOutput(
  stdout: string,
  marker: string
): NodeJS.ProcessEnv {
  const startIndex = stdout.indexOf(marker);
  const endIndex = stdout.lastIndexOf(marker);

  if (startIndex === -1 || endIndex === -1 || startIndex === endIndex) {
    throw new Error("shell env marker not found in probe output");
  }

  const rawPayload = stdout
    .slice(startIndex + marker.length, endIndex)
    .trim();
  const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return env;
}

export async function resolveShellEnvironment(
  options: ResolveShellEnvironmentOptions = {}
): Promise<ResolvedShellEnv> {
  const inheritedEnv = options.env ?? process.env;
  const shellPath = resolveShellPath(
    options.preferredShell,
    inheritedEnv,
    options.platform,
    options.userShell
  );
  const baseEnv = sanitizeInheritedEnv(inheritedEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const processExecPath = options.processExecPath ?? process.execPath;
  const marker = options.randomToken ?? `__kmux_shell_env__${randomUUID()}`;
  const exec = options.exec ?? defaultShellCommandExecutor;

  try {
    const {stdout} = await exec(
      shellPath,
      buildShellEnvProbeArgs(shellPath, processExecPath, marker),
      {
        env: baseEnv,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER
      }
    );
    const resolvedEnv = sanitizeInheritedEnv(parseShellEnvOutput(stdout, marker));
    resolvedEnv.SHELL ??= shellPath;
    return {
      shellPath,
      baseEnv: resolvedEnv,
      source: "resolved"
    };
  } catch (error) {
    console.warn(
      `[shell-env] failed to resolve shell environment via ${shellPath}; falling back to process.env`,
      error
    );
    return {
      shellPath,
      baseEnv: {
        ...baseEnv,
        SHELL: baseEnv.SHELL ?? shellPath
      },
      source: "fallback"
    };
  }
}

function readUserShell(): string | undefined {
  try {
    const shell = userInfo().shell;
    return shell?.trim() ? shell : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeInheritedEnv(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };

  for (const key of BLOCKED_INHERITED_ENV_KEYS) {
    delete nextEnv[key];
  }

  return nextEnv;
}

function buildShellEnvProbeCommand(
  shellPath: string,
  processExecPath: string,
  marker: string
): string {
  const script = [
    `process.stdout.write(${JSON.stringify(marker)});`,
    "process.stdout.write(JSON.stringify(process.env));",
    `process.stdout.write(${JSON.stringify(marker)});`
  ].join("");

  if (isPowerShell(shellPath)) {
    return `$env:ELECTRON_RUN_AS_NODE='1'; & ${powershellQuote(processExecPath)} -e ${powershellQuote(script)}`;
  }

  return `ELECTRON_RUN_AS_NODE=1 ${posixQuote(processExecPath)} -e ${posixQuote(script)}`;
}

function isPowerShell(shellPath: string): boolean {
  const shellName = basename(shellPath).toLowerCase();
  return shellName === "pwsh" || shellName === "pwsh.exe";
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function defaultShellCommandExecutor(
  command: string,
  args: string[],
  options: ShellCommandExecutorOptions
): Promise<{stdout: string; stderr: string}> {
  const {stdout = "", stderr = ""} = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8"
  });
  return {stdout, stderr};
}
