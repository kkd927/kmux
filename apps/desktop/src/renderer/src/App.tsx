import { useEffect, useMemo, useRef, useState } from "react";

import type { AppAction } from "@kmux/core";
import type {
  KmuxSettings,
  NotificationItem,
  ShellViewModel,
  SidebarLogEntry,
  SidebarProgress,
  WorkspaceRowVm
} from "@kmux/proto";
import { normalizeShortcut } from "@kmux/ui";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Codicon } from "./components/Codicon";
import { PaneTree } from "./components/PaneTree";
import { useShellView } from "./hooks/useShellView";
import styles from "./styles/App.module.css";

type RenameSurfaceRequest = {
  surfaceId: string;
  token: number;
};
type TerminalFocusRequest = {
  surfaceId: string;
  token: number;
};
type ActiveShortcutContext = {
  view: ShellViewModel;
  activePaneId: string;
  activeSurfaceId: string;
};
type WorkspaceContextMenuState = {
  workspaceId: string;
  x: number;
  y: number;
};
type WorkspaceRowContext = {
  view: ShellViewModel;
  row: WorkspaceRowVm;
  index: number;
};

export function App(): JSX.Element {
  const view = useShellView();
  const isMac = navigator.userAgent.includes("Mac");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchSurfaceId, setSearchSurfaceId] = useState<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null
  );
  const [renameSurfaceRequest, setRenameSurfaceRequest] =
    useState<RenameSurfaceRequest | null>(null);
  const [terminalFocusRequest, setTerminalFocusRequest] =
    useState<TerminalFocusRequest | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [dropWorkspaceId, setDropWorkspaceId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(
    null
  );
  const [settingsDraft, setSettingsDraft] = useState(view?.settings);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ShellViewModel | null>(view);
  const overlayStateRef = useRef({
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: Boolean(workspaceContextMenu)
  });

  viewRef.current = view;
  overlayStateRef.current = {
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: Boolean(workspaceContextMenu)
  };

  useEffect(() => {
    setSettingsDraft(
      view?.settings
        ? {
            ...view.settings,
            shortcuts: omitDeprecatedShortcuts(view.settings.shortcuts)
          }
        : undefined
    );
  }, [view?.settings]);

  useEffect(() => {
    if (!view?.settings) {
      return;
    }
    applyTypographySettings(view.settings);
  }, [
    view?.settings?.terminalFontFamily,
    view?.settings?.terminalFontSize,
    view?.settings?.terminalLineHeight
  ]);

  useEffect(() => {
    if (
      workspaceContextMenu &&
      view &&
      !view.workspaceRows.some(
        (row) => row.workspaceId === workspaceContextMenu.workspaceId
      )
    ) {
      setWorkspaceContextMenu(null);
    }
  }, [view, workspaceContextMenu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const currentView = viewRef.current;
      if (!currentView) {
        return;
      }

      const {
        paletteOpen: currentPaletteOpen,
        notificationsOpen: currentNotificationsOpen,
        settingsOpen: currentSettingsOpen,
        searchSurfaceId: currentSearchSurfaceId,
        workspaceContextMenuOpen: currentWorkspaceContextMenuOpen
      } = overlayStateRef.current;
      const activePaneId = currentView.activeWorkspace.activePaneId;
      if (event.key === "Escape") {
        if (currentWorkspaceContextMenuOpen) {
          event.preventDefault();
          closeWorkspaceContextMenu();
          return;
        }
        if (currentSearchSurfaceId) {
          event.preventDefault();
          setSearchSurfaceId(null);
          requestTerminalFocus(currentSearchSurfaceId);
          return;
        }
        if (currentSettingsOpen) {
          event.preventDefault();
          setSettingsOpen(false);
          return;
        }
        if (currentNotificationsOpen) {
          event.preventDefault();
          setNotificationsOpen(false);
          return;
        }
        if (currentPaletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          setPaletteQuery("");
          setPaletteSelectedIndex(0);
          return;
        }
      }

      if (currentWorkspaceContextMenuOpen) {
        return;
      }

      const target = event.target;
      const isTerminalInput =
        target instanceof HTMLTextAreaElement &&
        target.classList.contains("xterm-helper-textarea");
      const terminalOwnsShortcut =
        isTerminalInput &&
        (matchShortcut(currentView, event, "terminal.search") ||
          matchShortcut(currentView, event, "terminal.search.next") ||
          matchShortcut(currentView, event, "terminal.search.prev") ||
          matchShortcut(currentView, event, "terminal.copy") ||
          matchShortcut(currentView, event, "terminal.paste") ||
          matchShortcut(currentView, event, "terminal.copyMode"));
      const isEditable =
        target instanceof HTMLInputElement ||
        (target instanceof HTMLTextAreaElement && !isTerminalInput) ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (terminalOwnsShortcut) {
        return;
      }

      if (isEditable) {
        return;
      }

      if (
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        event.key >= "1" &&
        event.key <= "9"
      ) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.selectIndex",
          index: Number(event.key) - 1
        });
        return;
      }
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        event.key >= "1" &&
        event.key <= "9"
      ) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "surface.focusIndex",
          paneId: activePaneId,
          index: Number(event.key) - 1
        });
        return;
      }
      if (matchShortcut(currentView, event, "command.palette")) {
        event.preventDefault();
        if (currentPaletteOpen) {
          setPaletteOpen(false);
          setPaletteQuery("");
          setPaletteSelectedIndex(0);
        } else {
          setPaletteQuery("");
          setPaletteSelectedIndex(0);
          setPaletteOpen(true);
        }
        return;
      }
      if (matchShortcut(currentView, event, "notifications.toggle")) {
        event.preventDefault();
        setNotificationsOpen((open) => !open);
        return;
      }
      if (matchShortcut(currentView, event, "settings.toggle")) {
        event.preventDefault();
        setSettingsOpen((open) => !open);
        return;
      }
      if (matchShortcut(currentView, event, "workspace.create")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.create",
          name: "new workspace"
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.rename")) {
        event.preventDefault();
        beginWorkspaceRename(
          currentView.activeWorkspace.id,
          currentView.sidebarVisible
        );
        return;
      }
      if (matchShortcut(currentView, event, "workspace.close")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.close",
          workspaceId: currentView.activeWorkspace.id
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.next")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.selectRelative",
          delta: 1
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.prev")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.selectRelative",
          delta: -1
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.sidebar.toggle")) {
        event.preventDefault();
        void window.kmux.dispatch({ type: "workspace.sidebar.toggle" });
        return;
      }
      if (matchShortcut(currentView, event, "pane.split.right")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          dispatchAndFocusActiveTerminal({
            type: "pane.split",
            paneId: latestPaneId,
            direction: "right"
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.split.down")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          dispatchAndFocusActiveTerminal({
            type: "pane.split",
            paneId: latestPaneId,
            direction: "down"
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.left")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "pane.focusDirection",
          direction: "left"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.right")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "pane.focusDirection",
          direction: "right"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.up")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "pane.focusDirection",
          direction: "up"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.down")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "pane.focusDirection",
          direction: "down"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.resize.left")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "pane.resize",
            paneId: latestPaneId,
            direction: "left",
            delta: 0.03
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.resize.right")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "pane.resize",
            paneId: latestPaneId,
            direction: "right",
            delta: 0.03
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.resize.up")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "pane.resize",
            paneId: latestPaneId,
            direction: "up",
            delta: 0.03
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.resize.down")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "pane.resize",
            paneId: latestPaneId,
            direction: "down",
            delta: 0.03
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.close")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({ type: "pane.close", paneId: latestPaneId })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.create")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          dispatchAndFocusActiveTerminal({
            type: "surface.create",
            paneId: latestPaneId
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.rename")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) => {
            requestSurfaceRename(latestSurfaceId);
          }
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.close")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) =>
            window.kmux.dispatch({
              type: "surface.close",
              surfaceId: latestSurfaceId
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.closeOthers")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) =>
            window.kmux.dispatch({
              type: "surface.closeOthers",
              surfaceId: latestSurfaceId
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.next")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "surface.focusRelative",
            paneId: latestPaneId,
            delta: 1
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.prev")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          window.kmux.dispatch({
            type: "surface.focusRelative",
            paneId: latestPaneId,
            delta: -1
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "terminal.search")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) => {
            setSearchSurfaceId((current) =>
              current === latestSurfaceId ? null : latestSurfaceId
            );
          }
        );
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const rows = view?.workspaceRows ?? [];
  const workspaceContextRow = workspaceContextMenu
    ? (rows.find(
        (row) => row.workspaceId === workspaceContextMenu.workspaceId
      ) ?? null)
    : null;
  const workspaceContextIndex = workspaceContextRow
    ? rows.findIndex(
        (row) => row.workspaceId === workspaceContextRow.workspaceId
      )
    : -1;
  const activeWorkspaceHasAux = Boolean(
    view?.activeWorkspace.sidebarStatus ||
    view?.activeWorkspace.progress ||
    view?.activeWorkspace.logs[0]
  );
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sidebarRef.current,
    estimateSize: (index) =>
      rows[index]?.workspaceId === view?.activeWorkspace.id &&
      activeWorkspaceHasAux
        ? 126
        : 62,
    overscan: 4
  });

  const paletteItems = useMemo(() => {
    if (!view) {
      return [];
    }

    return [
      {
        id: "new-workspace",
        label: "New workspace",
        subtitle: "Create another workspace",
        run: () =>
          void dispatch({ type: "workspace.create", name: "new workspace" })
      },
      {
        id: "rename-workspace",
        label: "Rename workspace",
        subtitle: "Edit the active workspace name",
        run: () =>
          void withLatestView((latestView) =>
            beginWorkspaceRename(
              latestView.activeWorkspace.id,
              latestView.sidebarVisible
            )
          )
      },
      {
        id: "new-tab",
        label: "New tab in active pane",
        subtitle: "Create a new terminal surface",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "surface.create",
              paneId: activePaneId
            })
          )
      },
      {
        id: "rename-tab",
        label: "Rename active tab",
        subtitle: "Edit the active surface title",
        run: () =>
          void withLatestActiveShortcutContext(({ activeSurfaceId }) => {
            requestSurfaceRename(activeSurfaceId);
          })
      },
      {
        id: "close-other-tabs",
        label: "Close other tabs",
        subtitle: "Keep only the active surface",
        run: () =>
          void withLatestActiveShortcutContext(({ activeSurfaceId }) =>
            dispatch({
              type: "surface.closeOthers",
              surfaceId: activeSurfaceId
            })
          )
      },
      {
        id: "split-right",
        label: "Split right",
        subtitle: "Split active pane horizontally",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "pane.split",
              paneId: activePaneId,
              direction: "right"
            })
          )
      },
      {
        id: "split-down",
        label: "Split down",
        subtitle: "Split active pane vertically",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "pane.split",
              paneId: activePaneId,
              direction: "down"
            })
          )
      },
      {
        id: "close-pane",
        label: "Close active pane",
        subtitle: "Remove the current split",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({ type: "pane.close", paneId: activePaneId })
          )
      },
      {
        id: "jump-unread",
        label: "Jump to latest unread",
        subtitle: "Focus latest notification target",
        run: () => void dispatch({ type: "notification.jumpLatestUnread" })
      },
      {
        id: "toggle-settings",
        label: "Settings",
        subtitle: "Open settings modal",
        run: () => setSettingsOpen(true)
      }
    ].filter(
      (item) =>
        item.label.toLowerCase().includes(paletteQuery.toLowerCase()) ||
        item.subtitle.toLowerCase().includes(paletteQuery.toLowerCase())
    );
  }, [paletteQuery, view]);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }
    setPaletteSelectedIndex(0);
  }, [paletteOpen, paletteQuery]);

  useEffect(() => {
    if (!paletteItems.length) {
      setPaletteSelectedIndex(0);
      return;
    }

    if (paletteSelectedIndex >= paletteItems.length) {
      setPaletteSelectedIndex(paletteItems.length - 1);
    }
  }, [paletteItems.length, paletteSelectedIndex]);

  if (!view) {
    return <div className={styles.loading}>Booting kmux…</div>;
  }

  return (
    <div className={styles.window} data-platform={isMac ? "darwin" : "other"}>
      <div className={styles.titlebar}>
        <div className={styles.titlebarLeft}>
          {!isMac ? (
            <div className={styles.trafficLights}>
              <button
                aria-label="Close window"
                onClick={() => void window.kmux.windowControl("close")}
              />
              <button
                aria-label="Minimize window"
                onClick={() => void window.kmux.windowControl("minimize")}
              />
              <button
                aria-label="Maximize window"
                onClick={() => void window.kmux.windowControl("maximize")}
              />
            </div>
          ) : null}
          <div className={styles.titlebarTools}>
            <button
              aria-label="Toggle sidebar"
              className={styles.titleActionButton}
              onClick={() =>
                void dispatch({ type: "workspace.sidebar.toggle" })
              }
            >
              <Codicon name="layout-sidebar-left" />
            </button>
            <button
              aria-label="Create workspace"
              className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
              onClick={() =>
                void dispatch({
                  type: "workspace.create",
                  name: "new workspace"
                })
              }
            >
              <Codicon name="add" />
            </button>
          </div>
        </div>
        <div className={styles.titleCenter}>
          <div className={styles.titleWordmark} data-testid="project-header">
            kmux
          </div>
        </div>
        <div className={styles.titleActions}>
          <button
            aria-label="Toggle notifications"
            className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
            onClick={() => setNotificationsOpen((open) => !open)}
          >
            <Codicon name="bell" />
            {view.unreadNotifications > 0 ? (
              <span className={styles.titleActionCount}>
                {view.unreadNotifications}
              </span>
            ) : null}
          </button>
          <button
            aria-label="Open settings"
            className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
            onClick={() => setSettingsOpen(true)}
          >
            <Codicon name="gear" />
          </button>
        </div>
      </div>
      <div className={styles.shell}>
        {view.sidebarVisible ? (
          <aside className={styles.sidebar} data-testid="workspace-tool-window">
            <div className={styles.sidebarPanel}>
              <div className={styles.sidebarHeader}>
                <div className={styles.sidebarHeaderLabelGroup}>
                  <div className={styles.sidebarHeaderTitleRow}>
                    <div className={styles.sidebarHeaderTitle}>WORKSPACES</div>
                    <span className={styles.sidebarHeaderCount}>
                      {rows.length}
                    </span>
                  </div>
                </div>
              </div>
              <div ref={sidebarRef} className={styles.sidebarScroll}>
                {rows.length === 0 ? (
                  <div
                    className={styles.paletteEmpty}
                    style={{ margin: "10px", marginTop: "20px" }}
                  >
                    <div style={{ marginBottom: "6px" }}>No workspaces</div>
                    <div style={{ fontSize: "0.769rem", opacity: 0.6 }}>
                      Press Cmd/Ctrl + N or +
                    </div>
                  </div>
                ) : (
                  <div
                    className={styles.virtualBody}
                    style={{
                      height: rowVirtualizer.getTotalSize()
                    }}
                  >
                    {rowVirtualizer.getVirtualItems().map((item) => {
                      const row = rows[item.index];
                      return (
                        <div
                          key={row.workspaceId}
                          className={styles.virtualItem}
                          data-index={item.index}
                          ref={rowVirtualizer.measureElement}
                          style={{
                            transform: `translateY(${item.start}px)`
                          }}
                        >
                          <WorkspaceCard
                            row={row}
                            editing={editingWorkspaceId === row.workspaceId}
                            expanded={
                              row.workspaceId === view.activeWorkspace.id
                            }
                            menuOpen={
                              workspaceContextMenu?.workspaceId ===
                              row.workspaceId
                            }
                            status={
                              row.workspaceId === view.activeWorkspace.id
                                ? view.activeWorkspace.sidebarStatus
                                : undefined
                            }
                            progress={
                              row.workspaceId === view.activeWorkspace.id
                                ? view.activeWorkspace.progress
                                : undefined
                            }
                            latestLog={
                              row.workspaceId === view.activeWorkspace.id
                                ? view.activeWorkspace.logs[0]
                                : undefined
                            }
                            onSelect={() =>
                              void dispatch({
                                type: "workspace.select",
                                workspaceId: row.workspaceId
                              })
                            }
                            onRenameStart={() =>
                              beginWorkspaceRename(row.workspaceId)
                            }
                            onOpenContextMenu={(position) =>
                              openWorkspaceContextMenu(
                                row.workspaceId,
                                position.x,
                                position.y
                              )
                            }
                            onRename={(name) => {
                              void dispatch({
                                type: "workspace.rename",
                                workspaceId: row.workspaceId,
                                name
                              });
                              setEditingWorkspaceId(null);
                            }}
                            dragging={dragWorkspaceId === row.workspaceId}
                            dropPosition={
                              dropWorkspaceId === row.workspaceId
                                ? dropPosition
                                : null
                            }
                            onDragStart={() => {
                              setDragWorkspaceId(row.workspaceId);
                              setDropWorkspaceId(null);
                              setDropPosition(null);
                            }}
                            onDragTarget={(position) => {
                              if (
                                !dragWorkspaceId ||
                                dragWorkspaceId === row.workspaceId
                              ) {
                                setDropWorkspaceId(null);
                                setDropPosition(null);
                                return;
                              }
                              setDropWorkspaceId(row.workspaceId);
                              setDropPosition(position);
                            }}
                            onDragLeave={() => {
                              if (dropWorkspaceId === row.workspaceId) {
                                setDropWorkspaceId(null);
                                setDropPosition(null);
                              }
                            }}
                            onDrop={(position) => {
                              if (
                                !dragWorkspaceId ||
                                dragWorkspaceId === row.workspaceId
                              ) {
                                setDragWorkspaceId(null);
                                setDropWorkspaceId(null);
                                setDropPosition(null);
                                return;
                              }
                              const sourceIndex = rows.findIndex(
                                (entry) => entry.workspaceId === dragWorkspaceId
                              );
                              const targetIndex = rows.findIndex(
                                (entry) => entry.workspaceId === row.workspaceId
                              );
                              if (sourceIndex === -1 || targetIndex === -1) {
                                setDragWorkspaceId(null);
                                setDropWorkspaceId(null);
                                setDropPosition(null);
                                return;
                              }

                              const toIndex =
                                position === "after"
                                  ? sourceIndex < targetIndex
                                    ? targetIndex
                                    : targetIndex + 1
                                  : sourceIndex < targetIndex
                                    ? targetIndex - 1
                                    : targetIndex;

                              void dispatch({
                                type: "workspace.move",
                                workspaceId: dragWorkspaceId,
                                toIndex
                              });
                              setDragWorkspaceId(null);
                              setDropWorkspaceId(null);
                              setDropPosition(null);
                            }}
                            onDragEnd={() => {
                              setDragWorkspaceId(null);
                              setDropWorkspaceId(null);
                              setDropPosition(null);
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </aside>
        ) : null}
        <main className={styles.main}>
          <PaneTree
            workspace={view.activeWorkspace}
            settings={view.settings}
            searchSurfaceId={searchSurfaceId}
            renameSurfaceRequest={renameSurfaceRequest}
            focusTerminalRequest={terminalFocusRequest}
            onConsumeRenameSurfaceRequest={consumeRenameSurfaceRequest}
            onConsumeFocusTerminalRequest={consumeTerminalFocusRequest}
            onSetSplitRatio={(splitNodeId, ratio) =>
              void dispatch({ type: "pane.setSplitRatio", splitNodeId, ratio })
            }
            onFocusPane={(paneId) =>
              void dispatch({ type: "pane.focus", paneId })
            }
            onFocusSurface={(surfaceId) =>
              void dispatch({ type: "surface.focus", surfaceId })
            }
            onRenameSurface={(surfaceId, title) =>
              void dispatch({ type: "surface.rename", surfaceId, title })
            }
            onCreateSurface={(paneId) =>
              void dispatch({ type: "surface.create", paneId })
            }
            onCloseSurface={(surfaceId) =>
              void dispatch({ type: "surface.close", surfaceId })
            }
            onCloseOthers={(surfaceId) =>
              void dispatch({ type: "surface.closeOthers", surfaceId })
            }
            onSplitRight={(paneId) =>
              void dispatch({ type: "pane.split", paneId, direction: "right" })
            }
            onSplitDown={(paneId) =>
              void dispatch({ type: "pane.split", paneId, direction: "down" })
            }
            onClosePane={(paneId) =>
              void dispatch({ type: "pane.close", paneId })
            }
            onToggleSearch={(surfaceId) => setSearchSurfaceId(surfaceId)}
          />
        </main>
      </div>
      {paletteOpen ? (
        <div className={styles.overlay} onClick={closePalette}>
          <div
            className={styles.palette}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (!paletteItems.length && event.key === "Escape") {
                  event.preventDefault();
                  closePalette();
                  return;
                }
                if (!paletteItems.length) {
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPaletteSelectedIndex(
                    (current) => (current + 1) % paletteItems.length
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPaletteSelectedIndex(
                    (current) =>
                      (current - 1 + paletteItems.length) % paletteItems.length
                  );
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  executePaletteItem(paletteSelectedIndex);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closePalette();
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
              {paletteItems.map((item, index) => (
                <button
                  key={item.id}
                  className={styles.paletteItem}
                  data-selected={index === paletteSelectedIndex}
                  role="option"
                  aria-selected={index === paletteSelectedIndex}
                  onMouseEnter={() => setPaletteSelectedIndex(index)}
                  onFocus={() => setPaletteSelectedIndex(index)}
                  onClick={() => executePaletteItem(index)}
                >
                  <span>{item.label}</span>
                  <span>{item.subtitle}</span>
                </button>
              ))}
              {!paletteItems.length ? (
                <div className={styles.paletteEmpty}>No matching results</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {workspaceContextMenu && workspaceContextRow ? (
        <div
          className={styles.menuOverlay}
          onClick={closeWorkspaceContextMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            closeWorkspaceContextMenu();
          }}
        >
          <div
            className={styles.workspaceMenu}
            role="menu"
            aria-label={`Workspace menu for ${workspaceContextRow.name}`}
            style={{
              left: workspaceContextMenu.x,
              top: workspaceContextMenu.y
            }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className={styles.workspaceMenuHeader}>
              <span>{workspaceContextRow.name}</span>
              {workspaceContextRow.pinned ? (
                <span className={styles.workspaceMenuMeta}>Pinned</span>
              ) : null}
            </div>
            <div className={styles.workspaceMenuGroup}>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "rename",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Rename Workspace…
              </button>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "pin-toggle",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                {workspaceContextRow.pinned
                  ? "Unpin Workspace"
                  : "Pin Workspace"}
              </button>
            </div>
            <div className={styles.workspaceMenuGroup}>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                disabled={workspaceContextIndex <= 0}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "move-top",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Move to Top
              </button>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                disabled={workspaceContextIndex <= 0}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "move-up",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Move Up
              </button>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                disabled={
                  workspaceContextIndex === -1 ||
                  workspaceContextIndex >= rows.length - 1
                }
                onClick={() =>
                  void runWorkspaceContextAction(
                    "move-down",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Move Down
              </button>
            </div>
            <div className={styles.workspaceMenuGroup}>
              <button
                role="menuitem"
                className={styles.workspaceMenuItem}
                disabled={rows.length <= 1}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "close-others",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Close Other Workspaces
              </button>
              <button
                role="menuitem"
                className={`${styles.workspaceMenuItem} ${styles.workspaceMenuItemDanger}`}
                disabled={rows.length <= 1}
                onClick={() =>
                  void runWorkspaceContextAction(
                    "close",
                    workspaceContextRow.workspaceId
                  )
                }
              >
                Close Workspace
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {notificationsOpen ? (
        <NotificationsPanel
          notifications={view.notifications}
          onClose={() => setNotificationsOpen(false)}
          onJump={() => {
            void dispatch({ type: "notification.jumpLatestUnread" });
            setNotificationsOpen(false);
          }}
          onClear={() => void dispatch({ type: "notification.clear" })}
        />
      ) : null}
      {settingsOpen && settingsDraft ? (
        <div className={styles.overlay} onClick={() => setSettingsOpen(false)}>
          <div
            className={styles.settings}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2>Settings</h2>
              <button
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <label>
              Socket mode
              <select
                value={settingsDraft.socketMode}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    socketMode: event.currentTarget
                      .value as ShellViewModel["settings"]["socketMode"]
                  })
                }
              >
                <option value="kmuxOnly">kmuxOnly</option>
                <option value="allowAll">allowAll</option>
                <option value="off">off</option>
              </select>
            </label>
            <label>
              Startup restore
              <input
                type="checkbox"
                checked={settingsDraft.startupRestore}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    startupRestore: event.currentTarget.checked
                  })
                }
              />
            </label>
            <label>
              Desktop notifications
              <input
                type="checkbox"
                checked={settingsDraft.notificationDesktop}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    notificationDesktop: event.currentTarget.checked
                  })
                }
              />
            </label>
            <label>
              Font family
              <input
                type="text"
                value={settingsDraft.terminalFontFamily}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    terminalFontFamily: event.currentTarget.value
                  })
                }
              />
            </label>
            <label>
              Font size
              <input
                type="number"
                min="8"
                max="32"
                value={settingsDraft.terminalFontSize}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    terminalFontSize: Number(event.currentTarget.value)
                  })
                }
              />
            </label>
            <label>
              Line height
              <input
                type="number"
                min="0.8"
                max="2"
                step="0.05"
                value={settingsDraft.terminalLineHeight}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    terminalLineHeight: Number(event.currentTarget.value)
                  })
                }
              />
            </label>
            <div className={styles.shortcutsEditor}>
              {Object.entries(settingsDraft.shortcuts)
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
                      onChange={(event) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          shortcuts: {
                            ...settingsDraft.shortcuts,
                            [command]: event.currentTarget.value
                          }
                        })
                      }
                    />
                  </label>
                ))}
            </div>
            <div className={styles.modalActions}>
              <button onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button
                onClick={() => {
                  const settingsPatch = {
                    ...settingsDraft,
                    shortcuts: omitDeprecatedShortcuts(settingsDraft.shortcuts)
                  };
                  applyTypographySettings(settingsPatch);
                  void dispatch({
                    type: "settings.update",
                    patch: settingsPatch
                  });
                  setSettingsOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  async function dispatch(action: AppAction): Promise<void> {
    await window.kmux.dispatch(action);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
  }

  function openWorkspaceContextMenu(
    workspaceId: string,
    x: number,
    y: number
  ): void {
    const menuWidth = 228;
    const menuHeight = 320;
    setWorkspaceContextMenu({
      workspaceId,
      x: Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12))
    });
  }

  function closeWorkspaceContextMenu(): void {
    setWorkspaceContextMenu(null);
  }

  function beginWorkspaceRename(
    workspaceId: string,
    sidebarVisible = viewRef.current?.sidebarVisible ?? true
  ): void {
    if (!sidebarVisible) {
      void window.kmux.dispatch({ type: "workspace.sidebar.toggle" });
    }
    setEditingWorkspaceId(workspaceId);
  }

  function requestSurfaceRename(surfaceId: string): void {
    setRenameSurfaceRequest({
      surfaceId,
      token: Date.now()
    });
  }

  function requestTerminalFocus(surfaceId: string): void {
    setTerminalFocusRequest({
      surfaceId,
      token: Date.now()
    });
  }

  function consumeRenameSurfaceRequest(token: number): void {
    setRenameSurfaceRequest((current) =>
      current?.token === token ? null : current
    );
  }

  function consumeTerminalFocusRequest(token: number): void {
    setTerminalFocusRequest((current) =>
      current?.token === token ? null : current
    );
  }

  async function dispatchAndFocusActiveTerminal(
    action: AppAction
  ): Promise<void> {
    const nextView = await window.kmux.dispatch(action);
    const nextPaneId = nextView.activeWorkspace.activePaneId;
    const nextPane = nextView.activeWorkspace.panes[nextPaneId];
    if (!nextPane) {
      return;
    }
    requestTerminalFocus(nextPane.activeSurfaceId);
  }

  async function withLatestActiveShortcutContext(
    run: (context: ActiveShortcutContext) => void | Promise<void>
  ): Promise<void> {
    const latestView = await window.kmux.getView();
    const latestPaneId = latestView.activeWorkspace.activePaneId;
    const latestPane = latestView.activeWorkspace.panes[latestPaneId];
    if (!latestPane) {
      return;
    }
    await run({
      view: latestView,
      activePaneId: latestPaneId,
      activeSurfaceId: latestPane.activeSurfaceId
    });
  }

  async function withLatestView(
    run: (view: ShellViewModel) => void | Promise<void>
  ): Promise<void> {
    await run(await window.kmux.getView());
  }

  async function withLatestWorkspaceContext(
    workspaceId: string,
    run: (context: WorkspaceRowContext) => void | Promise<void>
  ): Promise<void> {
    await withLatestView(async (latestView) => {
      const index = latestView.workspaceRows.findIndex(
        (row) => row.workspaceId === workspaceId
      );
      if (index === -1) {
        return;
      }
      await run({
        view: latestView,
        row: latestView.workspaceRows[index],
        index
      });
    });
  }

  async function runWorkspaceContextAction(
    action:
      | "rename"
      | "pin-toggle"
      | "move-top"
      | "move-up"
      | "move-down"
      | "close-others"
      | "close",
    workspaceId: string
  ): Promise<void> {
    closeWorkspaceContextMenu();

    switch (action) {
      case "rename":
        await withLatestWorkspaceContext(
          workspaceId,
          ({ view: latestView }) => {
            beginWorkspaceRename(workspaceId, latestView.sidebarVisible);
          }
        );
        return;
      case "pin-toggle":
        await dispatch({ type: "workspace.pin.toggle", workspaceId });
        return;
      case "move-top":
        await withLatestWorkspaceContext(workspaceId, ({ index }) => {
          if (index > 0) {
            return dispatch({
              type: "workspace.move",
              workspaceId,
              toIndex: 0
            });
          }
        });
        return;
      case "move-up":
        await withLatestWorkspaceContext(workspaceId, ({ index }) => {
          if (index > 0) {
            return dispatch({
              type: "workspace.move",
              workspaceId,
              toIndex: index - 1
            });
          }
        });
        return;
      case "move-down":
        await withLatestWorkspaceContext(
          workspaceId,
          ({ index, view: latestView }) => {
            if (index < latestView.workspaceRows.length - 1) {
              return dispatch({
                type: "workspace.move",
                workspaceId,
                toIndex: index + 1
              });
            }
          }
        );
        return;
      case "close-others":
        await dispatch({ type: "workspace.closeOthers", workspaceId });
        return;
      case "close":
        await dispatch({ type: "workspace.close", workspaceId });
        return;
      default:
        return;
    }
  }

  function executePaletteItem(index: number): void {
    const item = paletteItems[index];
    if (!item) {
      return;
    }
    item.run();
    closePalette();
  }
}

