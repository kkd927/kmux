import {BrowserWindow} from "electron";

import type {AppAction, AppState} from "@kmux/core";
import type {
    Id,
    PtyEvent,
    SurfaceChunkSegment,
    SurfaceSnapshotOptions,
    SurfaceChunkPayload,
    SurfaceExitPayload,
    SurfaceSnapshotPayload,
    TerminalKeyInput,
    UsageVendor
} from "@kmux/proto";

import type {PtyHostManager} from "./ptyHost";
import { logDiagnostics } from "../shared/diagnostics";
import { profileNowMs } from "../shared/nodeSmoothnessProfile";
import { createSmoothnessProfileBucket } from "../shared/smoothnessProfileBucket";
import type { SmoothnessProfileRecorder } from "../shared/smoothnessProfile";

interface TerminalBridgeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  getPtyHost: () => PtyHostManager | null;
  onSurfaceInputText?: (surfaceId: Id, text: string) => void;
  getSurfaceVendor?: (surfaceId: Id) => UsageVendor;
  isSurfaceVisibleToUser?: (surfaceId: Id) => boolean;
  profileRecorder?: SmoothnessProfileRecorder;
}

interface SurfaceAttachmentState {
  status: "hydrating" | "ready";
  queuedChunks: SurfaceChunkPayload[];
  queuedBytes: number;
  queueOverflowed: boolean;
  overflowedThroughSequence: number | null;
  pendingExit: SurfaceExitPayload | null;
  hydratePromise: Promise<SurfaceSnapshotPayload | null> | null;
}

const ATTACH_SNAPSHOT_SETTLE_MS = 120;
const ATTACH_QUEUE_MAX_CHUNKS = 1000;
const ATTACH_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const ATTACH_QUEUE_MAX_RECOVERY_SNAPSHOTS = 2;
const PROFILE_TERMINAL_BUCKET_MIN_CHUNKS = 100;
const PROFILE_TERMINAL_BUCKET_MAX_DURATION_MS = 1000;
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

const CODEX_STRICT_INPUT_PATTERNS = [
  /\bplan mode prompt:/i,
  /\benter to submit answer\b/i,
  /\btab to add notes\b/i,
  /\besc to interrupt\b/i,
  /\bquestion \d+\/\d+\b/i,
  /\bunanswered\b/i
] as const;

export interface TerminalBridge {
  surfaceSessionId(surfaceId: Id): Id | null;
  sendText(surfaceId: Id, text: string): void;
  sendKey(surfaceId: Id, key: string): void;
  sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void;
  resizeSurface(surfaceId: Id, cols: number, rows: number): Promise<void>;
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
  const terminalIpcBucket = createSmoothnessProfileBucket<{
    surfaceId: Id;
    sessionId: Id;
    startedAt: number;
    chunks: number;
    bytes: number;
    sends: number;
    maxSendDurationMs: number;
  }>({
    minEvents: PROFILE_TERMINAL_BUCKET_MIN_CHUNKS,
    maxDurationMs: PROFILE_TERMINAL_BUCKET_MAX_DURATION_MS,
    now: profileNowMs,
    createDetails: (key, startedAt) => {
      const [surfaceId, sessionId] = key.split("\u0000") as [Id, Id];
      return {
        surfaceId,
        sessionId,
        startedAt,
        chunks: 0,
        bytes: 0,
        sends: 0,
        maxSendDurationMs: 0
      };
    },
    onFlush: (details, durationMs, at) => {
      if (!options.profileRecorder?.enabled) {
        return;
      }
      options.profileRecorder.record({
        source: "main",
        name: "terminal.ipc.bucket",
        at,
        details: {
          ...details,
          durationMs
        }
      });
    }
  });

  function surfaceSessionId(surfaceId: Id): Id | null {
    const surface = options.getState().surfaces[surfaceId];
    return surface ? surface.sessionId : null;
  }

