export type UpdateCheckSource = "background" | "foreground";

export type UpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  version?: string;
  errorMessage?: string;
}

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
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
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
  logger?: UpdaterLogger;
  scheduler?: UpdaterScheduler;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
  initialDelayMs?: number;
  intervalMs?: number;
}

export interface UpdaterController {
  getState(): UpdaterState;
  subscribe(listener: (state: UpdaterState) => void): () => void;
  checkForUpdates(source?: UpdateCheckSource): Promise<void>;
  downloadUpdate(source?: UpdateCheckSource): Promise<void>;
  quitAndInstall(): void;
  startBackgroundChecks(): void;
  dispose(): void;
}

type ActiveOperation =
  | { kind: "check"; source: UpdateCheckSource }
  | { kind: "download"; source: UpdateCheckSource }
  | null;

const DEFAULT_INITIAL_DELAY_MS = 20_000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  return (
    options.platform === "darwin" &&
    options.isPackaged === true &&
    options.env?.NODE_ENV !== "test"
  );
}

export function createUpdaterController(
  options: UpdaterControllerOptions
): UpdaterController {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const enabled = isUpdaterEnabled({
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

  const listeners = new Set<(state: UpdaterState) => void>();
  const detachFns: Array<() => void> = [];

  options.driver.autoDownload = false;
  options.driver.autoInstallOnAppQuit = false;
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
      if (source === "background" && version) {
        options.notifier.notifyUpdateDownloaded(version);
      }
    },
    error: (error) => {
      if (!enabled) {
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
    if (state.status === "downloaded") {
      if (source === "foreground") {
        quitAndInstall();
      }
      return;
    }
    if (state.status === "available") {
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
      await options.driver.checkForUpdates();
    } catch (error) {
      handleError(error);
    }
  }

  async function downloadUpdate(
    source: UpdateCheckSource = "foreground"
  ): Promise<void> {
    if (!enabled) {
      return;
    }
    if (state.status === "downloaded") {
      if (source === "foreground") {
        quitAndInstall();
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

  function quitAndInstall(): void {
    if (!enabled || state.status !== "downloaded") {
      return;
    }
    options.driver.quitAndInstall();
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

  function handleError(error: unknown): void {
    const message = getErrorMessage(error);
    const source = activeOperation?.source ?? "background";
    activeOperation = null;
    logger.error("[updater]", message);
    setState({
      status: "error",
      errorMessage: message
    });
    if (source === "foreground") {
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
