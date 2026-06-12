import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const { showMessageBox, showNotification, showNotificationFailure } =
  vi.hoisted(() => ({
    showMessageBox: vi.fn(async () => ({
      response: 0,
      checkboxChecked: false
    })),
    showNotification: vi.fn(),
    showNotificationFailure: {
      current: null as unknown | null
    }
  }));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox
  },
  Notification: class {
    constructor(
      private readonly options: { title: string; body: string; icon?: string }
    ) {}

    show(): void {
      if (showNotificationFailure.current) {
        throw showNotificationFailure.current;
      }
      showNotification(this.options);
    }
  }
}));

import {
  createNativeUpdaterDialogs,
  createNativeUpdaterNotifier,
  showUpdateInstallIncompleteDialog
} from "./updaterUi";
import { DIAGNOSTICS_LOG_PATH_ENV } from "../shared/diagnostics";

describe("native updater UI", () => {
  beforeEach(() => {
    showMessageBox.mockClear();
    showNotification.mockClear();
    showNotificationFailure.current = null;
  });

  it("adds native notification icon identity to update notifications", () => {
    const notifier = createNativeUpdaterNotifier({
      appName: "kmux",
      nativeNotificationIdentity: {
        appId: "dev.kmux.desktop",
        appName: "kmux",
        iconPath: "/tmp/kmux/resources/notificationIcon.png"
      }
    });

    notifier.notifyUpdateAvailable("0.3.13");

    expect(showNotification).toHaveBeenCalledWith({
      title: "kmux update available",
      body: "Version 0.3.13 is ready to download from the title bar or application menu.",
      icon: "/tmp/kmux/resources/notificationIcon.png"
    });
  });

  it("logs update notification failures without interrupting update state", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-updater-ui-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    const previousLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];
    showNotificationFailure.current = new Error(
      "org.freedesktop.Notifications unavailable"
    );
    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;

    try {
      const notifier = createNativeUpdaterNotifier({
        appName: "kmux",
        nativeNotificationIdentity: {
          appId: "dev.kmux.desktop",
          appName: "kmux",
          startupWmClass: "kmux",
          iconPath: "/tmp/kmux/resources/notificationIcon.png"
        }
      });

      expect(() => notifier.notifyUpdateDownloaded("0.3.13")).not.toThrow();

      expect(showNotification).not.toHaveBeenCalled();
      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"main.updater.notification.failed"');
      expect(contents).toContain('"notificationType":"downloaded"');
      expect(contents).toContain('"title":"kmux update ready"');
      expect(contents).toContain('"appId":"dev.kmux.desktop"');
      expect(contents).toContain('"appName":"kmux"');
      expect(contents).toContain('"startupWmClass":"kmux"');
      expect(contents).toContain('"hasIcon":true');
      expect(contents).toContain(
        '"iconPath":"/tmp/kmux/resources/notificationIcon.png"'
      );
      expect(contents).toContain("org.freedesktop.Notifications unavailable");
    } finally {
      showNotificationFailure.current = null;
      if (typeof previousLogPath === "string") {
        process.env[DIAGNOSTICS_LOG_PATH_ENV] = previousLogPath;
      } else {
        delete process.env[DIAGNOSTICS_LOG_PATH_ENV];
      }
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("shows message boxes against the active window when available", async () => {
    const window = {} as Electron.BrowserWindow;
    const dialogs = createNativeUpdaterDialogs({
      appName: "kmux",
      getWindow: () => window
    });

    await dialogs.showUpToDate("0.3.13");

    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: "kmux is up to date",
        detail: "Version 0.3.13 is already installed."
      })
    );
  });

  it("uses Linux AppImage recovery copy for incomplete update installs", async () => {
    const window = {} as Electron.BrowserWindow;

    await showUpdateInstallIncompleteDialog(window, {
      appName: "kmux",
      platform: "linux",
      version: "0.3.13"
    });

    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: "kmux 0.3.13 couldn't finish installing",
        detail:
          "The update was downloaded, but the AppImage update did not apply. Restart kmux from the installed AppImage, then check for updates again."
      })
    );
  });

  it("keeps macOS recovery copy for incomplete Squirrel installs", async () => {
    const window = {} as Electron.BrowserWindow;

    await showUpdateInstallIncompleteDialog(window, {
      appName: "kmux",
      platform: "darwin",
      version: "0.3.13"
    });

    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: "kmux 0.3.13 couldn't finish installing",
        detail:
          "The update was downloaded but macOS didn't apply it. This happens when a Squirrel update has already been installed since the last restart. Restart your Mac, then check for updates again to finish updating."
      })
    );
  });
});
