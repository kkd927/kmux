import { describe, expect, it } from "vitest";

import {
  createTerminalCwdRangeSnapshotWindow,
  createTerminalCwdRangeTracker,
  type TerminalCwdRangeTrackerLineSource
} from "./terminalCwdRanges";

function lineSource(length: number): TerminalCwdRangeTrackerLineSource {
  return {
    getBufferLength: () => length
  };
}

describe("terminal cwd ranges", () => {
  it("records a contiguous cwd range for written output", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(5));

    tracker.recordWrite({ startLine: 1, endLine: 2, cwd: "/repo/a" });

    expect(tracker.snapshotRanges()).toEqual([
      { startLine: 1, endLine: 2, cwd: "/repo/a" }
    ]);
  });

  it("merges adjacent ranges with the same cwd", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(5));

    tracker.recordWrite({ startLine: 1, endLine: 2, cwd: "/repo/a" });
    tracker.recordWrite({ startLine: 3, endLine: 3, cwd: "/repo/a" });

    expect(tracker.snapshotRanges()).toEqual([
      { startLine: 1, endLine: 3, cwd: "/repo/a" }
    ]);
  });

  it("does not record missing cwd", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(5));

    tracker.recordWrite({ startLine: 1, endLine: 2, cwd: undefined });

    expect(tracker.snapshotRanges()).toEqual([]);
  });

  it("drops ranges when the buffer has no lines", () => {
    let length = 5;
    const tracker = createTerminalCwdRangeTracker({
      getBufferLength: () => length
    });

    tracker.recordWrite({ startLine: 1, endLine: 2, cwd: "/repo/a" });
    length = 0;

    expect(tracker.snapshotRanges()).toEqual([]);
  });

  it("shifts and prunes ranges when scrollback is trimmed", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(5));

    tracker.recordWrite({ startLine: 0, endLine: 1, cwd: "/repo/old" });
    tracker.recordWrite({ startLine: 3, endLine: 4, cwd: "/repo/current" });
    tracker.handleTrim(2);

    expect(tracker.getTrimmedLineCount()).toBe(2);
    expect(tracker.snapshotRanges()).toEqual([
      { startLine: 1, endLine: 2, cwd: "/repo/current" }
    ]);
  });

  it("clips snapshot ranges to the serialized window and subtracts the offset", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(20));

    tracker.recordWrite({ startLine: 2, endLine: 3, cwd: "/repo/old" });
    tracker.recordWrite({ startLine: 7, endLine: 10, cwd: "/repo/partial" });
    tracker.recordWrite({ startLine: 12, endLine: 13, cwd: "/repo/current" });

    expect(
      tracker.snapshotRanges({
        startLine: 9,
        endLine: 15,
        lineOffset: 9
      })
    ).toEqual([
      { startLine: 0, endLine: 1, cwd: "/repo/partial" },
      { startLine: 3, endLine: 4, cwd: "/repo/current" }
    ]);
  });

  it("computes the restore snapshot cwd window from live buffer coordinates", () => {
    expect(
      createTerminalCwdRangeSnapshotWindow({
        baseY: 15000,
        bufferLength: 15024,
        restoreScrollbackLines: 8000
      })
    ).toEqual({
      startLine: 7000,
      endLine: 15023,
      lineOffset: 7000
    });
  });
});
