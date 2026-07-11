import { describe, expect, it, vi } from "vitest";

import { createVisibleTerminalWriteScheduler } from "./visibleTerminalWriteScheduler";

class SchedulerClock {
  nowMs = 0;
  private nextId = 1;
  private readonly frames = new Map<number, (timestamp: number) => void>();
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  requestAnimationFrame = vi.fn(
    (callback: (timestamp: number) => void): number => {
      const id = this.nextId++;
      this.frames.set(id, callback);
      return id;
    }
  );

  cancelAnimationFrame = vi.fn((id: number): void => {
    this.frames.delete(id);
  });

  setTimeout = vi.fn(
    (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
      const id = this.nextId++;
      this.timers.set(id, { callback, dueAt: this.nowMs + delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
  );

  clearTimeout = vi.fn((handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  });

  now = (): number => this.nowMs;

  runFrame(elapsedMs = 16): void {
    this.nowMs += elapsedMs;
    const entry = this.frames.entries().next().value;
    if (!entry) {
      throw new Error("no animation frame queued");
    }
    const [id, callback] = entry;
    this.frames.delete(id);
    callback(this.nowMs);
  }

  advanceTimersBy(elapsedMs: number): void {
    this.nowMs += elapsedMs;
    while (true) {
      const dueTimer = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.nowMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!dueTimer) {
        return;
      }
      const [id, timer] = dueTimer;
      this.timers.delete(id);
      timer.callback();
    }
  }

  runAllFrames(): void {
    while (this.frames.size > 0) {
      this.runFrame();
    }
  }
}

function createHarness(
  overrides: {
    frameChunkChars?: number;
    catchUpPendingChars?: number;
    maxPresentationLagMs?: number;
    inputImmediateMs?: number;
  } = {}
) {
  const clock = new SchedulerClock();
  const writes: string[] = [];
  const scheduler = createVisibleTerminalWriteScheduler({
    write: (data) => writes.push(data),
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    now: clock.now,
    frameChunkChars: overrides.frameChunkChars ?? 4,
    catchUpPendingChars: overrides.catchUpPendingChars ?? 32,
    maxPresentationLagMs: overrides.maxPresentationLagMs ?? 32,
    inputImmediateMs: overrides.inputImmediateMs ?? 100
  });
  return { clock, scheduler, writes };
}

describe("visible terminal write scheduler", () => {
  it("writes the first idle append immediately and paces later appends in order", () => {
    const { clock, scheduler, writes } = createHarness();

    scheduler.writePlain("first");
    scheduler.writePlain("ab");
    scheduler.writePlain("cd");
    scheduler.writePlain("ef");

    expect(writes).toEqual(["first"]);
    clock.runFrame();
    expect(writes).toEqual(["first", "abcd"]);
    clock.runFrame();
    expect(writes).toEqual(["first", "abcd", "ef"]);

    scheduler.writePlain("idle-again");
    expect(writes).toEqual(["first", "abcd", "ef", "idle-again"]);
  });

  it("never splits a Unicode surrogate pair at a paced frame boundary", () => {
    const { clock, scheduler, writes } = createHarness({
      frameChunkChars: 4
    });

    scheduler.writePlain("seed");
    scheduler.writePlain("ab😀cd");
    clock.runFrame();
    clock.runFrame();

    expect(writes).toEqual(["seed", "ab😀", "cd"]);
    expect(writes.join("")).toBe("seedab😀cd");
    expect(writes.every(hasNoUnpairedSurrogates)).toBe(true);
  });

  it("flushes pending plain output before an immediate control or TUI write", () => {
    const { clock, scheduler, writes } = createHarness();

    scheduler.writePlain("plain-1");
    scheduler.writePlain("plain-2");
    scheduler.writeImmediate("\u001b[2Jcontrol");

    expect(writes).toEqual(["plain-1", "plain-2", "\u001b[2Jcontrol"]);
    clock.runAllFrames();
    expect(writes).toEqual(["plain-1", "plain-2", "\u001b[2Jcontrol"]);
  });

  it("flushes on input and keeps subsequent writes immediate for 100ms", () => {
    const { clock, scheduler, writes } = createHarness();

    scheduler.writePlain("before");
    scheduler.writePlain("queued");
    scheduler.notifyInput();
    scheduler.writePlain("echo");
    scheduler.writePlain("response");

    expect(writes).toEqual(["before", "queued", "echo", "response"]);

    clock.advanceTimersBy(100);
    scheduler.writePlain("next-burst");
    scheduler.writePlain("paced-again");
    expect(writes).toEqual([
      "before",
      "queued",
      "echo",
      "response",
      "next-burst"
    ]);
    clock.runAllFrames();
    expect(writes.slice(-2).join("")).toBe("paced-again");
  });

  it("catches up immediately when the pending character budget is exceeded", () => {
    const { clock, scheduler, writes } = createHarness({
      catchUpPendingChars: 8
    });

    scheduler.writePlain("seed");
    scheduler.writePlain("1234");
    scheduler.writePlain("56789");

    expect(writes).toEqual(["seed", "123456789"]);
    clock.runAllFrames();
    expect(writes).toEqual(["seed", "123456789"]);
  });

  it("catches up after the oldest pending append waits 32ms", () => {
    const { clock, scheduler, writes } = createHarness();

    scheduler.writePlain("seed");
    scheduler.writePlain("waiting");
    clock.advanceTimersBy(32);

    expect(writes).toEqual(["seed", "waiting"]);
    clock.runAllFrames();
    expect(writes).toEqual(["seed", "waiting"]);
  });

  it("reports writer failures raised later from a paced frame", () => {
    const clock = new SchedulerClock();
    const onWriteError = vi.fn();
    let writeCount = 0;
    const scheduler = createVisibleTerminalWriteScheduler({
      write() {
        writeCount += 1;
        if (writeCount === 2) {
          throw new Error("xterm disposed");
        }
      },
      onWriteError,
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      now: clock.now,
      frameChunkChars: 4
    });

    scheduler.writePlain("seed");
    scheduler.writePlain("paced");

    expect(() => clock.runFrame()).not.toThrow();
    expect(onWriteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "xterm disposed" })
    );
  });

  it("drops pending output and cancels callbacks on dispose", () => {
    const { clock, scheduler, writes } = createHarness();

    scheduler.writePlain("written");
    scheduler.writePlain("drop-me");
    scheduler.dispose();
    scheduler.writePlain("ignored");
    scheduler.writeImmediate("also-ignored");
    scheduler.notifyInput();
    clock.runAllFrames();
    clock.advanceTimersBy(100);

    expect(writes).toEqual(["written"]);
    expect(clock.cancelAnimationFrame).toHaveBeenCalled();
    expect(clock.clearTimeout).toHaveBeenCalled();
  });
});

function hasNoUnpairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
