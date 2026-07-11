import type { Id } from "@kmux/proto";

import type { PtyEvent } from "../shared/ptyProtocol";

import { SHELL_READY_OSC_PAYLOAD } from "./shellIntegration";

export const SHELL_READY_FALLBACK_MS = 8_000;

export interface ShellInputReadyRecord {
  sessionId: Id;
  surfaceId: Id;
  shellInputReady: boolean;
  pendingInitialInput?: string;
  shellReadyFallbackTimer: NodeJS.Timeout | null;
  pty: {
    write(text: string): void;
  };
}

export function isShellReadyOscPayload(payload: string): boolean {
  return payload === SHELL_READY_OSC_PAYLOAD;
}

export function markShellInputReady(
  record: ShellInputReadyRecord,
  emit: (event: PtyEvent) => void,
  onReady?: () => void
): boolean {
  if (record.shellInputReady) {
    return false;
  }

  record.shellInputReady = true;
  disposeShellReadyFallback(record);

  const pendingInitialInput = record.pendingInitialInput;
  record.pendingInitialInput = undefined;
  if (pendingInitialInput) {
    record.pty.write(pendingInitialInput);
  }
  onReady?.();

  emit({
    type: "shell.ready",
    sessionId: record.sessionId,
    surfaceId: record.surfaceId
  });
  return true;
}

export function armShellReadyFallback(
  record: ShellInputReadyRecord,
  emit: (event: PtyEvent) => void,
  fallbackMs = SHELL_READY_FALLBACK_MS,
  onReady?: () => void
): void {
  if (record.shellInputReady || record.shellReadyFallbackTimer) {
    return;
  }

  record.shellReadyFallbackTimer = setTimeout(() => {
    record.shellReadyFallbackTimer = null;
    markShellInputReady(record, emit, onReady);
  }, fallbackMs);
}

export function disposeShellReadyFallback(record: ShellInputReadyRecord): void {
  if (!record.shellReadyFallbackTimer) {
    return;
  }
  clearTimeout(record.shellReadyFallbackTimer);
  record.shellReadyFallbackTimer = null;
}
