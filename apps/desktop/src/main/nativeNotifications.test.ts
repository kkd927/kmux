import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createNativeNotificationIdentity,
  createNativeNotificationOptions,
  resolveNotificationIconPath,
  showNativeNotification
} from "./nativeNotifications";
import { DIAGNOSTICS_LOG_PATH_ENV } from "../shared/diagnostics";

describe("native notification identity", () => {
  it("prefers the packaged notification icon resource", () => {
    expect(
      resolveNotificationIconPath({
        currentDir: "/repo/apps/desktop/out/main",
        resourcesPath: "/tmp/kmux/resources",
        exists: (filePath) =>
          filePath === "/tmp/kmux/resources/notificationIcon.png"
      })
    ).toBe("/tmp/kmux/resources/notificationIcon.png");
  });

  it("falls back to the development build icon", () => {
    expect(
      resolveNotificationIconPath({
        currentDir: "/repo/apps/desktop/out/main",
        resourcesPath: "/tmp/kmux/resources",
        exists: (filePath) => filePath === "/repo/apps/desktop/build/icon.png"
      })
    ).toBe("/repo/apps/desktop/build/icon.png");
  });

  it("omits the icon option when no icon path is available", () => {
    expect(
      createNativeNotificationOptions({
        title: "Codex finished",
        body: "Ready for review"
      })
    ).toEqual({
      title: "Codex finished",
      body: "Ready for review"
    });
  });

  it("adds the resolved icon to native notification options", () => {
    expect(
      createNativeNotificationOptions(
        {
          title: "Codex finished",
          body: "Ready for review"
        },
        {
          iconPath: "/tmp/kmux/resources/notificationIcon.png"
        }
      )
    ).toEqual({
      title: "Codex finished",
      body: "Ready for review",
      icon: "/tmp/kmux/resources/notificationIcon.png"
    });
  });

  it("keeps Linux app identity out of unsupported Electron notification options", () => {
    expect(
      createNativeNotificationOptions(
        {
          title: "Codex finished",
          body: "Ready for review"
        },
        createNativeNotificationIdentity({
          appId: "dev.kmux.desktop",
          appName: "kmux",
          startupWmClass: "kmux",
          iconPath: "/tmp/kmux/resources/notificationIcon.png"
        })
      )
    ).toEqual({
      title: "Codex finished",
      body: "Ready for review",
      icon: "/tmp/kmux/resources/notificationIcon.png"
    });
  });

  it("creates native notification identity from packaged desktop identity", () => {
    expect(
      createNativeNotificationIdentity({
        appId: "dev.kmux.desktop",
        appName: "kmux",
        startupWmClass: "kmux",
        iconPath: "/tmp/kmux/resources/notificationIcon.png"
      })
    ).toEqual({
      appId: "dev.kmux.desktop",
      appName: "kmux",
      startupWmClass: "kmux",
      iconPath: "/tmp/kmux/resources/notificationIcon.png"
    });
  });

  it("skips unsupported native notifications without constructing one", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-notification-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    const previousLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];
    const constructed = vi.fn();

    class UnsupportedNotification {
      static isSupported(): boolean {
        return false;
      }

      constructor(_options: Electron.NotificationConstructorOptions) {
        constructed();
      }

      show(): void {
        throw new Error("unsupported notifications should not be shown");
      }
    }

    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;
    try {
      expect(
        showNativeNotification(
          {
            title: "Codex finished",
            body: "Ready for review"
          },
          createNativeNotificationIdentity({
            appId: "dev.kmux.desktop",
            appName: "kmux",
            startupWmClass: "kmux"
          }),
          {
            notificationApi: UnsupportedNotification,
            diagnosticsScope: "test.native-notification.failed"
          }
        )
      ).toBe(false);
      expect(constructed).not.toHaveBeenCalled();
      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"test.native-notification.failed"');
      expect(contents).toContain('"appId":"dev.kmux.desktop"');
      expect(contents).toContain('"appName":"kmux"');
      expect(contents).toContain('"startupWmClass":"kmux"');
      expect(contents).toContain('"hasIcon":false');
      expect(contents).toContain("native notifications unsupported");
    } finally {
      if (typeof previousLogPath === "string") {
        process.env[DIAGNOSTICS_LOG_PATH_ENV] = previousLogPath;
      } else {
        delete process.env[DIAGNOSTICS_LOG_PATH_ENV];
      }
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("logs native notification failures without throwing", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-notification-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    const previousLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];
    const notificationError = new Error(
      "org.freedesktop.Notifications unavailable"
    );
    const onError = vi.fn();

    class FailingNotification {
      static isSupported(): boolean {
        return true;
      }

      constructor(_options: Electron.NotificationConstructorOptions) {}

      show(): void {
        throw notificationError;
      }
    }

    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;
    try {
      expect(
        showNativeNotification(
          {
            title: "Codex finished",
            body: "Ready for review"
          },
          createNativeNotificationIdentity({
            appId: "dev.kmux.desktop",
            appName: "kmux",
            startupWmClass: "kmux",
            iconPath: "/tmp/kmux/resources/notificationIcon.png"
          }),
          {
            notificationApi: FailingNotification,
            diagnosticsScope: "test.native-notification.failed",
            diagnosticsDetails: {
              source: "unit"
            },
            onError
          }
        )
      ).toBe(false);

      expect(onError).toHaveBeenCalledWith(notificationError);
      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"test.native-notification.failed"');
      expect(contents).toContain('"source":"unit"');
      expect(contents).toContain('"title":"Codex finished"');
      expect(contents).toContain('"bodyLength":16');
      expect(contents).toContain('"appId":"dev.kmux.desktop"');
      expect(contents).toContain('"appName":"kmux"');
      expect(contents).toContain('"startupWmClass":"kmux"');
      expect(contents).toContain('"hasIcon":true');
      expect(contents).toContain(
        '"iconPath":"/tmp/kmux/resources/notificationIcon.png"'
      );
      expect(contents).toContain("org.freedesktop.Notifications unavailable");
    } finally {
      if (typeof previousLogPath === "string") {
        process.env[DIAGNOSTICS_LOG_PATH_ENV] = previousLogPath;
      } else {
        delete process.env[DIAGNOSTICS_LOG_PATH_ENV];
      }
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
