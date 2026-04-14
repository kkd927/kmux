import type {Dispatch, RefObject, SetStateAction} from "react";

import type {KmuxSettings, NotificationItem} from "@kmux/proto";

import type {
    WorkspaceContext,
    WorkspaceContextAction,
    WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";
import type {WorkspaceContextMenuState} from "../hooks/useWorkspaceContextMenu";
import styles from "../styles/App.module.css";
import {NotificationsPanel} from "./NotificationsPanel";
import {WorkspaceContextMenu} from "./WorkspaceContextMenu";

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
  settingsOpen: boolean;
  settingsDraft: KmuxSettings | undefined;
  setSettingsDraft: Dispatch<SetStateAction<KmuxSettings | undefined>>;
  onCloseSettings: () => void;
  onSaveSettings: (settingsDraft: KmuxSettings) => void;
}

export function AppOverlays(props: AppOverlaysProps): JSX.Element {
  const activeWorkspaceContext =
    props.workspaceContextMenu && props.workspaceContext
      ? props.workspaceContext
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
                    (props.paletteSelectedIndex - 1 + props.paletteItems.length) %
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
                    const themeMode =
                      event.currentTarget
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
                    const socketMode =
                      event.currentTarget
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
                Font family
                <input
                  aria-label="Font family"
                  type="text"
                  value={props.settingsDraft.terminalFontFamily}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      terminalFontFamily: event.currentTarget.value
                    });
                  }}
                />
              </label>
              <label>
                Font size
                <input
                  aria-label="Font size"
                  type="number"
                  min="8"
                  max="32"
                  value={props.settingsDraft.terminalFontSize}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      terminalFontSize: Number(event.currentTarget.value)
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
                  value={props.settingsDraft.terminalLineHeight}
                  onChange={(event) => {
                    updateSettingsDraft(props.setSettingsDraft, {
                      terminalLineHeight: Number(event.currentTarget.value)
                    });
                  }}
                />
              </label>
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
  patch: Partial<KmuxSettings>
): void {
  setSettingsDraft((current) =>
    current
      ? {
          ...current,
          ...patch
        }
      : current
  );
}
