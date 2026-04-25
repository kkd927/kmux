import { isDeepStrictEqual } from "node:util";

import { BrowserWindow, Notification, shell } from "electron";

import {
  type AppAction,
  type AppEffect,
  type AppMutationSummary,
  type AppState,
  buildActiveWorkspaceActivityVm,
  buildActiveWorkspacePaneTreeVm,
  buildNotificationsVm,
  buildShellSettingsVm,
  buildShellWindowChromeVm,
  buildWorkspaceRowsVm,
  cloneState,
  createDefaultSettings,
  createInitialState,
  mergeSettings
} from "@kmux/core";
import type {
  Id,
  ResolvedTerminalTypographyVm,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  WorkspaceRowsPatch,
  WorkspaceRowVm
} from "@kmux/proto";
import type {
  SettingsFileStore,
  SnapshotFileStore,
  WindowStateFileStore
} from "@kmux/persistence";

import type { AppStore } from "./store";
import type { PtyHostManager } from "./ptyHost";
import type { MetadataRefreshOptions } from "./metadataRuntime";
import { logDiagnostics } from "../shared/diagnostics";
import {
  type FontInventoryProvider,
  TerminalTypographyController
} from "./terminalTypography";
import {
  profileNowMs
} from "../shared/nodeSmoothnessProfile";
import type { SmoothnessProfileRecorder } from "../shared/smoothnessProfile";

export interface AppRuntimeOptions {
  paths: {
    socketPath: string;
    nodePath: string;
  };
  snapshotStore: SnapshotFileStore;
  windowStateStore: WindowStateFileStore;
  settingsStore: SettingsFileStore;
  defaultShellPath: string;
  refreshMetadata: (
    surfaceId: Id,
    cwd?: string,
    pid?: number,
    refreshOptions?: MetadataRefreshOptions
  ) => void;
  persistWindowState: (window: BrowserWindow) => void;
  fontInventoryProvider?: FontInventoryProvider;
  onDidDispatchAppAction?: (action: AppAction, state: AppState) => void;
  profileRecorder?: SmoothnessProfileRecorder;
}

export interface AppRuntime {
  setStore(store: AppStore): void;
  setPtyHost(ptyHost: PtyHostManager | null): void;
  setMainWindow(window: BrowserWindow | null): void;
  getState(): AppState;
  getShellState(): ShellStoreSnapshot;
  dispatchAppAction(action: AppAction): void;
  runEffects(effects: AppEffect[]): void;
  syncWindowTitles(): void;
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
  let shellState: ShellStoreSnapshot | null = null;
  let suppressTerminalTypographyPatch = 0;
  const terminalTypographyController = new TerminalTypographyController({
    initialSettings: createDefaultSettings("kmuxOnly", options.defaultShellPath)
      .terminalTypography,
    fontInventoryProvider: options.fontInventoryProvider,
    shouldLogInventoryErrors: () => !shuttingDown,
    onDidChange: () => {
      if (store && suppressTerminalTypographyPatch === 0) {
        emitShellPatch(new Set(["terminalTypography"]));
      }
    }
  });

  function getState(): AppState {
    if (!store) {
      throw new Error("Store not ready");
    }
    return store.getState();
  }

  function getShellState(): ShellStoreSnapshot {
    if (!shellState) {
      shellState = buildShellStateSnapshot(0);
    }
    return shellState;
  }

  function buildShellStateSnapshot(version: number): ShellStoreSnapshot {
    const state = getState();
    return {
      version,
      ...buildShellWindowChromeVm(state),
      workspaceRows: buildWorkspaceRowsVm(state),
      activeWorkspace: buildActiveWorkspaceActivityVm(state),
      activeWorkspacePaneTree: buildActiveWorkspacePaneTreeVm(state),
      notifications: buildNotificationsVm(state),
      settings: buildShellSettingsVm(state),
      terminalTypography: terminalTypographyController.getViewModel()
    };
  }

  function syncWindowTitles(): void {
    const title = getShellState().title;
    for (const window of BrowserWindow.getAllWindows()) {
      window.setTitle(title);
    }
  }

