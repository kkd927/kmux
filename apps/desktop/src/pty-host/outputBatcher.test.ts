import { afterEach, describe, expect, it, vi } from "vitest";

import type { SurfaceChunkPayload } from "@kmux/proto";
import { OutputBatcher } from "./outputBatcher";

describe("OutputBatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces chunks until the flush timer fires", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new OutputBatcher({
      flushMs: 8,
      maxBatchBytes: 64 * 1024,
      onFlush
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "hello "
    });
    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 2,
      chunk: "world"
    });

    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
      fromSequence: 1,
      sequence: 2,
      segments: [
        {
          sequence: 1,
          length: 6
        },
        {
          sequence: 2,
          length: 5
        }
      ],
      chunk: "hello world"
    });
  });

  it("flushes immediately when the byte cap is reached", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new OutputBatcher({
      flushMs: 8,
      maxBatchBytes: 5,
      onFlush
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "123"
    });
    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 2,
      chunk: "45"
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
      fromSequence: 1,
      sequence: 2,
      segments: [
        {
          sequence: 1,
          length: 3
        },
        {
          sequence: 2,
          length: 2
        }
      ],
      chunk: "12345"
    });
  });

  it("flushes a pending batch explicitly", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new OutputBatcher({
      flushMs: 8,
      maxBatchBytes: 64 * 1024,
      onFlush
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "pending"
    });

    batcher.flush("session_1");

    expect(onFlush).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
      fromSequence: 1,
      sequence: 1,
      segments: [
        {
          sequence: 1,
          length: 7
        }
      ],
      chunk: "pending"
    });
  });

  it("preserves cwd for each coalesced segment with the same cwd", () => {
    const flushed: SurfaceChunkPayload[] = [];
    const batcher = new OutputBatcher({
      flushMs: 1000,
      maxBatchBytes: 1024,
      onFlush: (payload) => flushed.push(payload)
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "src/App",
      cwd: "/repo/a"
    });
    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 2,
      chunk: ".tsx\n",
      cwd: "/repo/a"
    });
    batcher.flush("session_1");

    expect(flushed[0]).toMatchObject({
      cwd: "/repo/a",
      segments: [
        { sequence: 1, length: "src/App".length, cwd: "/repo/a" },
        { sequence: 2, length: ".tsx\n".length, cwd: "/repo/a" }
      ]
    });
  });

  it("flushes before coalescing output from a different cwd", () => {
    vi.useFakeTimers();
    const flushed: SurfaceChunkPayload[] = [];
    const batcher = new OutputBatcher({
      flushMs: 1000,
      maxBatchBytes: 1024,
      onFlush: (payload) => flushed.push(payload)
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "src/a.ts\n",
      cwd: "/repo/a"
    });
    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 2,
      chunk: "src/b.ts\n",
      cwd: "/repo/b"
    });

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      cwd: "/repo/a",
      segments: [{ sequence: 1, length: "src/a.ts\n".length, cwd: "/repo/a" }],
      chunk: "src/a.ts\n"
    });

    batcher.flush("session_1");
    expect(flushed[1]).toMatchObject({
      cwd: "/repo/b",
      segments: [{ sequence: 2, length: "src/b.ts\n".length, cwd: "/repo/b" }],
      chunk: "src/b.ts\n"
    });
  });

  it("clears pending batches without flushing", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new OutputBatcher({
      flushMs: 8,
      maxBatchBytes: 64 * 1024,
      onFlush
    });

    batcher.push({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: 1,
      chunk: "pending"
    });

    batcher.clearAll();
    vi.advanceTimersByTime(8);

    expect(onFlush).not.toHaveBeenCalled();
  });
});
