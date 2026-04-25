import { afterEach } from "vitest";
import { applyAction, createInitialState, type AppAction } from "@kmux/core";
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

  it("promotes restored Codex input prompts even before vendor binding is known", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "unknown"
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
        protocol: 9,
        inferredFromUnknownVendor: true
      })
    });
  });

  it("keeps unknown non-Codex terminal prompts on the generic notification path", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "unknown"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "tool",
      message: "Permission required"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "notification.create",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      title: "tool",
      message: "Permission required",
      source: "terminal"
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

  it("trims batched hydration chunks to post-snapshot segments", async () => {
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
        fromSequence: 1,
        sequence: 3,
        chunk: "before-inside-after",
        segments: [
          {
            sequence: 1,
            length: 7
          },
          {
            sequence: 2,
            length: 7
          },
          {
            sequence: 3,
            length: 5
          }
        ]
      }
    });

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
        fromSequence: 3,
        sequence: 3,
        chunk: "after",
        segments: [
          {
            sequence: 3,
            length: 5
          }
        ]
      }
    });
  });

  it("records attach queue profiling metrics when hydration flushes", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const snapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 1,
      vt: "snapshot",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    let resolveSnapshot: ((value: typeof snapshot) => void) | undefined;
    const record = vi.fn();
    const ptyHost = {
      snapshot: vi.fn(
        () =>
          new Promise<typeof snapshot>((resolve) => {
            resolveSnapshot = resolve;
          })
      )
    };
    browserWindows.push({
      webContents: {
        id: 77,
        send: vi.fn()
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never,
      profileRecorder: {
        enabled: true,
        record
      }
    });

    const attachPromise = bridge.attachSurface(77, surfaceId);
    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 2,
        chunk: "queued"
      }
    });

    const resolve = resolveSnapshot;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected snapshot resolver to be set");
    }
    resolve(snapshot);
    await attachPromise;

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        name: "terminal.attach.queue",
        details: expect.objectContaining({
          contentsId: 77,
          surfaceId,
          queuedChunks: 1,
          snapshotSequence: 1
        })
      })
    );
  });

  it("requests a fresh snapshot instead of flushing an overgrown hydration queue", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const firstSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "stale",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const freshSnapshot = {
      ...firstSnapshot,
      sequence: 1001,
      vt: "fresh"
    };
    let resolveFirstSnapshot: ((value: typeof firstSnapshot) => void) | undefined;
    const ptyHost = {
      snapshot: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof firstSnapshot>((resolve) => {
              resolveFirstSnapshot = resolve;
            })
        )
        .mockResolvedValueOnce(freshSnapshot)
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
    for (let sequence = 1; sequence <= 1001; sequence += 1) {
      bridge.handlePtyEvent({
        type: "chunk",
        payload: {
          surfaceId,
          sessionId: surface.sessionId,
          sequence,
          chunk: "x"
        }
      });
    }

    const resolve = resolveFirstSnapshot;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected snapshot resolver to be set");
    }
    resolve(firstSnapshot);

    await expect(attachPromise).resolves.toEqual(freshSnapshot);
    expect(ptyHost.snapshot).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("requests a fresh snapshot when hydration queued bytes exceed the cap", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const firstSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "stale",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const freshSnapshot = {
      ...firstSnapshot,
      sequence: 1,
      vt: "fresh"
    };
    let resolveFirstSnapshot: ((value: typeof firstSnapshot) => void) | undefined;
    const ptyHost = {
      snapshot: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof firstSnapshot>((resolve) => {
              resolveFirstSnapshot = resolve;
            })
        )
        .mockResolvedValueOnce(freshSnapshot)
    };
    browserWindows.push({
      webContents: {
        id: 77,
        send: vi.fn()
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
        chunk: "x".repeat(2 * 1024 * 1024 + 1)
      }
    });

    const resolve = resolveFirstSnapshot;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected snapshot resolver to be set");
    }
    resolve(firstSnapshot);

    await expect(attachPromise).resolves.toEqual(freshSnapshot);
    expect(ptyHost.snapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps recovering until a snapshot covers chunks dropped during hydration overflow", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const baseSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "snapshot",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const snapshotResolvers: Array<(value: typeof baseSnapshot) => void> = [];
    const ptyHost = {
      snapshot: vi.fn(
        () =>
          new Promise<typeof baseSnapshot>((resolve) => {
            snapshotResolvers.push(resolve);
          })
      )
    };
    browserWindows.push({
      webContents: {
        id: 77,
        send: vi.fn()
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
        chunk: "x".repeat(2 * 1024 * 1024 + 1)
      }
    });
    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 2,
        chunk: "late"
      }
    });

    async function waitForSnapshotResolver(index: number) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const resolver = snapshotResolvers[index];
        if (resolver) {
          return resolver;
        }
        await Promise.resolve();
      }
      throw new Error(`expected snapshot resolver ${index}`);
    }

    const resolveInitialSnapshot = await waitForSnapshotResolver(0);
    resolveInitialSnapshot(baseSnapshot);

    const resolveLaggingSnapshot = await waitForSnapshotResolver(1);
    resolveLaggingSnapshot({
      ...baseSnapshot,
      sequence: 1,
      vt: "still-lagging"
    });

    const resolveCaughtUpSnapshot = await waitForSnapshotResolver(2);
    const caughtUpSnapshot = {
      ...baseSnapshot,
      sequence: 2,
      vt: "caught-up"
    };
    resolveCaughtUpSnapshot(caughtUpSnapshot);

    await expect(attachPromise).resolves.toEqual(caughtUpSnapshot);
    expect(ptyHost.snapshot).toHaveBeenCalledTimes(3);
  });

  it("skips overflow recovery snapshots when an exit is pending during hydration", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const baseSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "snapshot",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    let resolveInitialSnapshot:
      | ((value: typeof baseSnapshot | null) => void)
      | undefined;
    const ptyHost = {
      snapshot: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof baseSnapshot | null>((resolve) => {
              resolveInitialSnapshot = resolve;
            })
        )
        .mockResolvedValueOnce({
          ...baseSnapshot,
          sequence: 1,
          vt: "unneeded"
        })
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
        chunk: "x".repeat(2 * 1024 * 1024 + 1)
      }
    });
    bridge.handlePtyEvent({
      type: "exit",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        exitCode: 0
      }
    });

    const resolve = resolveInitialSnapshot;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected snapshot resolver to be set");
    }
    resolve(null);

    await expect(attachPromise).resolves.toBeNull();
    expect(ptyHost.snapshot).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("kmux:terminal-event", {
      type: "exit",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        exitCode: 0
      }
    });
  });

  it("records degraded attach recovery when output keeps overflowing the hydration queue", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const baseSnapshot = {
      surfaceId,
      sessionId: surface.sessionId,
      sequence: 0,
      vt: "snapshot",
      title: surface.title,
      cwd: surface.cwd,
      branch: undefined,
      ports: [],
      unreadCount: 0,
      attention: false
    };
    const snapshotResolvers: Array<(value: typeof baseSnapshot) => void> = [];
    const ptyHost = {
      snapshot: vi.fn(
        () =>
          new Promise<typeof baseSnapshot>((resolve) => {
            snapshotResolvers.push(resolve);
          })
      )
    };
    const record = vi.fn();
    browserWindows.push({
      webContents: {
        id: 77,
        send: vi.fn()
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never,
      profileRecorder: {
        enabled: true,
        record
      }
    });

    const attachPromise = bridge.attachSurface(77, surfaceId);

    async function waitForSnapshotResolver(index: number) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const resolver = snapshotResolvers[index];
        if (resolver) {
          return resolver;
        }
        await Promise.resolve();
      }
      throw new Error(`expected snapshot resolver ${index}`);
    }

    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 1,
        chunk: "x".repeat(2 * 1024 * 1024 + 1)
      }
    });
    bridge.handlePtyEvent({
      type: "chunk",
      payload: {
        surfaceId,
        sessionId: surface.sessionId,
        sequence: 2,
        chunk: "late"
      }
    });

    const resolveInitialSnapshot = await waitForSnapshotResolver(0);
    resolveInitialSnapshot({
      ...baseSnapshot,
      sequence: 0
    });

    const resolveFirstRecovery = await waitForSnapshotResolver(1);
    resolveFirstRecovery({
      ...baseSnapshot,
      sequence: 0
    });

    const resolveSecondRecovery = await waitForSnapshotResolver(2);
    resolveSecondRecovery({
      ...baseSnapshot,
      sequence: 1
    });

    await attachPromise;

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        name: "terminal.attach.queue.degraded",
        details: expect.objectContaining({
          contentsId: 77,
          surfaceId,
          recoverySnapshots: 2,
          maxRecoverySnapshots: 2,
          snapshotSequence: 1,
          overflowedThroughSequence: 2,
          policy: "fresh-snapshot-then-ready"
        })
      })
    );
  });

  it("records terminal IPC buckets with surface and session attribution", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const record = vi.fn();
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
    browserWindows.push({
      webContents: {
        id: 77,
        send: vi.fn()
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () =>
        ({
          snapshot: vi.fn().mockResolvedValue(snapshot)
        }) as never,
      profileRecorder: {
        enabled: true,
        record
      }
    });

    await bridge.attachSurface(77, surfaceId);

    for (let index = 1; index <= 100; index += 1) {
      bridge.handlePtyEvent({
        type: "chunk",
        payload: {
          surfaceId,
          sessionId: surface.sessionId,
          sequence: index,
          chunk: "x"
        }
      });
    }

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        name: "terminal.ipc.bucket",
        details: expect.objectContaining({
          surfaceId,
          sessionId: surface.sessionId,
          chunks: 100,
          sends: 100,
          bytes: 100
        })
      })
    );
  });

  it("records resize request and ack profiling metrics", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const record = vi.fn();
    const resize = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () =>
        ({
          resize
        }) as never,
      profileRecorder: {
        enabled: true,
        record
      }
    });

    await bridge.resizeSurface(surfaceId, 132, 43);

    expect(resize).toHaveBeenCalledWith(surface.sessionId, 132, 43);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        name: "terminal.resize.request",
        details: expect.objectContaining({
          surfaceId,
          sessionId: surface.sessionId,
          cols: 132,
          rows: 43
        })
      })
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        name: "terminal.resize.ack",
        details: expect.objectContaining({
          surfaceId,
          sessionId: surface.sessionId,
          cols: 132,
          rows: 43,
          durationMs: expect.any(Number)
        })
      })
    );
  });

  it("forwards resize requests immediately so startup ordering stays with pty-host", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    let resolveFirstResize: (() => void) | undefined;
    const resize = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstResize = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () =>
        ({
          resize
        }) as never
    });

    const firstResize = bridge.resizeSurface(surfaceId, 100, 30);
    const secondResize = bridge.resizeSurface(surfaceId, 110, 35);
    const thirdResize = bridge.resizeSurface(surfaceId, 120, 40);

    expect(resize).toHaveBeenCalledTimes(3);
    expect(resize).toHaveBeenNthCalledWith(1, surface.sessionId, 100, 30);
    expect(resize).toHaveBeenNthCalledWith(2, surface.sessionId, 110, 35);
    expect(resize).toHaveBeenNthCalledWith(3, surface.sessionId, 120, 40);

    const resolve = resolveFirstResize;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) {
      throw new Error("expected resize resolver to be set");
    }
    resolve();

    await Promise.all([firstResize, secondResize, thirdResize]);
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

  it("clears visible Codex needs-input attention when escape text dismisses the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "idle",
      message: "Dismissed input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        dismissKey: "escape"
      })
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Codex needs-input attention when escape key input is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Escape" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "idle",
      message: "Dismissed input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        dismissKey: "escape"
      })
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Escape"
    });
  });

  it("clears visible Claude needs-input attention when escape text dismisses the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "idle",
      message: "Dismissed input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        dismissKey: "escape"
      })
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Claude needs-input attention when escape key input is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Escape" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "idle",
      message: "Dismissed input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        dismissKey: "escape"
      })
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Escape"
    });
  });

  it("does not clear Claude needs-input attention when the surface is not visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => false
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).not.toHaveBeenCalled();
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Codex needs-input attention when Enter text submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\r");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "idle",
      message: "Submitted input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        submitKey: "enter"
      })
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\r");
  });

  it("clears visible Codex needs-input attention when Enter key input submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "idle",
      message: "Submitted input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        submitKey: "enter"
      })
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("clears visible Gemini needs-input attention when Enter submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "gemini",
      event: "needs_input",
      message: "Tool permission requested: WriteFile"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "gemini",
      event: "idle",
      message: "Submitted input prompt",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true,
        source: "terminal-input",
        submitKey: "enter"
      })
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("does not clear Claude needs-input on Enter submit (Claude is covered by hooks)", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).not.toHaveBeenCalled();
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("does not clear Codex needs-input on arrow keys (navigation should not submit)", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "ArrowDown" });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("does not clear Codex needs-input via submit when the surface is not visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => false
    });

    bridge.sendText(surfaceId, "\r");

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("does not clear Codex needs-input on multi-char text that merely ends with a newline (paste / programmatic send)", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "foo\nbar\n");

    expect(dispatchAppAction).not.toHaveBeenCalled();
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "foo\nbar\n");
  });
});
