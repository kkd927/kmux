import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createAppImageUpdateRelaunchCoordinator } from "./appImageUpdateRelaunch";

class FakeUpdater extends EventEmitter {
  autoRunAppAfterInstall = true;
}

describe("AppImage update relaunch coordinator", () => {
  it("defers the replacement AppImage until the successful update quit", () => {
    const updater = new FakeUpdater();
    const updateQuitEmitter = new EventEmitter();
    const app = { relaunch: vi.fn() };
    const coordinator = createAppImageUpdateRelaunchCoordinator({
      enabled: true,
      platform: "linux",
      env: { APPIMAGE: "/home/user/Applications/kmux.AppImage" },
      updater,
      updateQuitEmitter,
      app
    });

    expect(updater.autoRunAppAfterInstall).toBe(false);

    coordinator.requestRelaunchAfterInstall();
    expect(app.relaunch).not.toHaveBeenCalled();

    updateQuitEmitter.emit("before-quit-for-update");
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.relaunch).toHaveBeenCalledWith({
      execPath: "/home/user/Applications/kmux.AppImage",
      args: []
    });

    updateQuitEmitter.emit("before-quit-for-update");
    expect(app.relaunch).toHaveBeenCalledTimes(1);
  });

  it("cancels a requested relaunch when installation fails", () => {
    const updater = new FakeUpdater();
    const updateQuitEmitter = new EventEmitter();
    const app = { relaunch: vi.fn() };
    const coordinator = createAppImageUpdateRelaunchCoordinator({
      enabled: true,
      platform: "linux",
      env: { APPIMAGE: "/home/user/Applications/kmux.AppImage" },
      updater,
      updateQuitEmitter,
      app
    });

    coordinator.requestRelaunchAfterInstall();
    updater.emit("error", new Error("install failed"));
    updateQuitEmitter.emit("before-quit-for-update");

    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("relaunches a versioned AppImage from its updated filename", () => {
    const updater = new FakeUpdater();
    const updateQuitEmitter = new EventEmitter();
    const app = { relaunch: vi.fn() };
    const coordinator = createAppImageUpdateRelaunchCoordinator({
      enabled: true,
      platform: "linux",
      env: {
        APPIMAGE: "/home/user/Applications/kmux-0.4.7-linux-arm64.AppImage"
      },
      updater,
      updateQuitEmitter,
      app
    });

    coordinator.requestRelaunchAfterInstall();
    updater.emit(
      "appimage-filename-updated",
      "/home/user/Applications/kmux-1.0.0-linux-arm64.AppImage"
    );
    updateQuitEmitter.emit("before-quit-for-update");

    expect(app.relaunch).toHaveBeenCalledWith({
      execPath: "/home/user/Applications/kmux-1.0.0-linux-arm64.AppImage",
      args: []
    });
  });

  it("leaves non-AppImage updater behavior unchanged", () => {
    const updater = new FakeUpdater();
    const updateQuitEmitter = new EventEmitter();
    const app = { relaunch: vi.fn() };
    const coordinator = createAppImageUpdateRelaunchCoordinator({
      enabled: true,
      platform: "darwin",
      env: { APPIMAGE: "/home/user/Applications/kmux.AppImage" },
      updater,
      updateQuitEmitter,
      app
    });

    coordinator.requestRelaunchAfterInstall();
    updateQuitEmitter.emit("before-quit-for-update");

    expect(updater.autoRunAppAfterInstall).toBe(true);
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("removes update listeners when disposed", () => {
    const updater = new FakeUpdater();
    const updateQuitEmitter = new EventEmitter();
    const app = { relaunch: vi.fn() };
    const coordinator = createAppImageUpdateRelaunchCoordinator({
      enabled: true,
      platform: "linux",
      env: { APPIMAGE: "/home/user/Applications/kmux.AppImage" },
      updater,
      updateQuitEmitter,
      app
    });

    coordinator.requestRelaunchAfterInstall();
    coordinator.dispose();
    updateQuitEmitter.emit("before-quit-for-update");

    expect(app.relaunch).not.toHaveBeenCalled();
    expect(updater.listenerCount("error")).toBe(0);
    expect(updater.listenerCount("appimage-filename-updated")).toBe(0);
    expect(updateQuitEmitter.listenerCount("before-quit-for-update")).toBe(0);
  });
});
