import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import type { AppState } from "@kmux/core";
import type { KmuxSettings } from "@kmux/proto";

const SNAPSHOT_STORE_VERSION = 1;
const WINDOW_STATE_STORE_VERSION = 1;

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
  snapshot: AppState;
}

interface WindowStateEnvelope {
  version: number;
  windowState: PersistedWindowState;
}

export interface SnapshotFileStore {
  path: string;
  load(): AppState | null;
  save(snapshot: AppState): void;
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

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    const reason = error instanceof Error ? error.message : String(error);
    warnInvalidFile(filePath, reason);
    return null;
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
  return {
    path: statePath,
    load() {
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
      return envelope.snapshot;
    },
    save(snapshot) {
      atomicWrite(
        statePath,
        JSON.stringify({
          version: SNAPSHOT_STORE_VERSION,
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

  return {
    path: settingsPath,
    load() {
      return readJsonFile<KmuxSettings>(settingsPath);
    },
    save(settings) {
      atomicWrite(settingsPath, JSON.stringify(settings, null, 2));
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
  socketPath: string;
} {
  const configDir = env.KMUX_CONFIG_DIR ?? join(homeDir, ".config", "kmux");
  const runtimeDir = env.KMUX_RUNTIME_DIR ?? join(homeDir, ".kmux");
  return {
    statePath: join(configDir, "state.json"),
    windowStatePath: join(configDir, "window-state.json"),
    settingsPath: join(configDir, "settings.json"),
    socketPath: join(runtimeDir, "control.sock")
  };
}