  function broadcastShellPatch(patch: ShellPatch): void {
    const nextTitle = getShellState().title;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("kmux:shell-patch", patch);
      if ("title" in patch) {
        window.setTitle(nextTitle);
      }
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
      options.snapshotStore.save(store.getState(), {
        cleanShutdown: false
      });
      options.settingsStore.save(store.getState().settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        options.persistWindowState(mainWindow);
      }
    }, 300);
  }

  function emitShellPatch(groups: Set<ShellGroup>): void {
    if (!store || groups.size === 0) {
      return;
    }

    const profileStartedAt = profileNowMs();
    const currentShellState = getShellState();
    const nextPatch: ShellPatch = {
      version: currentShellState.version
    };
    const nextShellStatePatch: Partial<Omit<ShellStoreSnapshot, "version">> = {};
    let didChange = false;

    if (groups.has("window")) {
      const nextWindowChrome = buildShellWindowChromeVm(getState());
      if (!isDeepStrictEqual(currentShellState.windowId, nextWindowChrome.windowId)) {
        nextPatch.windowId = nextWindowChrome.windowId;
        nextShellStatePatch.windowId = nextWindowChrome.windowId;
        didChange = true;
      }
      if (!isDeepStrictEqual(currentShellState.title, nextWindowChrome.title)) {
        nextPatch.title = nextWindowChrome.title;
        nextShellStatePatch.title = nextWindowChrome.title;
        didChange = true;
      }
      if (
        !isDeepStrictEqual(
          currentShellState.sidebarVisible,
          nextWindowChrome.sidebarVisible
        )
      ) {
        nextPatch.sidebarVisible = nextWindowChrome.sidebarVisible;
        nextShellStatePatch.sidebarVisible = nextWindowChrome.sidebarVisible;
        didChange = true;
      }
      if (
        !isDeepStrictEqual(
          currentShellState.sidebarWidth,
          nextWindowChrome.sidebarWidth
        )
      ) {
        nextPatch.sidebarWidth = nextWindowChrome.sidebarWidth;
        nextShellStatePatch.sidebarWidth = nextWindowChrome.sidebarWidth;
        didChange = true;
      }
      if (
        !isDeepStrictEqual(
          currentShellState.unreadNotifications,
          nextWindowChrome.unreadNotifications
        )
      ) {
        nextPatch.unreadNotifications = nextWindowChrome.unreadNotifications;
        nextShellStatePatch.unreadNotifications =
          nextWindowChrome.unreadNotifications;
        didChange = true;
      }
    }

    if (groups.has("workspaceRows")) {
      const workspaceRows = buildWorkspaceRowsVm(getState());
      if (!isDeepStrictEqual(currentShellState.workspaceRows, workspaceRows)) {
        const workspaceRowsPatch = buildWorkspaceRowsPatch(
          currentShellState.workspaceRows,
          workspaceRows
        );
        if (workspaceRowsPatch) {
          nextPatch.workspaceRowsPatch = workspaceRowsPatch;
        } else {
          nextPatch.workspaceRows = workspaceRows;
        }
        nextShellStatePatch.workspaceRows = workspaceRows;
        didChange = true;
      }
    }

    if (groups.has("activeWorkspace")) {
      const activeWorkspace = buildActiveWorkspaceActivityVm(getState());
      if (
        !isDeepStrictEqual(currentShellState.activeWorkspace, activeWorkspace)
      ) {
        nextPatch.activeWorkspace = activeWorkspace;
        nextShellStatePatch.activeWorkspace = activeWorkspace;
        didChange = true;
      }
    }

    if (groups.has("activeWorkspacePaneTree")) {
      const activeWorkspacePaneTree = buildActiveWorkspacePaneTreeVm(getState());
      if (
        !isDeepStrictEqual(
          currentShellState.activeWorkspacePaneTree,
          activeWorkspacePaneTree
        )
      ) {
        nextPatch.activeWorkspacePaneTree = activeWorkspacePaneTree;
        nextShellStatePatch.activeWorkspacePaneTree = activeWorkspacePaneTree;
        didChange = true;
      }
    }

    if (groups.has("notifications")) {
      const notifications = buildNotificationsVm(getState());
      if (!isDeepStrictEqual(currentShellState.notifications, notifications)) {
        nextPatch.notifications = notifications;
        nextShellStatePatch.notifications = notifications;
        didChange = true;
      }
    }

    if (groups.has("settings")) {
      const settings = buildShellSettingsVm(getState());
      if (!isDeepStrictEqual(currentShellState.settings, settings)) {
        nextPatch.settings = settings;
        nextShellStatePatch.settings = settings;
        didChange = true;
      }
    }

    if (groups.has("terminalTypography")) {
      const terminalTypography = terminalTypographyController.getViewModel();
      if (
        !isDeepStrictEqual(
          currentShellState.terminalTypography,
          terminalTypography
        )
      ) {
        nextPatch.terminalTypography = terminalTypography;
        nextShellStatePatch.terminalTypography = terminalTypography;
        didChange = true;
      }
    }

    if (!didChange) {
      return;
    }

    const version = currentShellState.version + 1;
    const outgoingPatch = {
      ...nextPatch,
      version
    };
    const updatedShellState = {
      ...currentShellState,
      ...nextShellStatePatch,
      version
    } satisfies ShellStoreSnapshot;
    shellState = updatedShellState;
    broadcastShellPatch(outgoingPatch);
    if (options.profileRecorder?.enabled) {
      const profileEndedAt = profileNowMs();
      options.profileRecorder.record({
        source: "main",
        name: "shell.patch.emit",
        at: profileEndedAt,
        details: {
          version,
          requestedGroups: [...groups].sort(),
          changedKeys: Object.keys(outgoingPatch).filter(
            (key) => key !== "version"
          ),
          payloadBytes: Buffer.byteLength(JSON.stringify(outgoingPatch), "utf8"),
          durationMs: profileEndedAt - profileStartedAt
        }
      });
    }
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
            effect.pid,
            effect.branchOnly ? { branchOnly: true } : undefined
          );
          break;
        case "notify.desktop":
          logDiagnostics("main.effect.notify.desktop", {
            enabled: getState().settings.notificationDesktop,
            title: effect.notification.title,
            message: effect.notification.message
          });
          if (getState().settings.notificationDesktop) {
            new Notification({
              title: effect.notification.title,
              body: effect.notification.message
            }).show();
          }
          break;
        case "bell.sound":
          logDiagnostics("main.effect.bell.sound", {
            enabled: getState().settings.notificationSound
          });
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
  }

  function dispatchAppAction(action: AppAction): void {
    const previousSettings = store?.getState().settings.terminalTypography;
    const result = store?.dispatch(action) ?? {
      effects: [],
      mutation: {}
    };
    const effects = result.effects;
    const shellGroups = shellGroupsFromMutation(result.mutation);
    if (
      action.type === "agent.event" ||
      action.type === "notification.create" ||
      action.type === "terminal.bell"
    ) {
      logDiagnostics("main.action.dispatched", {
        actionType: action.type,
        effectTypes: effects.map((effect) => effect.type),
        workspaceId: "workspaceId" in action ? action.workspaceId : undefined,
        paneId: "paneId" in action ? action.paneId : undefined,
        surfaceId: "surfaceId" in action ? action.surfaceId : undefined,
        sessionId: "sessionId" in action ? action.sessionId : undefined,
        agent: action.type === "agent.event" ? action.agent : undefined,
        event: action.type === "agent.event" ? action.event : undefined,
        source:
          action.type === "agent.event"
            ? action.details?.source
            : action.type === "notification.create"
              ? action.source
              : undefined,
        uiOnly:
          action.type === "agent.event" ? action.details?.uiOnly === true : undefined,
        visibleToUser:
          action.type === "agent.event"
            ? action.details?.visibleToUser === true
            : undefined,
        title:
          action.type === "notification.create" || action.type === "agent.event"
            ? action.title
            : undefined,
        message:
          action.type === "notification.create" || action.type === "agent.event"
            ? action.message
            : undefined
      });
    }
    const currentState = store?.getState();
    if (currentState) {
      options.onDidDispatchAppAction?.(action, currentState);
    }
    const nextSettings = store?.getState().settings.terminalTypography;
    const terminalTypographySettingsChanged =
      Boolean(previousSettings && nextSettings) &&
      !areTerminalTypographySettingsEqual(previousSettings!, nextSettings!);
    if (
      previousSettings &&
      nextSettings &&
      terminalTypographySettingsChanged
    ) {
      suppressTerminalTypographyPatch += 1;
      try {
        terminalTypographyController.setSettings(nextSettings);
      } finally {
        suppressTerminalTypographyPatch -= 1;
      }
      shellGroups.add("terminalTypography");
    }
    runEffects(effects);
    emitShellPatch(shellGroups);
  }

  function restoreInitialState(): AppState {
    const snapshotRecord = options.snapshotStore.loadRecord();
    const snapshot = snapshotRecord?.snapshot ?? null;
    const savedWindowState = options.windowStateStore.load();
    const settings =
      options.settingsStore.load() ??
      createDefaultSettings("kmuxOnly", options.defaultShellPath);
    const shouldRestoreSnapshot =
      snapshot !== null && snapshotRecord?.cleanShutdown !== true;
    const initial =
      shouldRestoreSnapshot
        ? cloneState(snapshot)
        : createInitialState(options.defaultShellPath);

    initial.settings = mergeSettings(initial.settings, settings ?? {});

    if (shouldRestoreSnapshot) {
      for (const session of Object.values(initial.sessions)) {
        if (session.runtimeState !== "exited") {
          session.runtimeState = "pending";
          delete session.pid;
          delete session.exitCode;
        }
      }
      clearSnapshotNotifications(initial);
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
      const shutdownSnapshot = createCleanShutdownSnapshot(
        store.getState(),
        options.defaultShellPath
      );
      options.snapshotStore.save(shutdownSnapshot, {
        cleanShutdown: true
      });
      options.settingsStore.save(store.getState().settings);
    }
  }

  return {
    setStore(nextStore) {
      store = nextStore;
      suppressTerminalTypographyPatch += 1;
      try {
        terminalTypographyController.setSettings(
          nextStore.getState().settings.terminalTypography
        );
      } finally {
        suppressTerminalTypographyPatch -= 1;
      }
      shellState = buildShellStateSnapshot(0);
      options.snapshotStore.save(nextStore.getState(), {
        cleanShutdown: false
      });
    },
    setPtyHost(nextPtyHost) {
      ptyHost = nextPtyHost;
    },
    setMainWindow(window) {
      mainWindow = window;
    },
    getState,
    getShellState,
    dispatchAppAction,
    runEffects,
    syncWindowTitles,
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

function clearSnapshotNotifications(state: AppState): void {
  if (state.notifications.length === 0) {
    return;
  }
  state.notifications = [];
  for (const surface of Object.values(state.surfaces)) {
    surface.unreadCount = 0;
    surface.attention = false;
  }
}

function createCleanShutdownSnapshot(
  currentState: AppState,
  defaultShellPath: string
): AppState {
  const cleanState = createInitialState(defaultShellPath);
  cleanState.settings = mergeSettings(cleanState.settings, currentState.settings);

  const currentWindow = currentState.windows[currentState.activeWindowId];
  const cleanWindow = cleanState.windows[cleanState.activeWindowId];

  if (currentWindow && cleanWindow) {
    cleanWindow.sidebarVisible = currentWindow.sidebarVisible;
    cleanWindow.sidebarWidth = currentWindow.sidebarWidth;
  }

  return cleanState;
}

type ShellGroup =
  | "window"
  | "workspaceRows"
  | "activeWorkspace"
  | "activeWorkspacePaneTree"
  | "notifications"
  | "settings"
  | "terminalTypography";

function buildWorkspaceRowsPatch(
  currentRows: WorkspaceRowVm[],
  nextRows: WorkspaceRowVm[]
): WorkspaceRowsPatch | null {
  const currentById = new Map(
    currentRows.map((row) => [row.workspaceId, row] as const)
  );
  const nextById = new Map(nextRows.map((row) => [row.workspaceId, row] as const));
  const remove = currentRows
    .map((row) => row.workspaceId)
    .filter((workspaceId) => !nextById.has(workspaceId));
  const upsert = nextRows.filter((row) => {
    const current = currentById.get(row.workspaceId);
    return !current || !isDeepStrictEqual(current, row);
  });
  const currentOrder = currentRows.map((row) => row.workspaceId);
  const nextOrder = nextRows.map((row) => row.workspaceId);
  const order = isDeepStrictEqual(currentOrder, nextOrder)
    ? undefined
    : nextOrder;

  if (remove.length === 0 && upsert.length === 0 && !order) {
    return null;
  }

  return {
    ...(upsert.length > 0 ? { upsert } : {}),
    ...(remove.length > 0 ? { remove } : {}),
    ...(order ? { order } : {})
  };
}

function shellGroupsFromMutation(mutation: AppMutationSummary): Set<ShellGroup> {
  const groups = new Set<ShellGroup>();
  if (mutation.window) {
    groups.add("window");
  }
  if (mutation.workspaceRows) {
    groups.add("workspaceRows");
  }
  if (mutation.activeWorkspaceActivity) {
    groups.add("activeWorkspace");
  }
  if (mutation.activeWorkspacePaneTree) {
    groups.add("activeWorkspacePaneTree");
  }
  if (mutation.notifications) {
    groups.add("notifications");
  }
  if (mutation.settings) {
    groups.add("settings");
  }
  if (mutation.terminalTypography) {
    groups.add("terminalTypography");
  }
  return groups;
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
