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
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined);
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
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  beforeQuitAndInstall?: ReturnType<typeof vi.fn>;
  commitQuitAndInstall?: ReturnType<typeof vi.fn>;
  cancelQuitAndInstall?: ReturnType<typeof vi.fn>;
  recoverQuitAndInstall?: ReturnType<typeof vi.fn>;
  autoInstallOnAppQuit?: boolean;
  autoRunAppAfterInstall?: boolean;
  preInstallTimeoutMs?: number;
}): {
  updater: FakeUpdater;
  dialogs: UpdaterDialogs & {
    showUpToDate: ReturnType<typeof vi.fn>;
    promptForDownload: ReturnType<typeof vi.fn>;
    promptForInstall: ReturnType<typeof vi.fn>;
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
    promptForInstall: vi.fn(async () => false),
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
    platform: options?.platform ?? "darwin",
    isPackaged: options?.isPackaged ?? true,
    enabled: options?.enabled,
    env: options?.env ?? {},
    beforeQuitAndInstall: options?.beforeQuitAndInstall,
    commitQuitAndInstall: options?.commitQuitAndInstall,
    cancelQuitAndInstall: options?.cancelQuitAndInstall,
    recoverQuitAndInstall: options?.recoverQuitAndInstall,
    autoInstallOnAppQuit: options?.autoInstallOnAppQuit,
    autoRunAppAfterInstall: options?.autoRunAppAfterInstall,
    preInstallTimeoutMs: options?.preInstallTimeoutMs
  });

  return {
    updater,
    dialogs,
    notifier,
    logger,
    controller
  };
}

