import { describe, expect, it } from "vitest";

import { TerminalDeltaStore } from "./terminalDeltaStore";

interface TestDelta {
  id: string;
  fromSequence: number;
  sequence: number;
  bytes: number;
}

function createStore(
  overrides: Partial<{
    maxSessionBytes: number;
    maxSessionEvents: number;
    maxTotalBytes: number;
    maxTotalEvents: number;
  }> = {}
): TerminalDeltaStore<TestDelta> {
  return new TerminalDeltaStore({
    maxSessionBytes: overrides.maxSessionBytes ?? 20,
    maxSessionEvents: overrides.maxSessionEvents ?? 4,
    maxTotalBytes: overrides.maxTotalBytes ?? 30,
    maxTotalEvents: overrides.maxTotalEvents ?? 8,
    rangeOf: (delta) => delta,
    sizeOf: (delta) => delta.bytes
  });
}

function delta(
  id: string,
  sequence: number,
  bytes = 5,
  fromSequence = sequence - 1
): TestDelta {
  return { id, fromSequence, sequence, bytes };
}

describe("TerminalDeltaStore", () => {
  it("treats a new session at sequence zero as an empty contiguous stream", () => {
    const store = createStore();

    expect(store.replayAfter("session_new", 0)).toEqual({
      status: "ok",
      latestSequence: 0,
      deltas: []
    });
  });

  it("replays contiguous deltas after the acknowledged sequence", () => {
    const store = createStore();
    store.append("session_1", delta("one", 1));
    store.append("session_1", delta("two-three", 3, 5, 1));

    expect(store.replayAfter("session_1", 1)).toEqual({
      status: "ok",
      latestSequence: 3,
      deltas: [delta("two-three", 3, 5, 1)]
    });
    expect(store.replayAfter("session_1", 3)).toEqual({
      status: "ok",
      latestSequence: 3,
      deltas: []
    });
  });

  it("returns a bounded exact replay window without reordering zero-byte mutations", () => {
    const store = createStore({
      maxSessionBytes: 100,
      maxSessionEvents: 10,
      maxTotalBytes: 100,
      maxTotalEvents: 10
    });
    store.append("session_1", delta("resize-1", 1, 0));
    store.append("session_1", delta("large-output", 2, 6));
    store.append("session_1", delta("resize-2", 3, 0));
    store.append("session_1", delta("output", 4, 4));

    expect(
      store.replayAfter("session_1", 0, { maxBytes: 5, maxEvents: 10 })
    ).toEqual({
      status: "ok",
      latestSequence: 4,
      deltas: [delta("resize-1", 1, 0)]
    });
    expect(
      store.replayAfter("session_1", 1, { maxBytes: 5, maxEvents: 10 })
    ).toEqual({
      status: "ok",
      latestSequence: 4,
      // A first source delta larger than the window remains one item.
      deltas: [delta("large-output", 2, 6)]
    });
    expect(
      store.replayAfter("session_1", 2, { maxBytes: 4, maxEvents: 10 })
    ).toEqual({
      status: "ok",
      latestSequence: 4,
      deltas: [delta("resize-2", 3, 0), delta("output", 4, 4)]
    });
    expect(
      store.replayAfter("session_1", 2, { maxBytes: 100, maxEvents: 1 })
    ).toEqual({
      status: "ok",
      latestSequence: 4,
      deltas: [delta("resize-2", 3, 0)]
    });
  });

  it("uses wire bytes for replay windows while retaining metadata against the ring budget", () => {
    const store = new TerminalDeltaStore<TestDelta>({
      maxSessionBytes: 100,
      maxSessionEvents: 10,
      maxTotalBytes: 100,
      maxTotalEvents: 10,
      rangeOf: (value) => value,
      sizeOf: () => 40,
      replaySizeOf: (value) => value.bytes
    });
    store.append("session_1", delta("one", 1, 1));
    store.append("session_1", delta("two", 2, 1));

    expect(store.stats()).toMatchObject({ bytes: 80, events: 2 });
    expect(store.replayAfter("session_1", 0, { maxBytes: 2 })).toEqual({
      status: "ok",
      latestSequence: 2,
      deltas: [delta("one", 1, 1), delta("two", 2, 1)]
    });
  });

  it("finds a replay cursor logarithmically and copies only the requested suffix window", () => {
    let rangeReads = 0;
    const store = createStore({
      maxSessionBytes: 10_000,
      maxSessionEvents: 5_000,
      maxTotalBytes: 10_000,
      maxTotalEvents: 5_000
    });
    for (let sequence = 1; sequence <= 4_096; sequence += 1) {
      const tracked = {
        id: `delta-${sequence}`,
        sequence,
        bytes: 1
      } as TestDelta;
      Object.defineProperty(tracked, "fromSequence", {
        enumerable: true,
        get() {
          rangeReads += 1;
          return sequence - 1;
        }
      });
      store.append("session_1", tracked);
    }
    rangeReads = 0;

    const replay = store.replayAfter("session_1", 3_071, {
      maxBytes: 1,
      maxEvents: 1
    });

    expect(replay).toMatchObject({
      status: "ok",
      latestSequence: 4_096,
      deltas: [{ id: "delta-3072" }]
    });
    expect(rangeReads).toBeLessThanOrEqual(13);
  });

  it("reports a gap after the per-session byte budget evicts history", () => {
    const store = createStore({ maxSessionBytes: 10 });
    store.append("session_1", delta("one", 1, 6));
    store.append("session_1", delta("two", 2, 6));

    expect(store.replayAfter("session_1", 0)).toEqual({
      status: "gap",
      latestSequence: 2,
      retainedFromSequence: 2
    });
    expect(store.replayAfter("session_1", 1)).toMatchObject({
      status: "ok",
      latestSequence: 2
    });
  });

  it("enforces the event cap independently of the byte cap", () => {
    const store = createStore({
      maxSessionBytes: 100,
      maxSessionEvents: 2,
      maxTotalBytes: 100
    });
    store.append("session_1", delta("one", 1, 1));
    store.append("session_1", delta("two", 2, 1));
    store.append("session_1", delta("three", 3, 1));

    expect(store.replayAfter("session_1", 0)).toMatchObject({
      status: "gap",
      retainedFromSequence: 2
    });
    expect(store.stats()).toMatchObject({
      sessions: 1,
      events: 2,
      bytes: 2,
      peakSessionBytes: 2,
      peakSessionEvents: 2,
      boundViolationCount: 0
    });
    expect(store.sessionStats("session_1")).toMatchObject({
      events: 2,
      bytes: 2,
      latestSequence: 3,
      retainedFromSequence: 2
    });
    const ring = (
      store as unknown as {
        rings: Map<
          string,
          { entries: Array<unknown | undefined>; head: number }
        >;
      }
    ).rings.get("session_1");
    expect(ring?.head).toBe(1);
    expect(ring?.entries[0]).toBeUndefined();
  });

  it("evicts the globally oldest retained delta across sessions", () => {
    const store = createStore({
      maxSessionBytes: 100,
      maxSessionEvents: 10,
      maxTotalBytes: 10
    });
    store.append("session_1", delta("s1-one", 1, 6));
    store.append("session_2", delta("s2-one", 1, 6));

    expect(store.replayAfter("session_1", 0)).toMatchObject({ status: "gap" });
    expect(store.replayAfter("session_2", 0)).toMatchObject({
      status: "ok",
      deltas: [delta("s2-one", 1, 6)]
    });
    expect(store.stats()).toMatchObject({ sessions: 2, events: 1, bytes: 6 });
  });

  it("bounds zero-byte events across all sessions", () => {
    const store = createStore({
      maxSessionBytes: 100,
      maxSessionEvents: 10,
      maxTotalBytes: 100,
      maxTotalEvents: 2
    });
    store.append("session_1", delta("s1-one", 1, 0));
    store.append("session_2", delta("s2-one", 1, 0));
    store.append("session_1", delta("s1-two", 2, 0));

    expect(store.replayAfter("session_1", 0)).toMatchObject({
      status: "gap",
      retainedFromSequence: 2
    });
    expect(store.replayAfter("session_2", 0)).toMatchObject({
      status: "ok",
      deltas: [delta("s2-one", 1, 0)]
    });
    expect(store.stats()).toMatchObject({
      sessions: 2,
      events: 2,
      bytes: 0,
      maxTotalEvents: 2,
      peakTotalEvents: 2,
      boundViolationCount: 0
    });
  });

  it("keeps latest sequence but no replay data for an oversized delta", () => {
    const store = createStore({ maxSessionBytes: 8 });
    store.append("session_1", delta("oversized", 1, 9));

    expect(store.latestSequence("session_1")).toBe(1);
    expect(store.replayAfter("session_1", 0)).toEqual({
      status: "gap",
      latestSequence: 1,
      retainedFromSequence: 2
    });
    expect(store.stats()).toMatchObject({
      sessions: 1,
      events: 0,
      bytes: 0,
      oversizedDeltaCount: 1
    });
  });

  it("rejects non-contiguous committed ranges", () => {
    const store = createStore();
    store.append("session_1", delta("one", 1));

    expect(() => store.append("session_1", delta("three", 3))).toThrow(
      "non-contiguous terminal delta"
    );
  });

  it("requires resume cursors to land on a committed delta boundary", () => {
    const store = createStore();
    store.append("session_1", delta("one-through-three", 3, 5, 0));

    expect(store.replayAfter("session_1", 1)).toEqual({
      status: "gap",
      latestSequence: 3,
      retainedFromSequence: 1
    });
  });

  it("rejects a resume cursor ahead of the authoritative sequence", () => {
    const store = createStore();
    store.append("session_1", delta("one", 1));

    expect(store.replayAfter("session_1", 2)).toMatchObject({
      status: "gap",
      latestSequence: 1
    });
  });

  it("releases global accounting when a session closes", () => {
    const store = createStore();
    store.append("session_1", delta("one", 1));
    store.removeSession("session_1");

    expect(store.stats()).toMatchObject({ sessions: 0, events: 0, bytes: 0 });
    expect(store.sessionStats("session_1")).toMatchObject({
      events: 0,
      bytes: 0,
      latestSequence: 0,
      retainedFromSequence: 1
    });
  });
});
