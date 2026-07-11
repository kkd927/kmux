import { describe, expect, it, vi } from "vitest";

import { SessionMutationQueue } from "./sessionMutationQueue";

function createQueue(
  applyOutputRun: (outputs: string[]) => Promise<void> | void,
  overrides: Partial<{
    maxOutputRunBytes: number;
    highWatermarkBytes: number;
    lowWatermarkBytes: number;
    onHighWatermark: () => void;
    onLowWatermark: () => void;
  }> = {}
): SessionMutationQueue<string> {
  return new SessionMutationQueue({
    maxOutputRunBytes: overrides.maxOutputRunBytes ?? 8,
    highWatermarkBytes: overrides.highWatermarkBytes ?? 16,
    lowWatermarkBytes: overrides.lowWatermarkBytes ?? 4,
    applyOutputRun,
    onHighWatermark: overrides.onHighWatermark,
    onLowWatermark: overrides.onLowWatermark
  });
}

describe("SessionMutationQueue", () => {
  it("coalesces bounded output runs without crossing a barrier", async () => {
    const order: string[] = [];
    const queue = createQueue(async (outputs) => {
      order.push(`output:${outputs.join("")}`);
    });
    queue.enqueueOutput({ value: "aa", bytes: 2 });
    queue.enqueueOutput({ value: "bbbb", bytes: 4 });
    queue.enqueueOutput({ value: "cccc", bytes: 4 });
    queue.enqueueBarrier(() => {
      order.push("resize");
    });
    queue.enqueueOutput({ value: "dd", bytes: 2 });

    expect(await queue.drainSlice()).toBe(true);
    expect(await queue.drainSlice()).toBe(true);
    expect(await queue.drainSlice()).toBe(true);
    expect(await queue.drainSlice()).toBe(false);

    expect(order).toEqual([
      "output:aabbbb",
      "output:cccc",
      "resize",
      "output:dd"
    ]);
  });

  it("keeps in-flight bytes under backpressure until parsing finishes", async () => {
    let release: (() => void) | undefined;
    const onHighWatermark = vi.fn();
    const onLowWatermark = vi.fn();
    const queue = createQueue(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      {
        maxOutputRunBytes: 32,
        highWatermarkBytes: 8,
        lowWatermarkBytes: 2,
        onHighWatermark,
        onLowWatermark
      }
    );
    queue.enqueueOutput({ value: "12345678", bytes: 8 });

    const draining = queue.drainSlice();
    await Promise.resolve();
    const internalQueue = queue as unknown as {
      mutations: Array<unknown | undefined>;
      head: number;
    };
    expect(internalQueue.head).toBe(1);
    expect(internalQueue.mutations[0]).toBeUndefined();
    expect(queue.pendingOutputBytes).toBe(8);
    expect(queue.stats()).toEqual({
      highWatermarkBytes: 8,
      lowWatermarkBytes: 2,
      pendingMutations: 0,
      queuedOutputBytes: 0,
      inFlightOutputBytes: 8,
      pendingOutputBytes: 8,
      peakPendingOutputBytes: 8,
      highWatermarkActive: true,
      highWatermarkCrossings: 1
    });
    expect(onHighWatermark).toHaveBeenCalledOnce();
    expect(onLowWatermark).not.toHaveBeenCalled();

    release?.();
    await draining;
    expect(queue.pendingOutputBytes).toBe(0);
    expect(queue.stats()).toMatchObject({
      pendingMutations: 0,
      pendingOutputBytes: 0,
      peakPendingOutputBytes: 8,
      highWatermarkActive: false
    });
    expect(onLowWatermark).toHaveBeenCalledOnce();
  });

  it("releases byte accounting when output parsing fails", async () => {
    const queue = createQueue(async () => {
      throw new Error("parse failed");
    });
    queue.enqueueOutput({ value: "abcd", bytes: 4 });

    await expect(queue.drainSlice()).rejects.toThrow("parse failed");
    expect(queue.pendingOutputBytes).toBe(0);
  });

  it("rejects a source segment that could bypass the parser slice", () => {
    const applyOutputRun = vi.fn();
    const queue = createQueue(applyOutputRun);

    expect(() =>
      queue.enqueueOutput({ value: "oversized", bytes: 64 })
    ).toThrow("session output mutation exceeds 8 bytes");
    expect(applyOutputRun).not.toHaveBeenCalled();
    expect(queue.pendingOutputBytes).toBe(0);
  });

  it("orders output, resize, later output, and snapshot at one sequence boundary", async () => {
    let sequence = 0;
    let transcript = "";
    let cols = 80;
    let rows = 24;
    let captured:
      | { sequence: number; transcript: string; cols: number; rows: number }
      | undefined;
    const queue = createQueue((outputs) => {
      for (const output of outputs) {
        transcript += output;
        sequence += 1;
      }
    });
    queue.enqueueOutput({ value: "A", bytes: 1 });
    queue.enqueueBarrier(() => {
      cols = 120;
      rows = 40;
      sequence += 1;
    });
    queue.enqueueOutput({ value: "B", bytes: 1 });
    queue.enqueueBarrier(() => {
      captured = { sequence, transcript, cols, rows };
    });

    while (await queue.drainSlice()) {
      // Drain one fair slice at a time until the snapshot barrier commits.
    }

    expect(captured).toEqual({
      sequence: 3,
      transcript: "AB",
      cols: 120,
      rows: 40
    });
  });
});
