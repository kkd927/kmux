import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { sanitizeSettings, type AppState } from "@kmux/core";
import type { KmuxSettings, UsageVendor } from "@kmux/proto";

const SNAPSHOT_STORE_VERSION = 1;
const WINDOW_STATE_STORE_VERSION = 1;
const USAGE_HISTORY_STORE_VERSION = 1;
const DEFAULT_SOCKET_FILE_NAME = "control.sock";
const POSIX_SOCKET_PATH_MAX_BYTES = 103;

export type AppPathSource =
  | "env"
  | "home"
  | "run-user"
  | "xdg"
  | "tmp-fallback"
  | "path-length-fallback";

export interface RuntimeDirCandidateInfo {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid?: number;
  mode?: number;
}

export interface AppPaths {
  configDir: string;
  runtimeDir: string;
  stateDir: string;
  dataDir: string;
  cacheDir: string;
  socketPath: string;
  statePath: string;
  windowStatePath: string;
  settingsPath: string;
  usageHistoryPath: string;
  shellEnvCachePath: string;
  antigravitySessionsPath: string;
  captureRoot: string;
  attachmentRoot: string;
  rawOutputRoot: string;
  nativeCacheRoot: string;
  diagnosticsRoot: string;
  agentHookBinDir: string;
  agentWrapperBinDir: string;
  sources: {
    configDir: AppPathSource;
    runtimeDir: AppPathSource;
    stateDir: AppPathSource;
    dataDir: AppPathSource;
    cacheDir: AppPathSource;
    socketPath: AppPathSource;
  };
}

export interface ResolveAppPathsOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tmpDir?: string;
  uid?: number;
  runUserDir?: string;
  statRuntimeDir?: (path: string) => RuntimeDirCandidateInfo | null;
}

export type AppPathResolutionErrorCode =
  | "socket-path-too-long"
  | "path-root-not-absolute";

export class AppPathResolutionError extends Error {
  constructor(
    readonly code: AppPathResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AppPathResolutionError";
  }
}

export interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  sidebarWidth?: number;
}

interface SnapshotEnvelope {
  version: number;
  cleanShutdown?: boolean;
  snapshot: AppState;
}

export interface SnapshotRecord {
  snapshot: AppState;
  cleanShutdown: boolean;
}

export interface SnapshotSaveOptions {
  cleanShutdown?: boolean;
}

interface WindowStateEnvelope {
  version: number;
  windowState: PersistedWindowState;
}

interface UsageHistoryEnvelope {
  version: number;
  pricingRevision?: string;
  days: UsageHistoryDayRecord[];
}

export interface SnapshotFileStore {
  path: string;
  load(): AppState | null;
  loadRecord(): SnapshotRecord | null;
  save(snapshot: AppState, options?: SnapshotSaveOptions): void;
}

export interface WindowStateFileStore {
  path: string;
  load(): PersistedWindowState | null;
  save(windowState: PersistedWindowState): void;
}

export interface SettingsFileStore {
  path: string;
  load(): KmuxSettings | null;
  save(settings: KmuxSettings): void;
}

export interface UsageHistoryVendorRecord {
  vendor: Exclude<UsageVendor, "unknown">;
  totalCostUsd: number;
  totalTokens: number;
}

export interface UsageHistoryDayRecord {
  dayKey: string;
  totalCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
  totalTokens: number;
  vendors: UsageHistoryVendorRecord[];
}

