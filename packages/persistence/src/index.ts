import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type { AppState } from "@kmux/core";
import type { KmuxSettings } from "@kmux/proto";

const APP_ROW_ID = "singleton";

export interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export class KmuxDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_window (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  loadSnapshot(): AppState | null {
    const row = this.db
      .prepare("SELECT payload FROM app_state WHERE id = ?")
      .get(APP_ROW_ID) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AppState) : null;
  }

  saveSnapshot(snapshot: AppState): void {
    this.db
      .prepare(
        `
          INSERT INTO app_state (id, payload, updated_at)
          VALUES (@id, @payload, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
        `
      )
      .run({
        id: APP_ROW_ID,
        payload: JSON.stringify(snapshot)
      });
  }

  loadWindowState(): PersistedWindowState | null {
    const row = this.db
      .prepare("SELECT payload FROM app_window WHERE id = ?")
      .get(APP_ROW_ID) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as PersistedWindowState) : null;
  }

  saveWindowState(windowState: PersistedWindowState): void {
    this.db
      .prepare(
        `
          INSERT INTO app_window (id, payload, updated_at)
          VALUES (@id, @payload, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
        `
      )
      .run({
        id: APP_ROW_ID,
        payload: JSON.stringify(windowState)
      });
  }

  close(): void {
    this.db.close();
  }
}

export interface SettingsFileStore {
  path: string;
  load(): KmuxSettings | null;
  save(settings: KmuxSettings): void;
}

export function createSettingsStore(settingsPath: string): SettingsFileStore {
  mkdirSync(dirname(settingsPath), { recursive: true });

  return {
    path: settingsPath,
    load() {
      try {
        return JSON.parse(readFileSync(settingsPath, "utf8")) as KmuxSettings;
      } catch {
        return null;
      }
    },
    save(settings) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  };
}

export function defaultAppPaths(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): {
  dbPath: string;
  settingsPath: string;
  socketPath: string;
} {
  const configDir = env.KMUX_CONFIG_DIR ?? join(homeDir, ".config", "kmux");
  const runtimeDir = env.KMUX_RUNTIME_DIR ?? join(homeDir, ".kmux");
  return {
    dbPath: join(configDir, "kmux.db"),
    settingsPath: join(configDir, "settings.json"),
    socketPath: join(runtimeDir, "control.sock")
  };
}
