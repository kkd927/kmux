import { dialog } from "electron";
import type { BrowserWindow } from "electron";

import type { UpdaterDialogs, UpdaterNotifier } from "./updater";
import {
  showNativeNotification,
  type NativeNotificationIdentity
} from "./nativeNotifications";

interface NativeUpdaterUiOptions {
  appName: string;
  getWindow: () => BrowserWindow | null;
  nativeNotificationIdentity?: NativeNotificationIdentity;
}

export function createNativeUpdaterDialogs(
  options: NativeUpdaterUiOptions
): UpdaterDialogs {
  return {
    async showUpToDate(currentVersion: string): Promise<void> {
      await showMessageBox(options.getWindow(), {
        type: "info",
        buttons: ["OK"],
        defaultId: 0,
        message: `${options.appName} is up to date`,
        detail: `Version ${currentVersion} is already installed.`
      });
    },
    async promptForDownload(version: string): Promise<boolean> {
      const result = await showMessageBox(options.getWindow(), {
        type: "info",
        buttons: ["Download and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `${options.appName} ${version} is available`,
        detail:
          "Download and install the latest stable release? You will be asked to restart once the download finishes."
      });
      return result.response === 0;
    },
    async promptForInstall(version?: string): Promise<boolean> {
      const versionLabel = version ? ` ${version}` : "";
      const result = await showMessageBox(options.getWindow(), {
        type: "info",
        buttons: ["Install and Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `${options.appName}${versionLabel} is ready to install`,
        detail: "The update has finished downloading. Install and restart now?"
      });
      return result.response === 0;
    },
    async showError(message: string): Promise<void> {
      await showMessageBox(options.getWindow(), {
        type: "error",
        buttons: ["OK"],
        defaultId: 0,
        message: `Unable to update ${options.appName}`,
        detail: message
      });
    }
  };
}

export function createNativeUpdaterNotifier(
  options: Pick<
    NativeUpdaterUiOptions,
    "appName" | "nativeNotificationIdentity"
  >
): UpdaterNotifier {
  return {
    notifyUpdateAvailable(version: string): void {
      showNotification(
        `${options.appName} update available`,
        `Version ${version} is ready to download from the title bar or application menu.`,
        options.nativeNotificationIdentity,
        "available"
      );
    },
    notifyUpdateDownloaded(version: string): void {
      showNotification(
        `${options.appName} update ready`,
        `Version ${version} is ready to install from the title bar or application menu.`,
        options.nativeNotificationIdentity,
        "downloaded"
      );
    }
  };
}

export async function showUpdateInstallIncompleteDialog(
  window: BrowserWindow | null,
  options: { appName: string; platform?: NodeJS.Platform; version?: string }
): Promise<void> {
  const versionLabel = options.version ? ` ${options.version}` : "";
  const detail =
    options.platform === "linux"
      ? "The update was downloaded, but the AppImage update did not apply. Restart kmux from the installed AppImage, then check for updates again."
      : "The update was downloaded but macOS didn't apply it. This happens when a Squirrel update has already been installed since the last restart. Restart your Mac, then check for updates again to finish updating.";
  await showMessageBox(window, {
    type: "warning",
    buttons: ["OK"],
    defaultId: 0,
    message: `${options.appName}${versionLabel} couldn't finish installing`,
    detail
  });
}

async function showMessageBox(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  if (window) {
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

function showNotification(
  title: string,
  body: string,
  identity: NativeNotificationIdentity | undefined,
  notificationType: "available" | "downloaded"
): void {
  showNativeNotification({ title, body }, identity, {
    diagnosticsScope: "main.updater.notification.failed",
    diagnosticsDetails: {
      notificationType
    }
  });
}
