import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createUpdateInstallWatchdog,
  UPDATE_INSTALL_EXIT_TIMEOUT_MS
} from "./updateInstallWatchdog";

describe("update install exit watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-exits once after the shutdown deadline has had time to report", () => {
    const exit = vi.fn();
    const onTimeout = vi.fn();
    const watchdog = createUpdateInstallWatchdog({ exit, onTimeout });

    watchdog.arm();
    watchdog.arm();
    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledWith(UPDATE_INSTALL_EXIT_TIMEOUT_MS);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("can be disarmed during install recovery and armed for a retry", () => {
    const exit = vi.fn();
    const watchdog = createUpdateInstallWatchdog({
      exit,
      onTimeout: vi.fn()
    });

    watchdog.arm();
    watchdog.disarm();
    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS);
    expect(exit).not.toHaveBeenCalled();

    watchdog.arm();
    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("force-exits even when timeout diagnostics fail", () => {
    const exit = vi.fn();
    const watchdog = createUpdateInstallWatchdog({
      exit,
      onTimeout: () => {
        throw new Error("diagnostics unavailable");
      }
    });

    watchdog.arm();
    expect(() =>
      vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS)
    ).toThrow("diagnostics unavailable");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
