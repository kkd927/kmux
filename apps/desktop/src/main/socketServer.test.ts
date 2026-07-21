import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAction,
  createInitialState,
  listWorkspaceSurfaceIds,
  locatedPathForTarget,
  terminalSessionForSurface
} from "@kmux/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KmuxSocketServer, SocketStartupError } from "./socketServer";

async function sendSocketMessage(
  socketPath: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";

    socket.connect(socketPath, () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        socket.end();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });

    socket.on("error", reject);
  });
}

function createTestSocketServer(
  socketPath: string,
  state = createInitialState("/bin/zsh")
): KmuxSocketServer {
  state.settings.socketMode = "allowAll";
  const activeWorkspaceId =
    state.windows[state.activeWindowId].activeWorkspaceId;
  return new KmuxSocketServer({
    socketPath,
    getState: () => state,
    dispatch: vi.fn(),
    sendSurfaceText: vi.fn(),
    sendSurfaceKey: vi.fn(),
    identify: () => ({
      socketPath,
      socketMode: state.settings.socketMode,
      windowId: state.activeWindowId,
      activeWorkspaceId,
      activeSurfaceId:
        state.panes[state.workspaces[activeWorkspaceId].activePaneId]
          .activeSurfaceId,
      capabilities: []
    })
  });
}

