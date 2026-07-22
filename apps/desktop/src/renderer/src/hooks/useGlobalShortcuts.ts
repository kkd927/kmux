import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef
} from "react";

import type { AppAction } from "@kmux/core";
import type {
  ActiveWorkspacePaneTreeVm,
  ShellStoreSnapshot
} from "@kmux/proto";
import { normalizeShortcut, normalizeShortcutBinding } from "@kmux/ui";

import {
  isReservedSystemChordBinding,
  type KeyboardShortcutModifier,
  type KeyChord,
  type PlatformKeyboardPolicy
} from "../../../shared/platform/keyboardPolicy";

type RightPanelKind = "usage" | "sessions" | null;

interface DismissibleUiState {
  paletteOpen: boolean;
  notificationsOpen: boolean;
  settingsOpen: boolean;
  searchSurfaceId: string | null;
  workspaceContextMenuOpen: boolean;
  workspaceCloseConfirmOpen: boolean;
  surfaceRestartConfirmOpen: boolean;
  worktreeDialogOpen: boolean;
  sshWorkspaceDialogOpen: boolean;
  sshAskpassPromptOpen: boolean;
}

interface ActiveShortcutContext {
  view: ShellStoreSnapshot;
  activePaneId: string;
  activeSurfaceId: string;
}

interface UseGlobalShortcutsOptions {
  keyboardPolicy: PlatformKeyboardPolicy;
  viewRef: MutableRefObject<ShellStoreSnapshot | null>;
  dismissibleUiStateRef: MutableRefObject<DismissibleUiState>;
  setShowWorkspaceShortcutHints: Dispatch<SetStateAction<boolean>>;
  closeWorkspaceContextMenu: () => void;
  closeWorkspaceCloseConfirm: () => void;
  closeSurfaceRestartConfirm: () => void;
  closeWorktreeDialog: () => void;
  closeSshWorkspaceDialog: () => void;
  closeSshAskpassPrompt: () => void;
  setSearchSurfaceId: Dispatch<SetStateAction<string | null>>;
  closeSettingsModal: () => void;
  setNotificationsOpen: Dispatch<SetStateAction<boolean>>;
  setRightPanelKind: Dispatch<SetStateAction<RightPanelKind>>;
  closePalette: () => void;
  openPalette: () => void;
  openSettingsModal: () => void;
  beginWorkspaceRename: (workspaceId: string, sidebarVisible?: boolean) => void;
  dispatch: (action: AppAction) => Promise<void>;
  requestTerminalFocus?: (surfaceId: string) => void;
  requestWorkspaceClose: (workspaceId: string) => Promise<void>;
  requestPaneClose: (paneId: string) => Promise<void>;
  requestSurfaceClose: (surfaceId: string) => Promise<void>;
  withLatestActiveShortcutContext: (
    run: (context: ActiveShortcutContext) => void | Promise<void>
  ) => Promise<void>;
}

