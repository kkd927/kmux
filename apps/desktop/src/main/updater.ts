import type { UpdaterState } from "@kmux/proto";

import { isPackagedDesktopUpdaterEligible } from "./platform/posix";

export type UpdateCheckSource = "background" | "foreground" | "inline";
export type UpdateDownloadSource = UpdateCheckSource | "inline";
export type { UpdaterState, UpdaterStatus } from "@kmux/proto";

type UpdaterEventName =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

interface UpdateInfoLike {
  version?: string;
}

type UpdaterEventListener = (...args: unknown[]) => void;

export interface UpdaterDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: UpdaterEventName, listener: UpdaterEventListener): unknown;
  off?(event: UpdaterEventName, listener: UpdaterEventListener): unknown;
  removeListener?(
    event: UpdaterEventName,
    listener: UpdaterEventListener
  ): unknown;
}

export interface UpdaterDialogs {
  showUpToDate(currentVersion: string): Promise<void>;
  promptForDownload(version: string): Promise<boolean>;
  promptForInstall(version?: string): Promise<boolean>;
  showError(message: string): Promise<void>;
}

export interface UpdaterNotifier {
  notifyUpdateAvailable(version: string): void;
  notifyUpdateDownloaded(version: string): void;
}

export interface UpdaterLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface UpdaterScheduler {
  setTimeout(handler: () => void, timeoutMs: number): NodeJS.Timeout;
  clearTimeout(timeout: NodeJS.Timeout): void;
  setInterval(handler: () => void, timeoutMs: number): NodeJS.Timeout;
  clearInterval(timeout: NodeJS.Timeout): void;
}

interface UpdaterControllerOptions {
  driver: UpdaterDriver;
  dialogs: UpdaterDialogs;
  notifier: UpdaterNotifier;
  currentVersion: string;
  beforeQuitAndInstall?: (version?: string) => void | Promise<void>;
  commitQuitAndInstall?: (version?: string) => void | Promise<void>;
  cancelQuitAndInstall?: (version?: string) => void | Promise<void>;
  recoverQuitAndInstall?: (
    error: unknown,
    version?: string
  ) => void | Promise<void>;
  logger?: UpdaterLogger;
  scheduler?: UpdaterScheduler;
  enabled?: boolean;
  autoInstallOnAppQuit?: boolean;
  autoRunAppAfterInstall?: boolean;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
  initialDelayMs?: number;
  intervalMs?: number;
  preInstallTimeoutMs?: number;
}

export interface UpdaterController {
  getState(): UpdaterState;
  subscribe(listener: (state: UpdaterState) => void): () => void;
  checkForUpdates(source?: UpdateCheckSource): Promise<void>;
  downloadUpdate(source?: UpdateDownloadSource): Promise<void>;
  quitAndInstall(): Promise<void>;
  prepareForShutdown(): string | undefined;
  startBackgroundChecks(): void;
  dispose(): void;
}

type ActiveOperation =
  | { kind: "check"; source: UpdateCheckSource }
  | { kind: "download"; source: UpdateDownloadSource }
  | null;

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PRE_INSTALL_TIMEOUT_MS = 2_500;

const DEFAULT_LOGGER: UpdaterLogger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

const DEFAULT_SCHEDULER: UpdaterScheduler = {
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (timeout) => clearTimeout(timeout),
  setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
  clearInterval: (timeout) => clearInterval(timeout)
};

export function isUpdaterEnabled(options: {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!isPackagedDesktopUpdaterEligible(options)) {
    return false;
  }
  return options.platform === "darwin" || options.platform === "linux";
}

