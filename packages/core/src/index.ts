import {
  buildDefaultShortcuts,
  createDefaultTerminalThemeSettings,
  normalizeShortcutBinding,
  sanitizeTerminalThemeSettings,
  type ShortcutCommandId,
  type ShortcutPlatform
} from "@kmux/ui";
import {
  type AgentEventName,
  type ActiveWorkspaceActivityVm,
  type ActiveWorkspacePaneTreeVm,
  type ActiveWorkspaceVm,
  type ExternalAgentSessionRef,
  type ExternalAgentSessionVendor,
  type Id,
  formatUint64Decimal,
  isoNow,
  type KmuxSettings,
  type ResolvedTerminalTypographyVm,
  makeId,
  parseUint64Decimal,
  type NotificationItem,
  type PaneTreeNode,
  type TerminalTypographySettings,
  type SessionLaunchConfig as SessionLaunchConfigDto,
  type ShellViewModel,
  type SidebarLogEntry,
  type SidebarProgress,
  type SidebarStatusEntry,
  type SocketMode,
  type SplitAxis,
  type SplitDirection,
  type SurfaceDiagnosticCaptureMode,
  type SurfaceVm,
  type WorkspaceDetectedWorktreeMetadata as WorkspaceDetectedWorktreeMetadataDto,
  type WorkspaceGitRepositoryMetadata as WorkspaceGitRepositoryMetadataDto,
  type WorkspaceRowVm,
  type WorkspaceWorktreeMetadata as WorkspaceWorktreeMetadataDto,
  type TerminalThemeSettings,
  type Uint64
} from "@kmux/proto";
import {
  type AgentSessionRef,
  type LocatedPath,
  type LocatedWorkspaceDetectedWorktreeMetadata,
  type LocatedWorkspaceGitRepositoryMetadata,
  type LocatedWorkspaceWorktreeMetadata,
  type SessionRuntimeStatus,
  type RemoteSessionRuntimeState,
  type RemoteSessionStorageStatus,
  type StoredSessionLaunchConfig,
  type WorkspaceLocation,
  type WorkspaceTarget,
  assertLocatedPathTarget,
  decodeLocatedPathDto,
  decodeWorkspaceLocationDto,
  encodeLocatedPathDto,
  encodeWorkspaceLocationDto,
  locatedPathForTarget,
  sameLocatedPath,
  workspaceLocation
} from "./domain";
import {
  decodeRemoteOperationProjectionDto,
  encodeRemoteOperationProjectionDto,
  type RemoteOperationProjection
} from "./remoteOperation";
import type {
  SurfaceContentOf,
  SurfaceOpenAction,
  SurfaceState,
  TerminalRuntimeMetadata
} from "./surfaces/contracts";

export type {
  SurfaceContent,
  SurfaceContentMap,
  SurfaceContentOf,
  SurfaceInit,
  SurfaceInitMap,
  SurfaceOpenAction,
  SurfacePlacementRequest,
  SurfaceState,
  MarkdownFileSource,
  MarkdownSurfaceContent,
  MarkdownSurfaceInit,
  TerminalRuntimeMetadata,
  TerminalSurfaceContent,
  TerminalSurfaceInit
} from "./surfaces/contracts";
import { surfaceCoreModule } from "./surfaces/registry";

export {
  LocalPath,
  RemotePath,
  assertLocatedPathTarget,
  decodeLocalPath,
  decodeLocatedPathDto,
  decodeRemotePath,
  decodeWorkspaceLocationDto,
  decodeWorkspaceTarget,
  encodeLocatedPathDto,
  encodeWorkspaceLocationDto,
  localLocatedPath,
  locatedPathForTarget,
  remoteLocatedPath,
  sameLocatedPath,
  sameWorkspaceTarget,
  targetOfLocatedPath,
  validateRemoteTargetBinding,
  workspaceLocation
} from "./domain";
export type {
  AgentSessionRef,
  LocatedPath,
  LocatedPathDto,
  LocatedWorkspaceDetectedWorktreeMetadata,
  LocatedWorkspaceGitRepositoryMetadata,
  LocatedWorkspaceWorktreeMetadata,
  RemoteAuthenticatedPrincipal,
  RemoteAuthorityIdentity,
  RemoteResourceKey,
  RemoteTargetBinding,
  RemoteTargetLocator,
  RemoteTargetObservation,
  RemoteSessionRuntimeState,
  RemoteSessionStorageStatus,
  SessionLaunchConfig,
  SessionRuntimeStatus,
  SshProfile,
  StoredSessionLaunchConfig,
  WorkspaceLocation,
  WorkspaceLocationDto,
  WorkspaceTarget
} from "./domain";
export {
  canonicalizeRemoteOperationPayload,
  createRemotePendingProductProjection,
  decodeRemoteOperationIntentDto,
  decodeRemoteOperationPayload,
  decodeRemoteOperationProjectionDto,
  encodeRemoteOperationIntentDto,
  encodeRemoteOperationProjectionDto,
  payloadFromRemotePendingProductProjection
} from "./remoteOperation";
export type {
  RemoteOperationIntent,
  RemoteOperationIntentDto,
  RemoteOperationAdmissionCommand,
  RemoteOperationCommandResult,
  RemoteOperationExecutionOutcome,
  RemoteOperationKind,
  RemoteOperationPayloadDto,
  RemotePendingProductProjection,
  RemoteOperationProjection,
  RemoteOperationProjectionDto,
  RemoteOperationProjectionState,
  RemoteSessionLaunchPayloadDto,
  RemoteWorktreeProductMetadata
} from "./remoteOperation";

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
  location: WorkspaceLocation;
  worktree?: LocatedWorkspaceWorktreeMetadata;
  detectedWorktree?: LocatedWorkspaceDetectedWorktreeMetadata;
  dismissedWorktreePaths?: LocatedPath[];
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
  /** Last authoritative revision of the remote workspace descriptor. */
  remoteResourceRevision?: Uint64;
}

export interface PaneState {
  id: Id;
  workspaceId: Id;
  surfaceIds: Id[];
  activeSurfaceId: Id;
}

export interface SessionState {
  id: Id;
  surfaceId: Id;
  launch: StoredSessionLaunchConfig;
  agentSessionRef?: AgentSessionRef;
  authToken: string;
  runtimeStatus: SessionRuntimeStatus;
  remoteRuntime?: RemoteSessionRuntimeState;
  shellInputReady: boolean;
  pid?: number;
  exitCode?: number;
  runtimeMetadata: TerminalRuntimeMetadata;
}

export interface RemoteEventReceiptState {
  throughSequence: Uint64;
  recentEventIds: Id[];
}

export interface AppState {
  windows: Record<Id, WindowState>;
  workspaces: Record<Id, WorkspaceState>;
  panes: Record<Id, PaneState>;
  surfaces: Record<Id, SurfaceState>;
  sessions: Record<Id, SessionState>;
  remoteOperations: Record<Id, RemoteOperationProjection>;
  remoteEventReceipts: Record<Id, RemoteEventReceiptState>;
  notifications: NotificationItem[];
  settings: KmuxSettings;
  activeWindowId: Id;
}

type LegacyTypographyFields = {
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
  startupRestore?: boolean;
};

type LegacyKmuxSettings = Partial<KmuxSettings> & LegacyTypographyFields;

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const JETBRAINS_MONO_NERD_FONT_MONO_FAMILY =
  '"JetBrainsMono Nerd Font Mono"';
const LEGACY_TERMINAL_TEXT_FONT_FAMILY =
  'ui-monospace, Menlo, Monaco, Consolas, "SFMono-Regular", monospace';
const PREVIOUS_BUNDLED_TERMINAL_TEXT_FONT_FAMILY = `"kmux JetBrainsMono Nerd Font Mono", ${JETBRAINS_MONO_NERD_FONT_MONO_FAMILY}, ${LEGACY_TERMINAL_TEXT_FONT_FAMILY}`;
export const DEFAULT_TERMINAL_TEXT_FONT_FAMILY = `${JETBRAINS_MONO_NERD_FONT_MONO_FAMILY}, ${LEGACY_TERMINAL_TEXT_FONT_FAMILY}`;
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
export const CURRENT_SETTINGS_VERSION = 4;
const TERMINAL_TYPOGRAPHY_DEFAULT_RESET_SETTINGS_VERSION = 4;

export interface SessionSpawnEffect {
  type: "session.spawn";
  sessionId: Id;
  surfaceId: Id;
  workspaceId: Id;
  launch: StoredSessionLaunchConfig;
  initialSize: {
    cols: number;
    rows: number;
  };
  sessionEnv: Record<string, string>;
}

function defaultHomeDirectory(): string {
  const homeDirectory =
    typeof process !== "undefined"
      ? (process.env.HOME ?? process.env.USERPROFILE)
      : undefined;
  return homeDirectory?.trim() || "~";
}

function defaultLocalCwd(): LocatedPath {
  return locatedPathForTarget({ kind: "local" }, defaultHomeDirectory());
}

export function pendingSessionRuntimeStatus(): SessionRuntimeStatus {
  return {
    processState: "pending",
    observationState: "unknown",
    attachmentState: "detached"
  };
}

export type AppEffect =
  | SessionSpawnEffect
  | {
      type: "session.close";
      sessionId: Id;
    }
  | {
      type: "surface.runtime.close";
      kind: "markdown";
      surfaceId: Id;
    }
  | {
      type: "metadata.refresh";
      workspaceId: Id;
      surfaceId?: Id;
      pid?: number;
      cwd?: LocatedPath;
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

export type RemoteEventProductAction =
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
    };

