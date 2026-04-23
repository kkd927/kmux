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
});
