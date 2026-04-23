import {type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef} from "react";

import type {AppAction} from "@kmux/core";
import type {ActiveWorkspacePaneTreeVm, ShellStoreSnapshot} from "@kmux/proto";
import {normalizeShortcut} from "@kmux/ui";

type RightPanelKind = "usage" | null;

interface OverlayState {
  paletteOpen: boolean;
  notificationsOpen: boolean;
  settingsOpen: boolean;
  searchSurfaceId: string | null;
  rightPanelKind: RightPanelKind;
  workspaceContextMenuOpen: boolean;
  workspaceCloseConfirmOpen: boolean;
}

interface ActiveShortcutContext {
  view: ShellStoreSnapshot;
  activePaneId: string;
  activeSurfaceId: string;
}

interface UseGlobalShortcutsOptions {
  isMac: boolean;
  viewRef: MutableRefObject<ShellStoreSnapshot | null>;
  overlayStateRef: MutableRefObject<OverlayState>;
  setShowWorkspaceShortcutHints: Dispatch<SetStateAction<boolean>>;
  closeWorkspaceContextMenu: () => void;
  closeWorkspaceCloseConfirm: () => void;
  setSearchSurfaceId: Dispatch<SetStateAction<string | null>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setNotificationsOpen: Dispatch<SetStateAction<boolean>>;
  setRightPanelKind: Dispatch<SetStateAction<RightPanelKind>>;
  closePalette: () => void;
  openPalette: () => void;
  openSettingsModal: () => void;
  beginWorkspaceRename: (workspaceId: string, sidebarVisible?: boolean) => void;
  dispatch: (action: AppAction) => Promise<void>;
  requestSurfaceClose: (surfaceId: string) => Promise<void>;
  withLatestActiveShortcutContext: (
    run: (context: ActiveShortcutContext) => void | Promise<void>
  ) => Promise<void>;
}

