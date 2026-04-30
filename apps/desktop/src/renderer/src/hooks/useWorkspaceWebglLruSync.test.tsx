// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveWorkspacePaneTreeVm, ShellStoreSnapshot } from "@kmux/proto";

import { useWorkspaceWebglLruSync } from "./useWorkspaceWebglLruSync";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function createWorkspacePaneTree(
  activePaneId: string,
  paneIds: string[] = ["pane_a", "pane_b"]
): ActiveWorkspacePaneTreeVm {
  return {
    id: "workspace_1",
    rootNodeId: "node_root",
    nodes: {
      node_root: {
        id: "node_root",
        kind: "leaf",
        paneId: paneIds[0] ?? activePaneId
      }
    },
    panes: Object.fromEntries(
      paneIds.map((paneId) => [
        paneId,
        {
          id: paneId,
          surfaceIds: [`surface_${paneId}`],
          activeSurfaceId: `surface_${paneId}`,
          focused: paneId === activePaneId
        }
      ])
    ),
    surfaces: Object.fromEntries(
      paneIds.map((paneId) => [
        `surface_${paneId}`,
        {
          id: `surface_${paneId}`,
          title: paneId,
          ports: [],
          unreadCount: 0,
          attention: false,
          sessionState: "running"
        }
      ])
    ),
    activePaneId
  };
}

function TestHarness(props: {
  activeWorkspacePaneTree: ActiveWorkspacePaneTreeVm | null;
  workspacePaneTrees: ShellStoreSnapshot["workspacePaneTrees"];
  touchPane: (paneId: string) => void;
  forgetPane: (paneId: string) => void;
  releaseTerminalPane: (paneId: string) => void;
}): null {
  useWorkspaceWebglLruSync(props);
  return null;
}

describe("useWorkspaceWebglLruSync", () => {
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

  it("touches the active pane when keyboard focus changes without pane set changes", () => {
    const touchPane = vi.fn();
    const forgetPane = vi.fn();
    const releaseTerminalPane = vi.fn();
    const initialTree = createWorkspacePaneTree("pane_a");
    const nextTree = createWorkspacePaneTree("pane_b");

    act(() => {
      root.render(
        <TestHarness
          activeWorkspacePaneTree={initialTree}
          workspacePaneTrees={{ workspace_1: initialTree }}
          touchPane={touchPane}
          forgetPane={forgetPane}
          releaseTerminalPane={releaseTerminalPane}
        />
      );
    });
    touchPane.mockClear();

    act(() => {
      root.render(
        <TestHarness
          activeWorkspacePaneTree={nextTree}
          workspacePaneTrees={{ workspace_1: nextTree }}
          touchPane={touchPane}
          forgetPane={forgetPane}
          releaseTerminalPane={releaseTerminalPane}
        />
      );
    });

    expect(touchPane).toHaveBeenCalledTimes(1);
    expect(touchPane).toHaveBeenCalledWith("pane_b");
  });

  it("forgets and releases panes that leave all workspace trees", () => {
    const touchPane = vi.fn();
    const forgetPane = vi.fn();
    const releaseTerminalPane = vi.fn();
    const initialTree = createWorkspacePaneTree("pane_a", ["pane_a", "pane_b"]);
    const nextTree = createWorkspacePaneTree("pane_a", ["pane_a"]);

    act(() => {
      root.render(
        <TestHarness
          activeWorkspacePaneTree={initialTree}
          workspacePaneTrees={{ workspace_1: initialTree }}
          touchPane={touchPane}
          forgetPane={forgetPane}
          releaseTerminalPane={releaseTerminalPane}
        />
      );
    });

    act(() => {
      root.render(
        <TestHarness
          activeWorkspacePaneTree={nextTree}
          workspacePaneTrees={{ workspace_1: nextTree }}
          touchPane={touchPane}
          forgetPane={forgetPane}
          releaseTerminalPane={releaseTerminalPane}
        />
      );
    });

    expect(forgetPane).toHaveBeenCalledWith("pane_b");
    expect(releaseTerminalPane).toHaveBeenCalledWith("pane_b");
  });
});
