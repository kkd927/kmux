import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LINUX_SHUTDOWN_TIMEOUT_MS,
  settleShutdownTasks
} from "./shutdownTasks";

describe("Linux shutdown tasks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts every stop task and reports failures without blocking peers", async () => {
    const first = vi.fn(async () => {
      throw new Error("socket failed");
    });
    const second = vi.fn(async () => undefined);

    const outcome = await settleShutdownTasks([
      { name: "socket", stop: first },
      { name: "pty", stop: second }
    ]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(outcome.failures).toEqual([
      {
        name: "socket",
        error: expect.objectContaining({ message: "socket failed" })
      }
    ]);
    expect(outcome.timedOut).toEqual([]);
  });

  it("returns at the common 20 second deadline with the unfinished targets", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(() => new Promise<void>(() => {}));
    const failed = vi.fn(async () => {
      throw new Error("remote failed");
    });
    const completed = vi.fn(async () => undefined);

    const outcomePromise = settleShutdownTasks([
      { name: "pty", stop: hanging },
      { name: "remote", stop: failed },
      { name: "socket", stop: completed }
    ]);
    await Promise.resolve();

    expect(hanging).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LINUX_SHUTDOWN_TIMEOUT_MS);
    const outcome = await outcomePromise;

    expect(outcome.failures).toEqual([
      {
        name: "remote",
        error: expect.objectContaining({ message: "remote failed" })
      }
    ]);
    expect(outcome.timedOut).toEqual(["pty"]);
  });
});
