// @vitest-environment jsdom

import { act, useRef } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellStoreSnapshot } from "@kmux/proto";

import { useGlobalShortcuts } from "./useGlobalShortcuts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

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
        workspaceCloseConfirmOpen: false
      });

      useGlobalShortcuts({
        isMac: false,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        setSettingsOpen: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind,
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch: vi.fn(async () => undefined),
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
        workspaceCloseConfirmOpen: false
      });

      useGlobalShortcuts({
        isMac: false,
        viewRef,
        dismissibleUiStateRef,
        setShowWorkspaceShortcutHints: vi.fn(),
        closeWorkspaceContextMenu: vi.fn(),
        closeWorkspaceCloseConfirm: vi.fn(),
        setSearchSurfaceId: vi.fn(),
        setSettingsOpen: vi.fn(),
        setNotificationsOpen: vi.fn(),
        setRightPanelKind: vi.fn(),
        closePalette: vi.fn(),
        openPalette: vi.fn(),
        openSettingsModal: vi.fn(),
        beginWorkspaceRename: vi.fn(),
        dispatch,
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
});
