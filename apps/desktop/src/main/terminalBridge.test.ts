import { afterEach } from "vitest";
import { createInitialState, type AppAction } from "@kmux/core";
import { vi } from "vitest";

const browserWindows: Array<{
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
  };
}> = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => browserWindows
  }
}));

import { createTerminalBridge } from "./terminalBridge";

describe("terminal bridge", () => {
  afterEach(() => {
    browserWindows.length = 0;
    vi.clearAllMocks();
  });

  it("routes BEL events to the terminal bell action", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].sessionId;
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "bell",
      surfaceId,
      sessionId,
      title: "shell",
      cwd: "/tmp/project"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "terminal.bell"
    });
  });

  it("routes terminal notifications into notification.create", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 777
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "notification.create",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      title: surface.title,
      message: surface.cwd ?? "Terminal notification",
      source: "terminal"
    });
  });

  it("flushes only post-snapshot chunks after attach hydration completes", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const snapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 2,
      vt: "snapshot",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    let resolveSnapshot: ((value: typeof snapshot) => void) | undefined;
    const ptyHost = {
      snapshot: vi.fn(
        () =>
          new Promise<typeof snapshot>((resolve) => {
            resolveSnapshot = resolve;
          })
      )
    };
    const send = vi.fn();
    browserWindows.push({
      webContents: {
        id: 77,
        send
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never
    });

    const attachPromise = bridge.attachSurface(77, surfaceId);
    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 1,
        chunk: "before-snapshot"
      }
    });
    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 3,
        chunk: "after-snapshot"
      }
    });

    expect(send).not.toHaveBeenCalled();

    const resolve = resolveSnapshot;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected snapshot resolver to be set");
    }
    resolve(snapshot);

    await expect(attachPromise).resolves.toEqual(snapshot);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("kmux:terminal-event", {
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 3,
        chunk: "after-snapshot"
      }
    });
  });

  it("forwards settled snapshot options to the pty-host", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const ptyHost = {
      snapshot: vi.fn().mockResolvedValue(null)
    };
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never
    });

    await bridge.snapshotSurface(surfaceId, {
      settleForMs: 300,
      timeoutMs: 5000
    });

    expect(ptyHost.snapshot).toHaveBeenCalledWith(
      surface.sessionId,
      surfaceId,
      {
        settleForMs: 300,
        timeoutMs: 5000
      }
    );
  });
});
