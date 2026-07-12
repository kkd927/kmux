import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  utilityProcess
} from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";

import {
  resolveAgentStorageRoots,
  USAGE_AGGREGATION_REVISION,
  USAGE_PRICING_REVISION
} from "@kmux/metadata";

import { resolveSurfaceDiagnosticCaptureEnabled } from "@kmux/core";

import {
  createSettingsStore,
  createSnapshotStore,
  createUsageHistoryStore,
  createWindowStateStore,
  defaultAppPaths
} from "@kmux/persistence";

import { createAppRuntime } from "./appRuntime";
import { ensureClaudeHooksInstalled } from "./claudeIntegration";
import { createMainClipboardService } from "./clipboard";
import { createExternalSessionIndexer } from "./externalSessions";
import {
  createImageAttachmentService,
  IMAGE_ATTACHMENT_CLEANUP_INTERVAL_MS
} from "./imageAttachments";
import { registerIpcHandlers } from "./ipcHandlers";
import { createMetadataRuntime } from "./metadataRuntime";
import { PtyHostManager } from "./ptyHost";
import {
  buildShellLaunchPolicy,
  cancelShellEnvironmentRefresh,
  resolveShellEnvironment
} from "./shellEnvironment";
import { openSettingsJsonFile, openWithMacTextEditor } from "./settingsJson";
import { createShellWrapperRuntime } from "./shellWrapperRuntime";
import { KmuxSocketServer } from "./socketServer";
import { createSurfaceCaptureService } from "./surfaceCapture";
import { buildApplicationMenuTemplate } from "./appMenu";
import { createTerminalBridge } from "./terminalBridge";
import { createTerminalDataPlaneController } from "./terminalDataPlane";
import {
  openTerminalFilePath as openTerminalFilePathFromTerminal,
  resolveTerminalFileLinks as resolveTerminalFileLinksFromTerminal
} from "./terminalFileOpen";
import { createUpdaterController } from "./updater";
import { resolveAutoUpdaterChannel } from "./updaterChannel";
import { createUsageRuntime } from "./usageRuntime";
import { createWorktreeRuntime } from "./worktreeRuntime";
import {
  createNativeUpdaterDialogs,
  createNativeUpdaterNotifier,
  showUpdateInstallIncompleteDialog
} from "./updaterUi";
import {
  createPendingUpdateStore,
  evaluatePendingInstall
} from "./pendingUpdate";
import {
  createMainLifecycleController,
  showQuitConfirmationDialog
} from "./mainLifecycle";
import {
  requirePlatformRuntime,
  UnsupportedPlatformError
} from "./platform/runtime";
import {
  exportItermcolorsPalette,
  importItermcolorsPalette
} from "./itermcolors";
import {
  DIAGNOSTICS_LOG_PATH_ENV,
  logDiagnostics,
  resolveDiagnosticsLogPath
} from "../shared/diagnostics";
import { createNodeSmoothnessProfileRecorder } from "../shared/nodeSmoothnessProfile";
import {
  KMUX_PROFILE_LOG_PATH_ENV,
  isSmoothnessProfileLogPathAllowed
} from "../shared/smoothnessProfile";
import {
  KMUX_NATIVE_CACHE_ROOT_ENV,
  KMUX_RAW_OUTPUT_ROOT_ENV
} from "../shared/platform/env";
import {
  writeAgentHookHelpers,
  writeAgentWrapperBinaries
} from "../pty-host/shellIntegration";
import {
  createMainWindow,
  persistWindowState,
  setDevelopmentDockIcon
} from "./windowLifecycle";
import { AppStore } from "./store";
import {
  ensureAntigravityHooksInstalled,
  recordAntigravitySessionFromHook
} from "./antigravityIntegration";
import {
  KMUX_APP_ID,
  KMUX_APP_NAME,
  LINUX_STARTUP_WM_CLASS
} from "./appIdentity";
import {
  createNativeNotificationIdentity,
  resolveNotificationIconPath
} from "./nativeNotifications";
import { configureElectronUserDataDir } from "./electronUserData";

