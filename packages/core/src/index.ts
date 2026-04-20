import {
  DEFAULT_SHORTCUTS,
  createDefaultTerminalThemeSettings,
  sanitizeTerminalThemeSettings
} from "@kmux/ui";
import {
  type AgentEventName,
  type ActiveWorkspaceVm,
  type Id,
  isoNow,
  type KmuxSettings,
  type ResolvedTerminalTypographyVm,
  makeId,
  type NotificationItem,
  type PaneTreeNode,
  type PtySessionSpec,
  type TerminalTypographySettings,
  type SessionLaunchConfig,
  type SessionRuntimeState,
  type ShellViewModel,
  type SidebarLogEntry,
  type SidebarProgress,
  type SidebarStatusEntry,
  type SocketMode,
  type SplitAxis,
  type SplitDirection,
  type SurfaceVm,
  type TerminalThemeSettings
} from "@kmux/proto";

export interface WindowState {
  id: Id;
  workspaceOrder: Id[];
  activeWorkspaceId: Id;
  sidebarVisible: boolean;
  sidebarWidth: number;
}

export interface WorkspaceState {
  id: Id;
  windowId: Id;
  name: string;
  nameLocked?: boolean;
  rootNodeId: Id;
  nodeMap: Record<Id, PaneTreeNode>;
  activePaneId: Id;
  pinned: boolean;
  cwdSummary?: string;
  branch?: string;
  ports: number[];
  statusText?: string;
  statusEntries: Record<string, SidebarStatusEntry>;
  progress?: SidebarProgress;
  logs: SidebarLogEntry[];
}

export interface PaneState {
  id: Id;
  workspaceId: Id;
  surfaceIds: Id[];
  activeSurfaceId: Id;
}

export interface SurfaceState {
  id: Id;
  paneId: Id;
  sessionId: Id;
  title: string;
  titleLocked: boolean;
  cwd?: string;
  branch?: string;
  ports: number[];
  unreadCount: number;
  attention: boolean;
}

export interface SessionState {
  id: Id;
  surfaceId: Id;
  launch: SessionLaunchConfig;
  authToken: string;
  runtimeState: SessionRuntimeState;
  pid?: number;
  exitCode?: number;
}

export interface AppState {
  windows: Record<Id, WindowState>;
  workspaces: Record<Id, WorkspaceState>;
  panes: Record<Id, PaneState>;
  surfaces: Record<Id, SurfaceState>;
  sessions: Record<Id, SessionState>;
  notifications: NotificationItem[];
  settings: KmuxSettings;
  activeWindowId: Id;
}

type LegacyTypographyFields = {
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
};

type LegacyKmuxSettings = Partial<KmuxSettings> & LegacyTypographyFields;

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_TERMINAL_TEXT_FONT_FAMILY =
  'ui-monospace, Menlo, Monaco, Consolas, "SFMono-Regular", monospace';
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1;
export const KMUX_BUILTIN_SYMBOL_FONT_FAMILY = '"kmux Symbols Nerd Font Mono"';
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 110;
export const MAX_SIDEBAR_WIDTH = 320;
const MANUAL_STATUS_KEY = "manual";
const MAX_STATUS_TEXT_LENGTH = 256;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 512;
const NOTIFICATION_DEDUPE_WINDOW_MS = 5000;
const MAX_NOTIFICATION_DEDUPE_SCAN = 50;
const MAX_WORKSPACE_STATUS_ENTRIES = 16;
const MAX_VIEW_STATUS_ENTRIES = 3;

function defaultHomeDirectory(): string {
  const homeDirectory =
    typeof process !== "undefined"
      ? (process.env.HOME ?? process.env.USERPROFILE)
      : undefined;
  return homeDirectory?.trim() || "~";
}

export type AppEffect =
  | {
      type: "session.spawn";
      spec: PtySessionSpec;
    }
  | {
      type: "session.close";
      sessionId: Id;
    }
  | {
      type: "metadata.refresh";
      workspaceId: Id;
      surfaceId?: Id;
      pid?: number;
      cwd?: string;
    }
  | {
      type: "persist";
    }
  | {
      type: "notify.desktop";
      notification: NotificationItem;
    }
  | {
      type: "bell.sound";
    };

export type SettingsPatch = Partial<
  Omit<KmuxSettings, "terminalTypography" | "terminalThemes">
> & {
  terminalTypography?: Partial<TerminalTypographySettings>;
  terminalThemes?: Partial<TerminalThemeSettings>;
};

export type AppAction =
  | { type: "workspace.create"; name?: string; cwd?: string }
  | { type: "workspace.select"; workspaceId: Id }
  | { type: "workspace.selectRelative"; delta: number }
  | { type: "workspace.selectIndex"; index: number }
  | { type: "workspace.rename"; workspaceId: Id; name: string }
  | { type: "workspace.close"; workspaceId: Id }
  | { type: "workspace.closeOthers"; workspaceId: Id }
  | { type: "workspace.pin.toggle"; workspaceId: Id }
  | { type: "workspace.move"; workspaceId: Id; toIndex: number }
  | { type: "workspace.sidebar.toggle" }
  | { type: "workspace.sidebar.setWidth"; width: number }
  | { type: "pane.split"; paneId: Id; direction: SplitDirection }
  | { type: "pane.focus"; paneId: Id }
  | { type: "pane.focusDirection"; direction: SplitDirection; paneId?: Id }
  | {
      type: "pane.resize";
      paneId: Id;
      direction: SplitDirection;
      delta: number;
    }
  | { type: "pane.setSplitRatio"; splitNodeId: Id; ratio: number }
  | { type: "pane.close"; paneId: Id }
  | { type: "surface.create"; paneId: Id; title?: string; cwd?: string }
  | { type: "surface.focus"; surfaceId: Id }
  | { type: "surface.focusRelative"; paneId: Id; delta: number }
  | { type: "surface.focusIndex"; paneId: Id; index: number }
  | { type: "surface.rename"; surfaceId: Id; title: string }
  | { type: "surface.close"; surfaceId: Id }
  | { type: "surface.closeOthers"; surfaceId: Id }
  | {
      type: "surface.metadata";
      surfaceId: Id;
      cwd?: string;
      title?: string;
      branch?: string | null;
      ports?: number[];
      attention?: boolean;
      unreadDelta?: number;
    }
  | {
      type: "sidebar.setStatus";
      workspaceId: Id;
      text: string;
      key?: string;
      label?: string;
      variant?: SidebarStatusEntry["variant"];
      surfaceId?: Id;
    }
  | { type: "sidebar.clearStatus"; workspaceId: Id; key?: string }
  | { type: "sidebar.setProgress"; workspaceId: Id; progress: SidebarProgress }
  | { type: "sidebar.clearProgress"; workspaceId: Id }
  | {
      type: "sidebar.log";
      workspaceId: Id;
      level: SidebarLogEntry["level"];
      message: string;
    }
  | { type: "sidebar.clearLog"; workspaceId: Id }
  | {
      type: "notification.create";
      workspaceId: Id;
      paneId?: Id;
      surfaceId?: Id;
      title: string;
      message: string;
      source?: NotificationItem["source"];
      kind?: NotificationItem["kind"];
      agent?: NotificationItem["agent"];
    }
  | {
      type: "agent.event";
      workspaceId: Id;
      paneId?: Id;
      surfaceId?: Id;
      sessionId?: Id;
      agent: string;
      event: AgentEventName;
      title?: string;
      message?: string;
      details?: Record<string, unknown>;
    }
  | { type: "notification.clear"; notificationId?: Id }
  | { type: "notification.jumpLatestUnread" }
  | { type: "terminal.bell" }
  | { type: "settings.update"; patch: SettingsPatch }
  | { type: "session.started"; sessionId: Id; pid: number }
  | { type: "session.exited"; sessionId: Id; exitCode?: number }
  | { type: "state.restore"; snapshot: AppState };

export function createDefaultSettings(
  mode: SocketMode = "kmuxOnly",
  shellPath: string | undefined = process.env.SHELL
): KmuxSettings {
  return {
    socketMode: mode,
    startupRestore: true,
    warnBeforeQuit: true,
    notificationDesktop: true,
    notificationSound: false,
    terminalUseWebgl: true,
    themeMode: "dark",
    shell: shellPath,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    terminalTypography: createDefaultTerminalTypographySettings(),
    terminalThemes: createDefaultTerminalThemeSettings()
  };
}

export function createDefaultTerminalTypographySettings(): TerminalTypographySettings {
  return {
    preferredTextFontFamily: DEFAULT_TERMINAL_TEXT_FONT_FAMILY,
    preferredSymbolFallbackFamilies: [],
    fontSize: DEFAULT_TERMINAL_FONT_SIZE,
    lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT
  };
}

export function buildResolvedTerminalFontFamily(
  textFontFamily: string,
  symbolFallbackFamilies: string[]
): string {
  return [textFontFamily, ...symbolFallbackFamilies].filter(Boolean).join(", ");
}

export function buildBaseTerminalSymbolFallbackFamilies(
  symbolFallbackFamilies: string[]
): string[] {
  return sanitizeSymbolFallbackFamilies([
    ...symbolFallbackFamilies,
    KMUX_BUILTIN_SYMBOL_FONT_FAMILY
  ]);
}

