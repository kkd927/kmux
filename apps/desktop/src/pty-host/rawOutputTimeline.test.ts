import { describe, expect, it } from "vitest";

import { uint64 } from "@kmux/proto";

import { createRawOutputTimeline } from "./rawOutputTimeline";

describe("raw PTY output timeline", () => {
  it("keeps observed chunk timestamps aligned with raw-tail offsets", () => {
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
    timeline.record("redraw", {
      ptyReadAt: 300,
      outputKind: "mixed",
      visibleAtPtyRead: true,
      inputSequence: uint64(7n),
      inputKind: "keyboard-or-paste"
    });

    const snapshot = timeline.snapshot(true);
    expect(snapshot.rawOutputTail).toBe("leredraw");
    expect(snapshot.rawOutputTailTruncated).toBe(true);
    expect(snapshot.timeline).toMatchObject({
      enabled: true,
      offsetOrigin: "recording-window",
      recordingWindow: 1,
      sampleEvery: 1,
      totalChunks: uint64(3n),
      retainedChunks: 3,
      droppedChunks: 0,
      unobservedChunks: 0,
      rawTailCharStart: 7,
      rawTailCharEnd: 15
    });
    expect(snapshot.timeline.chunks.map((entry) => entry.charStart)).toEqual([
      0, 4, 9
    ]);
    expect(snapshot.progress).toEqual({
      ptyRecordingWindow: 1,
      lastAnyPtyReadAt: 300,
      lastAnyPtyChunkSequence: uint64(3n),
      lastScreenPtyReadAt: 300,
      lastScreenPtyChunkSequence: uint64(3n),
      lastTitleOnlyPtyReadAt: 200,
      lastTitleOnlyPtyChunkSequence: uint64(2n),
      lastIndeterminatePtyReadAt: null,
      lastIndeterminatePtyChunkSequence: null
    });
  });

  it("retains the raw tail without timeline bookkeeping when unobserved", () => {
    const timeline = createRawOutputTimeline();

    timeline.append("unobserved output");

    const snapshot = timeline.snapshot(false);
    expect(snapshot.rawOutputTail).toBe("unobserved output");
    expect(snapshot.timeline).toMatchObject({
      enabled: false,
      recordingWindow: 0,
      totalChunks: uint64(0n),
      retainedChunks: 0,
      droppedChunks: 0,
      unobservedChunks: 0,
      chunks: []
    });
  });

  it("starts a new recording window after unobserved output", () => {
    const timeline = createRawOutputTimeline({ maxTailChars: 32 });

    timeline.append("prefix");
    timeline.record("body", {
      ptyReadAt: 100,
      outputKind: "screen",
      visibleAtPtyRead: true
    });

    const firstWindow = timeline.snapshot(true);
    expect(firstWindow.rawOutputTail).toBe("prefixbody");
    expect(firstWindow.timeline).toMatchObject({
      recordingWindow: 1,
      totalChunks: uint64(1n),
      rawTailCharStart: -6,
      rawTailCharEnd: 4
    });
    expect(firstWindow.timeline.chunks[0]).toMatchObject({
      byteStart: 0,
      charStart: 0
    });

    timeline.append(" gap ");
    expect(timeline.snapshot(false).timeline).toMatchObject({
      recordingWindow: 1,
      totalChunks: uint64(0n),
      retainedChunks: 0
    });

    timeline.record("next", {
      ptyReadAt: 200,
      outputKind: "screen",
      visibleAtPtyRead: true
    });
    expect(timeline.snapshot(true).timeline).toMatchObject({
      recordingWindow: 2,
      totalChunks: uint64(1n)
    });
    expect(timeline.snapshot(true).progress).toMatchObject({
      ptyRecordingWindow: 2,
      lastAnyPtyChunkSequence: uint64(1n)
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