const paths = defaultAppPaths(homedir(), process.env);
configureElectronUserDataDir({ app });
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
  app.setName(KMUX_APP_NAME);
  const platformRuntime = requirePlatformRuntime({
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env
  });
  const notificationIconPath = resolveNotificationIconPath({
    currentDir,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath
  });
  const nativeNotificationIdentity = createNativeNotificationIdentity({
    appId: KMUX_APP_ID,
    appName: KMUX_APP_NAME,
    startupWmClass: LINUX_STARTUP_WM_CLASS,
    ...(notificationIconPath ? { iconPath: notificationIconPath } : {})
  });
  const smoothnessProfile = createNodeSmoothnessProfileRecorder(process.env);
  logDiagnostics("main.bootstrap", {
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: platformRuntime.platformId,
    diagnosticsLogPath: process.env[DIAGNOSTICS_LOG_PATH_ENV],
    smoothnessProfileEnabled: smoothnessProfile.enabled,
    smoothnessProfileLogPath: process.env[KMUX_PROFILE_LOG_PATH_ENV]
  });
  setDevelopmentDockIcon(currentDir, {
    supportsDock: platformRuntime.desktop.supportsDock
  });
  socketServer = new KmuxSocketServer({
    socketPath: paths.socketPath
  });
  await socketServer.start();
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
    USAGE_PRICING_REVISION,
    USAGE_AGGREGATION_REVISION
  );
  const savedSettings = settingsStore.load();
  const shellWrapperRuntime = createShellWrapperRuntime({
    platform: platformRuntime.shell.platform,
    tmpDir: join(paths.cacheDir, "shell-wrappers")
  });
  process.once("exit", () => {
    shellWrapperRuntime.cleanup();
  });
  const resolvedShellEnv = await resolveShellEnvironment({
    preferredShell: savedSettings?.shell,
    env: process.env,
    platform: platformRuntime.shell.platform,
    cachePath: paths.shellEnvCachePath
  });
  process.once("exit", cancelShellEnvironmentRefresh);
  logDiagnostics("main.shell-environment.resolved", {
    shellPath: resolvedShellEnv.shellPath,
    source: resolvedShellEnv.source
  });
  const userHomeDir = resolvedShellEnv.baseEnv.HOME ?? homedir();
  const agentStorageRoots = resolveAgentStorageRoots({
    homeDir: userHomeDir,
    env: resolvedShellEnv.baseEnv
  });
  const diagnosticsLogPath = resolveDiagnosticsLogPath(
    process.env[DIAGNOSTICS_LOG_PATH_ENV]
  );
  if (diagnosticsLogPath) {
    resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV] = diagnosticsLogPath;
  } else {
    delete resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV];
  }
  const smoothnessProfileLogPath =
    process.env[KMUX_PROFILE_LOG_PATH_ENV]?.trim();
  if (isSmoothnessProfileLogPathAllowed(smoothnessProfileLogPath)) {
    resolvedShellEnv.baseEnv[KMUX_PROFILE_LOG_PATH_ENV] =
      smoothnessProfileLogPath;
  } else {
    delete resolvedShellEnv.baseEnv[KMUX_PROFILE_LOG_PATH_ENV];
  }
  writeAgentHookHelpers(paths.agentHookBinDir);
  writeAgentWrapperBinaries(paths.agentWrapperBinDir);
  const claudeIntegrationResult = ensureClaudeHooksInstalled(userHomeDir, {
    socketPath: paths.socketPath,
    agentBinDir: paths.agentHookBinDir,
    agentStorageRoots
  });
  if (claudeIntegrationResult.warning) {
    console.warn(claudeIntegrationResult.warning);
  }
  const antigravityIntegrationResult = ensureAntigravityHooksInstalled(
    userHomeDir,
    {
      socketPath: paths.socketPath,
      agentBinDir: paths.agentHookBinDir,
      agentStorageRoots
    }
  );
  if (antigravityIntegrationResult.warning) {
    console.warn(antigravityIntegrationResult.warning);
  }
  let metadataRuntime!: ReturnType<typeof createMetadataRuntime>;
  let usageRuntime!: ReturnType<typeof createUsageRuntime>;
  let worktreeRuntime!: ReturnType<typeof createWorktreeRuntime>;

  const runtime = createAppRuntime({
    paths: {
      ...paths,
      nodePath: process.execPath
    },
    snapshotStore,
    windowStateStore,
    settingsStore,
    createShellLaunchPolicy: (launch) =>
      buildShellLaunchPolicy({
        defaultShellPath: resolvedShellEnv.shellPath,
        launchShell: launch.shell,
        launchArgs: launch.args,
        platform: platformRuntime.shell.platform,
        enableShellIntegration:
          platformRuntime.shell.enablePosixShellIntegration,
        socketPath: paths.socketPath,
        nodePath: process.execPath,
        agentHookBinDir: paths.agentHookBinDir,
        agentWrapperBinDir: paths.agentWrapperBinDir
      }),
    defaultShellPath: resolvedShellEnv.shellPath,
    shortcutDefaultsPlatform: platformRuntime.platformId,
    refreshMetadata: (...args) => metadataRuntime.refreshMetadata(...args),
    onDidDispatchAppAction: (action) => {
      metadataRuntime?.handleAppAction(action);
      usageRuntime?.handleAppAction(action);
    },
    externalSessionIndexer: createExternalSessionIndexer({
      homeDir: userHomeDir,
      env: resolvedShellEnv.baseEnv,
      agentStorageRoots,
      antigravitySessionIndexPath: paths.antigravitySessionsPath
    }),
    nativeNotificationIdentity,
    profileRecorder: smoothnessProfile,
    persistWindowState: (window) => {
      persistWindowState({
        windowStateStore,
        window,
        getSidebarVisible: () => {
          const state = runtime.getState();
          return state.windows[state.activeWindowId]?.sidebarVisible;
        },
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
    historyStore: usageHistoryStore,
    homeDir: userHomeDir,
    agentStorageRoots,
    platform: platformRuntime.platformId
  });

  worktreeRuntime = createWorktreeRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    env: resolvedShellEnv.baseEnv,
    homeDir: userHomeDir
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

  ptyHost = new PtyHostManager((modulePath, args, options) =>
    utilityProcess.fork(modulePath, args, options)
  );
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
  const terminalDataPlane = createTerminalDataPlaneController({
    getState: runtime.getState,
    getPtyHost: () => ptyHost
  });
  const surfaceCaptureService = createSurfaceCaptureService({
    captureRoot: paths.captureRoot,
    getState: runtime.getState,
    getWindow: () =>
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null,
    snapshotSurface: terminalBridge.snapshotSurface
  });
  const captureSurfaceDiagnostics = async (surfaceId: string) => {
    runtime.dispatchAppAction({ type: "surface.focus", surfaceId });
    const capture = await surfaceCaptureService.captureSurface(surfaceId, {
      settleForMs: 250,
      timeoutMs: 3000
    });
    logDiagnostics("surface.capture.completed", {
      surfaceId,
      outDir: capture.outDir,
      json: capture.files.json,
      screenshot: capture.files.screenshot,
      rendererWaitTimedOut:
        capture.renderer.dom?.terminalDiagnostics.waitTimedOut ?? null
    });
    if (process.env.NODE_ENV !== "test") {
      shell.showItemInFolder(capture.files.json);
    }
    return capture;
  };
  const imageAttachmentService = createImageAttachmentService({
    attachmentRoot: paths.attachmentRoot,
    getSurfaceSessionId: terminalBridge.surfaceSessionId,
    getSurfaceVendor: usageRuntime.getSurfaceVendor
  });
  const runImageAttachmentCleanup = (): void => {
    void imageAttachmentService
      .cleanupImageAttachments()
      .then((result) => {
        if (result.deletedCount > 0) {
          logDiagnostics("main.image-attachments.cleanup", {
            deletedCount: result.deletedCount,
            deletedBytes: result.deletedBytes,
            remainingBytes: result.remainingBytes
          });
        }
      })
      .catch((error: unknown) => {
        logDiagnostics("main.image-attachments.cleanup-error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
  };
  runImageAttachmentCleanup();
  const imageAttachmentCleanupTimer = setInterval(
    runImageAttachmentCleanup,
    IMAGE_ATTACHMENT_CLEANUP_INTERVAL_MS
  );
  imageAttachmentCleanupTimer.unref?.();
  app.once("before-quit", () => {
    clearInterval(imageAttachmentCleanupTimer);
  });

  logDiagnostics("main.pty-host.starting", {
    diagnosticsLogPath: resolvedShellEnv.baseEnv[DIAGNOSTICS_LOG_PATH_ENV]
  });
  ptyHost.on("event", terminalBridge.handlePtyEvent);
  ptyHost.start({
    ...resolvedShellEnv.baseEnv,
    ...shellWrapperRuntime.env,
    [KMUX_RAW_OUTPUT_ROOT_ENV]: paths.rawOutputRoot,
    [KMUX_NATIVE_CACHE_ROOT_ENV]: paths.nativeCacheRoot
  });
  socketServer.setRuntime({
    getState: runtime.getState,
    dispatch: runtime.dispatchAppAction,
    sendSurfaceText: terminalBridge.sendText,
    sendSurfaceKey: terminalBridge.sendKey,
    identify: runtime.identify,
    isSurfaceVisibleToUser,
    onAgentHook: ({ agent, payload }) => {
      recordAntigravitySessionFromHook({
        indexPath: paths.antigravitySessionsPath,
        agent,
        payload
      });
    }
  });

  registerIpcHandlers({
    getPlatformDescriptor: () => platformRuntime.rendererDescriptor,
    getShellState: runtime.getShellState,
    getWorkspaceContextView: () => {
      const shellState = runtime.getShellState();
      return {
        workspaceRows: shellState.workspaceRows,
        settings: shellState.settings
      };
    },
    getUsageView: usageRuntime.getSnapshot,
    getExternalAgentSessions: runtime.getExternalAgentSessions,
    resumeExternalAgentSession: runtime.resumeExternalAgentSession,
    createImageAttachments: imageAttachmentService.createImageAttachments,
    getUpdaterState: () => updater.getState(),
    dispatchAppAction: runtime.dispatchAppAction,
    attachTerminalStream: terminalDataPlane.attach,
    snapshotSurface: terminalBridge.snapshotSurface,
    sendText: terminalBridge.sendText,
    sendKeyInput: terminalBridge.sendKeyInput,
    openExternalUrl: async (rawUrl) => {
      const url = new URL(rawUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
      }
      if (process.env.NODE_ENV === "test") {
        return;
      }
      await shell.openExternal(url.toString());
    },
    openTerminalFilePath: (surfaceId, rawPath, baseCwd) =>
      openTerminalFilePathFromTerminal({
        surfaceId,
        rawPath,
        baseCwd,
        getState: runtime.getState
      }),
    resolveTerminalFileLinks: (surfaceId, candidates) =>
      resolveTerminalFileLinksFromTerminal({
        surfaceId,
        candidates,
        getState: runtime.getState
      }),
    identify: runtime.identify,
    previewTerminalTypography: runtime.previewTerminalTypography,
    reportTerminalTypographyProbe: runtime.reportTerminalTypographyProbe,
    importTerminalThemePalette: importItermcolorsPalette,
    exportTerminalThemePalette: exportItermcolorsPalette,
    openSettingsJson: async () => {
      settingsStore.save(runtime.getState().settings);
      const result = await openSettingsJsonFile({
        nodeEnv: process.env.NODE_ENV,
        platform: platformRuntime.opener.platform,
        settingsPath: paths.settingsPath,
        shell,
        openWithTextEditor: platformRuntime.opener.useMacTextEditorFirst
          ? openWithMacTextEditor
          : undefined
      });
      if (result.action === "revealed") {
        logDiagnostics("settings-json.open.fallback", {
          path: paths.settingsPath,
          error: result.error
        });
      }
    },
    isSurfaceDiagnosticsEnabled: () =>
      resolveSurfaceDiagnosticCaptureEnabled(
        runtime.getState().settings.surfaceDiagnosticCaptureMode,
        platformRuntime.rendererDescriptor.debugging
          .surfaceDiagnosticCaptureDefaultEnabled
      ),
    captureSurfaceDiagnostics,
    prepareWorktreeConversion: worktreeRuntime.prepareConversion,
    createWorktreeWorkspace: worktreeRuntime.createWorkspace,
    convertDetectedWorktree: worktreeRuntime.convertDetected,
    removeWorkspaceWorktree: worktreeRuntime.remove,
    removeWorkspaceWorktrees: worktreeRuntime.removeMany,
    setUsageDashboardOpen: usageRuntime.setDashboardOpen,
    downloadAvailableUpdate: () => updater.downloadUpdate("inline"),
    installDownloadedUpdate: () => updater.quitAndInstall(),
    clipboard: createMainClipboardService(),
    recordProfileEvent: (event) => smoothnessProfile.record(event),
    recordProfileEvents: (events) => {
      if (smoothnessProfile.recordMany) {
        smoothnessProfile.recordMany(events);
      } else {
        events.forEach((event) => smoothnessProfile.record(event));
      }
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
      platform: platformRuntime.desktop.window,
      onClose: (closingWindow) => {
        persistWindowState({
          windowStateStore,
          window: closingWindow,
          getSidebarVisible: () => {
            const state = runtime.getState();
            return state.windows[state.activeWindowId]?.sidebarVisible;
          },
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
      if (process.env.KMUX_DEV_SMOKE === "1") {
        console.log("[main:window] did-finish-load");
      }
      runtime.syncWindowTitles();
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
  const autoUpdaterChannel = resolveAutoUpdaterChannel({
    platform: process.platform,
    arch: process.arch
  });
  if (autoUpdaterChannel) {
    autoUpdater.channel = autoUpdaterChannel;
  }
  autoUpdater.allowDowngrade = false;
  const pendingUpdateStore = createPendingUpdateStore(
    join(dirname(paths.settingsPath), "pending-update.json")
  );
  updater = createUpdaterController({
    driver: autoUpdater,
    dialogs: createNativeUpdaterDialogs({
      appName: app.getName(),
      getWindow: getCurrentWindow
    }),
    notifier: createNativeUpdaterNotifier({
      appName: app.getName(),
      nativeNotificationIdentity
    }),
    currentVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    enabled: platformRuntime.updater.enabled,
    env: process.env,
    beforeQuitAndInstall: (version) => {
      lifecycle.allowQuit();
      if (version) {
        pendingUpdateStore.record(version);
      }
    }
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
        cancelShellEnvironmentRefresh();
        runtime.shutdown();
        metadataRuntime.dispose();
        usageRuntime.shutdown();

        const server = socketServer;
        socketServer = null;
        const host = ptyHost;
        ptyHost = null;

        const socketStop = server?.stop();
        const hostStop = host?.stop();
        try {
          await Promise.all([socketStop, hostStop]);
        } finally {
          shellWrapperRuntime.cleanup();
        }
      })().catch((error) => {
        console.error("[main:shutdown]", error);
      });
    }

    return shutdownPromise;
  };
  lifecycle = createMainLifecycleController({
    isMac: platformRuntime.desktop.isMac,
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
    getRestoreWorkspacesAfterQuit: () =>
      runtime.getState().settings.restoreWorkspacesAfterQuit,
    setRestoreWorkspacesAfterQuit: (value) => {
      runtime.dispatchAppAction({
        type: "settings.update",
        patch: {
          restoreWorkspacesAfterQuit: value
        }
      });
    },
    confirmQuit: (window, options) =>
      showQuitConfirmationDialog(window, {
        ...options,
        ...(notificationIconPath ? { iconPath: notificationIconPath } : {})
      }),
    shutdown
  });
  openMainWindow("initial");
  const pendingInstall = evaluatePendingInstall(
    app.getVersion(),
    pendingUpdateStore.read()
  );
  if (pendingInstall.status !== "none") {
    logDiagnostics("main.updater.pending-install", {
      status: pendingInstall.status,
      attemptedVersion: pendingInstall.version,
      currentVersion: app.getVersion()
    });
    pendingUpdateStore.clear();
    if (
      pendingInstall.status === "incomplete" &&
      process.env.NODE_ENV !== "test"
    ) {
      void showUpdateInstallIncompleteDialog(getCurrentWindow(), {
        appName: app.getName(),
        platform: process.platform,
        version: pendingInstall.version
      });
    }
  }
  const updateApplicationMenu = () => {
    const template = buildApplicationMenuTemplate({
      appName: app.getName(),
      isMac: platformRuntime.desktop.isMac,
      isDevelopment: !app.isPackaged,
      updaterState: updater.getState(),
      actions: {
        checkForUpdates: () => updater.checkForUpdates("foreground"),
        downloadUpdate: () => updater.downloadUpdate("inline"),
        quitAndInstall: () => updater.quitAndInstall()
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
  runtime.syncWindowTitles();
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
    if (error instanceof UnsupportedPlatformError) {
      console.error("[main:unsupported-platform]", error.message);
      dialog.showErrorBox("Unsupported platform", error.message);
    } else {
      console.error(error);
    }
    app.quit();
  });