export function createPendingResolvedTerminalTypographyVm(
  settings: TerminalTypographySettings
): ResolvedTerminalTypographyVm {
  const terminalTypography = normalizeTerminalTypographySettings(settings);
  const symbolFallbackFamilies = buildBaseTerminalSymbolFallbackFamilies(
    terminalTypography.preferredSymbolFallbackFamilies
  );

  return {
    stackHash: `pending:${terminalTypography.preferredTextFontFamily}:${symbolFallbackFamilies.join("|")}`,
    resolvedFontFamily: buildResolvedTerminalFontFamily(
      terminalTypography.preferredTextFontFamily,
      symbolFallbackFamilies
    ),
    textFontFamily: terminalTypography.preferredTextFontFamily,
    symbolFallbackFamilies,
    autoFallbackApplied: symbolFallbackFamilies.length > 0,
    status: "pending",
    issues: []
  };
}

export function mergeSettings(
  current: KmuxSettings,
  patch: SettingsPatch & LegacyTypographyFields
): KmuxSettings {
  const {
    terminalFontFamily: _legacyTerminalFontFamily,
    terminalFontSize: _legacyTerminalFontSize,
    terminalLineHeight: _legacyTerminalLineHeight,
    ...nextPatch
  } = patch;
  const shortcuts = sanitizeShortcuts({
    ...current.shortcuts,
    ...(nextPatch.shortcuts ?? {})
  });

  return {
    ...current,
    ...nextPatch,
    warnBeforeQuit:
      typeof nextPatch.warnBeforeQuit === "boolean"
        ? nextPatch.warnBeforeQuit
        : current.warnBeforeQuit,
    terminalUseWebgl: sanitizeTerminalUseWebgl(
      nextPatch.terminalUseWebgl ?? current.terminalUseWebgl
    ),
    themeMode: sanitizeThemeMode(nextPatch.themeMode ?? current.themeMode),
    terminalTypography: sanitizeTerminalTypographySettings(
      nextPatch.terminalTypography,
      patch,
      current.terminalTypography
    ),
    terminalThemes: sanitizeTerminalThemeSettings(
      nextPatch.terminalThemes,
      current.terminalThemes
    ),
    shortcuts
  };
}

export function sanitizeSettings(
  settings: LegacyKmuxSettings | undefined
): KmuxSettings {
  if (!settings) {
    return createDefaultSettings();
  }
  return mergeSettings(createDefaultSettings(settings.socketMode), settings);
}

export function normalizeTerminalTypographySettings(
  terminalTypography: Partial<TerminalTypographySettings> | undefined
): TerminalTypographySettings {
  return sanitizeTerminalTypographySettings(terminalTypography);
}

export function createInitialState(
  shellPath: string | undefined = process.env.SHELL
): AppState {
  const windowId = makeId("window");
  const workspaceId = makeId("workspace");
  const paneId = makeId("pane");
  const surfaceId = makeId("surface");
  const sessionId = makeId("session");
  const nodeId = makeId("node");

  const state: AppState = {
    windows: {
      [windowId]: {
        id: windowId,
        workspaceOrder: [workspaceId],
        activeWorkspaceId: workspaceId,
        sidebarVisible: true,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH
      }
    },
    workspaces: {
      [workspaceId]: {
        id: workspaceId,
        windowId,
        name: "hq",
        rootNodeId: nodeId,
        nodeMap: {
          [nodeId]: {
            id: nodeId,
            kind: "leaf",
            paneId
          }
        },
        activePaneId: paneId,
        pinned: true,
        cwdSummary: "~/",
        ports: [],
        statusEntries: {},
        logs: []
      }
    },
    panes: {
      [paneId]: {
        id: paneId,
        workspaceId,
        surfaceIds: [surfaceId],
        activeSurfaceId: surfaceId
      }
    },
    surfaces: {
      [surfaceId]: {
        id: surfaceId,
        paneId,
        sessionId,
        title: "hq",
        titleLocked: false,
        cwd: defaultHomeDirectory(),
        ports: [],
        unreadCount: 0,
        attention: false
      }
    },
    sessions: {
      [sessionId]: {
        id: sessionId,
        surfaceId,
        launch: {
          cwd: defaultHomeDirectory(),
          shell: shellPath
        },
        authToken: makeId("auth"),
        runtimeState: "pending"
      }
    },
    notifications: [],
    settings: createDefaultSettings("kmuxOnly", shellPath),
    activeWindowId: windowId
  };

  return state;
}

export function cloneState(snapshot: AppState): AppState {
  return sanitizeState(structuredClone(snapshot));
}

export function applyAction(state: AppState, action: AppAction): AppEffect[] {
  switch (action.type) {
    case "state.restore":
      Object.assign(state, cloneState(action.snapshot));
      return [{ type: "persist" }];
    case "workspace.create":
      return createWorkspace(
        state,
        action.name ?? "new workspace",
        action.cwd,
        !!action.name
      );
    case "workspace.select":
      return selectWorkspace(state, action.workspaceId);
    case "workspace.selectRelative":
      return selectWorkspaceRelative(state, action.delta);
    case "workspace.selectIndex":
      return selectWorkspaceIndex(state, action.index);
    case "workspace.rename":
      if (state.workspaces[action.workspaceId]) {
        state.workspaces[action.workspaceId].name =
          action.name.trim() || state.workspaces[action.workspaceId].name;
        state.workspaces[action.workspaceId].nameLocked = true;
      }
      return [{ type: "persist" }];
    case "workspace.close":
      return closeWorkspace(state, action.workspaceId);
    case "workspace.closeOthers":
      return closeOtherWorkspaces(state, action.workspaceId);
    case "workspace.pin.toggle":
      return toggleWorkspacePinned(state, action.workspaceId);
    case "workspace.move":
      return moveWorkspace(state, action.workspaceId, action.toIndex);
    case "workspace.sidebar.toggle":
      state.windows[state.activeWindowId].sidebarVisible =
        !state.windows[state.activeWindowId].sidebarVisible;
      return [{ type: "persist" }];
    case "workspace.sidebar.setWidth":
      state.windows[state.activeWindowId].sidebarWidth = clamp(
        action.width,
        MIN_SIDEBAR_WIDTH,
        MAX_SIDEBAR_WIDTH
      );
      return [{ type: "persist" }];
    case "pane.split":
      return splitPane(state, action.paneId, action.direction);
    case "pane.focus":
      return focusPane(state, action.paneId);
    case "pane.focusDirection":
      return focusPaneDirection(state, action.direction, action.paneId);
    case "pane.resize":
      return resizePane(state, action.paneId, action.direction, action.delta);
    case "pane.setSplitRatio":
      return setSplitRatio(state, action.splitNodeId, action.ratio);
    case "pane.close":
      return closePane(state, action.paneId);
    case "surface.create":
      return createSurface(state, action.paneId, action.title, action.cwd);
    case "surface.focus":
      return focusSurface(state, action.surfaceId);
    case "surface.focusRelative":
      return focusSurfaceRelative(state, action.paneId, action.delta);
    case "surface.focusIndex":
      return focusSurfaceIndex(state, action.paneId, action.index);
    case "surface.rename":
      if (state.surfaces[action.surfaceId]) {
        const nextTitle = action.title.trim();
        if (nextTitle) {
          state.surfaces[action.surfaceId].title = nextTitle;
          state.surfaces[action.surfaceId].titleLocked = true;
        }
      }
      return [{ type: "persist" }];
    case "surface.close":
      return closeSurface(state, action.surfaceId);
    case "surface.closeOthers":
      return closeOtherSurfaces(state, action.surfaceId);
    case "surface.metadata":
      return updateSurfaceMetadata(state, action);
    case "sidebar.setStatus":
      return setSidebarStatus(state, action);
    case "sidebar.clearStatus":
      return clearSidebarStatus(state, action.workspaceId, action.key);
    case "sidebar.setProgress":
      if (state.workspaces[action.workspaceId]) {
        state.workspaces[action.workspaceId].progress = {
          value: Math.max(0, Math.min(1, action.progress.value)),
          label: action.progress.label
        };
      }
      return [{ type: "persist" }];
    case "sidebar.clearProgress":
      if (state.workspaces[action.workspaceId]) {
        state.workspaces[action.workspaceId].progress = undefined;
      }
      return [{ type: "persist" }];
    case "sidebar.log":
      if (state.workspaces[action.workspaceId]) {
        state.workspaces[action.workspaceId].logs.unshift({
          id: makeId("log"),
          level: action.level,
          message: action.message,
          createdAt: isoNow()
        });
        state.workspaces[action.workspaceId].logs = state.workspaces[
          action.workspaceId
        ].logs.slice(0, 50);
      }
      return [{ type: "persist" }];
    case "sidebar.clearLog":
      if (state.workspaces[action.workspaceId]) {
        state.workspaces[action.workspaceId].logs = [];
      }
      return [{ type: "persist" }];
    case "notification.create":
      return createNotification(state, action);
    case "agent.event":
      return applyAgentEvent(state, action);
    case "notification.clear":
      return clearNotifications(state, action.notificationId);
    case "notification.jumpLatestUnread":
      return jumpLatestUnread(state);
    case "terminal.bell":
      return state.settings.notificationSound ? [{ type: "bell.sound" }] : [];
    case "settings.update": {
      state.settings = mergeSettings(state.settings, action.patch);
      return [{ type: "persist" }];
    }
    case "session.started":
      if (state.sessions[action.sessionId]) {
        const session = state.sessions[action.sessionId];
        session.runtimeState = "running";
        session.pid = action.pid;
        const surface = state.surfaces[session.surfaceId];
        const pane = surface ? state.panes[surface.paneId] : undefined;
        return pane
          ? [
              {
                type: "metadata.refresh",
                workspaceId: pane.workspaceId,
                surfaceId: surface.id,
                pid: action.pid,
                cwd: surface.cwd
              },
              { type: "persist" }
            ]
          : [{ type: "persist" }];
      }
      return [];
    case "session.exited":
      if (state.sessions[action.sessionId]) {
        state.sessions[action.sessionId].runtimeState = "exited";
        state.sessions[action.sessionId].exitCode = action.exitCode;
      }
      return [{ type: "persist" }];
    default:
      return [];
  }
}