  const VISIBLE_DISMISS_AGENTS = ["codex", "claude"] as const;
  const VISIBLE_SUBMIT_AGENTS = ["codex", "gemini"] as const;

  type VisibleInputClearTrigger =
    | { kind: "dismiss"; key: "escape" | "ctrl-c" | "ctrl-d" }
    | { kind: "submit" };

  function clearVisibleAgentNeedsInput(
    surfaceId: Id,
    trigger: VisibleInputClearTrigger
  ): void {
    const state = options.getState();
    const surface = state.surfaces[surfaceId];
    if (!surface) {
      return;
    }
    const pane = state.panes[surface.paneId];
    if (!pane) {
      return;
    }
    const visibleToUser = options.isSurfaceVisibleToUser?.(surfaceId) ?? false;
    if (!visibleToUser) {
      return;
    }
    const workspace = state.workspaces[pane.workspaceId];
    const agents =
      trigger.kind === "dismiss"
        ? VISIBLE_DISMISS_AGENTS
        : VISIBLE_SUBMIT_AGENTS;
    const diagnosticSuffix =
      trigger.kind === "dismiss" ? "dismissed" : "submitted";
    const promptMessage =
      trigger.kind === "dismiss"
        ? "Dismissed input prompt"
        : "Submitted input prompt";
    for (const agent of agents) {
      const statusKey = `agent:${agent}:${surfaceId}`;
      if (workspace?.statusEntries?.[statusKey]?.text !== "needs input") {
        continue;
      }
      const triggerInfo =
        trigger.kind === "dismiss"
          ? { dismissKey: trigger.key }
          : { submitKey: "enter" as const };
      logDiagnostics(`main.terminal.${agent}-input-${diagnosticSuffix}`, {
        workspaceId: pane.workspaceId,
        paneId: surface.paneId,
        surfaceId,
        sessionId: surface.sessionId,
        ...triggerInfo
      });
      options.dispatchAppAction({
        type: "agent.event",
        workspaceId: pane.workspaceId,
        paneId: surface.paneId,
        surfaceId,
        sessionId: surface.sessionId,
        agent,
        event: "idle",
        message: promptMessage,
        details: {
          uiOnly: true,
          visibleToUser: true,
          source: "terminal-input",
          ...triggerInfo
        }
      });
    }
  }

