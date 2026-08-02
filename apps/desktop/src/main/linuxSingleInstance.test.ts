import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireLinuxSingleInstanceLock,
  KMUX_UPDATE_RELAUNCH_PARENT_PID,
  prepareUpdateRelaunchEnvironment,
  UPDATE_RELAUNCH_PARENT_TIMEOUT_MS
} from "./linuxSingleInstance";

describe("packaged Linux single-instance handoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not apply a lock to unpackaged or non-Linux runtimes", async () => {
    const requestLock = vi.fn(() => true);

    await expect(
      acquireLinuxSingleInstanceLock({
        platform: "linux",
        isPackaged: false,
        env: {},
        requestLock
      })
    ).resolves.toEqual({ status: "not-required" });
    await expect(
      acquireLinuxSingleInstanceLock({
        platform: "darwin",
        isPackaged: true,
        env: {},
        requestLock
      })
    ).resolves.toEqual({ status: "not-required" });
    expect(requestLock).not.toHaveBeenCalled();
  });

  it("acquires the lock immediately for a normal packaged launch", async () => {
    const requestLock = vi.fn(() => true);

    await expect(
      acquireLinuxSingleInstanceLock({
        platform: "linux",
        isPackaged: true,
        env: {},
        requestLock
      })
    ).resolves.toEqual({ status: "acquired" });
    expect(requestLock).toHaveBeenCalledTimes(1);
  });

  it("prepares the parent handoff synchronously and restores the prior environment", () => {
    const env = { [KMUX_UPDATE_RELAUNCH_PARENT_PID]: "1111" };

    const prepared = prepareUpdateRelaunchEnvironment(env, 4242);

    expect(env[KMUX_UPDATE_RELAUNCH_PARENT_PID]).toBe("4242");
    prepared.restore();
    prepared.restore();
    expect(env[KMUX_UPDATE_RELAUNCH_PARENT_PID]).toBe("1111");
  });

  it("removes a newly prepared parent handoff when installation is rejected", () => {
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareUpdateRelaunchEnvironment(env, 4242);
    prepared.restore();

    expect(env).not.toHaveProperty(KMUX_UPDATE_RELAUNCH_PARENT_PID);
  });

  it("waits for the update parent to exit before requesting the lock", async () => {
    vi.useFakeTimers();
    let parentRunning = true;
    const requestLock = vi.fn(() => true);
    const env = { [KMUX_UPDATE_RELAUNCH_PARENT_PID]: "4242" };

    const resultPromise = acquireLinuxSingleInstanceLock({
      platform: "linux",
      isPackaged: true,
      env,
      currentPid: 5000,
      requestLock,
      isProcessRunning: () => parentRunning
    });
    await Promise.resolve();
    expect(requestLock).not.toHaveBeenCalled();

    parentRunning = false;
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      status: "acquired",
      parentPid: 4242
    });
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(env).not.toHaveProperty(KMUX_UPDATE_RELAUNCH_PARENT_PID);
  });

  it("does not request the lock when the update parent misses the deadline", async () => {
    vi.useFakeTimers();
    const requestLock = vi.fn(() => true);

    const resultPromise = acquireLinuxSingleInstanceLock({
      platform: "linux",
      isPackaged: true,
      env: { [KMUX_UPDATE_RELAUNCH_PARENT_PID]: "4242" },
      currentPid: 5000,
      requestLock,
      isProcessRunning: () => true
    });
    await vi.advanceTimersByTimeAsync(UPDATE_RELAUNCH_PARENT_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      status: "parent-timeout",
      parentPid: 4242
    });
    expect(requestLock).not.toHaveBeenCalled();
  });

  it("reports lock denial after a completed update handoff", async () => {
    const requestLock = vi.fn(() => false);

    await expect(
      acquireLinuxSingleInstanceLock({
        platform: "linux",
        isPackaged: true,
        env: { [KMUX_UPDATE_RELAUNCH_PARENT_PID]: "4242" },
        currentPid: 5000,
        requestLock,
        isProcessRunning: () => false
      })
    ).resolves.toEqual({ status: "denied", parentPid: 4242 });
  });
});
