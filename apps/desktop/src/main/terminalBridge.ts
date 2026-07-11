import type { AppAction, AppState } from "@kmux/core";
import type {
  Id,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalKeyInput,
  UsageVendor
} from "@kmux/proto";
import type { PtyEvent } from "../shared/ptyProtocol";

import type { PtyHostManager } from "./ptyHost";
import { logDiagnostics } from "../shared/diagnostics";

interface TerminalBridgeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  getPtyHost: () => PtyHostManager | null;
  onSurfaceInputText?: (surfaceId: Id, text: string) => void;
  getSurfaceVendor?: (surfaceId: Id) => UsageVendor;
  isSurfaceVisibleToUser?: (surfaceId: Id) => boolean;
}
const TITLE_METADATA_COALESCE_MS = 1000;
type CodexInputAttentionMatch = {
  reason:
    | "plan-mode-prompt"
    | "enter-to-submit-answer"
    | "needs-input"
    | "waiting-for-input"
    | "question-unanswered"
    | "question-submit";
};

type CodexInputAttentionMatchOptions = {
  allowGenericInputPhrases: boolean;
};

export interface TerminalBridge {
  surfaceSessionId(surfaceId: Id): Id | null;
  sendText(surfaceId: Id, text: string): void;
  sendKey(surfaceId: Id, key: string): void;
  sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void;
  snapshotSurface(
    surfaceId: Id,
    options?: SurfaceSnapshotOptions
  ): Promise<SurfaceSnapshotPayload | null>;
  handlePtyEvent(event: PtyEvent): void;
}