function createWorkspace(
  state: AppState,
  name: string,
  cwd?: string,
  nameLocked = false
): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const activeWorkspace = state.workspaces[window.activeWorkspaceId];
  const inheritedCwd = activeWorkspace
    ? activeSurface(state, activeWorkspace.activePaneId)?.cwd
    : undefined;
  const workspaceCwd = cwd ?? inheritedCwd ?? defaultHomeDirectory();
  const workspaceId = makeId("workspace");
  const paneId = makeId("pane");
  const surfaceId = makeId("surface");
  const sessionId = makeId("session");
  const nodeId = makeId("node");
  const workspaceName =
    name.trim() || `workspace ${window.workspaceOrder.length + 1}`;

  state.workspaces[workspaceId] = {
    id: workspaceId,
    windowId: window.id,
    name: workspaceName,
    nameLocked,
    rootNodeId: nodeId,
    nodeMap: {
      [nodeId]: {
        id: nodeId,
        kind: "leaf",
        paneId
      }
    },
    activePaneId: paneId,
    pinned: false,
    cwdSummary: workspaceCwd,
    ports: [],
    statusEntries: {},
    logs: []
  };
  state.panes[paneId] = {
    id: paneId,
    workspaceId,
    surfaceIds: [surfaceId],
    activeSurfaceId: surfaceId
  };
  state.surfaces[surfaceId] = {
    id: surfaceId,
    paneId,
    sessionId,
    title: workspaceName,
    titleLocked: false,
    cwd: workspaceCwd,
    ports: [],
    unreadCount: 0,
    attention: false
  };
  state.sessions[sessionId] = {
    id: sessionId,
    surfaceId,
    launch: {
      cwd: workspaceCwd,
      shell: state.settings.shell || process.env.SHELL
    },
    authToken: makeId("auth"),
    runtimeState: "pending"
  };
  window.workspaceOrder.push(workspaceId);
  window.activeWorkspaceId = workspaceId;

  return [
    {
      type: "session.spawn",
      spec: buildPtySpec(state, workspaceId, surfaceId, sessionId)
    },
    { type: "persist" }
  ];
}

function selectWorkspace(state: AppState, workspaceId: Id): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }
  const activePane = state.panes[workspace.activePaneId];
  if (!activePane) {
    window.activeWorkspaceId = workspaceId;
    return [{ type: "persist" }];
  }
  return focusPane(state, activePane.id);
}

function selectWorkspaceRelative(state: AppState, delta: number): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const visibleWorkspaceIds = listVisibleWorkspaceIds(state, window);
  const index = visibleWorkspaceIds.indexOf(window.activeWorkspaceId);
  if (index === -1 || visibleWorkspaceIds.length === 0) {
    return [];
  }
  const next =
    (index + delta + visibleWorkspaceIds.length) % visibleWorkspaceIds.length;
  return selectWorkspace(state, visibleWorkspaceIds[next]);
}

function selectWorkspaceIndex(state: AppState, index: number): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const workspaceId = listVisibleWorkspaceIds(state, window)[index];
  return workspaceId ? selectWorkspace(state, workspaceId) : [];
}

function moveWorkspace(
  state: AppState,
  workspaceId: Id,
  toIndex: number
): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }
  const visibleWorkspaceIds = listVisibleWorkspaceIds(state, window);
  const currentIndex = visibleWorkspaceIds.indexOf(workspaceId);
  if (currentIndex === -1) {
    return [];
  }
  const groupedWorkspaceIds = visibleWorkspaceIds.filter(
    (id) => state.workspaces[id]?.pinned === workspace.pinned
  );
  const groupStartIndex = visibleWorkspaceIds.findIndex(
    (id) => state.workspaces[id]?.pinned === workspace.pinned
  );
  const groupEndIndex = groupStartIndex + groupedWorkspaceIds.length - 1;
  const nextIndex = clamp(toIndex, groupStartIndex, groupEndIndex);
  const currentGroupIndex = groupedWorkspaceIds.indexOf(workspaceId);
  const nextGroupIndex = nextIndex - groupStartIndex;
  if (currentGroupIndex === -1 || currentGroupIndex === nextGroupIndex) {
    return [];
  }

  const nextGroupedWorkspaceIds = [...groupedWorkspaceIds];
  const [removed] = nextGroupedWorkspaceIds.splice(currentGroupIndex, 1);
  nextGroupedWorkspaceIds.splice(nextGroupIndex, 0, removed);

  const groupPositions = window.workspaceOrder.reduce<number[]>(
    (positions, id, index) => {
      if (state.workspaces[id]?.pinned === workspace.pinned) {
        positions.push(index);
      }
      return positions;
    },
    []
  );
  if (groupPositions.length !== nextGroupedWorkspaceIds.length) {
    return [];
  }

  const nextWorkspaceOrder = [...window.workspaceOrder];
  groupPositions.forEach((position, index) => {
    nextWorkspaceOrder[position] = nextGroupedWorkspaceIds[index];
  });
  window.workspaceOrder = nextWorkspaceOrder;
  return [{ type: "persist" }];
}

function closeWorkspace(state: AppState, workspaceId: Id): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  if (window.workspaceOrder.length === 1 || !state.workspaces[workspaceId]) {
    return [];
  }
  const currentIndex = window.workspaceOrder.indexOf(workspaceId);
  const remainingWorkspaceIds = window.workspaceOrder.filter(
    (id) => id !== workspaceId && Boolean(state.workspaces[id])
  );
  const nextActiveIndex = Math.max(
    0,
    Math.min(remainingWorkspaceIds.length - 1, currentIndex)
  );
  const nextActiveWorkspaceId = remainingWorkspaceIds[nextActiveIndex];
  if (window.activeWorkspaceId === workspaceId && nextActiveWorkspaceId) {
    window.activeWorkspaceId = nextActiveWorkspaceId;
  }
  const closeEffects = removeWorkspace(state, workspaceId);

  return [...closeEffects, { type: "persist" }];
}

function closeOtherWorkspaces(state: AppState, workspaceId: Id): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  if (window.workspaceOrder.length <= 1 || !state.workspaces[workspaceId]) {
    return [];
  }
  const closeIds = window.workspaceOrder.filter((id) => id !== workspaceId);
  return closeWorkspaceIds(state, closeIds, workspaceId);
}

function closeWorkspaceIds(
  state: AppState,
  workspaceIds: Id[],
  nextActiveWorkspaceId?: Id
): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const closeIds = workspaceIds.filter(
    (workspaceId) => state.workspaces[workspaceId]
  );
  if (!closeIds.length || closeIds.length >= window.workspaceOrder.length) {
    return [];
  }
  if (nextActiveWorkspaceId && state.workspaces[nextActiveWorkspaceId]) {
    window.activeWorkspaceId = nextActiveWorkspaceId;
  }
  const closeEffects = closeIds.flatMap((workspaceId) =>
    removeWorkspace(state, workspaceId)
  );
  return closeEffects.length ? [...closeEffects, { type: "persist" }] : [];
}

function toggleWorkspacePinned(state: AppState, workspaceId: Id): AppEffect[] {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }
  workspace.pinned = !workspace.pinned;
  return [{ type: "persist" }];
}

function removeWorkspace(state: AppState, workspaceId: Id): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }
  const paneIds = listWorkspacePaneIds(state, workspace.id);
  const sessionIds = paneIds.flatMap((paneId) =>
    state.panes[paneId].surfaceIds
      .map((surfaceId) => state.surfaces[surfaceId]?.sessionId)
      .filter(Boolean)
  ) as Id[];

  for (const paneId of paneIds) {
    for (const surfaceId of state.panes[paneId].surfaceIds) {
      delete state.sessions[state.surfaces[surfaceId].sessionId];
      delete state.surfaces[surfaceId];
    }
    delete state.panes[paneId];
  }
  delete state.workspaces[workspace.id];
  window.workspaceOrder = window.workspaceOrder.filter(
    (id) => id !== workspaceId
  );

  return sessionIds.map(
    (sessionId) => ({ type: "session.close", sessionId }) satisfies AppEffect
  );
}

function splitPane(
  state: AppState,
  paneId: Id,
  direction: SplitDirection
): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  const workspace = state.workspaces[pane.workspaceId];
  const targetLeafId = Object.values(workspace.nodeMap).find(
    (node): node is Extract<PaneTreeNode, { kind: "leaf" }> =>
      node.kind === "leaf" && node.paneId === paneId
  )?.id;
  if (!targetLeafId) {
    return [];
  }

  const newPaneId = makeId("pane");
  const newSurfaceId = makeId("surface");
  const newSessionId = makeId("session");
  const newLeafId = makeId("node");
  const splitId = makeId("node");
  const axis: SplitAxis =
    direction === "left" || direction === "right" ? "vertical" : "horizontal";
  const splitNode =
    direction === "left" || direction === "up"
      ? {
          id: splitId,
          kind: "split" as const,
          axis,
          ratio: 0.5,
          first: newLeafId,
          second: targetLeafId
        }
      : {
          id: splitId,
          kind: "split" as const,
          axis,
          ratio: 0.5,
          first: targetLeafId,
          second: newLeafId
        };

  replaceNodeReference(workspace, targetLeafId, splitId);
  workspace.nodeMap[splitId] = splitNode;
  workspace.nodeMap[newLeafId] = {
    id: newLeafId,
    kind: "leaf",
    paneId: newPaneId
  };

  state.panes[newPaneId] = {
    id: newPaneId,
    workspaceId: workspace.id,
    surfaceIds: [newSurfaceId],
    activeSurfaceId: newSurfaceId
  };
  state.surfaces[newSurfaceId] = {
    id: newSurfaceId,
    paneId: newPaneId,
    sessionId: newSessionId,
    title: "new terminal",
    titleLocked: false,
    cwd: activeSurface(state, paneId)?.cwd,
    ports: [],
    unreadCount: 0,
    attention: false
  };
  state.sessions[newSessionId] = {
    id: newSessionId,
    surfaceId: newSurfaceId,
    launch: {
      cwd: activeSurface(state, paneId)?.cwd,
      shell: state.settings.shell || process.env.SHELL
    },
    authToken: makeId("auth"),
    runtimeState: "pending"
  };
  workspace.activePaneId = newPaneId;

  return [
    {
      type: "session.spawn",
      spec: buildPtySpec(state, workspace.id, newSurfaceId, newSessionId)
    },
    { type: "persist" }
  ];
}