  function sendText(surfaceId: Id, text: string): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      const dismissKey = codexDismissKeyFromText(text);
      if (dismissKey) {
        clearVisibleAgentNeedsInput(surfaceId, {
          kind: "dismiss",
          key: dismissKey
        });
      } else if (isSubmitText(text)) {
        clearVisibleAgentNeedsInput(surfaceId, { kind: "submit" });
      }
      options.onSurfaceInputText?.(surfaceId, text);
      options.getPtyHost()?.sendText(sessionId, text);
    }
  }

  function sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      const dismissKey = codexDismissKeyFromKeyInput(input);
      if (dismissKey) {
        clearVisibleAgentNeedsInput(surfaceId, {
          kind: "dismiss",
          key: dismissKey
        });
      } else if (isSubmitKeyInput(input)) {
        clearVisibleAgentNeedsInput(surfaceId, { kind: "submit" });
      }
      options.getPtyHost()?.sendKey(sessionId, input);
    }
  }

  function sendKey(surfaceId: Id, key: string): void {
    sendKeyInput(surfaceId, { key });
  }

  async function resizeSurface(
    surfaceId: Id,
    cols: number,
    rows: number
  ): Promise<void> {
    const sessionId = surfaceSessionId(surfaceId);
    if (!sessionId) {
      return;
    }

    const startedAt = profileNowMs();
    const ptyHost = options.getPtyHost();
    if (options.profileRecorder?.enabled) {
      options.profileRecorder.record({
        source: "main",
        name: "terminal.resize.request",
        at: startedAt,
        details: {
          surfaceId,
          sessionId,
          cols,
          rows,
          hasPtyHost: Boolean(ptyHost)
        }
      });
    }
    try {
      await ptyHost?.resize(sessionId, cols, rows);
    } finally {
      if (options.profileRecorder?.enabled) {
        const endedAt = profileNowMs();
        options.profileRecorder.record({
          source: "main",
          name: "terminal.resize.ack",
          at: endedAt,
          details: {
            surfaceId,
            sessionId,
            cols,
            rows,
            durationMs: endedAt - startedAt
          }
        });
      }
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
      queuedBytes: 0,
      queueOverflowed: false,
      overflowedThroughSequence: null,
      pendingExit: null,
      hydratePromise: null
    };
    attached.set(surfaceId, attachment);

    attachment.hydratePromise = (async () => {
      let snapshot = await snapshotSurface(
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
      let recoverySnapshots = 0;
      while (
        shouldRecoverHydrationOverflow(attachment, snapshot) &&
        recoverySnapshots < ATTACH_QUEUE_MAX_RECOVERY_SNAPSHOTS
      ) {
        recoverySnapshots += 1;
        snapshot = await snapshotSurface(surfaceId);
        const latestAttachment = attachedSurfacesByContents
          .get(contentsId)
          ?.get(surfaceId);
        if (latestAttachment !== attachment) {
          return snapshot;
        }
      }
      if (attachment.queueOverflowed) {
        if (hydrationOverflowCoveredBySnapshot(attachment, snapshot)) {
          clearHydrationOverflow(attachment);
        } else {
          recordDegradedAttachRecovery({
            contentsId,
            surfaceId,
            recoverySnapshots,
            snapshotSequence: snapshot?.sequence ?? null,
            overflowedThroughSequence: attachment.overflowedThroughSequence
          });
          clearHydrationOverflow(attachment);
        }
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
    const sendStartedAt = profileNowMs();
    window?.webContents.send("kmux:terminal-event", event);
    if (options.profileRecorder?.enabled && event.type === "chunk") {
      const now = profileNowMs();
      terminalIpcBucket.record(
        `${event.payload.surfaceId}\u0000${event.payload.sessionId}`,
        (details) => {
          details.chunks += 1;
          details.bytes += Buffer.byteLength(event.payload.chunk, "utf8");
          details.sends += 1;
          details.maxSendDurationMs = Math.max(
            details.maxSendDurationMs,
            now - sendStartedAt
          );
        }
      );
    }
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
      .map((payload) => trimHydrationChunkAfterSnapshot(payload, snapshotSequence))
      .filter((payload): payload is SurfaceChunkPayload => Boolean(payload))
      .sort(
        (left, right) =>
          chunkStartSequence(left) - chunkStartSequence(right) ||
          left.sequence - right.sequence
      );
    options.profileRecorder?.record({
      source: "main",
      name: "terminal.attach.queue",
      at: profileNowMs(),
      details: {
        contentsId,
        surfaceId,
        queuedChunks: queuedChunks.length,
        queuedBytes: attachment.queuedBytes,
        queueOverflowed: attachment.queueOverflowed,
        snapshotSequence
      }
    });
    attachment.queuedChunks = [];
    attachment.queuedBytes = 0;
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
        queueHydrationChunk(attachment, payload);
        continue;
      }
      sendTerminalEvent(contentsId, {
        type: "chunk",
        payload
      });
    }
  }

  function chunkStartSequence(payload: SurfaceChunkPayload): number {
    return payload.fromSequence ?? payload.sequence;
  }

  function trimHydrationChunkAfterSnapshot(
    payload: SurfaceChunkPayload,
    snapshotSequence: number
  ): SurfaceChunkPayload | null {
    if (payload.sequence <= snapshotSequence) {
      return null;
    }
    if (!payload.segments || payload.segments.length === 0) {
      return payload;
    }

    let trimOffset = 0;
    const segments: SurfaceChunkSegment[] = [];
    for (const segment of payload.segments) {
      if (segment.sequence > snapshotSequence) {
        segments.push(segment);
        continue;
      }
      trimOffset += segment.length;
    }
    if (segments.length === 0) {
      return null;
    }
    if (segments.length === payload.segments.length) {
      return payload;
    }

    return {
      surfaceId: payload.surfaceId,
      sessionId: payload.sessionId,
      fromSequence: segments[0].sequence,
      sequence: segments[segments.length - 1].sequence,
      chunk: payload.chunk.slice(trimOffset),
      segments
    };
  }

  function recordDegradedAttachRecovery({
    contentsId,
    surfaceId,
    recoverySnapshots,
    snapshotSequence,
    overflowedThroughSequence
  }: {
    contentsId: number;
    surfaceId: Id;
    recoverySnapshots: number;
    snapshotSequence: number | null;
    overflowedThroughSequence: number | null;
  }): void {
    const details = {
      contentsId,
      surfaceId,
      recoverySnapshots,
      maxRecoverySnapshots: ATTACH_QUEUE_MAX_RECOVERY_SNAPSHOTS,
      snapshotSequence,
      overflowedThroughSequence,
      policy: "fresh-snapshot-then-ready" as const
    };
    logDiagnostics("main.terminal.attach.queue.degraded", details);
    options.profileRecorder?.record({
      source: "main",
      name: "terminal.attach.queue.degraded",
      at: profileNowMs(),
      details
    });
  }

  function queueHydrationChunk(
    attachment: SurfaceAttachmentState,
    payload: SurfaceChunkPayload
  ): void {
    if (attachment.queueOverflowed) {
      attachment.overflowedThroughSequence = Math.max(
        attachment.overflowedThroughSequence ?? 0,
        payload.sequence
      );
      return;
    }
    const chunkBytes = Buffer.byteLength(payload.chunk, "utf8");
    const nextQueuedBytes = attachment.queuedBytes + chunkBytes;
    if (
      attachment.queuedChunks.length + 1 > ATTACH_QUEUE_MAX_CHUNKS ||
      nextQueuedBytes > ATTACH_QUEUE_MAX_BYTES
    ) {
      attachment.overflowedThroughSequence = Math.max(
        maxQueuedChunkSequence(attachment.queuedChunks),
        payload.sequence
      );
      attachment.queuedChunks = [];
      attachment.queuedBytes = 0;
      attachment.queueOverflowed = true;
      return;
    }
    attachment.queuedChunks.push(payload);
    attachment.queuedBytes = nextQueuedBytes;
  }

  function shouldRecoverHydrationOverflow(
    attachment: SurfaceAttachmentState,
    snapshot: SurfaceSnapshotPayload | null
  ): boolean {
    if (!snapshot || attachment.pendingExit || !attachment.queueOverflowed) {
      return false;
    }
    const overflowedThroughSequence = attachment.overflowedThroughSequence;
    return (
      overflowedThroughSequence !== null &&
      snapshot.sequence < overflowedThroughSequence
    );
  }

  function hydrationOverflowCoveredBySnapshot(
    attachment: SurfaceAttachmentState,
    snapshot: SurfaceSnapshotPayload | null
  ): boolean {
    const overflowedThroughSequence = attachment.overflowedThroughSequence;
    return (
      snapshot !== null &&
      overflowedThroughSequence !== null &&
      snapshot.sequence >= overflowedThroughSequence
    );
  }

  function clearHydrationOverflow(attachment: SurfaceAttachmentState): void {
    attachment.queueOverflowed = false;
    attachment.overflowedThroughSequence = null;
    attachment.queuedChunks = [];
    attachment.queuedBytes = 0;
  }

  function maxQueuedChunkSequence(chunks: SurfaceChunkPayload[]): number {
    return chunks.reduce(
      (maxSequence, payload) => Math.max(maxSequence, payload.sequence),
      0
    );
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
        logDiagnostics("main.terminal.bell.received", {
          surfaceId: event.surfaceId,
          sessionId: event.sessionId,
          title: event.title,
          cwd: event.cwd
        });
        if (!options.getState().surfaces[event.surfaceId]) {
          logDiagnostics("main.terminal.bell.dropped", {
            reason: "missing-surface",
            surfaceId: event.surfaceId,
            sessionId: event.sessionId
          });
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
        const vendor = options.getSurfaceVendor?.(event.surfaceId) ?? "unknown";
        const visibleToUser =
          options.isSurfaceVisibleToUser?.(event.surfaceId) ?? false;
        logDiagnostics("main.terminal.notification.received", {
          surfaceId: event.surfaceId,
          sessionId: event.sessionId,
          protocol: event.protocol,
          title: event.title,
          message: event.message,
          vendor,
          visibleToUser
        });
        if (!surface) {
          logDiagnostics("main.terminal.notification.dropped", {
            reason: "missing-surface",
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol
          });
          return;
        }
        const pane = state.panes[surface.paneId];
        if (!pane) {
          logDiagnostics("main.terminal.notification.dropped", {
            reason: "missing-pane",
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol
          });
          return;
        }
        const title = event.title ?? surface.title;
        const message = event.message ?? surface.cwd ?? "Terminal notification";
        const inferredCodexAttention =
          vendor === "codex"
            ? isCodexInputAttention(title, message)
            : isStrictCodexInputAttention(title, message);
        if (inferredCodexAttention) {
          logDiagnostics("main.terminal.notification.codex-promoted", {
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol,
            vendor,
            visibleToUser,
            title,
            message
          });
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
              ...(vendor === "unknown"
                ? { inferredFromUnknownVendor: true }
                : {}),
              source: "terminal",
              protocol: event.protocol,
              terminalTitle: title
            }
          });
          return;
        }
        if (vendor === "codex") {
          logDiagnostics("main.terminal.notification.codex-suppressed", {
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol,
            title,
            message
          });
          return;
        }
        if (visibleToUser) {
          logDiagnostics("main.terminal.notification.visible-suppressed", {
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol,
            title,
            message
          });
          return;
        }
        logDiagnostics("main.terminal.notification.generic-dispatch", {
          surfaceId: event.surfaceId,
          sessionId: event.sessionId,
          protocol: event.protocol,
          title,
          message
        });
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

function isStrictCodexInputAttention(title: string, message: string): boolean {
  const normalized = `${title}\n${message}`.trim();
  if (!normalized) {
    return false;
  }
  return CODEX_STRICT_INPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function codexDismissKeyFromText(
  text: string
): "escape" | "ctrl-c" | "ctrl-d" | null {
  if (text === "\u001b") {
    return "escape";
  }
  if (text === "\u0003") {
    return "ctrl-c";
  }
  if (text === "\u0004") {
    return "ctrl-d";
  }
  return null;
}

function codexDismissKeyFromKeyInput(
  input: TerminalKeyInput
): "escape" | "ctrl-c" | "ctrl-d" | null {
  const key = input.key.trim().toLowerCase();
  if (key === "escape") {
    return "escape";
  }
  if (input.ctrlKey && key === "c") {
    return "ctrl-c";
  }
  if (input.ctrlKey && key === "d") {
    return "ctrl-d";
  }
  return input.text ? codexDismissKeyFromText(input.text) : null;
}

function isSubmitText(text: string): boolean {
  // Strict equality (like dismissKey detection) — must be a pure Enter keystroke,
  // not a multi-char paste / programmatic send that happens to end with a newline.
  return text === "\r" || text === "\n" || text === "\r\n";
}

function isSubmitKeyInput(input: TerminalKeyInput): boolean {
  const key = input.key.trim().toLowerCase();
  if (key === "enter" || key === "return") {
    return true;
  }
  return input.text ? isSubmitText(input.text) : false;
}
