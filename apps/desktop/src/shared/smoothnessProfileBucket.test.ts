import { describe, expect, it, vi } from "vitest";

import { createSmoothnessProfileBucket } from "./smoothnessProfileBucket";

describe("smoothness profile bucket", () => {
  it("flushes after the configured event count", () => {
    let now = 10;
    const onFlush = vi.fn();
    const bucket = createSmoothnessProfileBucket({
      minEvents: 2,
      maxDurationMs: 1000,
      now: () => now,
      createDetails: (key, startedAt) => ({ key, startedAt, bytes: 0 }),
      onFlush
    });

    bucket.record("surface_1", (details) => {
      details.bytes += 5;
    });
    bucket.record("surface_1", (details) => {
      details.bytes += 7;
    });

    expect(onFlush).toHaveBeenCalledWith(
      { key: "surface_1", startedAt: 10, bytes: 12 },
      0,
      10
    );
  });

  it("flushes after the configured duration", () => {
    let now = 10;
    const onFlush = vi.fn();
    const bucket = createSmoothnessProfileBucket({
      minEvents: 100,
      maxDurationMs: 25,
      now: () => now,
      createDetails: (key, startedAt) => ({ key, startedAt, count: 0 }),
      onFlush
    });

    bucket.record("surface_1", (details) => {
      details.count += 1;
    });
    now = 36;
    bucket.record("surface_1", (details) => {
      details.count += 1;
    });

    expect(onFlush).toHaveBeenCalledWith(
      { key: "surface_1", startedAt: 10, count: 2 },
      26,
      36
    );
  });

  it("keeps keyed buckets isolated", () => {
    const onFlush = vi.fn();
    const bucket = createSmoothnessProfileBucket({
      minEvents: 2,
      maxDurationMs: 1000,
      now: () => 1,
      createDetails: (key, startedAt) => ({ key, startedAt, count: 0 }),
      onFlush
    });

    bucket.record("surface_1", (details) => {
      details.count += 1;
    });
    bucket.record("surface_2", (details) => {
      details.count += 1;
    });
    bucket.record("surface_1", (details) => {
      details.count += 1;
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      { key: "surface_1", startedAt: 1, count: 2 },
      0,
      1
    );
  });

  it("flushes and resets a bucket explicitly", () => {
    const onFlush = vi.fn();
    const bucket = createSmoothnessProfileBucket({
      minEvents: 100,
      maxDurationMs: 1000,
      now: () => 5,
      createDetails: (key, startedAt) => ({ key, startedAt, count: 0 }),
      onFlush
    });

    bucket.record("surface_1", (details) => {
      details.count += 1;
    });
    bucket.flush("surface_1");
    bucket.flush("surface_1");

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      { key: "surface_1", startedAt: 5, count: 1 },
      0,
      5
    );
  });
});
