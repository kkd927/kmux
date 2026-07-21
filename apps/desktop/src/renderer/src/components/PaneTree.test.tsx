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

vi.mock("./SurfacePane", () => ({
  SurfacePane: (props: { paneId: string }) => {
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
          paneId: "pane_1",
          title: "repo / shell",
          titleLocked: false,
          unreadCount: 0,
          attention: false,
          content: {
            kind: "terminal",
            sessionId: "session_1",
            runtimeStatus: "running",
            shellInputReady: true,
            runtimeMetadata: {
              cwd: "/repo",
              branch: "main",
              ports: [3000]
            }
          }
        }
      },
      activePaneId: "pane_1"
    },
    settings: {
      socketMode: "kmuxOnly",
      warnBeforeQuit: true,
      restoreWorkspacesAfterQuit: true,
      notificationDesktop: true,
      notificationSound: false,
      themeMode: "dark",
      shell: "/bin/zsh",
      surfaceDiagnosticCaptureMode: "default",
      diagnosticLoggingEnabled: false,
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
          paneId: "pane_2",
          content: {
            ...base.workspace.surfaces.surface_1.content,
            sessionId: "session_2"
          },
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

  it("applies divider drag locally and commits the ratio once on pointerup", () => {
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
      const split = divider!.parentElement!;
      const first = divider!.previousElementSibling as HTMLElement;
      const second = divider!.nextElementSibling as HTMLElement;
      split.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;

      act(() => {
        divider!.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            clientX: 500,
            clientY: 250
          })
        );
      });
      expect(isPaneDividerDragActive()).toBe(true);

      act(() => {
        window.dispatchEvent(
          new PointerEvent("pointermove", { clientX: 300, clientY: 250 })
        );
      });
      expect(first.style.flexGrow).toBe("0.3");
      expect(second.style.flexGrow).toBe("0.7");
      expect(props.onSetSplitRatio).not.toHaveBeenCalled();

      // Dragging past the edge clamps the preview to the reducer bounds.
      act(() => {
        window.dispatchEvent(
          new PointerEvent("pointermove", { clientX: 20, clientY: 250 })
        );
      });
      expect(first.style.flexGrow).toBe("0.1");
      expect(second.style.flexGrow).toBe("0.9");
      expect(props.onSetSplitRatio).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new PointerEvent("pointerup", {}));
      });
      expect(props.onSetSplitRatio).toHaveBeenCalledTimes(1);
      expect(props.onSetSplitRatio).toHaveBeenCalledWith("split_1", 0.1);
      expect(isPaneDividerDragActive()).toBe(false);
    } finally {
      Element.prototype.setPointerCapture = originalSetPointerCapture;
    }
  });

  it("does not commit a ratio when the pointer never moved", () => {
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
      act(() => {
        window.dispatchEvent(new PointerEvent("pointerup", {}));
      });

      expect(props.onSetSplitRatio).not.toHaveBeenCalled();
      expect(isPaneDividerDragActive()).toBe(false);
    } finally {
      Element.prototype.setPointerCapture = originalSetPointerCapture;
    }
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

      expect(container.querySelector("[data-split-axis]")).toBeNull();
      expect(isPaneDividerDragActive()).toBe(false);
    } finally {
      Element.prototype.setPointerCapture = originalSetPointerCapture;
    }
  });
});