function focusPane(state: AppState, paneId: Id): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  state.windows[state.activeWindowId].activeWorkspaceId = pane.workspaceId;
  const workspace = state.workspaces[pane.workspaceId];
  workspace.activePaneId = paneId;
  const surface = state.surfaces[pane.activeSurfaceId];
  if (surface) {
    surface.attention = false;
    surface.unreadCount = 0;
    markNotificationsRead(state, pane.workspaceId, paneId, pane.activeSurfaceId);
  }
  return [{ type: "persist" }];
}

function focusPaneDirection(
  state: AppState,
  direction: SplitDirection,
  explicitPaneId?: Id
): AppEffect[] {
  const workspace = activeWorkspaceState(state);
  const paneId = explicitPaneId ?? workspace.activePaneId;
  const rects = computePaneRects(workspace);
  const current = rects.find((entry) => entry.paneId === paneId);
  if (!current) {
    return [];
  }

  const next = rects
    .filter((entry) => entry.paneId !== paneId)
    .map((entry) => ({
      paneId: entry.paneId,
      distance: directionalDistance(current, entry, direction)
    }))
    .filter((entry) => entry.distance !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.distance - b.distance)[0];

  return next ? focusPane(state, next.paneId) : [];
}

function resizePane(
  state: AppState,
  paneId: Id,
  direction: SplitDirection,
  delta: number
): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  const workspace = state.workspaces[pane.workspaceId];
  const path = findAncestorSplits(workspace, paneId);
  const targetAxis: SplitAxis =
    direction === "left" || direction === "right" ? "vertical" : "horizontal";
  const target = [...path].reverse().find((entry) => {
    const node = workspace.nodeMap[entry.splitId];
    return node?.kind === "split" && node.axis === targetAxis;
  });
  if (!target) {
    return [];
  }
  const split = workspace.nodeMap[target.splitId];
  if (split.kind !== "split") {
    return [];
  }
  const signed = direction === "left" || direction === "up" ? -delta : delta;
  const ratio = target.isFirst ? split.ratio + signed : split.ratio - signed;
  split.ratio = clamp(ratio, 0.15, 0.85);
  return [{ type: "persist" }];
}

function setSplitRatio(
  state: AppState,
  splitNodeId: Id,
  ratio: number
): AppEffect[] {
  const workspace = activeWorkspaceState(state);
  const split = workspace.nodeMap[splitNodeId];
  if (split?.kind === "split") {
    split.ratio = clamp(ratio, 0.1, 0.9);
  }
  return [{ type: "persist" }];
}

function closePane(state: AppState, paneId: Id): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  const workspace = state.workspaces[pane.workspaceId];
  const paneIds = listPaneIds(workspace);
  if (paneIds.length === 1) {
    return [];
  }

  const leafId = Object.values(workspace.nodeMap).find(
    (node): node is Extract<PaneTreeNode, { kind: "leaf" }> =>
      node.kind === "leaf" && node.paneId === paneId
  )?.id;
  if (!leafId) {
    return [];
  }
  const parentEntry = findParentSplit(workspace, leafId);
  if (!parentEntry) {
    return [];
  }
  const parent = workspace.nodeMap[parentEntry.parentId];
  if (parent.kind !== "split") {
    return [];
  }
  const siblingId = parent.first === leafId ? parent.second : parent.first;
  replaceNodeReference(workspace, parent.id, siblingId);
  delete workspace.nodeMap[parent.id];
  delete workspace.nodeMap[leafId];

  const closeEffects: AppEffect[] = [];
  for (const surfaceId of pane.surfaceIds) {
    const surface = state.surfaces[surfaceId];
    closeEffects.push({ type: "session.close", sessionId: surface.sessionId });
    delete state.sessions[surface.sessionId];
    delete state.surfaces[surfaceId];
  }
  delete state.panes[paneId];
  workspace.activePaneId = listPaneIds(workspace)[0];

  return [...closeEffects, { type: "persist" }];
}

function createSurface(
  state: AppState,
  paneId: Id,
  title?: string,
  cwd?: string
): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  const workspace = state.workspaces[pane.workspaceId];
  const surfaceId = makeId("surface");
  const sessionId = makeId("session");
  const launchCwd = cwd ?? activeSurface(state, paneId)?.cwd;

  state.surfaces[surfaceId] = {
    id: surfaceId,
    paneId,
    sessionId,
    title: title?.trim() || `tab ${pane.surfaceIds.length + 1}`,
    titleLocked: Boolean(title?.trim()),
    cwd: launchCwd,
    ports: [],
    unreadCount: 0,
    attention: false
  };
  state.sessions[sessionId] = {
    id: sessionId,
    surfaceId,
    launch: {
      cwd: launchCwd,
      shell: state.settings.shell || process.env.SHELL,
      title
    },
    authToken: makeId("auth"),
    runtimeState: "pending"
  };
  pane.surfaceIds.push(surfaceId);
  pane.activeSurfaceId = surfaceId;
  workspace.activePaneId = paneId;

  return [
    {
      type: "session.spawn",
      spec: buildPtySpec(state, workspace.id, surfaceId, sessionId)
    },
    { type: "persist" }
  ];
}

function focusSurface(state: AppState, surfaceId: Id): AppEffect[] {
  const surface = state.surfaces[surfaceId];
  if (!surface) {
    return [];
  }
  const pane = state.panes[surface.paneId];
  pane.activeSurfaceId = surfaceId;
  surface.attention = false;
  surface.unreadCount = 0;
  return focusPane(state, pane.id);
}

function focusSurfaceRelative(
  state: AppState,
  paneId: Id,
  delta: number
): AppEffect[] {
  const pane = state.panes[paneId];
  if (!pane) {
    return [];
  }
  const index = pane.surfaceIds.indexOf(pane.activeSurfaceId);
  const nextIndex =
    (index + delta + pane.surfaceIds.length) % pane.surfaceIds.length;
  return focusSurface(state, pane.surfaceIds[nextIndex]);
}

function focusSurfaceIndex(
  state: AppState,
  paneId: Id,
  index: number
): AppEffect[] {
  const pane = state.panes[paneId];
  return pane?.surfaceIds[index]
    ? focusSurface(state, pane.surfaceIds[index])
    : [];
}

function closeSurface(state: AppState, surfaceId: Id): AppEffect[] {
  const surface = state.surfaces[surfaceId];
  if (!surface) {
    return [];
  }
  const pane = state.panes[surface.paneId];
  if (pane.surfaceIds.length === 1) {
    return closePane(state, pane.id);
  }
  const closedIndex = pane.surfaceIds.indexOf(surfaceId);
  const remainingSurfaceIds = pane.surfaceIds.filter((id) => id !== surfaceId);
  pane.surfaceIds = remainingSurfaceIds;
  if (pane.activeSurfaceId === surfaceId) {
    const nextActiveIndex = closedIndex > 0 ? closedIndex - 1 : 0;
    pane.activeSurfaceId =
      remainingSurfaceIds[nextActiveIndex] ?? remainingSurfaceIds[0];
  }
  delete state.sessions[surface.sessionId];
  delete state.surfaces[surfaceId];
  return [
    { type: "session.close", sessionId: surface.sessionId },
    { type: "persist" }
  ];
}

function closeOtherSurfaces(state: AppState, surfaceId: Id): AppEffect[] {
  const surface = state.surfaces[surfaceId];
  if (!surface) {
    return [];
  }
  const pane = state.panes[surface.paneId];
  const toClose = pane.surfaceIds.filter((id) => id !== surfaceId);
  const effects = toClose.flatMap((id) => closeSurface(state, id));
  pane.activeSurfaceId = surfaceId;
  pane.surfaceIds = [surfaceId];
  return [...effects, { type: "persist" }];
}