export function createUpdaterController(
  options: UpdaterControllerOptions
): UpdaterController {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const enabled =
    options.enabled ??
    isUpdaterEnabled({
      platform: options.platform ?? process.platform,
      isPackaged: options.isPackaged ?? false,
      env: options.env ?? process.env
    });
  let state: UpdaterState = enabled
    ? { status: "idle" }
    : { status: "disabled" };
  let activeOperation: ActiveOperation = null;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let installInProgress = false;
  let installNativeInvoked = false;
  let installCommitted = false;

  const listeners = new Set<(state: UpdaterState) => void>();
  const detachFns: Array<() => void> = [];

  options.driver.autoDownload = false;
  options.driver.autoInstallOnAppQuit = options.autoInstallOnAppQuit ?? false;
  options.driver.autoRunAppAfterInstall =
    options.autoRunAppAfterInstall ?? true;
  options.driver.allowPrerelease = false;

  const eventHandlers: Record<UpdaterEventName, UpdaterEventListener> = {
    "checking-for-update": () => {
      if (!enabled) {
        return;
      }
      setState({
        status: "checking",
        version: state.version
      });
    },
    "update-available": (payload) => {
      if (!enabled) {
        return;
      }
      const version = getVersionFromPayload(payload, state.version);
      setState({
        status: "available",
        version
      });
      const source =
        activeOperation?.kind === "check"
          ? activeOperation.source
          : "background";
      activeOperation = null;
      if (source === "foreground") {
        void promptForDownload(version);
        return;
      }
      if (source === "inline") {
        void downloadKnownUpdate("inline");
        return;
      }
      if (version) {
        options.notifier.notifyUpdateAvailable(version);
      }
    },
    "update-not-available": () => {
      if (!enabled) {
        return;
      }
      const source =
        activeOperation?.kind === "check"
          ? activeOperation.source
          : "background";
      activeOperation = null;
      setState({ status: "idle" });
      if (source === "foreground") {
        void options.dialogs.showUpToDate(options.currentVersion);
      }
    },
    "download-progress": () => {
      if (!enabled || state.status !== "downloading") {
        return;
      }
      setState({
        status: "downloading",
        version: state.version
      });
    },
    "update-downloaded": (payload) => {
      if (!enabled) {
        return;
      }
      const version = getVersionFromPayload(payload, state.version);
      const source =
        activeOperation?.kind === "download"
          ? activeOperation.source
          : "background";
      activeOperation = null;
      setState({
        status: "downloaded",
        version
      });
      if (source === "foreground" || source === "inline") {
        void promptForInstall(version);
        return;
      }
      if (source === "background" && version) {
        options.notifier.notifyUpdateDownloaded(version);
      }
    },
    error: (error) => {
      if (!enabled) {
        return;
      }
      if (recoverRejectedInstall(error)) {
        return;
      }
      handleError(error);
    }
  };

  for (const eventName of Object.keys(eventHandlers) as UpdaterEventName[]) {
    const listener = eventHandlers[eventName];
    options.driver.on(eventName, listener);
    detachFns.push(() => {
      if (typeof options.driver.off === "function") {
        options.driver.off(eventName, listener);
        return;
      }
      options.driver.removeListener?.(eventName, listener);
    });
  }

  function getState(): UpdaterState {
    return { ...state };
  }

  function subscribe(listener: (state: UpdaterState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function checkForUpdates(
    source: UpdateCheckSource = "foreground"
  ): Promise<void> {
    if (!enabled) {
      return;
    }
    if (state.status === "downloaded" && source !== "inline") {
      if (source === "foreground") {
        await quitAndInstall();
      }
      return;
    }
    if (state.status === "available" && source !== "inline") {
      if (source === "foreground") {
        await downloadUpdate("foreground");
      }
      return;
    }
    if (state.status === "checking" || state.status === "downloading") {
      return;
    }

    activeOperation = { kind: "check", source };
    setState({ status: "checking" });

    try {
      const result = await options.driver.checkForUpdates();
      if (
        result === null &&
        activeOperation?.kind === "check" &&
        getState().status === "checking"
      ) {
        activeOperation = null;
        setState({ status: "idle" });
      }
    } catch (error) {
      handleError(error);
    }
  }

  async function downloadUpdate(
    source: UpdateDownloadSource = "foreground"
  ): Promise<void> {
    if (
      source === "inline" &&
      (state.status === "available" || state.status === "downloaded")
    ) {
      await checkForUpdates("inline");
      return;
    }

    await downloadKnownUpdate(source);
  }

  async function downloadKnownUpdate(
    source: UpdateDownloadSource = "foreground"
  ): Promise<void> {
    if (!enabled) {
      return;
    }
    if (state.status === "downloaded") {
      if (source === "foreground") {
        await quitAndInstall();
      }
      return;
    }
    if (state.status !== "available") {
      return;
    }

    activeOperation = { kind: "download", source };
    setState({
      status: "downloading",
      version: state.version
    });

    try {
      await options.driver.downloadUpdate();
    } catch (error) {
      handleError(error);
    }
  }

  async function quitAndInstall(): Promise<void> {
    if (!enabled || state.status !== "downloaded" || installInProgress) {
      return;
    }
    const version = state.version;
    installInProgress = true;
    installNativeInvoked = false;
    installCommitted = false;

    await runPreInstallHook(version);
    if (!installInProgress || state.status !== "downloaded") {
      await cancelPreparedInstall(version);
      return;
    }

    installNativeInvoked = true;
    try {
      options.driver.quitAndInstall(false, true);
    } catch (error) {
      await recoverRejectedInstallAsync(error, version);
      return;
    }

    // AppImageUpdater reports native install rejection through a synchronous
    // `error` event instead of throwing. Its listener clears this guard before
    // quitAndInstall returns so destructive shutdown work is never committed.
    if (!installInProgress) {
      return;
    }

    installCommitted = true;
    try {
      await options.commitQuitAndInstall?.(version);
    } catch (error) {
      logger.error("[updater:install-commit]", getErrorMessage(error));
    }
  }

  function startBackgroundChecks(): void {
    if (!enabled || initialTimer || intervalTimer) {
      return;
    }

    initialTimer = scheduler.setTimeout(() => {
      initialTimer = null;
      void checkForUpdates("background");
      intervalTimer = scheduler.setInterval(() => {
        void checkForUpdates("background");
      }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    }, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  }

  function prepareForShutdown(): string | undefined {
    const shouldAutoInstall =
      enabled &&
      options.autoInstallOnAppQuit === true &&
      state.status === "downloaded";
    options.driver.autoInstallOnAppQuit = shouldAutoInstall;
    return shouldAutoInstall ? state.version : undefined;
  }

  function dispose(): void {
    for (const detach of detachFns) {
      detach();
    }
    if (initialTimer) {
      scheduler.clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      scheduler.clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  async function promptForDownload(version?: string): Promise<void> {
    if (!version) {
      return;
    }
    const shouldDownload = await options.dialogs.promptForDownload(version);
    if (shouldDownload) {
      await downloadUpdate("foreground");
    }
  }

  async function promptForInstall(version?: string): Promise<void> {
    const shouldInstall = await options.dialogs.promptForInstall(version);
    if (shouldInstall) {
      await quitAndInstall();
    }
  }

  async function runPreInstallHook(version?: string): Promise<void> {
    if (!options.beforeQuitAndInstall) {
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    const preparation = Promise.resolve()
      .then(() => options.beforeQuitAndInstall?.(version))
      .then(() => "complete" as const)
      .catch((error) => {
        logger.warn("[updater:pre-install]", getErrorMessage(error));
        return "failed" as const;
      });
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = scheduler.setTimeout(
        () => resolve("timeout"),
        options.preInstallTimeoutMs ?? DEFAULT_PRE_INSTALL_TIMEOUT_MS
      );
    });

    const result = await Promise.race([preparation, timedOut]);
    if (timeout) {
      scheduler.clearTimeout(timeout);
    }
    if (result === "timeout") {
      logger.warn(
        "[updater:pre-install]",
        `Persistence flush exceeded ${
          options.preInstallTimeoutMs ?? DEFAULT_PRE_INSTALL_TIMEOUT_MS
        }ms; continuing update install.`
      );
    }
  }

  function recoverRejectedInstall(error: unknown): boolean {
    const recovery = beginRejectedInstallRecovery(error, state.version);
    if (!recovery) {
      return false;
    }
    void recovery;
    return true;
  }

  async function cancelPreparedInstall(version?: string): Promise<void> {
    installInProgress = false;
    installNativeInvoked = false;
    installCommitted = false;
    try {
      await options.cancelQuitAndInstall?.(version);
    } catch (error) {
      logger.error("[updater:install-cancel]", getErrorMessage(error));
    }
  }

  async function recoverRejectedInstallAsync(
    error: unknown,
    version?: string
  ): Promise<void> {
    await beginRejectedInstallRecovery(error, version);
  }

  function beginRejectedInstallRecovery(
    error: unknown,
    version?: string
  ): Promise<void> | null {
    if (!installInProgress || !installNativeInvoked || installCommitted) {
      return null;
    }
    installInProgress = false;
    installNativeInvoked = false;
    installCommitted = false;
    return finishRejectedInstallRecovery(error, version);
  }

  async function finishRejectedInstallRecovery(
    error: unknown,
    version?: string
  ): Promise<void> {
    const message = getErrorMessage(error);
    logger.error("[updater:install]", message);
    try {
      await options.recoverQuitAndInstall?.(error, version);
    } catch (recoveryError) {
      logger.error(
        "[updater:install-recovery]",
        getErrorMessage(recoveryError)
      );
    }
    await options.dialogs.showError(message);
  }

  function handleError(error: unknown): void {
    const message = getErrorMessage(error);
    const source = activeOperation?.source ?? "background";
    activeOperation = null;
    logger.error("[updater]", message);
    setState({
      status: "error",
      errorMessage: message
    });
    if (source !== "background") {
      void options.dialogs.showError(message);
    }
  }

  function setState(nextState: UpdaterState): void {
    if (areStatesEqual(state, nextState)) {
      return;
    }
    state = nextState;
    for (const listener of listeners) {
      listener(getState());
    }
  }

  return {
    getState,
    subscribe,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    prepareForShutdown,
    startBackgroundChecks,
    dispose
  };
}

function areStatesEqual(left: UpdaterState, right: UpdaterState): boolean {
  return (
    left.status === right.status &&
    left.version === right.version &&
    left.errorMessage === right.errorMessage
  );
}

function getVersionFromPayload(
  payload: unknown,
  fallback?: string
): string | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    "version" in payload &&
    typeof (payload as UpdateInfoLike).version === "string"
  ) {
    const version = (payload as UpdateInfoLike).version?.trim();
    if (version) {
      return version;
    }
  }
  return fallback;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "An unknown update error occurred.";
}
