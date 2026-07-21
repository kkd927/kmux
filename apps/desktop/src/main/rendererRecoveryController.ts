import type { BrowserWindow, RenderProcessGoneDetails } from "electron";

import type { MainWindowRecoveryState } from "./windowLifecycle";

export type MainWindowOpenReason = "initial" | "activate" | "recovery";

export interface RendererRecoveryDiagnosticContext {
  workspaceId?: string;
  paneId?: string;
  surfaceId?: string;
  sessionId?: string;
  lastInteraction?: Record<string, unknown>;
  lastRendererActionType?: string;
}

interface RendererRecoveryControllerOptions {
  openMainWindow: (
    reason: "recovery",
    recoveryState: MainWindowRecoveryState
  ) => BrowserWindow;
  isAppQuitting: () => boolean;
  getDiagnosticContext: () => RendererRecoveryDiagnosticContext;
  log: (scope: string, details: Record<string, unknown>) => void;
  showRecoveryLimitDialog: () => Promise<"reopen" | "quit">;
  quit: () => void;
  now?: () => number;
  crashLimit?: number;
  crashWindowMs?: number;
}

export interface RendererRecoveryController {
  registerWindow(window: BrowserWindow): void;
  isReplacingRenderer(): boolean;
}

interface ActiveRecoveryAttempt {
  id: number;
}

const DEFAULT_CRASH_LIMIT = 3;
const DEFAULT_CRASH_WINDOW_MS = 5 * 60 * 1_000;
const ERR_ABORTED = -3;