function updateSurfaceMetadata(
  state: AppState,
  action: Extract<AppAction, { type: "surface.metadata" }>
): AppEffect[] {
  const surface = state.surfaces[action.surfaceId];
  if (!surface) {
    return [];
  }
  let shouldRefreshDerivedMetadata = false;

  if (action.cwd !== undefined && action.cwd !== surface.cwd) {
    surface.cwd = action.cwd;
    state.workspaces[state.panes[surface.paneId].workspaceId].cwdSummary =
      action.cwd;
    shouldRefreshDerivedMetadata = true;
  }
  if (action.title !== undefined) {
    if (!surface.titleLocked) {
      surface.title = action.title;
    }
    const workspaceId = state.panes[surface.paneId].workspaceId;
    if (!state.workspaces[workspaceId].nameLocked) {
      state.workspaces[workspaceId].name = action.title;
    }
  }
  if ("branch" in action) {
    const branch = action.branch ?? undefined;
    surface.branch = branch;
    state.workspaces[state.panes[surface.paneId].workspaceId].branch = branch;
  }
  if (action.ports !== undefined) {
    surface.ports = action.ports.slice(0, 3);
    state.workspaces[state.panes[surface.paneId].workspaceId].ports =
      surface.ports.slice(0, 3);
  }
  if (action.attention !== undefined) {
    surface.attention = action.attention;
  }
  if (action.unreadDelta) {
    surface.unreadCount = Math.max(0, surface.unreadCount + action.unreadDelta);
  }
  const workspaceId = state.panes[surface.paneId].workspaceId;
  const session = state.sessions[surface.sessionId];
  return shouldRefreshDerivedMetadata
    ? [
        {
          type: "metadata.refresh",
          workspaceId,
          surfaceId: surface.id,
          pid: session?.pid,
          cwd: surface.cwd
        },
        { type: "persist" }
      ]
    : [{ type: "persist" }];
}

function setSidebarStatus(
  state: AppState,
  action: Extract<AppAction, { type: "sidebar.setStatus" }>
): AppEffect[] {
  const workspace = state.workspaces[action.workspaceId];
  if (!workspace) {
    return [];
  }

  const key = normalizeStatusKey(action.key);
  const text = normalizeStatusText(action.text);
  const label = normalizeOptionalText(action.label, 64);
  const variant = action.variant ?? "info";
  const surfaceId = normalizeOptionalText(action.surfaceId, 128);
  workspace.statusEntries ??= {};
  const existing = workspace.statusEntries[key];
  const nextManualStatus =
    key === MANUAL_STATUS_KEY ? text || undefined : workspace.statusText;
  const manualStatusChanged =
    key === MANUAL_STATUS_KEY && workspace.statusText !== nextManualStatus;

  if (!text) {
    const hadEntry = Boolean(existing);
    const hadManualStatus =
      key === MANUAL_STATUS_KEY && workspace.statusText !== undefined;
    delete workspace.statusEntries[key];
    if (key === MANUAL_STATUS_KEY) {
      workspace.statusText = undefined;
    }
    return hadEntry || hadManualStatus || pruneWorkspaceStatusEntries(workspace)
      ? [{ type: "persist" }]
      : [];
  }

  if (
    existing &&
    existing.text === text &&
    existing.label === label &&
    existing.variant === variant &&
    existing.surfaceId === surfaceId
  ) {
    if (manualStatusChanged) {
      workspace.statusText = nextManualStatus;
    }
    const pruned = pruneWorkspaceStatusEntries(workspace);
    return manualStatusChanged || pruned ? [{ type: "persist" }] : [];
  }

  if (manualStatusChanged) {
    workspace.statusText = nextManualStatus;
  }
  workspace.statusEntries[key] = {
    key,
    text,
    label,
    variant,
    updatedAt: isoNow(),
    surfaceId
  };
  pruneWorkspaceStatusEntries(workspace);
  return [{ type: "persist" }];
}

function clearSidebarStatus(
  state: AppState,
  workspaceId: Id,
  keyInput?: string
): AppEffect[] {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }

  const key = normalizeStatusKey(keyInput);
  workspace.statusEntries ??= {};
  const hadEntry = Boolean(workspace.statusEntries[key]);
  const hadManualStatus =
    key === MANUAL_STATUS_KEY && workspace.statusText !== undefined;
  delete workspace.statusEntries[key];
  if (key === MANUAL_STATUS_KEY) {
    workspace.statusText = undefined;
  }
  return hadEntry || hadManualStatus || pruneWorkspaceStatusEntries(workspace)
    ? [{ type: "persist" }]
    : [];
}

type AgentTarget = {
  workspace?: WorkspaceState;
  pane?: PaneState;
  surface?: SurfaceState;
};

function applyAgentEvent(
  state: AppState,
  action: Extract<AppAction, { type: "agent.event" }>
): AppEffect[] {
  const target = resolveAgentTarget(state, action);
  if (!target.workspace) {
    return [];
  }

  const agentName = normalizeAgentName(action.agent);
  const displayName = agentDisplayName(agentName);
  const statusScopeId = agentStatusScopeId(target, action);
  const statusKey = agentStatusKey(agentName, statusScopeId);
  const visibleToUser = action.details?.visibleToUser === true;

  if (action.event === "needs_input") {
    const statusText = "needs input";
    const notificationMessage =
      normalizeStatusText(action.message) || statusText;
    const clearedCompletionNotification = clearLatestNotificationMatching(
      state,
      {
        workspaceId: target.workspace.id,
        surfaceId: target.surface?.id,
        source: "agent",
        kind: "turn_complete",
        agent: agentName
      }
    );
    const clearedGenericReminders = clearNotificationsMatching(state, {
      workspaceId: target.workspace.id,
      surfaceId: target.surface?.id,
      source: "agent",
      kind: "generic",
      agent: agentName
    });
    const statusEffects = setSidebarStatus(state, {
      type: "sidebar.setStatus",
      workspaceId: target.workspace.id,
      key: statusKey,
      label: displayName,
      text: statusText,
      variant: "attention",
      surfaceId: target.surface?.id
    });
    if (visibleToUser) {
      const clearedNotifications = clearNotificationsMatching(state, {
        workspaceId: target.workspace.id,
        surfaceId: target.surface?.id,
        source: "agent",
        kind: "needs_input",
        agent: agentName
      });
      return statusEffects.length > 0 ||
        clearedNotifications ||
        clearedCompletionNotification ||
        clearedGenericReminders
        ? [{ type: "persist" }]
        : [];
    }
    const notificationEffects = createNotification(state, {
      type: "notification.create",
      workspaceId: target.workspace.id,
      paneId: target.pane?.id,
      surfaceId: target.surface?.id,
      title:
        normalizeOptionalText(action.title, 120) ??
        `${displayName} needs input`,
      message: notificationMessage,
      source: "agent",
      kind: "needs_input",
      agent: agentName
    });
    // History: Codex needs-input used to arrive as BEL-only notifications under
    // TERM_PROGRAM=kmux. We now promote those prompts through structured agent
    // notifications, so preserve the audible cue here for all hidden
    // needs-input events when Bell sounds are enabled.
    return state.settings.notificationSound
      ? [{ type: "bell.sound" }, ...notificationEffects]
      : notificationEffects;
  }

  if (action.event === "running") {
    return clearAgentAttentionUi(
      state,
      target.workspace,
      agentName,
      statusScopeId,
      target.surface?.id
    );
  }

  if (action.event === "idle") {
    return clearAgentAttentionUi(
      state,
      target.workspace,
      agentName,
      statusScopeId,
      target.surface?.id
    );
  }

  if (action.event === "turn_complete") {
    const clearEffects = clearAgentAttentionUi(
      state,
      target.workspace,
      agentName,
      statusScopeId,
      target.surface?.id
    );
    if (visibleToUser) {
      return clearEffects;
    }
    return createNotification(state, {
      type: "notification.create",
      workspaceId: target.workspace.id,
      paneId: target.pane?.id,
      surfaceId: target.surface?.id,
      title: `${displayName} finished`,
      message: normalizeStatusText(action.message) || "Finished",
      source: "agent",
      kind: "turn_complete",
      agent: agentName
    });
  }

  if (action.event === "session_end") {
    return clearAgentAttentionUi(
      state,
      target.workspace,
      agentName,
      statusScopeId,
      target.surface?.id
    );
  }

  return [];
}

function createNotification(
  state: AppState,
  action: Extract<AppAction, { type: "notification.create" }>
): AppEffect[] {
  const source = action.source ?? "socket";
  const message = action.message.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH);
  const now = isoNow();
  const duplicate = findRecentDuplicateNotification(state, {
    workspaceId: action.workspaceId,
    surfaceId: action.surfaceId,
    title: action.title,
    message,
    source,
    kind: action.kind,
    agent: action.agent
  });
  if (duplicate) {
    if (source === "agent" && duplicate.source === "terminal") {
      duplicate.source = "agent";
      duplicate.title = action.title;
      duplicate.message = message;
      duplicate.kind = action.kind;
      duplicate.agent = action.agent;
      duplicate.createdAt = now;
    }
    if (duplicate.surfaceId) {
      syncSurfaceNotificationState(state, duplicate.surfaceId);
    }
    return [{ type: "persist" }];
  }

  const notification: NotificationItem = {
    id: makeId("notification"),
    workspaceId: action.workspaceId,
    paneId: action.paneId,
    surfaceId: action.surfaceId,
    title: action.title,
    message,
    source,
    kind: action.kind,
    agent: action.agent,
    createdAt: now
  };
  state.notifications.unshift(notification);
  if (action.surfaceId && state.surfaces[action.surfaceId]) {
    state.surfaces[action.surfaceId].attention = true;
    state.surfaces[action.surfaceId].unreadCount += 1;
  }
  return [{ type: "notify.desktop", notification }, { type: "persist" }];
}

function normalizeStatusKey(keyInput?: string): string {
  const key = (keyInput ?? MANUAL_STATUS_KEY).trim();
  if (!key) {
    return MANUAL_STATUS_KEY;
  }
  return key.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96);
}

function normalizeStatusText(text: string | undefined): string {
  return (text ?? "").trim().slice(0, MAX_STATUS_TEXT_LENGTH);
}

function normalizeOptionalText(
  text: string | undefined,
  maxLength: number
): string | undefined {
  const normalized = text?.trim().slice(0, maxLength);
  return normalized || undefined;
}