export type AppAction =
  | {
      type: "workspace.create";
      name?: string;
      cwd?: string;
      target?: WorkspaceTarget;
      launch?: SessionLaunchConfigDto;
      agentSessionRef?: ExternalAgentSessionRef;
    }
  | { type: "workspace.select"; workspaceId: Id }
  | { type: "workspace.selectRelative"; delta: number }
  | { type: "workspace.selectIndex"; index: number }
  | { type: "workspace.rename"; workspaceId: Id; name: string }
  | { type: "workspace.close"; workspaceId: Id }
  | { type: "workspace.closeOthers"; workspaceId: Id }
  | { type: "workspace.pin.toggle"; workspaceId: Id }
  | { type: "workspace.move"; workspaceId: Id; toIndex: number }
  | {
      type: "workspace.worktree.convert";
      workspaceId: Id;
      worktree: WorkspaceWorktreeMetadataDto;
      createSurface?: boolean;
      focus?: boolean;
    }
  | {
      type: "workspace.worktree.detected";
      workspaceId: Id;
      detectedWorktree: WorkspaceDetectedWorktreeMetadataDto;
    }
  | {
      type: "workspace.worktree.launchSurfaceCreated";
      workspaceId: Id;
      path: string;
    }
  | {
      type: "workspace.worktree.dismissDetected";
      workspaceId: Id;
      path: string;
    }
  | { type: "workspace.worktree.clearDetected"; workspaceId: Id }
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
  | SurfaceOpenAction
  | {
      type: "surface.create";
      paneId: Id;
      title?: string;
      cwd?: string;
      launch?: SessionLaunchConfigDto;
    }
  | { type: "surface.focus"; surfaceId: Id }
  | {
      type: "surface.moveToSplit";
      surfaceId: Id;
      targetPaneId: Id;
      direction: SplitDirection;
    }
  | { type: "surface.focusRelative"; paneId: Id; delta: number }
  | { type: "surface.focusIndex"; paneId: Id; index: number }
  | { type: "surface.rename"; surfaceId: Id; title: string }
  | { type: "surface.close"; surfaceId: Id }
  | { type: "surface.closeOthers"; surfaceId: Id }
  | { type: "surface.restartSession"; surfaceId: Id }
  | {
      type: "surface.metadata";
      surfaceId: Id;
      cwd?: string;
      title?: string;
      branch?: string | null;
      ports?: number[];
      gitRepository?: WorkspaceGitRepositoryMetadataDto | null;
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
  | {
      type: "remote.event.apply";
      targetId: Id;
      sequence: Uint64;
      eventId: Id;
      productAction?: RemoteEventProductAction;
    }
  | { type: "agent.attention.clear"; surfaceId: Id }
  | { type: "notification.clear"; notificationId?: Id }
  | { type: "notification.jumpLatestUnread" }
  | { type: "terminal.bell" }
  | { type: "settings.update"; patch: SettingsPatch }
  | {
      type: "session.started";
      sessionId: Id;
      pid: number;
      shellInputReady: boolean;
    }
  | { type: "session.shellReady"; sessionId: Id }
  | { type: "session.exited"; sessionId: Id; exitCode?: number }
  | { type: "state.restore"; snapshot: AppState };

export function createDefaultSettings(
  mode: SocketMode = "kmuxOnly",
  shellPath: string | undefined = process.env.SHELL,
  options: {
    shortcutDefaultsPlatform?: ShortcutPlatform;
  } = {}
): KmuxSettings {
  const shortcutDefaultsPlatform = options.shortcutDefaultsPlatform ?? "darwin";
  return {
    settingsVersion: CURRENT_SETTINGS_VERSION,
    socketMode: mode,
    warnBeforeQuit: true,
    restoreWorkspacesAfterQuit: true,
    notificationDesktop: true,
    notificationSound: true,
    themeMode: "dark",
    shell: shellPath,
    shortcutDefaultsPlatform,
    surfaceDiagnosticCaptureMode: "default",
    diagnosticLoggingEnabled: false,
    shortcuts: buildDefaultShortcuts(shortcutDefaultsPlatform),
    terminalTypography: createDefaultTerminalTypographySettings(),
    terminalThemes: createDefaultTerminalThemeSettings()
  };
}

export function resolveSurfaceDiagnosticCaptureEnabled(
  mode: SurfaceDiagnosticCaptureMode,
  defaultEnabled: boolean
): boolean {
  if (mode === "enabled") {
    return true;
  }
  if (mode === "disabled") {
    return false;
  }
  return defaultEnabled;
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
    startupRestore: _legacyStartupRestore,
    ...nextPatch
  } = patch;
  const shortcuts = sanitizeShortcuts({
    ...current.shortcuts,
    ...(nextPatch.shortcuts ?? {})
  });

  return {
    settingsVersion: CURRENT_SETTINGS_VERSION,
    socketMode: nextPatch.socketMode ?? current.socketMode,
    warnBeforeQuit:
      typeof nextPatch.warnBeforeQuit === "boolean"
        ? nextPatch.warnBeforeQuit
        : current.warnBeforeQuit,
    restoreWorkspacesAfterQuit:
      typeof nextPatch.restoreWorkspacesAfterQuit === "boolean"
        ? nextPatch.restoreWorkspacesAfterQuit
        : current.restoreWorkspacesAfterQuit,
    notificationDesktop:
      typeof nextPatch.notificationDesktop === "boolean"
        ? nextPatch.notificationDesktop
        : current.notificationDesktop,
    notificationSound:
      typeof nextPatch.notificationSound === "boolean"
        ? nextPatch.notificationSound
        : current.notificationSound,
    themeMode: sanitizeThemeMode(nextPatch.themeMode ?? current.themeMode),
    shell: nextPatch.shell ?? current.shell,
    shortcutDefaultsPlatform:
      sanitizeShortcutDefaultsPlatform(nextPatch.shortcutDefaultsPlatform) ??
      current.shortcutDefaultsPlatform,
    surfaceDiagnosticCaptureMode: sanitizeSurfaceDiagnosticCaptureMode(
      nextPatch.surfaceDiagnosticCaptureMode ??
        current.surfaceDiagnosticCaptureMode
    ),
    diagnosticLoggingEnabled:
      typeof nextPatch.diagnosticLoggingEnabled === "boolean"
        ? nextPatch.diagnosticLoggingEnabled
        : current.diagnosticLoggingEnabled,
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
  const settingsVersion = sanitizeSettingsVersion(settings.settingsVersion);
  const migratedSettings: LegacyKmuxSettings = {
    ...settings,
    settingsVersion: CURRENT_SETTINGS_VERSION,
    notificationSound: settingsVersion < 2 ? true : settings.notificationSound
  };
  const sanitizedSettings = mergeSettings(
    createDefaultSettings(settings.socketMode),
    migratedSettings
  );
  return migrateSettingsAfterSanitize(sanitizedSettings, settingsVersion);
}

export function migrateShortcutDefaultsForPlatform(
  settings: KmuxSettings,
  targetPlatform: ShortcutPlatform
): KmuxSettings {
  const sourcePlatform =
    sanitizeShortcutDefaultsPlatform(settings.shortcutDefaultsPlatform) ??
    "darwin";
  if (sourcePlatform === targetPlatform) {
    return {
      ...settings,
      shortcutDefaultsPlatform: targetPlatform
    };
  }

  const sourceDefaults = buildDefaultShortcuts(sourcePlatform);
  const targetDefaults = buildDefaultShortcuts(targetPlatform);
  const shortcuts = { ...settings.shortcuts };

  for (const command of Object.keys(targetDefaults) as ShortcutCommandId[]) {
    const currentBinding = normalizeShortcutBinding(shortcuts[command] ?? "");
    const sourceBinding = normalizeShortcutBinding(sourceDefaults[command]);
    if (!currentBinding || currentBinding === sourceBinding) {
      shortcuts[command] = targetDefaults[command];
    }
  }

  return {
    ...settings,
    settingsVersion: CURRENT_SETTINGS_VERSION,
    shortcutDefaultsPlatform: targetPlatform,
    shortcuts: sanitizeShortcuts(shortcuts)
  };
}

function migrateSettingsAfterSanitize(
  settings: KmuxSettings,
  sourceSettingsVersion: number
): KmuxSettings {
  const textFontFamily =
    settings.terminalTypography.preferredTextFontFamily.trim();
  if (
    sourceSettingsVersion < TERMINAL_TYPOGRAPHY_DEFAULT_RESET_SETTINGS_VERSION
  ) {
    return {
      ...settings,
      terminalTypography: {
        ...settings.terminalTypography,
        preferredTextFontFamily: DEFAULT_TERMINAL_TEXT_FONT_FAMILY,
        fontSize: DEFAULT_TERMINAL_FONT_SIZE,
        lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT
      }
    };
  }

  if (
    sourceSettingsVersion >= CURRENT_SETTINGS_VERSION &&
    textFontFamily !== PREVIOUS_BUNDLED_TERMINAL_TEXT_FONT_FAMILY
  ) {
    return settings;
  }

  if (
    textFontFamily !== LEGACY_TERMINAL_TEXT_FONT_FAMILY &&
    textFontFamily !== PREVIOUS_BUNDLED_TERMINAL_TEXT_FONT_FAMILY
  ) {
    return settings;
  }

  return {
    ...settings,
    terminalTypography: {
      ...settings.terminalTypography,
      preferredTextFontFamily: DEFAULT_TERMINAL_TEXT_FONT_FAMILY
    }
  };
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
        name: "new workspace",
        location: workspaceLocation({ kind: "local" }, defaultHomeDirectory()),
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
        title: "new workspace",
        titleLocked: false,
        unreadCount: 0,
        attention: false,
        content: { kind: "terminal", sessionId }
      }
    },
    sessions: {
      [sessionId]: {
        id: sessionId,
        surfaceId,
        launch: {
          cwd: defaultLocalCwd(),
          shell: shellPath
        },
        authToken: makeId("auth"),
        runtimeStatus: pendingSessionRuntimeStatus(),
        shellInputReady: false,
        runtimeMetadata: {
          cwd: defaultLocalCwd(),
          ports: []
        }
      }
    },
    remoteOperations: {},
    remoteEventReceipts: {},
    notifications: [],
    settings: createDefaultSettings("kmuxOnly", shellPath),
    activeWindowId: windowId
  };

  return state;
}

export type AppStateDto = Record<string, unknown>;

/** Encodes opaque domain values into the versioned persistence/IPC schema. */
export function encodeAppStateDto(snapshot: AppState): AppStateDto {
  return {
    windows: structuredClone(snapshot.windows),
    workspaces: Object.fromEntries(
      Object.entries(snapshot.workspaces).map(([id, workspace]) => [
        id,
        {
          ...workspace,
          location: encodeWorkspaceLocationDto(workspace.location),
          remoteResourceRevision:
            workspace.remoteResourceRevision === undefined
              ? undefined
              : formatUint64Decimal(workspace.remoteResourceRevision),
          worktree: workspace.worktree
            ? encodePersistedWorkspaceWorktree(workspace.worktree)
            : undefined,
          detectedWorktree: workspace.detectedWorktree
            ? encodePersistedDetectedWorkspaceWorktree(
                workspace.detectedWorktree
              )
            : undefined,
          dismissedWorktreePaths:
            workspace.dismissedWorktreePaths?.map(encodeLocatedPathDto),
          nodeMap: structuredClone(workspace.nodeMap),
          statusEntries: structuredClone(workspace.statusEntries),
          logs: structuredClone(workspace.logs)
        }
      ])
    ),
    panes: structuredClone(snapshot.panes),
    surfaces: Object.fromEntries(
      Object.entries(snapshot.surfaces).map(([id, surface]) => [
        id,
        {
          id: surface.id,
          paneId: surface.paneId,
          title: surface.title,
          titleLocked: surface.titleLocked,
          unreadCount: surface.unreadCount,
          attention: surface.attention,
          content: surfaceCoreModule(surface.content.kind).encodeContent(
            surface.content
          )
        }
      ])
    ),
    sessions: Object.fromEntries(
      Object.entries(snapshot.sessions).map(([id, session]) => [
        id,
        {
          ...session,
          launch: {
            ...session.launch,
            cwd: encodeLocatedPathDto(session.launch.cwd)
          },
          agentSessionRef: session.agentSessionRef
            ? {
                ...session.agentSessionRef,
                cwd: session.agentSessionRef.cwd
                  ? encodeLocatedPathDto(session.agentSessionRef.cwd)
                  : undefined
              }
            : undefined,
          runtimeMetadata: {
            ...session.runtimeMetadata,
            cwd: encodeLocatedPathDto(session.runtimeMetadata.cwd),
            gitRepository: session.runtimeMetadata.gitRepository
              ? encodePersistedWorkspaceGitRepository(
                  session.runtimeMetadata.gitRepository
                )
              : undefined,
            ports: [...session.runtimeMetadata.ports]
          },
          remoteRuntime: session.remoteRuntime
            ? {
                keeperGeneration: session.remoteRuntime.keeperGeneration,
                remoteResourceRevision: formatUint64Decimal(
                  session.remoteRuntime.remoteResourceRevision
                ),
                ...(session.remoteRuntime.lastAcknowledgedMutationSequence ===
                undefined
                  ? {}
                  : {
                      lastAcknowledgedMutationSequence: formatUint64Decimal(
                        session.remoteRuntime.lastAcknowledgedMutationSequence
                      )
                    }),
                ...(session.remoteRuntime.storageStatus === undefined
                  ? {}
                  : {
                      storageStatus: {
                        ...session.remoteRuntime.storageStatus,
                        journalAdmitted: formatUint64Decimal(
                          session.remoteRuntime.storageStatus.journalAdmitted
                        ),
                        journalSynced: formatUint64Decimal(
                          session.remoteRuntime.storageStatus.journalSynced
                        )
                      }
                    })
              }
            : undefined
        }
      ])
    ),
    remoteOperations: Object.fromEntries(
      Object.entries(snapshot.remoteOperations).map(([id, operation]) => [
        id,
        {
          ...encodeRemoteOperationProjectionDto(operation)
        }
      ])
    ),
    remoteEventReceipts: Object.fromEntries(
      Object.entries(snapshot.remoteEventReceipts).map(
        ([targetId, receipt]) => [
          targetId,
          {
            throughSequence: formatUint64Decimal(receipt.throughSequence),
            recentEventIds: [...receipt.recentEventIds]
          }
        ]
      )
    ),
    notifications: structuredClone(snapshot.notifications),
    settings: structuredClone(snapshot.settings),
    activeWindowId: snapshot.activeWindowId
  };
}

