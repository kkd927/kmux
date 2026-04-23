// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellPatch, ShellStoreSnapshot } from "@kmux/proto";

import { useShellSelector } from "./useShellStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_ROWS: ShellStoreSnapshot["workspaceRows"] = [];

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createShellSnapshot(version = 0): ShellStoreSnapshot {
  return {
    version,
    windowId: "window_1",
    title: "alpha cli/unix socket",
    sidebarVisible: true,
    sidebarWidth: 240,
    unreadNotifications: 0,
    workspaceRows: [
      {
        workspaceId: "workspace_1",
        name: "alpha",
        nameLocked: true,
        summary: "repo / shell",
        cwd: "/repo",
        branch: "main",
        ports: [3000],
        statusEntries: [],
        unreadCount: 0,
        attention: false,
        pinned: false,
        isActive: true
      }
    ],
    activeWorkspace: {
      id: "workspace_1",
      name: "alpha",
      statusEntries: [],
      logs: []
    },
    activeWorkspacePaneTree: {
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
    notifications: [],
    settings: {
      socketMode: "kmuxOnly",
      warnBeforeQuit: true,
      notificationDesktop: true,
      notificationSound: false,
      terminalUseWebgl: true,
      themeMode: "dark",
      shell: "/bin/zsh",
      shortcuts: {
        "workspace.rename": "Meta+R",
        "workspace.close": "Meta+Shift+W"
      },
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
    }
  };
}

describe("useShellStore", () => {
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
      getShellState: vi.fn(async () => createShellSnapshot()),
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

  it("does not rerender selector consumers for unrelated shell patches", async () => {
    const renderSpy = vi.fn();

    function WorkspaceRowsProbe(): JSX.Element {
      const rows = useShellSelector(
        (snapshot) => snapshot?.workspaceRows ?? EMPTY_ROWS
      );
      renderSpy(rows.length);
      return <div>{rows.length}</div>;
    }

    act(() => {
      root.render(<WorkspaceRowsProbe />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderSpy).toHaveBeenCalledTimes(2);

    act(() => {
      emitPatch?.({
        version: 1,
        notifications: [
          {
            id: "notification_1",
            workspaceId: "workspace_1",
            title: "Agent needs input",
            message: "Approve tool use",
            source: "agent",
            createdAt: new Date(0).toISOString()
          }
        ],
        unreadNotifications: 1
      });
    });

    expect(renderSpy).toHaveBeenCalledTimes(2);

    act(() => {
      emitPatch?.({
        version: 2,
        workspaceRows: [
          {
            ...createShellSnapshot().workspaceRows[0],
            summary: "repo / review"
          }
        ]
      });
    });

    expect(renderSpy).toHaveBeenCalledTimes(3);
  });

  it("applies workspace row entity patches without a full row replacement", async () => {
    function WorkspaceRowsProbe(): JSX.Element {
      const rows = useShellSelector(
        (snapshot) => snapshot?.workspaceRows ?? EMPTY_ROWS
      );
      return (
        <div data-testid="rows">
          {rows.map((row) => row.workspaceId).join(",")}
        </div>
      );
    }

    act(() => {
      root.render(<WorkspaceRowsProbe />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const secondRow = {
      ...createShellSnapshot().workspaceRows[0],
      workspaceId: "workspace_2",
      name: "beta",
      isActive: false
    };

    act(() => {
      emitPatch?.({
        version: 1,
        workspaceRowsPatch: {
          upsert: [secondRow]
        }
      });
    });

    expect(container.querySelector("[data-testid='rows']")?.textContent).toBe(
      "workspace_1,workspace_2"
    );

    act(() => {
      emitPatch?.({
        version: 2,
        workspaceRowsPatch: {
          order: ["workspace_2", "workspace_1"]
        }
      });
    });

    expect(container.querySelector("[data-testid='rows']")?.textContent).toBe(
      "workspace_2,workspace_1"
    );

    act(() => {
      emitPatch?.({
        version: 3,
        workspaceRowsPatch: {
          remove: ["workspace_1"]
        }
      });
    });

    expect(container.querySelector("[data-testid='rows']")?.textContent).toBe(
      "workspace_2"
    );
  });

  it("applies shell patches that arrive before the initial snapshot resolves", async () => {
    const initialSnapshot = createDeferred<ShellStoreSnapshot>();
    window.kmux.getShellState = vi.fn(() => initialSnapshot.promise);

    function SidebarProbe(): JSX.Element {
      const sidebarVisible = useShellSelector(
        (snapshot) => snapshot?.sidebarVisible ?? true
      );
      return <div data-testid="sidebar">{String(sidebarVisible)}</div>;
    }

    act(() => {
      root.render(<SidebarProbe />);
    });

    act(() => {
      emitPatch?.({
        version: 1,
        sidebarVisible: false
      });
    });

    await act(async () => {
      initialSnapshot.resolve(createShellSnapshot(0));
      await initialSnapshot.promise;
    });

    expect(container.querySelector("[data-testid='sidebar']")?.textContent).toBe(
      "false"
    );
  });

  it("refetches the full shell snapshot instead of applying out-of-order patch gaps", async () => {
    const refetchedSnapshot = {
      ...createShellSnapshot(3),
      sidebarVisible: true
    };
    window.kmux.getShellState = vi
      .fn()
      .mockResolvedValueOnce(createShellSnapshot(0))
      .mockResolvedValueOnce(refetchedSnapshot);

    function SidebarProbe(): JSX.Element {
      const sidebarVisible = useShellSelector(
        (snapshot) => snapshot?.sidebarVisible ?? true
      );
      return <div data-testid="sidebar">{String(sidebarVisible)}</div>;
    }

    act(() => {
      root.render(<SidebarProbe />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitPatch?.({
        version: 1,
        unreadNotifications: 1
      });
    });

    act(() => {
      emitPatch?.({
        version: 3,
        sidebarVisible: false
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(window.kmux.getShellState).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='sidebar']")?.textContent).toBe(
      "true"
    );
  });

  it("preserves newer patches that arrive while a gap recovery refetch is in flight", async () => {
    const gapRecoverySnapshot = createDeferred<ShellStoreSnapshot>();
    window.kmux.getShellState = vi
      .fn()
      .mockResolvedValueOnce(createShellSnapshot(0))
      .mockReturnValueOnce(gapRecoverySnapshot.promise);

    function ShellProbe(): JSX.Element {
      const shellState = useShellSelector((snapshot) => snapshot);
      return (
        <div data-testid="shell">
          {JSON.stringify({
            version: shellState?.version ?? null,
            sidebarVisible: shellState?.sidebarVisible ?? null,
            sidebarWidth: shellState?.sidebarWidth ?? null
          })}
        </div>
      );
    }

    act(() => {
      root.render(<ShellProbe />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitPatch?.({
        version: 1,
        unreadNotifications: 1
      });
    });

    act(() => {
      emitPatch?.({
        version: 3,
        sidebarVisible: false
      });
    });

    act(() => {
      emitPatch?.({
        version: 4,
        sidebarWidth: 320
      });
    });

    await act(async () => {
      gapRecoverySnapshot.resolve({
        ...createShellSnapshot(3),
        sidebarVisible: false
      });
      await gapRecoverySnapshot.promise;
    });

    expect(window.kmux.getShellState).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='shell']")?.textContent).toBe(
      JSON.stringify({
        version: 4,
        sidebarVisible: false,
        sidebarWidth: 320
      })
    );
  });
});
