import {BrowserWindow} from "electron";

import type {AppAction, AppState} from "@kmux/core";
import type {
    Id,
    PtyEvent,
    SurfaceChunkPayload,
    SurfaceExitPayload,
    SurfaceSnapshotPayload,
    TerminalKeyInput
} from "@kmux/proto";

import type {PtyHostManager} from "./ptyHost";

interface TerminalBridgeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  getPtyHost: () => PtyHostManager | null;
}

export interface TerminalBridge {
  surfaceSessionId(surfaceId: Id): Id | null;
  sendText(surfaceId: Id, text: string): void;
  sendKey(surfaceId: Id, key: string): void;
  sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void;
  resizeSurface(surfaceId: Id, cols: number, rows: number): void;
  attachSurface(
    contentsId: number,
    surfaceId: Id
  ): Promise<SurfaceSnapshotPayload | null>;
  detachSurface(contentsId: number, surfaceId: Id): void;
  handlePtyEvent(event: PtyEvent): void;
}

export function createTerminalBridge(
  options: TerminalBridgeOptions
): TerminalBridge {
  const attachedSurfacesByContents = new Map<number, Set<Id>>();

  function surfaceSessionId(surfaceId: Id): Id | null {
    const surface = options.getState().surfaces[surfaceId];
    return surface ? surface.sessionId : null;
  }

  function sendText(surfaceId: Id, text: string): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      options.getPtyHost()?.sendText(sessionId, text);
    }
  }

  function sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      options.getPtyHost()?.sendKey(sessionId, input);
    }
  }

  function sendKey(surfaceId: Id, key: string): void {
    sendKeyInput(surfaceId, { key });
  }

  function resizeSurface(surfaceId: Id, cols: number, rows: number): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      options.getPtyHost()?.resize(sessionId, cols, rows);
    }
  }

  async function attachSurface(
    contentsId: number,
    surfaceId: Id
  ): Promise<SurfaceSnapshotPayload | null> {
    const surface = options.getState().surfaces[surfaceId];
    if (!surface) {
      return null;
    }
    const attached = attachedSurfacesByContents.get(contentsId) ?? new Set<Id>();
    attached.add(surfaceId);
    attachedSurfacesByContents.set(contentsId, attached);
    return (
      (await options.getPtyHost()?.snapshot(surface.sessionId, surfaceId)) ?? null
    );
  }

  function detachSurface(contentsId: number, surfaceId: Id): void {
    attachedSurfacesByContents.get(contentsId)?.delete(surfaceId);
  }

  function forwardTerminalChunk(payload: SurfaceChunkPayload): void {
    for (const window of BrowserWindow.getAllWindows()) {
      const attached = attachedSurfacesByContents.get(window.webContents.id);
      if (attached?.has(payload.surfaceId)) {
        window.webContents.send("kmux:terminal-event", {
          type: "chunk",
          payload
        });
      }
    }
  }

  function forwardTerminalExit(payload: SurfaceExitPayload): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("kmux:terminal-event", {
        type: "exit",
        payload
      });
    }
  }

  function handlePtyEvent(event: PtyEvent): void {
    switch (event.type) {
      case "spawned":
        options.dispatchAppAction({
          type: "session.started",
          sessionId: event.sessionId,
          pid: event.pid
        });
        return;
      case "metadata":
        options.dispatchAppAction({
          type: "surface.metadata",
          surfaceId: event.payload.surfaceId,
          cwd: event.payload.cwd,
          title: event.payload.title,
          attention: event.payload.attention,
          unreadDelta: event.payload.unreadDelta
        });
        return;
      case "bell": {
        const state = options.getState();
        const surface = state.surfaces[event.surfaceId];
        if (!surface) {
          return;
        }
        const pane = state.panes[surface.paneId];
        if (!pane) {
          return;
        }
        options.dispatchAppAction({
          type: "notification.create",
          workspaceId: pane.workspaceId,
          paneId: surface.paneId,
          surfaceId: event.surfaceId,
          title: event.title,
          message: event.cwd ?? "Bell received",
          source: "bell"
        });
        return;
      }
      case "chunk":
        forwardTerminalChunk(event.payload);
        return;
      case "exit":
        options.dispatchAppAction({
          type: "session.exited",
          sessionId: event.payload.sessionId,
          exitCode: event.payload.exitCode
        });
        forwardTerminalExit(event.payload);
        return;
      case "error":
        console.error("[pty-host]", event.message);
        return;
      default:
        return;
    }
  }

  return {
    surfaceSessionId,
    sendText,
    sendKey,
    sendKeyInput,
    resizeSurface,
    attachSurface,
    detachSurface,
    handlePtyEvent
  };
}
