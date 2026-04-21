import {execFile, fork} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import {userInfo} from "node:os";
import {basename, dirname, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedShellEnvEnvelope {
  shellPath: string;
  baseEnv: NodeJS.ProcessEnv;
  cachedAt: number;
}

const PLATFORM_FALLBACK_SHELLS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/bin/zsh",
  linux: "/bin/bash"
};

interface ShellEnvProbeWorkerRequest {
  type: "probe";
  shellPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface ShellEnvProbeWorkerResult {
  type: "result";
  stdout: string;
}

interface ShellEnvProbeWorkerError {
  type: "error";
  message: string;
}

type ShellEnvProbeWorkerMessage =
  | ShellEnvProbeWorkerResult
  | ShellEnvProbeWorkerError;

export interface ResolvedShellEnv {
  shellPath: string;
  baseEnv: NodeJS.ProcessEnv;
  source: "resolved" | "cached" | "fallback";
}

export interface ShellCommandExecutorOptions {
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

export interface ShellProbeInvocation {
  command: string;
  args: string[];
}

export interface ShellProbeLaunchOptions {
  cwd: string;
  entry: string;
  execArgv: string[];
}

export interface ShellPtyProbeOptions {
  shellPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type ShellCommandExecutor = (
  command: string,
  args: string[],
  options: ShellCommandExecutorOptions
) => Promise<{stdout: string; stderr: string}>;

export type ShellPtyProbe = (
  options: ShellPtyProbeOptions
) => Promise<string>;

interface ResolveShellEnvironmentOptions {
  preferredShell?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  userShell?: string;
  timeoutMs?: number;
  processExecPath?: string;
  randomToken?: string;
  exec?: ShellCommandExecutor;
  ptyProbe?: ShellPtyProbe;
  cachePath?: string;
  cacheTtlMs?: number;
  onBackgroundRevalidation?: (promise: Promise<void>) => void;
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

