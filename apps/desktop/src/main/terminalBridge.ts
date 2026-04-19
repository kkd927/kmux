import {BrowserWindow} from "electron";

import type {AppAction, AppState} from "@kmux/core";
import type {
    Id,
    PtyEvent,
    SurfaceSnapshotOptions,
    SurfaceChunkPayload,
    SurfaceExitPayload,
    SurfaceSnapshotPayload,
    TerminalKeyInput,
    UsageVendor
} from "@kmux/proto";

import type {PtyHostManager} from "./ptyHost";

interface TerminalBridgeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  getPtyHost: () => PtyHostManager | null;
  onSurfaceInputText?: (surfaceId: Id, text: string) => void;
  getSurfaceVendor?: (surfaceId: Id) => UsageVendor;
  isSurfaceVisibleToUser?: (surfaceId: Id) => boolean;
}

interface SurfaceAttachmentState {
  status: "hydrating" | "ready";
  queuedChunks: SurfaceChunkPayload[];
  pendingExit: SurfaceExitPayload | null;
  hydratePromise: Promise<SurfaceSnapshotPayload | null> | null;
}

const ATTACH_SNAPSHOT_SETTLE_MS = 120;
const CODEX_INPUT_PATTERNS = [
  /\bplan mode prompt:/i,
  /\benter to submit answer\b/i,
  /\btab to add notes\b/i,
  /\besc to interrupt\b/i,
  /\bapproval\b/i,
  /\bapprove\b/i,
  /\bpermission\b/i,
  /\bquestion \d+\/\d+\b/i,
  /\bunanswered\b/i,
  /\bneeds input\b/i,
  /\bwaiting for input\b/i
] as const;

export interface TerminalBridge {
  surfaceSessionId(surfaceId: Id): Id | null;
  sendText(surfaceId: Id, text: string): void;
  sendKey(surfaceId: Id, key: string): void;
  sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void;
  resizeSurface(surfaceId: Id, cols: number, rows: number): void;
  snapshotSurface(
    surfaceId: Id,
    options?: SurfaceSnapshotOptions
  ): Promise<SurfaceSnapshotPayload | null>;
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
  const attachedSurfacesByContents = new Map<
    number,
    Map<Id, SurfaceAttachmentState>
  >();
  const hydratedSurfaceIds = new Set<Id>();

  function surfaceSessionId(surfaceId: Id): Id | null {
    const surface = options.getState().surfaces[surfaceId];
    return surface ? surface.sessionId : null;
  }

  function sendText(surfaceId: Id, text: string): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      options.onSurfaceInputText?.(surfaceId, text);
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

  async function snapshotSurface(
    surfaceId: Id,
    snapshotOptions: SurfaceSnapshotOptions = {}
  ): Promise<SurfaceSnapshotPayload | null> {
    const surface = options.getState().surfaces[surfaceId];
    if (!surface) {
      return null;
    }
    return (
      (await options
        .getPtyHost()
        ?.snapshot(surface.sessionId, surfaceId, snapshotOptions)) ?? null
    );
  }

  async function attachSurface(
    contentsId: number,
    surfaceId: Id
  ): Promise<SurfaceSnapshotPayload | null> {
    if (!options.getState().surfaces[surfaceId]) {
      return null;
    }

    const attached =
      attachedSurfacesByContents.get(contentsId) ?? new Map<Id, SurfaceAttachmentState>();
    attachedSurfacesByContents.set(contentsId, attached);

    const existingAttachment = attached.get(surfaceId);
    if (existingAttachment?.status === "ready") {
      return snapshotSurface(surfaceId);
    }
    if (existingAttachment?.hydratePromise) {
      return existingAttachment.hydratePromise;
    }

    const attachment: SurfaceAttachmentState = {
      status: "hydrating",
      queuedChunks: [],
      pendingExit: null,
      hydratePromise: null
    };
    attached.set(surfaceId, attachment);

    attachment.hydratePromise = (async () => {
      const snapshot = await snapshotSurface(
        surfaceId,
        hydratedSurfaceIds.has(surfaceId)
          ? {}
          : {
              settleForMs: ATTACH_SNAPSHOT_SETTLE_MS
            }
      );
      const currentAttachment = attachedSurfacesByContents
        .get(contentsId)
        ?.get(surfaceId);
      if (currentAttachment !== attachment) {
        return snapshot;
      }

      attachment.status = "ready";
      attachment.hydratePromise = null;
      hydratedSurfaceIds.add(surfaceId);
      flushQueuedTerminalEvents(contentsId, surfaceId, snapshot?.sequence ?? 0);
      return snapshot;
    })();

    return attachment.hydratePromise;
  }

