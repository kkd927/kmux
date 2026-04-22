import { dialog } from "electron";
import type { BrowserWindow } from "electron";

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface QuitConfirmationResult {
  confirmed: boolean;
  suppressFutureWarnings: boolean;
}

interface MainLifecycleOptions {
  isMac: boolean;
  shouldConfirmQuit?: boolean;
  app: {
    quit(): void;
  };
  getWindowCount(): number;
  openMainWindow(reason: "activate"): void;
  getCurrentWindow(): BrowserWindow | null;
  getWarnBeforeQuit(): boolean;
  setWarnBeforeQuit(value: boolean): void;
  confirmQuit: (
    window: BrowserWindow | null
  ) => Promise<QuitConfirmationResult>;
  shutdown: () => Promise<void>;
}

export interface MainLifecycleController {
  allowQuit(): void;
  handleActivate(): void;
  handleBeforeQuit(event: BeforeQuitEventLike): void;
  handleWindowAllClosed(): void;
}

export function createMainLifecycleController(
  options: MainLifecycleOptions
): MainLifecycleController {
  const shouldConfirmQuit = options.shouldConfirmQuit ?? true;
  let quitApproved = false;
  let quitDialogOpen = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdownOnce = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = options.shutdown().catch((error) => {
        console.error("[main:shutdown]", error);
      });
    }
    return shutdownPromise;
  };

  return {
    allowQuit(): void {
      quitApproved = true;
    },
    handleActivate(): void {
      if (options.getWindowCount() === 0) {
        options.openMainWindow("activate");
      }
    },
    handleBeforeQuit(event: BeforeQuitEventLike): void {
      const shouldWarn =
        options.isMac &&
        shouldConfirmQuit &&
        !quitApproved &&
        options.getWarnBeforeQuit();

      if (!shouldWarn) {
        quitApproved = true;
        void shutdownOnce();
        return;
      }

      event.preventDefault();
      if (quitDialogOpen) {
        return;
      }

      quitDialogOpen = true;
      void options
        .confirmQuit(options.getCurrentWindow())
        .then((result) => {
          quitDialogOpen = false;
          if (!result.confirmed) {
            return;
          }
          if (result.suppressFutureWarnings) {
            options.setWarnBeforeQuit(false);
          }
          quitApproved = true;
          options.app.quit();
        })
        .catch((error) => {
          quitDialogOpen = false;
          console.error("[main:quit-confirmation]", error);
        });
    },
    handleWindowAllClosed(): void {
      if (!options.isMac) {
        options.app.quit();
      }
    }
  };
}

export async function showQuitConfirmationDialog(
  window: BrowserWindow | null
): Promise<QuitConfirmationResult> {
  const messageBoxOptions: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Quit kmux?",
    detail:
      "This will close all windows and clear current workspaces for the next launch.",
    checkboxLabel: "Don't warn again for Cmd+Q",
    checkboxChecked: false,
    normalizeAccessKeys: true
  };
  const result = window
    ? await dialog.showMessageBox(window, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions);

  return {
    confirmed: result.response === 0,
    suppressFutureWarnings: result.checkboxChecked === true
  };
}
