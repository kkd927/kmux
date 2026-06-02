import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeSettings, type AppState } from "@kmux/core";
import type { KmuxSettings, UsageVendor } from "@kmux/proto";

const SNAPSHOT_STORE_VERSION = 1;
const WINDOW_STATE_STORE_VERSION = 1;
const USAGE_HISTORY_STORE_VERSION = 1;

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
  activeSessionCount: number;
}

export interface UsageHistoryDayRecord {
  dayKey: string;
  totalCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
  totalTokens: number;
  activeSessionCount: number;
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

export function defaultAppPaths(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): {
  statePath: string;
  windowStatePath: string;
  settingsPath: string;
  usageHistoryPath: string;
  antigravitySessionsPath: string;
  agentHookBinDir: string;
  shellEnvCachePath: string;
  socketPath: string;
} {
  const configDir = env.KMUX_CONFIG_DIR ?? join(homeDir, ".config", "kmux");
  const runtimeDir = env.KMUX_RUNTIME_DIR ?? join(homeDir, ".kmux");
  return {
    statePath: join(configDir, "state.json"),
    windowStatePath: join(configDir, "window-state.json"),
    settingsPath: join(configDir, "settings.json"),
    usageHistoryPath: join(configDir, "usage-history.json"),
    antigravitySessionsPath: join(configDir, "antigravity-sessions.json"),
    agentHookBinDir: join(configDir, "bin"),
    shellEnvCachePath: join(configDir, "shell-env.json"),
    socketPath: join(runtimeDir, "control.sock")
  };
}