function normalizeAgentName(agent: string): string {
  return normalizeStatusKey(agent.toLowerCase()).slice(0, 48) || "agent";
}

function agentDisplayName(agent: string): string {
  if (agent === "claude") {
    return "Claude";
  }
  if (agent === "codex") {
    return "Codex";
  }
  if (agent === "gemini") {
    return "Gemini";
  }
  return agent
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function agentStatusScopeId(
  target: AgentTarget,
  action: Pick<
    Extract<AppAction, { type: "agent.event" }>,
    "surfaceId" | "sessionId"
  >
): string {
  return (
    target.surface?.id ?? action.surfaceId ?? action.sessionId ?? "workspace"
  );
}

function agentStatusKey(agent: string, scopeId: string): string {
  return normalizeStatusKey(`agent:${agent}:${scopeId}`);
}

function clearAgentStatus(
  workspace: WorkspaceState,
  agent: string,
  scopeId: string
): boolean {
  workspace.statusEntries ??= {};
  const key = agentStatusKey(agent, scopeId);
  if (!workspace.statusEntries[key]) {
    return false;
  }
  delete workspace.statusEntries[key];
  return true;
}

function clearAgentAttentionUi(
  state: AppState,
  workspace: WorkspaceState,
  agent: string,
  scopeId: string,
  surfaceId?: Id
): AppEffect[] {
  const clearedStatus = clearAgentStatus(workspace, agent, scopeId);
  const clearedNotifications = clearNotificationsMatching(state, {
    workspaceId: workspace.id,
    surfaceId,
    source: "agent",
    kind: "needs_input",
    agent
  });
  const clearedGenericReminders = clearNotificationsMatching(state, {
    workspaceId: workspace.id,
    surfaceId,
    source: "agent",
    kind: "generic",
    agent
  });
  return clearedStatus || clearedNotifications || clearedGenericReminders
    ? [{ type: "persist" }]
    : [];
}

function resolveAgentTarget(
  state: AppState,
  action: Pick<
    Extract<AppAction, { type: "agent.event" }>,
    "workspaceId" | "paneId" | "surfaceId" | "sessionId"
  >
): AgentTarget {
  const sessionSurfaceId = action.sessionId
    ? state.sessions[action.sessionId]?.surfaceId
    : undefined;
  const surface =
    (action.surfaceId ? state.surfaces[action.surfaceId] : undefined) ??
    (sessionSurfaceId ? state.surfaces[sessionSurfaceId] : undefined);
  const pane =
    (surface ? state.panes[surface.paneId] : undefined) ??
    (action.paneId ? state.panes[action.paneId] : undefined);
  const workspace =
    (pane ? state.workspaces[pane.workspaceId] : undefined) ??
    state.workspaces[action.workspaceId];
  return { workspace, pane, surface };
}

function findRecentDuplicateNotification(
  state: AppState,
  candidate: Pick<
    NotificationItem,
    "workspaceId" | "surfaceId" | "title" | "message" | "source" | "kind" | "agent"
  >
): NotificationItem | undefined {
  const nowMs = Date.now();
  const candidateTitle = normalizeNotificationText(candidate.title);
  const candidateMessage = normalizeNotificationText(candidate.message);
  const candidateInputRequest = isInputRequestNotification(
    candidateTitle,
    candidateMessage
  );

  for (const notification of state.notifications.slice(
    0,
    MAX_NOTIFICATION_DEDUPE_SCAN
  )) {
    if (
      notification.workspaceId !== candidate.workspaceId ||
      notification.surfaceId !== candidate.surfaceId
    ) {
      continue;
    }
    const createdAtMs = Date.parse(notification.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      nowMs - createdAtMs > NOTIFICATION_DEDUPE_WINDOW_MS
    ) {
      continue;
    }

    const notificationTitle = normalizeNotificationText(notification.title);
    const notificationMessage = normalizeNotificationText(notification.message);
    const notificationKind = notification.kind ?? "generic";
    const candidateKind = candidate.kind ?? "generic";
    const notificationAgent = notification.agent ?? "";
    const candidateAgent = candidate.agent ?? "";
    if (
      notificationKind === candidateKind &&
      notificationAgent === candidateAgent &&
      notificationTitle === candidateTitle &&
      notificationMessage === candidateMessage
    ) {
      return notification;
    }

    if (
      candidate.source === "agent" &&
      notification.source === "terminal" &&
      candidateInputRequest &&
      isInputRequestNotification(notificationTitle, notificationMessage)
    ) {
      return notification;
    }
  }

  return undefined;
}

function clearNotificationsMatching(
  state: AppState,
  candidate: Pick<
    NotificationItem,
    "workspaceId" | "surfaceId" | "source" | "kind" | "agent"
  >
): boolean {
  const removedSurfaceIds = new Set<Id>();
  const nextNotifications = state.notifications.filter((notification) => {
    if (notification.workspaceId !== candidate.workspaceId) {
      return true;
    }
    if (candidate.surfaceId && notification.surfaceId !== candidate.surfaceId) {
      return true;
    }
    if ((notification.source ?? "socket") !== candidate.source) {
      return true;
    }
    if ((notification.kind ?? "generic") !== (candidate.kind ?? "generic")) {
      return true;
    }
    if ((notification.agent ?? "") !== (candidate.agent ?? "")) {
      return true;
    }
    if (notification.surfaceId) {
      removedSurfaceIds.add(notification.surfaceId);
    }
    return false;
  });

  if (nextNotifications.length === state.notifications.length) {
    return false;
  }

  state.notifications = nextNotifications;
  for (const surfaceId of removedSurfaceIds) {
    syncSurfaceNotificationState(state, surfaceId);
  }
  return true;
}

function clearLatestNotificationMatching(
  state: AppState,
  candidate: Pick<
    NotificationItem,
    "workspaceId" | "surfaceId" | "source" | "kind" | "agent"
  >
): boolean {
  const removed = state.notifications.find((notification) => {
    if (notification.workspaceId !== candidate.workspaceId) {
      return false;
    }
    if (candidate.surfaceId && notification.surfaceId !== candidate.surfaceId) {
      return false;
    }
    if ((notification.source ?? "socket") !== candidate.source) {
      return false;
    }
    if ((notification.kind ?? "generic") !== (candidate.kind ?? "generic")) {
      return false;
    }
    if ((notification.agent ?? "") !== (candidate.agent ?? "")) {
      return false;
    }
    return true;
  });

  if (!removed) {
    return false;
  }

  state.notifications = state.notifications.filter(
    (notification) => notification.id !== removed.id
  );
  if (removed.surfaceId) {
    syncSurfaceNotificationState(state, removed.surfaceId);
  }
  return true;
}

function normalizeNotificationText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isInputRequestNotification(title: string, message: string): boolean {
  const text = `${title} ${message}`;
  return (
    text.includes("needs input") ||
    text.includes("need input") ||
    text.includes("waiting for input") ||
    text.includes("tool permission")
  );
}

function clearNotifications(state: AppState, notificationId?: Id): AppEffect[] {
  if (notificationId) {
    const notification = state.notifications.find(
      (item) => item.id === notificationId
    );
    state.notifications = state.notifications.filter(
      (item) => item.id !== notificationId
    );
    if (notification?.surfaceId) {
      syncSurfaceNotificationState(state, notification.surfaceId);
    }
  } else {
    state.notifications = [];
    for (const surface of Object.values(state.surfaces)) {
      surface.unreadCount = 0;
      surface.attention = false;
    }
  }
  return [{ type: "persist" }];
}

function jumpLatestUnread(state: AppState): AppEffect[] {
  const latest = state.notifications[0];
  if (!latest) {
    return [];
  }

  const targetSurface = latest.surfaceId
    ? state.surfaces[latest.surfaceId]
    : undefined;
  const targetPane = targetSurface
    ? state.panes[targetSurface.paneId]
    : undefined;

  if (
    latest.surfaceId &&
    targetSurface &&
    targetPane &&
    state.workspaces[targetPane.workspaceId]
  ) {
    return focusSurface(state, latest.surfaceId);
  }

  if (latest.workspaceId && state.workspaces[latest.workspaceId]) {
    selectWorkspace(state, latest.workspaceId);
  }

  return clearNotifications(state, latest.id);
}

function markNotificationsRead(
  state: AppState,
  workspaceId: Id,
  paneId: Id,
  surfaceId: Id
): void {
  state.notifications = state.notifications.filter(
    (notification) =>
      !(
        notification.workspaceId === workspaceId &&
        notification.paneId === paneId &&
        notification.surfaceId === surfaceId
      )
  );
  syncSurfaceNotificationState(state, surfaceId);
}

function syncSurfaceNotificationState(state: AppState, surfaceId: Id): void {
  const surface = state.surfaces[surfaceId];
  if (!surface) {
    return;
  }
  const unreadCount = state.notifications.reduce((count, notification) => {
    if (notification.surfaceId === surfaceId) {
      return count + 1;
    }
    return count;
  }, 0);
  surface.unreadCount = unreadCount;
  surface.attention = unreadCount > 0;
}

function findParentSplit(
  workspace: WorkspaceState,
  nodeId: Id
): { parentId: Id } | null {
  for (const node of Object.values(workspace.nodeMap)) {
    if (
      node.kind === "split" &&
      (node.first === nodeId || node.second === nodeId)
    ) {
      return { parentId: node.id };
    }
  }
  return null;
}

function replaceNodeReference(
  workspace: WorkspaceState,
  targetNodeId: Id,
  replacementNodeId: Id
): void {
  if (workspace.rootNodeId === targetNodeId) {
    workspace.rootNodeId = replacementNodeId;
  }
  for (const node of Object.values(workspace.nodeMap)) {
    if (node.kind === "split") {
      if (node.first === targetNodeId) {
        node.first = replacementNodeId;
      }
      if (node.second === targetNodeId) {
        node.second = replacementNodeId;
      }
    }
  }
}

function findAncestorSplits(
  workspace: WorkspaceState,
  paneId: Id
): Array<{ splitId: Id; isFirst: boolean }> {
  const result: Array<{ splitId: Id; isFirst: boolean }> = [];
  const walk = (nodeId: Id): boolean => {
    const node = workspace.nodeMap[nodeId];
    if (!node) {
      return false;
    }
    if (node.kind === "leaf") {
      return node.paneId === paneId;
    }
    const firstHit = walk(node.first);
    if (firstHit) {
      result.push({ splitId: node.id, isFirst: true });
      return true;
    }
    const secondHit = walk(node.second);
    if (secondHit) {
      result.push({ splitId: node.id, isFirst: false });
      return true;
    }
    return false;
  };

  walk(workspace.rootNodeId);
  return result;
}

function activeSurface(state: AppState, paneId: Id): SurfaceState | undefined {
  const pane = state.panes[paneId];
  return pane ? state.surfaces[pane.activeSurfaceId] : undefined;
}

function buildPtySpec(
  state: AppState,
  workspaceId: Id,
  surfaceId: Id,
  sessionId: Id
): PtySessionSpec {
  const session = state.sessions[sessionId];
  const paneId = state.surfaces[surfaceId]?.paneId;
  return {
    sessionId,
    surfaceId,
    workspaceId,
    launch: session.launch,
    cols: 120,
    rows: 30,
    env: {
      KMUX_SOCKET_MODE: state.settings.socketMode,
      KMUX_WORKSPACE_ID: workspaceId,
      ...(paneId ? { KMUX_PANE_ID: paneId } : {}),
      KMUX_SURFACE_ID: surfaceId,
      KMUX_SESSION_ID: sessionId,
      KMUX_AUTH_TOKEN: session.authToken,
      TERM_PROGRAM: "kmux"
    }
  };
}

export function listPaneIds(workspace: WorkspaceState): Id[] {
  return Object.values(workspace.nodeMap)
    .filter(
      (node): node is Extract<PaneTreeNode, { kind: "leaf" }> =>
        node.kind === "leaf"
    )
    .map((node) => node.paneId);
}

export function listWorkspacePaneIds(state: AppState, workspaceId: Id): Id[] {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return [];
  }
  return listPaneIds(workspace).filter(
    (paneId) => state.panes[paneId]?.workspaceId === workspace.id
  );
}

