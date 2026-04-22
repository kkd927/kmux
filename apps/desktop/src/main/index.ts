import { app, BrowserWindow, Menu } from "electron";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";

import {
  USAGE_PRICING_REVISION
} from "@kmux/metadata";

import {
  createSettingsStore,
  createSnapshotStore,
  createUsageHistoryStore,
  createWindowStateStore,
  defaultAppPaths
} from "@kmux/persistence";

import { createAppRuntime } from "./appRuntime";
import { ensureClaudeHooksInstalled } from "./claudeIntegration";
import { ensureGeminiHooksInstalled } from "./geminiIntegration";
import { registerIpcHandlers } from "./ipcHandlers";
import { createMetadataRuntime } from "./metadataRuntime";
import { PtyHostManager } from "./ptyHost";
import { resolveShellEnvironment } from "./shellEnvironment";
import { KmuxSocketServer } from "./socketServer";
import { buildApplicationMenuTemplate } from "./appMenu";
import { createTerminalBridge } from "./terminalBridge";
import { createFontInventoryProvider } from "./terminalTypography";
import { createUpdaterController } from "./updater";
import { createUsageRuntime } from "./usageRuntime";
import {
  createNativeUpdaterDialogs,
  createNativeUpdaterNotifier
} from "./updaterUi";
import {
  createMainLifecycleController,
  showQuitConfirmationDialog
} from "./mainLifecycle";
import {
  exportItermcolorsPalette,
  importItermcolorsPalette
} from "./itermcolors";
import {
  DIAGNOSTICS_LOG_PATH_ENV,
  logDiagnostics
} from "../shared/diagnostics";
import {
  createMainWindow,
  persistWindowState,
  setDevelopmentDockIcon
} from "./windowLifecycle";
import { AppStore } from "./store";

const paths = defaultAppPaths(homedir(), process.env);
const currentDir = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;

let ptyHost: PtyHostManager | null = null;
let socketServer: KmuxSocketServer | null = null;

function ignoreExpectedPipeClose(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
    return;
  }
  throw error;
}

process.stdout.on("error", ignoreExpectedPipeClose);
process.stderr.on("error", ignoreExpectedPipeClose);

