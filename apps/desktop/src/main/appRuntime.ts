import { isDeepStrictEqual } from "node:util";

import { BrowserWindow, shell } from "electron";

import {
  type AppAction,
  type AppEffect,
  type AppMutationSummary,
  type AppState,
  type SessionSpawnEffect,
  buildActiveWorkspaceActivityVm,
  buildActiveWorkspacePaneTreeVm,
  buildAllWorkspacePaneTreesVm,
  buildWorkspacePaneTreeVm,
  buildNotificationsVm,
  buildShellSettingsVm,
  buildShellWindowChromeVm,
  buildWorkspaceRowsVm,
  cloneState,
  createDefaultSettings,
  createInitialState,
  mergeSettings,
  migrateShortcutDefaultsForPlatform
} from "@kmux/core";
import type {
  ActiveWorkspacePaneTreeVm,
  ExternalAgentSessionRef,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  Id,
  ResolvedTerminalTypographyVm,
  SessionLaunchConfig,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  ShortcutDefaultsPlatform,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  WorkspacePaneTreesPatch,
  WorkspaceRowsPatch,
  WorkspaceRowVm
} from "@kmux/proto";
import type {
  SettingsFileStore,
  SnapshotFileStore,
  WindowStateFileStore
} from "@kmux/persistence";
import type { PtySessionSpec, ShellLaunchPolicy } from "../shared/ptyProtocol";

import type { AppStore } from "./store";
import type { PtyHostManager } from "./ptyHost";
import type { ExternalSessionResumeSpec } from "./externalSessions";
import { logDiagnostics } from "../shared/diagnostics";
import {
  type FontInventoryProvider,
  TerminalTypographyController
} from "./terminalTypography";
import { profileNowMs } from "../shared/nodeSmoothnessProfile";
import type { SmoothnessProfileRecorder } from "../shared/smoothnessProfile";
import {
  showNativeNotification,
  type NativeNotificationIdentity
} from "./nativeNotifications";

export interface AppRuntimeOptions {
  paths: {
    socketPath: string;
    nodePath: string;
  };
  createShellLaunchPolicy: (launch: SessionLaunchConfig) => ShellLaunchPolicy;
  snapshotStore: SnapshotFileStore;
  windowStateStore: WindowStateFileStore;
  settingsStore: SettingsFileStore;
  defaultShellPath: string;
  shortcutDefaultsPlatform?: ShortcutDefaultsPlatform;
  refreshMetadata: (surfaceId: Id, cwd?: string, pid?: number) => void;
  persistWindowState: (window: BrowserWindow) => void;
  fontInventoryProvider?: FontInventoryProvider;
  onDidDispatchAppAction?: (action: AppAction, state: AppState) => void;
  profileRecorder?: SmoothnessProfileRecorder;
  externalSessionIndexer?: ExternalSessionIndexerRuntime;
  nativeNotificationIdentity?: NativeNotificationIdentity;
  playBellSound?: () => void;
}

export interface ExternalSessionIndexerRuntime {
  listExternalAgentSessions: () => ExternalAgentSessionsSnapshot;
  resolveExternalAgentSession: (
    key: string
  ) => ExternalSessionResumeSpec | null;
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
  getExternalAgentSessions(): ExternalAgentSessionsSnapshot;
  resumeExternalAgentSession(key: string): ExternalAgentSessionResumeResult;
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
    initialSettings: createRuntimeDefaultSettings().terminalTypography,
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

  function createRuntimeDefaultSettings(): ReturnType<
    typeof createDefaultSettings
  > {
    return createDefaultSettings("kmuxOnly", options.defaultShellPath, {
      shortcutDefaultsPlatform: options.shortcutDefaultsPlatform
    });
  }

  function migrateRuntimeShortcutDefaults(
    settings: ReturnType<typeof createDefaultSettings>
  ): ReturnType<typeof createDefaultSettings> {
    return migrateShortcutDefaultsForPlatform(
      settings,
      options.shortcutDefaultsPlatform ?? "darwin"
    );
  }

