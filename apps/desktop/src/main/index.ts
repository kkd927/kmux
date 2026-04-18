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
import { resolveCliRuntimePaths } from "./cliRuntime";
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
  exportItermcolorsPalette,
  importItermcolorsPalette
} from "./itermcolors";
import {
  createMainWindow,
  persistWindowState,
  setDevelopmentDockIcon
} from "./windowLifecycle";
import { AppStore } from "./store";

const paths = defaultAppPaths(homedir(), process.env);
const currentDir = dirname(fileURLToPath(import.meta.url));
const cliRuntimePaths = resolveCliRuntimePaths({
  currentDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  processExecPath: process.execPath
});
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
  setDevelopmentDockIcon(currentDir);
  if (cliRuntimePaths.warning) {
    console.warn(cliRuntimePaths.warning);
  }
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
    env: process.env
  });
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
      ...cliRuntimePaths
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

  const initial = runtime.restoreInitialState();
  runtime.setStore(new AppStore(initial));

  ptyHost = new PtyHostManager();
  runtime.setPtyHost(ptyHost);

  const terminalBridge = createTerminalBridge({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    onSurfaceInputText: (surfaceId, text) => {
      usageRuntime.handleTerminalInput(surfaceId, text);
    },
    getPtyHost: () => ptyHost
  });

  ptyHost.start(resolvedShellEnv.baseEnv);
  ptyHost.on("event", terminalBridge.handlePtyEvent);

  socketServer = new KmuxSocketServer({
    socketPath: paths.socketPath,
    getState: runtime.getState,
    dispatch: runtime.dispatchAppAction,
    sendSurfaceText: terminalBridge.sendText,
    sendSurfaceKey: terminalBridge.sendKey,
    identify: runtime.identify
  });
  await socketServer.start();

  registerIpcHandlers({
    getView: runtime.getView,
    getUsageView: usageRuntime.getSnapshot,
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
    setUsageDashboardOpen: usageRuntime.setDashboardOpen
  });

  const mainWindow = createMainWindow({
    currentDir,
    loadWindowState: () => windowStateStore.load(),
    onClose: (window) => {
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
  runtime.setMainWindow(mainWindow);
  if (process.arch === "arm64") {
    autoUpdater.channel = "latest-arm64";
  }
  autoUpdater.allowDowngrade = false;
  const updater = createUpdaterController({
    driver: autoUpdater,
    dialogs: createNativeUpdaterDialogs({
      appName: app.getName(),
      getWindow: () => BrowserWindow.getFocusedWindow() ?? mainWindow
    }),
    notifier: createNativeUpdaterNotifier({
      appName: app.getName()
    }),
    currentVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env
  });
  const updateApplicationMenu = () => {
    const template = buildApplicationMenuTemplate({
      appName: app.getName(),
      isMac: process.platform === "darwin",
      isDevelopment: !app.isPackaged,
      updaterState: updater.getState(),
      actions: {
        checkForUpdates: () => updater.checkForUpdates("foreground"),
        downloadUpdate: () => updater.downloadUpdate("foreground"),
        quitAndInstall: () => updater.quitAndInstall()
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  const unsubscribeUpdater = updater.subscribe(() => {
    updateApplicationMenu();
  });
  updateApplicationMenu();
  runtime.broadcastView();
  usageRuntime.start();
  runtime.respawnRestoredSessions();
  mainWindow.once("ready-to-show", () => {
    updater.startBackgroundChecks();
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdownOnce = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
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

  app.on("before-quit", () => {
    void shutdownOnce();
  });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((error) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  app.quit();
});
