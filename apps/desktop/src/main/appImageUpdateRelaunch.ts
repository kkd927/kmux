import {
  normalizeAppImagePath,
  resolveAppImageRuntimePath
} from "./platform/posix";

interface AppImageUpdaterLike {
  autoRunAppAfterInstall: boolean;
  on(event: "error", listener: () => void): unknown;
  on(
    event: "appimage-filename-updated",
    listener: (path: string) => void
  ): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  removeListener(
    event: "appimage-filename-updated",
    listener: (path: string) => void
  ): unknown;
}

interface UpdateQuitEmitter {
  on(event: "before-quit-for-update", listener: () => void): unknown;
  removeListener(
    event: "before-quit-for-update",
    listener: () => void
  ): unknown;
}

interface AppRelauncher {
  relaunch(options: { execPath: string; args: string[] }): void;
}

export interface AppImageUpdateRelaunchCoordinator {
  requestRelaunchAfterInstall(): void;
  dispose(): void;
}

interface AppImageUpdateRelaunchOptions {
  enabled: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  updater: AppImageUpdaterLike;
  updateQuitEmitter: UpdateQuitEmitter;
  app: AppRelauncher;
}

export function createAppImageUpdateRelaunchCoordinator(
  options: AppImageUpdateRelaunchOptions
): AppImageUpdateRelaunchCoordinator {
  if (!options.enabled) {
    return createNoopCoordinator();
  }
  const initialAppImagePath = resolveAppImagePath(
    options.platform,
    options.env
  );
  if (!initialAppImagePath) {
    return createNoopCoordinator();
  }

  let relaunchRequested = false;
  let installedAppImagePath = initialAppImagePath;

  // electron-updater normally starts the replacement AppImage before asking
  // Electron to quit. kmux has asynchronous runtime shutdown, so defer the
  // replacement process until Electron has completed that shutdown.
  options.updater.autoRunAppAfterInstall = false;

  const handleInstallError = (): void => {
    relaunchRequested = false;
  };
  const handleAppImageFilenameUpdated = (path: string): void => {
    installedAppImagePath =
      normalizeAppImagePath(path) ?? installedAppImagePath;
  };
  const handleBeforeQuitForUpdate = (): void => {
    if (!relaunchRequested) {
      return;
    }
    relaunchRequested = false;
    options.app.relaunch({
      execPath: installedAppImagePath,
      args: []
    });
  };

  options.updater.on("error", handleInstallError);
  options.updater.on(
    "appimage-filename-updated",
    handleAppImageFilenameUpdated
  );
  options.updateQuitEmitter.on(
    "before-quit-for-update",
    handleBeforeQuitForUpdate
  );

  return {
    requestRelaunchAfterInstall(): void {
      relaunchRequested = true;
    },
    dispose(): void {
      options.updater.removeListener("error", handleInstallError);
      options.updater.removeListener(
        "appimage-filename-updated",
        handleAppImageFilenameUpdated
      );
      options.updateQuitEmitter.removeListener(
        "before-quit-for-update",
        handleBeforeQuitForUpdate
      );
      relaunchRequested = false;
    }
  };
}

function createNoopCoordinator(): AppImageUpdateRelaunchCoordinator {
  return {
    requestRelaunchAfterInstall() {},
    dispose() {}
  };
}

function resolveAppImagePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | null {
  if (platform !== "linux") {
    return null;
  }
  return resolveAppImageRuntimePath(env);
}