export function listWorkspaceSurfaceIds(
  state: AppState,
  workspaceId: Id
): Id[] {
  return listWorkspacePaneIds(state, workspaceId).flatMap((paneId) =>
    (state.panes[paneId]?.surfaceIds ?? []).filter(
      (surfaceId) => state.surfaces[surfaceId]?.paneId === paneId
    )
  );
}

function activeWorkspaceState(state: AppState): WorkspaceState {
  return state.workspaces[
    state.windows[state.activeWindowId].activeWorkspaceId
  ];
}

function listVisibleWorkspaceIds(
  state: AppState,
  window: WindowState = state.windows[state.activeWindowId]
): Id[] {
  const pinned: Id[] = [];
  const unpinned: Id[] = [];

  for (const workspaceId of window.workspaceOrder) {
    const workspace = state.workspaces[workspaceId];
    if (!workspace) {
      continue;
    }
    if (workspace.pinned) {
      pinned.push(workspaceId);
    } else {
      unpinned.push(workspaceId);
    }
  }

  return [...pinned, ...unpinned];
}

export function buildViewModel(state: AppState): ShellViewModel {
  const window = state.windows[state.activeWindowId];
  const orderedWorkspaceIds = listVisibleWorkspaceIds(state, window);
  const workspace =
    state.workspaces[window.activeWorkspaceId] ??
    state.workspaces[orderedWorkspaceIds[0]] ??
    state.workspaces[Object.keys(state.workspaces)[0]];
  if (!workspace) {
    throw new Error("Cannot build view model without an available workspace");
  }
  const workspacePaneIdsById = new Map(
    orderedWorkspaceIds.map((workspaceId) => [
      workspaceId,
      listWorkspacePaneIds(state, workspaceId)
    ])
  );
  const workspaceSurfaceIdsById = new Map(
    orderedWorkspaceIds.map((workspaceId) => [
      workspaceId,
      listWorkspaceSurfaceIds(state, workspaceId)
    ])
  );
  const workspacePaneIds = workspacePaneIdsById.get(workspace.id) ?? [];
  const activeWorkspaceSurfaceIds =
    workspaceSurfaceIdsById.get(workspace.id) ?? [];
  const activeWorkspaceStatusEntries = workspaceStatusEntries(workspace);
  const activeWorkspace: ActiveWorkspaceVm = {
    id: workspace.id,
    name: workspace.name,
    rootNodeId: workspace.rootNodeId,
    nodes: structuredClone(workspace.nodeMap),
    panes: Object.fromEntries(
      workspacePaneIds.map((paneId) => {
        const pane = state.panes[paneId];
        return [
          paneId,
          {
            id: pane.id,
            surfaceIds: [...pane.surfaceIds],
            activeSurfaceId: pane.activeSurfaceId,
            focused: workspace.activePaneId === paneId
          }
        ];
      })
    ),
    surfaces: Object.fromEntries(
      activeWorkspaceSurfaceIds.map((surfaceId) => {
        const surface = state.surfaces[surfaceId];
        return [
          surface.id,
          {
            id: surface.id,
            title: surface.title,
            cwd: surface.cwd,
            branch: surface.branch,
            ports: [...surface.ports],
            unreadCount: surface.unreadCount,
            attention: surface.attention,
            sessionState:
              state.sessions[surface.sessionId]?.runtimeState ?? "pending",
            exitCode: state.sessions[surface.sessionId]?.exitCode
          } satisfies SurfaceVm
        ];
      })
    ),
    activePaneId: workspace.activePaneId,
    sidebarStatus: workspace.statusText,
    statusEntries: activeWorkspaceStatusEntries,
    progress: workspace.progress,
    logs: [...workspace.logs]
  };

  return {
    windowId: window.id,
    title: `${workspace.name} cli/unix socket`,
    sidebarVisible: window.sidebarVisible,
    sidebarWidth: window.sidebarWidth,
    workspaceRows: orderedWorkspaceIds.map((workspaceId) => {
      const entry = state.workspaces[workspaceId];
      const representativeSurfaceTitle =
        firstWorkspaceSurface(state, entry)?.title ?? "Waiting for input";
      const surfaces = (workspaceSurfaceIdsById.get(workspaceId) ?? []).map(
        (surfaceId) => state.surfaces[surfaceId]
      );
      return {
        workspaceId,
        name: entry.name,
        nameLocked: Boolean(entry.nameLocked),
        summary: representativeSurfaceTitle,
        cwd: entry.cwdSummary,
        branch: entry.branch,
        ports: entry.ports,
        statusText: entry.statusText,
        statusEntries: workspaceStatusEntries(entry),
        unreadCount: surfaces.reduce(
          (sum, surface) => sum + surface.unreadCount,
          0
        ),
        attention: surfaces.some((surface) => surface.attention),
        pinned: entry.pinned,
        isActive: workspaceId === window.activeWorkspaceId
      };
    }),
    activeWorkspace,
    notifications: [...state.notifications],
    unreadNotifications: state.notifications.length,
    settings: state.settings,
    terminalTypography: createPendingResolvedTerminalTypographyVm(
      state.settings.terminalTypography
    )
  };
}

function workspaceStatusEntries(
  workspace: WorkspaceState
): SidebarStatusEntry[] {
  return sortedWorkspaceStatusEntries(workspace).slice(
    0,
    MAX_VIEW_STATUS_ENTRIES
  );
}

function sortedWorkspaceStatusEntries(
  workspace: WorkspaceState
): SidebarStatusEntry[] {
  return Object.values(workspace.statusEntries ?? {}).sort(compareStatusEntries);
}