  switch (basename(shellPath).toLowerCase()) {
    case "bash":
      return ["--login", "-i", "-c", command];
    default:
      return ["-i", "-l", "-c", command];
  }
}

export function shouldUsePtyShellEnvProbe(
  shellPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" && !isPowerShell(shellPath);
}

export function buildShellEnvProbeInvocation(
  shellPath: string,
  processExecPath: string,
  marker: string,
  _platform: NodeJS.Platform = process.platform
): ShellProbeInvocation {
  return {
    command: shellPath,
    args: buildShellEnvProbeArgs(shellPath, processExecPath, marker)
  };
}

export function resolveShellEnvProbeLaunchOptions(
  currentDir: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  resourcesPath: string | undefined = process.resourcesPath
): ShellProbeLaunchOptions {
  const asarSegment = `${sep}app.asar${sep}`;
  if (currentDir.includes(asarSegment)) {
    return {
      entry: join(currentDir, "shellEnvProbeWorker.js"),
      cwd: resourcesPath ?? resolve(currentDir, "../../../.."),
      execArgv: []
    };
  }

  const repoRoot = resolve(currentDir, "../../../..");
  if (nodeEnv === "production") {
    return {
      entry: resolve(currentDir, "shellEnvProbeWorker.js"),
      cwd: repoRoot,
      execArgv: []
    };
  }

  return {
    entry: resolve(repoRoot, "apps/desktop/src/main/shellEnvProbeWorker.ts"),
    cwd: repoRoot,
    execArgv: ["--import", "tsx"]
  };
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
  const platform = options.platform ?? process.platform;
  const shellPath = resolveShellPath(
    options.preferredShell,
    inheritedEnv,
    platform,
    options.userShell
  );
  const baseEnv = sanitizeInheritedEnv(inheritedEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const processExecPath = options.processExecPath ?? process.execPath;
  const marker = options.randomToken ?? `__kmux_shell_env__${randomUUID()}`;
  const exec = options.exec ?? defaultShellCommandExecutor;
  const ptyProbe = options.ptyProbe ?? defaultShellPtyProbe;

  if (options.cachePath) {
    const envelope = readCachedShellEnvEnvelope(options.cachePath);
    if (
      envelope &&
      envelope.shellPath === shellPath &&
      isCacheFresh(envelope.cachedAt, cacheTtlMs)
    ) {
      const revalidation = revalidateShellEnvInBackground({
        shellPath,
        platform,
        probeEnv: baseEnv,
        timeoutMs,
        processExecPath,
        marker,
        exec,
        ptyProbe,
        cachePath: options.cachePath
      });
      options.onBackgroundRevalidation?.(revalidation);
      return {
        shellPath,
        baseEnv: {
          ...envelope.baseEnv,
          SHELL: envelope.baseEnv.SHELL ?? shellPath
        },
        source: "cached"
      };
    }
  }

  try {
    const resolvedEnv = await probeShellEnvironment({
      shellPath,
      platform,
      probeEnv: baseEnv,
      timeoutMs,
      processExecPath,
      marker,
      exec,
      ptyProbe
    });
    if (options.cachePath) {
      writeCachedShellEnv(options.cachePath, {
        shellPath,
        baseEnv: resolvedEnv,
        cachedAt: Date.now()
      });
    }
    return {
      shellPath,
      baseEnv: resolvedEnv,
      source: "resolved"
    };
  } catch (error) {
    console.warn(
      `[shell-env] failed to resolve shell environment via ${shellPath}; falling back to cached env or process.env`,
      error
    );
    if (options.cachePath) {
      const envelope = readCachedShellEnvEnvelope(options.cachePath);
      if (envelope && envelope.shellPath === shellPath) {
        return {
          shellPath,
          baseEnv: {
            ...envelope.baseEnv,
            SHELL: envelope.baseEnv.SHELL ?? shellPath
          },
          source: "cached"
        };
      }
    }
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

async function probeShellEnvironment(options: {
  shellPath: string;
  platform: NodeJS.Platform;
  probeEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  processExecPath: string;
  marker: string;
  exec: ShellCommandExecutor;
  ptyProbe: ShellPtyProbe;
}): Promise<NodeJS.ProcessEnv> {
  let stdout = "";

  if (shouldUsePtyShellEnvProbe(options.shellPath, options.platform)) {
    stdout = await options.ptyProbe({
      shellPath: options.shellPath,
      args: buildShellEnvProbeArgs(
        options.shellPath,
        options.processExecPath,
        options.marker
      ),
      env: options.probeEnv,
      timeoutMs: options.timeoutMs
    });
  } else {
    const invocation = buildShellEnvProbeInvocation(
      options.shellPath,
      options.processExecPath,
      options.marker,
      options.platform
    );
    const result = await options.exec(
      invocation.command,
      invocation.args,
      {
        env: options.probeEnv,
        timeout: options.timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER
      }
    );
    stdout = result.stdout;
  }

  const resolvedEnv = sanitizeInheritedEnv(
    parseShellEnvOutput(stdout, options.marker)
  );
  resolvedEnv.SHELL ??= options.shellPath;
  return resolvedEnv;
}

function isCacheFresh(cachedAt: number | undefined, ttlMs: number): boolean {
  if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt)) {
    return false;
  }
  const age = Date.now() - cachedAt;
  return age >= 0 && age < ttlMs;
}

async function revalidateShellEnvInBackground(options: {
  shellPath: string;
  platform: NodeJS.Platform;
  probeEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  processExecPath: string;
  marker: string;
  exec: ShellCommandExecutor;
  ptyProbe: ShellPtyProbe;
  cachePath: string;
}): Promise<void> {
  try {
    const resolvedEnv = await probeShellEnvironment({
      shellPath: options.shellPath,
      platform: options.platform,
      probeEnv: options.probeEnv,
      timeoutMs: options.timeoutMs,
      processExecPath: options.processExecPath,
      marker: options.marker,
      exec: options.exec,
      ptyProbe: options.ptyProbe
    });
    writeCachedShellEnv(options.cachePath, {
      shellPath: options.shellPath,
      baseEnv: resolvedEnv,
      cachedAt: Date.now()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[shell-env] background revalidation failed for ${options.shellPath}: ${message}`
    );
  }
}

function readCachedShellEnvEnvelope(
  cachePath: string
): CachedShellEnvEnvelope | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CachedShellEnvEnvelope>;
    if (
      !parsed ||
      typeof parsed.shellPath !== "string" ||
      !parsed.baseEnv ||
      typeof parsed.baseEnv !== "object"
    ) {
      return null;
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(parsed.baseEnv)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    return {
      shellPath: parsed.shellPath,
      baseEnv: env,
      cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0
    };
  } catch {
    return null;
  }
}

function writeCachedShellEnv(
  cachePath: string,
  envelope: CachedShellEnvEnvelope
): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(envelope));
    try {
      renameSync(tmpPath, cachePath);
    } catch (renameError) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw renameError;
    }
  } catch (error) {
    console.warn(
      `[shell-env] failed to persist shell environment cache at ${cachePath}`,
      error
    );
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

  // Once the -c body starts, the probe's own stderr is redirected away from
  // the PTY stream we parse below. Noise emitted while the shell is sourcing
  // startup files can still surround the markers, so the parser slices only
  // the payload between those markers.
  return `exec 2>/dev/null; ELECTRON_RUN_AS_NODE=1 ${posixQuote(processExecPath)} -e ${posixQuote(script)}`;
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

async function defaultShellPtyProbe(
  options: ShellPtyProbeOptions
): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const launchOptions = resolveShellEnvProbeLaunchOptions(currentDir);

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = fork(launchOptions.entry, [], {
      cwd: launchOptions.cwd,
      execArgv: launchOptions.execArgv,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    let settled = false;

    const timeout = setTimeout(() => {
      settle(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        rejectPromise(
          new Error(`shell env PTY probe timed out after ${options.timeoutMs}ms`)
        );
      });
    }, options.timeoutMs);
    if (typeof timeout === "object" && timeout && "unref" in timeout) {
      timeout.unref();
    }

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      callback();
    };

    child.on("message", (message: ShellEnvProbeWorkerMessage) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "result") {
        settle(() => {
          resolvePromise(message.stdout);
        });
        return;
      }
      if (message.type === "error") {
        settle(() => {
          rejectPromise(new Error(message.message));
        });
      }
    });

    child.on("error", (error) => {
      settle(() => {
        rejectPromise(error);
      });
    });

    child.on("exit", (code, signal) => {
      settle(() => {
        rejectPromise(
          new Error(
            `shell env PTY probe worker exited before returning a result (code ${code ?? "null"}, signal ${signal ?? "none"})`
          )
        );
      });
    });

    try {
      child.send({
        type: "probe",
        shellPath: options.shellPath,
        args: options.args,
        env: options.env
      } satisfies ShellEnvProbeWorkerRequest);
    } catch (error) {
      settle(() => {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      });
    }
  });
}