export interface DecodeAppStateOptions {
  snapshotVersion?: 1 | 2 | 3;
}

/** Decodes the current DTO and explicitly supported legacy snapshot schemas. */
export function decodeAppStateDto(
  value: unknown,
  options: DecodeAppStateOptions = {}
): AppState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("app state snapshot must be an object");
  }
  const cloned = structuredClone(value) as AppState;
  return sanitizeState(cloned, {
    allowLegacySurfaceFormat:
      options.snapshotVersion === 1 || options.snapshotVersion === 2
  });
}

export function cloneState(snapshot: AppState): AppState {
  return decodeAppStateDto(encodeAppStateDto(snapshot));
}

export interface AppMutationSummary {
  window?: boolean;
  workspaceRows?: boolean;
  activeWorkspacePaneTree?: boolean;
  activeWorkspaceActivity?: boolean;
  notifications?: boolean;
  settings?: boolean;
  terminalTypography?: boolean;
}

export interface ApplyActionResult {
  effects: AppEffect[];
  mutation: AppMutationSummary;
}

export function applyActionWithSummary(
  state: AppState,
  action: AppAction
): ApplyActionResult {
  const effects = applyActionEffects(state, action);
  return {
    effects,
    mutation: mutationSummaryForAction(action)
  };
}

export function applyAction(state: AppState, action: AppAction): AppEffect[] {
  return applyActionWithSummary(state, action).effects;
}

function applyActionEffects(state: AppState, action: AppAction): AppEffect[] {
  switch (action.type) {
    case "state.restore":
      {
        const restored = cloneState(action.snapshot);
        resetRestoredShellInputReadiness(restored);
        Object.assign(state, restored);
      }
      return [{ type: "persist" }];
    case "workspace.create":
      return createWorkspace(
        state,
        action.name ?? "new workspace",
        action.cwd,
        action.target,
        !!action.name,
        action.launch,
        action.agentSessionRef
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
    case "workspace.worktree.convert":
      return convertWorkspaceToWorktree(state, action);
    case "workspace.worktree.detected":
      return setDetectedWorkspaceWorktree(state, action);
    case "workspace.worktree.launchSurfaceCreated":
      return markWorktreeLaunchSurfaceCreated(state, action);
    case "workspace.worktree.dismissDetected":
      return dismissDetectedWorkspaceWorktree(state, action);
    case "workspace.worktree.clearDetected":
      return clearDetectedWorkspaceWorktree(state, action.workspaceId);
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
    case "surface.open":
      return openSurfaceAtPlacement(state, action);
    case "surface.create":
      return createSurface(
        state,
        action.paneId,
        action.title,
        action.cwd,
        action.launch
      );
    case "surface.focus":
      return focusSurface(state, action.surfaceId);
    case "surface.moveToSplit":
      return moveSurfaceToSplit(
        state,
        action.surfaceId,
        action.targetPaneId,
        action.direction
      );
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
    case "surface.restartSession":
      return restartSurfaceSession(state, action.surfaceId);
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
    case "remote.event.apply":
      return applyRemoteEvent(state, action);
    case "agent.attention.clear":
      return clearSurfaceAgentAttention(state, action.surfaceId);
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
        session.runtimeStatus = {
          processState: "running",
          observationState: "observed",
          attachmentState: "attached"
        };
        session.shellInputReady = action.shellInputReady;
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
                cwd: session.runtimeMetadata.cwd
              },
              { type: "persist" }
            ]
          : [{ type: "persist" }];
      }
      return [];
    case "session.shellReady":
      if (state.sessions[action.sessionId]) {
        state.sessions[action.sessionId].shellInputReady = true;
        return [{ type: "persist" }];
      }
      return [];
    case "session.exited":
      if (state.sessions[action.sessionId]) {
        state.sessions[action.sessionId].runtimeStatus = {
          ...state.sessions[action.sessionId].runtimeStatus,
          processState: "exited",
          observationState: "observed"
        };
        state.sessions[action.sessionId].shellInputReady = false;
        state.sessions[action.sessionId].exitCode = action.exitCode;
      }
      return [{ type: "persist" }];
    default:
      return [];
  }
}

function resetRestoredShellInputReadiness(state: AppState): void {
  for (const session of Object.values(state.sessions)) {
    if (session.runtimeStatus.processState !== "exited") {
      session.shellInputReady = false;
    }
  }
}

function mutationSummaryForAction(action: AppAction): AppMutationSummary {
  switch (action.type) {
    case "workspace.sidebar.toggle":
    case "workspace.sidebar.setWidth":
      return { window: true };
    case "workspace.create":
    case "workspace.select":
    case "workspace.selectRelative":
    case "workspace.selectIndex":
    case "workspace.rename":
    case "workspace.worktree.convert":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "workspace.close":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "workspace.closeOthers":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "workspace.pin.toggle":
    case "workspace.move":
      return { workspaceRows: true };
    case "workspace.worktree.launchSurfaceCreated":
      return {};
    case "workspace.worktree.detected":
    case "workspace.worktree.dismissDetected":
    case "workspace.worktree.clearDetected":
      return { workspaceRows: true };
    case "pane.focus":
    case "pane.focusDirection":
    case "surface.focus":
    case "surface.focusRelative":
    case "surface.focusIndex":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "notification.create":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "agent.event":
    case "remote.event.apply":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "agent.attention.clear":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "notification.clear":
    case "notification.jumpLatestUnread":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "terminal.bell":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "surface.moveToSplit":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspacePaneTree: true,
        notifications: true
      };
    case "pane.split":
    case "pane.resize":
    case "pane.setSplitRatio":
    case "pane.close":
    case "surface.create":
    case "surface.open":
    case "surface.rename":
    case "surface.close":
    case "surface.closeOthers":
    case "surface.restartSession":
    case "surface.metadata":
      return {
        workspaceRows: true,
        activeWorkspacePaneTree: true
      };
    case "sidebar.setStatus":
    case "sidebar.clearStatus":
    case "sidebar.setProgress":
    case "sidebar.clearProgress":
    case "sidebar.log":
    case "sidebar.clearLog":
      return {
        workspaceRows: true,
        activeWorkspaceActivity: true
      };
    case "session.started":
    case "session.shellReady":
    case "session.exited":
      return {
        activeWorkspacePaneTree: true
      };
    case "settings.update":
      return { settings: true };
    case "state.restore":
      return {
        window: true,
        workspaceRows: true,
        activeWorkspaceActivity: true,
        activeWorkspacePaneTree: true,
        notifications: true,
        settings: true,
        terminalTypography: true
      };
    default:
      return assertNeverMutationAction(action);
  }
}

function assertNeverMutationAction(action: never): AppMutationSummary {
  void action;
  return {};
}