function WorkspaceCard(props: {
  row: WorkspaceRowVm;
  editing: boolean;
  expanded: boolean;
  menuOpen: boolean;
  status?: string;
  progress?: SidebarProgress;
  latestLog?: SidebarLogEntry;
  dragging: boolean;
  dropPosition: "before" | "after" | null;
  onSelect: () => void;
  onRenameStart: () => void;
  onOpenContextMenu: (position: { x: number; y: number }) => void;
  onRename: (name: string) => void;
  onDragStart: () => void;
  onDragTarget: (position: "before" | "after") => void;
  onDragLeave: () => void;
  onDrop: (position: "before" | "after") => void;
  onDragEnd: () => void;
}): JSX.Element {
  const summaryText =
    props.row.summary && props.row.summary !== props.row.name
      ? props.row.summary
      : props.row.cwd
        ? (lastPathSegment(props.row.cwd) ?? "Workspace folder")
        : "Detached workspace";
  const pathText = props.row.cwd ?? "No workspace folder";
  const showMeta = props.row.ports.length > 0 || props.row.attention;

  return (
    <button
      className={styles.workspaceCard}
      data-workspace-id={props.row.workspaceId}
      data-active={props.row.isActive}
      data-menu-open={props.menuOpen}
      data-dragging={props.dragging}
      data-drop-position={props.dropPosition ?? undefined}
      draggable={!props.editing}
      onClick={props.onSelect}
      onDoubleClick={props.onRenameStart}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenContextMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          props.editing ||
          event.target instanceof HTMLInputElement ||
          !(
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
        ) {
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onOpenContextMenu({
          x: rect.right - 12,
          y: rect.top + 14
        });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", props.row.workspaceId);
        props.onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position =
          event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
        props.onDragTarget(position);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          props.onDragLeave();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position =
          event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
        props.onDrop(position);
      }}
      onDragEnd={props.onDragEnd}
    >
      <div className={styles.workspaceCardHeader}>
        <div className={styles.workspaceTextBlock}>
          <div className={styles.workspaceTitleRow}>
            {props.editing ? (
              <input
                autoFocus
                defaultValue={props.row.name}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => props.onRename(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    props.onRename((event.target as HTMLInputElement).value);
                  }
                }}
              />
            ) : (
              <span className={styles.workspaceTitle}>{props.row.name}</span>
            )}
            <div className={styles.workspaceMetrics}>
              {props.row.pinned ? (
                <span className={styles.workspacePinned}>PIN</span>
              ) : null}
              {props.row.unreadCount > 0 ? (
                <span className={styles.workspaceUnread}>
                  {props.row.unreadCount}
                </span>
              ) : null}
            </div>
          </div>
          <span className={styles.workspaceSummary}>{summaryText}</span>
          <div className={styles.workspacePathRow}>
            {props.row.branch ? (
              <span className={styles.workspaceBranch}>{props.row.branch}</span>
            ) : null}
            <div className={styles.workspacePath}>{pathText}</div>
          </div>
          {showMeta ? (
            <div className={styles.workspaceMeta}>
              {props.row.ports.map((port) => (
                <span key={port} className={styles.workspaceMetaChip}>
                  :{port}
                </span>
              ))}
              {props.row.attention ? (
                <span
                  className={`${styles.workspaceMetaChip} ${styles.workspaceAttention}`}
                >
                  Attention
                </span>
              ) : null}
            </div>
          ) : null}
          {props.expanded &&
          (props.status || props.progress || props.latestLog) ? (
            <div className={styles.workspaceAux}>
              {props.status ? (
                <div className={styles.statusPill}>{props.status}</div>
              ) : null}
              {props.progress ? (
                <div className={styles.workspaceProgress}>
                  <div className={styles.workspaceProgressLabel}>
                    {props.progress.label ?? "Progress"}
                  </div>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${props.progress.value * 100}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {props.latestLog ? (
                <div
                  className={styles.workspaceLog}
                  data-level={props.latestLog.level}
                >
                  <span>{props.latestLog.level}</span>
                  <span>{props.latestLog.message}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function NotificationsPanel(props: {
  notifications: NotificationItem[];
  onClose: () => void;
  onJump: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div className={styles.overlay} onClick={props.onClose}>
      <div
        className={styles.notifications}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h2>Notifications</h2>
          <button aria-label="Close notifications" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className={styles.notificationActions}>
          <button onClick={props.onJump}>Jump latest unread</button>
          <button onClick={props.onClear}>Clear all</button>
        </div>
        <div className={styles.notificationList}>
          {props.notifications.map((notification) => (
            <div
              key={notification.id}
              className={styles.notificationItem}
              data-read={notification.read}
            >
              <div>{notification.title}</div>
              <div>{notification.message}</div>
              <div>{formatClock(notification.createdAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function lastPathSegment(value: string): string | null {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function matchShortcut(
  view: ShellViewModel,
  event: KeyboardEvent,
  commandId: string
): boolean {
  return view.settings.shortcuts[commandId] === normalizeShortcut(event);
}

function omitDeprecatedShortcuts(
  shortcuts: Record<string, string>
): Record<string, string> {
  const nextShortcuts = { ...shortcuts };
  delete nextShortcuts["workspace.switcher"];
  delete nextShortcuts["pane.zoom"];
  return nextShortcuts;
}

function applyTypographySettings(settings: KmuxSettings): void {
  const root = document.documentElement;
  root.style.setProperty(
    "--kmux-font-family",
    settings.terminalFontFamily.trim() ||
      '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace'
  );
  root.style.setProperty(
    "--kmux-font-size",
    `${Number.isFinite(settings.terminalFontSize) ? settings.terminalFontSize : 13}px`
  );
  root.style.setProperty(
    "--kmux-line-height",
    `${Number.isFinite(settings.terminalLineHeight) ? settings.terminalLineHeight : 1}`
  );
}
