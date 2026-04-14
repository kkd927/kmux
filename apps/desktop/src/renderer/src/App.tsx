import {useEffect, useMemo, useRef, useState} from "react";

import type {AppAction} from "@kmux/core";
import type {KmuxSettings, ShellViewModel} from "@kmux/proto";
import {applyThemeVariables, type ColorTheme, resolveColorTheme} from "@kmux/ui";

import {AppOverlays} from "./components/AppOverlays";
import {Codicon} from "./components/Codicon";
import {PaneTree} from "./components/PaneTree";
import {WorkspaceSidebar} from "./components/WorkspaceSidebar";
import {useGlobalShortcuts} from "./hooks/useGlobalShortcuts";
import {useShellView} from "./hooks/useShellView";
import {clampSidebarWidthForWindow, MAX_SIDEBAR_WIDTH, useSidebarResize} from "./hooks/useSidebarResize";
import {useWorkspaceContextMenu} from "./hooks/useWorkspaceContextMenu";
import {
  findWorkspaceContext,
  runWorkspaceContextAction as runSharedWorkspaceContextAction,
  type WorkspaceContextAction
} from "../../shared/workspaceContextMenu";
import styles from "./styles/App.module.css";

type TerminalFocusRequest = {
  surfaceId: string;
  token: number;
};
type ActiveShortcutContext = {
  view: ShellViewModel;
  activePaneId: string;
  activeSurfaceId: string;
};
type OverlayState = {
  paletteOpen: boolean;
  notificationsOpen: boolean;
  settingsOpen: boolean;
  searchSurfaceId: string | null;
  workspaceContextMenuOpen: boolean;
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
  const [terminalFocusRequest, setTerminalFocusRequest] =
    useState<TerminalFocusRequest | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [dropWorkspaceId, setDropWorkspaceId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(
    null
  );
  const [showWorkspaceShortcutHints, setShowWorkspaceShortcutHints] =
    useState(false);
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [windowWidth, setWindowWidth] = useState(
    () => document.documentElement.clientWidth || window.innerWidth
  );
  const [prefersDarkColorScheme, setPrefersDarkColorScheme] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const [settingsDraft, setSettingsDraft] = useState(view?.settings);
  const viewRef = useRef<ShellViewModel | null>(view);
  const overlayStateRef = useRef<OverlayState>({
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: false
  });

  viewRef.current = view;

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
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = (
      event: MediaQueryListEvent | MediaQueryList
    ): void => {
      setPrefersDarkColorScheme(event.matches);
    };

    updatePreference(mediaQuery);
    const listener = (event: MediaQueryListEvent) => updatePreference(event);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const updateWindowWidth = () => {
      const nextWidth = document.documentElement.clientWidth || window.innerWidth;
      setWindowWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth
      );
    };

    updateWindowWidth();
    const resizeObserver = new ResizeObserver(() => {
      updateWindowWidth();
    });
    resizeObserver.observe(document.documentElement);
    window.addEventListener("resize", updateWindowWidth);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWindowWidth);
    };
  }, []);

  useEffect(() => {
    if (!view?.settings) {
      return;
    }
    applyAppearanceSettings(view.settings, prefersDarkColorScheme);
  }, [
    view?.settings?.themeMode,
    view?.settings?.terminalFontFamily,
    view?.settings?.terminalFontSize,
    view?.settings?.terminalLineHeight,
    prefersDarkColorScheme
  ]);

  const resolvedColorTheme = resolveColorTheme(
    view?.settings?.themeMode ?? "dark",
    prefersDarkColorScheme
  );
  const renderedSidebarWidth = clampSidebarWidthForWindow(
    view?.sidebarWidth ?? MAX_SIDEBAR_WIDTH,
    windowWidth
  );

  const {
    workspaceContextMenu,
    workspaceContext,
    workspaceContextMenuItems,
    workspaceMenuRef,
    openWorkspaceContextMenu,
    closeWorkspaceContextMenu
  } = useWorkspaceContextMenu({
    view,
    beginWorkspaceRename
  });

  overlayStateRef.current = {
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: Boolean(workspaceContextMenu)
  };

  const { beginSidebarResize, handleSidebarResizeKeyDown } = useSidebarResize({
    viewRef,
    renderedSidebarWidth,
    setSidebarResizeActive,
    dispatch
  });

  useGlobalShortcuts({
    isMac,
    viewRef,
    overlayStateRef,
    setShowWorkspaceShortcutHints,
    closeWorkspaceContextMenu,
    setSearchSurfaceId,
    requestTerminalFocus,
    setSettingsOpen,
    setNotificationsOpen,
    closePalette,
    openPalette,
    openSettingsModal,
    beginWorkspaceRename,
    dispatch,
    dispatchAndFocusActiveTerminal,
    withLatestActiveShortcutContext
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
        run: () => void dispatch({ type: "workspace.create" })
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
        run: () => openSettingsModal()
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
                  type: "workspace.create"
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
            onClick={() => openSettingsModal()}
          >
            <Codicon name="gear" />
          </button>
        </div>
      </div>
      <div className={styles.shell}>
        {view.sidebarVisible ? (
          <WorkspaceSidebar
            view={view}
            renderedSidebarWidth={renderedSidebarWidth}
            showWorkspaceShortcutHints={showWorkspaceShortcutHints}
            editingWorkspaceId={editingWorkspaceId}
            workspaceContextMenuWorkspaceId={
              workspaceContextMenu?.workspaceId ?? null
            }
            dragWorkspaceId={dragWorkspaceId}
            dropWorkspaceId={dropWorkspaceId}
            dropPosition={dropPosition}
            sidebarResizeActive={sidebarResizeActive}
            onSelectWorkspace={(workspaceId) =>
              void dispatch({
                type: "workspace.select",
                workspaceId
              })
            }
            onStartRename={beginWorkspaceRename}
            onOpenContextMenu={(workspaceId, x, y) =>
              void openWorkspaceContextMenu(workspaceId, x, y)
            }
            onRenameWorkspace={(workspaceId, name) => {
              void dispatch({
                type: "workspace.rename",
                workspaceId,
                name
              });
              setEditingWorkspaceId(null);
            }}
            onDragStartWorkspace={(workspaceId) => {
              setDragWorkspaceId(workspaceId);
              setDropWorkspaceId(null);
              setDropPosition(null);
            }}
            onDragTargetWorkspace={(workspaceId, nextDropPosition) => {
              if (!dragWorkspaceId || dragWorkspaceId === workspaceId) {
                setDropWorkspaceId(null);
                setDropPosition(null);
                return;
              }
              setDropWorkspaceId(workspaceId);
              setDropPosition(nextDropPosition);
            }}
            onDragLeaveWorkspace={(workspaceId) => {
              if (dropWorkspaceId === workspaceId) {
                setDropWorkspaceId(null);
                setDropPosition(null);
              }
            }}
            onDropWorkspace={(workspaceId, nextDropPosition) => {
              if (!dragWorkspaceId || dragWorkspaceId === workspaceId) {
                clearWorkspaceDragState();
                return;
              }
              const sourceIndex = view.workspaceRows.findIndex(
                (entry) => entry.workspaceId === dragWorkspaceId
              );
              const targetIndex = view.workspaceRows.findIndex(
                (entry) => entry.workspaceId === workspaceId
              );
              if (sourceIndex === -1 || targetIndex === -1) {
                clearWorkspaceDragState();
                return;
              }

              const toIndex =
                nextDropPosition === "after"
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
              clearWorkspaceDragState();
            }}
            onDragEndWorkspace={clearWorkspaceDragState}
            onSidebarResizeKeyDown={handleSidebarResizeKeyDown}
            onSidebarResizePointerDown={beginSidebarResize}
          />
        ) : null}
        <main className={styles.main}>
          <PaneTree
            workspace={view.activeWorkspace}
            settings={view.settings}
            colorTheme={resolvedColorTheme}
            searchSurfaceId={searchSurfaceId}
            focusTerminalRequest={terminalFocusRequest}
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
      <AppOverlays
        isMac={isMac}
        paletteOpen={paletteOpen}
        paletteQuery={paletteQuery}
        paletteSelectedIndex={paletteSelectedIndex}
        paletteItems={paletteItems}
        onClosePalette={closePalette}
        onChangePaletteQuery={setPaletteQuery}
        onSelectPaletteIndex={setPaletteSelectedIndex}
        onExecutePaletteItem={executePaletteItem}
        workspaceContextMenu={workspaceContextMenu}
        workspaceContext={workspaceContext}
        workspaceContextMenuItems={workspaceContextMenuItems}
        workspaceMenuRef={workspaceMenuRef}
        onCloseWorkspaceContextMenu={closeWorkspaceContextMenu}
        onWorkspaceContextAction={(action, workspaceId) =>
          void handleWorkspaceContextAction(action, workspaceId)
        }
        notificationsOpen={notificationsOpen}
        notifications={view.notifications}
        onCloseNotifications={() => setNotificationsOpen(false)}
        onJumpNotifications={() => {
          void dispatch({ type: "notification.jumpLatestUnread" });
          setNotificationsOpen(false);
        }}
        onClearNotifications={() =>
          void dispatch({ type: "notification.clear" })
        }
        settingsOpen={settingsOpen}
        settingsDraft={settingsDraft}
        setSettingsDraft={setSettingsDraft}
        onCloseSettings={() => setSettingsOpen(false)}
        onSaveSettings={(draft) => {
          const settingsPatch = {
            ...draft,
            shortcuts: omitDeprecatedShortcuts(draft.shortcuts)
          };
          applyAppearanceSettings(settingsPatch, prefersDarkColorScheme);
          void dispatch({
            type: "settings.update",
            patch: settingsPatch
          });
          setSettingsOpen(false);
        }}
      />
    </div>
  );

  async function dispatch(action: AppAction): Promise<void> {
    await window.kmux.dispatch(action);
  }

  function clearWorkspaceDragState(): void {
    setDragWorkspaceId(null);
    setDropWorkspaceId(null);
    setDropPosition(null);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
  }

  function openPalette(): void {
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
    setPaletteOpen(true);
  }

  function openSettingsModal(): void {
    requestAnimationFrame(() => {
      setSettingsOpen(true);
    });
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

  function requestTerminalFocus(surfaceId: string): void {
    setTerminalFocusRequest({
      surfaceId,
      token: Date.now()
    });
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
    run: (nextView: ShellViewModel) => void | Promise<void>
  ): Promise<void> {
    await run(await window.kmux.getView());
  }

  async function handleWorkspaceContextAction(
    action: WorkspaceContextAction,
    workspaceId: string
  ): Promise<void> {
    closeWorkspaceContextMenu();

    const resolveWorkspaceContext = async () =>
      findWorkspaceContext(await window.kmux.getView(), workspaceId);

    await runSharedWorkspaceContextAction(
      workspaceId,
      action,
      resolveWorkspaceContext,
      {
        rename: async (targetWorkspaceId) => {
          const latestContext = await resolveWorkspaceContext();
          if (!latestContext) {
            return;
          }
          beginWorkspaceRename(
            targetWorkspaceId,
            latestContext.view.sidebarVisible
          );
        },
        dispatch
      }
    );
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

function omitDeprecatedShortcuts(
  shortcuts: Record<string, string>
): Record<string, string> {
  const nextShortcuts = { ...shortcuts };
  delete nextShortcuts["workspace.switcher"];
  delete nextShortcuts["pane.zoom"];
  delete nextShortcuts["surface.rename"];
  return nextShortcuts;
}

function applyAppearanceSettings(
  settings: KmuxSettings,
  prefersDarkColorScheme: boolean
): ColorTheme {
  const root = document.documentElement;
  const resolvedTheme = resolveColorTheme(
    settings.themeMode,
    prefersDarkColorScheme
  );

  applyThemeVariables(root, resolvedTheme);
  root.dataset.colorTheme = resolvedTheme;
  root.dataset.themeMode = settings.themeMode;
  root.style.colorScheme = resolvedTheme;

  applyTypographySettings(settings);
  return resolvedTheme;
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