export interface UsageHistoryFileStore {
  path: string;
  load(): UsageHistoryDayRecord[];
  save(days: UsageHistoryDayRecord[]): void;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function warnInvalidFile(filePath: string, reason: string): void {
  console.warn(`[persistence] ignoring ${filePath}: ${reason}`);
}

function warnSkippedSave(filePath: string, reason: string): void {
  console.warn(`[persistence] skipping save for ${filePath}: ${reason}`);
}

type TextFileReadResult =
  | { status: "ok"; content: string }
  | { status: "missing" }
  | { status: "error"; reason: string };

function readTextFile(filePath: string): TextFileReadResult {
  try {
    return { status: "ok", content: readFileSync(filePath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    warnInvalidFile(filePath, reason);
    return { status: "error", reason };
  }
}

function readJsonFile<T>(filePath: string): T | null {
  const readResult = readTextFile(filePath);
  if (readResult.status !== "ok") {
    return null;
  }

  try {
    return JSON.parse(readResult.content) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnInvalidFile(filePath, reason);
    return null;
  }
}

function sameTextFileReadResult(
  left: TextFileReadResult,
  right: TextFileReadResult
): boolean {
  if (left.status !== right.status) {
    return false;
  }
  switch (left.status) {
    case "ok":
      return right.status === "ok" && left.content === right.content;
    case "missing":
      return true;
    case "error":
      return false;
  }
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
  }
}

export function createSnapshotStore(statePath: string): SnapshotFileStore {
  const loadRecord = (): SnapshotRecord | null => {
    const envelope = readJsonFile<Partial<SnapshotEnvelope>>(statePath);
    if (!envelope) {
      return null;
    }
    if (envelope.version !== SNAPSHOT_STORE_VERSION) {
      warnInvalidFile(
        statePath,
        `unsupported version ${String(envelope.version)}`
      );
      return null;
    }
    if (!envelope.snapshot) {
      warnInvalidFile(statePath, "missing snapshot payload");
      return null;
    }
    return {
      snapshot: envelope.snapshot,
      cleanShutdown: envelope.cleanShutdown === true
    };
  };

  return {
    path: statePath,
    load() {
      return loadRecord()?.snapshot ?? null;
    },
    loadRecord,
    save(snapshot, options = {}) {
      atomicWrite(
        statePath,
        JSON.stringify({
          version: SNAPSHOT_STORE_VERSION,
          cleanShutdown: options.cleanShutdown === true,
          snapshot
        } satisfies SnapshotEnvelope)
      );
    }
  };
}

export function createWindowStateStore(
  windowStatePath: string
): WindowStateFileStore {
  return {
    path: windowStatePath,
    load() {
      const envelope =
        readJsonFile<Partial<WindowStateEnvelope>>(windowStatePath);
      if (!envelope) {
        return null;
      }
      if (envelope.version !== WINDOW_STATE_STORE_VERSION) {
        warnInvalidFile(
          windowStatePath,
          `unsupported version ${String(envelope.version)}`
        );
        return null;
      }
      if (!envelope.windowState) {
        warnInvalidFile(windowStatePath, "missing window state payload");
        return null;
      }
      return envelope.windowState;
    },
    save(windowState) {
      atomicWrite(
        windowStatePath,
        JSON.stringify({
          version: WINDOW_STATE_STORE_VERSION,
          windowState
        } satisfies WindowStateEnvelope)
      );
    }
  };
}

export function createSettingsStore(settingsPath: string): SettingsFileStore {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let lastKnownReadResult = readTextFile(settingsPath);

  return {
    path: settingsPath,
    load() {
      const readResult = readTextFile(settingsPath);
      lastKnownReadResult = readResult;
      if (readResult.status !== "ok") {
        return null;
      }
      let settings: KmuxSettings;
      try {
        settings = JSON.parse(readResult.content) as KmuxSettings;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnInvalidFile(settingsPath, reason);
        return null;
      }
      if (!settings) {
        return null;
      }
      return sanitizeSettings(settings);
    },
    save(settings) {
      const currentReadResult = readTextFile(settingsPath);
      if (currentReadResult.status === "error") {
        warnSkippedSave(
          settingsPath,
          `settings file could not be read: ${currentReadResult.reason}`
        );
        return;
      }
      if (lastKnownReadResult.status === "error") {
        warnSkippedSave(
          settingsPath,
          "last settings read failed; reload settings before saving"
        );
        return;
      }
      if (!sameTextFileReadResult(currentReadResult, lastKnownReadResult)) {
        warnSkippedSave(
          settingsPath,
          "external changes detected since the last settings load or save"
        );
        return;
      }

      const nextContent = JSON.stringify(settings, null, 2);
      atomicWrite(settingsPath, nextContent);
      lastKnownReadResult = { status: "ok", content: nextContent };
    }
  };
}

export function createUsageHistoryStore(
  usageHistoryPath: string,
  pricingRevision?: string
): UsageHistoryFileStore {
  mkdirSync(dirname(usageHistoryPath), { recursive: true });

  return {
    path: usageHistoryPath,
    load() {
      const envelope =
        readJsonFile<Partial<UsageHistoryEnvelope>>(usageHistoryPath);
      if (!envelope) {
        return [];
      }
      if (envelope.version !== USAGE_HISTORY_STORE_VERSION) {
        warnInvalidFile(
          usageHistoryPath,
          `unsupported version ${String(envelope.version)}`
        );
        return [];
      }
      if (!Array.isArray(envelope.days)) {
        warnInvalidFile(usageHistoryPath, "missing usage history payload");
        return [];
      }
      if (pricingRevision && envelope.pricingRevision !== pricingRevision) {
        warnInvalidFile(usageHistoryPath, "stale usage pricing revision");
        return [];
      }
      return envelope.days as UsageHistoryDayRecord[];
    },
    save(days) {
      atomicWrite(
        usageHistoryPath,
        JSON.stringify({
          version: USAGE_HISTORY_STORE_VERSION,
          pricingRevision,
          days
        } satisfies UsageHistoryEnvelope)
      );
    }
  };
}

function hashPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function pathSourceFromEnv(
  env: NodeJS.ProcessEnv,
  key: string
): AppPathSource | undefined {
  return envPath(env, key) ? "env" : undefined;
}

function envPath(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function explicitRootEnvPath(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  const value = envPath(env, key);
  if (!value) {
    return undefined;
  }
  if (platform === "linux" && !isAbsolute(value)) {
    throw new AppPathResolutionError(
      "path-root-not-absolute",
      `${key} must be an absolute path on Linux: ${value}`
    );
  }
  return value;
}

function xdgRootEnvPath(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const value = envPath(env, key);
  return value && isAbsolute(value) ? value : undefined;
}

function resolveConfigDir(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { path: string; source: AppPathSource } {
  const explicitConfigDir = explicitRootEnvPath(
    env,
    "KMUX_CONFIG_DIR",
    platform
  );
  if (explicitConfigDir) {
    return { path: explicitConfigDir, source: "env" };
  }
  const xdgConfigHome =
    platform === "linux" ? xdgRootEnvPath(env, "XDG_CONFIG_HOME") : undefined;
  if (xdgConfigHome) {
    return { path: join(xdgConfigHome, "kmux"), source: "xdg" };
  }
  return { path: join(homeDir, ".config", "kmux"), source: "home" };
}

function resolveRuntimeDir(options: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  tmpDir: string;
  uid?: number;
  runUserDir?: string;
  statRuntimeDir: (path: string) => RuntimeDirCandidateInfo | null;
}): { path: string; source: AppPathSource } {
  const explicitRuntimeDir = explicitRootEnvPath(
    options.env,
    "KMUX_RUNTIME_DIR",
    options.platform
  );
  if (explicitRuntimeDir) {
    return { path: explicitRuntimeDir, source: "env" };
  }
  if (options.platform === "linux") {
    const xdgRuntimeDir = xdgRootEnvPath(options.env, "XDG_RUNTIME_DIR");
    if (xdgRuntimeDir) {
      return { path: join(xdgRuntimeDir, "kmux"), source: "xdg" };
    }
    if (typeof options.uid === "number") {
      const runUserDir =
        options.runUserDir ?? join("/run/user", String(options.uid));
      if (
        isSafeDefaultRuntimeBase(
          runUserDir,
          options.uid,
          options.statRuntimeDir
        )
      ) {
        return { path: join(runUserDir, "kmux"), source: "run-user" };
      }
    }
    const stableIdentity =
      typeof options.uid === "number"
        ? String(options.uid)
        : hashPathSegment(options.homeDir);
    return {
      path: join(options.tmpDir, `kmux-runtime-${stableIdentity}`),
      source: "tmp-fallback"
    };
  }
  return { path: join(options.homeDir, ".kmux"), source: "home" };
}

function defaultStatRuntimeDir(path: string): RuntimeDirCandidateInfo | null {
  try {
    const stats = lstatSync(path);
    return {
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      uid: stats.uid,
      mode: stats.mode
    };
  } catch {
    return null;
  }
}

function isSafeDefaultRuntimeBase(
  path: string,
  uid: number,
  statRuntimeDir: (path: string) => RuntimeDirCandidateInfo | null
): boolean {
  const stats = statRuntimeDir(path);
  if (!stats || !stats.isDirectory || stats.isSymbolicLink) {
    return false;
  }
  if (typeof stats.uid === "number" && stats.uid !== uid) {
    return false;
  }
  if (typeof stats.mode === "number" && (stats.mode & 0o077) !== 0) {
    return false;
  }
  return true;
}

function resolveStateDir(
  homeDir: string,
  configDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { path: string; source: AppPathSource } {
  const explicitStateDir = explicitRootEnvPath(
    env,
    "KMUX_STATE_DIR",
    platform
  );
  if (explicitStateDir) {
    return { path: explicitStateDir, source: "env" };
  }
  if (platform === "linux") {
    const xdgStateHome = xdgRootEnvPath(env, "XDG_STATE_HOME");
    if (xdgStateHome) {
      return { path: join(xdgStateHome, "kmux"), source: "xdg" };
    }
    return { path: join(homeDir, ".local", "state", "kmux"), source: "home" };
  }
  return {
    path: configDir,
    source: pathSourceFromEnv(env, "KMUX_CONFIG_DIR") ?? "home"
  };
}

function resolveDataDir(
  homeDir: string,
  configDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { path: string; source: AppPathSource } {
  const explicitDataDir = explicitRootEnvPath(env, "KMUX_DATA_DIR", platform);
  if (explicitDataDir) {
    return { path: explicitDataDir, source: "env" };
  }
  if (platform === "linux") {
    const xdgDataHome = xdgRootEnvPath(env, "XDG_DATA_HOME");
    if (xdgDataHome) {
      return { path: join(xdgDataHome, "kmux"), source: "xdg" };
    }
    return { path: join(homeDir, ".local", "share", "kmux"), source: "home" };
  }
  return {
    path: configDir,
    source: pathSourceFromEnv(env, "KMUX_CONFIG_DIR") ?? "home"
  };
}

function resolveCacheDir(
  homeDir: string,
  runtimeDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { path: string; source: AppPathSource } {
  const explicitCacheDir = explicitRootEnvPath(
    env,
    "KMUX_CACHE_DIR",
    platform
  );
  if (explicitCacheDir) {
    return { path: explicitCacheDir, source: "env" };
  }
  if (platform === "linux") {
    const xdgCacheHome = xdgRootEnvPath(env, "XDG_CACHE_HOME");
    if (xdgCacheHome) {
      return { path: join(xdgCacheHome, "kmux"), source: "xdg" };
    }
    return { path: join(homeDir, ".cache", "kmux"), source: "home" };
  }
  return {
    path: runtimeDir,
    source: pathSourceFromEnv(env, "KMUX_RUNTIME_DIR") ?? "home"
  };
}

function isSocketPathTooLong(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, "utf8") > POSIX_SOCKET_PATH_MAX_BYTES;
}

function resolveSocketPath(
  runtimeDir: string,
  runtimeDirSource: AppPathSource,
  options: ResolveAppPathsOptions & {
    platform: NodeJS.Platform;
    tmpDir: string;
  }
): { path: string; runtimeDir: string; source: AppPathSource } {
  const socketPath = join(runtimeDir, DEFAULT_SOCKET_FILE_NAME);
  if (!isSocketPathTooLong(socketPath)) {
    return { path: socketPath, runtimeDir, source: runtimeDirSource };
  }
  if (runtimeDirSource === "env") {
    throw new AppPathResolutionError(
      "socket-path-too-long",
      `KMUX_RUNTIME_DIR produces an overlong Unix socket path (${Buffer.byteLength(
        socketPath,
        "utf8"
      )} bytes): ${socketPath}`
    );
  }

  const stableIdentity =
    typeof options.uid === "number"
      ? String(options.uid)
      : hashPathSegment(options.homeDir);
  const shortRuntimeDir = join(
    options.tmpDir,
    `kmux-${stableIdentity}-${hashPathSegment(socketPath).slice(0, 8)}`
  );
  const shortSocketPath = join(shortRuntimeDir, "c.sock");
  if (isSocketPathTooLong(shortSocketPath)) {
    throw new AppPathResolutionError(
      "socket-path-too-long",
      `Unable to resolve a Unix socket path within ${POSIX_SOCKET_PATH_MAX_BYTES} bytes`
    );
  }
  return {
    path: shortSocketPath,
    runtimeDir: shortRuntimeDir,
    source: "path-length-fallback"
  };
}

export function resolveAppPaths(options: ResolveAppPathsOptions): AppPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tmpRoot = options.tmpDir ?? tmpdir();
  const configDir = resolveConfigDir(options.homeDir, env, platform);
  const runtimeDir = resolveRuntimeDir({
    homeDir: options.homeDir,
    env,
    platform,
    tmpDir: tmpRoot,
    uid: options.uid,
    runUserDir: options.runUserDir,
    statRuntimeDir: options.statRuntimeDir ?? defaultStatRuntimeDir
  });
  const socket = resolveSocketPath(runtimeDir.path, runtimeDir.source, {
    ...options,
    env,
    platform,
    tmpDir: tmpRoot
  });
  const effectiveRuntimeDir = socket.runtimeDir;
  const stateDir = resolveStateDir(
    options.homeDir,
    configDir.path,
    env,
    platform
  );
  const dataDir = resolveDataDir(
    options.homeDir,
    configDir.path,
    env,
    platform
  );
  const cacheDir = resolveCacheDir(
    options.homeDir,
    effectiveRuntimeDir,
    env,
    platform
  );
  const isLinux = platform === "linux";

  return {
    configDir: configDir.path,
    runtimeDir: effectiveRuntimeDir,
    stateDir: stateDir.path,
    dataDir: dataDir.path,
    cacheDir: cacheDir.path,
    socketPath: socket.path,
    statePath: join(stateDir.path, "state.json"),
    windowStatePath: join(stateDir.path, "window-state.json"),
    settingsPath: join(configDir.path, "settings.json"),
    usageHistoryPath: join(stateDir.path, "usage-history.json"),
    shellEnvCachePath: join(stateDir.path, "shell-env.json"),
    antigravitySessionsPath: join(stateDir.path, "antigravity-sessions.json"),
    captureRoot: join(
      isLinux ? stateDir.path : effectiveRuntimeDir,
      "captures"
    ),
    attachmentRoot: join(
      isLinux ? dataDir.path : effectiveRuntimeDir,
      "attachments"
    ),
    rawOutputRoot: join(stateDir.path, "pty-raw"),
    nativeCacheRoot: join(cacheDir.path, "native"),
    diagnosticsRoot: join(stateDir.path, "diagnostics"),
    agentHookBinDir: join(isLinux ? dataDir.path : configDir.path, "bin"),
    agentWrapperBinDir: join(
      isLinux ? dataDir.path : configDir.path,
      "wrappers"
    ),
    sources: {
      configDir: configDir.source,
      runtimeDir:
        socket.source === "path-length-fallback"
          ? socket.source
          : runtimeDir.source,
      stateDir: stateDir.source,
      dataDir: dataDir.source,
      cacheDir: cacheDir.source,
      socketPath: socket.source
    }
  };
}

export function defaultAppPaths(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): AppPaths {
  return resolveAppPaths({
    homeDir,
    env,
    platform: process.platform,
    uid: process.getuid?.()
  });
}