export function createRendererRecoveryController(
  options: RendererRecoveryControllerOptions
): RendererRecoveryController {
  const now = options.now ?? Date.now;
  const crashLimit = options.crashLimit ?? DEFAULT_CRASH_LIMIT;
  const crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
  const expectedClose = new WeakSet<BrowserWindow>();
  let currentWindow: BrowserWindow | null = null;
  let activeRecoveryAttempt: ActiveRecoveryAttempt | null = null;
  let nextRecoveryAttemptId = 1;
  let recoveryChoiceOpen = false;
  let recentCrashes: number[] = [];

  const registerWindow = (window: BrowserWindow): void => {
    currentWindow = window;
    window.once("close", () => {
      expectedClose.add(window);
    });
    window.once("closed", () => {
      if (currentWindow === window) {
        currentWindow = null;
      }
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      handleGone(window, details);
    });
    window.webContents.on("unresponsive", () => {
      options.log("main.renderer.unresponsive", windowDetails(window));
    });
    window.webContents.on("responsive", () => {
      options.log("main.renderer.responsive", windowDetails(window));
    });
  };

  const windowDetails = (window: BrowserWindow): Record<string, unknown> => {
    return {
      webContentsId: window.webContents.id,
      rendererPid: getRendererProcessId(window),
      ...options.getDiagnosticContext()
    };
  };

  const snapshotWindow = (window: BrowserWindow): MainWindowRecoveryState => ({
    bounds: window.isMaximized()
      ? window.getNormalBounds()
      : window.getBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen()
  });

  const replaceWindow = (
    recoveryState: MainWindowRecoveryState,
    trigger: "render-process-gone" | "user-reopen"
  ): void => {
    const attempt: ActiveRecoveryAttempt = {
      id: nextRecoveryAttemptId++
    };
    activeRecoveryAttempt = attempt;
    options.log("main.renderer.recovery.started", {
      attemptId: attempt.id,
      trigger,
      recentCrashCount: recentCrashes.length,
      ...options.getDiagnosticContext()
    });
    try {
      const replacement = options.openMainWindow("recovery", recoveryState);
      registerWindow(replacement);
      const settleAttempt = (): boolean => {
        if (!completeRecoveryAttempt(attempt)) {
          return false;
        }
        replacement.webContents.removeListener(
          "did-finish-load",
          onDidFinishLoad
        );
        replacement.webContents.removeListener("did-fail-load", onDidFailLoad);
        replacement.removeListener("closed", onClosedBeforeLoad);
        return true;
      };
      const onDidFinishLoad = (): void => {
        if (!settleAttempt()) {
          return;
        }
        options.log("main.renderer.recovery.completed", {
          attemptId: attempt.id,
          trigger,
          webContentsId: replacement.webContents.id,
          rendererPid: getRendererProcessId(replacement),
          ...options.getDiagnosticContext()
        });
      };
      const onDidFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame || errorCode === ERR_ABORTED || !settleAttempt()) {
          return;
        }
        options.log("main.renderer.recovery.failed", {
          attemptId: attempt.id,
          trigger,
          failureReason: "window-load-failed",
          errorCode,
          errorDescription,
          validatedURL,
          ...options.getDiagnosticContext()
        });
        expectedClose.add(replacement);
        void showRecoveryChoice(recoveryState, "window-load-failed");
        if (!replacement.isDestroyed()) {
          replacement.destroy();
        }
      };
      const onClosedBeforeLoad = (): void => {
        if (!settleAttempt()) {
          return;
        }
        options.log("main.renderer.recovery.failed", {
          attemptId: attempt.id,
          trigger,
          failureReason: "window-closed-before-load",
          ...options.getDiagnosticContext()
        });
      };
      replacement.webContents.once("did-finish-load", onDidFinishLoad);
      replacement.webContents.on("did-fail-load", onDidFailLoad);
      replacement.once("closed", onClosedBeforeLoad);
    } catch (error) {
      completeRecoveryAttempt(attempt);
      options.log("main.renderer.recovery.failed", {
        attemptId: attempt.id,
        trigger,
        failureReason: "window-create-failed",
        message: error instanceof Error ? error.message : String(error),
        ...options.getDiagnosticContext()
      });
      void showRecoveryChoice(recoveryState, "window-create-failed");
    }
  };

  const completeRecoveryAttempt = (attempt: ActiveRecoveryAttempt): boolean => {
    if (activeRecoveryAttempt !== attempt) {
      return false;
    }
    activeRecoveryAttempt = null;
    return true;
  };

  const showRecoveryChoice = async (
    recoveryState: MainWindowRecoveryState,
    reason: "crash-limit" | "window-create-failed" | "window-load-failed"
  ): Promise<void> => {
    if (recoveryChoiceOpen) {
      return;
    }
    recoveryChoiceOpen = true;
    options.log("main.renderer.recovery.paused", {
      reason,
      recentCrashCount: recentCrashes.length,
      ...options.getDiagnosticContext()
    });
    try {
      const choice = await options.showRecoveryLimitDialog();
      options.log("main.renderer.recovery.choice", { reason, choice });
      if (choice === "quit") {
        recoveryChoiceOpen = false;
        options.quit();
        return;
      }
      recentCrashes = [];
      recoveryChoiceOpen = false;
      replaceWindow(recoveryState, "user-reopen");
    } catch (error) {
      options.log("main.renderer.recovery.failed", {
        trigger: "native-dialog",
        message: error instanceof Error ? error.message : String(error)
      });
      recoveryChoiceOpen = false;
      options.quit();
    }
  };

  const handleGone = (
    window: BrowserWindow,
    details: RenderProcessGoneDetails
  ): void => {
    const diagnosticDetails = {
      reason: details.reason,
      exitCode: details.exitCode,
      ...windowDetails(window)
    };
    options.log("main.renderer.render-process-gone", diagnosticDetails);

    if (
      details.reason === "clean-exit" ||
      options.isAppQuitting() ||
      expectedClose.has(window) ||
      currentWindow !== window
    ) {
      options.log("main.renderer.recovery.skipped", {
        ...diagnosticDetails,
        skipReason:
          details.reason === "clean-exit"
            ? "clean-exit"
            : options.isAppQuitting()
              ? "app-quitting"
              : expectedClose.has(window)
                ? "window-closing"
                : "stale-window"
      });
      return;
    }

    const recoveryState = snapshotWindow(window);
    const crashAt = now();
    recentCrashes = recentCrashes.filter(
      (candidate) => crashAt - candidate < crashWindowMs
    );
    recentCrashes.push(crashAt);
    expectedClose.add(window);
    currentWindow = null;
    if (!window.isDestroyed()) {
      window.destroy();
    }

    if (recentCrashes.length >= crashLimit) {
      void showRecoveryChoice(recoveryState, "crash-limit");
      return;
    }
    replaceWindow(recoveryState, "render-process-gone");
  };

  return {
    registerWindow,
    isReplacingRenderer(): boolean {
      return activeRecoveryAttempt !== null || recoveryChoiceOpen;
    }
  };
}

function getRendererProcessId(window: BrowserWindow): number | undefined {
  try {
    return window.webContents.getOSProcessId();
  } catch {
    // A not-yet-launched or gone renderer may not expose an OS process id.
    return undefined;
  }
}
