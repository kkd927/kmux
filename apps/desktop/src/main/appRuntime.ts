import { BrowserWindow, Notification, shell } from "electron";

import {
  type AppAction,
  type AppEffect,
  type AppState,
  cloneState,
  createDefaultSettings,
  createInitialState,
  mergeSettings
} from "@kmux/core";
import type {
  Id,
  ResolvedTerminalTypographyVm,
  ShellIdentity,
  ShellViewModel,
  TerminalTypographyProbeReport,
  TerminalTypographySettings
} from "@kmux/proto";
import type {
  SettingsFileStore,
  SnapshotFileStore,
  WindowStateFileStore
} from "@kmux/persistence";

import type { AppStore } from "./store";
import type { PtyHostManager } from "./ptyHost";
import {
  type FontInventoryProvider,
  TerminalTypographyController
} from "./terminalTypography";

interface AppRuntimeOptions {
  paths: {
    socketPath: string;
    cliPath?: string;
    cliTsxLoaderPath?: string;
    cliWorkingDirectory?: string;
    nodePath: string;
  };
  snapshotStore: SnapshotFileStore;
  windowStateStore: WindowStateFileStore;
  settingsStore: SettingsFileStore;
  defaultShellPath: string;
  refreshMetadata: (surfaceId: Id, cwd?: string, pid?: number) => void;
  persistWindowState: (window: BrowserWindow) => void;
  fontInventoryProvider?: FontInventoryProvider;
}

export interface AppRuntime {
  setStore(store: AppStore): void;
  setPtyHost(ptyHost: PtyHostManager | null): void;
  setMainWindow(window: BrowserWindow | null): void;
  getState(): AppState;
  getView(): ShellViewModel;
  dispatchAppAction(action: AppAction): void;
  runEffects(effects: AppEffect[]): void;
  broadcastView(): void;
  restoreInitialState(): AppState;
  capabilityList(): string[];
  identify(): ShellIdentity;
  listTerminalFontFamilies(): Promise<string[]>;
  previewTerminalTypography(
    settings: TerminalTypographySettings
  ): Promise<ResolvedTerminalTypographyVm>;
  reportTerminalTypographyProbe(report: TerminalTypographyProbeReport): void;
  respawnRestoredSessions(): void;
  shutdown(): void;
}

export function createAppRuntime(options: AppRuntimeOptions): AppRuntime {
  let store: AppStore | null = null;
  let ptyHost: PtyHostManager | null = null;
  let mainWindow: BrowserWindow | null = null;
  let persistTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  const terminalTypographyController = new TerminalTypographyController({
    initialSettings: createDefaultSettings("kmuxOnly", options.defaultShellPath)
      .terminalTypography,
    fontInventoryProvider: options.fontInventoryProvider,
    shouldLogInventoryErrors: () => !shuttingDown,
    onDidChange: () => {
      if (store) {
        broadcastView();
      }
    }
  });

  function getState(): AppState {
    if (!store) {
      throw new Error("Store not ready");
    }
    return store.getState();
  }

  function getView(): ShellViewModel {
    if (!store) {
      throw new Error("Store not ready");
    }
    return {
      ...store.getView(),
      terminalTypography: terminalTypographyController.getViewModel()
    };
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
      options.snapshotStore.save(store.getState());
      options.settingsStore.save(store.getState().settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        options.persistWindowState(mainWindow);
      }
    }, 300);
  }

  function runEffects(effects: AppEffect[]): void {
    if (effects.length === 0) {
      return;
    }

    for (const effect of effects) {
      switch (effect.type) {
        case "session.spawn":
          ptyHost?.send({
            type: "spawn",
            spec: {
              ...effect.spec,
              env: {
                ...effect.spec.env,
                ...(options.paths.cliPath
                  ? { KMUX_CLI_PATH: options.paths.cliPath }
                  : {}),
                ...(options.paths.cliTsxLoaderPath
                  ? { KMUX_CLI_TSX_LOADER_PATH: options.paths.cliTsxLoaderPath }
                  : {}),
                ...(options.paths.cliWorkingDirectory
                  ? { KMUX_CLI_CWD: options.paths.cliWorkingDirectory }
                  : {}),
                KMUX_NODE_PATH: options.paths.nodePath,
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
          options.refreshMetadata(
            effect.surfaceId ?? "",
            effect.cwd,
            effect.pid
          );
          break;
        case "notify.desktop":
          if (getState().settings.notificationDesktop) {
            new Notification({
              title: effect.notification.title,
              body: effect.notification.message
            }).show();
          }
          break;
        case "bell.sound":
          if (getState().settings.notificationSound) {
            shell.beep();
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
    const previousSettings = store?.getState().settings.terminalTypography;
    const effects = store?.dispatch(action) ?? [];
    const nextSettings = store?.getState().settings.terminalTypography;
    if (
      previousSettings &&
      nextSettings &&
      !areTerminalTypographySettingsEqual(previousSettings, nextSettings)
    ) {
      terminalTypographyController.setSettings(nextSettings);
    }
    runEffects(effects);
  }

  function restoreInitialState(): AppState {
    const snapshot = options.snapshotStore.load();
    const savedWindowState = options.windowStateStore.load();
    const settings =
      options.settingsStore.load() ??
      createDefaultSettings("kmuxOnly", options.defaultShellPath);
    const initial =
      snapshot && settings.startupRestore
        ? cloneState(snapshot)
        : createInitialState(options.defaultShellPath);

    initial.settings = mergeSettings(initial.settings, settings ?? {});

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
      "agent.event",
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

  function listTerminalFontFamilies(): Promise<string[]> {
    return terminalTypographyController.listFontFamilies();
  }

  function previewTerminalTypography(
    settings: TerminalTypographySettings
  ): Promise<ResolvedTerminalTypographyVm> {
    return terminalTypographyController.preview(settings);
  }

  function reportTerminalTypographyProbe(
    report: TerminalTypographyProbeReport
  ): void {
    terminalTypographyController.reportProbe(report);
  }

  function respawnRestoredSessions(): void {
    const state = getState();
    for (const session of Object.values(state.sessions)) {
      if (session.runtimeState !== "exited") {
        const workspaceId =
          state.panes[state.surfaces[session.surfaceId].paneId].workspaceId;
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
    shuttingDown = true;
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    if (mainWindow) {
      options.persistWindowState(mainWindow);
    }
    if (store) {
      options.snapshotStore.save(store.getState());
      options.settingsStore.save(store.getState().settings);
    }
  }

  return {
    setStore(nextStore) {
      store = nextStore;
      terminalTypographyController.setSettings(
        nextStore.getState().settings.terminalTypography
      );
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
    listTerminalFontFamilies,
    previewTerminalTypography,
    reportTerminalTypographyProbe,
    respawnRestoredSessions,
    shutdown
  };
}

function areTerminalTypographySettingsEqual(
  left: TerminalTypographySettings,
  right: TerminalTypographySettings
): boolean {
  return (
    left.preferredTextFontFamily === right.preferredTextFontFamily &&
    left.fontSize === right.fontSize &&
    left.lineHeight === right.lineHeight &&
    left.preferredSymbolFallbackFamilies.length ===
      right.preferredSymbolFallbackFamilies.length &&
    left.preferredSymbolFallbackFamilies.every(
      (fontFamily, index) =>
        fontFamily === right.preferredSymbolFallbackFamilies[index]
    )
  );
}
