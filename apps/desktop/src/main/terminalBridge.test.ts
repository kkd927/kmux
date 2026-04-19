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

  it("suppresses visible terminal notifications for the active surface", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      isSurfaceVisibleToUser: () => true
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 777,
      title: "osc777 title",
      message: "osc777 body"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("promotes Codex input-required terminal notifications into ui-only agent events", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: Depth"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Plan mode prompt: Depth",
      details: expect.objectContaining({
        uiOnly: true,
        source: "terminal",
        protocol: 9
      })
    });
  });

  it("marks visible Codex input-required terminal notifications as already visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex",
      isSurfaceVisibleToUser: () => true
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: Depth"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Plan mode prompt: Depth",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true
      })
    });
  });

  it("suppresses non-attention Codex terminal chatter notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "kmux",
      message: "Hi. What do you need changed in `kmux`?"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
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

  it("hydrates a first-time attached surface from a settled snapshot", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const snapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const ptyHost = {
      snapshot: vi.fn().mockResolvedValue(snapshot)
    };

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never
    });

    await bridge.attachSurface(77, surfaceId);

    expect(ptyHost.snapshot).toHaveBeenCalledWith(
      surface.sessionId,
      surfaceId,
      expect.objectContaining({
        settleForMs: expect.any(Number)
      })
    );
  });

  it("hydrates a reattached surface from an immediate snapshot", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const firstSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 1,
      vt: "first",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const secondSnapshot = {
      ...firstSnapshot,
      sequence: 2,
      vt: "second"
    };
    const ptyHost = {
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(firstSnapshot)
        .mockResolvedValueOnce(secondSnapshot)
    };

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never
    });

    await bridge.attachSurface(77, surfaceId);
    bridge.detachSurface(77, surfaceId);
    await bridge.attachSurface(77, surfaceId);

    expect(ptyHost.snapshot).toHaveBeenNthCalledWith(
      1,
      surface.sessionId,
      surfaceId,
      expect.objectContaining({
        settleForMs: expect.any(Number)
      })
    );
    expect(ptyHost.snapshot).toHaveBeenNthCalledWith(
      2,
      surface.sessionId,
      surfaceId,
      {}
    );
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

  it("notifies usage runtime listeners when terminal input text is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const onSurfaceInputText = vi.fn();
    const ptyHost = {
      sendText: vi.fn()
    };
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never,
      onSurfaceInputText
    });

    bridge.sendText(surfaceId, "codex exec\r");

    expect(onSurfaceInputText).toHaveBeenCalledWith(surfaceId, "codex exec\r");
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "codex exec\r");
  });
});
