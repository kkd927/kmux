import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState } from "@kmux/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KmuxSocketServer } from "./socketServer";

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

describe("kmux socket server agent hooks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
