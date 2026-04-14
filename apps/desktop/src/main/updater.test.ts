import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createUpdaterController,
  type UpdaterController,
  type UpdaterDialogs,
  type UpdaterDriver,
  type UpdaterLogger,
  type UpdaterNotifier
} from "./updater";

class FakeUpdater extends EventEmitter implements UpdaterDriver {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn(() => undefined);

  override on(
    event: Parameters<EventEmitter["on"]>[0],
    listener: Parameters<EventEmitter["on"]>[1]
  ): this {
    return super.on(event, listener);
  }

  override off(
    event: Parameters<EventEmitter["off"]>[0],
    listener: Parameters<EventEmitter["off"]>[1]
  ): this {
    return super.off(event, listener);
  }
}

function createHarness(options?: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  updater: FakeUpdater;
  dialogs: UpdaterDialogs & {
    showUpToDate: ReturnType<typeof vi.fn>;
    promptForDownload: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  notifier: UpdaterNotifier & {
    notifyUpdateAvailable: ReturnType<typeof vi.fn>;
    notifyUpdateDownloaded: ReturnType<typeof vi.fn>;
  };
  logger: UpdaterLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  controller: UpdaterController;
} {
  const updater = new FakeUpdater();
  const dialogs = {
    showUpToDate: vi.fn(async () => undefined),
    promptForDownload: vi.fn(async () => false),
    showError: vi.fn(async () => undefined)
  };
  const notifier = {
    notifyUpdateAvailable: vi.fn(),
    notifyUpdateDownloaded: vi.fn()
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const controller = createUpdaterController({
    driver: updater,
    dialogs,
    notifier,
    logger,
    currentVersion: "0.1.11",
    platform: "darwin",
    isPackaged: options?.isPackaged ?? true,
    env: options?.env ?? {}
  });

  return {
    updater,
    dialogs,
    notifier,
    logger,
    controller
  };
}

describe("updater controller", () => {
  it("disables updates for unpackaged and test builds", async () => {
    const unpackaged = createHarness({ isPackaged: false });
    const testBuild = createHarness({ env: { NODE_ENV: "test" } });

    expect(unpackaged.controller.getState()).toEqual({ status: "disabled" });
    expect(testBuild.controller.getState()).toEqual({ status: "disabled" });

    await unpackaged.controller.checkForUpdates("foreground");
    await testBuild.controller.checkForUpdates("foreground");

    expect(unpackaged.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(testBuild.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(unpackaged.updater.autoDownload).toBe(false);
    expect(unpackaged.updater.autoInstallOnAppQuit).toBe(false);
    expect(unpackaged.updater.allowPrerelease).toBe(false);
  });

  it("shows a foreground confirmation when no update is available", async () => {
    const harness = createHarness();

    await harness.controller.checkForUpdates("foreground");
    harness.updater.emit("update-not-available", { version: "0.1.11" });
    await Promise.resolve();

    expect(harness.dialogs.showUpToDate).toHaveBeenCalledWith("0.1.11");
    expect(harness.notifier.notifyUpdateAvailable).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({ status: "idle" });
  });

  it("prompts for download on a foreground update and starts downloading when accepted", async () => {
    const harness = createHarness();
    harness.dialogs.promptForDownload.mockResolvedValue(true);

    await harness.controller.checkForUpdates("foreground");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    expect(harness.dialogs.promptForDownload).toHaveBeenCalledWith("0.1.12");
    expect(harness.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState()).toEqual({
      status: "downloading",
      version: "0.1.12"
    });
  });

  it("keeps background update checks quiet except for notifications", async () => {
    const harness = createHarness();

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    expect(harness.notifier.notifyUpdateAvailable).toHaveBeenCalledWith(
      "0.1.12"
    );
    expect(harness.dialogs.promptForDownload).not.toHaveBeenCalled();
    expect(harness.dialogs.showUpToDate).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "available",
      version: "0.1.12"
    });
  });

  it("tracks download completion and background completion notifications", async () => {
    const harness = createHarness();

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();
    await harness.controller.downloadUpdate("background");

    expect(harness.controller.getState()).toEqual({
      status: "downloading",
      version: "0.1.12"
    });

    harness.updater.emit("download-progress", { percent: 50 });
    expect(harness.controller.getState()).toEqual({
      status: "downloading",
      version: "0.1.12"
    });

    harness.updater.emit("update-downloaded", { version: "0.1.12" });

    expect(harness.notifier.notifyUpdateDownloaded).toHaveBeenCalledWith(
      "0.1.12"
    );
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
  });

  it("shows foreground errors and recovers on retry", async () => {
    const harness = createHarness();
    harness.updater.checkForUpdates
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);

    await harness.controller.checkForUpdates("foreground");

    expect(harness.dialogs.showError).toHaveBeenCalledWith("network down");
    expect(harness.logger.error).toHaveBeenCalledWith(
      "[updater]",
      "network down"
    );
    expect(harness.controller.getState()).toEqual({
      status: "error",
      errorMessage: "network down"
    });

    await harness.controller.checkForUpdates("foreground");
    harness.updater.emit("update-not-available", { version: "0.1.11" });
    await Promise.resolve();

    expect(harness.controller.getState()).toEqual({ status: "idle" });
  });

  it("schedules delayed and periodic background checks", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = createUpdaterController({
      driver: harness.updater,
      dialogs: harness.dialogs,
      notifier: harness.notifier,
      logger: harness.logger,
      currentVersion: "0.1.11",
      platform: "darwin",
      isPackaged: true,
      env: {},
      initialDelayMs: 100,
      intervalMs: 1_000
    });

    controller.startBackgroundChecks();
    vi.advanceTimersByTime(99);
    expect(harness.updater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(1);

    harness.updater.emit("update-not-available", { version: "0.1.11" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    controller.dispose();
    vi.advanceTimersByTime(1_000);
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