export function createTerminalBridge(
  options: TerminalBridgeOptions
): TerminalBridge {
  const pendingTitleMetadata = new Map<
    string,
    {
      surfaceId: Id;
      sessionId: Id;
      title: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const lastTitleMetadataDispatchAt = new Map<string, number>();
  const lastDispatchedTitleMetadata = new Map<string, string>();

  function surfaceSessionId(surfaceId: Id): Id | null {
    const surface = options.getState().surfaces[surfaceId];
    return surface ? surface.sessionId : null;
  }

  function isCurrentSurfaceSession(surfaceId: Id, sessionId: Id): boolean {
    return surfaceSessionId(surfaceId) === sessionId;
  }

  function titleMetadataKey(surfaceId: Id, sessionId: Id): string {
    return `${surfaceId}\u0000${sessionId}`;
  }

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
    const hasNeedsInput = Object.values(workspace?.statusEntries ?? {}).some(
      (entry) =>
        entry.surfaceId === surfaceId &&
        entry.text === "needs input" &&
        entry.key.startsWith("agent:")
    );
    if (!hasNeedsInput) {
      return;
    }
    const diagnosticSuffix =
      trigger.kind === "dismiss" ? "dismissed" : "submitted";
    const triggerInfo =
      trigger.kind === "dismiss"
        ? { dismissKey: trigger.key }
        : { submitKey: "enter" as const };
    logDiagnostics(`main.terminal.agent-input-${diagnosticSuffix}`, {
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      ...triggerInfo
    });
    options.dispatchAppAction({
      type: "agent.attention.clear",
      surfaceId
    });
  }

  function sendText(surfaceId: Id, text: string): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      observeTextInput(surfaceId, text);
      options.getPtyHost()?.sendText(sessionId, text);
    }
  }

  function observeTextInput(surfaceId: Id, text: string): void {
    const dismissKey = dismissKeyFromText(text);
    if (dismissKey) {
      clearVisibleAgentNeedsInput(surfaceId, {
        kind: "dismiss",
        key: dismissKey
      });
    } else if (isSubmitText(text)) {
      clearVisibleAgentNeedsInput(surfaceId, { kind: "submit" });
    }
    options.onSurfaceInputText?.(surfaceId, text);
  }

  function sendKeyInput(surfaceId: Id, input: TerminalKeyInput): void {
    const sessionId = surfaceSessionId(surfaceId);
    if (sessionId) {
      observeKeyInput(surfaceId, input);
      options.getPtyHost()?.sendKey(sessionId, input);
    }
  }

  function observeKeyInput(surfaceId: Id, input: TerminalKeyInput): void {
    const dismissKey = dismissKeyFromKeyInput(input);
    if (dismissKey) {
      clearVisibleAgentNeedsInput(surfaceId, {
        kind: "dismiss",
        key: dismissKey
      });
    } else if (isSubmitKeyInput(input)) {
      clearVisibleAgentNeedsInput(surfaceId, { kind: "submit" });
    }
  }

  function sendKey(surfaceId: Id, key: string): void {
    sendKeyInput(surfaceId, { key });
  }

  function handleTerminalMetadata(
    payload: Extract<PtyEvent, { type: "metadata" }>["payload"]
  ): void {
    if (!isCurrentSurfaceSession(payload.surfaceId, payload.sessionId)) {
      logDiagnostics("main.terminal.metadata.dropped", {
        reason: "stale-session",
        surfaceId: payload.surfaceId,
        sessionId: payload.sessionId
      });
      return;
    }
    if (
      payload.cwd !== undefined ||
      payload.attention !== undefined ||
      payload.unreadDelta !== undefined
    ) {
      options.dispatchAppAction({
        type: "surface.metadata",
        surfaceId: payload.surfaceId,
        cwd: payload.cwd,
        attention: payload.attention,
        unreadDelta: payload.unreadDelta
      });
    }
    if (payload.title !== undefined) {
      queueTitleMetadata(payload.surfaceId, payload.sessionId, payload.title);
    }
  }

  function queueTitleMetadata(
    surfaceId: Id,
    sessionId: Id,
    title: string
  ): void {
    const key = titleMetadataKey(surfaceId, sessionId);
    if (!shouldDispatchTitleMetadata(surfaceId, sessionId, title)) {
      if (pendingTitleMetadata.get(key)?.title !== title) {
        clearPendingTitleMetadata(surfaceId, sessionId);
      }
      return;
    }

    const now = Date.now();
    const lastDispatchAt = lastTitleMetadataDispatchAt.get(key);
    if (
      lastDispatchAt === undefined ||
      now - lastDispatchAt >= TITLE_METADATA_COALESCE_MS
    ) {
      clearPendingTitleMetadata(surfaceId, sessionId);
      dispatchTitleMetadata(surfaceId, sessionId, title);
      return;
    }

    const existing = pendingTitleMetadata.get(key);
    if (existing) {
      existing.title = title;
      return;
    }

    const timer = setTimeout(
      () => {
        flushPendingTitleMetadata(surfaceId, sessionId);
      },
      TITLE_METADATA_COALESCE_MS - (now - lastDispatchAt)
    );
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    pendingTitleMetadata.set(key, { surfaceId, sessionId, title, timer });
  }

  function shouldDispatchTitleMetadata(
    surfaceId: Id,
    sessionId: Id,
    title: string
  ): boolean {
    const surface = options.getState().surfaces[surfaceId];
    if (!surface || surface.sessionId !== sessionId || surface.titleLocked) {
      return false;
    }
    if (surface.title === title) {
      return false;
    }
    const key = titleMetadataKey(surfaceId, sessionId);
    if (lastDispatchedTitleMetadata.get(key) === title) {
      return false;
    }
    if (pendingTitleMetadata.get(key)?.title === title) {
      return false;
    }
    return true;
  }

  function dispatchTitleMetadata(
    surfaceId: Id,
    sessionId: Id,
    title: string
  ): void {
    if (!shouldDispatchTitleMetadata(surfaceId, sessionId, title)) {
      return;
    }
    const key = titleMetadataKey(surfaceId, sessionId);
    lastTitleMetadataDispatchAt.set(key, Date.now());
    lastDispatchedTitleMetadata.set(key, title);
    options.dispatchAppAction({
      type: "surface.metadata",
      surfaceId,
      title
    });
  }

  function flushPendingTitleMetadata(surfaceId: Id, sessionId: Id): void {
    const key = titleMetadataKey(surfaceId, sessionId);
    const pending = pendingTitleMetadata.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTitleMetadata.delete(key);
    dispatchTitleMetadata(surfaceId, sessionId, pending.title);
  }

  function clearPendingTitleMetadata(surfaceId: Id, sessionId: Id): void {
    const key = titleMetadataKey(surfaceId, sessionId);
    const pending = pendingTitleMetadata.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTitleMetadata.delete(key);
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

  function handlePtyEvent(event: PtyEvent): void {
    switch (event.type) {
      case "spawned":
        options.dispatchAppAction({
          type: "session.started",
          sessionId: event.sessionId,
          pid: event.pid,
          shellInputReady: event.shellInputReady
        });
        return;
      case "shell.ready":
        options.dispatchAppAction({
          type: "session.shellReady",
          sessionId: event.sessionId
        });
        return;
      case "metadata":
        handleTerminalMetadata(event.payload);
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
        if (!isCurrentSurfaceSession(event.surfaceId, event.sessionId)) {
          logDiagnostics("main.terminal.bell.dropped", {
            reason: "stale-session",
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
        if (surface.sessionId !== event.sessionId) {
          logDiagnostics("main.terminal.notification.dropped", {
            reason: "stale-session",
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
        const codexAttentionMatch = matchCodexInputAttentionForVendor(
          vendor,
          title,
          message
        );
        if (codexAttentionMatch) {
          logDiagnostics("main.terminal.notification.codex-promoted", {
            surfaceId: event.surfaceId,
            sessionId: event.sessionId,
            protocol: event.protocol,
            vendor,
            visibleToUser,
            title,
            message,
            matchReason: codexAttentionMatch.reason
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
      case "input.observed": {
        const currentSession = options
          .getPtyHost()
          ?.sessionRef(event.session.surfaceId, event.session.sessionId);
        if (!currentSession || currentSession.epoch !== event.session.epoch) {
          return;
        }
        if (event.input.type === "text") {
          observeTextInput(event.session.surfaceId, event.input.text);
        } else if (event.input.type === "key") {
          observeKeyInput(event.session.surfaceId, event.input.input);
        }
        return;
      }
      case "runtime.lost":
        for (const session of event.sessions) {
          if (!isCurrentSurfaceSession(session.surfaceId, session.sessionId)) {
            continue;
          }
          flushPendingTitleMetadata(session.surfaceId, session.sessionId);
          options.dispatchAppAction({
            type: "session.exited",
            sessionId: session.sessionId
          });
        }
        return;
      case "exit":
        flushPendingTitleMetadata(
          event.payload.surfaceId,
          event.payload.sessionId
        );
        options.dispatchAppAction({
          type: "session.exited",
          sessionId: event.payload.sessionId,
          exitCode: event.payload.exitCode
        });
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
    snapshotSurface,
    handlePtyEvent
  };
}

function matchCodexInputAttentionForVendor(
  vendor: UsageVendor,
  title: string,
  message: string
): CodexInputAttentionMatch | null {
  if (vendor === "codex") {
    return matchCodexInputAttention(title, message, {
      allowGenericInputPhrases: true
    });
  }
  if (vendor === "unknown") {
    return matchCodexInputAttention(title, message, {
      allowGenericInputPhrases: false
    });
  }
  return null;
}

function matchCodexInputAttention(
  title: string,
  message: string,
  options: CodexInputAttentionMatchOptions
): CodexInputAttentionMatch | null {
  const normalized = `${title}\n${message}`.trim();
  if (!normalized) {
    return null;
  }

  const hasQuestion = /\bquestion \d+\/\d+\b/i.test(normalized);
  const hasEnterToSubmit = /\benter to submit answer\b/i.test(normalized);
  if (hasQuestion) {
    if (/\bunanswered\b/i.test(normalized)) {
      return { reason: "question-unanswered" };
    }
    if (hasEnterToSubmit) {
      return { reason: "question-submit" };
    }
  }
  if (/\bplan mode prompt:/i.test(normalized)) {
    return { reason: "plan-mode-prompt" };
  }
  if (hasEnterToSubmit) {
    return { reason: "enter-to-submit-answer" };
  }
  if (options.allowGenericInputPhrases) {
    if (/\bneeds input\b/i.test(normalized)) {
      return { reason: "needs-input" };
    }
    if (/\bwaiting for input\b/i.test(normalized)) {
      return { reason: "waiting-for-input" };
    }
  }
  return null;
}

function dismissKeyFromText(
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

function dismissKeyFromKeyInput(
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
  return input.text ? dismissKeyFromText(input.text) : null;
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
