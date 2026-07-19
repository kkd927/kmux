import { describe, expect, it, vi } from "vitest";
import { uint64, type Uint64 } from "@kmux/proto";

import { createTerminalCwdRangeSnapshotWindow } from "./terminalCwdRanges";
import {
  materializeBoundedTerminalSnapshot,
  SnapshotCache,
  TerminalCheckpointTooLargeError
} from "./snapshotCache";

function cacheRequest(
  serialize: (scrollbackLines: number) => string,
  overrides: Partial<{
    sequence: Uint64;
    cols: number;
    rows: number;
    requestedScrollbackLines: number;
    maxBytes: number;
  }> = {}
) {
  return {
    sequence: overrides.sequence ?? uint64(1n),
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    requestedScrollbackLines: overrides.requestedScrollbackLines ?? 8_000,
    maxBytes: overrides.maxBytes ?? 1_000,
    serialize
  };
}

describe("SnapshotCache", () => {
  it("reuses the VT and selected scrollback window for unchanged state", () => {
    const cache = new SnapshotCache();
    const serialize = vi.fn((_scrollbackLines: number) => "first");

    const first = cache.get(cacheRequest(serialize));
    const second = cache.get(cacheRequest(serialize));

    expect(first).toEqual({ vt: "first", scrollbackLines: 8_000 });
    expect(second).toEqual(first);
    expect(serialize).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledWith(8_000);
  });

  it("invalidates on sequence, dimensions, or an explicit mutation release", () => {
    const cache = new SnapshotCache();
    const serialize = vi
      .fn<(scrollbackLines: number) => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("sequence")
      .mockReturnValueOnce("dimensions")
      .mockReturnValueOnce("released");

    cache.get(cacheRequest(serialize));
    expect(cache.get(cacheRequest(serialize, { sequence: uint64(2n) })).vt).toBe(
      "sequence"
    );
    expect(
      cache.get(
        cacheRequest(serialize, { sequence: uint64(2n), cols: 120 })
      ).vt
    ).toBe("dimensions");
    cache.invalidate();
    expect(
      cache.get(
        cacheRequest(serialize, { sequence: uint64(2n), cols: 120 })
      ).vt
    ).toBe("released");
    expect(serialize).toHaveBeenCalledTimes(4);
  });

  it("measures UTF-8 bytes rather than JavaScript string length", () => {
    const serialize = vi.fn((scrollbackLines: number) =>
      scrollbackLines === 0 ? "한" : `한${"x".repeat(scrollbackLines)}`
    );

    const materialization = materializeBoundedTerminalSnapshot({
      requestedScrollbackLines: 2,
      maxBytes: 4,
      serialize
    });

    expect(materialization).toEqual({ vt: "한", scrollbackLines: 0 });
    expect(Buffer.byteLength(materialization.vt, "utf8")).toBe(3);
    expect(serialize.mock.calls.map(([lines]) => lines)).toEqual([2, 0]);
  });

  it("uses a conservative ratio window, caches it, and aligns cwd coordinates", () => {
    const cache = new SnapshotCache();
    const serialize = vi.fn((scrollbackLines: number) =>
      "x".repeat(20 + scrollbackLines)
    );
    const request = cacheRequest(serialize, { maxBytes: 1_000 });

    const first = cache.get(request);
    const second = cache.get(request);

    expect(first.scrollbackLines).toBeGreaterThan(0);
    expect(first.scrollbackLines).toBeLessThan(8_000);
    expect(Buffer.byteLength(first.vt, "utf8")).toBeLessThanOrEqual(1_000);
    expect(second).toEqual(first);
    expect(serialize.mock.calls.map(([lines]) => lines)).toEqual([
      8_000,
      0,
      first.scrollbackLines
    ]);
    expect(
      createTerminalCwdRangeSnapshotWindow({
        baseY: 15_000,
        bufferLength: 15_024,
        restoreScrollbackLines: first.scrollbackLines
      })
    ).toEqual({
      startLine: 15_000 - first.scrollbackLines,
      endLine: 15_023,
      lineOffset: 15_000 - first.scrollbackLines
    });
  });

  it("falls back to screen-only after a bounded number of nonlinear corrections", () => {
    const serialize = vi.fn((scrollbackLines: number) =>
      "x".repeat(scrollbackLines === 0 ? 10 : 200)
    );

    const materialization = materializeBoundedTerminalSnapshot({
      requestedScrollbackLines: 8_000,
      maxBytes: 100,
      serialize
    });

    expect(materialization).toEqual({ vt: "x".repeat(10), scrollbackLines: 0 });
    expect(serialize.mock.calls[0]?.[0]).toBe(8_000);
    expect(serialize.mock.calls[1]?.[0]).toBe(0);
    expect(serialize).toHaveBeenCalledTimes(5);
  });

  it("throws a bounded non-recoverable error when screen-only is oversized", () => {
    const serialize = vi.fn((_scrollbackLines: number) => "한한");

    expect(() =>
      materializeBoundedTerminalSnapshot({
        requestedScrollbackLines: 8_000,
        maxBytes: 4,
        serialize
      })
    ).toThrow(TerminalCheckpointTooLargeError);
    expect(serialize.mock.calls.map(([lines]) => lines)).toEqual([8_000, 0]);
  });
});
