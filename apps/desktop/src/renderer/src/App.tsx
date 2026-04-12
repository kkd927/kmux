import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { AppAction } from "@kmux/core";
import type {
  ActiveWorkspaceVm,
  KmuxSettings,
  ShellViewModel,
  WorkspaceRowVm
} from "@kmux/proto";
import {
  applyThemeVariables,
  normalizeShortcut,
  resolveColorTheme,
  type ColorTheme
} from "@kmux/ui";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Codicon } from "./components/Codicon";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { PaneTree } from "./components/PaneTree";
import { WorkspaceCard } from "./components/WorkspaceCard";
import { WorkspaceContextMenu } from "./components/WorkspaceContextMenu";
import { useShellView } from "./hooks/useShellView";
import {
  buildWorkspaceContextMenuEntries,
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
type WorkspaceContextMenuState = {
  workspaceId: string;
  x: number;
  y: number;
};
type SidebarResizeState = {
  startX: number;
  startWidth: number;
};
const MIN_SIDEBAR_WIDTH = 110;
const MAX_SIDEBAR_WIDTH = 320;
const NARROW_WINDOW_SIDEBAR_BREAKPOINT = 1180;
const NARROW_WINDOW_MAX_SIDEBAR_WIDTH = 272;

function maxSidebarWidthForWindow(windowWidth: number): number {
  return windowWidth <= NARROW_WINDOW_SIDEBAR_BREAKPOINT
    ? Math.min(MAX_SIDEBAR_WIDTH, NARROW_WINDOW_MAX_SIDEBAR_WIDTH)
    : MAX_SIDEBAR_WIDTH;
}

function clampSidebarWidthForWindow(width: number, windowWidth: number): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(maxSidebarWidthForWindow(windowWidth), Math.round(width))
  );
}

