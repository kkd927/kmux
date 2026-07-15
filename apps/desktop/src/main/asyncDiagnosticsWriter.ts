import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  formatStructuredDiagnosticsRecord,
  MAX_DIAGNOSTICS_LOG_BYTES,
  resolveDiagnosticsLogPath,
  type DiagnosticsRecord
} from "../shared/diagnostics";

export const DIAGNOSTICS_WRITER_FLUSH_INTERVAL_MS = 200;
export const DIAGNOSTICS_WRITER_MAX_BATCH_RECORDS = 256;
export const DIAGNOSTICS_WRITER_MAX_BATCH_BYTES = 64 * 1024;
export const DIAGNOSTICS_WRITER_MAX_QUEUE_BYTES = 2 * 1024 * 1024;

interface QueuedDiagnosticsRecord {
  line: string;
  bytes: number;
  terminalTelemetry: boolean;
}

interface DropSummarySnapshot {
  line: string;
  droppedTerminalTelemetry: number;
  droppedOther: number;
}

export interface AsyncDiagnosticsWriter {
  readonly enabled: boolean;
  readonly queuedBytes: number;
  configure(logPath: string | undefined): Promise<boolean>;
  record(record: DiagnosticsRecord): boolean;
  flush(): Promise<void>;
  clear(): Promise<boolean>;
  close(): Promise<void>;
}

