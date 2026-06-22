// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActiveWorkspacePaneTreeVm,
  ShellStoreSnapshot
} from "@kmux/proto";

import { useTerminalInstanceCleanup } from "./useTerminalInstanceCleanup";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createWorkspacePaneTree(
  paneIds: string[] = ["pane_a", "pane_b"]
): ActiveWorkspacePaneTreeVm {
  return {
    id: "workspace_1",
    rootNodeId: "node_root",
    nodes: {
      node_root: {
        id: "node_root",
        kind: "leaf",
        paneId: paneIds[0] ?? "pane_a"
      }
    },
    panes: Object.fromEntries(
      paneIds.map((paneId) => [
        paneId,
        {
          id: paneId,
          surfaceIds: [`surface_${paneId}`],
          activeSurfaceId: `surface_${paneId}`,
          focused: paneId === paneIds[0]
        }
      ])
    ),
    surfaces: Object.fromEntries(
      paneIds.map((paneId) => [
        `surface_${paneId}`,
        {
          id: `surface_${paneId}`,
          sessionId: `session_${paneId}`,
          title: paneId,
          ports: [],
          unreadCount: 0,
          attention: false,
          sessionState: "running",
          shellInputReady: true
        }
      ])
    ),
    activePaneId: paneIds[0] ?? "pane_a"
  };
}

function TestHarness(props: {
  workspacePaneTrees: ShellStoreSnapshot["workspacePaneTrees"];
  releaseTerminalSurface: (surfaceId: string) => void;
}): null {
  useTerminalInstanceCleanup(props);
  return null;
}

describe("useTerminalInstanceCleanup", () => {
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

  it("releases terminal instances for removed surfaces", () => {
    const releaseTerminalSurface = vi.fn();
    const initialTree = createWorkspacePaneTree(["pane_a", "pane_b"]);
    const nextTree = createWorkspacePaneTree(["pane_a"]);

    act(() => {
      root.render(
        <TestHarness
          workspacePaneTrees={{ workspace_1: initialTree }}
          releaseTerminalSurface={releaseTerminalSurface}
        />
      );
    });

    act(() => {
      root.render(
        <TestHarness
          workspacePaneTrees={{ workspace_1: nextTree }}
          releaseTerminalSurface={releaseTerminalSurface}
        />
      );
    });

    expect(releaseTerminalSurface).toHaveBeenCalledTimes(1);
    expect(releaseTerminalSurface).toHaveBeenCalledWith("surface_pane_b");
  });
});
