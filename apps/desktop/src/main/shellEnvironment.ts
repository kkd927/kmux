import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  resolveDefaultShellArgs,
  shouldApplyShellIntegration,
  shouldStripShellManagedEnv,
  type ShellLaunchPolicy
} from "../shared/ptyProtocol";

const execFileAsync = promisify(execFile);

const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;
const PROBE_ONLY_ENV_KEYS = [
  "KMUX_DISABLE_SHELL_ENV_PROBE",
  "KMUX_SHELL_ENV_PROBE"
] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const SHELL_ENV_CACHE_SCHEMA_VERSION = 2;
const FINGERPRINT_IGNORED_ENV_KEYS = new Set([
  "_",
  "COLORTERM",
  // Session endpoints and per-process runtime identities must never make a
  // shell-startup fingerprint unique to one app launch. They are overlaid from
  // the current process below so cached shells cannot retain stale sockets,
  // display connections, or terminal multiplexer identities.
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_STARTUP_ID",
  "DISPLAY",
  "GIO_LAUNCHED_DESKTOP_FILE",
  "GIO_LAUNCHED_DESKTOP_FILE_PID",
  "GPG_AGENT_INFO",
  "INVOCATION_ID",
  "ITERM_SESSION_ID",
  "JOURNAL_STREAM",
  "LaunchInstanceID",
  "OLDPWD",
  "PWD",
  "SECURITYSESSIONID",
  "SESSION_MANAGER",
  "SHLVL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "STY",
  "SYSTEMD_EXEC_PID",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "TMPDIR",
  "TMUX",
  "TMUX_PANE",
  "VSCODE_IPC_HOOK",
  "VSCODE_IPC_HOOK_CLI",
  "WAYLAND_DISPLAY",
  "WINDOWID",
  "XAUTHORITY",
  "XDG_ACTIVATION_TOKEN",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_ID",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME"
]);

interface CachedShellEnvEnvelope {
  schemaVersion: number;
  platform?: NodeJS.Platform;
  shellPath: string;
  baseEnv: NodeJS.ProcessEnv;
  cachedAt: number;
  startupConfigFingerprint?: ShellStartupConfigFingerprint;
  lastProbeFailure?: ShellEnvProbeFailureMetadata;
}

interface ShellEnvProbeFailureMetadata {
  fingerprint: ShellStartupConfigFingerprint;
  failedAt: number;
}

export interface ShellStartupConfigFingerprint {
  version: 2;
  platform: NodeJS.Platform;
  shell: "zsh" | "bash" | "fish";
  shellPath: string;
  shellIdentity: ShellStartupFileFingerprint;
  inheritedEnvHash: string;
  envPaths: {
    HOME: string | null;
    SHELL: string | null;
    ZDOTDIR: string | null;
    XDG_CONFIG_HOME: string | null;
  };
  files: ShellStartupFileFingerprint[];
}

export interface ShellStartupFileFingerprint {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

const PLATFORM_FALLBACK_SHELLS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/bin/zsh",
  linux: "/bin/bash"
};

interface ShellEnvProbeWorkerRequest {
  type: "probe";
  shellPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface ShellEnvProbeWorkerResult {
  type: "result";
  stdout: string;
}

interface ShellEnvProbeWorkerStarted {
  type: "started";
  ptyPid: number;
}

interface ShellEnvProbeWorkerError {
  type: "error";
  message: string;
}

type ShellEnvProbeWorkerMessage =
  | ShellEnvProbeWorkerStarted
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
  signal: AbortSignal;
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
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export type ShellCommandExecutor = (
  command: string,
  args: string[],
  options: ShellCommandExecutorOptions
) => Promise<{ stdout: string; stderr: string }>;

export type ShellPtyProbe = (options: ShellPtyProbeOptions) => Promise<string>;

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
  refreshCachedEnv?: boolean;
}

interface ActiveShellEnvRefresh {
  controller: AbortController;
}