function compareStatusEntries(
  left: SidebarStatusEntry,
  right: SidebarStatusEntry
): number {
  const priorityDelta =
    statusEntryPriority(left) - statusEntryPriority(right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const updatedAtDelta = right.updatedAt.localeCompare(left.updatedAt);
  return updatedAtDelta !== 0
    ? updatedAtDelta
    : left.key.localeCompare(right.key);
}

function statusEntryPriority(entry: SidebarStatusEntry): number {
  if (entry.key === MANUAL_STATUS_KEY) {
    return 0;
  }
  if (entry.variant === "error" || entry.variant === "attention") {
    return 1;
  }
  return 2;
}

function pruneWorkspaceStatusEntries(workspace: WorkspaceState): boolean {
  const entries = sortedWorkspaceStatusEntries(workspace);
  if (entries.length <= MAX_WORKSPACE_STATUS_ENTRIES) {
    return false;
  }

  workspace.statusEntries = Object.fromEntries(
    entries
      .slice(0, MAX_WORKSPACE_STATUS_ENTRIES)
      .map((entry) => [entry.key, entry])
  );
  return true;
}

function firstWorkspaceSurface(
  state: AppState,
  workspace: WorkspaceState
): SurfaceState | null {
  const paneId = firstPaneIdInTreeOrder(workspace);
  if (!paneId) {
    return null;
  }
  const pane = state.panes[paneId];
  if (!pane) {
    return null;
  }
  const surfaceId = pane.surfaceIds[0];
  return surfaceId ? (state.surfaces[surfaceId] ?? null) : null;
}

function firstPaneIdInTreeOrder(workspace: WorkspaceState): Id | null {
  function walk(nodeId: Id): Id | null {
    const node = workspace.nodeMap[nodeId];
    if (!node) {
      return null;
    }
    if (node.kind === "leaf") {
      return node.paneId;
    }
    return walk(node.first) ?? walk(node.second);
  }

  return walk(workspace.rootNodeId);
}

function sanitizeState(state: AppState): AppState {
  const firstWindowId = Object.keys(state.windows)[0];
  if (!state.windows[state.activeWindowId] && firstWindowId) {
    state.activeWindowId = firstWindowId;
  }

  const firstWorkspaceId = Object.keys(state.workspaces)[0];

  for (const window of Object.values(state.windows)) {
    window.workspaceOrder = window.workspaceOrder.filter((workspaceId) =>
      Boolean(state.workspaces[workspaceId])
    );
    window.sidebarWidth = clamp(
      Number.isFinite(window.sidebarWidth)
        ? window.sidebarWidth
        : DEFAULT_SIDEBAR_WIDTH,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH
    );
    if (!window.workspaceOrder.length && firstWorkspaceId) {
      window.workspaceOrder = [firstWorkspaceId];
    }
    if (
      !state.workspaces[window.activeWorkspaceId] &&
      window.workspaceOrder.length > 0
    ) {
      window.activeWorkspaceId = window.workspaceOrder[0];
    }
  }

  for (const pane of Object.values(state.panes)) {
    pane.surfaceIds = pane.surfaceIds.filter(
      (surfaceId) => state.surfaces[surfaceId]?.paneId === pane.id
    );
    if (
      pane.surfaceIds.length > 0 &&
      !pane.surfaceIds.includes(pane.activeSurfaceId)
    ) {
      pane.activeSurfaceId = pane.surfaceIds[0];
    }
  }

  for (const workspace of Object.values(state.workspaces)) {
    sanitizeWorkspaceStatusEntries(workspace);
    const paneIds = listPaneIds(workspace).filter(
      (paneId) => state.panes[paneId]?.workspaceId === workspace.id
    );
    if (paneIds.length > 0 && !paneIds.includes(workspace.activePaneId)) {
      workspace.activePaneId = paneIds[0];
    }
    delete (workspace as WorkspaceState & { zoomedPaneId?: Id }).zoomedPaneId;
  }

  state.settings = sanitizeSettings(state.settings as LegacyKmuxSettings);
  state.notifications = Array.isArray(state.notifications)
    ? state.notifications.flatMap((notification) => {
        if (!notification || typeof notification !== "object") {
          return [];
        }
        const { read, ...sanitized } = notification as NotificationItem & {
          read?: boolean;
        };
        if (read === true) {
          return [];
        }
        return [sanitized as NotificationItem];
      })
    : [];

  for (const session of Object.values(state.sessions)) {
    session.launch = sanitizeSessionLaunchConfig(
      session.launch,
      state.settings.shell
    );
  }

  for (const surface of Object.values(state.surfaces)) {
    syncSurfaceNotificationState(state, surface.id);
  }

  return state;
}

function sanitizeWorkspaceStatusEntries(workspace: WorkspaceState): void {
  const legacyStatusText = normalizeStatusText(workspace.statusText);
  const rawEntries =
    typeof workspace.statusEntries === "object" && workspace.statusEntries
      ? workspace.statusEntries
      : {};
  const nextEntries: Record<string, SidebarStatusEntry> = {};

  for (const [rawKey, rawEntry] of Object.entries(rawEntries)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry as Partial<SidebarStatusEntry>;
    const key = normalizeStatusKey(entry.key ?? rawKey);
    if (key.startsWith("agent:")) {
      continue;
    }
    const text = normalizeStatusText(entry.text);
    if (!text) {
      continue;
    }
    nextEntries[key] = {
      key,
      text,
      label: normalizeOptionalText(entry.label, 64),
      variant:
        entry.variant === "attention" ||
        entry.variant === "muted" ||
        entry.variant === "error"
          ? entry.variant
          : "info",
      updatedAt: normalizeOptionalText(entry.updatedAt, 64) ?? isoNow(),
      surfaceId: normalizeOptionalText(entry.surfaceId, 128)
    };
  }

  if (legacyStatusText && !nextEntries[MANUAL_STATUS_KEY]) {
    nextEntries[MANUAL_STATUS_KEY] = {
      key: MANUAL_STATUS_KEY,
      text: legacyStatusText,
      variant: "info",
      updatedAt: isoNow()
    };
  }
  workspace.statusText = legacyStatusText || undefined;
  workspace.statusEntries = nextEntries;
  pruneWorkspaceStatusEntries(workspace);
}

function sanitizeSessionLaunchConfig(
  launch: SessionLaunchConfig | undefined,
  fallbackShell: string | undefined
): SessionLaunchConfig {
  const nextLaunch: SessionLaunchConfig = {
    ...(launch ?? {})
  };

  if (!Array.isArray(nextLaunch.args) || nextLaunch.args.length === 0) {
    delete nextLaunch.args;
  }

  if (!nextLaunch.shell && fallbackShell) {
    nextLaunch.shell = fallbackShell;
  }

  return nextLaunch;
}

function sanitizeShortcuts(
  shortcuts: Record<string, string>
): Record<string, string> {
  const nextShortcuts = { ...shortcuts };
  delete nextShortcuts["workspace.switcher"];
  delete nextShortcuts["pane.zoom"];
  return nextShortcuts;
}

function sanitizeThemeMode(
  themeMode: KmuxSettings["themeMode"] | undefined
): KmuxSettings["themeMode"] {
  if (themeMode === "light" || themeMode === "system") {
    return themeMode;
  }
  return "dark";
}

function sanitizeTerminalUseWebgl(
  terminalUseWebgl: boolean | undefined
): boolean {
  return typeof terminalUseWebgl === "boolean" ? terminalUseWebgl : true;
}

function sanitizeTextFontFamily(fontFamily: string | undefined): string {
  return fontFamily?.trim() || DEFAULT_TERMINAL_TEXT_FONT_FAMILY;
}

function sanitizeSymbolFallbackFamilies(
  symbolFallbackFamilies: string[] | undefined
): string[] {
  if (!Array.isArray(symbolFallbackFamilies)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const family of symbolFallbackFamilies) {
    const nextFamily = typeof family === "string" ? family.trim() : "";
    if (!nextFamily || seen.has(nextFamily)) {
      continue;
    }
    seen.add(nextFamily);
    normalized.push(nextFamily);
  }
  return normalized;
}

function sanitizeFontSize(fontSize: number | undefined): number {
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.max(8, Math.min(32, fontSize));
}

function sanitizeLineHeight(lineHeight: number | undefined): number {
  if (typeof lineHeight !== "number" || !Number.isFinite(lineHeight)) {
    return DEFAULT_TERMINAL_LINE_HEIGHT;
  }
  return Math.max(0.8, Math.min(2, lineHeight));
}

function sanitizeTerminalTypographySettings(
  terminalTypography: Partial<TerminalTypographySettings> | undefined,
  legacyTypography: LegacyTypographyFields = {},
  current: TerminalTypographySettings = createDefaultTerminalTypographySettings()
): TerminalTypographySettings {
  return {
    preferredTextFontFamily: sanitizeTextFontFamily(
      terminalTypography?.preferredTextFontFamily ??
        legacyTypography.terminalFontFamily ??
        current.preferredTextFontFamily
    ),
    preferredSymbolFallbackFamilies: sanitizeSymbolFallbackFamilies(
      terminalTypography?.preferredSymbolFallbackFamilies ??
        current.preferredSymbolFallbackFamilies
    ),
    fontSize: sanitizeFontSize(
      terminalTypography?.fontSize ??
        legacyTypography.terminalFontSize ??
        current.fontSize
    ),
    lineHeight: sanitizeLineHeight(
      terminalTypography?.lineHeight ??
        legacyTypography.terminalLineHeight ??
        current.lineHeight
    )
  };
}

function computePaneRects(
  workspace: WorkspaceState
): Array<{ paneId: Id; x: number; y: number; width: number; height: number }> {
  const rects: Array<{
    paneId: Id;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  const walk = (
    nodeId: Id,
    x: number,
    y: number,
    width: number,
    height: number
  ) => {
    const node = workspace.nodeMap[nodeId];
    if (!node) {
      return;
    }
    if (node.kind === "leaf") {
      rects.push({ paneId: node.paneId, x, y, width, height });
      return;
    }
    if (node.axis === "vertical") {
      const firstWidth = width * node.ratio;
      walk(node.first, x, y, firstWidth, height);
      walk(node.second, x + firstWidth, y, width - firstWidth, height);
    } else {
      const firstHeight = height * node.ratio;
      walk(node.first, x, y, width, firstHeight);
      walk(node.second, x, y + firstHeight, width, height - firstHeight);
    }
  };
  walk(workspace.rootNodeId, 0, 0, 1, 1);
  return rects;
}

function directionalDistance(
  current: { x: number; y: number; width: number; height: number },
  candidate: { x: number; y: number; width: number; height: number },
  direction: SplitDirection
): number {
  const currentCenterX = current.x + current.width / 2;
  const currentCenterY = current.y + current.height / 2;
  const candidateCenterX = candidate.x + candidate.width / 2;
  const candidateCenterY = candidate.y + candidate.height / 2;
  const dx = candidateCenterX - currentCenterX;
  const dy = candidateCenterY - currentCenterY;

  if (direction === "left" && dx >= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "right" && dx <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "up" && dy >= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "down" && dy <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
