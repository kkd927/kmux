import type { Dispatch, RefObject, SetStateAction } from "react";

import type {
  KmuxSettings,
  NotificationItem,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm
} from "@kmux/proto";
import type { TerminalThemeVariant } from "@kmux/proto";

import type {
  WorkspaceContext,
  WorkspaceContextAction,
  WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";
import type { WorkspaceContextMenuState } from "../hooks/useWorkspaceContextMenu";
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
  onCloseSettings: () => void;
  onSaveSettings: (settingsDraft: KmuxSettings) => void;
}

type SettingsDraftPatch = Partial<
  Omit<KmuxSettings, "terminalTypography" | "terminalThemes">
> & {
  terminalTypography?: Partial<KmuxSettings["terminalTypography"]>;
  terminalThemes?: Partial<KmuxSettings["terminalThemes"]>;
};

export function AppOverlays(props: AppOverlaysProps): JSX.Element {
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
              <button
                aria-label="Close settings"
                onClick={props.onCloseSettings}
              >
                ×
              </button>
            </div>
            <div className={styles.settingsBody} data-testid="settings-body">
              <label>
                Theme mode
                <select
                  aria-label="Theme mode"
                  value={props.settingsDraft.themeMode}
                  onChange={(event) => {
                    const themeMode = event.currentTarget
                      .value as KmuxSettings["themeMode"];
                    updateSettingsDraft(props.setSettingsDraft, {
                      themeMode
                    });
                  }}
                >
                  <option value="system">system</option>
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                </select>
              </label>
              <label>
                Socket mode
                <select
                  aria-label="Socket mode"
                  value={props.settingsDraft.socketMode}
                  onChange={(event) => {
                    const socketMode = event.currentTarget
                      .value as KmuxSettings["socketMode"];
                    updateSettingsDraft(props.setSettingsDraft, {
                      socketMode
                    });
                  }}
                >
                  <option value="kmuxOnly">kmuxOnly</option>
                  <option value="allowAll">allowAll</option>
                  <option value="off">off</option>
                </select>
              </label>
              <label>
                Startup restore
                <input
                  aria-label="Startup restore"
                  type="checkbox"
                  checked={props.settingsDraft.startupRestore}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      startupRestore: event.currentTarget.checked
                    });
                  }}
                />
              </label>
              <label>
                Desktop notifications
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
              </label>
              <label>
                Bell sounds
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
              </label>
              <div className={styles.settingsSection}>
                <div className={styles.settingsSectionHeader}>
                  <span>Terminal theme</span>
                  {activeTerminalTheme ? (
                    <span className={styles.settingsSectionMeta}>
                      {activeTerminalTheme.source}
                    </span>
                  ) : null}
                </div>
                <label>
                  Active terminal theme
                  <select
                    aria-label="Active terminal theme"
                    value={props.settingsDraft.terminalThemes.activeProfileId}
                    onChange={(event) =>
                      props.onSelectTerminalTheme(event.currentTarget.value)
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
                    Duplicate
                  </button>
                  <button
                    type="button"
                    aria-label="Delete terminal theme"
                    onClick={props.onDeleteTerminalTheme}
                    disabled={activeTerminalTheme?.source === "builtin"}
                  >
                    Delete
                  </button>
                </div>
                <div className={styles.terminalThemeActions}>
                  <button
                    type="button"
                    aria-label="Replace dark terminal theme"
                    onClick={() => props.onReplaceTerminalThemeVariant("dark")}
                  >
                    Replace dark
                  </button>
                  <button
                    type="button"
                    aria-label="Replace light terminal theme"
                    onClick={() => props.onReplaceTerminalThemeVariant("light")}
                  >
                    Replace light
                  </button>
                  <button
                    type="button"
                    aria-label="Export dark terminal theme"
                    onClick={() => props.onExportTerminalThemeVariant("dark")}
                  >
                    Export dark
                  </button>
                  <button
                    type="button"
                    aria-label="Export light terminal theme"
                    onClick={() => props.onExportTerminalThemeVariant("light")}
                  >
                    Export light
                  </button>
                </div>
                {activeTerminalTheme ? (
                  <label>
                    Minimum contrast ratio
                    <input
                      aria-label="Minimum contrast ratio"
                      type="number"
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
                      background: props.terminalThemePreview.palette.background,
                      color: props.terminalThemePreview.palette.foreground
                    }}
                  >
                    <div className={styles.terminalThemePreviewHeader}>
                      <span>{props.terminalThemePreview.profileName}</span>
                      <span>
                        {props.terminalThemePreview.variant} · contrast{" "}
                        {props.terminalThemePreview.minimumContrastRatio}
                      </span>
                    </div>
                    <div className={styles.terminalThemePreviewBody}>
                      <div>plain text: ~/src/kmux $ echo hello</div>
                      <div className={styles.terminalThemePreviewDim}>
                        dim text: last login, hints, and secondary prompt copy
                      </div>
                      <div className={styles.terminalThemePreviewLine}>
                        <span
                          style={{
                            color: props.terminalThemePreview.palette.ansi[2]
                          }}
                        >
                          success
                        </span>
                        <span
                          style={{
                            color: props.terminalThemePreview.palette.ansi[3]
                          }}
                        >
                          warning
                        </span>
                        <span
                          style={{
                            color: props.terminalThemePreview.palette.ansi[1]
                          }}
                        >
                          error
                        </span>
                        <span
                          style={{
                            color: props.terminalThemePreview.palette.ansi[4]
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
              <label>
                Text font
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
                        preferredTextFontFamily: event.currentTarget.value
                      }
                    });
                  }}
                />
              </label>
              <datalist id="terminal-font-families">
                {props.availableTerminalFontFamilies.map((fontFamily) => (
                  <option key={fontFamily} value={fontFamily} />
                ))}
              </datalist>
              <label>
                Font size
                <input
                  aria-label="Font size"
                  type="number"
                  min="8"
                  max="32"
                  value={props.settingsDraft.terminalTypography.fontSize}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      terminalTypography: {
                        fontSize: Number(event.currentTarget.value)
                      }
                    });
                  }}
                />
              </label>
              <label>
                Line height
                <input
                  aria-label="Line height"
                  type="number"
                  min="0.8"
                  max="2"
                  step="0.05"
                  value={props.settingsDraft.terminalTypography.lineHeight}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      terminalTypography: {
                        lineHeight: Number(event.currentTarget.value)
                      }
                    });
                  }}
                />
              </label>
              <label>
                Use WebGL terminal renderer
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
              </label>
              <div className={styles.settingsNotice}>
                Turn this off if terminal text looks soft or slightly blurred on
                your display.
              </div>
              {props.terminalTypographyPreview ? (
                <div
                  className={styles.terminalTypographyPreview}
                  data-testid="terminal-typography-preview"
                >
                  <div className={styles.terminalTypographyPreviewHeader}>
                    <span>Terminal glyphs</span>
                    <span
                      className={styles.terminalTypographyStatus}
                      data-status={props.terminalTypographyPreview.status}
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
              <div className={styles.shortcutsEditor}>
                {Object.entries(props.settingsDraft.shortcuts)
                  .filter(
                    ([command]) =>
                      command !== "workspace.switcher" &&
                      command !== "pane.zoom"
                  )
                  .map(([command, binding]) => (
                    <label key={command}>
                      <span>{command}</span>
                      <input
                        value={binding}
                        onChange={(event) => {
                          const nextBinding = event.currentTarget.value;
                          props.setSettingsDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  shortcuts: {
                                    ...current.shortcuts,
                                    [command]: nextBinding
                                  }
                                }
                              : current
                          );
                        }}
                      />
                    </label>
                  ))}
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
