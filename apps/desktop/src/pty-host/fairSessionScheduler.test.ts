import { describe, expect, it, vi } from "vitest";

import { FairSessionScheduler } from "./fairSessionScheduler";

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("FairSessionScheduler", () => {
  it("starts another session while a slow session slice is pending", async () => {
    const scheduled: Array<() => void> = [];
    let releaseSlow: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseSlow = () => resolve(false);
        })
    );
    const fast = vi.fn(async () => false);
    const scheduler = new FairSessionScheduler({
      schedule: (callback) => scheduled.push(callback)
    });
    scheduler.register("slow", slow);
    scheduler.register("fast", fast);

    scheduler.wake("slow");
    scheduler.wake("fast");
    scheduled.shift()?.();
    await Promise.resolve();

    expect(slow).toHaveBeenCalledOnce();
    expect(fast).toHaveBeenCalledOnce();
    releaseSlow?.();
    await Promise.resolve();
  });

  it("coalesces repeated wakes and schedules another slice when work remains", async () => {
    const scheduled: Array<() => void> = [];
    const drain = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const scheduler = new FairSessionScheduler({
      schedule: (callback) => scheduled.push(callback)
    });
    scheduler.register("session_1", drain);

    scheduler.wake("session_1");
    scheduler.wake("session_1");
    scheduled.shift()?.();
    await flushMicrotasks();
    scheduled.shift()?.();
    await flushMicrotasks();

    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("reports errors and lets the same session continue", async () => {
    const scheduled: Array<() => void> = [];
    const onDrainError = vi.fn();
    const drain = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("parse failed"))
      .mockResolvedValueOnce(false);
    const scheduler = new FairSessionScheduler({
      schedule: (callback) => scheduled.push(callback),
      onDrainError
    });
    scheduler.register("session_1", drain);

    scheduler.wake("session_1");
    scheduled.shift()?.();
    await flushMicrotasks();
    scheduled.shift()?.();
    await flushMicrotasks();

    expect(onDrainError).toHaveBeenCalledWith("session_1", expect.any(Error));
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
