import { Notification, dialog } from "electron";
import type { BrowserWindow } from "electron";

import type { UpdaterDialogs, UpdaterNotifier } from "./updater";

interface NativeUpdaterUiOptions {
  appName: string;
  getWindow: () => BrowserWindow | null;
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
        detail:
          "The update has finished downloading. Install and restart now?"
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
  options: Pick<NativeUpdaterUiOptions, "appName">
): UpdaterNotifier {
  return {
    notifyUpdateAvailable(version: string): void {
      showNotification(
        `${options.appName} update available`,
        `Version ${version} is ready to download from the title bar or the ${options.appName} menu.`
      );
    },
    notifyUpdateDownloaded(version: string): void {
      showNotification(
        `${options.appName} update ready`,
        `Version ${version} is ready to install from the title bar or the ${options.appName} menu.`
      );
    }
  };
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

function showNotification(title: string, body: string): void {
  if (
    typeof Notification.isSupported === "function" &&
    !Notification.isSupported()
  ) {
    return;
  }
  new Notification({ title, body }).show();
}
