// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneTreeProps } from "./PaneTree";

const terminalPaneRenderSpy = vi.fn();

vi.mock("./TerminalPane", () => ({
  TerminalPane: (props: { paneId: string }) => {
    terminalPaneRenderSpy(props.paneId);
    return <div data-testid="terminal-pane" />;
  }
}));

import { PaneTree } from "./PaneTree";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

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
          title: "repo / shell",
          cwd: "/repo",
          branch: "main",
          ports: [3000],
          unreadCount: 0,
          attention: false,
          sessionState: "running"
        }
      },
      activePaneId: "pane_1"
    },
    settings: {
      socketMode: "kmuxOnly",
      warnBeforeQuit: true,
      notificationDesktop: true,
      notificationSound: false,
      terminalUseWebgl: true,
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
    isPaneWebglEnabled: () => true,
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
    onToggleSearch: vi.fn()
  };
}

describe("PaneTree", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    terminalPaneRenderSpy.mockClear();
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
});