  function detachSurface(contentsId: number, surfaceId: Id): void {
    const attached = attachedSurfacesByContents.get(contentsId);
    attached?.delete(surfaceId);
    if (attached && attached.size === 0) {
      attachedSurfacesByContents.delete(contentsId);
    }
  }

  function sendTerminalEvent(
    contentsId: number,
    event:
      | { type: "chunk"; payload: SurfaceChunkPayload }
      | { type: "exit"; payload: SurfaceExitPayload }
  ): void {
    const window = BrowserWindow.getAllWindows().find(
      (entry) => entry.webContents.id === contentsId
    );
    window?.webContents.send("kmux:terminal-event", event);
  }

  function surfaceAttachmentEntries(surfaceId: Id): Array<
    [number, SurfaceAttachmentState]
  > {
    const entries: Array<[number, SurfaceAttachmentState]> = [];
    for (const [contentsId, attached] of attachedSurfacesByContents.entries()) {
      const attachment = attached.get(surfaceId);
      if (attachment) {
        entries.push([contentsId, attachment]);
      }
    }
    return entries;
  }

  function flushQueuedTerminalEvents(
    contentsId: number,
    surfaceId: Id,
    snapshotSequence: number
  ): void {
    const attachment = attachedSurfacesByContents.get(contentsId)?.get(surfaceId);
    if (!attachment) {
      return;
    }

    const queuedChunks = attachment.queuedChunks
      .filter((payload) => payload.sequence > snapshotSequence)
      .sort((left, right) => left.sequence - right.sequence);
    attachment.queuedChunks = [];
    for (const payload of queuedChunks) {
      sendTerminalEvent(contentsId, {
        type: "chunk",
        payload
      });
    }
    if (attachment.pendingExit) {
      sendTerminalEvent(contentsId, {
        type: "exit",
        payload: attachment.pendingExit
      });
      attachment.pendingExit = null;
    }
  }

  function forwardTerminalChunk(payload: SurfaceChunkPayload): void {
    for (const [contentsId, attachment] of surfaceAttachmentEntries(
      payload.surfaceId
    )) {
      if (attachment.status === "hydrating") {
        attachment.queuedChunks.push(payload);
        continue;
      }
      sendTerminalEvent(contentsId, {
        type: "chunk",
        payload
      });
    }
  }

  function forwardTerminalExit(payload: SurfaceExitPayload): void {
    for (const [contentsId, attachment] of surfaceAttachmentEntries(
      payload.surfaceId
    )) {
      if (attachment.status === "hydrating") {
        attachment.pendingExit = payload;
        continue;
      }
      sendTerminalEvent(contentsId, {
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
        if (!options.getState().surfaces[event.surfaceId]) {
          return;
        }
        options.dispatchAppAction({
          type: "terminal.bell"
        });
        return;
      }
      case "terminal.notification": {
        const state = options.getState();
        const surface = state.surfaces[event.surfaceId];
        if (!surface) {
          return;
        }
        const pane = state.panes[surface.paneId];
        if (!pane) {
          return;
        }
        const title = event.title ?? surface.title;
        const message = event.message ?? surface.cwd ?? "Terminal notification";
        const vendor = options.getSurfaceVendor?.(event.surfaceId) ?? "unknown";
        const visibleToUser =
          options.isSurfaceVisibleToUser?.(event.surfaceId) ?? false;
        if (vendor === "codex") {
          if (isCodexInputAttention(title, message)) {
            options.dispatchAppAction({
              type: "agent.event",
              workspaceId: pane.workspaceId,
              paneId: surface.paneId,
              surfaceId: event.surfaceId,
              sessionId: event.sessionId,
              agent: "codex",
              event: "needs_input",
              title: "Codex needs input",
              message,
              details: {
                uiOnly: true,
                ...(visibleToUser ? { visibleToUser: true } : {}),
                source: "terminal",
                protocol: event.protocol,
                terminalTitle: title
              }
            });
          }
          return;
        }
        if (visibleToUser) {
          return;
        }
        options.dispatchAppAction({
          type: "notification.create",
          workspaceId: pane.workspaceId,
          paneId: surface.paneId,
          surfaceId: event.surfaceId,
          title,
          message,
          source: "terminal"
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
    snapshotSurface,
    attachSurface,
    detachSurface,
    handlePtyEvent
  };
}

function isCodexInputAttention(title: string, message: string): boolean {
  const normalized = `${title}\n${message}`.trim();
  if (!normalized) {
    return false;
  }
  return CODEX_INPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}
