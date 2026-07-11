// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellPatch, ShellStoreSnapshot } from "@kmux/proto";

import { useTerminalInstanceCleanup } from "./useTerminalInstanceCleanup";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness(props: {
  releaseTerminalSurface: (surfaceId: string) => void;
  forgetTerminalStreamSurface?: (surfaceId: string) => void;
}): null {
  useTerminalInstanceCleanup(props);
  return null;
}

function shellSnapshot(
  version: number,
  surfaceIds: string[] = []
): ShellStoreSnapshot {
  return {
    version,
    surfaceIds,
    activeWorkspacePaneTree: {
      id: "workspace_1",
      rootNodeId: "node_1",
      nodes: {},
      panes: {},
      surfaces: {},
      activePaneId: "pane_1"
    }
  } as unknown as ShellStoreSnapshot;
}

describe("useTerminalInstanceCleanup", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let emitPatch: ((patch: ShellPatch) => void) | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    emitPatch = null;
    window.kmux = {
      ...window.kmux,
      getShellState: vi.fn(async () => shellSnapshot(0)),
      subscribeShellPatches: vi.fn((listener: (patch: ShellPatch) => void) => {
        emitPatch = listener;
        return () => {
          emitPatch = null;
        };
      })
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("releases terminal instances from the removed-surface signal", async () => {
    const releaseTerminalSurface = vi.fn();
    const forgetTerminalStreamSurface = vi.fn();

    act(() => {
      root.render(
        <TestHarness
          releaseTerminalSurface={releaseTerminalSurface}
          forgetTerminalStreamSurface={forgetTerminalStreamSurface}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitPatch?.({
        version: 1,
        removedSurfaceIds: ["surface_pane_b"]
      });
    });

    expect(releaseTerminalSurface).toHaveBeenCalledTimes(1);
    expect(releaseTerminalSurface).toHaveBeenCalledWith("surface_pane_b");
    expect(forgetTerminalStreamSurface).toHaveBeenCalledWith("surface_pane_b");
  });

  it("preserves removed-surface cleanup across shell patch gap recovery", async () => {
    const getShellState = vi
      .fn<() => Promise<ShellStoreSnapshot>>()
      .mockResolvedValueOnce(shellSnapshot(0, ["surface_hidden"]))
      .mockResolvedValueOnce(shellSnapshot(3));
    window.kmux.getShellState = getShellState;
    const releaseTerminalSurface = vi.fn();

    act(() => {
      root.render(
        <TestHarness releaseTerminalSurface={releaseTerminalSurface} />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitPatch?.({
        version: 3
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.kmux.getShellState).toHaveBeenCalledTimes(2);
    expect(releaseTerminalSurface).toHaveBeenCalledWith("surface_hidden");
  });

  it("ignores removed-surface hints from stale patches", async () => {
    window.kmux.getShellState = vi.fn(async () =>
      shellSnapshot(2, ["surface_still_live"])
    );
    const releaseTerminalSurface = vi.fn();

    act(() => {
      root.render(
        <TestHarness releaseTerminalSurface={releaseTerminalSurface} />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitPatch?.({
        version: 1,
        removedSurfaceIds: ["surface_still_live"]
      });
      emitPatch?.({ version: 3, unreadNotifications: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(releaseTerminalSurface).not.toHaveBeenCalled();
  });
});
