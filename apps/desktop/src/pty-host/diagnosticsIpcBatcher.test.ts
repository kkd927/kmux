import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticsRecord } from "../shared/diagnostics";
import { createPtyDiagnosticsIpcBatcher } from "./diagnosticsIpcBatcher";

function record(index: number): DiagnosticsRecord {
  return {
    at: "2026-07-15T00:00:00.000Z",
    pid: 12,
    scope: "pty-host.test",
    details: { index },
    terminalTelemetry: false
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pty-host diagnostics IPC batcher", () => {
  it("sends at most 256 ordered records in a batch", () => {
    const sendBatch = vi.fn((_records: DiagnosticsRecord[]) => true);
    const batcher = createPtyDiagnosticsIpcBatcher({
      enabled: true,
      sendBatch
    });

    for (let index = 0; index < 257; index += 1) {
      expect(batcher.record(record(index))).toBe(true);
    }
    batcher.flush();

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(256);
    expect(
      sendBatch.mock.calls[0]?.[0].map((entry) => entry.details.index)
    ).toEqual(Array.from({ length: 256 }, (_, index) => index));
    expect(sendBatch.mock.calls[1]?.[0]).toEqual([record(256)]);
  });

  it("flushes after 200ms and before disabling or closing", () => {
    vi.useFakeTimers();
    const sendBatch = vi.fn((_records: DiagnosticsRecord[]) => true);
    const batcher = createPtyDiagnosticsIpcBatcher({
      enabled: true,
      sendBatch
    });

    batcher.record(record(1));
    vi.advanceTimersByTime(199);
    expect(sendBatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendBatch).toHaveBeenLastCalledWith([record(1)]);

    batcher.record(record(2));
    batcher.configure(false);
    expect(sendBatch).toHaveBeenLastCalledWith([record(2)]);
    expect(batcher.record(record(3))).toBe(false);

    batcher.configure(true);
    batcher.record(record(4));
    batcher.close();
    expect(sendBatch).toHaveBeenLastCalledWith([record(4)]);
    expect(batcher.enabled).toBe(false);
  });

  it("creates no timer or IPC batch while disabled", () => {
    const setTimeoutFn = vi.fn(setTimeout);
    const sendBatch = vi.fn((_records: DiagnosticsRecord[]) => true);
    const batcher = createPtyDiagnosticsIpcBatcher({
      enabled: false,
      sendBatch,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout
    });

    expect(batcher.record(record(1))).toBe(false);
    batcher.flush();
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
