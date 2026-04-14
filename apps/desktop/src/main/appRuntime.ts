import {BrowserWindow, Notification} from "electron";

import {
  type AppAction,
  type AppEffect,
  type AppState,
  cloneState,
  createDefaultSettings,
  createInitialState
} from "@kmux/core";
import type {Id, ShellIdentity} from "@kmux/proto";
import type {KmuxDatabase, SettingsFileStore} from "@kmux/persistence";

import type {AppStore} from "./store";
import type {PtyHostManager} from "./ptyHost";

interface AppRuntimeOptions {
  paths: {
    socketPath: string;
  };
  db: KmuxDatabase;
  settingsStore: SettingsFileStore;
  refreshMetadata: (surfaceId: Id, cwd?: string, pid?: number) => void;
  persistWindowState: (window: BrowserWindow) => void;
}

export interface AppRuntime {
  setStore(store: AppStore): void;
  setPtyHost(ptyHost: PtyHostManager | null): void;
  setMainWindow(window: BrowserWindow | null): void;
  getState(): AppState;
  getView(): ReturnType<AppStore["getView"]>;
  dispatchAppAction(action: AppAction): void;
  runEffects(effects: AppEffect[]): void;
  broadcastView(): void;
  restoreInitialState(): AppState;
  capabilityList(): string[];
  identify(): ShellIdentity;
  respawnRestoredSessions(): void;
  shutdown(): void;
}

export function createAppRuntime(options: AppRuntimeOptions): AppRuntime {
  let store: AppStore | null = null;
  let ptyHost: PtyHostManager | null = null;
  let mainWindow: BrowserWindow | null = null;
  let persistTimer: NodeJS.Timeout | null = null;

  function getState(): AppState {
    if (!store) {
      throw new Error("Store not ready");
    }
    return store.getState();
  }

  function getView(): ReturnType<AppStore["getView"]> {
    if (!store) {
      throw new Error("Store not ready");
    }
    return store.getView();
  }

  function broadcastView(): void {
    const view = getView();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("kmux:view", view);
      window.setTitle(view.title);
    }
  }

  function schedulePersist(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      if (!store) {
        return;
      }
      options.db.saveSnapshot(store.getState());
      options.settingsStore.save(store.getState().settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        options.persistWindowState(mainWindow);
      }
    }, 300);
  }

  function runEffects(effects: AppEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "session.spawn":
          ptyHost?.send({
            type: "spawn",
            spec: {
              ...effect.spec,
              env: {
                ...effect.spec.env,
                KMUX_SOCKET_PATH: options.paths.socketPath
              }
            }
          });
          break;
        case "session.close":
          ptyHost?.send({
            type: "close",
            sessionId: effect.sessionId
          });
          break;
        case "metadata.refresh":
          options.refreshMetadata(effect.surfaceId ?? "", effect.cwd, effect.pid);
          break;
        case "notify.desktop":
          if (getState().settings.notificationDesktop) {
            new Notification({
              title: effect.notification.title,
              body: effect.notification.message
            }).show();
          }
          break;
        case "persist":
          schedulePersist();
          break;
        default:
          break;
      }
    }
    broadcastView();
  }

  function dispatchAppAction(action: AppAction): void {
    const effects = store?.dispatch(action) ?? [];
    runEffects(effects);
  }

  function restoreInitialState(): AppState {
    const snapshot = options.db.loadSnapshot();
    const savedWindowState = options.db.loadWindowState();
    const settings = options.settingsStore.load() ?? createDefaultSettings();
    const initial =
      snapshot && settings.startupRestore
        ? cloneState(snapshot)
        : createInitialState();

    initial.settings = {
      ...initial.settings,
      ...settings,
      shortcuts: {
        ...initial.settings.shortcuts,
        ...settings.shortcuts
      }
    };

    if (settings.startupRestore) {
      for (const session of Object.values(initial.sessions)) {
        if (session.runtimeState !== "exited") {
          session.runtimeState = "pending";
          delete session.pid;
          delete session.exitCode;
        }
      }
    }

    const activeWindow = initial.windows[initial.activeWindowId];
    const persistedSidebarWidth = savedWindowState?.sidebarWidth;
    if (
      activeWindow &&
      typeof persistedSidebarWidth === "number" &&
      Number.isFinite(persistedSidebarWidth)
    ) {
      activeWindow.sidebarWidth = persistedSidebarWidth;
    }

    return initial;
  }

  function capabilityList(): string[] {
    return [
      "workspace.list",
      "workspace.create",
      "workspace.select",
      "workspace.current",
      "workspace.close",
      "surface.list",
      "surface.split",
      "surface.focus",
      "surface.send_text",
      "surface.send_key",
      "notification.create",
      "notification.list",
      "notification.clear",
      "sidebar.set_status",
      "sidebar.clear_status",
      "sidebar.set_progress",
      "sidebar.clear_progress",
      "sidebar.log",
      "sidebar.clear_log",
      "sidebar.state",
      "sidebar_state",
      "system.ping",
      "system.capabilities",
      "system.identify"
    ];
  }

  function identify(): ShellIdentity {
    const state = getState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    return {
      socketPath: options.paths.socketPath,
      socketMode: state.settings.socketMode,
      windowId: state.activeWindowId,
      activeWorkspaceId: workspaceId,
      activeSurfaceId: surfaceId,
      capabilities: capabilityList()
    };
  }

  function respawnRestoredSessions(): void {
    const state = getState();
    for (const session of Object.values(state.sessions)) {
      if (session.runtimeState !== "exited") {
        const workspaceId = state.panes[state.surfaces[session.surfaceId].paneId]
          .workspaceId;
        runEffects([
          {
            type: "session.spawn",
            spec: {
              sessionId: session.id,
              surfaceId: session.surfaceId,
              workspaceId,
              launch: session.launch,
              cols: 120,
              rows: 30,
              env: {
                KMUX_SOCKET_MODE: state.settings.socketMode,
                KMUX_WORKSPACE_ID: workspaceId,
                KMUX_SURFACE_ID: session.surfaceId,
                KMUX_AUTH_TOKEN: session.authToken,
                TERM_PROGRAM: "kmux"
              }
            }
          }
        ]);
      }
    }
  }

  function shutdown(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    if (mainWindow) {
      options.persistWindowState(mainWindow);
    }
    if (store) {
      options.db.saveSnapshot(store.getState());
      options.settingsStore.save(store.getState().settings);
    }
  }

  return {
    setStore(nextStore) {
      store = nextStore;
    },
    setPtyHost(nextPtyHost) {
      ptyHost = nextPtyHost;
    },
    setMainWindow(window) {
      mainWindow = window;
    },
    getState,
    getView,
    dispatchAppAction,
    runEffects,
    broadcastView,
    restoreInitialState,
    capabilityList,
    identify,
    respawnRestoredSessions,
    shutdown
  };
}