function createWorkspace(
  state: AppState,
  name: string,
  cwd?: string,
  requestedTarget: WorkspaceTarget = { kind: "local" },
  nameLocked = false,
  launch?: SessionLaunchConfigDto,
  agentSessionRef?: ExternalAgentSessionRef
): AppEffect[] {
  const window = state.windows[state.activeWindowId];
  const workspaceCwd = cwd ?? launch?.cwd ?? defaultHomeDirectory();
  const target: WorkspaceTarget =
    requestedTarget.kind === "local"
      ? { kind: "local" }
      : { kind: "ssh", targetId: requestedTarget.targetId };
  const locatedWorkspaceCwd = locatedPathForTarget(target, workspaceCwd);
  const workspaceId = makeId("workspace");
  const paneId = makeId("pane");
  const nodeId = makeId("node");
  const workspaceName =
    name.trim() || `workspace ${window.workspaceOrder.length + 1}`;
  const explicitLaunchTitle = launch?.title?.trim();

  state.workspaces[workspaceId] = {
    id: workspaceId,
    windowId: window.id,
    name: workspaceName,
    nameLocked,
    location: workspaceLocation(target, workspaceCwd),
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
    surfaceIds: [],
    activeSurfaceId: ""
  };
  window.workspaceOrder.push(workspaceId);
  window.activeWorkspaceId = workspaceId;

  return openSurfaceAtPlacement(state, {
    type: "surface.open",
    workspaceId,
    init: {
      kind: "terminal",
      title: explicitLaunchTitle,
      cwd: encodeLocatedPathDto(locatedWorkspaceCwd).path,
      launch: {
        ...launch,
        ...(explicitLaunchTitle ? { title: explicitLaunchTitle } : {}),
        cwd: launch?.cwd ?? workspaceCwd
      },
      agentSessionRef
    },
    placement: { kind: "tab", paneId }
  });
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

function convertWorkspaceToWorktree(
  state: AppState,
  action: Extract<AppAction, { type: "workspace.worktree.convert" }>
): AppEffect[] {
  const workspace = state.workspaces[action.workspaceId];
  if (!workspace) {
    return [];
  }

  const window =
    state.windows[workspace.windowId] ?? state.windows[state.activeWindowId];
  const previousWorktree = workspace.worktree;
  const nextWorktree = decodeWorkspaceWorktree(
    action.worktree,
    workspace.location.target
  );
  if (
    previousWorktree?.launchSurfaceCreated === true &&
    encodedLocatedPath(previousWorktree.path) ===
      encodedLocatedPath(nextWorktree.path)
  ) {
    nextWorktree.launchSurfaceCreated = true;
  }
  workspace.worktree = nextWorktree;
  workspace.detectedWorktree = undefined;
  workspace.name = action.worktree.name;
  workspace.nameLocked = true;
  workspace.cwdSummary = action.worktree.path;
  workspace.branch = action.worktree.branch;
  if (action.focus !== false && window) {
    window.activeWorkspaceId = workspace.id;
  }

  if (!action.createSurface) {
    return [{ type: "persist" }];
  }

  const effects = createSurface(
    state,
    workspace.activePaneId,
    action.worktree.name,
    action.worktree.path,
    {
      cwd: action.worktree.path,
      title: action.worktree.name
    }
  );
  return effects.length > 0 ? effects : [{ type: "persist" }];
}

function markWorktreeLaunchSurfaceCreated(
  state: AppState,
  action: Extract<
    AppAction,
    { type: "workspace.worktree.launchSurfaceCreated" }
  >
): AppEffect[] {
  const worktree = state.workspaces[action.workspaceId]?.worktree;
  if (!worktree || encodedLocatedPath(worktree.path) !== action.path) {
    return [];
  }
  if (worktree.launchSurfaceCreated === true) {
    return [];
  }
  worktree.launchSurfaceCreated = true;
  return [{ type: "persist" }];
}

function setDetectedWorkspaceWorktree(
  state: AppState,
  action: Extract<AppAction, { type: "workspace.worktree.detected" }>
): AppEffect[] {
  const workspace = state.workspaces[action.workspaceId];
  if (!workspace || workspace.worktree) {
    return [];
  }
  if (
    workspace.dismissedWorktreePaths?.some((path) =>
      sameLocatedPath(
        path,
        locatedPathForTarget(
          workspace.location.target,
          action.detectedWorktree.path
        )
      )
    )
  ) {
    return [];
  }
  if (
    workspace.detectedWorktree &&
    sameLocatedPath(
      workspace.detectedWorktree.path,
      locatedPathForTarget(
        workspace.location.target,
        action.detectedWorktree.path
      )
    ) &&
    workspace.detectedWorktree.branch === action.detectedWorktree.branch &&
    workspace.detectedWorktree.baseRef === action.detectedWorktree.baseRef
  ) {
    return [];
  }
  workspace.detectedWorktree = decodeDetectedWorkspaceWorktree(
    action.detectedWorktree,
    workspace.location.target
  );
  return [{ type: "persist" }];
}

function dismissDetectedWorkspaceWorktree(
  state: AppState,
  action: Extract<AppAction, { type: "workspace.worktree.dismissDetected" }>
): AppEffect[] {
  const workspace = state.workspaces[action.workspaceId];
  if (!workspace) {
    return [];
  }
  const dismissedPath = locatedPathForTarget(
    workspace.location.target,
    action.path
  );
  const dismissed = (workspace.dismissedWorktreePaths ?? []).filter(
    (path) => !sameLocatedPath(path, dismissedPath)
  );
  workspace.dismissedWorktreePaths = [...dismissed, dismissedPath].slice(-32);
  if (
    workspace.detectedWorktree &&
    sameLocatedPath(workspace.detectedWorktree.path, dismissedPath)
  ) {
    workspace.detectedWorktree = undefined;
  }
  return [{ type: "persist" }];
}

function clearDetectedWorkspaceWorktree(
  state: AppState,
  workspaceId: Id
): AppEffect[] {
  const workspace = state.workspaces[workspaceId];
  if (!workspace?.detectedWorktree) {
    return [];
  }
  workspace.detectedWorktree = undefined;
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
  const closeEffects: AppEffect[] = [];

  for (const paneId of paneIds) {
    for (const surfaceId of state.panes[paneId].surfaceIds) {
      const surface = state.surfaces[surfaceId];
      if (!surface) continue;
      purgeSurfaceReferences(state, surfaceId);
      closeEffects.push(...closeSurfaceResource(state, surface));
      delete state.surfaces[surfaceId];
    }
    delete state.panes[paneId];
  }
  delete state.workspaces[workspace.id];
  window.workspaceOrder = window.workspaceOrder.filter(
    (id) => id !== workspaceId
  );

  return closeEffects;
}

function splitPane(
  state: AppState,
  paneId: Id,
  direction: SplitDirection
): AppEffect[] {
  const pane = state.panes[paneId];
  return pane
    ? openSurfaceAtPlacement(state, {
        type: "surface.open",
        workspaceId: pane.workspaceId,
        init: {
          kind: "terminal",
          cwd: encodeLocatedPathDto(defaultNewSurfaceCwd(state, paneId)).path
        },
        placement: { kind: "split", paneId, direction }
      })
    : [];
}

export function createSplitPaneLeaf(
  state: AppState,
  paneId: Id,
  direction: SplitDirection
): { newPaneId: Id } {
  const pane = state.panes[paneId];
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  const targetLeafId = workspace
    ? findLeafIdForPane(workspace, paneId)
    : undefined;
  if (!pane || !workspace || !targetLeafId) {
    throw new Error("Cannot split an unknown pane leaf");
  }
  const newPaneId = makeId("pane");
  insertPaneLeafSplit(workspace, targetLeafId, newPaneId, direction);
  state.panes[newPaneId] = {
    id: newPaneId,
    workspaceId: workspace.id,
    surfaceIds: [],
    activeSurfaceId: ""
  };
  return { newPaneId };
}

export function openSurfaceAtPlacement(
  state: AppState,
  action: SurfaceOpenAction
): AppEffect[] {
  const workspace = state.workspaces[action.workspaceId];
  const sourcePane = state.panes[action.placement.paneId];
  if (!workspace || !sourcePane || sourcePane.workspaceId !== workspace.id) {
    return [];
  }
  const targetPaneId =
    action.placement.kind === "tab"
      ? sourcePane.id
      : createSplitPaneLeaf(state, sourcePane.id, action.placement.direction)
          .newPaneId;
  const targetPane = state.panes[targetPaneId];
  const surfaceId = makeId("surface");
  const module = surfaceCoreModule(action.init.kind);
  const created = module.create(
    {
      state,
      workspaceId: workspace.id,
      paneId: targetPane.id,
      surfaceId,
      createResourceId: () => makeId("session")
    },
    action.init
  );
  state.surfaces[surfaceId] = created.surface;
  targetPane.surfaceIds.push(surfaceId);
  targetPane.activeSurfaceId = surfaceId;
  workspace.activePaneId = targetPane.id;
  return [...created.effects, { type: "persist" }];
}

function moveSurfaceToSplit(
  state: AppState,
  surfaceId: Id,
  targetPaneId: Id,
  direction: SplitDirection
): AppEffect[] {
  const surface = state.surfaces[surfaceId];
  const targetPane = state.panes[targetPaneId];
  if (!surface || !targetPane) {
    return [];
  }
  const sourcePane = state.panes[surface.paneId];
  if (!sourcePane || sourcePane.workspaceId !== targetPane.workspaceId) {
    return [];
  }
  if (!sourcePane.surfaceIds.includes(surfaceId)) {
    return [];
  }
  if (sourcePane.id === targetPane.id && sourcePane.surfaceIds.length === 1) {
    return [];
  }

  const workspace = state.workspaces[targetPane.workspaceId];
  const sourceLeafId = findLeafIdForPane(workspace, sourcePane.id);
  if (!sourceLeafId) {
    return [];
  }

  const { newPaneId } = createSplitPaneLeaf(state, targetPane.id, direction);

  removeSurfaceFromPane(sourcePane, surfaceId);
  if (sourcePane.surfaceIds.length === 0) {
    collapsePaneLeaf(workspace, sourceLeafId);
    delete state.panes[sourcePane.id];
  }

  state.panes[newPaneId].surfaceIds = [surfaceId];
  state.panes[newPaneId].activeSurfaceId = surfaceId;
  surface.paneId = newPaneId;
  workspace.activePaneId = newPaneId;
  markSurfaceNotificationsRead(state, workspace.id, surfaceId);

  return [{ type: "persist" }];
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
    markNotificationsRead(
      state,
      pane.workspaceId,
      paneId,
      pane.activeSurfaceId
    );
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
    purgeSurfaceReferences(state, surfaceId);
    closeEffects.push(...closeSurfaceResource(state, surface));
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
  cwd?: string,
  launch?: SessionLaunchConfigDto
): AppEffect[] {
  const pane = state.panes[paneId];
  return pane
    ? openSurfaceAtPlacement(state, {
        type: "surface.open",
        workspaceId: pane.workspaceId,
        init: { kind: "terminal", title, cwd, launch },
        placement: { kind: "tab", paneId }
      })
    : [];
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
  purgeSurfaceReferences(state, surfaceId);
  const closeEffects = closeSurfaceResource(state, surface);
  delete state.surfaces[surfaceId];
  return [...closeEffects, { type: "persist" }];
}

function closeSurfaceResource(
  state: AppState,
  surface: SurfaceState
): AppEffect[] {
  return surfaceCoreModule(surface.content.kind).close(state, surface);
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

function restartSurfaceSession(state: AppState, surfaceId: Id): AppEffect[] {
  const surface = state.surfaces[surfaceId];
  if (!surface || surface.content.kind !== "terminal") {
    return [];
  }
  const pane = state.panes[surface.paneId];
  if (!pane) {
    return [];
  }
  const workspace = state.workspaces[pane.workspaceId];
  const oldSession = terminalSessionForSurface(state, surfaceId);
  if (!oldSession || oldSession.runtimeStatus.processState === "pending") {
    return [];
  }

  const newSessionId = makeId("session");
  const defaultShell =
    workspace.location.target.kind === "local"
      ? state.settings.shell || process.env.SHELL
      : undefined;
  const launch = sanitizeStoredSessionLaunchConfig(
    {
      ...oldSession.launch,
      cwd: oldSession.launch.cwd
    },
    defaultShell
  );

  delete state.sessions[oldSession.id];
  state.sessions[newSessionId] = {
    id: newSessionId,
    surfaceId,
    launch,
    authToken: makeId("auth"),
    runtimeStatus: pendingSessionRuntimeStatus(),
    shellInputReady: false,
    runtimeMetadata: {
      ...oldSession.runtimeMetadata,
      ...(oldSession.runtimeMetadata.gitRepository
        ? { gitRepository: { ...oldSession.runtimeMetadata.gitRepository } }
        : {}),
      ports: [...oldSession.runtimeMetadata.ports]
    }
  };
  surface.content = { kind: "terminal", sessionId: newSessionId };
  surface.attention = false;
  surface.unreadCount = 0;
  pane.activeSurfaceId = surfaceId;
  workspace.activePaneId = pane.id;

  return [
    { type: "session.close", sessionId: oldSession.id },
    buildSessionSpawnEffect(state, workspace.id, surfaceId, newSessionId),
    { type: "persist" }
  ];
}

function updateSurfaceMetadata(
  state: AppState,
  action: Extract<AppAction, { type: "surface.metadata" }>
): AppEffect[] {
  const surface = state.surfaces[action.surfaceId];
  const session = terminalSessionForSurface(state, action.surfaceId);
  if (!surface || !session) {
    return [];
  }
  const workspaceId = state.panes[surface.paneId].workspaceId;
  const workspace = state.workspaces[workspaceId];
  let shouldRefreshDerivedMetadata = false;

  if (action.cwd !== undefined) {
    const nextCwd = locatedPathForTarget(workspace.location.target, action.cwd);
    if (!sameLocatedPath(nextCwd, session.runtimeMetadata.cwd)) {
      session.runtimeMetadata.cwd = nextCwd;
      shouldRefreshDerivedMetadata = true;
    }
  }
  if (action.title !== undefined) {
    if (!surface.titleLocked) {
      surface.title = action.title;
    }
  }
  if ("branch" in action) {
    session.runtimeMetadata.branch = action.branch ?? undefined;
  }
  if ("gitRepository" in action) {
    session.runtimeMetadata.gitRepository = action.gitRepository
      ? decodeWorkspaceGitRepository(
          action.gitRepository,
          workspace.location.target
        )
      : undefined;
  }
  if (action.ports !== undefined) {
    session.runtimeMetadata.ports = action.ports.slice(0, 3);
  }
  if (action.attention !== undefined) {
    surface.attention = action.attention;
  }
  if (action.unreadDelta) {
    surface.unreadCount = Math.max(0, surface.unreadCount + action.unreadDelta);
  }
  if (shouldRefreshDerivedMetadata) {
    return [
      {
        type: "metadata.refresh",
        workspaceId,
        surfaceId: surface.id,
        pid: session?.pid,
        cwd: session.runtimeMetadata.cwd
      },
      { type: "persist" }
    ];
  }
  return [{ type: "persist" }];
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
  const agentSessionRefChanged = backfillAgentSessionRef(state, target, action);

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
      return withPersistIfChanged(
        statusEffects.length > 0 ||
          clearedNotifications ||
          clearedCompletionNotification ||
          clearedGenericReminders
          ? [{ type: "persist" }]
          : [],
        agentSessionRefChanged
      );
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
    return withPersistIfChanged(
      state.settings.notificationSound
        ? [{ type: "bell.sound" }, ...notificationEffects]
        : notificationEffects,
      agentSessionRefChanged
    );
  }

  if (action.event === "idle") {
    return withPersistIfChanged(
      clearAgentAttentionUi(
        state,
        target.workspace,
        agentName,
        statusScopeId,
        target.surface?.id
      ),
      agentSessionRefChanged
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
      return withPersistIfChanged(clearEffects, agentSessionRefChanged);
    }
    return withPersistIfChanged(
      createNotification(state, {
        type: "notification.create",
        workspaceId: target.workspace.id,
        paneId: target.pane?.id,
        surfaceId: target.surface?.id,
        title: `${displayName} finished`,
        message: normalizeStatusText(action.message) || "Finished",
        source: "agent",
        kind: "turn_complete",
        agent: agentName
      }),
      agentSessionRefChanged
    );
  }

  if (action.event === "session_end") {
    return withPersistIfChanged(
      clearAgentAttentionUi(
        state,
        target.workspace,
        agentName,
        statusScopeId,
        target.surface?.id
      ),
      agentSessionRefChanged
    );
  }

  return withPersistIfChanged([], agentSessionRefChanged);
}

function withPersistIfChanged(
  effects: AppEffect[],
  changed: boolean
): AppEffect[] {
  if (!changed || effects.some((effect) => effect.type === "persist")) {
    return effects;
  }
  return [...effects, { type: "persist" }];
}

function backfillAgentSessionRef(
  state: AppState,
  target: AgentTarget,
  action: Extract<AppAction, { type: "agent.event" }>
): boolean {
  if (
    action.details?.uiOnly === true ||
    (action.event !== "session_start" && action.event !== "needs_input")
  ) {
    return false;
  }
  const surface = target.surface;
  const session = surface
    ? terminalSessionForSurface(state, surface.id)
    : undefined;
  const vendor = normalizeExternalAgentSessionVendor(action.agent);
  const vendorSessionId =
    vendor === "antigravity"
      ? normalizeOptionalText(
          typeof action.details?.conversationId === "string"
            ? action.details.conversationId
            : undefined,
          512
        )
      : normalizeOptionalText(action.sessionId, 512);
  if (
    !session ||
    !target.workspace ||
    !vendor ||
    !vendorSessionId ||
    vendorSessionId === session.id ||
    vendorSessionId === surface?.id
  ) {
    return false;
  }

  const agentSessionRef = {
    vendor,
    id: vendorSessionId,
    targetId:
      target.workspace.location.target.kind === "ssh"
        ? target.workspace.location.target.targetId
        : "local",
    cwd:
      (surface
        ? terminalRuntimeMetadataForSurface(state, surface.id)?.cwd
        : undefined) ??
      locatedPathForTarget(
        target.workspace.location.target,
        encodeWorkspaceDefaultCwd(target.workspace.location)
      ),
    externalKey: externalAgentSessionKey(vendor, vendorSessionId)
  } satisfies AgentSessionRef;
  if (
    session.agentSessionRef?.vendor === agentSessionRef.vendor &&
    session.agentSessionRef.externalKey === agentSessionRef.externalKey &&
    session.agentSessionRef.id === agentSessionRef.id &&
    session.agentSessionRef.targetId === agentSessionRef.targetId &&
    sameLocatedPath(session.agentSessionRef.cwd, agentSessionRef.cwd)
  ) {
    return false;
  }
  session.agentSessionRef = agentSessionRef;
  return true;
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
  text: unknown,
  maxLength: number
): string | undefined {
  const normalized =
    typeof text === "string" ? text.trim().slice(0, maxLength) : undefined;
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
  if (agent === "antigravity") {
    return "Antigravity";
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

function clearSurfaceAgentAttention(
  state: AppState,
  surfaceId: Id
): AppEffect[] {
  let changed = false;

  for (const workspace of Object.values(state.workspaces)) {
    workspace.statusEntries ??= {};
    for (const [key, entry] of Object.entries(workspace.statusEntries)) {
      if (
        entry.surfaceId === surfaceId &&
        entry.text === "needs input" &&
        key.startsWith("agent:")
      ) {
        delete workspace.statusEntries[key];
        changed = true;
      }
    }
  }

  const beforeCount = state.notifications.length;
  state.notifications = state.notifications.filter(
    (notification) =>
      !(
        notification.surfaceId === surfaceId &&
        notification.source === "agent" &&
        notification.kind === "needs_input"
      )
  );
  if (state.notifications.length !== beforeCount) {
    changed = true;
    syncSurfaceNotificationState(state, surfaceId);
  }

  return changed ? [{ type: "persist" }] : [];
}

function purgeSurfaceReferences(state: AppState, surfaceId: Id): boolean {
  let changed = false;

  for (const workspace of Object.values(state.workspaces)) {
    workspace.statusEntries ??= {};
    for (const [key, entry] of Object.entries(workspace.statusEntries)) {
      if (entry.surfaceId === surfaceId) {
        delete workspace.statusEntries[key];
        changed = true;
      }
    }
  }

  const beforeCount = state.notifications.length;
  state.notifications = state.notifications.filter(
    (notification) => notification.surfaceId !== surfaceId
  );
  if (state.notifications.length !== beforeCount) {
    changed = true;
    syncSurfaceNotificationState(state, surfaceId);
  }

  return changed;
}

const MAX_RECENT_REMOTE_EVENT_IDS = 512;

function applyRemoteEvent(
  state: AppState,
  action: Extract<AppAction, { type: "remote.event.apply" }>
): AppEffect[] {
  const receipt = state.remoteEventReceipts[action.targetId];
  if (receipt && action.sequence <= receipt.throughSequence) {
    return [];
  }
  if (receipt?.recentEventIds.includes(action.eventId)) {
    state.remoteEventReceipts[action.targetId] = {
      throughSequence: action.sequence,
      recentEventIds: receipt.recentEventIds
    };
    return [{ type: "persist" }];
  }
  const effects = action.productAction
    ? applyActionEffects(state, action.productAction)
    : [];
  const recentEventIds = [
    ...(receipt?.recentEventIds ?? []),
    action.eventId
  ].slice(-MAX_RECENT_REMOTE_EVENT_IDS);
  state.remoteEventReceipts[action.targetId] = {
    throughSequence: action.sequence,
    recentEventIds
  };
  return effects.some((effect) => effect.type === "persist")
    ? effects
    : [...effects, { type: "persist" }];
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
    | "workspaceId"
    | "surfaceId"
    | "title"
    | "message"
    | "source"
    | "kind"
    | "agent"
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

function markSurfaceNotificationsRead(
  state: AppState,
  workspaceId: Id,
  surfaceId: Id
): void {
  state.notifications = state.notifications.filter(
    (notification) =>
      !(
        notification.workspaceId === workspaceId &&
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

function findLeafIdForPane(
  workspace: WorkspaceState,
  paneId: Id
): Id | undefined {
  return Object.values(workspace.nodeMap).find(
    (node): node is Extract<PaneTreeNode, { kind: "leaf" }> =>
      node.kind === "leaf" && node.paneId === paneId
  )?.id;
}

function insertPaneLeafSplit(
  workspace: WorkspaceState,
  targetLeafId: Id,
  paneId: Id,
  direction: SplitDirection
): void {
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
    paneId
  };
}

function removeSurfaceFromPane(pane: PaneState, surfaceId: Id): void {
  const surfaceIndex = pane.surfaceIds.indexOf(surfaceId);
  if (surfaceIndex === -1) {
    return;
  }
  pane.surfaceIds = pane.surfaceIds.filter((id) => id !== surfaceId);
  if (pane.activeSurfaceId !== surfaceId || pane.surfaceIds.length === 0) {
    return;
  }
  const nextActiveIndex = surfaceIndex > 0 ? surfaceIndex - 1 : 0;
  pane.activeSurfaceId = pane.surfaceIds[nextActiveIndex] ?? pane.surfaceIds[0];
}

function collapsePaneLeaf(workspace: WorkspaceState, leafId: Id): void {
  const parentEntry = findParentSplit(workspace, leafId);
  if (!parentEntry) {
    delete workspace.nodeMap[leafId];
    return;
  }
  const parent = workspace.nodeMap[parentEntry.parentId];
  if (parent?.kind !== "split") {
    return;
  }
  const siblingId = parent.first === leafId ? parent.second : parent.first;
  replaceNodeReference(workspace, parent.id, siblingId);
  delete workspace.nodeMap[parent.id];
  delete workspace.nodeMap[leafId];
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

export function terminalSessionForSurface(
  state: AppState,
  surfaceId: Id
): SessionState | undefined {
  const surface = state.surfaces[surfaceId];
  if (!surface || surface.content.kind !== "terminal") {
    return undefined;
  }
  const session = state.sessions[surface.content.sessionId];
  return session?.surfaceId === surface.id ? session : undefined;
}

export function requireTerminalSurfaceContent(
  surface: SurfaceState
): SurfaceContentOf<"terminal"> {
  if (surface.content.kind !== "terminal") {
    throw new TypeError(`Surface ${surface.id} is not a Terminal Surface`);
  }
  return surface.content;
}

export function terminalRuntimeMetadataForSurface(
  state: AppState,
  surfaceId: Id
): TerminalRuntimeMetadata | undefined {
  return terminalSessionForSurface(state, surfaceId)?.runtimeMetadata;
}

export function defaultNewSurfaceCwd(
  state: AppState,
  paneId: Id,
  explicitCwd?: string
): LocatedPath {
  const pane = state.panes[paneId];
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  if (!workspace) {
    return defaultLocalCwd();
  }
  if (explicitCwd !== undefined) {
    return locatedPathForTarget(workspace.location.target, explicitCwd);
  }
  return (
    workspace.worktree?.path ??
    (activeSurface(state, paneId)
      ? terminalRuntimeMetadataForSurface(
          state,
          activeSurface(state, paneId)!.id
        )?.cwd
      : undefined) ??
    locatedPathForTarget(
      workspace.location.target,
      encodeWorkspaceDefaultCwd(workspace.location)
    )
  );
}

export function buildSessionSpawnEffect(
  state: AppState,
  workspaceId: Id,
  surfaceId: Id,
  sessionId: Id
): SessionSpawnEffect {
  const session = state.sessions[sessionId];
  const paneId = state.surfaces[surfaceId]?.paneId;
  return {
    type: "session.spawn",
    sessionId,
    surfaceId,
    workspaceId,
    launch: session.launch,
    initialSize: {
      cols: 120,
      rows: 30
    },
    sessionEnv: {
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
  return {
    ...buildShellWindowChromeVm(state),
    workspaceRows: buildWorkspaceRowsVm(state),
    activeWorkspace: buildActiveWorkspaceVm(state),
    notifications: buildNotificationsVm(state),
    settings: buildShellSettingsVm(state),
    terminalTypography: createPendingResolvedTerminalTypographyVm(
      state.settings.terminalTypography
    )
  };
}

export function buildShellWindowChromeVm(
  state: AppState
): Pick<
  ShellViewModel,
  | "windowId"
  | "title"
  | "sidebarVisible"
  | "sidebarWidth"
  | "unreadNotifications"
> {
  const { window, workspace } = resolveActiveWindowContext(state);

  return {
    windowId: window.id,
    title: `${workspace.name} cli/unix socket`,
    sidebarVisible: window.sidebarVisible,
    sidebarWidth: window.sidebarWidth,
    unreadNotifications: state.notifications.length
  };
}

export function buildWorkspaceRowsVm(state: AppState): WorkspaceRowVm[] {
  const { window, orderedWorkspaceIds } = resolveActiveWindowContext(state);
  const workspaceSurfaceIdsById = new Map(
    orderedWorkspaceIds.map((workspaceId) => [
      workspaceId,
      listWorkspaceSurfaceIds(state, workspaceId)
    ])
  );

  return orderedWorkspaceIds.map((workspaceId) => {
    const entry = state.workspaces[workspaceId];
    const representativeSurface = representativeWorkspaceSurface(state, entry);
    const representativeTerminalSurface =
      representativeWorkspaceTerminalSurface(state, entry);
    const representativeSession = representativeTerminalSurface
      ? terminalSessionForSurface(state, representativeTerminalSurface.id)
      : undefined;
    const representativeMetadata = representativeSession?.runtimeMetadata;
    const surfaces = (workspaceSurfaceIdsById.get(workspaceId) ?? []).map(
      (surfaceId) => state.surfaces[surfaceId]
    );
    const worktree = entry.worktree;
    const detectedWorktree = worktree ? undefined : entry.detectedWorktree;
    const branch = worktree?.branch ?? representativeMetadata?.branch;
    const baseStatusEntries = workspaceStatusEntries(entry).map(
      (statusEntry) => ({
        ...statusEntry
      })
    );
    const statusEntries =
      detectedWorktree && workspaceId !== window.activeWorkspaceId
        ? [
            {
              key: "worktree-detected",
              text: "worktree detected",
              variant: "attention" as const,
              updatedAt: detectedWorktree.detectedAt
            },
            ...baseStatusEntries
          ].slice(0, MAX_VIEW_STATUS_ENTRIES)
        : baseStatusEntries;
    return {
      workspaceId,
      targetKind: entry.location.target.kind,
      name: worktree?.name ?? entry.name,
      nameLocked: Boolean(entry.nameLocked || worktree),
      summary: worktree
        ? `worktree · ${worktree.branch}`
        : workspaceSummary(representativeSurface),
      cwd:
        (worktree ? encodedLocatedPath(worktree.path) : undefined) ??
        (representativeMetadata
          ? encodedLocatedPath(representativeMetadata.cwd)
          : entry.cwdSummary),
      branch,
      gitRepository: representativeMetadata?.gitRepository
        ? encodeWorkspaceGitRepository(representativeMetadata.gitRepository)
        : undefined,
      worktree: worktree ? encodeWorkspaceWorktree(worktree) : undefined,
      detectedWorktree: detectedWorktree
        ? encodeDetectedWorkspaceWorktree(detectedWorktree)
        : undefined,
      ports: aggregateWorkspacePorts(
        state,
        surfaces,
        state.panes[entry.activePaneId]?.activeSurfaceId
      ),
      statusText: entry.statusText,
      statusEntries,
      unreadCount: surfaces.reduce(
        (sum, surface) => sum + surface.unreadCount,
        0
      ),
      attention: surfaces.some((surface) => surface.attention),
      pinned: entry.pinned,
      isActive: workspaceId === window.activeWorkspaceId
    };
  });
}

export function buildActiveWorkspaceActivityVm(
  state: AppState
): ActiveWorkspaceActivityVm {
  const { workspace } = resolveActiveWindowContext(state);

  return {
    id: workspace.id,
    name: workspace.name,
    sidebarStatus: workspace.statusText,
    statusEntries: workspaceStatusEntries(workspace).map((statusEntry) => ({
      ...statusEntry
    })),
    progress: workspace.progress ? { ...workspace.progress } : undefined,
    logs: workspace.logs.map((logEntry) => ({ ...logEntry }))
  };
}

export function buildActiveWorkspaceVm(state: AppState): ActiveWorkspaceVm {
  const paneTree = buildActiveWorkspacePaneTreeVm(state);
  return { ...paneTree, ...buildActiveWorkspaceActivityVm(state) };
}

export function buildActiveWorkspacePaneTreeVm(
  state: AppState
): ActiveWorkspacePaneTreeVm {
  const { workspace, orderedWorkspaceIds } = resolveActiveWindowContext(state);

  if (!orderedWorkspaceIds.includes(workspace.id)) {
    throw new Error(
      "Cannot build active workspace view for a hidden workspace"
    );
  }

  return buildWorkspacePaneTreeVm(state, workspace.id);
}

export function buildWorkspacePaneTreeVm(
  state: AppState,
  workspaceId: Id
): ActiveWorkspacePaneTreeVm {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    throw new Error(
      `Cannot build pane tree for unknown workspace: ${workspaceId}`
    );
  }
  const workspacePaneIds = listWorkspacePaneIds(state, workspaceId);
  const workspaceSurfaceIds = listWorkspaceSurfaceIds(state, workspaceId);

  return {
    id: workspace.id,
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
      workspaceSurfaceIds.map((surfaceId) => {
        const surface = state.surfaces[surfaceId];
        return [
          surface.id,
          {
            id: surface.id,
            paneId: surface.paneId,
            title: surface.title,
            titleLocked: surface.titleLocked,
            unreadCount: surface.unreadCount,
            attention: surface.attention,
            content: surfaceCoreModule(surface.content.kind).buildVmContent(
              state,
              surface
            )
          } satisfies SurfaceVm
        ];
      })
    ),
    activePaneId: workspace.activePaneId
  };
}

export function buildNotificationsVm(state: AppState): NotificationItem[] {
  return state.notifications.map((notification) => ({ ...notification }));
}

export function buildShellSettingsVm(state: AppState): KmuxSettings {
  return structuredClone(state.settings);
}

function resolveActiveWindowContext(state: AppState): {
  window: WindowState;
  orderedWorkspaceIds: Id[];
  workspace: WorkspaceState;
} {
  const window = state.windows[state.activeWindowId];
  const orderedWorkspaceIds = listVisibleWorkspaceIds(state, window);
  const workspace =
    state.workspaces[window.activeWorkspaceId] ??
    state.workspaces[orderedWorkspaceIds[0]] ??
    state.workspaces[Object.keys(state.workspaces)[0]];
  if (!workspace) {
    throw new Error("Cannot build view model without an available workspace");
  }

  return {
    window,
    orderedWorkspaceIds,
    workspace
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
  return Object.values(workspace.statusEntries ?? {}).sort(
    compareStatusEntries
  );
}

function compareStatusEntries(
  left: SidebarStatusEntry,
  right: SidebarStatusEntry
): number {
  const priorityDelta = statusEntryPriority(left) - statusEntryPriority(right);
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

function representativeWorkspaceSurface(
  state: AppState,
  workspace: WorkspaceState
): SurfaceState | null {
  const activePane = state.panes[workspace.activePaneId];
  const activeSurfaceId = activePane?.activeSurfaceId;
  if (activeSurfaceId && state.surfaces[activeSurfaceId]) {
    return state.surfaces[activeSurfaceId];
  }

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

function representativeWorkspaceTerminalSurface(
  state: AppState,
  workspace: WorkspaceState
): SurfaceState<"terminal"> | null {
  const activePane = state.panes[workspace.activePaneId];
  const activeSurface = activePane
    ? state.surfaces[activePane.activeSurfaceId]
    : undefined;
  if (activeSurface?.content.kind === "terminal") {
    return activeSurface as SurfaceState<"terminal">;
  }

  const paneIds = [
    ...(activePane ? [activePane.id] : []),
    ...paneIdsInTreeOrder(workspace).filter((id) => id !== activePane?.id)
  ];
  for (const paneId of paneIds) {
    const pane = state.panes[paneId];
    for (const surfaceId of pane?.surfaceIds ?? []) {
      const surface = state.surfaces[surfaceId];
      if (surface?.content.kind === "terminal") {
        return surface as SurfaceState<"terminal">;
      }
    }
  }
  return null;
}

function paneIdsInTreeOrder(workspace: WorkspaceState): Id[] {
  const paneIds: Id[] = [];
  function walk(nodeId: Id): void {
    const node = workspace.nodeMap[nodeId];
    if (!node) return;
    if (node.kind === "leaf") {
      paneIds.push(node.paneId);
      return;
    }
    walk(node.first);
    walk(node.second);
  }
  walk(workspace.rootNodeId);
  return paneIds;
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

function workspaceSummary(representativeSurface: SurfaceState | null): string {
  const representativeTitle = representativeSurface?.title.trim();
  return representativeTitle || "Waiting for input";
}

function aggregateWorkspacePorts(
  state: AppState,
  surfaces: SurfaceState[],
  activeSurfaceId?: Id
): number[] {
  const seen = new Set<number>();
  const aggregate: number[] = [];
  const activeSurface = activeSurfaceId
    ? surfaces.find((surface) => surface.id === activeSurfaceId)
    : undefined;

  function pushPort(port: number): void {
    if (!Number.isFinite(port) || seen.has(port) || aggregate.length >= 3) {
      return;
    }
    seen.add(port);
    aggregate.push(port);
  }

  for (const port of activeSurface
    ? (terminalRuntimeMetadataForSurface(state, activeSurface.id)?.ports ?? [])
    : []) {
    pushPort(port);
  }

  const otherPorts = surfaces
    .filter((surface) => surface.id !== activeSurface?.id)
    .flatMap(
      (surface) =>
        terminalRuntimeMetadataForSurface(state, surface.id)?.ports ?? []
    )
    .filter((port) => Number.isFinite(port) && !seen.has(port))
    .sort((left, right) => left - right);

  for (const port of otherPorts) {
    pushPort(port);
  }

  return aggregate;
}

function sanitizeState(
  state: AppState,
  options: { allowLegacySurfaceFormat: boolean }
): AppState {
  const rawRemoteEventReceipts = (
    state as AppState & { remoteEventReceipts?: unknown }
  ).remoteEventReceipts;
  state.remoteEventReceipts =
    rawRemoteEventReceipts &&
    typeof rawRemoteEventReceipts === "object" &&
    !Array.isArray(rawRemoteEventReceipts)
      ? Object.fromEntries(
          Object.entries(rawRemoteEventReceipts)
            .slice(0, 256)
            .flatMap(([targetId, value]) => {
              if (
                !targetId ||
                targetId.length > 512 ||
                !value ||
                typeof value !== "object" ||
                Array.isArray(value)
              ) {
                return [];
              }
              const record = value as unknown as Record<string, unknown>;
              if (
                !Array.isArray(record.recentEventIds) ||
                record.recentEventIds.length > MAX_RECENT_REMOTE_EVENT_IDS ||
                !record.recentEventIds.every(
                  (eventId) =>
                    typeof eventId === "string" &&
                    eventId.length > 0 &&
                    eventId.length <= 512
                )
              ) {
                return [];
              }
              try {
                const throughSequence =
                  typeof record.throughSequence === "bigint"
                    ? parseUint64Decimal(record.throughSequence.toString(10))
                    : parseUint64Decimal(record.throughSequence);
                const recentEventIds = [...new Set(record.recentEventIds)];
                return [[targetId, { throughSequence, recentEventIds }]];
              } catch {
                return [];
              }
            })
        )
      : {};
  const rawRemoteOperations = (
    state as AppState & { remoteOperations?: unknown }
  ).remoteOperations;
  state.remoteOperations =
    rawRemoteOperations &&
    typeof rawRemoteOperations === "object" &&
    !Array.isArray(rawRemoteOperations)
      ? Object.fromEntries(
          Object.entries(rawRemoteOperations).flatMap(([id, operation]) => {
            try {
              const decoded = decodeRemoteOperationProjectionDto(operation);
              return decoded.operationId === id ? [[id, decoded]] : [];
            } catch {
              return [];
            }
          })
        )
      : {};
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
    const rawLocation = (workspace as WorkspaceState & { location?: unknown })
      .location;
    workspace.location =
      rawLocation === undefined
        ? workspaceLocation(
            { kind: "local" },
            normalizeOptionalText(workspace.cwdSummary, 32 * 1024) ??
              defaultHomeDirectory()
          )
        : decodeWorkspaceLocationDto(rawLocation);
    const rawRemoteResourceRevision = (
      workspace as WorkspaceState & { remoteResourceRevision?: unknown }
    ).remoteResourceRevision;
    if (
      workspace.location.target.kind === "ssh" &&
      rawRemoteResourceRevision !== undefined
    ) {
      try {
        workspace.remoteResourceRevision =
          typeof rawRemoteResourceRevision === "bigint"
            ? parseUint64Decimal(rawRemoteResourceRevision.toString(10))
            : parseUint64Decimal(rawRemoteResourceRevision);
      } catch {
        delete workspace.remoteResourceRevision;
      }
    } else {
      delete workspace.remoteResourceRevision;
    }
    sanitizeWorkspaceStatusEntries(workspace);
    workspace.worktree = sanitizeWorkspaceWorktree(
      workspace.worktree,
      workspace.location.target
    );
    workspace.detectedWorktree = sanitizeDetectedWorkspaceWorktree(
      workspace.detectedWorktree,
      workspace.location.target
    );
    workspace.dismissedWorktreePaths = Array.isArray(
      workspace.dismissedWorktreePaths
    )
      ? workspace.dismissedWorktreePaths
          .flatMap((path) => {
            try {
              return [decodeFeaturePath(path, workspace.location.target)];
            } catch {
              return [];
            }
          })
          .slice(-32)
      : undefined;
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
        if (read === true || sanitized.agent === "gemini") {
          return [];
        }
        return [sanitized as NotificationItem];
      })
    : [];

  const legacyMetadataBySurfaceId = new Map<
    Id,
    {
      cwd?: unknown;
      branch?: unknown;
      gitRepository?: unknown;
      ports?: unknown;
    }
  >();

  for (const surface of Object.values(state.surfaces)) {
    const pane = state.panes[surface.paneId];
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (!workspace) {
      throw new TypeError(`Surface ${surface.id} has no owning workspace`);
    }
    const record = surface as unknown as Record<string, unknown>;
    const content = record.content;
    if (content === undefined) {
      if (!options.allowLegacySurfaceFormat) {
        throw new TypeError(`Surface ${surface.id} is missing content`);
      }
      const sessionId = normalizeOptionalText(record.sessionId, 512);
      if (!sessionId) {
        throw new TypeError(`Legacy Surface ${surface.id} has no sessionId`);
      }
      surface.content = { kind: "terminal", sessionId };
      legacyMetadataBySurfaceId.set(surface.id, {
        cwd: record.cwd,
        branch: record.branch,
        gitRepository: record.gitRepository,
        ports: record.ports
      });
    } else {
      surface.content = decodeSurfaceContent(content);
    }
    delete record.sessionId;
    delete record.cwd;
    delete record.branch;
    delete record.gitRepository;
    delete record.ports;
    syncSurfaceNotificationState(state, surface.id);
  }

  for (const session of Object.values(state.sessions)) {
    const surface = state.surfaces[session.surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    const target = workspace?.location.target ?? ({ kind: "local" } as const);
    if (!surface || surface.content.kind !== "terminal") {
      throw new TypeError(`Session ${session.id} has no Terminal Surface`);
    }
    if (surface.content.sessionId !== session.id) {
      throw new TypeError(
        `Terminal Surface ${surface.id} does not reference Session ${session.id}`
      );
    }
    const legacyMetadata = legacyMetadataBySurfaceId.get(surface.id);
    const fallbackCwd = workspace
      ? locatedPathForTarget(
          target,
          encodeWorkspaceDefaultCwd(workspace.location)
        )
      : defaultLocalCwd();
    const rawLaunch = session.launch as unknown as Record<string, unknown>;
    let launchCwd = fallbackCwd;
    try {
      launchCwd = decodeFeaturePath(rawLaunch?.cwd, target, fallbackCwd);
    } catch {
      // Keep the target-checked surface cwd when an old launch cwd is invalid.
    }
    session.launch = sanitizeStoredSessionLaunchConfig(
      { ...rawLaunch, cwd: launchCwd },
      target.kind === "local" ? state.settings.shell : undefined
    );
    session.agentSessionRef = sanitizeAgentSessionRef(
      (session as SessionState & { agentSessionRef?: unknown }).agentSessionRef,
      target,
      launchCwd
    );
    if (!session.agentSessionRef) {
      delete session.agentSessionRef;
    }
    const rawRuntimeMetadata = (
      session as SessionState & { runtimeMetadata?: unknown }
    ).runtimeMetadata;
    session.runtimeMetadata = decodeTerminalRuntimeMetadata(
      rawRuntimeMetadata ?? legacyMetadata,
      target,
      launchCwd
    );
    session.runtimeStatus = sanitizeSessionRuntimeStatus(
      (
        session as SessionState & {
          runtimeStatus?: unknown;
          runtimeState?: unknown;
        }
      ).runtimeStatus,
      (session as SessionState & { runtimeState?: unknown }).runtimeState
    );
    delete (session as SessionState & { runtimeState?: unknown }).runtimeState;
    session.remoteRuntime = sanitizeRemoteSessionRuntimeState(
      (session as SessionState & { remoteRuntime?: unknown }).remoteRuntime,
      target
    );
    if (!session.remoteRuntime) delete session.remoteRuntime;
    session.shellInputReady =
      session.runtimeStatus.processState === "running" &&
      session.shellInputReady === true;
  }

  for (const surface of Object.values(state.surfaces)) {
    const pane = state.panes[surface.paneId];
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (!workspace) {
      throw new TypeError(`Surface ${surface.id} has no owning workspace`);
    }
    if (surface.content.kind === "terminal") {
      const metadata = terminalRuntimeMetadataForSurface(state, surface.id);
      if (!metadata) {
        throw new TypeError(
          `Terminal Surface ${surface.id} has an invalid Session reference`
        );
      }
      assertLocatedPathTarget(workspace.location.target, metadata.cwd);
    } else {
      assertLocatedPathTarget(
        workspace.location.target,
        surface.content.source.path
      );
    }
  }

  return state;
}

function decodeSurfaceContent(value: unknown): SurfaceContentOf {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Surface content must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "terminal" && record.kind !== "markdown") {
    throw new TypeError(`Unsupported Surface kind: ${String(record.kind)}`);
  }
  return surfaceCoreModule(record.kind).decodeContent(value);
}

function decodeTerminalRuntimeMetadata(
  value: unknown,
  target: WorkspaceTarget,
  fallbackCwd: LocatedPath
): TerminalRuntimeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { cwd: fallbackCwd, ports: [] };
  }
  const record = value as Record<string, unknown>;
  const cwd = decodeFeaturePath(record.cwd, target, fallbackCwd);
  const branch = normalizeOptionalText(record.branch, 4096);
  const gitRepository = sanitizeWorkspaceGitRepository(
    record.gitRepository,
    target
  );
  const ports = Array.isArray(record.ports)
    ? record.ports
        .filter(
          (port): port is number =>
            typeof port === "number" &&
            Number.isInteger(port) &&
            port > 0 &&
            port <= 65_535
        )
        .slice(0, 3)
    : [];
  return {
    cwd,
    ...(branch === undefined ? {} : { branch }),
    ...(gitRepository === undefined ? {} : { gitRepository }),
    ports
  };
}

function sanitizeRemoteSessionRuntimeState(
  value: unknown,
  target: WorkspaceTarget
): RemoteSessionRuntimeState | undefined {
  if (target.kind !== "ssh" || !value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.keeperGeneration !== "string" ||
    record.keeperGeneration.length === 0
  ) {
    return undefined;
  }
  try {
    const remoteResourceRevision =
      typeof record.remoteResourceRevision === "bigint"
        ? parseUint64Decimal(record.remoteResourceRevision.toString(10))
        : parseUint64Decimal(record.remoteResourceRevision);
    const lastAcknowledgedMutationSequence =
      record.lastAcknowledgedMutationSequence === undefined
        ? undefined
        : typeof record.lastAcknowledgedMutationSequence === "bigint"
          ? parseUint64Decimal(
              record.lastAcknowledgedMutationSequence.toString(10)
            )
          : parseUint64Decimal(record.lastAcknowledgedMutationSequence);
    const storageStatus = sanitizeRemoteSessionStorageStatus(
      record.storageStatus
    );
    return {
      keeperGeneration: record.keeperGeneration,
      remoteResourceRevision,
      ...(lastAcknowledgedMutationSequence === undefined
        ? {}
        : { lastAcknowledgedMutationSequence }),
      ...(storageStatus === undefined ? {} : { storageStatus })
    };
  } catch {
    return undefined;
  }
}

function sanitizeRemoteSessionStorageStatus(
  value: unknown
): RemoteSessionStorageStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.state !== "normal" &&
    record.state !== "degraded" &&
    record.state !== "backpressured"
  ) {
    return undefined;
  }
  if (
    typeof record.emergencyBytes !== "number" ||
    !Number.isSafeInteger(record.emergencyBytes) ||
    record.emergencyBytes < 0 ||
    record.emergencyBytes > 4 * 1024 * 1024 ||
    (record.lastSyncDurationMs !== undefined &&
      (typeof record.lastSyncDurationMs !== "number" ||
        !Number.isSafeInteger(record.lastSyncDurationMs) ||
        record.lastSyncDurationMs < 0))
  ) {
    return undefined;
  }
  try {
    const journalAdmitted =
      typeof record.journalAdmitted === "bigint"
        ? parseUint64Decimal(record.journalAdmitted.toString(10))
        : parseUint64Decimal(record.journalAdmitted);
    const journalSynced =
      typeof record.journalSynced === "bigint"
        ? parseUint64Decimal(record.journalSynced.toString(10))
        : parseUint64Decimal(record.journalSynced);
    if (journalSynced > journalAdmitted) return undefined;
    return {
      state: record.state,
      journalAdmitted,
      journalSynced,
      emergencyBytes: record.emergencyBytes,
      ...(record.lastSyncDurationMs === undefined
        ? {}
        : { lastSyncDurationMs: record.lastSyncDurationMs })
    };
  } catch {
    return undefined;
  }
}

function sanitizeWorkspaceGitRepository(
  repository: unknown,
  target: WorkspaceTarget
): LocatedWorkspaceGitRepositoryMetadata | undefined {
  if (!repository || typeof repository !== "object") {
    return undefined;
  }
  const record = repository as Record<string, unknown>;
  try {
    return {
      root: decodeFeaturePath(record.root, target),
      gitDir: decodeFeaturePath(record.gitDir, target),
      commonGitDir: decodeFeaturePath(record.commonGitDir, target),
      linkedWorktree: record.linkedWorktree === true
    };
  } catch {
    return undefined;
  }
}

function sanitizeWorkspaceWorktree(
  worktree: unknown,
  target: WorkspaceTarget
): LocatedWorkspaceWorktreeMetadata | undefined {
  if (!worktree || typeof worktree !== "object") {
    return undefined;
  }
  const record = worktree as Record<string, unknown>;
  const name = normalizeOptionalText(record.name, 128);
  const baseRef = normalizeOptionalText(record.baseRef, 256);
  const branch = normalizeOptionalText(record.branch, 256);
  if (!name || !baseRef || !branch) {
    return undefined;
  }
  try {
    return {
      name,
      path: decodeFeaturePath(record.path, target),
      repoRoot: decodeFeaturePath(record.repoRoot, target),
      commonGitDir: decodeFeaturePath(record.commonGitDir, target),
      baseRef,
      branch,
      createdByKmux: record.createdByKmux === true,
      ...(record.launchSurfaceCreated === true
        ? { launchSurfaceCreated: true }
        : {})
    };
  } catch {
    return undefined;
  }
}

function sanitizeDetectedWorkspaceWorktree(
  worktree: unknown,
  target: WorkspaceTarget
): LocatedWorkspaceDetectedWorktreeMetadata | undefined {
  if (!worktree || typeof worktree !== "object") {
    return undefined;
  }
  const record = worktree as Record<string, unknown>;
  const baseRef = normalizeOptionalText(record.baseRef, 256);
  const branch = normalizeOptionalText(record.branch, 256);
  const detectedAt = normalizeOptionalText(record.detectedAt, 64);
  if (!baseRef || !branch) {
    return undefined;
  }
  try {
    return {
      path: decodeFeaturePath(record.path, target),
      repoRoot: decodeFeaturePath(record.repoRoot, target),
      commonGitDir: decodeFeaturePath(record.commonGitDir, target),
      baseRef,
      branch,
      detectedAt: detectedAt ?? isoNow()
    };
  } catch {
    return undefined;
  }
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

export function sanitizeStoredSessionLaunchConfig(
  launch: Record<string, unknown> & { cwd: LocatedPath },
  fallbackShell: string | undefined
): StoredSessionLaunchConfig {
  // This also proves the value came from a path codec rather than a cast.
  encodeLocatedPathDto(launch.cwd);
  const shell = normalizeOptionalText(launch.shell, 32 * 1024) ?? fallbackShell;
  const title = normalizeOptionalText(launch.title, 4 * 1024);
  const args = Array.isArray(launch.args)
    ? launch.args
        .filter((arg): arg is string => typeof arg === "string")
        .slice(0, 256)
        .map((arg) => arg.slice(0, 32 * 1024))
    : [];
  const initialInput =
    typeof launch.initialInput === "string" && launch.initialInput.length > 0
      ? launch.initialInput.slice(0, 64 * 1024)
      : undefined;
  const env = sanitizeLaunchEnvironment(launch.env);
  return {
    cwd: launch.cwd,
    ...(shell ? { shell } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(initialInput ? { initialInput } : {}),
    ...(env ? { env } : {}),
    ...(title ? { title } : {})
  };
}

function sanitizeLaunchEnvironment(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        entry[0].length <= 512 &&
        !entry[0].includes("\0") &&
        typeof entry[1] === "string"
    )
    .slice(0, 256)
    .map(([key, entryValue]) => [key, entryValue.slice(0, 32 * 1024)]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function sanitizeAgentSessionRef(
  value: unknown,
  target: WorkspaceTarget,
  fallbackCwd: LocatedPath
): AgentSessionRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    vendor?: unknown;
    externalKey?: unknown;
    sessionId?: unknown;
    id?: unknown;
    targetId?: unknown;
    cwd?: unknown;
  };
  const vendor =
    typeof record.vendor === "string"
      ? normalizeExternalAgentSessionVendor(record.vendor)
      : null;
  const sessionId = normalizeOptionalText(record.id ?? record.sessionId, 512);
  const externalKey =
    typeof record.externalKey === "string"
      ? normalizeOptionalText(record.externalKey, 512)
      : undefined;

  if (!vendor || !sessionId) {
    return undefined;
  }
  const expectedTargetId = target.kind === "ssh" ? target.targetId : "local";
  if (
    record.targetId !== undefined &&
    normalizeOptionalText(record.targetId, 512) !== expectedTargetId
  ) {
    return undefined;
  }
  let cwd = fallbackCwd;
  if (record.cwd !== undefined) {
    try {
      cwd = decodeFeaturePath(record.cwd, target, fallbackCwd);
    } catch {
      return undefined;
    }
  }
  return {
    vendor,
    id: sessionId,
    targetId: expectedTargetId,
    cwd,
    externalKey: externalKey ?? externalAgentSessionKey(vendor, sessionId)
  };
}

function sanitizeSessionRuntimeStatus(
  value: unknown,
  legacyProcessState: unknown
): SessionRuntimeStatus {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  const processState =
    record?.processState === "pending" ||
    record?.processState === "running" ||
    record?.processState === "exited"
      ? record.processState
      : legacyProcessState === "running" || legacyProcessState === "exited"
        ? legacyProcessState
        : "pending";
  const observationState =
    record?.observationState === "observed" ? "observed" : "unknown";
  const attachmentState =
    record?.attachmentState === "connecting" ||
    record?.attachmentState === "attached" ||
    record?.attachmentState === "failed"
      ? record.attachmentState
      : "detached";
  return { processState, observationState, attachmentState };
}

function decodeFeaturePath(
  value: unknown,
  target: WorkspaceTarget,
  fallback?: LocatedPath
): LocatedPath {
  if (value === undefined || value === null) {
    if (fallback) {
      assertLocatedPathTarget(target, fallback);
      return fallback;
    }
    throw new TypeError("path is required");
  }
  const path =
    typeof value === "string"
      ? locatedPathForTarget(target, value)
      : decodeLocatedPathDto(value);
  assertLocatedPathTarget(target, path);
  return path;
}

function decodeWorkspaceGitRepository(
  value: WorkspaceGitRepositoryMetadataDto,
  target: WorkspaceTarget
): LocatedWorkspaceGitRepositoryMetadata {
  const decoded = sanitizeWorkspaceGitRepository(value, target);
  if (!decoded) {
    throw new TypeError("workspace Git repository metadata is invalid");
  }
  return decoded;
}

function decodeWorkspaceWorktree(
  value: WorkspaceWorktreeMetadataDto,
  target: WorkspaceTarget
): LocatedWorkspaceWorktreeMetadata {
  const decoded = sanitizeWorkspaceWorktree(value, target);
  if (!decoded) {
    throw new TypeError("workspace worktree metadata is invalid");
  }
  return decoded;
}

function decodeDetectedWorkspaceWorktree(
  value: WorkspaceDetectedWorktreeMetadataDto,
  target: WorkspaceTarget
): LocatedWorkspaceDetectedWorktreeMetadata {
  const decoded = sanitizeDetectedWorkspaceWorktree(value, target);
  if (!decoded) {
    throw new TypeError("detected worktree metadata is invalid");
  }
  return decoded;
}

function encodedLocatedPath(path: LocatedPath): string {
  return encodeLocatedPathDto(path).path;
}

function encodeWorkspaceDefaultCwd(location: WorkspaceLocation): string {
  return encodeWorkspaceLocationDto(location).defaultCwd;
}

export function encodeWorkspaceGitRepository(
  repository: LocatedWorkspaceGitRepositoryMetadata
): WorkspaceGitRepositoryMetadataDto {
  return {
    root: encodedLocatedPath(repository.root),
    gitDir: encodedLocatedPath(repository.gitDir),
    commonGitDir: encodedLocatedPath(repository.commonGitDir),
    linkedWorktree: repository.linkedWorktree
  };
}

function encodeWorkspaceWorktree(
  worktree: LocatedWorkspaceWorktreeMetadata
): WorkspaceWorktreeMetadataDto {
  return {
    name: worktree.name,
    path: encodedLocatedPath(worktree.path),
    repoRoot: encodedLocatedPath(worktree.repoRoot),
    commonGitDir: encodedLocatedPath(worktree.commonGitDir),
    baseRef: worktree.baseRef,
    branch: worktree.branch,
    createdByKmux: worktree.createdByKmux,
    ...(worktree.launchSurfaceCreated === true
      ? { launchSurfaceCreated: true }
      : {})
  };
}

function encodeDetectedWorkspaceWorktree(
  worktree: LocatedWorkspaceDetectedWorktreeMetadata
): WorkspaceDetectedWorktreeMetadataDto {
  return {
    path: encodedLocatedPath(worktree.path),
    repoRoot: encodedLocatedPath(worktree.repoRoot),
    commonGitDir: encodedLocatedPath(worktree.commonGitDir),
    baseRef: worktree.baseRef,
    branch: worktree.branch,
    detectedAt: worktree.detectedAt
  };
}

function encodePersistedWorkspaceGitRepository(
  repository: LocatedWorkspaceGitRepositoryMetadata
): Record<string, unknown> {
  return {
    root: encodeLocatedPathDto(repository.root),
    gitDir: encodeLocatedPathDto(repository.gitDir),
    commonGitDir: encodeLocatedPathDto(repository.commonGitDir),
    linkedWorktree: repository.linkedWorktree
  };
}

function encodePersistedWorkspaceWorktree(
  worktree: LocatedWorkspaceWorktreeMetadata
): Record<string, unknown> {
  return {
    name: worktree.name,
    path: encodeLocatedPathDto(worktree.path),
    repoRoot: encodeLocatedPathDto(worktree.repoRoot),
    commonGitDir: encodeLocatedPathDto(worktree.commonGitDir),
    baseRef: worktree.baseRef,
    branch: worktree.branch,
    createdByKmux: worktree.createdByKmux,
    ...(worktree.launchSurfaceCreated === true
      ? { launchSurfaceCreated: true }
      : {})
  };
}

function encodePersistedDetectedWorkspaceWorktree(
  worktree: LocatedWorkspaceDetectedWorktreeMetadata
): Record<string, unknown> {
  return {
    path: encodeLocatedPathDto(worktree.path),
    repoRoot: encodeLocatedPathDto(worktree.repoRoot),
    commonGitDir: encodeLocatedPathDto(worktree.commonGitDir),
    baseRef: worktree.baseRef,
    branch: worktree.branch,
    detectedAt: worktree.detectedAt
  };
}

function normalizeExternalAgentSessionVendor(
  value: string
): ExternalAgentSessionVendor | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_");
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "claude") {
    return "claude";
  }
  if (
    normalized === "agy" ||
    normalized === "antigravity" ||
    normalized === "antigravity-cli"
  ) {
    return "antigravity";
  }
  return null;
}

function externalAgentSessionKey(
  vendor: ExternalAgentSessionVendor,
  sessionId: string
): string {
  return `${vendor}:${sessionId}`;
}

function sanitizeShortcuts(
  shortcuts: Record<string, string>
): Record<string, string> {
  const nextShortcuts = Object.fromEntries(
    Object.entries(shortcuts).map(([command, binding]) => [
      command,
      normalizeShortcutBinding(binding)
    ])
  );
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

function sanitizeShortcutDefaultsPlatform(
  platform: KmuxSettings["shortcutDefaultsPlatform"] | undefined
): ShortcutPlatform | undefined {
  if (platform === "darwin" || platform === "linux") {
    return platform;
  }
  return undefined;
}

function sanitizeSurfaceDiagnosticCaptureMode(
  mode: KmuxSettings["surfaceDiagnosticCaptureMode"] | undefined
): SurfaceDiagnosticCaptureMode {
  if (mode === "enabled" || mode === "disabled") {
    return mode;
  }
  return "default";
}

function sanitizeSettingsVersion(settingsVersion: unknown): number {
  return typeof settingsVersion === "number" && Number.isFinite(settingsVersion)
    ? settingsVersion
    : 1;
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