describe("kmux socket server startup", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a private runtime directory before listening", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-start-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "runtime", "control.sock");
    const server = createTestSocketServer(socketPath);

    await server.start();

    try {
      expect(statSync(join(tempDir, "runtime")).mode & 0o777).toBe(0o700);
    } finally {
      await server.stop();
    }
  });

  it("refuses to unlink a live socket owner", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-live-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const first = createTestSocketServer(socketPath);
    const second = createTestSocketServer(socketPath);

    await first.start();

    try {
      await expect(second.start()).rejects.toMatchObject({
        reason: "live-owner",
        socketPath
      });
    } finally {
      await first.stop();
    }
  });

  it("claims the socket before runtime handlers are attached", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-early-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const server = new KmuxSocketServer({ socketPath });
    const second = createTestSocketServer(socketPath);

    await server.start();

    try {
      await expect(second.start()).rejects.toMatchObject({
        reason: "live-owner",
        socketPath
      });

      await expect(
        sendSocketMessage(socketPath, {
          jsonrpc: "2.0",
          id: "starting",
          method: "system.ping",
          params: {}
        })
      ).resolves.toMatchObject({
        id: "starting",
        error: {
          code: -32002,
          message: "kmux socket server is still starting"
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("unlinks a stale socket left by a crashed owner", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-stale-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
          const { createServer } = require("node:net");
          const server = createServer();
          server.listen(process.argv[1], () => process.send("ready"));
          setInterval(() => {}, 1000);
        `,
        socketPath
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      }
    );

    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `stale socket fixture exited before ready: code=${code} signal=${signal}`
          )
        );
      });
    });

    child.kill("SIGKILL");
    await once(child, "exit");
    expect(existsSync(socketPath)).toBe(true);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const server = createTestSocketServer(socketPath);
    await server.start();

    try {
      await expect(
        sendSocketMessage(socketPath, {
          jsonrpc: "2.0",
          id: "rpc_stale",
          method: "system.identify",
          params: {}
        })
      ).resolves.toMatchObject({
        result: { socketPath }
      });
    } finally {
      await server.stop();
    }
  });

  it("allows isolated runtimes to listen side by side", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-isolated-"));
    tempDirs.push(tempDir);
    const first = createTestSocketServer(join(tempDir, "one", "control.sock"));
    const second = createTestSocketServer(join(tempDir, "two", "control.sock"));

    await first.start();
    await second.start();

    try {
      await expect(
        sendSocketMessage(join(tempDir, "one", "control.sock"), {
          jsonrpc: "2.0",
          id: "rpc_one",
          method: "system.identify",
          params: {}
        })
      ).resolves.toMatchObject({
        result: { socketPath: join(tempDir, "one", "control.sock") }
      });
      await expect(
        sendSocketMessage(join(tempDir, "two", "control.sock"), {
          jsonrpc: "2.0",
          id: "rpc_two",
          method: "system.identify",
          params: {}
        })
      ).resolves.toMatchObject({
        result: { socketPath: join(tempDir, "two", "control.sock") }
      });
    } finally {
      await second.stop();
      await first.stop();
    }
  });

  it("encodes opaque local and remote paths in socket response DTOs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-path-dto-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const state = createInitialState("/bin/zsh");
    const priorWorkspaceIds = new Set(Object.keys(state.workspaces));
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app",
      name: "remote"
    });
    const remoteWorkspaceId = Object.keys(state.workspaces).find(
      (workspaceId) => !priorWorkspaceIds.has(workspaceId)
    )!;
    const remoteSurfaceId = listWorkspaceSurfaceIds(
      state,
      remoteWorkspaceId
    )[0];
    const remoteSession = terminalSessionForSurface(state, remoteSurfaceId);
    if (!remoteSession) throw new Error("remote terminal session is missing");
    remoteSession.runtimeMetadata.branch = "main";
    remoteSession.runtimeMetadata.gitRepository = {
      root: locatedPathForTarget(
        { kind: "ssh", targetId: "target_1" },
        "/srv/app"
      ),
      gitDir: locatedPathForTarget(
        { kind: "ssh", targetId: "target_1" },
        "/srv/app/.git"
      ),
      commonGitDir: locatedPathForTarget(
        { kind: "ssh", targetId: "target_1" },
        "/srv/app/.git"
      ),
      linkedWorktree: false
    };
    const server = createTestSocketServer(socketPath, state);
    await server.start();

    try {
      const workspaces = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "workspace_paths",
        method: "workspace.list",
        params: {}
      });
      expect(workspaces.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: remoteWorkspaceId,
            location: {
              target: { kind: "ssh", targetId: "target_1" },
              defaultCwd: "/srv/app"
            }
          })
        ])
      );

      const surfaces = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "surface_paths",
        method: "surface.list",
        params: { workspaceId: remoteWorkspaceId }
      });
      expect(surfaces.result).toEqual([
        expect.objectContaining({
          branch: "main",
          cwd: { kind: "ssh", targetId: "target_1", path: "/srv/app" },
          gitRepository: {
            root: { kind: "ssh", targetId: "target_1", path: "/srv/app" },
            gitDir: {
              kind: "ssh",
              targetId: "target_1",
              path: "/srv/app/.git"
            },
            commonGitDir: {
              kind: "ssh",
              targetId: "target_1",
              path: "/srv/app/.git"
            },
            linkedWorktree: false
          },
          ports: [],
          sessionId: expect.any(String)
        })
      ]);
    } finally {
      await server.stop();
    }
  });

  it("does not replace a non-socket file at the socket path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-file-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    writeFileSync(socketPath, "not a socket", "utf8");
    const server = createTestSocketServer(socketPath);
    const startResult = server.start();

    await expect(startResult).rejects.toBeInstanceOf(SocketStartupError);
    await expect(startResult).rejects.toMatchObject({
      reason: "socket-path-not-socket",
      socketPath
    });
  });

  it("fails clearly when the socket path exceeds POSIX limits", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-long-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "x".repeat(120), "control.sock");
    const server = createTestSocketServer(socketPath);
    const startResult = server.start();

    await expect(startResult).rejects.toBeInstanceOf(SocketStartupError);
    await expect(startResult).rejects.toMatchObject({
      reason: "socket-path-too-long",
      socketPath
    });
  });
});

describe("kmux socket server terminal controls", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for the PTY-boundary result and routes bounded capture responses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-control-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activeSurfaceId =
      state.panes[state.workspaces[activeWorkspaceId].activePaneId]
        .activeSurfaceId;
    let resolveAcknowledgement!: (value: unknown) => void;
    const acknowledgement = new Promise<unknown>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const sendSurfaceText = vi.fn(() => acknowledgement);
    const sendSurfaceKey = vi.fn(async () => {
      throw new Error("keeper writer lease changed");
    });
    const captureSurface = vi.fn(async () => ({
      captureId: "capture_1",
      mutationSequence: "17",
      text: "bounded output",
      lineCount: 1,
      byteLength: 14
    }));
    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch: vi.fn(),
      sendSurfaceText,
      sendSurfaceKey,
      captureSurface,
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId,
        capabilities: []
      })
    });
    await server.start();

    try {
      let textReplySettled = false;
      const textReply = sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_send_text",
        method: "surface.send_text",
        params: {
          surfaceId: activeSurfaceId,
          text: "hello",
          operationId: "operation_1"
        }
      });
      void textReply.then(() => {
        textReplySettled = true;
      });
      await vi.waitFor(() =>
        expect(sendSurfaceText).toHaveBeenCalledWith(
          activeSurfaceId,
          "hello",
          "operation_1"
        )
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(textReplySettled).toBe(false);

      resolveAcknowledgement({
        operationId: "operation_1",
        boundary: "pty-write"
      });
      await expect(textReply).resolves.toMatchObject({
        id: "rpc_send_text",
        result: {
          operationId: "operation_1",
          boundary: "pty-write"
        }
      });

      await expect(
        sendSocketMessage(socketPath, {
          jsonrpc: "2.0",
          id: "rpc_capture",
          method: "surface.capture",
          params: {
            surfaceId: activeSurfaceId,
            captureId: "capture_1",
            lines: 20,
            maxBytes: 4096
          }
        })
      ).resolves.toMatchObject({
        id: "rpc_capture",
        result: {
          captureId: "capture_1",
          mutationSequence: "17",
          text: "bounded output"
        }
      });
      expect(captureSurface).toHaveBeenCalledWith({
        surfaceId: activeSurfaceId,
        captureId: "capture_1",
        lines: 20,
        maxBytes: 4096
      });

      await expect(
        sendSocketMessage(socketPath, {
          jsonrpc: "2.0",
          id: "rpc_send_key",
          method: "surface.send_key",
          params: {
            surfaceId: activeSurfaceId,
            key: "Enter",
            operationId: "operation_2"
          }
        })
      ).resolves.toMatchObject({
        id: "rpc_send_key",
        error: {
          code: -32603,
          message: "keeper writer lease changed"
        }
      });
    } finally {
      await server.stop();
    }
  });
});

describe("kmux socket server agent hooks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores broken-pipe reply errors from disconnected clients", () => {
    const state = createInitialState("/bin/zsh");
    const server = new KmuxSocketServer({
      socketPath: "/tmp/kmux-socket-server-test.sock",
      getState: () => state,
      dispatch: vi.fn(),
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath: "/tmp/kmux-socket-server-test.sock",
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId:
          state.windows[state.activeWindowId].activeWorkspaceId,
        activeSurfaceId:
          state.panes[
            state.workspaces[
              state.windows[state.activeWindowId].activeWorkspaceId
            ].activePaneId
          ].activeSurfaceId,
        capabilities: []
      })
    });

    const socket = {
      destroyed: false,
      writable: true,
      writableEnded: false,
      write: vi.fn(() => {
        const error = new Error("write EPIPE") as Error & { code?: string };
        error.code = "EPIPE";
        throw error;
      })
    } as unknown as Socket;

    expect(() =>
      (
        server as unknown as {
          reply: (socket: Socket, id: unknown, result?: unknown) => void;
        }
      ).reply(socket, "rpc_epipe", { ok: true })
    ).not.toThrow();
  });

  it("logs unexpected client socket errors instead of crashing the main process", () => {
    const state = createInitialState("/bin/zsh");
    const server = new KmuxSocketServer({
      socketPath: "/tmp/kmux-socket-server-test.sock",
      getState: () => state,
      dispatch: vi.fn(),
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath: "/tmp/kmux-socket-server-test.sock",
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId:
          state.windows[state.activeWindowId].activeWorkspaceId,
        activeSurfaceId:
          state.panes[
            state.workspaces[
              state.windows[state.activeWindowId].activeWorkspaceId
            ].activePaneId
          ].activeSurfaceId,
        capabilities: []
      })
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = new EventEmitter() as Socket;

    (
      server as unknown as {
        handleConnection: (socket: Socket) => void;
      }
    ).handleConnection(socket);

    const error = new Error("boom");
    expect(() => socket.emit("error", error)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[socket-server]", error);
  });

  it("normalizes raw agent hooks in main before dispatching reducer events", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_1",
        method: "agent.hook",
        params: {
          agent: "codex",
          hookEvent: "Stop",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Done"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith({
        type: "agent.event",
        workspaceId: activeWorkspaceId,
        paneId: undefined,
        surfaceId: "surface_1",
        sessionId: "session_1",
        agent: "codex",
        event: "turn_complete",
        title: undefined,
        message: undefined,
        details: {
          kmux_hook_event_arg: "Stop"
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("resolves surface split through the live surface pane when a request also carries a stale pane id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const stalePaneId = state.workspaces[activeWorkspaceId].activePaneId;
    applyAction(state, {
      type: "pane.split",
      paneId: stalePaneId,
      direction: "right"
    });
    const livePaneId = state.workspaces[activeWorkspaceId].activePaneId;
    const liveSurfaceId = state.panes[livePaneId].activeSurfaceId;
    expect(livePaneId).not.toBe(stalePaneId);

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId: liveSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_surface_split_current_pane",
        method: "surface.split",
        params: {
          paneId: stalePaneId,
          surfaceId: liveSurfaceId,
          direction: "down"
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith({
        type: "pane.split",
        paneId: livePaneId,
        direction: "down"
      });
    } finally {
      await server.stop();
    }
  });

  it("normalizes stale pane ids on hook notifications when a live surface target is available", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const stalePaneId = state.workspaces[activeWorkspaceId].activePaneId;
    applyAction(state, {
      type: "pane.split",
      paneId: stalePaneId,
      direction: "right"
    });
    const livePaneId = state.workspaces[activeWorkspaceId].activePaneId;
    const liveSurfaceId = state.panes[livePaneId].activeSurfaceId;
    expect(livePaneId).not.toBe(stalePaneId);

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId: liveSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_hook_notification_current_pane",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          paneId: stalePaneId,
          surfaceId: liveSurfaceId,
          payload: {
            title: "Task complete",
            message: "Task completed successfully"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "notification.create",
          paneId: livePaneId,
          surfaceId: liveSurfaceId
        })
      );
    } finally {
      await server.stop();
    }
  });

  it("marks visible agent hook events so reducer delivery can suppress active-surface notifications", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      }),
      isSurfaceVisibleToUser: () => true
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_2",
        method: "agent.hook",
        params: {
          agent: "codex",
          hookEvent: "Stop",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Done"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith({
        type: "agent.event",
        workspaceId: activeWorkspaceId,
        paneId: undefined,
        surfaceId: "surface_1",
        sessionId: "session_1",
        agent: "codex",
        event: "turn_complete",
        title: undefined,
        message: undefined,
        details: {
          kmux_hook_event_arg: "Stop",
          visibleToUser: true
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("routes Claude notification hooks to generic kmux notifications", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_3",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            title: "Task complete",
            message: "Task completed successfully"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith({
        type: "notification.create",
        workspaceId: activeWorkspaceId,
        paneId: undefined,
        surfaceId: "surface_1",
        title: "Task complete",
        message: "Task completed successfully",
        source: "agent",
        agent: "claude"
      });
    } finally {
      await server.stop();
    }
  });

  it("suppresses Claude Notification hooks that duplicate a recent turn_complete alert", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    state.notifications.unshift({
      id: "notification_turn_complete",
      workspaceId: activeWorkspaceId,
      surfaceId: "surface_1",
      title: "Claude finished",
      message: "Finished",
      source: "agent",
      kind: "turn_complete",
      agent: "claude",
      createdAt: new Date(Date.now() - 30_000).toISOString()
    });

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_dedupe_recent",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Claude is waiting for your input"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("suppresses Claude Notification hooks that duplicate an existing needs_input alert", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    state.notifications.unshift({
      id: "notification_needs_input",
      workspaceId: activeWorkspaceId,
      surfaceId: "surface_1",
      title: "Claude needs input",
      message: "Continue? (Yes, No)",
      source: "agent",
      kind: "needs_input",
      agent: "claude",
      createdAt: new Date(Date.now() - 5_000).toISOString()
    });

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_dedupe_needs_input",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Claude Code needs your attention"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("still forwards Claude Notification hooks when the turn_complete alert is older than the dedupe window", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    state.notifications.unshift({
      id: "notification_turn_complete_stale",
      workspaceId: activeWorkspaceId,
      surfaceId: "surface_1",
      title: "Claude finished",
      message: "Finished",
      source: "agent",
      kind: "turn_complete",
      agent: "claude",
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    });

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_dedupe_stale",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Claude is waiting for your input"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "notification.create",
          surfaceId: "surface_1",
          agent: "claude",
          source: "agent"
        })
      );
    } finally {
      await server.stop();
    }
  });

  it("does not dedupe Claude Notification hooks against a different agent's turn_complete", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    state.notifications.unshift({
      id: "notification_turn_complete_codex",
      workspaceId: activeWorkspaceId,
      surfaceId: "surface_1",
      title: "Codex finished",
      message: "Finished",
      source: "agent",
      kind: "turn_complete",
      agent: "codex",
      createdAt: new Date(Date.now() - 30_000).toISOString()
    });

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      })
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_dedupe_cross_agent",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Claude is waiting for your input"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "notification.create",
          surfaceId: "surface_1",
          agent: "claude"
        })
      );
    } finally {
      await server.stop();
    }
  });

  it("suppresses visible Claude notification hooks because the notification is already in band", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kmux-socket-server-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "control.sock");
    const dispatch = vi.fn();

    const state = createInitialState("/bin/zsh");
    state.settings.socketMode = "allowAll";
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    const server = new KmuxSocketServer({
      socketPath,
      getState: () => state,
      dispatch,
      sendSurfaceText: vi.fn(),
      sendSurfaceKey: vi.fn(),
      identify: () => ({
        socketPath,
        socketMode: state.settings.socketMode,
        windowId: state.activeWindowId,
        activeWorkspaceId,
        activeSurfaceId:
          state.panes[state.workspaces[activeWorkspaceId].activePaneId]
            .activeSurfaceId,
        capabilities: []
      }),
      isSurfaceVisibleToUser: () => true
    });

    await server.start();

    try {
      const response = await sendSocketMessage(socketPath, {
        jsonrpc: "2.0",
        id: "rpc_4",
        method: "agent.hook",
        params: {
          agent: "claude",
          hookEvent: "Notification",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            title: "Task complete",
            message: "Task completed successfully"
          }
        }
      });

      expect(response.result).toEqual({ ok: true });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