export function useGlobalShortcuts(options: UseGlobalShortcutsOptions): void {
  const optionsRef = useRef(options);

  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const currentOptions = optionsRef.current;
      const hintModifier =
        currentOptions.keyboardPolicy.workspaceShortcutHintModifier;
      if (hintModifier) {
        currentOptions.setShowWorkspaceShortcutHints(
          isModifierPressed(event, hintModifier)
        );
      }
      const currentView = currentOptions.viewRef.current;
      if (!currentView) {
        return;
      }
      const requestTerminalFocus = (surfaceId: string): void => {
        currentOptions.requestTerminalFocus?.(surfaceId);
      };
      const requestActiveTerminalFocusAfter = async (
        run: () => Promise<void>
      ): Promise<void> => {
        await run();
        await currentOptions.withLatestActiveShortcutContext(
          ({ activeSurfaceId }) => requestTerminalFocus(activeSurfaceId)
        );
      };

      const {
        paletteOpen: currentPaletteOpen,
        notificationsOpen: currentNotificationsOpen,
        settingsOpen: currentSettingsOpen,
        searchSurfaceId: currentSearchSurfaceId,
        workspaceContextMenuOpen: currentWorkspaceContextMenuOpen,
        workspaceCloseConfirmOpen: currentWorkspaceCloseConfirmOpen,
        surfaceRestartConfirmOpen: currentSurfaceRestartConfirmOpen,
        worktreeDialogOpen: currentWorktreeDialogOpen,
        sshWorkspaceDialogOpen: currentSshWorkspaceDialogOpen,
        sshAskpassPromptOpen: currentSshAskpassPromptOpen
      } = currentOptions.dismissibleUiStateRef.current;
      const target = event.target;
      const isShortcutRecorder =
        target instanceof HTMLElement &&
        target.closest("[data-shortcut-recorder]");
      if (isShortcutRecorder) {
        return;
      }

      if (isReservedSystemChord(event, currentOptions.keyboardPolicy)) {
        return;
      }

      if (event.key === "Escape") {
        if (currentSshAskpassPromptOpen) {
          event.preventDefault();
          currentOptions.closeSshAskpassPrompt();
          return;
        }
        if (currentWorkspaceCloseConfirmOpen) {
          event.preventDefault();
          currentOptions.closeWorkspaceCloseConfirm();
          return;
        }
        if (currentSurfaceRestartConfirmOpen) {
          event.preventDefault();
          currentOptions.closeSurfaceRestartConfirm();
          return;
        }
        if (currentWorktreeDialogOpen) {
          event.preventDefault();
          currentOptions.closeWorktreeDialog();
          return;
        }
        if (currentSshWorkspaceDialogOpen) {
          event.preventDefault();
          currentOptions.closeSshWorkspaceDialog();
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
          currentOptions.closeSettingsModal();
          return;
        }
        if (currentNotificationsOpen) {
          event.preventDefault();
          currentOptions.setNotificationsOpen(false);
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
        currentWorkspaceCloseConfirmOpen ||
        currentSurfaceRestartConfirmOpen ||
        currentWorktreeDialogOpen ||
        currentSshWorkspaceDialogOpen ||
        currentSshAskpassPromptOpen
      ) {
        return;
      }

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
        matchesNumberRowShortcut(
          event,
          currentOptions.keyboardPolicy.numberRowShortcuts.workspaceModifier,
          digitIndex
        )
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
        matchesNumberRowShortcut(
          event,
          currentOptions.keyboardPolicy.numberRowShortcuts.surfaceModifier,
          digitIndex
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        const latestView = currentOptions.viewRef.current;
        const shortcutTargets = latestView
          ? listWorkspaceSurfaceShortcutTargets(
              latestView.activeWorkspacePaneTree
            )
          : [];
        const targetSurfaceId = shortcutTargets[digitIndex] ?? null;
        if (!targetSurfaceId) {
          return;
        }
        void requestActiveTerminalFocusAfter(() =>
          currentOptions.dispatch({
            type: "surface.focus",
            surfaceId: targetSurfaceId
          })
        );
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
          currentOptions.closeSettingsModal();
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
        void currentOptions.requestWorkspaceClose(
          currentView.activeWorkspace.id
        );
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
            requestActiveTerminalFocusAfter(() =>
              currentOptions.dispatch({
                type: "pane.split",
                paneId: latestPaneId,
                direction: "right"
              })
            )
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.split.down")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            requestActiveTerminalFocusAfter(() =>
              currentOptions.dispatch({
                type: "pane.split",
                paneId: latestPaneId,
                direction: "down"
              })
            )
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.left")) {
        event.preventDefault();
        void requestActiveTerminalFocusAfter(() =>
          currentOptions.dispatch({
            type: "pane.focusDirection",
            direction: "left"
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.right")) {
        event.preventDefault();
        void requestActiveTerminalFocusAfter(() =>
          currentOptions.dispatch({
            type: "pane.focusDirection",
            direction: "right"
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.up")) {
        event.preventDefault();
        void requestActiveTerminalFocusAfter(() =>
          currentOptions.dispatch({
            type: "pane.focusDirection",
            direction: "up"
          })
        );
        return;
      }
      if (matchShortcut(currentView, event, "pane.focus.down")) {
        event.preventDefault();
        void requestActiveTerminalFocusAfter(() =>
          currentOptions.dispatch({
            type: "pane.focusDirection",
            direction: "down"
          })
        );
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
            currentOptions.requestPaneClose(latestPaneId)
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.create")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            requestActiveTerminalFocusAfter(() =>
              currentOptions.dispatch({
                type: "surface.create",
                paneId: latestPaneId
              })
            )
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
            requestActiveTerminalFocusAfter(() =>
              currentOptions.dispatch({
                type: "surface.focusRelative",
                paneId: latestPaneId,
                delta: 1
              })
            )
        );
        return;
      }
      if (matchShortcut(currentView, event, "surface.prev")) {
        event.preventDefault();
        void currentOptions.withLatestActiveShortcutContext(
          ({ activePaneId: latestPaneId }) =>
            requestActiveTerminalFocusAfter(() =>
              currentOptions.dispatch({
                type: "surface.focusRelative",
                paneId: latestPaneId,
                delta: -1
              })
            )
        );
        return;
      }
      if (matchShortcut(currentView, event, "terminal.search")) {
        const paneTree = currentView.activeWorkspacePaneTree;
        const activePane = paneTree.panes[paneTree.activePaneId];
        const activeSurface = activePane
          ? paneTree.surfaces[activePane.activeSurfaceId]
          : undefined;
        if (activeSurface?.content.kind !== "terminal") {
          return;
        }
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
  }, [options.keyboardPolicy]);

  useEffect(() => {
    const hideWorkspaceShortcutHints = () => {
      optionsRef.current.setShowWorkspaceShortcutHints(false);
    };
    const syncWorkspaceShortcutHints = (
      event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
    ) => {
      const hintModifier =
        optionsRef.current.keyboardPolicy.workspaceShortcutHintModifier;
      if (!hintModifier) {
        return;
      }
      optionsRef.current.setShowWorkspaceShortcutHints(
        isModifierPressed(event, hintModifier)
      );
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!optionsRef.current.keyboardPolicy.workspaceShortcutHintModifier) {
        return;
      }
      syncWorkspaceShortcutHints(event);
    };
    const onPointerInteraction = (
      event: MouseEvent | PointerEvent | WheelEvent
    ) => {
      const hintModifier =
        optionsRef.current.keyboardPolicy.workspaceShortcutHintModifier;
      if (!hintModifier || isModifierPressed(event, hintModifier)) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onWindowFocus = () => {
      if (!optionsRef.current.keyboardPolicy.workspaceShortcutHintModifier) {
        return;
      }
      hideWorkspaceShortcutHints();
    };
    const onVisibilityChange = () => {
      if (
        !optionsRef.current.keyboardPolicy.workspaceShortcutHintModifier ||
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
  }, [options.keyboardPolicy]);
}

function isModifierPressed(
  event: Pick<
    KeyboardEvent | MouseEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  modifier: KeyboardShortcutModifier
): boolean {
  switch (modifier) {
    case "Meta":
      return event.metaKey;
    case "Ctrl":
      return event.ctrlKey;
    case "Alt":
      return event.altKey;
    case "Shift":
      return event.shiftKey;
  }
}

function matchesNumberRowShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  modifier: KeyboardShortcutModifier | null,
  digitIndex: number
): boolean {
  if (!modifier || Number.isNaN(digitIndex)) {
    return false;
  }

  switch (modifier) {
    case "Meta":
      return event.metaKey && !event.altKey && !event.shiftKey;
    case "Ctrl":
      return (
        event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
      );
    case "Alt":
      return (
        event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      );
    case "Shift":
      return (
        event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      );
  }
}

function matchShortcut(
  view: ShellStoreSnapshot,
  event: KeyboardEvent,
  commandId: string
): boolean {
  return (
    normalizeShortcutBinding(view.settings.shortcuts[commandId] ?? "") ===
    normalizeShortcut(event)
  );
}

const keyboardShortcutModifiers: KeyboardShortcutModifier[] = [
  "Meta",
  "Ctrl",
  "Alt",
  "Shift"
];

function isReservedSystemChord(
  event: KeyboardEvent,
  keyboardPolicy: PlatformKeyboardPolicy
): boolean {
  const eventShortcut = normalizeShortcutForReservedSystemChord(event);
  return isReservedSystemChordBinding(
    eventShortcut,
    keyboardPolicy.reservedSystemChords
  );
}

function normalizeShortcutForReservedSystemChord(
  event: KeyboardEvent
): KeyChord {
  return normalizeModifierOnlyShortcut(event) ?? normalizeShortcut(event);
}

function normalizeModifierOnlyShortcut(event: KeyboardEvent): string | null {
  const modifier = shortcutModifierFromKey(event.key);
  if (!modifier) {
    return null;
  }

  const activeModifiers = keyboardShortcutModifiers.filter((current) =>
    isModifierPressed(event, current)
  );
  return activeModifiers.length === 1 && activeModifiers[0] === modifier
    ? modifier
    : null;
}

function shortcutModifierFromKey(key: string): KeyboardShortcutModifier | null {
  switch (key) {
    case "Meta":
    case "OS":
      return "Meta";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
    case "Option":
      return "Alt";
    case "Shift":
      return "Shift";
    default:
      return null;
  }
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