interface AsyncDiagnosticsWriterOptions {
  flushIntervalMs?: number;
  maxBatchRecords?: number;
  maxBatchBytes?: number;
  maxQueueBytes?: number;
  maxLogBytes?: number;
  openFile?: typeof open;
  mkdir?: typeof mkdir;
  removeFile?: typeof rm;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** Main-process owner for the settings-managed kmux-debug.log. */
export function createAsyncDiagnosticsWriter(
  options: AsyncDiagnosticsWriterOptions = {}
): AsyncDiagnosticsWriter {
  const flushIntervalMs =
    options.flushIntervalMs ?? DIAGNOSTICS_WRITER_FLUSH_INTERVAL_MS;
  const maxBatchRecords =
    options.maxBatchRecords ?? DIAGNOSTICS_WRITER_MAX_BATCH_RECORDS;
  const maxBatchBytes =
    options.maxBatchBytes ?? DIAGNOSTICS_WRITER_MAX_BATCH_BYTES;
  const maxQueueBytes =
    options.maxQueueBytes ?? DIAGNOSTICS_WRITER_MAX_QUEUE_BYTES;
  const maxLogBytes = options.maxLogBytes ?? MAX_DIAGNOSTICS_LOG_BYTES;
  const openFile = options.openFile ?? open;
  const mkdirDirectory = options.mkdir ?? mkdir;
  const removeFile = options.removeFile ?? rm;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;

  let logPath: string | undefined;
  let accepting = false;
  let failed = false;
  let file: FileHandle | null = null;
  let fileBytes = 0;
  let queueBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let operation = Promise.resolve();
  const queue: QueuedDiagnosticsRecord[] = [];
  let droppedTerminalTelemetry = 0;
  let droppedOther = 0;

  function cancelFlushTimer(): void {
    if (!flushTimer) {
      return;
    }
    clearTimer(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (
      flushTimer ||
      !accepting ||
      (queue.length === 0 &&
        droppedTerminalTelemetry === 0 &&
        droppedOther === 0)
    ) {
      return;
    }
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
    flushTimer.unref?.();
  }

  function enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
    const next = operation.then(task, task);
    operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function ensureOpen(): Promise<FileHandle | null> {
    if (file || !logPath || failed) {
      return file;
    }
    try {
      await mkdirDirectory(dirname(logPath), { recursive: true, mode: 0o700 });
      file = await openFile(logPath, "a", 0o600);
      await file.chmod(0o600);
      fileBytes = (await file.stat()).size;
      if (fileBytes > maxLogBytes) {
        await file.truncate(0);
        fileBytes = 0;
      }
      return file;
    } catch {
      failClosed();
      return null;
    }
  }

  function failClosed(): void {
    failed = true;
    accepting = false;
    cancelFlushTimer();
    queue.length = 0;
    queueBytes = 0;
    droppedTerminalTelemetry = 0;
    droppedOther = 0;
    const openFileHandle = file;
    file = null;
    if (openFileHandle) {
      void openFileHandle.close().catch(() => undefined);
    }
  }

  function dropQueuedTerminalTelemetry(bytesNeeded: number): void {
    for (
      let index = 0;
      index < queue.length && queueBytes + bytesNeeded > maxQueueBytes;
    ) {
      const queued = queue[index];
      if (!queued.terminalTelemetry) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      queueBytes -= queued.bytes;
      droppedTerminalTelemetry += 1;
    }
  }

  function formatDropSummary(): DropSummarySnapshot | null {
    if (droppedTerminalTelemetry === 0 && droppedOther === 0) {
      return null;
    }
    const snapshot = { droppedTerminalTelemetry, droppedOther };
    return {
      ...snapshot,
      line: formatStructuredDiagnosticsRecord({
        at: new Date().toISOString(),
        pid: process.pid,
        scope: "diagnostics.records.dropped",
        details: {
          reason: "queue-limit",
          ...snapshot
        },
        terminalTelemetry: false
      })
    };
  }

  async function writeBatch(
    batch: QueuedDiagnosticsRecord[],
    dropSummary: DropSummarySnapshot | null
  ): Promise<boolean> {
    const handle = await ensureOpen();
    if (!handle) {
      return false;
    }
    const contents = `${dropSummary?.line ?? ""}${batch
      .map((record) => record.line)
      .join("")}`;
    const bytes = Buffer.byteLength(contents);
    try {
      if (fileBytes + bytes > maxLogBytes) {
        await handle.truncate(0);
        fileBytes = 0;
      }
      await handle.write(contents, null, "utf8");
      fileBytes += bytes;
      return true;
    } catch {
      failClosed();
      return false;
    }
  }

  async function drainQueue(): Promise<void> {
    cancelFlushTimer();
    while (
      !failed &&
      (queue.length > 0 || droppedTerminalTelemetry > 0 || droppedOther > 0)
    ) {
      const batch: QueuedDiagnosticsRecord[] = [];
      let batchBytes = 0;
      while (queue.length > 0 && batch.length < maxBatchRecords) {
        const next = queue[0];
        if (batch.length > 0 && batchBytes + next.bytes > maxBatchBytes) {
          break;
        }
        queue.shift();
        queueBytes -= next.bytes;
        batch.push(next);
        batchBytes += next.bytes;
        if (batchBytes >= maxBatchBytes) {
          break;
        }
      }
      const summary = formatDropSummary();
      if (!(await writeBatch(batch, summary))) {
        return;
      }
      if (summary) {
        droppedTerminalTelemetry = Math.max(
          0,
          droppedTerminalTelemetry - summary.droppedTerminalTelemetry
        );
        droppedOther = Math.max(0, droppedOther - summary.droppedOther);
      }
    }
  }

  function flush(): Promise<void> {
    return enqueueOperation(drainQueue);
  }

  return {
    get enabled() {
      return accepting && !failed && Boolean(logPath);
    },
    get queuedBytes() {
      return queueBytes;
    },
    configure(nextLogPath): Promise<boolean> {
      const resolvedPath = resolveDiagnosticsLogPath(nextLogPath);
      if (!resolvedPath) {
        accepting = false;
      } else {
        logPath = resolvedPath;
        failed = false;
        accepting = true;
      }
      cancelFlushTimer();
      return enqueueOperation(async () => {
        await drainQueue();
        if (!resolvedPath) {
          const handle = file;
          file = null;
          logPath = undefined;
          fileBytes = 0;
          if (handle) {
            try {
              await handle.close();
            } catch {
              // Diagnostics shutdown must not affect app behavior.
            }
          }
          return true;
        }
        return Boolean(await ensureOpen());
      });
    },
    record(record): boolean {
      if (!accepting || failed || !logPath) {
        return false;
      }
      let line: string;
      try {
        line = formatStructuredDiagnosticsRecord(record);
      } catch {
        return false;
      }
      const bytes = Buffer.byteLength(line);
      if (bytes > maxQueueBytes) {
        if (record.terminalTelemetry) {
          droppedTerminalTelemetry += 1;
        } else {
          droppedOther += 1;
        }
        scheduleFlush();
        return false;
      }
      if (!record.terminalTelemetry) {
        dropQueuedTerminalTelemetry(bytes);
      }
      if (queueBytes + bytes > maxQueueBytes) {
        if (record.terminalTelemetry) {
          droppedTerminalTelemetry += 1;
        } else {
          droppedOther += 1;
        }
        scheduleFlush();
        return false;
      }
      queue.push({ line, bytes, terminalTelemetry: record.terminalTelemetry });
      queueBytes += bytes;
      if (queue.length >= maxBatchRecords || queueBytes >= maxBatchBytes) {
        cancelFlushTimer();
        void flush();
      } else {
        scheduleFlush();
      }
      return true;
    },
    flush,
    clear(): Promise<boolean> {
      cancelFlushTimer();
      return enqueueOperation(async () => {
        await drainQueue();
        const currentPath = logPath;
        const handle = file;
        file = null;
        fileBytes = 0;
        if (handle) {
          try {
            await handle.close();
          } catch {
            return false;
          }
        }
        if (!currentPath) {
          return false;
        }
        try {
          await removeFile(currentPath, { force: true });
          return true;
        } catch {
          return false;
        }
      });
    },
    close(): Promise<void> {
      accepting = false;
      cancelFlushTimer();
      return enqueueOperation(async () => {
        await drainQueue();
        const handle = file;
        file = null;
        logPath = undefined;
        fileBytes = 0;
        if (handle) {
          try {
            await handle.close();
          } catch {
            // Diagnostics shutdown must not affect app behavior.
          }
        }
      });
    }
  };
}
