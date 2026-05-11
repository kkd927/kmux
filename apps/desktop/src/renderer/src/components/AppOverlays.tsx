import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction
} from "react";

import type {
  KmuxSettings,
  NotificationItem,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm
} from "@kmux/proto";
import type { TerminalThemeVariant } from "@kmux/proto";
import { normalizeShortcut } from "@kmux/ui";

import type {
  WorkspaceContext,
  WorkspaceContextAction,
  WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";
import type { WorkspaceContextMenuState } from "../hooks/useWorkspaceContextMenu";
import { formatShortcutLabel } from "../shortcutLabels";
import styles from "../styles/App.module.css";
import {
  describeTerminalTypographyHeadline,
  describeTerminalTypographyStatus,
  describeTerminalTypographySupportLines
} from "../terminalTypography";
import { NotificationsPanel } from "./NotificationsPanel";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";

interface AppOverlaysProps {
  isMac: boolean;
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
    isLastWorkspace: boolean;
  } | null;
  onCloseWorkspaceCloseConfirm: () => void;
  onConfirmWorkspaceClose: () => void;
  settingsOpen: boolean;
  settingsDraft: KmuxSettings | undefined;
  setSettingsDraft: Dispatch<SetStateAction<KmuxSettings | undefined>>;
  settingsThemeNotice: string | null;
  availableTerminalFontFamilies: string[];
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

function formatRecordedShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >
): string | null {
  if (isModifierOnlyShortcutEvent(event)) {
    return null;
  }
  return normalizeShortcut(event);
}

export function AppOverlays(props: AppOverlaysProps): JSX.Element {
  const [activeSettingsCategory, setActiveSettingsCategory] =
    useState<SettingsCategoryId>("general");
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

  useEffect(() => {
    if (props.settingsOpen) {
      setActiveSettingsCategory("general");
    } else {
      setRecordingShortcutCommand(null);
    }
  }, [props.settingsOpen]);

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

    const nextBinding = formatRecordedShortcut(event);
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
          isMac={props.isMac}
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
            aria-label="Close workspace?"
            data-testid="workspace-close-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2>Close workspace?</h2>
              <button
                aria-label="Dismiss workspace close dialog"
                onClick={props.onCloseWorkspaceCloseConfirm}
              >
                ×
              </button>
            </div>
            <p className={styles.confirmBody}>
              {props.workspaceCloseConfirm.isLastWorkspace
                ? "This workspace only has one tab left. Closing it will replace it with a new workspace."
                : "This workspace only has one tab left. Closing it will close the workspace."}
            </p>
            <div className={styles.modalActions}>
              <button
                autoFocus
                aria-label="Cancel"
                onClick={props.onCloseWorkspaceCloseConfirm}
              >
                Cancel
              </button>
              <button
                aria-label="Close Workspace"
                onClick={props.onConfirmWorkspaceClose}
              >
                Close Workspace
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
                    </div>
                  </div>
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
                            <span>{props.terminalThemePreview.profileName}</span>
                            <span>
                              {props.terminalThemePreview.variant} · text
                              contrast{" "}
                              {
                                props.terminalThemePreview
                                  .minimumContrastRatio
                              }
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
                              className={
                                styles.terminalThemePreviewSelection
                              }
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
                                    className={
                                      styles.terminalThemeAnsiSwatch
                                    }
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
                            Terminal monospace font. Glyph fallback stays
                            automatic.
                          </span>
                        </span>
                        <input
                          aria-label="Text font"
                          type="text"
                          list="terminal-font-families"
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
                      <datalist id="terminal-font-families">
                        {props.availableTerminalFontFamilies.map(
                          (fontFamily) => (
                            <option key={fontFamily} value={fontFamily} />
                          )
                        )}
                      </datalist>
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
                      <div className={styles.settingsRow}>
                        <span className={styles.settingsRowCopy}>
                          <span className={styles.settingsRowTitle}>
                            Hardware-accelerated renderer
                          </span>
                          <span className={styles.settingsRowDescription}>
                            Uses WebGL for smoother terminal drawing. Turn this
                            off only if text looks soft or blurry on your
                            display.
                          </span>
                        </span>
                        <input
                          aria-label="Use WebGL terminal renderer"
                          type="checkbox"
                          checked={props.settingsDraft.terminalUseWebgl}
                          onChange={(event) => {
                            updateSettingsDraft(props.setSettingsDraft, {
                              terminalUseWebgl: event.currentTarget.checked
                            });
                          }}
                        />
                      </div>
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
                            data-status={
                              props.terminalTypographyPreview.status
                            }
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
                              notificationDesktop:
                                event.currentTarget.checked
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
                            formatShortcutLabel(binding, props.isMac, {
                              separator: props.isMac ? " " : undefined
                            }) ?? "Unassigned";
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