async function moveToDownloaded(
  harness: ReturnType<typeof createHarness>
): Promise<void> {
  await harness.controller.checkForUpdates("background");
  harness.updater.emit("update-available", { version: "0.1.12" });
  await harness.controller.downloadUpdate("background");
  harness.updater.emit("update-downloaded", { version: "0.1.12" });
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

  it("enables packaged Linux updater checks without requiring APPIMAGE", async () => {
    const packagedLinux = createHarness({
      platform: "linux",
      isPackaged: true,
      env: {
        APPIMAGE: "/tmp/kmux-0.3.12-linux-x64.AppImage"
      }
    });
    const noAppImageEnvLinux = createHarness({
      platform: "linux",
      isPackaged: true,
      env: {}
    });
    const unpackagedLinux = createHarness({
      platform: "linux",
      isPackaged: false,
      env: {}
    });
    const testLinux = createHarness({
      platform: "linux",
      isPackaged: true,
      env: {
        APPIMAGE: "/tmp/kmux-0.3.12-linux-x64.AppImage",
        NODE_ENV: "test"
      }
    });

    expect(packagedLinux.controller.getState()).toEqual({ status: "idle" });
    expect(noAppImageEnvLinux.controller.getState()).toEqual({
      status: "idle"
    });
    expect(unpackagedLinux.controller.getState()).toEqual({
      status: "disabled"
    });
    expect(testLinux.controller.getState()).toEqual({ status: "disabled" });

    await packagedLinux.controller.checkForUpdates("foreground");
    await noAppImageEnvLinux.controller.checkForUpdates("foreground");
    await unpackagedLinux.controller.checkForUpdates("foreground");
    await testLinux.controller.checkForUpdates("foreground");

    expect(packagedLinux.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(noAppImageEnvLinux.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(unpackagedLinux.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(testLinux.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("applies platform-composed install-on-quit and relaunch policies", () => {
    const linux = createHarness({
      platform: "linux",
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true
    });
    const mac = createHarness({
      platform: "darwin",
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true
    });

    expect(linux.updater.autoInstallOnAppQuit).toBe(true);
    expect(linux.updater.autoRunAppAfterInstall).toBe(true);
    expect(mac.updater.autoInstallOnAppQuit).toBe(false);
    expect(mac.updater.autoRunAppAfterInstall).toBe(true);
  });

  it("freezes auto-install eligibility at shutdown entry", async () => {
    const downloading = createHarness({
      platform: "linux",
      autoInstallOnAppQuit: true
    });
    await downloading.controller.checkForUpdates("background");
    downloading.updater.emit("update-available", { version: "0.1.12" });
    await downloading.controller.downloadUpdate("background");

    expect(downloading.controller.prepareForShutdown()).toBeUndefined();
    expect(downloading.updater.autoInstallOnAppQuit).toBe(false);
    downloading.updater.emit("update-downloaded", { version: "0.1.12" });
    expect(downloading.updater.autoInstallOnAppQuit).toBe(false);

    const downloaded = createHarness({
      platform: "linux",
      autoInstallOnAppQuit: true
    });
    await moveToDownloaded(downloaded);

    expect(downloaded.controller.prepareForShutdown()).toBe("0.1.12");
    expect(downloaded.updater.autoInstallOnAppQuit).toBe(true);
  });

  it("keeps packaged app updates on the stable release channel", () => {
    const packagedMac = createHarness({
      platform: "darwin",
      isPackaged: true
    });
    const packagedLinux = createHarness({
      platform: "linux",
      isPackaged: true,
      env: {
        APPIMAGE: "/tmp/kmux-0.4.6-linux-x64.AppImage"
      }
    });

    expect(packagedMac.updater.allowPrerelease).toBe(false);
    expect(packagedLinux.updater.allowPrerelease).toBe(false);
  });

  it("accepts platform-composed updater enablement", async () => {
    const disabledByRuntime = createHarness({ enabled: false });
    const enabledByRuntime = createHarness({
      enabled: true,
      isPackaged: false,
      env: { NODE_ENV: "test" }
    });

    expect(disabledByRuntime.controller.getState()).toEqual({
      status: "disabled"
    });
    expect(enabledByRuntime.controller.getState()).toEqual({ status: "idle" });

    await disabledByRuntime.controller.checkForUpdates("foreground");
    await enabledByRuntime.controller.checkForUpdates("foreground");

    expect(disabledByRuntime.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(enabledByRuntime.updater.checkForUpdates).toHaveBeenCalledTimes(1);
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

  it("returns to idle when the native updater declines a check with null", async () => {
    const harness = createHarness({ platform: "linux", env: {} });
    harness.updater.checkForUpdates.mockResolvedValueOnce(null);

    await harness.controller.checkForUpdates("foreground");

    expect(harness.controller.getState()).toEqual({ status: "idle" });
    expect(harness.dialogs.showUpToDate).not.toHaveBeenCalled();
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

  it("prompts to install immediately after a foreground download completes", async () => {
    const harness = createHarness();
    harness.dialogs.promptForDownload.mockResolvedValue(true);
    harness.dialogs.promptForInstall.mockResolvedValue(true);

    await harness.controller.checkForUpdates("foreground");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    harness.updater.emit("update-downloaded", { version: "0.1.12" });
    await Promise.resolve();

    expect(harness.dialogs.promptForInstall).toHaveBeenCalledWith("0.1.12");
    await vi.waitFor(() => {
      expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(harness.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(harness.notifier.notifyUpdateDownloaded).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
  });

  it("tracks background download completion and background completion notifications", async () => {
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
    expect(harness.dialogs.promptForInstall).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
  });

  it("prompts to install immediately after an inline download completes", async () => {
    const harness = createHarness();
    harness.dialogs.promptForInstall.mockResolvedValue(true);

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    await harness.controller.downloadUpdate("inline");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    harness.updater.emit("update-downloaded", { version: "0.1.12" });
    await Promise.resolve();

    expect(harness.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(harness.dialogs.promptForInstall).toHaveBeenCalledWith("0.1.12");
    await vi.waitFor(() => {
      expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(harness.notifier.notifyUpdateDownloaded).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
  });

  it("runs the install preparation hook before installing an accepted inline update", async () => {
    const beforeQuitAndInstall = vi.fn();
    const harness = createHarness({ beforeQuitAndInstall });
    harness.dialogs.promptForInstall.mockResolvedValue(true);

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    await harness.controller.downloadUpdate("inline");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    harness.updater.emit("update-downloaded", { version: "0.1.12" });
    await vi.waitFor(() => {
      expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    expect(beforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(beforeQuitAndInstall.mock.invocationCallOrder[0]).toBeLessThan(
      harness.updater.quitAndInstall.mock.invocationCallOrder[0]
    );
  });

  it("deduplicates install requests while persistence preparation is pending", async () => {
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const beforeQuitAndInstall = vi.fn(() => preparation);
    const commitQuitAndInstall = vi.fn();
    const harness = createHarness({
      beforeQuitAndInstall,
      commitQuitAndInstall
    });

    await moveToDownloaded(harness);
    const firstInstall = harness.controller.quitAndInstall();
    const duplicateInstall = harness.controller.quitAndInstall();
    await duplicateInstall;

    expect(beforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled();

    finishPreparation();
    await firstInstall;

    expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(commitQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(
      harness.updater.quitAndInstall.mock.invocationCallOrder[0]
    ).toBeLessThan(commitQuitAndInstall.mock.invocationCallOrder[0]);
  });

  it("continues installation after the 2.5 second persistence deadline", async () => {
    vi.useFakeTimers();
    try {
      const beforeQuitAndInstall = vi.fn(() => new Promise<void>(() => {}));
      const harness = createHarness({ beforeQuitAndInstall });
      await moveToDownloaded(harness);

      const install = harness.controller.quitAndInstall();
      await Promise.resolve();
      vi.advanceTimersByTime(2_499);
      expect(harness.updater.quitAndInstall).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await install;

      expect(harness.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        "[updater:pre-install]",
        "Persistence flush exceeded 2500ms; continuing update install."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps synchronous handoff preparation when persistence rejects", async () => {
    let handoffPrepared = false;
    const beforeQuitAndInstall = vi.fn(() => {
      handoffPrepared = true;
      throw new Error("settings write failed");
    });
    const harness = createHarness({ beforeQuitAndInstall });
    harness.updater.quitAndInstall.mockImplementationOnce(() => {
      expect(handoffPrepared).toBe(true);
    });
    await moveToDownloaded(harness);

    await harness.controller.quitAndInstall();

    expect(harness.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "[updater:pre-install]",
      "settings write failed"
    );
  });

  it("rolls back preparation when updater state changes before native install", async () => {
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const cancelQuitAndInstall = vi.fn(async () => undefined);
    const harness = createHarness({
      beforeQuitAndInstall: vi.fn(() => preparation),
      cancelQuitAndInstall
    });
    await moveToDownloaded(harness);

    const install = harness.controller.quitAndInstall();
    await Promise.resolve();
    harness.updater.emit("error", new Error("download was invalidated"));
    finishPreparation();
    await install;

    expect(cancelQuitAndInstall).toHaveBeenCalledWith("0.1.12");
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("recovers a synchronous native install error without committing shutdown", async () => {
    const commitQuitAndInstall = vi.fn();
    const recoverQuitAndInstall = vi.fn(async () => undefined);
    const harness = createHarness({
      commitQuitAndInstall,
      recoverQuitAndInstall
    });
    await moveToDownloaded(harness);
    harness.updater.quitAndInstall.mockImplementationOnce(() => {
      harness.updater.emit("error", new Error("No update filepath provided"));
    });

    await harness.controller.quitAndInstall();
    await vi.waitFor(() => {
      expect(recoverQuitAndInstall).toHaveBeenCalledTimes(1);
    });

    expect(commitQuitAndInstall).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
    expect(harness.dialogs.showError).toHaveBeenCalledWith(
      "No update filepath provided"
    );

    harness.updater.quitAndInstall.mockImplementationOnce(() => undefined);
    await harness.controller.quitAndInstall();
    expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(2);
    expect(commitQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("recovers a directly thrown native install error", async () => {
    const commitQuitAndInstall = vi.fn();
    const recoverQuitAndInstall = vi.fn(async () => undefined);
    const harness = createHarness({
      commitQuitAndInstall,
      recoverQuitAndInstall
    });
    await moveToDownloaded(harness);
    harness.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    await harness.controller.quitAndInstall();

    expect(recoverQuitAndInstall).toHaveBeenCalledWith(
      expect.objectContaining({ message: "spawn failed" }),
      "0.1.12"
    );
    expect(commitQuitAndInstall).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "downloaded",
      version: "0.1.12"
    });
    expect(harness.dialogs.showError).toHaveBeenCalledWith("spawn failed");
  });

  it("rechecks before inline downloads so stale update buttons jump to the latest version", async () => {
    const harness = createHarness();

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    expect(harness.controller.getState()).toEqual({
      status: "available",
      version: "0.1.12"
    });

    await harness.controller.downloadUpdate("inline");

    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(harness.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({ status: "checking" });

    harness.updater.emit("update-available", { version: "0.1.13" });
    await Promise.resolve();

    expect(harness.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState()).toEqual({
      status: "downloading",
      version: "0.1.13"
    });
  });

  it("shows inline download failures to the user", async () => {
    const harness = createHarness();
    harness.updater.downloadUpdate.mockRejectedValueOnce(
      new Error("disk full")
    );

    await harness.controller.checkForUpdates("background");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();

    await harness.controller.downloadUpdate("inline");
    harness.updater.emit("update-available", { version: "0.1.12" });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.dialogs.showError).toHaveBeenCalledWith("disk full");
    expect(harness.controller.getState()).toEqual({
      status: "error",
      errorMessage: "disk full"
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

  it("uses the VS Code-style default background update cadence", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.controller.startBackgroundChecks();
    vi.advanceTimersByTime(29_999);
    expect(harness.updater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(1);

    harness.updater.emit("update-not-available", { version: "0.1.11" });
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    await Promise.resolve();
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    harness.controller.dispose();
    vi.useRealTimers();
  });
});
