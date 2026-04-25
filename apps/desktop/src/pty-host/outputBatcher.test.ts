import { afterEach, describe, expect, it, vi } from "vitest";

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
});
