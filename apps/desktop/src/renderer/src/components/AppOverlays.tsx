import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction
} from "react";

import { resolveSurfaceDiagnosticCaptureEnabled } from "@kmux/core";
import type {
  KmuxSettings,
  NotificationItem,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm,
  SshAskpassPrompt,
  SshConnectionsSnapshot,
  WorktreeConversionPreview,
  WorktreeDirtyEntryGroup,
  WorkspaceRowVm,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import type { TerminalThemeVariant } from "@kmux/proto";
import { normalizeShortcut } from "@kmux/ui";

import {
  isReservedSystemChordBinding,
  type KeyChord
} from "../../../shared/platform/keyboardPolicy";
import type {
  WorkspaceContext,
  WorkspaceContextAction,
  WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";
import type { WorkspaceContextMenuState } from "../hooks/useWorkspaceContextMenu";
import {
  formatShortcutLabel,
  type ShortcutLabelStyle
} from "../shortcutLabels";
import styles from "../styles/App.module.css";
import {
  describeTerminalTypographyHeadline,
  describeTerminalTypographyStatus,
  describeTerminalTypographySupportLines
} from "../terminalTypography";
import { NotificationsPanel } from "./NotificationsPanel";
import { SshConnectionsSettings } from "./SshConnectionsSettings";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";

interface AppOverlaysProps {
  shortcutLabelStyle: ShortcutLabelStyle;
  reservedSystemChords: KeyChord[];
  surfaceDiagnosticCaptureDefaultEnabled: boolean;
  diagnosticLogPath?: string;
  paletteOpen: boolean;
  paletteQuery: string;
  paletteSelectedIndex: number;
  paletteItems: Array<{
    id: string;
    label: string;
    subtitle: string;
    run: () => void;
  }>;
  onClosePalette: () => void;
  onChangePaletteQuery: (value: string) => void;
  onSelectPaletteIndex: (index: number) => void;
  onExecutePaletteItem: (index: number) => void;
  workspaceContextMenu: WorkspaceContextMenuState | null;
  workspaceContext: WorkspaceContext | null;
  workspaceContextMenuItems: WorkspaceContextMenuEntry[];
  workspaceMenuRef: RefObject<HTMLDivElement>;
  onCloseWorkspaceContextMenu: () => void;
  onWorkspaceContextAction: (
    action: WorkspaceContextAction,
    workspaceId: string
  ) => void;
  notificationsOpen: boolean;
  notifications: NotificationItem[];
  onCloseNotifications: () => void;
  onJumpNotifications: () => void;
  onClearNotifications: () => void;
  workspaceCloseConfirm: {
    workspaceId: string;
    closeWorkspaceIds?: string[];
    isLastWorkspace: boolean;
    worktree?: WorkspaceWorktreeMetadata;
    worktrees?: Array<{
      workspaceId: string;
      worktree: WorkspaceWorktreeMetadata;
    }>;
    removeWorktree: boolean;
    dirtyEntries?: string[];
    dirtyWorktrees?: WorktreeDirtyEntryGroup[];
    error?: string | null;
    busy?: boolean;
  } | null;
  onCloseWorkspaceCloseConfirm: () => void;
  onToggleWorkspaceCloseRemoveWorktree: (removeWorktree: boolean) => void;
  onConfirmWorkspaceClose: () => void;
  surfaceRestartConfirm: {
    surfaceId: string;
    title: string;
  } | null;
  onCloseSurfaceRestartConfirm: () => void;
  onConfirmSurfaceRestart: () => void;
  worktreeDialog:
    | {
        kind: "create";
        workspaceId: string;
        preview: WorktreeConversionPreview;
        name: string;
        error?: string | null;
        busy?: boolean;
      }
    | {
        kind: "detected";
        workspaceId: string;
        row: WorkspaceRowVm;
        error?: string | null;
        busy?: boolean;
      }
    | null;
  onCloseWorktreeDialog: () => void;
  onDismissDetectedWorktree: () => void;
  onChangeWorktreeName: (name: string) => void;
  onConfirmWorktreeDialog: () => void;
  sshAskpassPrompt: (SshAskpassPrompt & { response: string }) | null;
  onChangeSshAskpassResponse: (response: string) => void;
  onCancelSshAskpass: () => void;
  onSubmitSshAskpass: () => void;
  sshWorkspaceDialog: {
    workspaceId: string;
    sourceTargetKind: "local" | "ssh";
    connections: SshConnectionsSnapshot | null;
    selectedProfileId: string | null;
    continuation: "convert" | "create";
    phase: "idle" | "preparing" | "committing";
    requestId?: string;
    error?: string | null;
  } | null;
  onCloseSshWorkspaceDialog: () => void;
  onSelectSshProfile: (profileId: string) => void;
  onSelectSshContinuation: (continuation: "convert" | "create") => void;
  onConfirmSshWorkspace: () => void;
  onManageSshConnections: () => void;
  settingsOpen: boolean;
  settingsInitialCategory:
    | "general"
    | "ssh"
    | "terminal"
    | "notifications"
    | "shortcuts";
  settingsDraft: KmuxSettings | undefined;
  setSettingsDraft: Dispatch<SetStateAction<KmuxSettings | undefined>>;
  settingsThemeNotice: string | null;
  terminalTypographyPreview: ResolvedTerminalTypographyVm | null;
  terminalThemePreview: ResolvedTerminalThemeVm | null;
  onImportTerminalTheme: () => void;
  onReplaceTerminalThemeVariant: (variant: TerminalThemeVariant) => void;
  onDuplicateTerminalTheme: () => void;
  onDeleteTerminalTheme: () => void;
  onSelectTerminalTheme: (profileId: string) => void;
  onSetTerminalThemeContrast: (value: number) => void;
  onExportTerminalThemeVariant: (variant: TerminalThemeVariant) => void;
  onOpenSettingsJson: () => Promise<void>;
  onClearDiagnosticLog: () => Promise<boolean>;
  onCloseSettings: () => void;
  onSaveSettings: (settingsDraft: KmuxSettings) => void;
}

type SettingsDraftPatch = Partial<
  Omit<KmuxSettings, "terminalTypography" | "terminalThemes">
> & {
  terminalTypography?: Partial<KmuxSettings["terminalTypography"]>;
  terminalThemes?: Partial<KmuxSettings["terminalThemes"]>;
};

type SettingsCategoryId =
  | "general"
  | "ssh"
  | "terminal"
  | "notifications"
  | "shortcuts";

const SETTINGS_CATEGORIES: Array<{
  id: SettingsCategoryId;
  label: string;
  description: string;
}> = [
  {
    id: "general",
    label: "General",
    description: "App behavior"
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Theme, font, renderer"
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Agent attention"
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Keyboard bindings"
  },
  {
    id: "ssh",
    label: "SSH Connections",
    description: "Remote profiles"
  }
];

const THEME_MODE_CHOICES: Array<{
  id: KmuxSettings["themeMode"];
  label: string;
  description: string;
}> = [
  {
    id: "system",
    label: "System",
    description: "Match macOS automatically"
  },
  {
    id: "light",
    label: "Light",
    description: "Bright workspace chrome"
  },
  {
    id: "dark",
    label: "Dark",
    description: "Dim chrome for focus"
  }
];

const SHORTCUT_LABELS: Record<string, { label: string; detail: string }> = {
  "workspace.create": {
    label: "New workspace",
    detail: "workspace.create"
  },
  "workspace.rename": {
    label: "Rename workspace",
    detail: "workspace.rename"
  },
  "workspace.close": {
    label: "Close workspace",
    detail: "workspace.close"
  },
  "workspace.next": {
    label: "Next workspace",
    detail: "workspace.next"
  },
  "workspace.prev": {
    label: "Previous workspace",
    detail: "workspace.prev"
  },
  "workspace.sidebar.toggle": {
    label: "Show or hide sidebar",
    detail: "workspace.sidebar.toggle"
  },
  "pane.split.right": {
    label: "Split pane right",
    detail: "pane.split.right"
  },
  "pane.split.down": {
    label: "Split pane down",
    detail: "pane.split.down"
  },
  "pane.focus.left": {
    label: "Focus pane left",
    detail: "pane.focus.left"
  },
  "pane.focus.right": {
    label: "Focus pane right",
    detail: "pane.focus.right"
  },
  "pane.focus.up": {
    label: "Focus pane above",
    detail: "pane.focus.up"
  },
  "pane.focus.down": {
    label: "Focus pane below",
    detail: "pane.focus.down"
  },
  "pane.resize.left": {
    label: "Resize pane left",
    detail: "pane.resize.left"
  },
  "pane.resize.right": {
    label: "Resize pane right",
    detail: "pane.resize.right"
  },
  "pane.resize.up": {
    label: "Resize pane up",
    detail: "pane.resize.up"
  },
  "pane.resize.down": {
    label: "Resize pane down",
    detail: "pane.resize.down"
  },
  "pane.close": {
    label: "Close pane",
    detail: "pane.close"
  },
  "surface.create": {
    label: "New terminal tab",
    detail: "surface.create"
  },
  "surface.close": {
    label: "Close terminal tab",
    detail: "surface.close"
  },
  "surface.closeOthers": {
    label: "Close other terminal tabs",
    detail: "surface.closeOthers"
  },
  "surface.next": {
    label: "Next terminal tab",
    detail: "surface.next"
  },
  "surface.prev": {
    label: "Previous terminal tab",
    detail: "surface.prev"
  },
  "command.palette": {
    label: "Command palette",
    detail: "command.palette"
  },
  "notifications.toggle": {
    label: "Show notifications",
    detail: "notifications.toggle"
  },
  "usage.dashboard.toggle": {
    label: "Show usage dashboard",
    detail: "usage.dashboard.toggle"
  },
  "settings.toggle": {
    label: "Open settings",
    detail: "settings.toggle"
  },
  "terminal.search": {
    label: "Find in terminal",
    detail: "terminal.search"
  },
  "terminal.search.next": {
    label: "Next search match",
    detail: "terminal.search.next"
  },
  "terminal.search.prev": {
    label: "Previous search match",
    detail: "terminal.search.prev"
  },
  "terminal.copy": {
    label: "Copy terminal selection",
    detail: "terminal.copy"
  },
  "terminal.paste": {
    label: "Paste into terminal",
    detail: "terminal.paste"
  },
  "terminal.copyMode": {
    label: "Terminal copy mode",
    detail: "terminal.copyMode"
  }
};

const SHORTCUT_MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "OS",
  "Shift"
]);

