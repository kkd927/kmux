import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAsyncDiagnosticsWriter,
  DIAGNOSTICS_WRITER_FLUSH_INTERVAL_MS,
  DIAGNOSTICS_WRITER_MAX_BATCH_BYTES,
  DIAGNOSTICS_WRITER_MAX_BATCH_RECORDS,
  DIAGNOSTICS_WRITER_MAX_QUEUE_BYTES
} from "./asyncDiagnosticsWriter";
import {
  MAX_DIAGNOSTICS_LOG_BYTES,
  type DiagnosticsRecord
} from "../shared/diagnostics";

const sandboxes: string[] = [];

function sandboxPath(): string {
  const sandbox = mkdtempSync(join(tmpdir(), "kmux-async-diagnostics-"));
  sandboxes.push(sandbox);
  return join(sandbox, "kmux-debug.log");
}

function record(
  scope: string,
  details: Record<string, unknown> = {},
  terminalTelemetry = false
): DiagnosticsRecord {
  return {
    at: "2026-07-15T01:02:03.004Z",
    pid: 42,
    scope,
    details,
    terminalTelemetry
  };
}

function parsedLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.includes("{"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
}

afterEach(() => {
  vi.useRealTimers();
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("async diagnostics writer", () => {
  it("writes accepted records in order as secured JSON lines", async () => {
    const path = sandboxPath();
    writeFileSync(path, "legacy\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    const writer = createAsyncDiagnosticsWriter();

    expect(await writer.configure(path)).toBe(true);
    expect(writer.record(record("first", { sequence: 1 }))).toBe(true);
    expect(writer.record(record("second", { sequence: 2 }))).toBe(true);
    await writer.flush();
    await writer.close();

    expect(parsedLines(path).slice(-2)).toEqual([
      { scope: "first", sequence: 1 },
      { scope: "second", sequence: 2 }
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("flushes its pending batch after 200ms", async () => {
    vi.useFakeTimers();
    const path = sandboxPath();
    const writer = createAsyncDiagnosticsWriter();
    await writer.configure(path);
    writer.record(record("timed"));

    await vi.advanceTimersByTimeAsync(199);
    expect(statSync(path).size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await writer.flush();

    expect(parsedLines(path)).toEqual([{ scope: "timed" }]);
    expect(DIAGNOSTICS_WRITER_FLUSH_INTERVAL_MS).toBe(200);
    expect(DIAGNOSTICS_WRITER_MAX_BATCH_RECORDS).toBe(256);
    expect(DIAGNOSTICS_WRITER_MAX_BATCH_BYTES).toBe(64 * 1024);
    await writer.close();
  });

  it("truncates the existing file before a batch would exceed 20 MiB", async () => {
    const path = sandboxPath();
    writeFileSync(path, "stale\n");
    truncateSync(path, MAX_DIAGNOSTICS_LOG_BYTES);
    const writer = createAsyncDiagnosticsWriter();

    await writer.configure(path);
    writer.record(record("fresh", { sequence: 9 }));
    await writer.close();

    expect(readFileSync(path, "utf8")).not.toContain("stale");
    expect(parsedLines(path)).toEqual([{ scope: "fresh", sequence: 9 }]);
  });

  it("flushes before clear, disable, and close without accepting disabled records", async () => {
    const path = sandboxPath();
    const writer = createAsyncDiagnosticsWriter();
    await writer.configure(path);
    writer.record(record("before-clear"));

    expect(await writer.clear()).toBe(true);
    writer.record(record("after-clear"));
    await writer.configure(undefined);
    expect(writer.record(record("after-disable"))).toBe(false);

    expect(parsedLines(path)).toEqual([{ scope: "after-clear" }]);
    await writer.close();
  });

  it("bounds its queue, drops terminal telemetry first, and records a summary", async () => {
    const path = sandboxPath();
    const writer = createAsyncDiagnosticsWriter({
      maxQueueBytes: 700,
      maxBatchBytes: 10_000,
      maxBatchRecords: 1_000,
      flushIntervalMs: 60_000
    });
    await writer.configure(path);

    for (let sequence = 0; sequence < 20; sequence += 1) {
      writer.record(
        record(
          "terminal.data-plane.receive",
          { sequence, padding: "x".repeat(80) },
          true
        )
      );
    }
    expect(writer.queuedBytes).toBeLessThanOrEqual(700);
    expect(writer.record(record("main.lifecycle", { preserved: true }))).toBe(
      true
    );
    expect(writer.queuedBytes).toBeLessThanOrEqual(700);

    await writer.flush();
    await writer.close();
    const lines = parsedLines(path);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: "diagnostics.records.dropped",
        reason: "queue-limit",
        droppedTerminalTelemetry: expect.any(Number)
      })
    );
    expect(lines).toContainEqual({ scope: "main.lifecycle", preserved: true });
  });

  it("keeps accepting work within the bound while one asynchronous write is slow", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const fakeFile = {
      chmod: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: 0 })),
      truncate: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        markWriteStarted();
        await writeGate;
        return { bytesWritten: 1, buffer: "" };
      }),
      close: vi.fn(async () => undefined)
    } as unknown as FileHandle;
    const openFile = vi.fn(async () => fakeFile) as unknown as typeof open;
    const writer = createAsyncDiagnosticsWriter({
      openFile,
      maxQueueBytes: 1_024,
      maxBatchRecords: 1,
      maxBatchBytes: 1_024
    });
    await writer.configure("/tmp/kmux-slow-writer.log");
    writer.record(record("first"));
    await writeStarted;

    for (let sequence = 0; sequence < 100; sequence += 1) {
      writer.record(
        record(
          "terminal.data-plane.receive",
          { sequence, padding: "x".repeat(80) },
          true
        )
      );
    }
    expect(writer.queuedBytes).toBeLessThanOrEqual(1_024);

    releaseWrite();
    await writer.close();
    expect(fakeFile.close).toHaveBeenCalledOnce();
  });

  it("preserves drops that occur while an earlier drop summary is being written", async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const writes: string[] = [];
    const fakeFile = {
      chmod: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: 0 })),
      truncate: vi.fn(async () => undefined),
      write: vi.fn(async (contents: string) => {
        writes.push(contents);
        if (writes.length === 1) {
          markFirstWriteStarted();
          await firstWriteGate;
        }
        return { bytesWritten: Buffer.byteLength(contents), buffer: contents };
      }),
      close: vi.fn(async () => undefined)
    } as unknown as FileHandle;
    const writer = createAsyncDiagnosticsWriter({
      openFile: vi.fn(async () => fakeFile) as unknown as typeof open,
      maxQueueBytes: 200,
      maxBatchBytes: 1_024,
      maxBatchRecords: 256,
      flushIntervalMs: 60_000
    });
    await writer.configure("/tmp/kmux-drop-summary-race.log");

    const oversized = (sequence: number) =>
      record(
        "terminal.data-plane.receive",
        { sequence, padding: "x".repeat(400) },
        true
      );
    expect(writer.record(oversized(1))).toBe(false);
    const flushing = writer.flush();
    await firstWriteStarted;

    expect(writer.record(oversized(2))).toBe(false);
    expect(writer.record(oversized(3))).toBe(false);
    releaseFirstWrite();
    await flushing;
    await writer.close();

    const summaries = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))))
      .filter((line) => line.scope === "diagnostics.records.dropped");
    expect(summaries).toEqual([
      expect.objectContaining({ droppedTerminalTelemetry: 1 }),
      expect.objectContaining({ droppedTerminalTelemetry: 2 })
    ]);
  });

  it("does not create a timer or queue while disabled", () => {
    const setTimeoutFn = vi.fn(setTimeout);
    const writer = createAsyncDiagnosticsWriter({
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout
    });

    expect(writer.record(record("disabled"))).toBe(false);
    expect(writer.queuedBytes).toBe(0);
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(DIAGNOSTICS_WRITER_MAX_QUEUE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("contains open failures and stops accepting further records", async () => {
    const parentFile = sandboxPath();
    writeFileSync(parentFile, "not-a-directory");
    const writer = createAsyncDiagnosticsWriter();

    await expect(writer.configure(join(parentFile, "debug.log"))).resolves.toBe(
      false
    );
    expect(writer.record(record("after-failure"))).toBe(false);
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