  function buildShellStateSnapshot(version: number): ShellStoreSnapshot {
    const state = getState();
    return {
      version,
      ...buildShellWindowChromeVm(state),
      workspaceRows: buildWorkspaceRowsVm(state),
      activeWorkspace: buildActiveWorkspaceActivityVm(state),
      activeWorkspacePaneTree: buildActiveWorkspacePaneTreeVm(state),
      workspacePaneTrees: buildAllWorkspacePaneTreesVm(state),
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

  function emitShellPatch(
    groups: Set<ShellGroup>,
    profileContext: ShellPatchProfileContext = {}
  ): void {
    if (!store || groups.size === 0) {
      return;
    }

    const profileStartedAt = profileNowMs();
    const currentShellState = getShellState();
    const nextPatch: ShellPatch = {
      version: currentShellState.version
    };
    const nextShellStatePatch: Partial<Omit<ShellStoreSnapshot, "version">> =
      {};
    let didChange = false;

    if (groups.has("window")) {
      const nextWindowChrome = buildShellWindowChromeVm(getState());
      if (
        !isDeepStrictEqual(
          currentShellState.windowId,
          nextWindowChrome.windowId
        )
      ) {
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
      const activeWorkspacePaneTree =
        buildActiveWorkspacePaneTreeVm(getState());
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

    if (groups.has("workspacePaneTrees")) {
      const state = getState();
      const currentTrees = currentShellState.workspacePaneTrees;
      const nextTrees: Record<Id, ActiveWorkspacePaneTreeVm> = {};
      const paneTreesPatch = buildWorkspacePaneTreesPatch(
        state,
        currentTrees,
        nextTrees
      );
      if (paneTreesPatch) {
        nextPatch.workspacePaneTreesPatch = paneTreesPatch;
        nextShellStatePatch.workspacePaneTrees = nextTrees;
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
          ...profileContext,
          requestedGroups: [...groups].sort(),
          changedKeys: Object.keys(outgoingPatch).filter(
            (key) => key !== "version"
          ),
          payloadBytes: Buffer.byteLength(
            JSON.stringify(outgoingPatch),
            "utf8"
          ),
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
            spec: buildPtySessionSpec(effect),
            shellLaunchPolicy: options.createShellLaunchPolicy(effect.launch)
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
          logDiagnostics("main.effect.notify.desktop", {
            enabled: getState().settings.notificationDesktop,
            title: effect.notification.title,
            message: effect.notification.message
          });
          if (getState().settings.notificationDesktop) {
            showNativeNotification(
              {
                title: effect.notification.title,
                body: effect.notification.message
              },
              options.nativeNotificationIdentity,
              {
                diagnosticsScope: "main.effect.notify.desktop.failed",
                diagnosticsDetails: {
                  notificationId: effect.notification.id,
                  workspaceId: effect.notification.workspaceId,
                  paneId: effect.notification.paneId,
                  surfaceId: effect.notification.surfaceId,
                  source: effect.notification.source,
                  kind: effect.notification.kind,
                  agent: effect.notification.agent
                }
              }
            );
          }
          break;
        case "bell.sound":
          logDiagnostics("main.effect.bell.sound", {
            enabled: getState().settings.notificationSound
          });
          if (getState().settings.notificationSound) {
            playBellSound(options.playBellSound);
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
          action.type === "agent.event"
            ? action.details?.uiOnly === true
            : undefined,
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
    if (previousSettings && nextSettings && terminalTypographySettingsChanged) {
      suppressTerminalTypographyPatch += 1;
      try {
        terminalTypographyController.setSettings(nextSettings);
      } finally {
        suppressTerminalTypographyPatch -= 1;
      }
      shellGroups.add("terminalTypography");
    }
    runEffects(effects);
    emitShellPatch(
      shellGroups,
      shellPatchProfileContextForAction(action, effects)
    );
  }

  function restoreInitialState(): AppState {
    const snapshotRecord = options.snapshotStore.loadRecord();
    const snapshot = snapshotRecord?.snapshot ?? null;
    const savedWindowState = options.windowStateStore.load();
    const settings = migrateRuntimeShortcutDefaults(
      options.settingsStore.load() ?? createRuntimeDefaultSettings()
    );
    const shouldRestoreSnapshot =
      snapshot !== null &&
      (snapshotRecord?.cleanShutdown !== true ||
        snapshotRecord.restoreOnLaunch === true);
    const initial = shouldRestoreSnapshot
      ? cloneState(snapshot)
      : createInitialState(options.defaultShellPath);

    initial.settings = mergeSettings(initial.settings, settings ?? {});

    if (shouldRestoreSnapshot) {
      resetRestoredSessions(initial);
      clearSnapshotNotifications(initial);
    }

    const activeWindow = initial.windows[initial.activeWindowId];
    const persistedSidebarVisible = savedWindowState?.sidebarVisible;
    const persistedSidebarWidth = savedWindowState?.sidebarWidth;
    if (activeWindow && typeof persistedSidebarVisible === "boolean") {
      activeWindow.sidebarVisible = persistedSidebarVisible;
    }
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

  function getExternalAgentSessions(): ExternalAgentSessionsSnapshot {
    return (
      options.externalSessionIndexer?.listExternalAgentSessions() ?? {
        sessions: [],
        updatedAt: new Date().toISOString()
      }
    );
  }

  function resumeExternalAgentSession(
    key: string
  ): ExternalAgentSessionResumeResult {
    const spec =
      options.externalSessionIndexer?.resolveExternalAgentSession(key);
    if (!spec) {
      throw new Error("External session not found");
    }
    const existing = findOpenExternalAgentSession(spec);
    if (existing) {
      dispatchAppAction({
        type: "surface.focus",
        surfaceId: existing.surfaceId
      });
      return existing;
    }
    dispatchAppAction({
      type: "workspace.create",
      name: spec.title,
      cwd: spec.cwd,
      launch: spec.launch,
      agentSessionRef: spec.agentSessionRef
    });
    const state = getState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const workspace = state.workspaces[workspaceId];
    const paneId = workspace.activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    return { workspaceId, surfaceId };
  }

  function findOpenExternalAgentSession(
    spec: ExternalSessionResumeSpec
  ): ExternalAgentSessionResumeResult | null {
    const state = getState();
    for (const session of Object.values(state.sessions)) {
      if (session.runtimeState === "exited") {
        continue;
      }
      const agentSessionRefMatches = externalAgentSessionRefsMatch(
        session.agentSessionRef,
        spec.agentSessionRef
      );
      if (
        !agentSessionRefMatches &&
        !launchCommandsMatch(session.launch, spec.launch)
      ) {
        continue;
      }
      const surface = state.surfaces[session.surfaceId];
      if (!surface) {
        continue;
      }
      const pane = state.panes[surface.paneId];
      if (!pane) {
        continue;
      }
      return {
        workspaceId: pane.workspaceId,
        surfaceId: surface.id
      };
    }
    return null;
  }

  function launchCommandsMatch(
    left: SessionLaunchConfig,
    right: SessionLaunchConfig
  ): boolean {
    const defaultShell = getState().settings.shell || options.defaultShellPath;
    return (
      effectiveLaunchShell(left, defaultShell) ===
        effectiveLaunchShell(right, defaultShell) &&
      arrayShallowEqual(left.args, right.args) &&
      (left.initialInput ?? "") === (right.initialInput ?? "")
    );
  }

  function effectiveLaunchShell(
    launch: SessionLaunchConfig,
    defaultShell: string
  ): string | undefined {
    return launch.shell ?? defaultShell;
  }

  function arrayShallowEqual(
    left: readonly string[] | undefined,
    right: readonly string[] | undefined
  ): boolean {
    const leftItems = left ?? [];
    const rightItems = right ?? [];
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) => item === rightItems[index])
    );
  }

  function resolveRestoredAgentSession(
    agentSessionRef: ExternalAgentSessionRef | undefined
  ): ExternalSessionResumeSpec | null {
    if (!agentSessionRef) {
      return null;
    }
    const spec = options.externalSessionIndexer?.resolveExternalAgentSession(
      agentSessionRef.externalKey
    );
    if (
      !spec ||
      !externalAgentSessionRefsMatch(spec.agentSessionRef, agentSessionRef)
    ) {
      return null;
    }
    return spec;
  }

  function respawnRestoredSessions(): void {
    const state = getState();
    let replacedLaunch = false;
    for (const session of Object.values(state.sessions)) {
      if (session.runtimeState !== "exited") {
        const resumeSpec = resolveRestoredAgentSession(session.agentSessionRef);
        if (resumeSpec) {
          session.launch = resumeSpec.launch;
          session.agentSessionRef = resumeSpec.agentSessionRef;
          replacedLaunch = true;
        }
        const surface = state.surfaces[session.surfaceId];
        const pane = surface ? state.panes[surface.paneId] : undefined;
        const workspaceId = pane?.workspaceId;
        if (!surface || !pane || !workspaceId) {
          continue;
        }
        runEffects([
          {
            type: "session.spawn",
            sessionId: session.id,
            surfaceId: session.surfaceId,
            workspaceId,
            launch: session.launch,
            initialSize: {
              cols: 120,
              rows: 30
            },
            sessionEnv: {
              KMUX_SOCKET_MODE: state.settings.socketMode,
              KMUX_WORKSPACE_ID: workspaceId,
              KMUX_PANE_ID: pane.id,
              KMUX_SURFACE_ID: session.surfaceId,
              KMUX_SESSION_ID: session.id,
              KMUX_AUTH_TOKEN: session.authToken,
              TERM_PROGRAM: "kmux"
            }
          }
        ]);
      }
    }
    if (replacedLaunch) {
      options.snapshotStore.save(state, {
        cleanShutdown: false
      });
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
      const currentState = store.getState();
      const restoreOnLaunch = currentState.settings.restoreWorkspacesAfterQuit;
      const shutdownSnapshot = restoreOnLaunch
        ? currentState
        : createCleanShutdownSnapshot(currentState, options.defaultShellPath);
      options.snapshotStore.save(shutdownSnapshot, {
        cleanShutdown: true,
        restoreOnLaunch
      });
      options.settingsStore.save(currentState.settings);
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
    getExternalAgentSessions,
    resumeExternalAgentSession,
    respawnRestoredSessions,
    shutdown
  };
}

export function shouldUseNativeShellBeep(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== "linux";
}

function playBellSound(playBellSoundOverride?: () => void): void {
  if (playBellSoundOverride) {
    playBellSoundOverride();
    return;
  }
  if (!shouldUseNativeShellBeep()) {
    logDiagnostics("main.effect.bell.sound.skipped", {
      reason: "native-shell-beep-disabled-on-linux"
    });
    return;
  }
  shell.beep();
}

function buildPtySessionSpec(effect: SessionSpawnEffect): PtySessionSpec {
  return {
    sessionId: effect.sessionId,
    surfaceId: effect.surfaceId,
    workspaceId: effect.workspaceId,
    launch: effect.launch,
    cols: effect.initialSize.cols,
    rows: effect.initialSize.rows,
    env: effect.sessionEnv
  };
}

function clearSnapshotNotifications(state: AppState): void {
  state.notifications = [];
  for (const surface of Object.values(state.surfaces)) {
    surface.unreadCount = 0;
    surface.attention = false;
  }
}

function resetRestoredSessions(state: AppState): void {
  for (const session of Object.values(state.sessions)) {
    if (session.runtimeState !== "exited") {
      session.runtimeState = "pending";
      session.shellInputReady = false;
      delete session.pid;
      delete session.exitCode;
    }
  }
}

function externalAgentSessionRefsMatch(
  left: ExternalAgentSessionRef | undefined,
  right: ExternalAgentSessionRef | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.vendor === right.vendor &&
    left.externalKey === right.externalKey &&
    left.sessionId === right.sessionId
  );
}

function createCleanShutdownSnapshot(
  currentState: AppState,
  defaultShellPath: string
): AppState {
  const cleanState = createInitialState(defaultShellPath);
  cleanState.settings = mergeSettings(
    cleanState.settings,
    currentState.settings
  );
  return cleanState;
}

type ShellGroup =
  | "window"
  | "workspaceRows"
  | "activeWorkspace"
  | "activeWorkspacePaneTree"
  | "workspacePaneTrees"
  | "notifications"
  | "settings"
  | "terminalTypography";

interface ShellPatchProfileContext {
  actionType?: AppAction["type"];
  actionWorkspaceId?: Id;
  actionPaneId?: Id;
  actionSurfaceId?: Id;
  actionSessionId?: Id;
  effectTypes?: AppEffect["type"][];
  surfaceMetadataFields?: string[];
}

function buildWorkspacePaneTreesPatch(
  state: AppState,
  currentTrees: Record<Id, ActiveWorkspacePaneTreeVm>,
  nextTreesOut: Record<Id, ActiveWorkspacePaneTreeVm>
): WorkspacePaneTreesPatch | null {
  const currentIds = new Set(Object.keys(currentTrees));
  const nextIds = new Set(Object.keys(state.workspaces));
  const remove = [...currentIds].filter((id) => !nextIds.has(id));
  const upsert: Record<Id, ActiveWorkspacePaneTreeVm> = {};

  Object.assign(nextTreesOut, currentTrees);
  for (const id of remove) {
    delete nextTreesOut[id];
  }

  for (const id of nextIds) {
    const nextTree = buildWorkspacePaneTreeVm(state, id);
    nextTreesOut[id] = nextTree;
    if (!isDeepStrictEqual(currentTrees[id], nextTree)) {
      upsert[id] = nextTree;
    }
  }

  if (remove.length === 0 && Object.keys(upsert).length === 0) {
    return null;
  }

  return {
    ...(Object.keys(upsert).length > 0 ? { upsert } : {}),
    ...(remove.length > 0 ? { remove } : {})
  };
}

function buildWorkspaceRowsPatch(
  currentRows: WorkspaceRowVm[],
  nextRows: WorkspaceRowVm[]
): WorkspaceRowsPatch | null {
  const currentById = new Map(
    currentRows.map((row) => [row.workspaceId, row] as const)
  );
  const nextById = new Map(
    nextRows.map((row) => [row.workspaceId, row] as const)
  );
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

function shellGroupsFromMutation(
  mutation: AppMutationSummary
): Set<ShellGroup> {
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
  if (mutation.paneTreeWorkspaceIds && mutation.paneTreeWorkspaceIds.size > 0) {
    groups.add("workspacePaneTrees");
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

function shellPatchProfileContextForAction(
  action: AppAction,
  effects: AppEffect[]
): ShellPatchProfileContext {
  return {
    actionType: action.type,
    ...("workspaceId" in action
      ? { actionWorkspaceId: action.workspaceId }
      : {}),
    ...("paneId" in action ? { actionPaneId: action.paneId } : {}),
    ...("surfaceId" in action ? { actionSurfaceId: action.surfaceId } : {}),
    ...("sessionId" in action ? { actionSessionId: action.sessionId } : {}),
    effectTypes: effects.map((effect) => effect.type),
    ...(action.type === "surface.metadata"
      ? { surfaceMetadataFields: surfaceMetadataFieldsFromAction(action) }
      : {})
  };
}

function surfaceMetadataFieldsFromAction(
  action: Extract<AppAction, { type: "surface.metadata" }>
): string[] {
  const fields: string[] = [];
  if (action.cwd !== undefined) {
    fields.push("cwd");
  }
  if (action.title !== undefined) {
    fields.push("title");
  }
  if ("branch" in action) {
    fields.push("branch");
  }
  if ("gitRepository" in action) {
    fields.push("gitRepository");
  }
  if (action.ports !== undefined) {
    fields.push("ports");
  }
  if (action.attention !== undefined) {
    fields.push("attention");
  }
  if (action.unreadDelta !== undefined) {
    fields.push("unreadDelta");
  }
  return fields;
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