async function bootstrap(): Promise<void> {
  logDiagnostics("main.bootstrap", {
    packaged: app.isPackaged,
    version: app.getVersion(),
    diagnosticsLogPath: process.env[DIAGNOSTICS_LOG_PATH_ENV]
  });
  setDevelopmentDockIcon(currentDir);
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    website: "https://github.com/kkd927/kmux"
  });
  const snapshotStore = createSnapshotStore(paths.statePath);
  const windowStateStore = createWindowStateStore(paths.windowStatePath);
  const settingsStore = createSettingsStore(paths.settingsPath);
  const usageHistoryStore = createUsageHistoryStore(
    paths.usageHistoryPath,
    USAGE_PRICING_REVISION
  );
  const savedSettings = settingsStore.load();
  const resolvedShellEnv = await resolveShellEnvironment({
    preferredShell: savedSettings?.shell,
    env: process.env,
    cachePath: paths.shellEnvCachePath
  });
  logDiagnostics("main.shell-environment.resolved", {
    shellPath: resolvedShellEnv.shellPath,
    source: resolvedShellEnv.source
  });
  const diagnosticsLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];
  if (diagnosticsLogPath) {
    resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV] = diagnosticsLogPath;
  } else {
    delete resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV];
  }
  const claudeIntegrationResult = ensureClaudeHooksInstalled(
    resolvedShellEnv.baseEnv.HOME ?? homedir()
  );
  if (claudeIntegrationResult.warning) {
    console.warn(claudeIntegrationResult.warning);
  }
  const geminiIntegrationResult = ensureGeminiHooksInstalled(
    resolvedShellEnv.baseEnv.HOME ?? homedir()
  );
  if (geminiIntegrationResult.warning) {
    console.warn(geminiIntegrationResult.warning);
  }
  let metadataRuntime!: ReturnType<typeof createMetadataRuntime>;
  let usageRuntime!: ReturnType<typeof createUsageRuntime>;

  const runtime = createAppRuntime({
    paths: {
      ...paths,
      nodePath: process.execPath
    },
    snapshotStore,
    windowStateStore,
    settingsStore,
    defaultShellPath: resolvedShellEnv.shellPath,
    refreshMetadata: (...args) => metadataRuntime.refreshMetadata(...args),
    fontInventoryProvider: createFontInventoryProvider(
      resolvedShellEnv.baseEnv
    ),
    onDidDispatchAppAction: (action) => {
      usageRuntime?.handleAppAction(action);
    },
    persistWindowState: (window) => {
      persistWindowState({
        windowStateStore,
        window,
        getSidebarWidth: () => {
          const state = runtime.getState();
          return state.windows[state.activeWindowId]?.sidebarWidth;
        }
      });
    }
  });

  metadataRuntime = createMetadataRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    env: resolvedShellEnv.baseEnv
  });

  usageRuntime = createUsageRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    env: resolvedShellEnv.baseEnv,
    historyStore: usageHistoryStore
  });

  const isSurfaceVisibleToUser = (surfaceId: string): boolean => {
    if (!BrowserWindow.getFocusedWindow()) {
      return false;
    }
    const state = runtime.getState();
    const activeWindow = state.windows[state.activeWindowId];
    const activeWorkspace = state.workspaces[activeWindow.activeWorkspaceId];
    const activePane = state.panes[activeWorkspace.activePaneId];
    return activePane?.activeSurfaceId === surfaceId;
  };

  const initial = runtime.restoreInitialState();
  runtime.setStore(new AppStore(initial));
  let updater!: ReturnType<typeof createUpdaterController>;
  let lifecycle!: ReturnType<typeof createMainLifecycleController>;

  ptyHost = new PtyHostManager();
  runtime.setPtyHost(ptyHost);

  const terminalBridge = createTerminalBridge({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    getSurfaceVendor: usageRuntime.getSurfaceVendor,
    isSurfaceVisibleToUser,
    onSurfaceInputText: (surfaceId, text) => {
      usageRuntime.handleTerminalInput(surfaceId, text);
    },
    getPtyHost: () => ptyHost
  });

  logDiagnostics("main.pty-host.starting", {
    diagnosticsLogPath: resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV]
  });
  ptyHost.start(resolvedShellEnv.baseEnv);
  ptyHost.on("event", terminalBridge.handlePtyEvent);

  socketServer = new KmuxSocketServer({
    socketPath: paths.socketPath,
    getState: runtime.getState,
    dispatch: runtime.dispatchAppAction,
    sendSurfaceText: terminalBridge.sendText,
    sendSurfaceKey: terminalBridge.sendKey,
    identify: runtime.identify,
    isSurfaceVisibleToUser
  });
  await socketServer.start();

  registerIpcHandlers({
    getView: runtime.getView,
    getUsageView: usageRuntime.getSnapshot,
    getUpdaterState: () => updater.getState(),
    dispatchAppAction: runtime.dispatchAppAction,
    attachSurface: terminalBridge.attachSurface,
    snapshotSurface: terminalBridge.snapshotSurface,
    detachSurface: terminalBridge.detachSurface,
    sendText: terminalBridge.sendText,
    sendKeyInput: terminalBridge.sendKeyInput,
    resizeSurface: terminalBridge.resizeSurface,
    identify: runtime.identify,
    listTerminalFontFamilies: runtime.listTerminalFontFamilies,
    previewTerminalTypography: runtime.previewTerminalTypography,
    reportTerminalTypographyProbe: runtime.reportTerminalTypographyProbe,
    importTerminalThemePalette: importItermcolorsPalette,
    exportTerminalThemePalette: exportItermcolorsPalette,
    setUsageDashboardOpen: usageRuntime.setDashboardOpen,
    downloadAvailableUpdate: () => updater.downloadUpdate("inline"),
    installDownloadedUpdate: () => {
      lifecycle.allowQuit();
      updater.quitAndInstall();
    }
  });

  let currentMainWindow: BrowserWindow | null = null;
  const getCurrentWindow = (): BrowserWindow | null => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      return focusedWindow;
    }
    if (currentMainWindow && !currentMainWindow.isDestroyed()) {
      return currentMainWindow;
    }
    return null;
  };
  const openMainWindow = (_reason: "initial" | "activate"): void => {
    const window = createMainWindow({
      currentDir,
      loadWindowState: () => windowStateStore.load(),
      onClose: (closingWindow) => {
        persistWindowState({
          windowStateStore,
          window: closingWindow,
          getSidebarWidth: () => {
            const state = runtime.getState();
            return state.windows[state.activeWindowId]?.sidebarWidth;
          }
        });
      }
    });
    currentMainWindow = window;
    runtime.setMainWindow(window);
    window.webContents.once("did-finish-load", () => {
      runtime.broadcastView();
      broadcastUpdaterState();
    });
    window.once("ready-to-show", () => {
      updater.startBackgroundChecks();
    });
    window.once("closed", () => {
      if (currentMainWindow === window) {
        currentMainWindow = null;
        runtime.setMainWindow(null);
      }
    });
  };
  if (process.arch === "arm64") {
    autoUpdater.channel = "latest-arm64";
  }
  autoUpdater.allowDowngrade = false;
  updater = createUpdaterController({
    driver: autoUpdater,
    dialogs: createNativeUpdaterDialogs({
      appName: app.getName(),
      getWindow: getCurrentWindow
    }),
    notifier: createNativeUpdaterNotifier({
      appName: app.getName()
    }),
    currentVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env
  });
  const broadcastUpdaterState = (): void => {
    const state = updater.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("kmux:updater", state);
    }
  };
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logDiagnostics("main.shutdown.begin", {});
        unsubscribeUpdater();
        updater.dispose();
        runtime.shutdown();
        usageRuntime.shutdown();

        const server = socketServer;
        socketServer = null;
        const host = ptyHost;
        ptyHost = null;

        const socketStop = server?.stop();
        host?.stop();
        await socketStop;
      })().catch((error) => {
        console.error("[main:shutdown]", error);
      });
    }

    return shutdownPromise;
  };
  lifecycle = createMainLifecycleController({
    isMac: process.platform === "darwin",
    // E2E cleanup should not depend on mutating persisted warn-before-quit
    // settings or dismissing a native macOS dialog.
    shouldConfirmQuit: process.env.KMUX_E2E_DISABLE_QUIT_CONFIRM !== "1",
    app,
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    openMainWindow,
    getCurrentWindow,
    getWarnBeforeQuit: () => runtime.getState().settings.warnBeforeQuit,
    setWarnBeforeQuit: (value) => {
      runtime.dispatchAppAction({
        type: "settings.update",
        patch: {
          warnBeforeQuit: value
        }
      });
    },
    confirmQuit: showQuitConfirmationDialog,
    shutdown
  });
  openMainWindow("initial");
  const updateApplicationMenu = () => {
    const template = buildApplicationMenuTemplate({
      appName: app.getName(),
      isMac: process.platform === "darwin",
      isDevelopment: !app.isPackaged,
      updaterState: updater.getState(),
      actions: {
        checkForUpdates: () => updater.checkForUpdates("foreground"),
        downloadUpdate: () => updater.downloadUpdate("foreground"),
        quitAndInstall: () => {
          lifecycle.allowQuit();
          updater.quitAndInstall();
        }
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  const unsubscribeUpdater = updater.subscribe(() => {
    updateApplicationMenu();
    broadcastUpdaterState();
  });
  updateApplicationMenu();
  broadcastUpdaterState();
  runtime.broadcastView();
  usageRuntime.start();
  runtime.respawnRestoredSessions();
  app.on("before-quit", (event) => {
    logDiagnostics("main.before-quit", {});
    lifecycle.handleBeforeQuit(event);
  });
  app.on("activate", () => {
    lifecycle.handleActivate();
  });
  app.on("window-all-closed", () => {
    lifecycle.handleWindowAllClosed();
  });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((error) => {
    console.error(error);
    app.quit();
  });