function isModifierOnlyShortcutEvent(
  event: Pick<KeyboardEvent, "key">
): boolean {
  return SHORTCUT_MODIFIER_KEYS.has(event.key);
}

function isShortcutClearEvent(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >
): boolean {
  return (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === "Backspace" || event.key === "Delete")
  );
}

export function formatRecordedShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
  reservedSystemChords: KeyChord[] = []
): string | null {
  if (isModifierOnlyShortcutEvent(event)) {
    return null;
  }
  const shortcut = normalizeShortcut(event);
  return isReservedSystemChordBinding(shortcut, reservedSystemChords)
    ? null
    : shortcut;
}

export function AppOverlays(props: AppOverlaysProps): JSX.Element {
  const [activeSettingsCategory, setActiveSettingsCategory] =
    useState<SettingsCategoryId>("general");
  const [diagnosticLogClearStatus, setDiagnosticLogClearStatus] = useState<
    "idle" | "clearing" | "cleared" | "failed"
  >("idle");
  const [recordingShortcutCommand, setRecordingShortcutCommand] = useState<
    string | null
  >(null);
  const activeWorkspaceContext =
    props.workspaceContextMenu && props.workspaceContext
      ? props.workspaceContext
      : null;
  const activeTerminalTheme = props.settingsDraft
    ? (props.settingsDraft.terminalThemes.profiles.find(
        (profile) =>
          profile.id === props.settingsDraft?.terminalThemes.activeProfileId
      ) ?? null)
    : null;
  const selectedSshProfile =
    props.sshWorkspaceDialog?.connections?.profiles.find(
      (profile) => profile.id === props.sshWorkspaceDialog?.selectedProfileId
    ) ?? null;
  const surfaceDiagnosticCaptureEnabled = props.settingsDraft
    ? resolveSurfaceDiagnosticCaptureEnabled(
        props.settingsDraft.surfaceDiagnosticCaptureMode,
        props.surfaceDiagnosticCaptureDefaultEnabled
      )
    : false;
  const pendingCloseWorktrees = listPendingCloseWorktrees(
    props.workspaceCloseConfirm
  );
  const pendingCloseDirtyWorktrees = listPendingCloseDirtyWorktrees(
    props.workspaceCloseConfirm
  );

  useEffect(() => {
    setDiagnosticLogClearStatus("idle");
    if (props.settingsOpen) {
      setActiveSettingsCategory(props.settingsInitialCategory);
    } else {
      setRecordingShortcutCommand(null);
    }
  }, [props.settingsInitialCategory, props.settingsOpen]);

  useEffect(() => {
    setRecordingShortcutCommand(null);
  }, [activeSettingsCategory]);

  function updateShortcutBinding(command: string, binding: string): void {
    props.setSettingsDraft((current) =>
      current
        ? {
            ...current,
            shortcuts: {
              ...current.shortcuts,
              [command]: binding
            }
          }
        : current
    );
  }

  async function handleClearDiagnosticLog(): Promise<void> {
    setDiagnosticLogClearStatus("clearing");
    try {
      setDiagnosticLogClearStatus(
        (await props.onClearDiagnosticLog()) ? "cleared" : "failed"
      );
    } catch {
      setDiagnosticLogClearStatus("failed");
    }
  }

  function handleShortcutRecorderKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    command: string
  ): void {
    const isRecording = recordingShortcutCommand === command;

    if (!isRecording) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setRecordingShortcutCommand(command);
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setRecordingShortcutCommand(null);
      return;
    }

    if (isShortcutClearEvent(event)) {
      updateShortcutBinding(command, "");
      setRecordingShortcutCommand(null);
      return;
    }

    const nextBinding = formatRecordedShortcut(
      event,
      props.reservedSystemChords
    );
    if (!nextBinding) {
      return;
    }

    updateShortcutBinding(command, nextBinding);
    setRecordingShortcutCommand(null);
  }

  return (
    <>
      {props.paletteOpen ? (
        <div className={styles.overlay} onClick={props.onClosePalette}>
          <div
            className={styles.palette}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              value={props.paletteQuery}
              onChange={(event) =>
                props.onChangePaletteQuery(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (!props.paletteItems.length && event.key === "Escape") {
                  event.preventDefault();
                  props.onClosePalette();
                  return;
                }
                if (!props.paletteItems.length) {
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  props.onSelectPaletteIndex(
                    (props.paletteSelectedIndex + 1) % props.paletteItems.length
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  props.onSelectPaletteIndex(
                    (props.paletteSelectedIndex -
                      1 +
                      props.paletteItems.length) %
                      props.paletteItems.length
                  );
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.onExecutePaletteItem(props.paletteSelectedIndex);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  props.onClosePalette();
                }
              }}
              aria-label="Command palette query"
              placeholder="Search everywhere"
            />
            <div
              className={styles.paletteList}
              role="listbox"
              aria-label="Command results"
            >
              {props.paletteItems.map((item, index) => (
                <button
                  key={item.id}
                  className={styles.paletteItem}
                  data-selected={index === props.paletteSelectedIndex}
                  role="option"
                  aria-selected={index === props.paletteSelectedIndex}
                  onMouseEnter={() => props.onSelectPaletteIndex(index)}
                  onFocus={() => props.onSelectPaletteIndex(index)}
                  onClick={() => props.onExecutePaletteItem(index)}
                >
                  <span>{item.label}</span>
                  <span>{item.subtitle}</span>
                </button>
              ))}
              {!props.paletteItems.length ? (
                <div className={styles.paletteEmpty}>No matching results</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {props.workspaceContextMenu && activeWorkspaceContext ? (
        <WorkspaceContextMenu
          workspaceName={activeWorkspaceContext.row.name}
          position={props.workspaceContextMenu}
          items={props.workspaceContextMenuItems}
          shortcutLabelStyle={props.shortcutLabelStyle}
          menuRef={props.workspaceMenuRef}
          onClose={props.onCloseWorkspaceContextMenu}
          onAction={(action) =>
            props.onWorkspaceContextAction(
              action,
              activeWorkspaceContext.row.workspaceId
            )
          }
        />
      ) : null}
      {props.notificationsOpen ? (
        <NotificationsPanel
          notifications={props.notifications}
          onClose={props.onCloseNotifications}
          onJump={props.onJumpNotifications}
          onClear={props.onClearNotifications}
        />
      ) : null}
      {props.workspaceCloseConfirm ? (
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              props.onCloseWorkspaceCloseConfirm();
            }
          }}
        >
          <div
            className={styles.workspaceCloseConfirm}
            role="dialog"
            aria-modal="true"
            aria-label={
              pendingCloseWorktrees.length
                ? pendingCloseWorktrees.length > 1
                  ? "Close worktree workspaces?"
                  : "Close worktree workspace?"
                : "Close workspace?"
            }
            data-testid="workspace-close-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2>
                {pendingCloseWorktrees.length
                  ? pendingCloseWorktrees.length > 1
                    ? "Close Worktree Workspaces?"
                    : "Close Worktree Workspace?"
                  : "Close workspace?"}
              </h2>
              <button
                aria-label="Dismiss workspace close dialog"
                onClick={props.onCloseWorkspaceCloseConfirm}
                disabled={props.workspaceCloseConfirm.busy}
              >
                ×
              </button>
            </div>
            <p className={styles.confirmBody}>
              {pendingCloseWorktrees.length
                ? pendingCloseWorktrees.length > 1
                  ? "Close Workspace keeps git worktrees on disk unless you also remove them."
                  : "Close Workspace keeps the git worktree on disk unless you also remove it."
                : props.workspaceCloseConfirm.isLastWorkspace
                  ? "This workspace only has one tab left. Closing it will replace it with a new workspace."
                  : "This workspace only has one tab left. Closing it will close the workspace."}
            </p>
            {pendingCloseWorktrees.length ? (
              <div className={styles.worktreeCloseOptions}>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={props.workspaceCloseConfirm.removeWorktree}
                    disabled={props.workspaceCloseConfirm.busy}
                    onChange={(event) =>
                      props.onToggleWorkspaceCloseRemoveWorktree(
                        event.currentTarget.checked
                      )
                    }
                  />
                  <span>
                    {pendingCloseWorktrees.length > 1
                      ? "Also remove git worktrees"
                      : "Also remove git worktree"}
                  </span>
                </label>
                <div className={styles.worktreePreviewGrid}>
                  {pendingCloseWorktrees.length > 1 ? (
                    <>
                      <span>Worktrees</span>
                      <code>
                        {pendingCloseWorktrees
                          .map(
                            (entry) =>
                              `${entry.worktree.path} (${entry.worktree.branch})`
                          )
                          .join("\n")}
                      </code>
                    </>
                  ) : (
                    <>
                      <span>Worktree Path</span>
                      <code>{pendingCloseWorktrees[0]?.worktree.path}</code>
                      <span>Branch</span>
                      <code>{pendingCloseWorktrees[0]?.worktree.branch}</code>
                    </>
                  )}
                </div>
                {pendingCloseWorktrees.some(
                  (entry) => !entry.worktree.createdByKmux
                ) ? (
                  <div className={styles.worktreeWarning}>
                    {pendingCloseWorktrees.length > 1
                      ? "One or more worktrees were detected from terminal cwd, not created by kmux."
                      : "This worktree was detected from the terminal cwd, not created by kmux."}
                  </div>
                ) : null}
                {props.workspaceCloseConfirm.dirtyEntries?.length ||
                pendingCloseDirtyWorktrees.length ? (
                  <div className={styles.worktreeWarning}>
                    <strong>Uncommitted changes detected.</strong>
                    <span>
                      Confirm again to force-remove{" "}
                      {pendingCloseWorktrees.length > 1
                        ? "these worktrees."
                        : "this worktree."}
                    </span>
                    <code>
                      {formatPendingCloseDirtyEntries(
                        props.workspaceCloseConfirm.dirtyEntries,
                        pendingCloseDirtyWorktrees
                      )}
                    </code>
                  </div>
                ) : null}
                {props.workspaceCloseConfirm.error ? (
                  <div className={styles.worktreeError}>
                    {props.workspaceCloseConfirm.error}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className={styles.modalActions}>
              <button
                autoFocus
                aria-label="Cancel"
                onClick={props.onCloseWorkspaceCloseConfirm}
                disabled={props.workspaceCloseConfirm.busy}
              >
                Cancel
              </button>
              <button
                aria-label={
                  pendingCloseWorktrees.length &&
                  props.workspaceCloseConfirm.removeWorktree
                    ? "Remove and Close"
                    : "Close Workspace"
                }
                onClick={props.onConfirmWorkspaceClose}
                disabled={props.workspaceCloseConfirm.busy}
              >
                {pendingCloseWorktrees.length &&
                props.workspaceCloseConfirm.removeWorktree
                  ? props.workspaceCloseConfirm.dirtyEntries?.length ||
                    pendingCloseDirtyWorktrees.length
                    ? "Force Remove and Close"
                    : "Remove and Close"
                  : "Close Workspace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {props.surfaceRestartConfirm ? (
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              props.onCloseSurfaceRestartConfirm();
            }
          }}
        >
          <div
            className={styles.workspaceCloseConfirm}
            role="dialog"
            aria-modal="true"
            aria-label="Restart session?"
            data-testid="surface-restart-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2>Restart Session?</h2>
              <button
                aria-label="Dismiss restart session dialog"
                onClick={props.onCloseSurfaceRestartConfirm}
              >
                ×
              </button>
            </div>
            <p className={styles.confirmBody}>
              Restarting "{props.surfaceRestartConfirm.title}" will stop the
              running process and start the same surface again.
            </p>
            <div className={styles.modalActions}>
              <button
                autoFocus
                aria-label="Cancel restart session"
                onClick={props.onCloseSurfaceRestartConfirm}
              >
                Cancel
              </button>
              <button
                aria-label="Restart Session"
                onClick={props.onConfirmSurfaceRestart}
              >
                Restart Session
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {props.worktreeDialog ? (
        <WorktreeDialog
          dialog={props.worktreeDialog}
          onClose={props.onCloseWorktreeDialog}
          onDismissDetected={props.onDismissDetectedWorktree}
          onChangeName={props.onChangeWorktreeName}
          onConfirm={props.onConfirmWorktreeDialog}
        />
      ) : null}
      {props.sshAskpassPrompt ? (
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              props.onCancelSshAskpass();
            }
          }}
        >
          <form
            className={styles.workspaceCloseConfirm}
            role="dialog"
            aria-modal="true"
            aria-label="SSH Authentication"
            data-testid="ssh-askpass-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmitSshAskpass();
            }}
          >
            <div className={styles.modalHeader}>
              <h2>SSH Authentication</h2>
              <button
                type="button"
                aria-label="Cancel SSH authentication"
                onClick={props.onCancelSshAskpass}
              >
                ×
              </button>
            </div>
            <p className={styles.confirmBody}>
              <strong>{props.sshAskpassPrompt.profileName}</strong>
              <br />
              {props.sshAskpassPrompt.prompt}
            </p>
            <label className={styles.settingsRow}>
              <span className={styles.settingsRowCopy}>
                <span className={styles.settingsRowTitle}>
                  Password or passphrase
                </span>
                <span className={styles.settingsRowDescription}>
                  Used once by system OpenSSH and never saved in kmux settings.
                </span>
              </span>
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                aria-label="SSH password or passphrase"
                value={props.sshAskpassPrompt.response}
                onChange={(event) =>
                  props.onChangeSshAskpassResponse(event.currentTarget.value)
                }
              />
            </label>
            <div className={styles.modalActions}>
              <button type="button" onClick={props.onCancelSshAskpass}>
                Cancel
              </button>
              <button type="submit" disabled={!props.sshAskpassPrompt.response}>
                Continue
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {props.sshWorkspaceDialog ? (
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              props.onCloseSshWorkspaceDialog();
            }
          }}
        >
          <div
            className={`${styles.workspaceCloseConfirm} ${styles.sshWorkspaceDialog}`}
            role="dialog"
            aria-modal="true"
            aria-label="SSH Workspace"
            data-testid="ssh-workspace-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.sshWorkspaceDialogHeader}>
              <span>
                <h2>Connect through SSH</h2>
                <p>
                  Choose a saved connection, then decide what to do with this
                  workspace.
                </p>
              </span>
              <button
                type="button"
                aria-label="Close SSH workspace dialog"
                onClick={props.onCloseSshWorkspaceDialog}
                disabled={props.sshWorkspaceDialog.phase === "committing"}
              >
                ×
              </button>
            </header>
            <div className={styles.sshWorkspaceDialogBody}>
              <section
                className={styles.sshWorkspaceDialogSection}
                aria-labelledby="ssh-workspace-connection-title"
              >
                <div className={styles.sshWorkspaceDialogSectionHeader}>
                  <h3 id="ssh-workspace-connection-title">SSH connection</h3>
                  <p>Saved profiles are resolved by your system OpenSSH.</p>
                </div>
                <div className={styles.sshWorkspaceConnectionControl}>
                  <select
                    aria-label="SSH connection"
                    value={props.sshWorkspaceDialog.selectedProfileId ?? ""}
                    disabled={
                      props.sshWorkspaceDialog.phase !== "idle" ||
                      !props.sshWorkspaceDialog.connections?.profiles.length
                    }
                    onChange={(event) =>
                      props.onSelectSshProfile(event.currentTarget.value)
                    }
                  >
                    {!props.sshWorkspaceDialog.connections ? (
                      <option value="">Loading connections…</option>
                    ) : props.sshWorkspaceDialog.connections.profiles.length ? (
                      props.sshWorkspaceDialog.connections.profiles.map(
                        (profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        )
                      )
                    ) : (
                      <option value="">No saved SSH connections</option>
                    )}
                  </select>
                  {selectedSshProfile ? (
                    <code className={styles.sshWorkspaceConnectionRoute}>
                      {selectedSshProfile.effectiveConnection
                        ? `${selectedSshProfile.effectiveConnection.user}@${selectedSshProfile.effectiveConnection.hostName}:${selectedSshProfile.effectiveConnection.port}`
                        : (selectedSshProfile.sshConfigHost ??
                          selectedSshProfile.host)}
                    </code>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.sshWorkspaceManageButton}
                  onClick={props.onManageSshConnections}
                  disabled={props.sshWorkspaceDialog.phase !== "idle"}
                >
                  {props.sshWorkspaceDialog.connections?.profiles.length
                    ? "Manage SSH connections"
                    : "Create SSH connection"}
                </button>
              </section>
              <section
                className={styles.sshWorkspaceDialogSection}
                aria-labelledby="ssh-workspace-action-title"
              >
                <div className={styles.sshWorkspaceDialogSectionHeader}>
                  <h3 id="ssh-workspace-action-title">Workspace action</h3>
                  <p>Choose what happens after the remote host is ready.</p>
                </div>
                <div className={styles.sshWorkspaceChoices}>
                  <label
                    className={styles.sshWorkspaceChoice}
                    data-selected={
                      props.sshWorkspaceDialog.continuation === "convert"
                        ? "true"
                        : undefined
                    }
                    data-disabled={
                      props.sshWorkspaceDialog.sourceTargetKind !== "local"
                        ? "true"
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="ssh-workspace-continuation"
                      checked={
                        props.sshWorkspaceDialog.continuation === "convert"
                      }
                      disabled={
                        props.sshWorkspaceDialog.phase !== "idle" ||
                        props.sshWorkspaceDialog.sourceTargetKind !== "local"
                      }
                      onChange={() => props.onSelectSshContinuation("convert")}
                    />
                    <span>
                      <strong>Convert this workspace</strong>
                      <span>
                        Replaces its local sessions and panes only after the SSH
                        workspace is ready.
                      </span>
                    </span>
                  </label>
                  <label
                    className={styles.sshWorkspaceChoice}
                    data-selected={
                      props.sshWorkspaceDialog.continuation === "create"
                        ? "true"
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="ssh-workspace-continuation"
                      checked={
                        props.sshWorkspaceDialog.continuation === "create"
                      }
                      disabled={props.sshWorkspaceDialog.phase !== "idle"}
                      onChange={() => props.onSelectSshContinuation("create")}
                    />
                    <span>
                      <strong>Create a new SSH workspace</strong>
                      <span>
                        Keeps this workspace and every running session
                        unchanged.
                      </span>
                    </span>
                  </label>
                </div>
              </section>
              {props.sshWorkspaceDialog.phase !== "idle" ? (
                <div
                  className={styles.sshWorkspaceProgress}
                  data-phase={props.sshWorkspaceDialog.phase}
                  role="status"
                >
                  <span aria-hidden="true" />
                  <span>
                    <strong>
                      {props.sshWorkspaceDialog.phase === "preparing"
                        ? "Checking the remote host"
                        : "Creating the SSH workspace"}
                    </strong>
                    <span>
                      {props.sshWorkspaceDialog.phase === "preparing"
                        ? "Authentication, authority, and runtime are being verified. You can still cancel."
                        : "The remote workspace is being committed. This cannot be cancelled."}
                    </span>
                  </span>
                </div>
              ) : null}
              {props.sshWorkspaceDialog.error ? (
                <div className={styles.sshWorkspaceError} role="alert">
                  {props.sshWorkspaceDialog.error}
                </div>
              ) : null}
            </div>
            <div
              className={`${styles.modalActions} ${styles.sshWorkspaceDialogActions}`}
            >
              <button
                type="button"
                onClick={props.onCloseSshWorkspaceDialog}
                disabled={props.sshWorkspaceDialog.phase === "committing"}
              >
                Cancel
              </button>
              <button
                type="button"
                data-primary="true"
                onClick={props.onConfirmSshWorkspace}
                disabled={
                  props.sshWorkspaceDialog.phase !== "idle" ||
                  !props.sshWorkspaceDialog.selectedProfileId
                }
              >
                {props.sshWorkspaceDialog.continuation === "convert"
                  ? "Convert workspace"
                  : "Create SSH workspace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {props.settingsOpen && props.settingsDraft ? (
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              props.onCloseSettings();
            }
          }}
        >
          <div
            className={styles.settings}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            data-testid="settings-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2>Settings</h2>
              <div className={styles.modalHeaderActions}>
                <button
                  type="button"
                  className={styles.settingsJsonButton}
                  onClick={() => void props.onOpenSettingsJson()}
                >
                  Open settings.json
                </button>
                <button
                  type="button"
                  aria-label="Close settings"
                  onClick={props.onCloseSettings}
                >
                  ×
                </button>
              </div>
            </div>
            <div className={styles.settingsBody} data-testid="settings-body">
              <aside
                className={styles.settingsRail}
                aria-label="Settings categories"
              >
                {SETTINGS_CATEGORIES.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={styles.settingsRailItem}
                    data-active={activeSettingsCategory === category.id}
                    aria-pressed={activeSettingsCategory === category.id}
                    onClick={() => setActiveSettingsCategory(category.id)}
                  >
                    <span>{category.label}</span>
                    <span>{category.description}</span>
                  </button>
                ))}
              </aside>
              <div
                key={activeSettingsCategory}
                className={styles.settingsPanel}
                data-testid="settings-panel"
              >
                {activeSettingsCategory === "general" ? (
                  <div className={styles.settingsCategory}>
                    <div className={styles.settingsCategoryHeader}>
                      <h3>General</h3>
                      <p>
                        Common app behavior and the first things people tune
                        when kmux feels too bright, too dark, or too eager to
                        close.
                      </p>
                    </div>
                    <section className={styles.settingsShowcase}>
                      <div className={styles.settingsShowcaseHeader}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            App theme
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Follow macOS or choose a fixed light or dark
                            appearance.
                          </span>
                        </span>
                      </div>
                      <div
                        className={styles.appearanceChoiceGrid}
                        role="radiogroup"
                        aria-label="Theme mode"
                      >
                        {THEME_MODE_CHOICES.map((choice) => (
                          <button
                            key={choice.id}
                            type="button"
                            role="radio"
                            aria-checked={
                              props.settingsDraft?.themeMode === choice.id
                            }
                            className={styles.appearanceChoice}
                            data-selected={
                              props.settingsDraft?.themeMode === choice.id
                            }
                            data-mode={choice.id}
                            onClick={() => {
                              updateSettingsDraft(props.setSettingsDraft, {
                                themeMode: choice.id
                              });
                            }}
                          >
                            <span
                              className={styles.appearancePreview}
                              aria-hidden="true"
                            >
                              <span className={styles.appearanceBackdrop} />
                              <span className={styles.appearanceWindow}>
                                <span className={styles.appearanceTitlebar}>
                                  <span />
                                  <span />
                                  <span />
                                </span>
                                <span className={styles.appearanceBody}>
                                  <span className={styles.appearanceSidebar} />
                                  <span className={styles.appearanceTerminal}>
                                    <span />
                                    <span />
                                    <span />
                                  </span>
                                </span>
                              </span>
                            </span>
                            <span className={styles.appearanceChoiceCopy}>
                              <span>{choice.label}</span>
                              <span>{choice.description}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                    <div className={styles.settingsRowGroup}>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Warn before quit
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Ask before quitting while agent sessions may still
                            be running.
                          </span>
                        </span>
                        <input
                          aria-label="Warn before quit"
                          type="checkbox"
                          checked={props.settingsDraft.warnBeforeQuit}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              warnBeforeQuit: event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Restore workspaces after quitting
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Reopen the last workspace, pane, and tab layout on
                            the next launch.
                          </span>
                        </span>
                        <input
                          aria-label="Restore workspaces after quitting"
                          type="checkbox"
                          checked={
                            props.settingsDraft.restoreWorkspacesAfterQuit
                          }
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              restoreWorkspacesAfterQuit:
                                event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
                    </div>
                    <div className={styles.settingsCategoryHeader}>
                      <h3>Debugging</h3>
                    </div>
                    <div className={styles.settingsRowGroup}>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Enable diagnostic capture
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Adds Capture Diagnostics to terminal context menus.
                            Captures may include terminal text, screenshots, and
                            rendering state.
                          </span>
                        </span>
                        <input
                          aria-label="Enable diagnostic capture"
                          type="checkbox"
                          checked={surfaceDiagnosticCaptureEnabled}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              surfaceDiagnosticCaptureMode: event.currentTarget
                                .checked
                                ? "enabled"
                                : "disabled"
                            });
                          }}
                        />
                      </div>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Enable logging
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Writes structured app and terminal diagnostics to
                            <code className={styles.settingsInlinePath}>
                              {props.diagnosticLogPath ?? "kmux-debug.log"}
                            </code>
                            . Logs may include paths, session metadata, and
                            terminal notification text.
                          </span>
                        </span>
                        <input
                          aria-label="Enable logging"
                          type="checkbox"
                          checked={props.settingsDraft.diagnosticLoggingEnabled}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              diagnosticLoggingEnabled:
                                event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Stored diagnostic log
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Removes the current kmux-debug.log without changing
                            the logging setting.
                            <span aria-live="polite">
                              {diagnosticLogClearStatus === "cleared"
                                ? " Log cleared."
                                : diagnosticLogClearStatus === "failed"
                                  ? " Could not clear the log."
                                  : ""}
                            </span>
                          </span>
                        </span>
                        <button
                          type="button"
                          className={styles.settingsRowButton}
                          disabled={diagnosticLogClearStatus === "clearing"}
                          onClick={() => void handleClearDiagnosticLog()}
                        >
                          {diagnosticLogClearStatus === "clearing"
                            ? "Clearing…"
                            : "Clear log"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeSettingsCategory === "ssh" ? (
                  <SshConnectionsSettings />
                ) : null}
                {activeSettingsCategory === "terminal" ? (
                  <div className={styles.settingsCategory}>
                    <div className={styles.settingsCategoryHeader}>
                      <h3>Terminal</h3>
                      <p>
                        Tune terminal colors, typography, and renderer behavior
                        for long-running agent output.
                      </p>
                    </div>
                    <div className={styles.settingsSection}>
                      <div className={styles.settingsSectionHeader}>
                        <span>Terminal theme</span>
                        {activeTerminalTheme ? (
                          <span className={styles.settingsSectionMeta}>
                            {activeTerminalTheme.source}
                          </span>
                        ) : null}
                      </div>
                      <label className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Active terminal theme
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Used by all new and existing terminal panes.
                          </span>
                        </span>
                        <select
                          aria-label="Active terminal theme"
                          value={
                            props.settingsDraft.terminalThemes.activeProfileId
                          }
                          onChange={(event) =>
                            props.onSelectTerminalTheme(
                              event.currentTarget.value
                            )
                          }
                        >
                          {props.settingsDraft.terminalThemes.profiles.map(
                            (profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.name}
                              </option>
                            )
                          )}
                        </select>
                      </label>
                      <div className={styles.themeImportGuide}>
                        <div className={styles.themeImportGuideHeader}>
                          <span>.itermcolors</span>
                          <strong>iTerm2 color preset import</strong>
                        </div>
                        <p>
                          Bring an iTerm2 color preset into kmux. This changes
                          terminal colors only, so fonts, shell settings, pane
                          layout, and agent sessions stay untouched.
                        </p>
                        <dl className={styles.themeImportScope}>
                          <div>
                            <dt>Imports</dt>
                            <dd>Terminal color palette</dd>
                          </div>
                          <div>
                            <dt>Does not import</dt>
                            <dd>Fonts, shell profiles, pane layout</dd>
                          </div>
                        </dl>
                      </div>
                      <div className={styles.terminalThemeActions}>
                        <button
                          type="button"
                          aria-label="Import iTerm2 preset"
                          onClick={props.onImportTerminalTheme}
                        >
                          Import .itermcolors
                        </button>
                        <button
                          type="button"
                          aria-label="Duplicate terminal theme"
                          onClick={props.onDuplicateTerminalTheme}
                        >
                          Duplicate theme
                        </button>
                        <button
                          type="button"
                          aria-label="Delete terminal theme"
                          onClick={props.onDeleteTerminalTheme}
                          disabled={activeTerminalTheme?.source === "builtin"}
                        >
                          Delete theme
                        </button>
                      </div>
                      <div className={styles.terminalThemeActions}>
                        <button
                          type="button"
                          aria-label="Replace dark terminal theme"
                          onClick={() =>
                            props.onReplaceTerminalThemeVariant("dark")
                          }
                        >
                          Replace dark colors
                        </button>
                        <button
                          type="button"
                          aria-label="Replace light terminal theme"
                          onClick={() =>
                            props.onReplaceTerminalThemeVariant("light")
                          }
                        >
                          Replace light colors
                        </button>
                        <button
                          type="button"
                          aria-label="Export dark terminal theme"
                          onClick={() =>
                            props.onExportTerminalThemeVariant("dark")
                          }
                        >
                          Export dark colors
                        </button>
                        <button
                          type="button"
                          aria-label="Export light terminal theme"
                          onClick={() =>
                            props.onExportTerminalThemeVariant("light")
                          }
                        >
                          Export light colors
                        </button>
                      </div>
                      {activeTerminalTheme ? (
                        <label className={styles.settingsRow}>
                          <span className={styles.settingsRowCopy}>
                            <span className={styles.settingsRowTitle}>
                              Minimum text contrast
                            </span>
                            <span className={styles.settingsRowDescription}>
                              iTerm2-style guard that keeps terminal text
                              readable when theme colors are too close to the
                              background.
                            </span>
                          </span>
                          <span className={styles.settingsRangeControl}>
                            <input
                              aria-label="Minimum text contrast"
                              type="range"
                              min="1"
                              max="21"
                              step="0.5"
                              value={activeTerminalTheme.minimumContrastRatio}
                              onChange={(event) =>
                                props.onSetTerminalThemeContrast(
                                  Number(event.currentTarget.value)
                                )
                              }
                            />
                            <output aria-label="Current minimum text contrast">
                              {activeTerminalTheme.minimumContrastRatio}
                            </output>
                          </span>
                        </label>
                      ) : null}
                      {props.settingsThemeNotice ? (
                        <div className={styles.settingsNotice}>
                          {props.settingsThemeNotice}
                        </div>
                      ) : null}
                      {props.terminalThemePreview ? (
                        <div
                          className={styles.terminalThemePreview}
                          data-testid="terminal-theme-preview"
                          data-variant={props.terminalThemePreview.variant}
                          style={{
                            background:
                              props.terminalThemePreview.palette.background,
                            color: props.terminalThemePreview.palette.foreground
                          }}
                        >
                          <div className={styles.terminalThemePreviewHeader}>
                            <span>
                              {props.terminalThemePreview.profileName}
                            </span>
                            <span>
                              {props.terminalThemePreview.variant} · text
                              contrast{" "}
                              {props.terminalThemePreview.minimumContrastRatio}
                            </span>
                          </div>
                          <div className={styles.terminalThemePreviewBody}>
                            <div>plain text: ~/src/kmux $ echo hello</div>
                            <div className={styles.terminalThemePreviewDim}>
                              dim text: last login, hints, and secondary prompt
                              copy
                            </div>
                            <div className={styles.terminalThemePreviewLine}>
                              <span
                                style={{
                                  color:
                                    props.terminalThemePreview.palette.ansi[2]
                                }}
                              >
                                success
                              </span>
                              <span
                                style={{
                                  color:
                                    props.terminalThemePreview.palette.ansi[3]
                                }}
                              >
                                warning
                              </span>
                              <span
                                style={{
                                  color:
                                    props.terminalThemePreview.palette.ansi[1]
                                }}
                              >
                                error
                              </span>
                              <span
                                style={{
                                  color:
                                    props.terminalThemePreview.palette.ansi[4]
                                }}
                              >
                                info
                              </span>
                            </div>
                            <div
                              className={styles.terminalThemePreviewSelection}
                              style={{
                                background:
                                  props.terminalThemePreview.palette
                                    .selectionBackground,
                                color:
                                  props.terminalThemePreview.palette
                                    .selectionForeground
                              }}
                            >
                              selected text sample
                            </div>
                            <div className={styles.terminalThemeAnsiGrid}>
                              {props.terminalThemePreview.palette.ansi.map(
                                (color, index) => (
                                  <span
                                    key={`${color}-${index}`}
                                    className={styles.terminalThemeAnsiSwatch}
                                    style={{ background: color }}
                                    title={`ANSI ${index}`}
                                  />
                                )
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className={styles.settingsSection}>
                      <div className={styles.settingsSectionHeader}>
                        <span>Typography and renderer</span>
                      </div>
                      <label className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Text font
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Terminal monospace font. kmux keeps its built-in
                            glyph fallback at the end of the stack.
                          </span>
                        </span>
                        <input
                          aria-label="Text font"
                          type="text"
                          value={
                            props.settingsDraft.terminalTypography
                              .preferredTextFontFamily
                          }
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              terminalTypography: {
                                preferredTextFontFamily:
                                  event.currentTarget.value
                              }
                            });
                          }}
                        />
                      </label>
                      <label className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Font size
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Affects all terminal panes.
                          </span>
                        </span>
                        <input
                          aria-label="Font size"
                          type="number"
                          min="8"
                          max="32"
                          value={
                            props.settingsDraft.terminalTypography.fontSize
                          }
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              terminalTypography: {
                                fontSize: Number(event.currentTarget.value)
                              }
                            });
                          }}
                        />
                      </label>
                      <label className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Line height
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Use more space if agent output feels cramped.
                          </span>
                        </span>
                        <input
                          aria-label="Line height"
                          type="number"
                          min="0.8"
                          max="2"
                          step="0.05"
                          value={
                            props.settingsDraft.terminalTypography.lineHeight
                          }
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              terminalTypography: {
                                lineHeight: Number(event.currentTarget.value)
                              }
                            });
                          }}
                        />
                      </label>
                      {props.terminalTypographyPreview ? (
                        <div
                          className={styles.terminalTypographyPreview}
                          data-testid="terminal-typography-preview"
                        >
                          <div
                            className={styles.terminalTypographyPreviewHeader}
                          >
                            <span>Terminal glyphs</span>
                            <span
                              className={styles.terminalTypographyStatus}
                              data-status={
                                props.terminalTypographyPreview.status
                              }
                            >
                              {describeTerminalTypographyStatus(
                                props.terminalTypographyPreview
                              )}
                            </span>
                          </div>
                          <div
                            className={styles.terminalTypographyHeadline}
                            data-status={props.terminalTypographyPreview.status}
                          >
                            {describeTerminalTypographyHeadline(
                              props.terminalTypographyPreview
                            )}
                          </div>
                          <div
                            className={
                              props.terminalTypographyPreview.issues.length
                                ? styles.terminalTypographyIssues
                                : styles.terminalTypographyHint
                            }
                          >
                            {describeTerminalTypographySupportLines(
                              props.terminalTypographyPreview
                            ).map((line) => (
                              <div key={line}>{line}</div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {activeSettingsCategory === "notifications" ? (
                  <div className={styles.settingsCategory}>
                    <div className={styles.settingsCategoryHeader}>
                      <h3>Notifications</h3>
                      <p>
                        Choose how kmux gets your attention when terminal
                        sessions signal activity.
                      </p>
                    </div>
                    <div className={styles.settingsRowGroup}>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Desktop notifications
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Notify when an agent session needs attention.
                          </span>
                        </span>
                        <input
                          aria-label="Desktop notifications"
                          type="checkbox"
                          checked={props.settingsDraft.notificationDesktop}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              notificationDesktop: event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Bell sounds
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Play a short sound when a terminal bell event fires.
                          </span>
                        </span>
                        <input
                          aria-label="Bell sounds"
                          type="checkbox"
                          checked={props.settingsDraft.notificationSound}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              notificationSound: event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeSettingsCategory === "shortcuts" ? (
                  <div className={styles.settingsCategory}>
                    <div className={styles.settingsCategoryHeader}>
                      <h3>Shortcuts</h3>
                      <p>
                        Click a shortcut field, then press the key combination.
                        Esc cancels and Backspace clears the current binding.
                      </p>
                    </div>
                    <div className={styles.shortcutsEditor}>
                      {Object.entries(props.settingsDraft.shortcuts)
                        .filter(
                          ([command]) =>
                            command !== "workspace.switcher" &&
                            command !== "pane.zoom"
                        )
                        .map(([command, binding]) => {
                          const shortcutLabel = SHORTCUT_LABELS[command] ?? {
                            label: command,
                            detail: command
                          };
                          const isRecording =
                            recordingShortcutCommand === command;
                          const visibleBinding =
                            formatShortcutLabel(
                              binding,
                              props.shortcutLabelStyle,
                              {
                                separator:
                                  props.shortcutLabelStyle === "mac-symbols"
                                    ? " "
                                    : undefined
                              }
                            ) ?? "Unassigned";
                          return (
                            <div
                              key={command}
                              className={styles.shortcutEditorItem}
                            >
                              <span className={styles.shortcutCopy}>
                                <span>{shortcutLabel.label}</span>
                                <span>{shortcutLabel.detail}</span>
                              </span>
                              <button
                                type="button"
                                aria-label={`${shortcutLabel.label} shortcut`}
                                className={styles.shortcutRecorder}
                                data-empty={binding ? undefined : "true"}
                                data-recording={isRecording ? "true" : "false"}
                                data-shortcut-recorder={
                                  isRecording ? "" : undefined
                                }
                                onClick={() =>
                                  setRecordingShortcutCommand(command)
                                }
                                onBlur={() => {
                                  if (recordingShortcutCommand === command) {
                                    setRecordingShortcutCommand(null);
                                  }
                                }}
                                onKeyDown={(event) =>
                                  handleShortcutRecorderKeyDown(event, command)
                                }
                                title={
                                  binding
                                    ? `${visibleBinding} (${binding})`
                                    : visibleBinding
                                }
                              >
                                {isRecording ? (
                                  <span
                                    className={styles.shortcutRecorderPrompt}
                                  >
                                    Press keys...
                                  </span>
                                ) : (
                                  <span
                                    className={
                                      binding
                                        ? styles.shortcutBindingText
                                        : styles.shortcutUnassigned
                                    }
                                  >
                                    {visibleBinding}
                                  </span>
                                )}
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className={styles.modalActions}>
              <button aria-label="Cancel" onClick={props.onCloseSettings}>
                Cancel
              </button>
              <button
                aria-label="Save"
                onClick={() => {
                  if (props.settingsDraft) {
                    props.onSaveSettings(props.settingsDraft);
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function listPendingCloseWorktrees(
  pending: AppOverlaysProps["workspaceCloseConfirm"]
): Array<{ workspaceId: string; worktree: WorkspaceWorktreeMetadata }> {
  if (!pending) {
    return [];
  }
  if (pending.worktrees?.length) {
    return pending.worktrees;
  }
  return pending.worktree
    ? [
        {
          workspaceId: pending.workspaceId,
          worktree: pending.worktree
        }
      ]
    : [];
}

function listPendingCloseDirtyWorktrees(
  pending: AppOverlaysProps["workspaceCloseConfirm"]
): WorktreeDirtyEntryGroup[] {
  return pending?.dirtyWorktrees ?? [];
}

function formatPendingCloseDirtyEntries(
  dirtyEntries: string[] | undefined,
  dirtyWorktrees: WorktreeDirtyEntryGroup[]
): string {
  if (dirtyWorktrees.length) {
    return dirtyWorktrees
      .map(
        (entry) =>
          `${entry.path}\n${entry.dirtyEntries
            .map((dirtyEntry) => `  ${dirtyEntry}`)
            .join("\n")}`
      )
      .join("\n\n");
  }
  return dirtyEntries?.join("\n") ?? "";
}

function WorktreeDialog(props: {
  dialog: NonNullable<AppOverlaysProps["worktreeDialog"]>;
  onClose: () => void;
  onDismissDetected: () => void;
  onChangeName: (name: string) => void;
  onConfirm: () => void;
}): JSX.Element {
  const createDialog = props.dialog.kind === "create" ? props.dialog : null;
  const detectedDialog = props.dialog.kind === "detected" ? props.dialog : null;
  const preview = createDialog
    ? {
        from: createDialog.preview.from,
        repoPath: createDialog.preview.repoRoot,
        worktreePath: previewPathForName(
          createDialog.preview,
          createDialog.name
        ),
        branch: createDialog.name ? `kmux/${createDialog.name}` : ""
      }
    : {
        from: detectedDialog?.row.detectedWorktree?.baseRef ?? "-",
        repoPath: detectedDialog?.row.detectedWorktree?.repoRoot ?? "-",
        worktreePath: detectedDialog?.row.detectedWorktree?.path ?? "-",
        branch: detectedDialog?.row.detectedWorktree?.branch ?? "-"
      };
  const closeDialog = createDialog ? props.onClose : props.onDismissDetected;

  return (
    <div
      className={`${styles.overlay} ${styles.settingsOverlay}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <div
        className={styles.workspaceCloseConfirm}
        role="dialog"
        aria-modal="true"
        aria-label={
          createDialog ? "Convert to Worktree Workspace" : "Worktree detected"
        }
        data-testid="worktree-conversion-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h2>
            {createDialog
              ? "Convert to Worktree Workspace"
              : "Worktree detected"}
          </h2>
          <button
            aria-label="Dismiss worktree dialog"
            onClick={closeDialog}
            disabled={props.dialog.busy}
          >
            ×
          </button>
        </div>
        {createDialog ? (
          <label className={styles.worktreeNameField}>
            <span>Name</span>
            <input
              autoFocus
              value={createDialog.name}
              disabled={createDialog.busy}
              onChange={(event) =>
                props.onChangeName(event.currentTarget.value)
              }
            />
          </label>
        ) : (
          <p className={styles.confirmBody}>
            This workspace is already inside a linked git worktree.
          </p>
        )}
        <div className={styles.worktreePreviewGrid}>
          <span>From</span>
          <code>{preview.from}</code>
          <span>Repository Path</span>
          <code>{preview.repoPath}</code>
          <span>Worktree Path</span>
          <code>{preview.worktreePath}</code>
          <span>Branch</span>
          <code>{preview.branch}</code>
        </div>
        {props.dialog.error ? (
          <div className={styles.worktreeError}>{props.dialog.error}</div>
        ) : null}
        <div className={styles.modalActions}>
          {createDialog ? (
            <button
              aria-label="Cancel"
              onClick={props.onClose}
              disabled={props.dialog.busy}
            >
              Cancel
            </button>
          ) : (
            <button
              aria-label="Not now"
              onClick={props.onDismissDetected}
              disabled={props.dialog.busy}
            >
              Not now
            </button>
          )}
          <button
            aria-label={createDialog ? "Create" : "Convert"}
            onClick={props.onConfirm}
            disabled={
              props.dialog.busy ||
              Boolean(createDialog && !createDialog.name.trim())
            }
          >
            {createDialog ? "Create" : "Convert"}
          </button>
        </div>
      </div>
    </div>
  );
}

function previewPathForName(
  preview: WorktreeConversionPreview,
  name: string
): string {
  if (preview.path.endsWith(`/${preview.name}`)) {
    return (
      preview.path.slice(0, preview.path.length - preview.name.length) + name
    );
  }
  return preview.path;
}

function updateSettingsDraft(
  setSettingsDraft: Dispatch<SetStateAction<KmuxSettings | undefined>>,
  patch: SettingsDraftPatch
): void {
  setSettingsDraft((current) =>
    current
      ? {
          ...current,
          ...patch,
          shortcuts: patch.shortcuts
            ? {
                ...current.shortcuts,
                ...patch.shortcuts
              }
            : current.shortcuts,
          terminalTypography: patch.terminalTypography
            ? {
                ...current.terminalTypography,
                ...patch.terminalTypography
              }
            : current.terminalTypography,
          terminalThemes: patch.terminalThemes
            ? {
                ...current.terminalThemes,
                ...patch.terminalThemes
              }
            : current.terminalThemes
        }
      : current
  );
}
