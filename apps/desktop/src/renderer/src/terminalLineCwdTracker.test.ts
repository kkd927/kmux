import { describe, expect, it } from "vitest";

import { createTerminalLineCwdTracker } from "./terminalLineCwdTracker";

describe("terminal line cwd tracker", () => {
  it("imports snapshot cwd ranges", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.importSnapshotRanges([
      { startLine: 2, endLine: 3, cwd: "/repo/a" }
    ]);

    expect(tracker.getCwdForLine(2)).toBe("/repo/a");
    expect(tracker.getCwdForLine(3)).toBe("/repo/a");
    expect(tracker.getCwdForLine(4)).toBeUndefined();
  });

  it("replaces existing state when importing snapshot cwd ranges", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 1, endLine: 1, cwd: "/repo/live" });
    tracker.importSnapshotRanges([
      { startLine: 2, endLine: 2, cwd: "/repo/snapshot" }
    ]);

    expect(tracker.getCwdForLine(1)).toBeUndefined();
    expect(tracker.getCwdForLine(2)).toBe("/repo/snapshot");
  });

  it("records live writes over a line range", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 5, endLine: 8, cwd: "/repo/b" });

    expect(tracker.getCwdForLine(5)).toBe("/repo/b");
    expect(tracker.getCwdForLine(6)).toBe("/repo/b");
    expect(tracker.getCwdForLine(7)).toBe("/repo/b");
    expect(tracker.getCwdForLine(8)).toBe("/repo/b");
  });

  it("normalizes reversed multiline write ranges", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 4, endLine: 2, cwd: "/repo/c" });

    expect(tracker.getCwdForLine(2)).toBe("/repo/c");
    expect(tracker.getCwdForLine(3)).toBe("/repo/c");
    expect(tracker.getCwdForLine(4)).toBe("/repo/c");
  });

  it("ignores writes without cwd", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 1, endLine: 1, cwd: undefined });

    expect(tracker.getCwdForLine(1)).toBeUndefined();
  });

  it("shifts and prunes line cwd state when scrollback is trimmed", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 0, endLine: 1, cwd: "/repo/old" });
    tracker.recordWrite({ startLine: 3, endLine: 4, cwd: "/repo/current" });
    tracker.handleTrim(2);

    expect(tracker.getTrimmedLineCount()).toBe(2);
    expect(tracker.getCwdForLine(0)).toBeUndefined();
    expect(tracker.getCwdForLine(1)).toBe("/repo/current");
    expect(tracker.getCwdForLine(2)).toBe("/repo/current");
  });

  it("resets trim accounting when cleared", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.recordWrite({ startLine: 2, endLine: 2, cwd: "/repo/a" });
    tracker.handleTrim(1);
    tracker.clear();

    expect(tracker.getTrimmedLineCount()).toBe(0);
    expect(tracker.getCwdForLine(1)).toBeUndefined();
  });

  it("falls back to no cwd for invalid or unknown lines", () => {
    const tracker = createTerminalLineCwdTracker();

    tracker.importSnapshotRanges([
      { startLine: Number.NaN, endLine: Number.NaN, cwd: "/repo/a" }
    ]);
    tracker.recordWrite({
      startLine: Number.POSITIVE_INFINITY,
      endLine: 1,
      cwd: "/repo/b"
    });

    expect(tracker.getCwdForLine(Number.NaN)).toBeUndefined();
    expect(tracker.getCwdForLine(1)).toBeUndefined();
    expect(tracker.getCwdForLine(100)).toBeUndefined();
  });
});