type KillProcess = (pid: number, signal: NodeJS.Signals) => true;

let activeShellEnvRefresh: ActiveShellEnvRefresh | null = null;

export interface BuildShellLaunchPolicyOptions {
  defaultShellPath: string;
  launchShell?: string;
  launchArgs?: string[];
  platform: NodeJS.Platform;
  enableShellIntegration: boolean;
  socketPath: string;
  nodePath: string;
  agentHookBinDir: string;
  agentWrapperBinDir: string;
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

export function buildShellLaunchPolicy(
  options: BuildShellLaunchPolicyOptions
): ShellLaunchPolicy {
  const shellPath = options.launchShell?.trim() || options.defaultShellPath;
  const integrationEnabled =
    options.enableShellIntegration &&
    shouldApplyShellIntegration(
      shellPath,
      options.launchArgs,
      options.platform
    );

  return {
    defaultShellPath: shellPath,
    defaultShellArgs: resolveDefaultShellArgs(shellPath, options.platform),
    stripManagedEnv: shouldStripShellManagedEnv(
      shellPath,
      options.launchArgs,
      options.platform
    ),
    integration: {
      enabled: integrationEnabled,
      mode: integrationEnabled ? "posix-wrapper" : "none"
    },
    agentPath: {
      helperBinDir: options.agentHookBinDir,
      wrapperBinDir: options.agentWrapperBinDir,
      prependWrapperToPath: true
    },
    hookEnv: {
      KMUX_SOCKET_PATH: options.socketPath,
      KMUX_AGENT_BIN_DIR: options.agentHookBinDir,
      KMUX_NODE_PATH: options.nodePath
    }
  };
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
  return (
    (platform === "darwin" || platform === "linux") && !isPowerShell(shellPath)
  );
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
    const packagedResourcesPath =
      resourcesPath ?? resolve(currentDir, "../../../..");
    return {
      entry: join(currentDir, "shellEnvProbeWorker.js"),
      cwd: join(packagedResourcesPath, "app.asar.unpacked"),
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

  const rawPayload = stdout.slice(startIndex + marker.length, endIndex).trim();
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
  const probeEnv = buildShellProbeEnv(baseEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const processExecPath = options.processExecPath ?? process.execPath;
  const marker = options.randomToken ?? `__kmux_shell_env__${randomUUID()}`;
  const exec = options.exec ?? defaultShellCommandExecutor;
  const ptyProbe = options.ptyProbe ?? defaultShellPtyProbe;

  if (inheritedEnv.KMUX_DISABLE_SHELL_ENV_PROBE === "1") {
    return {
      shellPath,
      baseEnv: {
        ...baseEnv,
        SHELL: baseEnv.SHELL ?? shellPath
      },
      source: "fallback"
    };
  }

  const cachedEnvelope = options.cachePath
    ? readCachedShellEnvEnvelope(options.cachePath)
    : null;
  const currentStartupConfigFingerprint = createShellStartupConfigFingerprint(
    shellPath,
    platform,
    baseEnv,
    cachedEnvelope?.baseEnv ?? baseEnv
  );
  const matchesLastFailedFingerprint = Boolean(
    cachedEnvelope?.shellPath === shellPath &&
    currentStartupConfigFingerprint &&
    cachedEnvelope.lastProbeFailure &&
    shellStartupConfigFingerprintsEqual(
      cachedEnvelope.lastProbeFailure.fingerprint,
      currentStartupConfigFingerprint
    )
  );
  if (
    cachedEnvelope?.shellPath === shellPath &&
    cachedEnvelope.schemaVersion === SHELL_ENV_CACHE_SCHEMA_VERSION &&
    cachedEnvelope.platform === platform &&
    currentStartupConfigFingerprint &&
    shellStartupConfigFingerprintsEqual(
      cachedEnvelope.startupConfigFingerprint,
      currentStartupConfigFingerprint
    )
  ) {
    if (options.refreshCachedEnv !== false && options.cachePath) {
      scheduleCachedShellEnvRefresh({
        cachePath: options.cachePath,
        shellPath,
        platform,
        probeEnv,
        timeoutMs,
        processExecPath,
        marker,
        exec,
        ptyProbe
      });
    }
    const cachedEnv = mergeCachedShellEnv(
      cachedEnvelope.baseEnv,
      baseEnv,
      shellPath
    );
    return {
      shellPath,
      baseEnv: cachedEnv,
      source: "cached"
    };
  }
  if (
    cachedEnvelope?.shellPath === shellPath &&
    currentStartupConfigFingerprint &&
    matchesLastFailedFingerprint
  ) {
    if (options.refreshCachedEnv !== false && options.cachePath) {
      scheduleCachedShellEnvRefresh({
        cachePath: options.cachePath,
        shellPath,
        platform,
        probeEnv,
        timeoutMs,
        processExecPath,
        marker,
        exec,
        ptyProbe
      });
    }
    return {
      shellPath,
      baseEnv: mergeCachedShellEnv(cachedEnvelope.baseEnv, baseEnv, shellPath),
      source: "cached"
    };
  }

  try {
    const foregroundProbeController = new AbortController();
    const resolvedEnv = await probeShellEnvironment({
      shellPath,
      platform,
      probeEnv,
      timeoutMs,
      processExecPath,
      marker,
      exec,
      ptyProbe,
      signal: foregroundProbeController.signal
    });
    if (options.cachePath) {
      const startupConfigFingerprint = createShellStartupConfigFingerprint(
        shellPath,
        platform,
        baseEnv,
        resolvedEnv
      );
      writeCachedShellEnv(options.cachePath, {
        schemaVersion: SHELL_ENV_CACHE_SCHEMA_VERSION,
        platform,
        shellPath,
        baseEnv: sanitizeShellEnvForCache(resolvedEnv),
        cachedAt: Date.now(),
        ...(startupConfigFingerprint ? { startupConfigFingerprint } : {})
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
    if (cachedEnvelope?.shellPath === shellPath) {
      const cachedEnv = mergeCachedShellEnv(
        cachedEnvelope.baseEnv,
        baseEnv,
        shellPath
      );
      if (options.cachePath && currentStartupConfigFingerprint) {
        // Remember that this exact input fingerprint already received its one
        // bounded foreground attempt. Keep the last-known-good fingerprint
        // authoritative; subsequent launches use the stale value explicitly
        // as a fallback and retry the failed fingerprint off the startup path.
        writeCachedShellEnv(options.cachePath, {
          schemaVersion: SHELL_ENV_CACHE_SCHEMA_VERSION,
          platform,
          shellPath,
          baseEnv: sanitizeShellEnvForCache(cachedEnvelope.baseEnv),
          cachedAt: cachedEnvelope.cachedAt,
          ...(cachedEnvelope.startupConfigFingerprint
            ? {
                startupConfigFingerprint:
                  cachedEnvelope.startupConfigFingerprint
              }
            : {}),
          lastProbeFailure: {
            fingerprint: currentStartupConfigFingerprint,
            failedAt: Date.now()
          }
        });
      }
      return {
        shellPath,
        baseEnv: cachedEnv,
        source: "cached"
      };
    }
    if (options.cachePath && currentStartupConfigFingerprint) {
      // A fresh install can have a startup file that blocks the probe too.
      // Persist the sanitized inherited environment only as an explicit
      // failed-fingerprint fallback, so the same configuration receives one
      // foreground attempt rather than delaying every launch.
      writeCachedShellEnv(options.cachePath, {
        schemaVersion: SHELL_ENV_CACHE_SCHEMA_VERSION,
        platform,
        shellPath,
        baseEnv: sanitizeShellEnvForCache(baseEnv),
        cachedAt: Date.now(),
        lastProbeFailure: {
          fingerprint: currentStartupConfigFingerprint,
          failedAt: Date.now()
        }
      });
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

export function cancelShellEnvironmentRefresh(): void {
  const refresh = activeShellEnvRefresh;
  activeShellEnvRefresh = null;
  refresh?.controller.abort();
}

function scheduleCachedShellEnvRefresh(options: {
  cachePath: string;
  shellPath: string;
  platform: NodeJS.Platform;
  probeEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  processExecPath: string;
  marker: string;
  exec: ShellCommandExecutor;
  ptyProbe: ShellPtyProbe;
}): void {
  if (activeShellEnvRefresh) {
    return;
  }
  const refresh: ActiveShellEnvRefresh = {
    controller: new AbortController()
  };
  activeShellEnvRefresh = refresh;
  void probeShellEnvironment({
    shellPath: options.shellPath,
    platform: options.platform,
    probeEnv: options.probeEnv,
    timeoutMs: options.timeoutMs,
    processExecPath: options.processExecPath,
    marker: options.marker,
    exec: options.exec,
    ptyProbe: options.ptyProbe,
    signal: refresh.controller.signal
  })
    .then((resolvedEnv) => {
      if (!refresh.controller.signal.aborted) {
        const startupConfigFingerprint = createShellStartupConfigFingerprint(
          options.shellPath,
          options.platform,
          options.probeEnv,
          resolvedEnv
        );
        writeCachedShellEnv(options.cachePath, {
          schemaVersion: SHELL_ENV_CACHE_SCHEMA_VERSION,
          platform: options.platform,
          shellPath: options.shellPath,
          baseEnv: sanitizeShellEnvForCache(resolvedEnv),
          cachedAt: Date.now(),
          ...(startupConfigFingerprint ? { startupConfigFingerprint } : {})
        });
      }
    })
    .catch(() => {
      // The last valid cache remains authoritative for this launch. A failed
      // refresh is bounded and retried on a later launch, never on startup's
      // critical path.
    })
    .finally(() => {
      if (activeShellEnvRefresh === refresh) {
        activeShellEnvRefresh = null;
      }
    });
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
  signal: AbortSignal;
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
      cwd: resolveShellProbeCwd(options.probeEnv),
      env: options.probeEnv,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    });
  } else {
    const invocation = buildShellEnvProbeInvocation(
      options.shellPath,
      options.processExecPath,
      options.marker,
      options.platform
    );
    const result = await options.exec(invocation.command, invocation.args, {
      env: options.probeEnv,
      timeout: options.timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
      signal: options.signal
    });
    stdout = result.stdout;
  }

  const resolvedEnv = sanitizeInheritedEnv(
    parseShellEnvOutput(stdout, options.marker)
  );
  resolvedEnv.SHELL ??= options.shellPath;
  return resolvedEnv;
}

export function createShellStartupConfigFingerprint(
  shellPath: string,
  platform: NodeJS.Platform,
  inheritedEnv: NodeJS.ProcessEnv,
  cachedOrResolvedEnv: NodeJS.ProcessEnv
): ShellStartupConfigFingerprint | null {
  const shellName = basename(shellPath).toLowerCase();
  const homeRoots = uniquePaths([
    absoluteEnvPath(inheritedEnv.HOME),
    absoluteEnvPath(cachedOrResolvedEnv.HOME)
  ]);
  const commonFiles = commonShellStartupFiles(platform);
  const shellIdentity = fingerprintStartupFile(
    isAbsolute(shellPath) ? resolve(shellPath) : shellPath
  );
  const baseFingerprint = {
    version: 2 as const,
    platform,
    shellPath: isAbsolute(shellPath) ? resolve(shellPath) : shellPath,
    shellIdentity,
    inheritedEnvHash: stableInheritedEnvHash(inheritedEnv),
    envPaths: {
      HOME:
        absoluteEnvPath(inheritedEnv.HOME) ??
        absoluteEnvPath(cachedOrResolvedEnv.HOME),
      SHELL: normalizedEnvValue(inheritedEnv.SHELL),
      ZDOTDIR:
        absoluteEnvPath(inheritedEnv.ZDOTDIR) ??
        absoluteEnvPath(cachedOrResolvedEnv.ZDOTDIR),
      XDG_CONFIG_HOME:
        absoluteEnvPath(inheritedEnv.XDG_CONFIG_HOME) ??
        absoluteEnvPath(cachedOrResolvedEnv.XDG_CONFIG_HOME)
    }
  };
  if (shellName === "zsh") {
    const roots = uniquePaths([
      ...homeRoots,
      absoluteEnvPath(inheritedEnv.ZDOTDIR),
      absoluteEnvPath(cachedOrResolvedEnv.ZDOTDIR)
    ]);
    if (roots.length === 0) {
      return null;
    }
    return {
      ...baseFingerprint,
      shell: "zsh",
      files: fingerprintStartupFiles([
        "/etc/zshenv",
        "/etc/zprofile",
        "/etc/zshrc",
        "/etc/zlogin",
        "/etc/zsh/zshenv",
        "/etc/zsh/zprofile",
        "/etc/zsh/zshrc",
        "/etc/zsh/zlogin",
        ...commonFiles,
        ...roots.flatMap((root) =>
          [".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((name) =>
            join(root, name)
          )
        )
      ])
    };
  }
  if (shellName === "bash") {
    if (homeRoots.length === 0) {
      return null;
    }
    return {
      ...baseFingerprint,
      shell: "bash",
      files: fingerprintStartupFiles([
        "/etc/profile",
        "/etc/bashrc",
        "/etc/bash.bashrc",
        ...commonFiles,
        ...homeRoots.flatMap((home) =>
          [
            ".bash_profile",
            ".bash_login",
            ".profile",
            ".bashrc",
            ".bash_logout"
          ].map((name) => join(home, name))
        )
      ])
    };
  }
  if (shellName === "fish") {
    const configRoots = uniquePaths([
      absoluteEnvPath(inheritedEnv.XDG_CONFIG_HOME),
      absoluteEnvPath(cachedOrResolvedEnv.XDG_CONFIG_HOME),
      ...homeRoots.map((home) => join(home, ".config"))
    ]);
    if (configRoots.length === 0) {
      return null;
    }
    const systemFishRoots = ["/etc/fish", "/usr/local/etc/fish"];
    if (platform === "darwin") {
      systemFishRoots.push("/opt/homebrew/etc/fish");
    }
    return {
      ...baseFingerprint,
      shell: "fish",
      files: fingerprintStartupFiles([
        ...commonFiles,
        ...systemFishRoots.flatMap(fishStartupFiles),
        ...fishVendorStartupFiles(platform),
        ...configRoots.flatMap((root) => fishStartupFiles(join(root, "fish")))
      ])
    };
  }
  return null;
}

function absoluteEnvPath(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && isAbsolute(candidate) ? resolve(candidate) : null;
}

function normalizedEnvValue(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate || null;
}

function commonShellStartupFiles(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/etc/paths", ...listDirectoryFiles("/etc/paths.d")];
  }
  if (platform === "linux") {
    return [
      "/etc/environment",
      "/etc/profile",
      ...listDirectoryFiles("/etc/profile.d")
    ];
  }
  return [];
}

function fishStartupFiles(root: string): string[] {
  return [
    join(root, "config.fish"),
    ...listDirectoryFiles(join(root, "conf.d"), (name) =>
      name.endsWith(".fish")
    )
  ];
}

function fishVendorStartupFiles(platform: NodeJS.Platform): string[] {
  const roots = [
    "/usr/share/fish/vendor_conf.d",
    "/usr/local/share/fish/vendor_conf.d"
  ];
  if (platform === "darwin") {
    roots.push("/opt/homebrew/share/fish/vendor_conf.d");
  }
  return roots.flatMap((root) =>
    listDirectoryFiles(root, (name) => name.endsWith(".fish"))
  );
}

function listDirectoryFiles(
  directory: string,
  include: (name: string) => boolean = () => true
): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          include(entry.name) && (entry.isFile() || entry.isSymbolicLink())
      )
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function stableInheritedEnvHash(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(sanitizeInheritedEnv(env))
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        !key.startsWith("KMUX_") &&
        !FINGERPRINT_IGNORED_ENV_KEYS.has(key)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function mergeCachedShellEnv(
  cachedEnv: NodeJS.ProcessEnv,
  inheritedEnv: NodeJS.ProcessEnv,
  shellPath: string
): NodeJS.ProcessEnv {
  const merged = sanitizeInheritedEnv(cachedEnv);

  // These values are intentionally excluded from the startup fingerprint
  // because they change per process/window. They must therefore come from
  // this launch rather than from a persisted shell probe.
  for (const key of FINGERPRINT_IGNORED_ENV_KEYS) {
    const value = inheritedEnv[key];
    if (typeof value === "string") {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }

  // KMUX_* is app/runtime state, not shell startup state. Never resurrect a
  // prior session's ids, auth token, diagnostics path, or test switches from
  // the shell environment cache.
  for (const key of Object.keys(merged)) {
    if (key.startsWith("KMUX_")) {
      delete merged[key];
    }
  }
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (key.startsWith("KMUX_") && typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const key of PROBE_ONLY_ENV_KEYS) {
    delete merged[key];
  }

  merged.SHELL ??= shellPath;
  return merged;
}

function sanitizeShellEnvForCache(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cached = sanitizeInheritedEnv(env);
  for (const key of Object.keys(cached)) {
    if (key.startsWith("KMUX_")) {
      delete cached[key];
    }
  }
  return cached;
}

function uniquePaths(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function fingerprintStartupFiles(
  paths: string[]
): ShellStartupFileFingerprint[] {
  return uniquePaths(paths).sort().map(fingerprintStartupFile);
}

function fingerprintStartupFile(path: string): ShellStartupFileFingerprint {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return { path, exists: false };
  }
  if (!stat.isFile()) {
    return { path, exists: false };
  }
  try {
    const content = readFileSync(path);
    return {
      path,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(content).digest("hex")
    };
  } catch {
    return {
      path,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: "unreadable"
    };
  }
}

function shellStartupConfigFingerprintsEqual(
  cached: ShellStartupConfigFingerprint | undefined,
  current: ShellStartupConfigFingerprint
): boolean {
  return Boolean(cached && JSON.stringify(cached) === JSON.stringify(current));
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
      schemaVersion:
        typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0,
      ...(typeof parsed.platform === "string"
        ? { platform: parsed.platform }
        : {}),
      shellPath: parsed.shellPath,
      baseEnv: env,
      cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0,
      ...(isShellStartupConfigFingerprint(parsed.startupConfigFingerprint)
        ? { startupConfigFingerprint: parsed.startupConfigFingerprint }
        : {}),
      ...(isShellEnvProbeFailureMetadata(parsed.lastProbeFailure)
        ? { lastProbeFailure: parsed.lastProbeFailure }
        : {})
    };
  } catch {
    return null;
  }
}

function isShellEnvProbeFailureMetadata(
  value: unknown
): value is ShellEnvProbeFailureMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ShellEnvProbeFailureMetadata>;
  return (
    typeof candidate.failedAt === "number" &&
    Number.isFinite(candidate.failedAt) &&
    isShellStartupConfigFingerprint(candidate.fingerprint)
  );
}

function isShellStartupConfigFingerprint(
  value: unknown
): value is ShellStartupConfigFingerprint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ShellStartupConfigFingerprint>;
  return (
    candidate.version === 2 &&
    typeof candidate.platform === "string" &&
    (candidate.shell === "zsh" ||
      candidate.shell === "bash" ||
      candidate.shell === "fish") &&
    typeof candidate.shellPath === "string" &&
    typeof candidate.inheritedEnvHash === "string" &&
    Boolean(candidate.shellIdentity) &&
    typeof candidate.shellIdentity?.path === "string" &&
    typeof candidate.shellIdentity.exists === "boolean" &&
    Boolean(candidate.envPaths) &&
    ["HOME", "SHELL", "ZDOTDIR", "XDG_CONFIG_HOME"].every((key) => {
      const pathValue =
        candidate.envPaths?.[
          key as keyof ShellStartupConfigFingerprint["envPaths"]
        ];
      return pathValue === null || typeof pathValue === "string";
    }) &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        typeof file.exists === "boolean" &&
        (file.size === undefined || typeof file.size === "number") &&
        (file.mtimeMs === undefined || typeof file.mtimeMs === "number") &&
        (file.sha256 === undefined || typeof file.sha256 === "string")
    )
  );
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

function sanitizeInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };

  for (const key of [...BLOCKED_INHERITED_ENV_KEYS, ...PROBE_ONLY_ENV_KEYS]) {
    delete nextEnv[key];
  }

  return nextEnv;
}

function buildShellProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    KMUX_SHELL_ENV_PROBE: "1"
  };
}

function resolveShellProbeCwd(env: NodeJS.ProcessEnv): string {
  const homeDir = env.HOME?.trim();
  if (homeDir && isAbsolute(homeDir)) {
    return homeDir;
  }
  return process.cwd();
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
): Promise<{ stdout: string; stderr: string }> {
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8"
  });
  return { stdout, stderr };
}

async function defaultShellPtyProbe(
  options: ShellPtyProbeOptions
): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const launchOptions = resolveShellEnvProbeLaunchOptions(currentDir);

  if (options.signal.aborted) {
    throw createShellEnvProbeAbortError();
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = fork(launchOptions.entry, [], {
      cwd: launchOptions.cwd,
      execArgv: launchOptions.execArgv,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    let settled = false;
    let ptyPid: number | null = null;

    const timeout = setTimeout(() => {
      settle(() => {
        terminateShellEnvProbeProcessTree(child, ptyPid, "SIGTERM");
        rejectPromise(
          new Error(
            `shell env PTY probe timed out after ${options.timeoutMs}ms`
          )
        );
      });
    }, options.timeoutMs);
    if (typeof timeout === "object" && timeout && "unref" in timeout) {
      timeout.unref();
    }

    const handleAbort = (): void => {
      settle(() => {
        terminateShellEnvProbeProcessTree(child, ptyPid, "SIGTERM");
        rejectPromise(createShellEnvProbeAbortError());
      });
    };

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      options.signal.removeEventListener("abort", handleAbort);
      callback();
    };

    options.signal.addEventListener("abort", handleAbort, { once: true });

    child.on("message", (message: ShellEnvProbeWorkerMessage) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "started") {
        if (Number.isSafeInteger(message.ptyPid) && message.ptyPid > 0) {
          ptyPid = message.ptyPid;
        }
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
        cwd: options.cwd,
        env: options.env
      } satisfies ShellEnvProbeWorkerRequest);
    } catch (error) {
      settle(() => {
        terminateShellEnvProbeProcessTree(child, ptyPid, "SIGTERM");
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    }
  });
}

export function terminateShellEnvProbeProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  ptyPid: number | null,
  signal: NodeJS.Signals,
  killProcess: KillProcess = process.kill
): void {
  const processGroupLeaders = new Set<number>();
  if (ptyPid && ptyPid > 0) {
    processGroupLeaders.add(ptyPid);
  }
  if (child.pid && child.pid > 0) {
    processGroupLeaders.add(child.pid);
  }
  for (const pid of processGroupLeaders) {
    try {
      killProcess(-pid, signal);
    } catch {
      try {
        killProcess(pid, signal);
      } catch {
        // The worker or PTY may already have exited.
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The worker may already have exited.
  }
}

function createShellEnvProbeAbortError(): Error {
  const error = new Error("shell env PTY probe was cancelled");
  error.name = "AbortError";
  return error;
}
