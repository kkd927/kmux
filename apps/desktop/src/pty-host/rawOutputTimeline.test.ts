import { describe, expect, it } from "vitest";

import { uint64 } from "@kmux/proto";

import { createRawOutputTimeline } from "./rawOutputTimeline";

describe("raw PTY output timeline", () => {
  it("keeps unsampled chunk timestamps aligned with absolute raw-tail offsets", () => {
    const timeline = createRawOutputTimeline({ maxChunks: 3, maxTailChars: 8 });

    timeline.record("body", {
      ptyReadAt: 100,
      outputKind: "screen",
      visibleAtPtyRead: true
    });
    timeline.record("title", {
      ptyReadAt: 200,
      outputKind: "osc-title-only",
      visibleAtPtyRead: true
    });
    timeline.record("x");
    timeline.record("redraw", {
      ptyReadAt: 300,
      outputKind: "mixed",
      visibleAtPtyRead: true,
      inputSequence: uint64(7n),
      inputKind: "keyboard-or-paste"
    });

    const snapshot = timeline.snapshot(true);
    expect(snapshot.rawOutputTail).toBe("exredraw");
    expect(snapshot.rawOutputTailTruncated).toBe(true);
    expect(snapshot.timeline).toMatchObject({
      enabled: true,
      sampleEvery: 1,
      totalChunks: uint64(4n),
      retainedChunks: 3,
      droppedChunks: 0,
      unobservedChunks: 1,
      rawTailCharStart: 8,
      rawTailCharEnd: 16
    });
    expect(snapshot.timeline.chunks.map((entry) => entry.charStart)).toEqual([
      0, 4, 10
    ]);
    expect(snapshot.progress).toEqual({
      lastAnyPtyReadAt: 300,
      lastAnyPtyChunkSequence: uint64(4n),
      lastScreenPtyReadAt: 300,
      lastScreenPtyChunkSequence: uint64(4n),
      lastTitleOnlyPtyReadAt: 200,
      lastTitleOnlyPtyChunkSequence: uint64(2n),
      lastIndeterminatePtyReadAt: null,
      lastIndeterminatePtyChunkSequence: null
    });
  });

  it("reports overwritten metadata instead of silently losing timeline entries", () => {
    const timeline = createRawOutputTimeline({ maxChunks: 2 });
    for (let index = 1; index <= 3; index += 1) {
      timeline.record(String(index), {
        ptyReadAt: index,
        outputKind: "screen",
        visibleAtPtyRead: false
      });
    }

    const snapshot = timeline.snapshot(true);
    expect(snapshot.timeline.droppedChunks).toBe(1);
    expect(
      snapshot.timeline.chunks.map((entry) => entry.chunkSequence)
    ).toEqual([uint64(2n), uint64(3n)]);
  });
});