export function useGlobalShortcuts(
  options: UseGlobalShortcutsOptions
): void {
  const optionsRef = useRef(options);

  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const currentOptions = optionsRef.current;
      if (currentOptions.isMac) {
        currentOptions.setShowWorkspaceShortcutHints(event.metaKey);
      }
      const currentView = currentOptions.viewRef.current;
      if (!currentView) {
        return;
      }

      const {
        paletteOpen: currentPaletteOpen,
        notificationsOpen: currentNotificationsOpen,
        settingsOpen: currentSettingsOpen,
        searchSurfaceId: currentSearchSurfaceId,
        rightPanelKind: currentRightPanelKind,
        workspaceContextMenuOpen: currentWorkspaceContextMenuOpen,
        workspaceCloseConfirmOpen: currentWorkspaceCloseConfirmOpen
      } = currentOptions.overlayStateRef.current;
      if (event.key === "Escape") {
        if (currentWorkspaceCloseConfirmOpen) {
          event.preventDefault();
          currentOptions.closeWorkspaceCloseConfirm();
          return;
        }
        if (currentWorkspaceContextMenuOpen) {
          event.preventDefault();
          currentOptions.closeWorkspaceContextMenu();
          return;
        }
        if (currentSearchSurfaceId) {
          event.preventDefault();
          currentOptions.setSearchSurfaceId(null);
          return;
        }
        if (currentSettingsOpen) {
          event.preventDefault();
          currentOptions.setSettingsOpen(false);
          return;
        }
        if (currentNotificationsOpen) {
          event.preventDefault();
          currentOptions.setNotificationsOpen(false);
          return;
        }
        if (currentRightPanelKind) {
          event.preventDefault();
          currentOptions.setRightPanelKind(null);
          return;
        }
        if (currentPaletteOpen) {
          event.preventDefault();
          currentOptions.closePalette();
          return;
        }
      }

      if (
        currentWorkspaceContextMenuOpen ||
        currentWorkspaceCloseConfirmOpen
      ) {
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

      if (terminalOwnsShortcut || isEditable) {
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
        void currentOptions.dispatch({
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
        const latestView = currentOptions.viewRef.current;
        const shortcutTargets = latestView
          ? listWorkspaceSurfaceShortcutTargets(latestView.activeWorkspacePaneTree)
          : [];
        const targetSurfaceId = shortcutTargets[digitIndex] ?? null;
        if (!targetSurfaceId) {
          return;
        }
        void currentOptions.dispatch({
          type: "surface.focus",
          surfaceId: targetSurfaceId
        });
        return;
      }
      if (matchShortcut(currentView, event, "command.palette")) {
        event.preventDefault();
        if (currentPaletteOpen) {
          currentOptions.closePalette();
        } else {
          currentOptions.openPalette();
        }
        return;
      }
      if (matchShortcut(currentView, event, "notifications.toggle")) {
        event.preventDefault();
        currentOptions.setNotificationsOpen((open) => !open);
        return;
      }
      if (matchShortcut(currentView, event, "usage.dashboard.toggle")) {
        event.preventDefault();
        currentOptions.setRightPanelKind((current) =>
          current === "usage" ? null : "usage"
        );
        return;
      }
      if (matchShortcut(currentView, event, "settings.toggle")) {
        event.preventDefault();
        if (currentSettingsOpen) {
          currentOptions.setSettingsOpen(false);
        } else {
          currentOptions.openSettingsModal();
        }
        return;
      }
      if (matchShortcut(currentView, event, "workspace.create")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "workspace.create"
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.rename")) {
        event.preventDefault();
        currentOptions.beginWorkspaceRename(
          currentView.activeWorkspace.id,
          currentView.sidebarVisible
        );
        return;
      }
      if (matchShortcut(currentView, event, "workspace.close")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "workspace.close",
          workspaceId: currentView.activeWorkspace.id
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.next")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "workspace.selectRelative",
          delta: 1
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.prev")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "workspace.selectRelative",
          delta: -1
        });
        return;
      }
      if (matchShortcut(currentView, event, "workspace.sidebar.toggle")) {
        event.preventDefault();
        void currentOptions.dispatch({ type: "workspace.sidebar.toggle" });
        return;
      }
      if (matchShortcut(currentView, event, "pane.split.right")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
              type: "pane.split",
              paneId: latestPaneId,
              direction: "right"
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.split.down")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
              type: "pane.split",
              paneId: latestPaneId,
              direction: "down"
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.left")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "pane.focusDirection",
          direction: "left"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.right")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "pane.focusDirection",
          direction: "right"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.up")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "pane.focusDirection",
          direction: "up"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.down")) {
        event.preventDefault();
        void currentOptions.dispatch({
          type: "pane.focusDirection",
          direction: "down"
        });
        return;
      }
      if (matchShortcut(currentView, event, "pane.resize.left")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
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
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
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
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
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
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
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
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({ type: "pane.close", paneId: latestPaneId })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.create")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
              type: "surface.create",
              paneId: latestPaneId
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.close")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) =>
            currentOptions.requestSurfaceClose(latestSurfaceId)
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.closeOthers")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) =>
            currentOptions.dispatch({
              type: "surface.closeOthers",
              surfaceId: latestSurfaceId
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.next")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
              type: "surface.focusRelative",
              paneId: latestPaneId,
              delta: 1
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.prev")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            currentOptions.dispatch({
              type: "surface.focusRelative",
              paneId: latestPaneId,
              delta: -1
            })
        );
        return;
      }
      if (matchShortcut(currentView, event, "terminal.search")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activeSurfaceId: latestSurfaceId }) => {
            currentOptions.setSearchSurfaceId((current) =>
              current === latestSurfaceId ? null : latestSurfaceId
            );
          }
        );
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [options.isMac]);

  useEffect(() => {
    const hideWorkspaceShortcutHints = () => {
      optionsRef.current.setShowWorkspaceShortcutHints(false);
    };
    const syncWorkspaceShortcutHints = (metaKey: boolean) => {
      optionsRef.current.setShowWorkspaceShortcutHints(metaKey);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!optionsRef.current.isMac) {
        return;
      }
      syncWorkspaceShortcutHints(event.metaKey);
    };
    const onPointerInteraction = (
      event: MouseEvent | PointerEvent | WheelEvent
    ) => {
      if (!optionsRef.current.isMac || event.metaKey) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onWindowFocus = () => {
      if (!optionsRef.current.isMac) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onVisibilityChange = () => {
      if (
        !optionsRef.current.isMac ||
        document.visibilityState === "visible"
      ) {
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
  }, [options.isMac]);
}

function matchShortcut(
  view: ShellStoreSnapshot,
  event: KeyboardEvent,
  commandId: string
): boolean {
  return view.settings.shortcuts[commandId] === normalizeShortcut(event);
}

function listWorkspaceSurfaceShortcutTargets(
  workspace: ActiveWorkspacePaneTreeVm
): string[] {
  return listWorkspacePaneIdsInTreeOrder(workspace).flatMap(
    (paneId) => workspace.panes[paneId]?.surfaceIds ?? []
  );
}

function listWorkspacePaneIdsInTreeOrder(
  workspace: ActiveWorkspacePaneTreeVm
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
