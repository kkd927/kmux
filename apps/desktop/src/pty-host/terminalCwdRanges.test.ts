import { describe, expect, it } from "vitest";
import {
  TERMINAL_DATA_PLANE_MAX_CWD_RANGES,
  TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  validateTerminalDataPlaneHostMessage
} from "@kmux/proto";

import {
  createTerminalCwdRangeSnapshotWindow,
  createTerminalCwdRangeTracker,
  TERMINAL_CWD_RANGE_MAX_RETAINED_BYTES,
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

  it("ignores over-limit UTF-8 cwd metadata", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(1));
    const valid = "한".repeat(
      Math.floor(TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES / 3)
    );
    const oversized = `${valid}한`;

    tracker.recordWrite({ startLine: 0, endLine: 0, cwd: valid });
    tracker.recordWrite({ startLine: 0, endLine: 0, cwd: oversized });

    expect(tracker.snapshotRanges()).toEqual([
      { startLine: 0, endLine: 0, cwd: valid }
    ]);
  });

  it("keeps the newest protocol-bounded range count on one alternating line", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(1));
    for (
      let index = 0;
      index <= TERMINAL_DATA_PLANE_MAX_CWD_RANGES;
      index += 1
    ) {
      tracker.recordWrite({
        startLine: 0,
        endLine: 0,
        cwd: `/cwd/${index}`
      });
    }

    const ranges = tracker.snapshotRanges();
    expect(ranges).toHaveLength(TERMINAL_DATA_PLANE_MAX_CWD_RANGES);
    expect(ranges[0]?.cwd).toBe("/cwd/1");
    expect(ranges.at(-1)?.cwd).toBe(
      `/cwd/${TERMINAL_DATA_PLANE_MAX_CWD_RANGES}`
    );
    expect(
      validateTerminalDataPlaneHostMessage({
        protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
        attachId: "attach_1",
        session: {
          surfaceId: "surface_1",
          sessionId: "session_1",
          epoch: "epoch_1"
        },
        type: "attached",
        mode: "checkpoint",
        checkpoint: {
          format: "xterm-vt/1",
          session: {
            surfaceId: "surface_1",
            sessionId: "session_1",
            epoch: "epoch_1"
          },
          sequence: 1,
          data: "",
          cols: 80,
          rows: 24,
          cwdRanges: ranges
        }
      })
    ).toMatchObject({ ok: true });
  });

  it("evicts oldest ranges when retained cwd bytes reach the internal budget", () => {
    const tracker = createTerminalCwdRangeTracker(lineSource(1));
    const cwdBytes = TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES;
    const base = `/${"a".repeat(cwdBytes - 2)}`;
    const first = `${base}0`;
    const second = `${base}1`;
    const retainedRangeLimit = TERMINAL_CWD_RANGE_MAX_RETAINED_BYTES / cwdBytes;
    for (let index = 0; index <= retainedRangeLimit; index += 1) {
      tracker.recordWrite({
        startLine: 0,
        endLine: 0,
        cwd: index % 2 === 0 ? first : second
      });
    }

    const ranges = tracker.snapshotRanges();
    expect(ranges).toHaveLength(retainedRangeLimit);
    expect(ranges[0]?.cwd).toBe(second);
    expect(
      ranges.reduce(
        (bytes, range) => bytes + Buffer.byteLength(range.cwd, "utf8"),
        0
      )
    ).toBeLessThanOrEqual(TERMINAL_CWD_RANGE_MAX_RETAINED_BYTES);
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
