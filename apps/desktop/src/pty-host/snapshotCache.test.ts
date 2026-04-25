import { describe, expect, it, vi } from "vitest";

import { SnapshotCache } from "./snapshotCache";

describe("SnapshotCache", () => {
  it("reuses serialized VT for unchanged sequence and dimensions", () => {
    const cache = new SnapshotCache();
    const serialize = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");

    const first = cache.get({
      sequence: 1,
      cols: 80,
      rows: 24,
      serialize
    });
    const second = cache.get({
      sequence: 1,
      cols: 80,
      rows: 24,
      serialize
    });

    expect(first).toBe("first");
    expect(second).toBe("first");
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it("serializes again when output sequence changes", () => {
    const cache = new SnapshotCache();
    const serialize = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");

    cache.get({
      sequence: 1,
      cols: 80,
      rows: 24,
      serialize
    });
    const next = cache.get({
      sequence: 2,
      cols: 80,
      rows: 24,
      serialize
    });

    expect(next).toBe("second");
    expect(serialize).toHaveBeenCalledTimes(2);
  });

  it("serializes again when terminal dimensions change", () => {
    const cache = new SnapshotCache();
    const serialize = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");

    cache.get({
      sequence: 1,
      cols: 80,
      rows: 24,
      serialize
    });
    const next = cache.get({
      sequence: 1,
      cols: 120,
      rows: 40,
      serialize
    });

    expect(next).toBe("second");
    expect(serialize).toHaveBeenCalledTimes(2);
  });
});
