import { describe, expect, it, vi } from "vitest";

import { createPtyResizeCoalescer } from "./ptyResizeCoalescer";

const SETTLE_MS = 300;
const HOLD_SAFETY_MS = 1500;

function createHarness(): {
  commits: Array<[number, number]>;
  coalescer: ReturnType<typeof createPtyResizeCoalescer>;
  advance: (ms: number) => void;
} {
  let clock = 0;
  let scheduled: { at: number; fire: () => void } | null = null;
  const commits: Array<[number, number]> = [];
  const coalescer = createPtyResizeCoalescer({
    initialCols: 80,
    initialRows: 24,
    commit: (cols, rows) => {
      commits.push([cols, rows]);
    },
    settleMs: SETTLE_MS,
    holdSafetyMs: HOLD_SAFETY_MS,
    now: () => clock,
    setTimeoutFn: ((fire: () => void, delay: number) => {
      scheduled = { at: clock + delay, fire };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {
      scheduled = null;
    }) as typeof clearTimeout
  });
  const advance = (ms: number): void => {
    const target = clock + ms;
    while (scheduled && scheduled.at <= target) {
      const { at, fire } = scheduled;
      scheduled = null;
      clock = at;
      fire();
    }
    clock = target;
  };
  return { commits, coalescer, advance };
}

describe("pty resize coalescer", () => {
  it("commits an isolated width change immediately", () => {
    const { commits, coalescer } = createHarness();
    coalescer.request(120, 40);
    expect(commits).toEqual([[120, 40]]);
  });

  it("coalesces an unflagged storm into a leading and a settled commit", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(100, 24);
    advance(200);
    coalescer.request(104, 24);
    advance(200);
    coalescer.request(108, 24);
    advance(200);
    coalescer.request(112, 24);
    expect(commits).toEqual([[100, 24]]);

    advance(SETTLE_MS);
    expect(commits).toEqual([
      [100, 24],
      [112, 24]
    ]);
  });

  it("drops a pending change when the grid returns to the committed size", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(100, 24);
    advance(100);
    coalescer.request(110, 24);
    advance(100);
    coalescer.request(100, 24);
    advance(SETTLE_MS * 2);
    expect(commits).toEqual([[100, 24]]);
  });

  it("passes row-only changes through immediately", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(80, 30);
    expect(commits).toEqual([[80, 30]]);

    advance(100);
    coalescer.request(80, 40);
    expect(commits).toEqual([
      [80, 30],
      [80, 40]
    ]);
  });

  it("holds gesture requests across pauses longer than the settle window", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(100, 24, { hold: true });
    advance(SETTLE_MS * 3);
    coalescer.request(104, 24, { hold: true });
    advance(SETTLE_MS * 3);
    expect(commits).toEqual([]);

    // Gesture end: the release request commits immediately so the app
    // repaints the moment the drag is dropped.
    coalescer.request(104, 24);
    expect(commits).toEqual([[104, 24]]);
  });

  it("commits a held size through the safety timer when the release is lost", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(100, 24, { hold: true });
    advance(HOLD_SAFETY_MS);
    expect(commits).toEqual([[100, 24]]);
  });

  it("drops a held size when the grid returns to the committed size", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(100, 24, { hold: true });
    advance(200);
    coalescer.request(80, 24);
    advance(HOLD_SAFETY_MS * 2);
    expect(commits).toEqual([]);
  });

  it("does not commit again for the already committed size", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(120, 40);
    advance(SETTLE_MS * 2);
    coalescer.request(120, 40);
    advance(SETTLE_MS * 2);
    expect(commits).toEqual([[120, 40]]);
  });

  it("stops committing after dispose", () => {
    const { commits, coalescer, advance } = createHarness();
    coalescer.request(110, 24, { hold: true });
    coalescer.dispose();
    advance(HOLD_SAFETY_MS * 2);
    coalescer.request(130, 40);
    expect(commits).toEqual([]);
  });

  it("swallows commit errors from the sink wrapper", () => {
    const commit = vi.fn((_cols: number, _rows: number) => {
      throw new Error("pty exited");
    });
    // The production sink wraps pty.resize in try/catch; this guards the
    // call shape when the sink still throws.
    const coalescer = createPtyResizeCoalescer({
      initialCols: 80,
      initialRows: 24,
      commit: (cols, rows) => {
        try {
          commit(cols, rows);
        } catch {
          // mirror of the production wrapper
        }
      },
      settleMs: SETTLE_MS
    });
    coalescer.request(80, 30);
    expect(commit).toHaveBeenCalledWith(80, 30);
  });
});