function estimateWorkspaceRowHeight(
  row: WorkspaceRowVm | undefined,
  activeWorkspace: ActiveWorkspaceVm | undefined
): number {
  if (!row) {
    return 62;
  }

  const isActive = row.workspaceId === activeWorkspace?.id;
  let height = 62;

  if (isActive && row.cwd) {
    height += 19;
  }

  if (row.attention || (isActive && (Boolean(row.branch) || row.ports.length > 0))) {
    height += 27;
  }

  if (isActive) {
    if (activeWorkspace?.sidebarStatus) {
      height += 29;
    }
    if (activeWorkspace?.progress) {
      height += 39;
    }
    if (activeWorkspace?.logs[0]) {
      height += 24;
    }
  }

  return height;
}

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
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
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
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ShellViewModel | null>(view);
  const sidebarResizeStateRef = useRef<SidebarResizeState | null>(null);
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
    if (!workspaceContextMenu) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      workspaceMenuRef.current
        ?.querySelector<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)'
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [workspaceContextMenu]);

  useEffect(() => {
    return window.kmux.subscribeWorkspaceRenameRequest((workspaceId) => {
      beginWorkspaceRename(workspaceId);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMac) {
        setShowWorkspaceShortcutHints(event.metaKey);
      }
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

      const digitIndex =
        event.code.startsWith("Digit") && event.code.length === "Digit1".length
          ? Number(event.code.slice("Digit".length)) - 1
          : Number.NaN;

      if (
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !Number.isNaN(digitIndex)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void window.kmux.dispatch({
          type: "workspace.selectIndex",
          index: digitIndex
        });
        return;
      }
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !Number.isNaN(digitIndex)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const latestView = viewRef.current;
        const shortcutTargets = latestView
          ? listWorkspaceSurfaceShortcutTargets(latestView.activeWorkspace)
          : [];
        const targetSurfaceId = shortcutTargets[digitIndex] ?? null;
        if (!targetSurfaceId) {
          return;
        }
        window.setTimeout(() => {
          requestTerminalFocus(targetSurfaceId);
          void window.kmux.dispatch({
            type: "surface.focus",
            surfaceId: targetSurfaceId
          });
        }, 0);
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
        if (currentSettingsOpen) {
          setSettingsOpen(false);
        } else {
          openSettingsModal();
        }
        return;
      }
      if (matchShortcut(currentView, event, "workspace.create")) {
        event.preventDefault();
        void window.kmux.dispatch({
          type: "workspace.create"
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
          dispatch({
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
          dispatch({
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
          dispatch({
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
          dispatch({
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
          dispatch({ type: "pane.close", paneId: latestPaneId })
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
      if (matchShortcut(currentView, event, "surface.close")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) =>
            dispatch({
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
            dispatch({
              type: "surface.closeOthers",
              surfaceId: latestSurfaceId
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.next")) {
        event.preventDefault();
        void withLatestActiveShortcutContext(({ activePaneId: latestPaneId }) =>
          dispatchAndFocusActiveTerminal({
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
          dispatchAndFocusActiveTerminal({
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
  }, [isMac]);

  useEffect(() => {
    const hideWorkspaceShortcutHints = () => {
      setShowWorkspaceShortcutHints(false);
    };
    const syncWorkspaceShortcutHints = (metaKey: boolean) => {
      setShowWorkspaceShortcutHints(metaKey);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isMac) {
        return;
      }
      syncWorkspaceShortcutHints(event.metaKey);
    };
    const onPointerInteraction = (event: MouseEvent | PointerEvent | WheelEvent) => {
      if (!isMac || event.metaKey) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onWindowFocus = () => {
      if (!isMac) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onVisibilityChange = () => {
      if (!isMac || document.visibilityState === "visible") {
        return;
      }
      hideWorkspaceShortcutHints();
    };

    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", hideWorkspaceShortcutHints);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("pointerdown", onPointerInteraction, true);
    window.addEventListener("wheel", onPointerInteraction, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", hideWorkspaceShortcutHints);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("pointerdown", onPointerInteraction, true);
      window.removeEventListener("wheel", onPointerInteraction, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isMac]);

  useEffect(() => {
    const stopSidebarResize = () => {
      if (!sidebarResizeStateRef.current) {
        return;
      }
      sidebarResizeStateRef.current = null;
      setSidebarResizeActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onPointerMove = (event: PointerEvent) => {
      const dragState = sidebarResizeStateRef.current;
      if (!dragState) {
        return;
      }
      const nextWidth = clampSidebarWidthForWindow(
        dragState.startWidth + event.clientX - dragState.startX,
        window.innerWidth
      );
      const currentRenderedWidth = clampSidebarWidthForWindow(
        viewRef.current?.sidebarWidth ?? nextWidth,
        window.innerWidth
      );
      if (nextWidth === currentRenderedWidth) {
        return;
      }
      void window.kmux.dispatch({
        type: "workspace.sidebar.setWidth",
        width: nextWidth
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopSidebarResize);
    window.addEventListener("pointercancel", stopSidebarResize);
    window.addEventListener("blur", stopSidebarResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopSidebarResize);
      window.removeEventListener("pointercancel", stopSidebarResize);
      window.removeEventListener("blur", stopSidebarResize);
      stopSidebarResize();
    };
  }, []);

  const rows = view?.workspaceRows ?? [];
  const workspaceContext = workspaceContextMenu && view
    ? findWorkspaceContext(view, workspaceContextMenu.workspaceId)
    : null;
  const workspaceContextMenuItems = workspaceContext
    ? buildWorkspaceContextMenuEntries(workspaceContext)
      : [];
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sidebarRef.current,
    getItemKey: (index) => rows[index]?.workspaceId ?? index,
    estimateSize: (index) =>
      estimateWorkspaceRowHeight(rows[index], view?.activeWorkspace),
    overscan: 4,
    useAnimationFrameWithResizeObserver: true
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      sidebarRef.current
        ?.querySelectorAll<HTMLElement>("[data-workspace-virtual-item]")
        .forEach((element) => {
          rowVirtualizer.measureElement(element);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    rowVirtualizer,
    rows,
    view?.activeWorkspace.id,
    view?.activeWorkspace.sidebarStatus,
    view?.activeWorkspace.progress?.label,
    view?.activeWorkspace.progress?.value,
    view?.activeWorkspace.logs[0]?.id,
    showWorkspaceShortcutHints,
    editingWorkspaceId,
    renderedSidebarWidth
  ]);

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
          <>
            <aside
              className={styles.sidebar}
              data-testid="workspace-tool-window"
              style={{
                width: `${renderedSidebarWidth}px`,
                minWidth: `${renderedSidebarWidth}px`,
                maxWidth: `${renderedSidebarWidth}px`
              }}
            >
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
                            data-workspace-virtual-item=""
                            ref={rowVirtualizer.measureElement}
                            style={{
                              transform: `translateY(${item.start}px)`
                            }}
                          >
                            <WorkspaceCard
                              row={row}
                              displayName={
                                row.nameLocked ? row.name : "new workspace"
                              }
                              shortcutHint={
                                showWorkspaceShortcutHints && item.index < 9
                                  ? `⌘${item.index + 1}`
                                  : undefined
                              }
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
                                void openWorkspaceContextMenu(
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
            <div
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuenow={view.sidebarWidth}
              className={styles.sidebarResizer}
              data-active={sidebarResizeActive}
              data-testid="sidebar-resizer"
              onKeyDown={handleSidebarResizeKeyDown}
              onPointerDown={beginSidebarResize}
              role="separator"
              tabIndex={0}
            />
          </>
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
      {workspaceContextMenu && workspaceContext ? (
        <WorkspaceContextMenu
          workspaceName={workspaceContext.row.name}
          position={workspaceContextMenu}
          items={workspaceContextMenuItems}
          isMac={isMac}
          menuRef={workspaceMenuRef}
          onClose={closeWorkspaceContextMenu}
          onAction={(action) =>
            void handleWorkspaceContextAction(
              action,
              workspaceContext.row.workspaceId
            )
          }
        />
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
        <div
          className={`${styles.overlay} ${styles.settingsOverlay}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
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
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.settingsBody} data-testid="settings-body">
              <label>
                Theme mode
                <select
                  aria-label="Theme mode"
                  value={settingsDraft.themeMode}
                  onChange={(event) => {
                    const themeMode =
                      event.currentTarget
                        .value as ShellViewModel["settings"]["themeMode"];
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            themeMode
                          }
                        : current
                    );
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
                  value={settingsDraft.socketMode}
                  onChange={(event) => {
                    const socketMode =
                      event.currentTarget
                        .value as ShellViewModel["settings"]["socketMode"];
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            socketMode
                          }
                        : current
                    );
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
                  checked={settingsDraft.startupRestore}
                  onChange={(event) => {
                    const startupRestore = event.currentTarget.checked;
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            startupRestore
                          }
                        : current
                    );
                  }}
                />
              </label>
              <label>
                Desktop notifications
                <input
                  aria-label="Desktop notifications"
                  type="checkbox"
                  checked={settingsDraft.notificationDesktop}
                  onChange={(event) => {
                    const notificationDesktop = event.currentTarget.checked;
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            notificationDesktop
                          }
                        : current
                    );
                  }}
                />
              </label>
              <label>
                Font family
                <input
                  aria-label="Font family"
                  type="text"
                  value={settingsDraft.terminalFontFamily}
                  onChange={(event) => {
                    const terminalFontFamily = event.currentTarget.value;
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            terminalFontFamily
                          }
                        : current
                    );
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
                  value={settingsDraft.terminalFontSize}
                  onChange={(event) => {
                    const terminalFontSize = Number(event.currentTarget.value);
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            terminalFontSize
                          }
                        : current
                    );
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
                  value={settingsDraft.terminalLineHeight}
                  onChange={(event) => {
                    const terminalLineHeight = Number(event.currentTarget.value);
                    setSettingsDraft((current) =>
                      current
                        ? {
                            ...current,
                            terminalLineHeight
                          }
                        : current
                    );
                  }}
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
                        onChange={(event) => {
                          const nextBinding = event.currentTarget.value;
                          setSettingsDraft((current) =>
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
              <button
                aria-label="Cancel"
                onClick={() => setSettingsOpen(false)}
              >
                Cancel
              </button>
              <button
                aria-label="Save"
                onClick={() => {
                  const settingsPatch = {
                    ...settingsDraft,
                    shortcuts: omitDeprecatedShortcuts(settingsDraft.shortcuts)
                  };
                  applyAppearanceSettings(settingsPatch, prefersDarkColorScheme);
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

  function openSettingsModal(): void {
    requestAnimationFrame(() => {
      setSettingsOpen(true);
    });
  }

  async function openWorkspaceContextMenu(
    workspaceId: string,
    x: number,
    y: number
  ): Promise<void> {
    setWorkspaceContextMenu(null);

    const usedNative = await window.kmux.showWorkspaceContextMenu(
      workspaceId,
      x,
      y
    );
    if (usedNative) {
      return;
    }

    const menuWidth = 272;
    const menuHeight = 252;
    setWorkspaceContextMenu({
      workspaceId,
      x: Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12))
    });
  }

  function closeWorkspaceContextMenu(): void {
    setWorkspaceContextMenu(null);
  }

  function setSidebarWidth(width: number): void {
    const nextWidth = clampSidebarWidthForWindow(width, window.innerWidth);
    if (nextWidth === renderedSidebarWidth) {
      return;
    }
    void dispatch({
      type: "workspace.sidebar.setWidth",
      width: nextWidth
    });
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !viewRef.current?.sidebarVisible) {
      return;
    }
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: renderedSidebarWidth
    };
    setSidebarResizeActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  }

  function handleSidebarResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void {
    if (!viewRef.current?.sidebarVisible) {
      return;
    }
    const currentWidth = renderedSidebarWidth;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth(currentWidth - 12);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(currentWidth + 12);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(maxSidebarWidthForWindow(window.innerWidth));
    }
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
    run: (view: ShellViewModel) => void | Promise<void>
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

function listWorkspaceSurfaceShortcutTargets(
  workspace: ActiveWorkspaceVm
): string[] {
  return listWorkspacePaneIdsInTreeOrder(workspace).flatMap(
    (paneId) => workspace.panes[paneId]?.surfaceIds ?? []
  );
}

function listWorkspacePaneIdsInTreeOrder(
  workspace: ActiveWorkspaceVm
): string[] {
  const paneIds: string[] = [];

  function walk(nodeId: string): void {
    const node = workspace.nodes[nodeId];
    if (!node) {
      return;
    }
    if (node.kind === "leaf") {
      if (workspace.panes[node.paneId]) {
        paneIds.push(node.paneId);
      }
      return;
    }
    walk(node.first);
    walk(node.second);
  }

  walk(workspace.rootNodeId);
  return paneIds;
}
