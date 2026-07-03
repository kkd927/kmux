// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneTreeProps } from "./PaneTree";
import {
  isPaneDividerDragActive,
  resetPaneDividerDragForTests
} from "../paneDividerDrag";

const terminalPaneRenderSpy = vi.fn();

vi.mock("./TerminalPane", () => ({
  TerminalPane: (props: { paneId: string }) => {
    terminalPaneRenderSpy(props.paneId);
    return <div data-testid="terminal-pane" />;
  }
}));

import { PaneTree } from "./PaneTree";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createPaneTreeProps(): PaneTreeProps {
  return {
    workspace: {
      id: "workspace_1",
      rootNodeId: "node_1",
      nodes: {
        node_1: {
          id: "node_1",
          kind: "leaf",
          paneId: "pane_1"
        }
      },
      panes: {
        pane_1: {
          id: "pane_1",
          surfaceIds: ["surface_1"],
          activeSurfaceId: "surface_1",
          focused: true
        }
      },
      surfaces: {
        surface_1: {
          id: "surface_1",
          sessionId: "session_1",
          title: "repo / shell",
          cwd: "/repo",
          branch: "main",
          ports: [3000],
          unreadCount: 0,
          attention: false,
          sessionState: "running",
          shellInputReady: true
        }
      },
      activePaneId: "pane_1"
    },
    settings: {
      socketMode: "kmuxOnly",
      warnBeforeQuit: true,
      notificationDesktop: true,
      notificationSound: false,
      themeMode: "dark",
      shell: "/bin/zsh",
      shortcuts: {},
      terminalTypography: {
        preferredTextFontFamily: "SF Mono",
        preferredSymbolFallbackFamilies: [],
        fontSize: 13,
        lineHeight: 1.25
      },
      terminalThemes: {
        activeProfileId: "builtin",
        profiles: []
      }
    },
    reservedSystemChords: [],
    keyboardPlatform: "linux",
    shortcutLabelStyle: "text",
    copyModeSelectAllShortcut: "Ctrl+A",
    terminalTypography: {
      stackHash: "stack_1",
      resolvedFontFamily: "SF Mono",
      textFontFamily: "SF Mono",
      symbolFallbackFamilies: [],
      autoFallbackApplied: false,
      status: "ready",
      issues: []
    },
    terminalTheme: {
      profileId: "builtin",
      profileName: "Builtin",
      source: "builtin",
      minimumContrastRatio: 4.5,
      variant: "dark",
      palette: {
        foreground: "#f5f5f5",
        background: "#111111",
        cursor: "#ffffff",
        cursorText: "#111111",
        selectionBackground: "#333333",
        selectionForeground: "#f5f5f5",
        ansi: new Array(16).fill("#000000")
      }
    },
    active: true,
    colorTheme: "dark",
    searchSurfaceId: null,
    draggedSurfaceTab: null,
    onSetSplitRatio: vi.fn(),
    onFocusPane: vi.fn(),
    onFocusSurface: vi.fn(),
    onCreateSurface: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOthers: vi.fn(),
    onMoveSurfaceToSplit: vi.fn(),
    onSurfaceTabDragStart: vi.fn(),
    onSurfaceTabDragEnd: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClosePane: vi.fn(),
    onRestartSurface: vi.fn(),
    onToggleSearch: vi.fn()
  };
}

function createSplitPaneTreeProps(): PaneTreeProps {
  const base = createPaneTreeProps();
  return {
    ...base,
    workspace: {
      ...base.workspace,
      rootNodeId: "split_1",
      nodes: {
        split_1: {
          id: "split_1",
          kind: "split",
          axis: "vertical",
          ratio: 0.5,
          first: "node_1",
          second: "node_2"
        },
        node_1: {
          id: "node_1",
          kind: "leaf",
          paneId: "pane_1"
        },
        node_2: {
          id: "node_2",
          kind: "leaf",
          paneId: "pane_2"
        }
      },
      panes: {
        ...base.workspace.panes,
        pane_2: {
          id: "pane_2",
          surfaceIds: ["surface_2"],
          activeSurfaceId: "surface_2",
          focused: false
        }
      },
      surfaces: {
        ...base.workspace.surfaces,
        surface_2: {
          ...base.workspace.surfaces.surface_1,
          id: "surface_2",
          sessionId: "session_2",
          title: "repo / shell 2"
        }
      }
    }
  };
}

describe("PaneTree", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    terminalPaneRenderSpy.mockClear();
    resetPaneDividerDragForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetPaneDividerDragForTests();
    container.remove();
  });

  it("does not rerender terminal panes when parent callbacks change but shell props stay stable", () => {
    const props = createPaneTreeProps();

    act(() => {
      root.render(<PaneTree {...props} />);
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <PaneTree
          {...props}
          onFocusPane={() => undefined}
          onFocusSurface={() => undefined}
          onToggleSearch={() => undefined}
        />
      );
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("rerenders terminal panes when the terminal tree slice changes", () => {
    const props = createPaneTreeProps();

    act(() => {
      root.render(<PaneTree {...props} />);
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <PaneTree
          {...props}
          workspace={{
            ...props.workspace,
            surfaces: {
              ...props.workspace.surfaces,
              surface_1: {
                ...props.workspace.surfaces.surface_1,
                title: "repo / codex"
              }
            }
          }}
        />
      );
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(2);
  });

  it("rerenders terminal panes when a surface tab drag starts", () => {
    const props = createPaneTreeProps();

    act(() => {
      root.render(<PaneTree {...props} />);
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <PaneTree
          {...props}
          draggedSurfaceTab={{
            surfaceId: "surface_1",
            sourcePaneId: "pane_1"
          }}
        />
      );
    });

    expect(terminalPaneRenderSpy).toHaveBeenCalledTimes(2);
  });

  it("ends a divider drag when the divider unmounts mid-drag", () => {
    const originalSetPointerCapture = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = vi.fn();
    try {
      const props = createSplitPaneTreeProps();

      act(() => {
        root.render(<PaneTree {...props} />);
      });

      const divider = container.querySelector<HTMLElement>(
        '[data-split-axis="vertical"]'
      );
      expect(divider).toBeTruthy();

      act(() => {
        divider!.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            clientX: 100,
            clientY: 100
          })
        );
      });

      expect(isPaneDividerDragActive()).toBe(true);

      // Simulate the split collapsing (e.g. the sibling pane closing) while
      // the pointer is still down: the divider disappears without a
      // pointerup/pointercancel ever reaching the window listeners.
      act(() => {
        root.render(
          <PaneTree
            {...props}
            workspace={{ ...props.workspace, rootNodeId: "node_1" }}
          />
        );
      });

      expect(container.querySelector('[data-split-axis]')).toBeNull();
      expect(isPaneDividerDragActive()).toBe(false);
    } finally {
      Element.prototype.setPointerCapture = originalSetPointerCapture;
    }
  });
});
