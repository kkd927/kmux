import type { DiagnosticsRecord } from "../shared/diagnostics";

export const PTY_DIAGNOSTICS_BATCH_MAX_RECORDS = 256;
export const PTY_DIAGNOSTICS_BATCH_FLUSH_MS = 200;

export interface PtyDiagnosticsIpcBatcher {
  readonly enabled: boolean;
  configure(enabled: boolean): void;
  record(record: DiagnosticsRecord): boolean;
  flush(): void;
  close(): void;
}

export function createPtyDiagnosticsIpcBatcher(options: {
  enabled: boolean;
  sendBatch: (records: DiagnosticsRecord[]) => boolean;
  maxRecords?: number;
  flushMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): PtyDiagnosticsIpcBatcher {
  const maxRecords = options.maxRecords ?? PTY_DIAGNOSTICS_BATCH_MAX_RECORDS;
  const flushMs = options.flushMs ?? PTY_DIAGNOSTICS_BATCH_FLUSH_MS;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  const pending: DiagnosticsRecord[] = [];
  let enabled = options.enabled;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = (): void => {
    if (!timer) {
      return;
    }
    clearTimer(timer);
    timer = null;
  };

  const flush = (): void => {
    cancelTimer();
    if (pending.length === 0) {
      return;
    }
    options.sendBatch(pending.splice(0));
  };

  return {
    get enabled() {
      return enabled && !closed;
    },
    configure(nextEnabled): void {
      if (closed || enabled === nextEnabled) {
        return;
      }
      if (!nextEnabled) {
        flush();
      }
      enabled = nextEnabled;
    },
    record(record): boolean {
      if (!enabled || closed) {
        return false;
      }
      pending.push(record);
      if (pending.length >= maxRecords) {
        flush();
      } else if (!timer) {
        timer = setTimer(flush, flushMs);
        timer.unref?.();
      }
      return true;
    },
    flush,
    close(): void {
      if (closed) {
        return;
      }
      flush();
      closed = true;
      enabled = false;
    }
  };
}
