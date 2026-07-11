// @vitest-environment jsdom

import { act, useRef } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellStoreSnapshot } from "@kmux/proto";

import { buildPlatformKeyboardPolicy } from "../../../shared/platform/keyboardPolicy";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createViewSnapshot(): ShellStoreSnapshot {
  return {
    settings: {
      shortcuts: {}
    },
    activeWorkspace: {
      id: "workspace_1"
    },
    activeWorkspacePaneTree: {
      activePaneId: "pane_1"
    },
    sidebarVisible: true
  } as ShellStoreSnapshot;
}

describe("useGlobalShortcuts", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  const linuxKeyboardPolicy = buildPlatformKeyboardPolicy({
    platform: "linux",
    labelStyle: "text"
  });
  const darwinKeyboardPolicy = buildPlatformKeyboardPolicy({
    platform: "darwin",
    labelStyle: "mac-symbols"
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not dismiss the usage right panel on Escape", () => {
    const setRightPanelKind = vi.fn();

    function Harness(): null {
      const viewRef = useRef(createViewSnapshot());
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind,
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch: vi.fn(async () => undefined),
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(setRightPanelKind).not.toHaveBeenCalled();
  });

  it("uses the settings discard close path for Escape and the settings toggle shortcut", () => {
    const closeSettingsModal = vi.fn();

    function Harness(): null {
      const view = createViewSnapshot();
      view.settings.shortcuts = { "settings.toggle": "Meta+," };
      const viewRef = useRef(view);
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: true,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal,
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch: vi.fn(async () => undefined),
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true
        })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ",",
          code: "Comma",
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(closeSettingsModal).toHaveBeenCalledTimes(2);
  });

  it("routes the pane close shortcut through the pane close request flow", () => {
    const dispatch = vi.fn(async () => undefined);
    const requestPaneClose = vi.fn(async () => undefined);
    const withLatestActiveShortcutContext = vi.fn(
      async (
        run: (context: {
          view: ShellStoreSnapshot;
          activePaneId: string;
          activeSurfaceId: string;
        }) => void | Promise<void>
      ) => {
        const view = createViewSnapshot();
        await run({
          view,
          activePaneId: "pane_1",
          activeSurfaceId: "surface_1"
        });
      }
    );

    function Harness(): null {
      const view = createViewSnapshot();
      view.settings.shortcuts = {
        "pane.close": "Meta+Alt+K"
      };
      const viewRef = useRef(view);
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose,
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(requestPaneClose).toHaveBeenCalledWith("pane_1");
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "pane.close",
      paneId: "pane_1"
    });
  });

  it("blocks workspace shortcuts while a worktree dialog is open", () => {
    const dispatch = vi.fn(async () => undefined);
    const requestWorkspaceClose = vi.fn(async () => undefined);
    const terminalInput = document.createElement("textarea");
    terminalInput.className = "xterm-helper-textarea";
    document.body.appendChild(terminalInput);

    function Harness(): null {
      const view = createViewSnapshot();
      view.settings.shortcuts = {
        "workspace.close": "Meta+Alt+W"
      };
      const viewRef = useRef(view);
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: true
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose,
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      terminalInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "w",
          code: "KeyW",
          metaKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    terminalInput.remove();
    expect(requestWorkspaceClose).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets Linux reserved system chords pass through user shortcut bindings", () => {
    const openPalette = vi.fn();
    const requestWorkspaceClose = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);

    function Harness(): null {
      const view = createViewSnapshot();
      view.settings.shortcuts = {
        "command.palette": "Ctrl+Alt+T",
        "workspace.close": "Alt+F4"
      };
      const viewRef = useRef(view);
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette,
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose,
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    const terminalShortcut = new KeyboardEvent("keydown", {
      key: "t",
      code: "KeyT",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      window.dispatchEvent(terminalShortcut);
    });

    const closeShortcut = new KeyboardEvent("keydown", {
      key: "F4",
      code: "F4",
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      window.dispatchEvent(closeShortcut);
    });

    expect(terminalShortcut.defaultPrevented).toBe(false);
    expect(closeShortcut.defaultPrevented).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
    expect(requestWorkspaceClose).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses the keyboard policy for Linux number-row workspace switching", () => {
    const dispatch = vi.fn(async () => undefined);
    const setShowWorkspaceShortcutHints = vi.fn();

    function Harness(): null {
      const viewRef = useRef(createViewSnapshot());
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints,
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          code: "Digit1",
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(setShowWorkspaceShortcutHints).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          code: "Digit1",
          altKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.selectIndex",
      index: 0
    });
  });

  it("keeps macOS number-row workspace switching on the policy Meta modifier", () => {
    const dispatch = vi.fn(async () => undefined);

    function Harness(): null {
      const viewRef = useRef(createViewSnapshot());
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: darwinKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "2",
          code: "Digit2",
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.selectIndex",
      index: 1
    });
  });

  it("uses the keyboard policy for Linux number-row surface switching", () => {
    const dispatch = vi.fn(async () => undefined);

    function Harness(): null {
      const view = createViewSnapshot();
      view.activeWorkspacePaneTree = {
        id: "workspace_1",
        rootNodeId: "split_1",
        activePaneId: "pane_2",
        nodes: {
          split_1: {
            id: "split_1",
            kind: "split",
            axis: "horizontal",
            ratio: 0.5,
            first: "leaf_1",
            second: "leaf_2"
          },
          leaf_1: {
            id: "leaf_1",
            kind: "leaf",
            paneId: "pane_1"
          },
          leaf_2: {
            id: "leaf_2",
            kind: "leaf",
            paneId: "pane_2"
          }
        },
        panes: {
          pane_1: {
            id: "pane_1",
            surfaceIds: ["surface_1", "surface_2"],
            activeSurfaceId: "surface_1",
            focused: false
          },
          pane_2: {
            id: "pane_2",
            surfaceIds: ["surface_3"],
            activeSurfaceId: "surface_3",
            focused: true
          }
        },
        surfaces: {
          surface_1: createSurface("surface_1"),
          surface_2: createSurface("surface_2"),
          surface_3: createSurface("surface_3")
        }
      };
      const viewRef = useRef(view);
      const dismissibleUiStateRef = useRef({
        paletteOpen: false,
        notificationsOpen: false,
        settingsOpen: false,
        searchSurfaceId: null,
        workspaceContextMenuOpen: false,
        workspaceCloseConfirmOpen: false,
        surfaceRestartConfirmOpen: false,
        worktreeDialogOpen: false
      });

      useGlobalShortcuts({
        keyboardPolicy: linuxKeyboardPolicy,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        closeSurfaceRestartConfirm: vi.fn(),
        closeWorktreeDialog: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        closeSettingsModal: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
        requestWorkspaceClose: vi.fn(async () => undefined),
        requestPaneClose: vi.fn(async () => undefined),
        requestSurfaceClose: vi.fn(async () => undefined),
        withLatestActiveShortcutContext: vi.fn(async () => undefined)
      });

      return null;
    }

    act(() => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "2",
          code: "Digit2",
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "surface.focus",
      surfaceId: "surface_2"
    });
  });
});

function createSurface(
  id: string
): ShellStoreSnapshot["activeWorkspacePaneTree"]["surfaces"][string] {
  return {
    id,
    sessionId: `session_${id}`,
    title: id,
    ports: [],
    unreadCount: 0,
    attention: false,
    sessionState: "running",
    shellInputReady: true
  };
}
