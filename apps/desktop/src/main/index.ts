import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  utilityProcess
} from "electron";
import { homedir } from "node:os";
import { watch as watchFile } from "node:fs";
import { dirname, join, posix } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";

import {
  resolveAgentStorageRoots,
  USAGE_AGGREGATION_REVISION,
  USAGE_PRICING_REVISION
} from "@kmux/metadata";

import {
  resolveSurfaceDiagnosticCaptureEnabled,
  terminalRuntimeMetadataForSurface,
  terminalSessionForSurface,
  type AppState,
  type LocalPath,
  type RemotePath
} from "@kmux/core";

import {
  createSettingsStore,
  createSnapshotStore,
  createUsageHistoryStore,
  createWindowStateStore,
  defaultAppPaths
} from "@kmux/persistence";

import { createAppRuntime } from "./appRuntime";
import { DocumentService } from "./documentService";
import { ResourceOpenCoordinator } from "./resourceOpenCoordinator";
import { ensureClaudeHooksInstalled } from "./claudeIntegration";
import { createMainClipboardService } from "./clipboard";
import { createExternalSessionIndexer } from "./externalSessions";
import {
  createImageAttachmentService,
  IMAGE_ATTACHMENT_CLEANUP_INTERVAL_MS,
  IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  IMAGE_ATTACHMENT_RETENTION_MS
} from "./imageAttachments";
import { registerIpcHandlers } from "./ipcHandlers";
import { createMetadataRuntime } from "./metadataRuntime";
import { PtyHostManager } from "./ptyHost";
import { RemoteHostManager } from "./remoteHost";
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
  openTargetTerminalFilePath,
  resolveTargetTerminalFileLinks
} from "./terminalFileOpen";
import { createUpdaterController } from "./updater";
import { resolveAutoUpdaterChannel } from "./updaterChannel";
import { createUsageRuntime } from "./usageRuntime";
import { createUsageScanWorkerClient } from "./usageScanWorkerClient";
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
  applyDiagnosticsLogPath,
  clearDiagnosticsLog,
  DEFAULT_DIAGNOSTICS_LOG_FILE_NAME,
  DIAGNOSTICS_LOG_PATH_ENV,
  logDiagnostics,
  logTerminalDiagnostics,
  prepareExistingDiagnosticsLogFile,
  resolveEffectiveDiagnosticsLogPath,
  setDiagnosticsRecordSink,
  type DiagnosticsRecord
} from "../shared/diagnostics";
import { createAsyncDiagnosticsWriter } from "./asyncDiagnosticsWriter";
import { createNodeSmoothnessProfileRecorder } from "../shared/nodeSmoothnessProfile";
import {
  KMUX_PROFILE_LOG_PATH_ENV,
  isSmoothnessProfileLogPathAllowed,
  type SmoothnessProfileEvent
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
  setDevelopmentDockIcon,
  type MainWindowRecoveryState
} from "./windowLifecycle";
import {
  createRendererRecoveryController,
  type MainWindowOpenReason
} from "./rendererRecoveryController";
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
import {
  authorizeRendererAppAction,
  routeRendererAppAction
} from "./remote/rendererCommandAuthorization";
import { loadOrCreateDesktopInstallationId } from "./remote/desktopInstallationIdentity";
import { createDurableRemoteOperationStore } from "./remote/durableRemoteOperationStore";
import { createConversionWalStore } from "./remote/conversionWal";
import { createRetainedSessionInventoryStore } from "./remote/retainedSessionInventory";
import { createRemoteEventReceiptStore } from "./remote/remoteEventReceiptStore";
import { RemoteLifecycleRuntime } from "./remote/remoteLifecycleRuntime";
import { createRemoteTargetBindingStore } from "./remote/remoteTargetBindingStore";
import { createSshConnectionRuntime } from "./remote/sshConnectionRuntime";
import { listOpenSshAliases } from "./remote/openSshAliasCatalog";
import { createSshProfileConnectionResolver } from "./remote/sshProfileConnection";
import { createSshProfileStore } from "./remote/sshProfileStore";
import {
  collectSshStartupTargetIds,
  restoreSshStartupTargets
} from "./remote/sshStartupRestore";
import { createSshWorkspaceRuntime } from "./remote/sshWorkspaceRuntime";
import { createSshAskpassBroker } from "./remote/sshAskpassBroker";
import {
  createLocalPathResolver,
  createTargetServiceRegistry
} from "./targets/targetServiceRegistry";
import type { TargetServiceRegistry } from "./targets/contracts";
import {
  createLocalAttachmentProvider,
  createLocalFileProvider,
  createLocalGitProvider
} from "./targets/localTargetProviders";
import { createRemoteGitProvider } from "./targets/remoteGitProvider";
import { createRemoteFileProviders } from "./targets/remoteFileProvider";
import { createRemoteHistoryProvider } from "./targets/remoteHistoryProvider";
import { createLocalUsageProvider } from "./targets/localUsageProvider";
import { createRemoteUsageProvider } from "./targets/remoteUsageProvider";
import { createRemoteMetadataProvider } from "./targets/remoteMetadataProvider";
import {
  createRemoteForwardQueue,
  createRemotePortProvider
} from "./targets/remotePortProvider";
import type { TargetServiceSet } from "./targets/contracts";
import {
  createLocalHistoryProvider,
  createTargetHistoryRuntime,
  type TargetHistoryRuntime
} from "./targetHistoryRuntime";

const paths = defaultAppPaths(homedir(), process.env);
configureElectronUserDataDir({ app });
const currentDir = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
let ptyHost: PtyHostManager | null = null;
let remoteHost: RemoteHostManager | null = null;
let remoteLifecycle: RemoteLifecycleRuntime | null = null;
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
  const resolveLocalPath = createLocalPathResolver();
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
  const settingsStore = createSettingsStore(paths.settingsPath);
  const savedSettings = settingsStore.load();
  const settingsDiagnosticsLogPath = join(
    paths.diagnosticsRoot,
    DEFAULT_DIAGNOSTICS_LOG_FILE_NAME
  );
  const existingDiagnosticsLogPrepared = prepareExistingDiagnosticsLogFile(
    settingsDiagnosticsLogPath
  );
  let diagnosticLoggingSettingEnabled =
    savedSettings?.diagnosticLoggingEnabled ?? false;
  let diagnosticsLogPath = resolveEffectiveDiagnosticsLogPath({
    settingsEnabled: diagnosticLoggingSettingEnabled,
    settingsLogPath: settingsDiagnosticsLogPath
  });
  applyDiagnosticsLogPath(process.env, diagnosticsLogPath);
  let diagnosticsWriter = diagnosticsLogPath
    ? createAsyncDiagnosticsWriter()
    : null;
  if (diagnosticsWriter && diagnosticsLogPath) {
    const configured = await diagnosticsWriter.configure(diagnosticsLogPath);
    if (!configured) {
      diagnosticsLogPath = undefined;
      diagnosticsWriter = null;
      applyDiagnosticsLogPath(process.env, undefined);
    }
  }
  const recordMainDiagnostics = (record: DiagnosticsRecord): boolean =>
    diagnosticsWriter?.record(record) ?? false;
  setDiagnosticsRecordSink(diagnosticsWriter ? recordMainDiagnostics : null);
  const smoothnessProfile = createNodeSmoothnessProfileRecorder(process.env);
  let lastRendererInteraction: Record<string, unknown> | undefined;
  let lastRendererActionType: string | undefined;
  let activeRuntimeContextProvider: () => Record<string, unknown> = () => ({});
  const recordProfileDiagnosticEvent = (
    event: SmoothnessProfileEvent,
    recordSmoothness = true
  ): void => {
    if (recordSmoothness) {
      smoothnessProfile.record(event);
    }
    if (event.name === "renderer.interaction") {
      lastRendererInteraction = { at: event.at, ...event.details };
    }
    const details = {
      source: event.source,
      eventAt: event.at,
      ...activeRuntimeContextProvider(),
      ...event.details
    };
    if (event.name.startsWith("terminal.")) {
      logTerminalDiagnostics(event.name, details);
    } else {
      logDiagnostics(event.name, details);
    }
  };
  logDiagnostics("main.bootstrap", {
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: platformRuntime.platformId,
    diagnosticsLogPath,
    diagnosticLoggingSettingEnabled,
    diagnosticLoggingSource: diagnosticsLogPath ? "settings" : "disabled",
    existingDiagnosticsLogPrepared,
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
  const usageHistoryStore = createUsageHistoryStore(
    paths.usageHistoryPath,
    USAGE_PRICING_REVISION,
    USAGE_AGGREGATION_REVISION
  );
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
  applyDiagnosticsLogPath(resolvedShellEnv.baseEnv, diagnosticsLogPath);
  const smoothnessProfileLogPath =
    process.env[KMUX_PROFILE_LOG_PATH_ENV]?.trim();
  if (isSmoothnessProfileLogPathAllowed(smoothnessProfileLogPath)) {
    resolvedShellEnv.baseEnv[KMUX_PROFILE_LOG_PATH_ENV] =
      smoothnessProfileLogPath;
  } else {
    delete resolvedShellEnv.baseEnv[KMUX_PROFILE_LOG_PATH_ENV];
  }
  let diagnosticConfiguration = Promise.resolve();
  const broadcastDiagnosticLoggingConfiguration = (enabled: boolean): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("kmux:diagnostics-logging", enabled);
    }
  };
  const configureDiagnosticLogging = (settingsEnabled: boolean): void => {
    const previouslyEnabled = diagnosticLoggingSettingEnabled;
    const previousLogPath = diagnosticsLogPath;
    diagnosticLoggingSettingEnabled = settingsEnabled;
    const nextDiagnosticsLogPath = resolveEffectiveDiagnosticsLogPath({
      settingsEnabled,
      settingsLogPath: settingsDiagnosticsLogPath
    });
    diagnosticsLogPath = nextDiagnosticsLogPath;
    applyDiagnosticsLogPath(process.env, nextDiagnosticsLogPath);
    applyDiagnosticsLogPath(resolvedShellEnv.baseEnv, nextDiagnosticsLogPath);
    diagnosticConfiguration = diagnosticConfiguration
      .then(async () => {
        let previousLogCleared: boolean | undefined;
        let effectiveLogPath = nextDiagnosticsLogPath;
        if (settingsEnabled) {
          diagnosticsWriter ??= createAsyncDiagnosticsWriter();
          const writerConfigured = await diagnosticsWriter.configure(
            settingsDiagnosticsLogPath
          );
          if (!writerConfigured) {
            effectiveLogPath = undefined;
            diagnosticsWriter = null;
            setDiagnosticsRecordSink(null);
            diagnosticsLogPath = undefined;
            applyDiagnosticsLogPath(process.env, undefined);
            applyDiagnosticsLogPath(resolvedShellEnv.baseEnv, undefined);
          } else if (!previouslyEnabled) {
            previousLogCleared = await diagnosticsWriter.clear();
            setDiagnosticsRecordSink(recordMainDiagnostics);
          } else {
            setDiagnosticsRecordSink(recordMainDiagnostics);
          }
        }
        const ptyHostConfigured =
          (await ptyHost?.configureDiagnosticsLogPath(effectiveLogPath)) ??
          true;
        logDiagnostics("main.diagnostics.configuration.changed", {
          settingsEnabled,
          effectiveEnabled: Boolean(effectiveLogPath),
          source: effectiveLogPath ? "settings" : "disabled",
          logPath: effectiveLogPath,
          previousLogPath,
          previousLogCleared,
          ptyHostConfigured
        });
        if (!settingsEnabled && diagnosticsWriter) {
          await diagnosticsWriter.configure(undefined);
          diagnosticsWriter = null;
          setDiagnosticsRecordSink(null);
        }
        broadcastDiagnosticLoggingConfiguration(Boolean(effectiveLogPath));
      })
      .catch(() => {
        // Diagnostics configuration must never affect application behavior.
      });
  };
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
  let targetServices: TargetServiceRegistry | undefined;
  let targetHistoryRuntime: TargetHistoryRuntime | undefined;
  const localExternalSessionIndexer = createExternalSessionIndexer({
    homeDir: userHomeDir,
    env: resolvedShellEnv.baseEnv,
    agentStorageRoots,
    antigravitySessionIndexPath: paths.antigravitySessionsPath
  });

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
    refreshMetadata: (surfaceId, cwd, pid) => {
      const state = runtime.getState();
      const surface = state.surfaces[surfaceId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
      if (!workspace || !targetServices) return;
      try {
        targetServices
          .resolveLocated(workspace.location.target)
          .metadata.refresh({
            surfaceId,
            ...(cwd === undefined ? {} : { cwd }),
            ...(pid === undefined ? {} : { pid })
          });
      } catch (error) {
        logDiagnostics("main.target-metadata.refresh-failed", {
          surfaceId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },
    onDidDispatchAppAction: (action, state) => {
      const settings = state.settings;
      if (
        settings.diagnosticLoggingEnabled !== diagnosticLoggingSettingEnabled
      ) {
        configureDiagnosticLogging(settings.diagnosticLoggingEnabled);
      }
      metadataRuntime?.handleAppAction(action);
      usageRuntime?.handleAppAction(action);
      if (
        action.type === "state.restore" ||
        action.type === "workspace.worktree.convert"
      ) {
        void worktreeRuntime?.reconcileManagedSurfaces();
      }
    },
    externalSessionIndexer: {
      listExternalAgentSessions: () =>
        targetHistoryRuntime?.listExternalAgentSessions() ??
        localExternalSessionIndexer.listExternalAgentSessions(),
      resolveExternalAgentSession: (key) =>
        targetHistoryRuntime?.resolveExternalAgentSession(key) ??
        localExternalSessionIndexer.resolveExternalAgentSession(key)
    },
    nativeNotificationIdentity,
    resolveLocalPath,
    profileRecorder: {
      get enabled() {
        return smoothnessProfile.enabled || diagnosticLoggingSettingEnabled;
      },
      record: recordProfileDiagnosticEvent
    },
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
  activeRuntimeContextProvider = () =>
    getActiveRuntimeContext(runtime.getState());

  metadataRuntime = createMetadataRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    env: resolvedShellEnv.baseEnv,
    resolveLocalPath
  });

  const localUsageProvider = createLocalUsageProvider({
    scanService: createUsageScanWorkerClient({
      env: resolvedShellEnv.baseEnv,
      homeDir: userHomeDir,
      agentStorageRoots,
      platform: platformRuntime.platformId
    })
  });
  usageRuntime = createUsageRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    env: resolvedShellEnv.baseEnv,
    historyStore: usageHistoryStore,
    homeDir: userHomeDir,
    agentStorageRoots,
    platform: platformRuntime.platformId,
    resolveLocalPath,
    targetServices: () => targetServices,
    reportTargetUsageError: (target, error) =>
      logDiagnostics("main.target-usage.refresh-failed", {
        target: target.kind === "local" ? "local" : `ssh:${target.targetId}`,
        message: error.message
      })
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
  const desktopInstallationId = loadOrCreateDesktopInstallationId(
    paths.desktopInstallationIdentityPath
  );
  const remoteTargetBindings = createRemoteTargetBindingStore(
    paths.remoteTargetBindingsPath
  );
  const sshProfiles = createSshProfileStore(paths.sshProfilesPath);
  const remoteOperationStore = createDurableRemoteOperationStore(
    paths.remoteOperationRoot
  );
  const remoteEventReceiptStore = createRemoteEventReceiptStore(
    paths.remoteEventReceiptRoot
  );
  const conversionWal = createConversionWalStore(paths.conversionWalRoot);
  const retainedSessionInventory = createRetainedSessionInventoryStore(
    paths.retainedSessionInventoryPath
  );
  let updater!: ReturnType<typeof createUpdaterController>;
  let lifecycle!: ReturnType<typeof createMainLifecycleController>;

  const sshAskpass = createSshAskpassBroker({
    electronPath: process.execPath,
    clientPath: join(currentDir, "askpassClient.js"),
    publishPrompt: (prompt) => {
      const windows = BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed()
      );
      if (windows.length === 0) {
        throw new Error("no renderer is available for SSH authentication");
      }
      for (const window of windows) {
        window.webContents.send("kmux:ssh-askpass-prompt", prompt);
      }
    }
  });
  await sshAskpass.start();

  ptyHost = new PtyHostManager((modulePath, args, options) =>
    utilityProcess.fork(modulePath, args, options)
  );
  remoteHost = new RemoteHostManager(
    (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options),
    {
      runtimeArtifactRoot: app.isPackaged
        ? join(process.resourcesPath, "remote-runtime")
        : join(
            dirname(fileURLToPath(import.meta.url)),
            "../../../../remote/kmuxd/dist"
          ),
      transferRoot: join(paths.cacheDir, "remote-transfers")
    }
  );
  remoteHost.on("error", (error: Error) => {
    logDiagnostics("main.remote-host.error", { message: error.message });
  });
  remoteHost.on("runtime-lost", () => {
    logDiagnostics("main.remote-host.runtime-lost", {});
  });
  remoteLifecycle = new RemoteLifecycleRuntime({
    desktopInstallationId,
    operationStore: remoteOperationStore,
    host: remoteHost,
    hostEnv: resolvedShellEnv.baseEnv,
    getState: runtime.getState,
    getTargetBinding: remoteTargetBindings.get,
    replaceTargetBinding: remoteTargetBindings.replace,
    dispatchFact: (fact) => {
      runtime.dispatchMainFact(fact);
      if (fact.type === "remote-operation.succeeded") {
        void worktreeRuntime?.reconcileManagedSurfaces();
      }
    },
    dispatchAppAction: runtime.dispatchAppAction,
    eventReceiptStore: remoteEventReceiptStore,
    retainedInventory: retainedSessionInventory,
    persistDurableProductSnapshot: (state) => {
      snapshotStore.saveDurable(state, { cleanShutdown: false });
    },
    closeWorkspaceProduct: (workspaceId) => {
      runtime.dispatchAppAction({ type: "workspace.close", workspaceId });
    },
    conversion: {
      wal: conversionWal,
      getLocalRuntimeEpoch: (surfaceId, sessionId) =>
        ptyHost?.sessionRef(surfaceId, sessionId)?.epoch ?? null,
      forceDesktopSnapshot: (state, expectedSnapshotHash) => {
        snapshotStore.saveDurable(state, { cleanShutdown: false });
        return expectedSnapshotHash;
      },
      installDesktopState: (state) => {
        runtime.installDurableState(state);
      },
      terminateLocalSession: async (target) => {
        if (target.runtimeEpoch === undefined) {
          return { ...target, outcome: "already-exited" };
        }
        const host = ptyHost;
        if (!host) {
          throw new Error(
            "local PTY host is unavailable during conversion cleanup"
          );
        }
        const outcome = await host.closeSessionGeneration({
          surfaceId: target.surfaceId,
          sessionId: target.sessionId,
          epoch: target.runtimeEpoch
        });
        return { ...target, outcome };
      }
    },
    reportError: (error) => {
      logDiagnostics("main.remote-lifecycle.error", {
        message: error.message
      });
    }
  });
  remoteLifecycle.recover();
  const providerRemoteHost = remoteHost;
  const providerRemoteLifecycle = remoteLifecycle;
  const sshConnections = createSshConnectionRuntime({
    desktopInstallationId,
    profiles: sshProfiles,
    bindings: remoteTargetBindings,
    resolver: createSshProfileConnectionResolver({
      homeDir: userHomeDir,
      configRoot: join(paths.cacheDir, "ssh-config"),
      env: resolvedShellEnv.baseEnv,
      resolveEffective: async ({ sshPath, configPath, host }) => {
        providerRemoteHost.start(resolvedShellEnv.baseEnv);
        if (!providerRemoteHost.isRunning()) {
          throw new Error("remote-host failed to start for OpenSSH resolution");
        }
        return await providerRemoteHost.resolveSshConfig({
          sshPath,
          configPath,
          host
        });
      }
    }),
    host: providerRemoteHost,
    lifecycle: providerRemoteLifecycle,
    hostEnv: resolvedShellEnv.baseEnv,
    askpassBroker: sshAskpass,
    isTargetReferenced: (targetId) => {
      if (
        Object.values(runtime.getState().workspaces).some(
          (workspace) =>
            workspace.location.target.kind === "ssh" &&
            workspace.location.target.targetId === targetId
        )
      ) {
        return true;
      }
      if (
        retainedSessionInventory
          .loadAll()
          .some((entry) => entry.resourceKey.targetId === targetId)
      ) {
        return true;
      }
      if (
        conversionWal
          .loadAll()
          .some(
            (record) =>
              record.workspaceResourceKey.targetId === targetId &&
              record.state !== "cleanup-complete"
          )
      ) {
        return true;
      }
      return remoteOperationStore
        .loadAll()
        .some(
          (record) =>
            record.intent.resourceKey.targetId === targetId &&
            record.result === undefined
        );
    }
  });
  const sshWorkspaces = createSshWorkspaceRuntime({
    connections: sshConnections,
    lifecycle: providerRemoteLifecycle,
    getState: runtime.getState
  });

  const localTargetServices: TargetServiceSet<LocalPath> = {
    terminal: {
      async create(request) {
        const cwd = resolveLocalPath({
          kind: "local",
          path: request.launch.cwd
        });
        runtime.dispatchAppAction({
          type: "surface.create",
          paneId: request.paneId,
          cwd,
          launch: {
            ...request.launch,
            cwd
          }
        });
      },
      async terminate(request) {
        const surfaceId =
          runtime.getState().sessions[request.sessionId]?.surfaceId;
        if (surfaceId) {
          runtime.dispatchAppAction({ type: "surface.close", surfaceId });
        }
      },
      async sendText(sessionId, text) {
        ptyHost?.sendText(sessionId, text);
      },
      async sendKey(sessionId, input) {
        ptyHost?.sendKey(sessionId, input);
      }
    },
    git: createLocalGitProvider({
      resolveLocalPath,
      managedRoot: join(userHomeDir, ".kmux", "worktrees"),
      env: resolvedShellEnv.baseEnv
    }),
    files: createLocalFileProvider({ resolveLocalPath, homeDir: userHomeDir }),
    metadata: {
      refresh(request) {
        metadataRuntime.refreshMetadata(
          request.surfaceId,
          request.cwd === undefined
            ? undefined
            : resolveLocalPath({ kind: "local", path: request.cwd }),
          request.pid
        );
      }
    },
    history: createLocalHistoryProvider({
      indexer: localExternalSessionIndexer,
      refreshUsage: usageRuntime.refreshNow
    }),
    usage: localUsageProvider,
    ports: {
      async list(sessionId) {
        const state = runtime.getState();
        const surfaceId = state.sessions[sessionId]?.surfaceId;
        return surfaceId
          ? [
              ...(terminalRuntimeMetadataForSurface(state, surfaceId)?.ports ??
                [])
            ]
          : [];
      },
      async remapBrowserUrl({ url }) {
        return { url };
      },
      async closeWorkspace() {}
    },
    attachments: createLocalAttachmentProvider({
      attachmentRoot: paths.attachmentRoot
    })
  };
  const remoteForwardQueue = createRemoteForwardQueue();
  targetServices = createTargetServiceRegistry({
    local: localTargetServices,
    remote: (targetId, resolveRemotePath, decodeRemotePath) => {
      const roots = providerRemoteLifecycle.getTargetRuntimeRoots(targetId);
      if (!roots) return undefined;
      const fileProviders = createRemoteFileProviders({
        host: providerRemoteHost,
        targetId,
        transferRoot: join(paths.cacheDir, "remote-transfers"),
        remoteStateRoot: roots.stateRoot,
        ...(deriveRemoteHome(roots) === undefined
          ? {}
          : { remoteHomeDir: deriveRemoteHome(roots) }),
        resolveRemotePath,
        decodeRemotePath
      });
      const gitProvider = createRemoteGitProvider({
        desktopInstallationId,
        targetId,
        host: providerRemoteHost,
        lifecycle: providerRemoteLifecycle,
        getState: runtime.getState,
        resolveRemotePath,
        decodeRemotePath,
        managedRoot: `${roots.stateRoot}/worktrees`
      });
      const portProvider = createRemotePortProvider({
        desktopInstallationId,
        targetId,
        host: providerRemoteHost,
        lifecycle: providerRemoteLifecycle,
        getState: runtime.getState,
        queue: remoteForwardQueue
      });
      const remoteServices: TargetServiceSet<RemotePath> = {
        terminal: {
          async create(request) {
            requireRemoteWorkspaceScope(
              runtime.getState(),
              targetId,
              request.workspaceId,
              request.paneId
            );
            const cwd = resolveRemotePath(request.launch.cwd);
            await providerRemoteLifecycle.executeRendererLifecycleAction({
              type: "surface.create",
              paneId: request.paneId,
              cwd,
              launch: { ...request.launch, cwd }
            });
          },
          async terminate(request) {
            const state = runtime.getState();
            const session = state.sessions[request.sessionId];
            if (!session) return;
            const surface = state.surfaces[session.surfaceId];
            const pane = surface ? state.panes[surface.paneId] : undefined;
            const workspace = pane
              ? state.workspaces[pane.workspaceId]
              : undefined;
            if (
              !workspace ||
              workspace.location.target.kind !== "ssh" ||
              workspace.location.target.targetId !== targetId
            ) {
              throw new Error("remote session termination target changed");
            }
            await providerRemoteLifecycle.executeRendererLifecycleAction({
              type: "surface.close",
              surfaceId: surface.id
            });
          },
          async sendText(sessionId, text) {
            const surfaceId = requireRemoteSessionSurface(
              runtime.getState(),
              targetId,
              sessionId
            );
            await providerRemoteLifecycle.sendSurfaceText(surfaceId, text);
          },
          async sendKey(sessionId, input) {
            const surfaceId = requireRemoteSessionSurface(
              runtime.getState(),
              targetId,
              sessionId
            );
            await providerRemoteLifecycle.sendSurfaceKey(surfaceId, input);
          }
        },
        git: gitProvider,
        files: fileProviders.files,
        metadata: createRemoteMetadataProvider({
          targetId,
          git: gitProvider,
          ports: portProvider,
          getState: runtime.getState,
          dispatchAppAction: runtime.dispatchAppAction,
          resolveRemotePath,
          reportError: (error) =>
            logDiagnostics("main.remote-metadata.refresh-failed", {
              targetId,
              message: error.message
            })
        }),
        history: createRemoteHistoryProvider({
          desktopInstallationId,
          targetId,
          host: providerRemoteHost,
          decodeRemotePath
        }),
        usage: createRemoteUsageProvider({
          desktopInstallationId,
          targetId,
          host: providerRemoteHost,
          decodeRemotePath
        }),
        ports: portProvider,
        attachments: fileProviders.attachments
      };
      return remoteServices;
    }
  });
  targetHistoryRuntime = createTargetHistoryRuntime({
    targetServices,
    getState: runtime.getState,
    localIndexer: localExternalSessionIndexer,
    reportError: (target, error) =>
      logDiagnostics("main.target-history.refresh-failed", {
        target: target.kind === "local" ? "local" : `ssh:${target.targetId}`,
        message: error.message
      })
  });
  const ownsRendererWindow = (
    sender: { readonly id: number },
    windowId: string
  ): boolean => {
    const state = runtime.getState();
    return Boolean(
      windowId === state.activeWindowId &&
      state.windows[windowId] &&
      BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.webContents.id === sender.id
      )
    );
  };
  const documentService = new DocumentService({
    getState: runtime.getState,
    targetServices,
    ownsWindow: ownsRendererWindow,
    watchLocal: (path, onChange) => {
      if (path.kind !== "local") {
        throw new Error("local document watch requires a local path");
      }
      try {
        const watcher = watchFile(
          resolveLocalPath(path),
          { persistent: false },
          onChange
        );
        watcher.on("error", onChange);
        return () => watcher.close();
      } catch {
        return () => {};
      }
    }
  });
  const resourceOpenCoordinator = new ResourceOpenCoordinator({
    getState: runtime.getState,
    targetServices,
    ownsWindow: ownsRendererWindow,
    dispatchAppAction: runtime.dispatchAppAction
  });
  runtime.setDocumentService(documentService);
  providerRemoteHost.on("target-available", (targetId: string) => {
    documentService.retryTarget(targetId);
  });
  worktreeRuntime = createWorktreeRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    targetServices,
    reportError: (error) =>
      logDiagnostics("main.worktree.surface-reconciliation-failed", {
        message: error.message
      })
  });
  void worktreeRuntime.reconcileManagedSurfaces();

  ptyHost.on("diagnostics", (records: DiagnosticsRecord[]) => {
    if (!diagnosticsWriter) {
      return;
    }
    for (const record of records) {
      diagnosticsWriter.record(record);
    }
  });
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
    getPtyHost: () => ptyHost,
    getRemoteTerminal: (surfaceId, sessionId) =>
      remoteLifecycle?.getRemoteTerminal(surfaceId, sessionId) ?? null
  });
  const surfaceCaptureService = createSurfaceCaptureService({
    captureRoot: paths.captureRoot,
    getState: runtime.getState,
    getWindow: () =>
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null,
    snapshotSurface: terminalBridge.snapshotSurface,
    flushDiagnostics: async () => {
      await diagnosticsWriter?.flush();
    },
    getDiagnosticsWriterHealth: () => diagnosticsWriter?.snapshot() ?? null,
    getDiagnosticsLogPath: () => diagnosticsLogPath
  });
  const captureSurfaceDiagnostics = async (surfaceId: string) => {
    const capture = await surfaceCaptureService.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 3000
    });
    logDiagnostics("surface.capture.completed", {
      surfaceId,
      outDir: capture.outDir,
      json: capture.files.json,
      screenshot: capture.files.screenshot,
      screenshotSkippedReason: capture.screenshotDiagnostics.skippedReason,
      rendererBufferSource: capture.renderer.dom?.bufferSource ?? null,
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
    getSurfaceVendor: usageRuntime.getSurfaceVendor,
    async storeAttachment(request) {
      const state = runtime.getState();
      const surface = state.surfaces[request.surfaceId];
      const session = state.sessions[request.sessionId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
      if (
        !surface ||
        !session ||
        !workspace ||
        terminalSessionForSurface(state, request.surfaceId)?.id !==
          request.sessionId ||
        session.surfaceId !== request.surfaceId
      ) {
        throw new Error("attachment surface identity changed before staging");
      }
      const stored = await targetServices
        .resolveLocated(workspace.location.target)
        .attachments.store({
          workspaceId: workspace.id,
          sessionId: session.id,
          cwd: session.runtimeMetadata.cwd,
          bytes: request.bytes,
          name: request.displayName
        });
      return { terminalReference: stored.terminalReference };
    }
  });
  const runImageAttachmentCleanup = (): void => {
    void (async () => {
      const local = await imageAttachmentService.cleanupImageAttachments();
      const remoteResults = await Promise.all(
        remoteTargetBindings.list().map(async (binding) => {
          const roots = providerRemoteLifecycle.getTargetRuntimeRoots(
            binding.id
          );
          if (!roots) return null;
          try {
            return await providerRemoteHost.pruneRemoteAttachments({
              targetId: binding.id,
              remoteDirectory: posix.join(roots.stateRoot, "attachments"),
              nowUnixMs: Date.now(),
              maxAgeMs: IMAGE_ATTACHMENT_RETENTION_MS,
              maxTotalBytes: IMAGE_ATTACHMENT_MAX_TOTAL_BYTES
            });
          } catch (error) {
            logDiagnostics("main.image-attachments.remote-cleanup-error", {
              targetId: binding.id,
              message: error instanceof Error ? error.message : String(error)
            });
            return null;
          }
        })
      );
      const totals = remoteResults.reduce<typeof local>(
        (result, current) => ({
          deletedCount: result.deletedCount + (current?.deletedCount ?? 0),
          deletedBytes: result.deletedBytes + (current?.deletedBytes ?? 0),
          remainingBytes: result.remainingBytes + (current?.remainingBytes ?? 0)
        }),
        local
      );
      if (totals.deletedCount > 0) {
        logDiagnostics("main.image-attachments.cleanup", { ...totals });
      }
    })().catch((error: unknown) => {
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
  const requireSurfaceWorkspaceTarget = (surfaceId: string) => {
    const state = runtime.getState();
    const surface = state.surfaces[surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (!surface || !pane || !workspace) {
      throw new Error("surface is unavailable");
    }
    return workspace.location.target;
  };
  socketServer.setRuntime({
    getState: runtime.getState,
    dispatch: (action) =>
      runtime.dispatchAppAction(
        authorizeRendererAppAction(action, runtime.getState())
      ),
    sendSurfaceText: async (surfaceId, text, operationId) => {
      const target = requireSurfaceWorkspaceTarget(surfaceId);
      if (target.kind === "local") {
        terminalBridge.sendText(surfaceId, text);
        return { ok: true, boundary: "local-pty-dispatch" };
      }
      const control = remoteLifecycle;
      if (!control) {
        throw new Error("remote lifecycle is unavailable");
      }
      const acknowledgement = await control.sendSurfaceText(
        surfaceId,
        text,
        operationId
      );
      usageRuntime.handleTerminalInput(surfaceId, text);
      return { ok: true, acknowledgement };
    },
    sendSurfaceKey: async (surfaceId, key, operationId) => {
      const target = requireSurfaceWorkspaceTarget(surfaceId);
      if (target.kind === "local") {
        terminalBridge.sendKey(surfaceId, key);
        return { ok: true, boundary: "local-pty-dispatch" };
      }
      const control = remoteLifecycle;
      if (!control) {
        throw new Error("remote lifecycle is unavailable");
      }
      const acknowledgement = await control.sendSurfaceKey(
        surfaceId,
        { key },
        operationId
      );
      return { ok: true, acknowledgement };
    },
    captureSurface: async ({ surfaceId, captureId, lines, maxBytes }) => {
      const target = requireSurfaceWorkspaceTarget(surfaceId);
      if (target.kind !== "ssh") {
        throw new Error(
          "bounded surface.capture is available for SSH surfaces"
        );
      }
      const control = remoteLifecycle;
      if (!control) {
        throw new Error("remote lifecycle is unavailable");
      }
      const capture = await control.captureSurface(surfaceId, {
        captureId,
        lineLimit: lines,
        maxBytes
      });
      return {
        ...capture,
        mutationSequence: capture.mutationSequence.toString(10)
      };
    },
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
    getPlatformDescriptor: () => ({
      ...platformRuntime.rendererDescriptor,
      debugging: {
        ...platformRuntime.rendererDescriptor.debugging,
        diagnosticLogPath: settingsDiagnosticsLogPath
      }
    }),
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
    subscribeDocument: (sender, request) =>
      documentService.subscribe(sender, request),
    unsubscribeDocument: (sender, request) =>
      documentService.unsubscribe(sender, request),
    dispatchRendererAction: (action) => {
      const route = routeRendererAppAction(action, runtime.getState());
      lastRendererActionType = route.action.type;
      logDiagnostics("renderer.action.dispatch", {
        actionType: route.action.type,
        ...getActiveRuntimeContext(runtime.getState())
      });
      if (route.kind === "local") {
        runtime.dispatchAppAction(route.action);
        return;
      }
      const control = remoteLifecycle;
      if (!control) {
        throw new Error("remote lifecycle is unavailable");
      }
      return control.executeRendererLifecycleAction(route.action);
    },
    getRetainedRemoteSessions: () => {
      const control = remoteLifecycle;
      if (!control) {
        throw new Error("remote lifecycle is unavailable");
      }
      return control.getRetainedSessionsSnapshot();
    },
    terminateRetainedRemoteSession: (resourceKey) => {
      const control = remoteLifecycle;
      if (!control) {
        return Promise.reject(new Error("remote lifecycle is unavailable"));
      }
      return control.terminateRetainedSession(resourceKey);
    },
    getSshConnections: (resolveEffective) =>
      sshConnections.getSnapshot({ resolveEffective }),
    listSshConfigAliases: () =>
      listOpenSshAliases({
        homeDir: userHomeDir,
        env: resolvedShellEnv.baseEnv
      }),
    importSshConfigAliases: async (aliases) => {
      const available = new Set(
        await listOpenSshAliases({
          homeDir: userHomeDir,
          env: resolvedShellEnv.baseEnv
        })
      );
      if (
        !Array.isArray(aliases) ||
        aliases.length > 128 ||
        aliases.some(
          (alias) => typeof alias !== "string" || !available.has(alias)
        )
      ) {
        throw new TypeError("SSH alias import selection is invalid");
      }
      const existing = await sshConnections.getSnapshot();
      const imported = new Set(
        existing.profiles
          .map((profile) => profile.sshConfigHost)
          .filter((alias): alias is string => alias !== undefined)
      );
      for (const alias of [...new Set(aliases)].sort()) {
        if (!imported.has(alias)) {
          sshConnections.saveProfile(undefined, {
            name: alias,
            sshConfigHost: alias,
            forwardAgent: false
          });
        }
      }
      return sshConnections.getSnapshot({ resolveEffective: true });
    },
    saveSshProfile: (request) =>
      sshConnections.saveProfile(request.id, request.profile),
    duplicateSshProfile: (profileId) =>
      sshConnections.duplicateProfile(profileId),
    deleteSshProfile: (profileId) => sshConnections.deleteProfile(profileId),
    testSshProfile: async (profileId) => {
      await sshConnections.connectProfile(profileId);
      return sshConnections.getSnapshot({ resolveEffective: true });
    },
    rebindSshProfile: async (profileId) => {
      await sshConnections.rebindProfile(profileId);
      return sshConnections.getSnapshot({ resolveEffective: true });
    },
    cleanSshRuntime: (profileId) =>
      sshConnections.cleanRemoteRuntime(profileId),
    resetSshRuntime: (profileId) =>
      sshConnections.resetRemoteRuntime(profileId),
    prepareSshWorkspace: (request) => sshWorkspaces.prepare(request),
    commitSshWorkspace: (request) => sshWorkspaces.commit(request),
    cancelSshWorkspacePreparation: (request) => sshWorkspaces.cancel(request),
    respondSshAskpass: (request) => sshAskpass.respond(request),
    closeWorkspaceSafely: (workspaceId) => {
      const workspace = runtime.getState().workspaces[workspaceId];
      if (!workspace) return;
      if (workspace.location.target.kind === "ssh") {
        const control = remoteLifecycle;
        if (!control) {
          throw new Error("remote lifecycle is unavailable");
        }
        control.closeWorkspaceRetained(workspaceId);
        return;
      }
      runtime.dispatchAppAction({ type: "workspace.close", workspaceId });
    },
    closeOtherWorkspacesSafely: (workspaceId) => {
      const state = runtime.getState();
      const workspace = state.workspaces[workspaceId];
      if (!workspace) return;
      const activeWindow = state.windows[state.activeWindowId];
      const hasRemoteOthers = activeWindow?.workspaceOrder.some(
        (candidateId) =>
          candidateId !== workspaceId &&
          state.workspaces[candidateId]?.location.target.kind === "ssh"
      );
      if (hasRemoteOthers) {
        const control = remoteLifecycle;
        if (!control) {
          throw new Error("remote lifecycle is unavailable");
        }
        control.closeOtherWorkspacesRetained(workspaceId);
      }
      runtime.dispatchAppAction({
        type: "workspace.closeOthers",
        workspaceId
      });
    },
    attachTerminalStream: terminalDataPlane.attach,
    reportTerminalStreamError: ({ surfaceId, sessionId, error }) => {
      logDiagnostics("main.terminal-stream.error", {
        source: "renderer",
        surfaceId,
        sessionId,
        ...error
      });
    },
    snapshotSurface: terminalBridge.snapshotSurface,
    sendText: terminalBridge.sendText,
    sendKeyInput: terminalBridge.sendKeyInput,
    openExternalUrl: async (surfaceId, rawUrl) => {
      const url = new URL(rawUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
      }
      const state = runtime.getState();
      const surface = state.surfaces[surfaceId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
      if (!surface || !workspace) {
        throw new Error("external terminal URL surface is unavailable");
      }
      const remapped = await targetServices
        .resolveLocated(workspace.location.target)
        .ports.remapBrowserUrl({ workspaceId: workspace.id, url });
      if (remapped.mapping?.status === "pending") {
        throw new Error("SSH port forward is not ready yet");
      }
      if (process.env.NODE_ENV === "test") {
        return;
      }
      await shell.openExternal(remapped.url.toString());
    },
    openTerminalFilePath: (surfaceId, rawPath, baseCwd) =>
      openTargetTerminalFilePath({
        surfaceId,
        rawPath,
        baseCwd,
        getState: runtime.getState,
        targetServices,
        resolveLocalPath
      }),
    resolveTerminalFileLinks: (surfaceId, candidates) =>
      resolveTargetTerminalFileLinks({
        surfaceId,
        candidates,
        getState: runtime.getState,
        targetServices
      }),
    activateTerminalFileLink: (sender, request) =>
      resourceOpenCoordinator.activateTerminalFileLink(sender, request),
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
    clearDiagnosticLog: async () => {
      if (!diagnosticsWriter) {
        return clearDiagnosticsLog(settingsDiagnosticsLogPath);
      }
      const ptyDiagnosticsFlushed = (await ptyHost?.flushDiagnostics()) ?? true;
      if (!ptyDiagnosticsFlushed) {
        return false;
      }
      return diagnosticsWriter.clear();
    },
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
    recordProfileEvent: (event) => {
      recordProfileDiagnosticEvent(event);
    },
    recordProfileEvents: (events) => {
      if (smoothnessProfile.recordMany) {
        smoothnessProfile.recordMany(events);
      } else {
        events.forEach((event) => smoothnessProfile.record(event));
      }
      for (const event of events) {
        recordProfileDiagnosticEvent(event, false);
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
  const openMainWindow = (
    reason: MainWindowOpenReason,
    recoveryState?: MainWindowRecoveryState
  ): BrowserWindow => {
    const window = createMainWindow({
      currentDir,
      loadWindowState: () => windowStateStore.load(),
      ...(recoveryState ? { recoveryState } : {}),
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
    logDiagnostics("main.window.opened", {
      reason,
      webContentsId: window.webContents.id,
      rendererPid: getRendererProcessId(window),
      ...getActiveRuntimeContext(runtime.getState())
    });
    window.webContents.once("did-finish-load", () => {
      // The scan worker forks a Node helper. Starting it while Chromium is
      // establishing renderer/utility IPC can starve macOS Electron startup.
      usageRuntime.start();
      if (process.env.KMUX_DEV_SMOKE === "1") {
        console.log("[main:window] did-finish-load");
      }
      runtime.syncWindowTitles();
      broadcastUpdaterState();
      window.webContents.send(
        "kmux:diagnostics-logging",
        Boolean(diagnosticsLogPath)
      );
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
    return window;
  };
  const rendererRecovery = createRendererRecoveryController({
    openMainWindow: (reason, recoveryState) =>
      openMainWindow(reason, recoveryState),
    isAppQuitting: () => lifecycle.isQuitInProgress(),
    getDiagnosticContext: () => ({
      ...getActiveRuntimeContext(runtime.getState()),
      lastInteraction: lastRendererInteraction,
      lastRendererActionType
    }),
    log: (scope, details) => {
      logDiagnostics(scope, {
        ...details,
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        appVersion: app.getVersion()
      });
    },
    showRecoveryLimitDialog: async () => {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "kmux UI stopped repeatedly",
        message: "The kmux UI stopped three times within five minutes.",
        detail:
          "Shell processes and sessions are still running. Reopen the UI to reconnect, or quit kmux.",
        buttons: ["UI 다시 열기", "kmux 종료"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      return result.response === 0 ? "reopen" : "quit";
    },
    quit: () => app.quit()
  });
  const diagnosticSampleIntervalMs = 5_000;
  let previousSampleAt = performance.now();
  let expectedSampleAt = previousSampleAt + diagnosticSampleIntervalMs;
  let previousCpuUsage = process.cpuUsage();
  const diagnosticsSampleTimer = setInterval(() => {
    const sampledAt = performance.now();
    const elapsedMs = Math.max(1, sampledAt - previousSampleAt);
    const eventLoopDelayMs = Math.max(0, sampledAt - expectedSampleAt);
    const cpuUsage = process.cpuUsage(previousCpuUsage);
    previousCpuUsage = process.cpuUsage();
    previousSampleAt = sampledAt;
    expectedSampleAt = sampledAt + diagnosticSampleIntervalMs;
    if (!diagnosticsLogPath) {
      return;
    }
    const rendererPid =
      currentMainWindow && !currentMainWindow.isDestroyed()
        ? getRendererProcessId(currentMainWindow)
        : undefined;
    const rendererMetric = app
      .getAppMetrics()
      .find((metric) => metric.pid === rendererPid);
    const memory = process.memoryUsage();
    logDiagnostics("main.event-loop-resource.sample", {
      eventLoopDelayMs,
      cpuPercent:
        ((cpuUsage.user + cpuUsage.system) / (elapsedMs * 1_000)) * 100,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      rendererPid,
      rendererCpuPercent: rendererMetric?.cpu.percentCPUUsage,
      rendererWorkingSetKb: rendererMetric?.memory.workingSetSize,
      rendererPeakWorkingSetKb: rendererMetric?.memory.peakWorkingSetSize,
      webContentsId: currentMainWindow?.webContents.id,
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      appVersion: app.getVersion(),
      ...getActiveRuntimeContext(runtime.getState())
    });
  }, diagnosticSampleIntervalMs);
  diagnosticsSampleTimer.unref();
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
        clearInterval(diagnosticsSampleTimer);
        cancelShellEnvironmentRefresh();
        let preserveRemoteWorkspaceLayout = false;
        if (!runtime.getState().settings.restoreWorkspacesAfterQuit) {
          const retention = remoteLifecycle?.retainOwnedForRestoreDisabled();
          if (retention && retention.missingDescriptorKeys.length > 0) {
            preserveRemoteWorkspaceLayout = true;
            logDiagnostics("main.remote-retention.descriptor-missing", {
              count: retention.missingDescriptorKeys.length,
              resourceKeys: retention.missingDescriptorKeys.slice(0, 32)
            });
          }
        }
        runtime.shutdown({
          preserveWorkspaceLayout: preserveRemoteWorkspaceLayout
        });
        metadataRuntime.dispose();
        usageRuntime.shutdown();
        documentService.close();

        await diagnosticConfiguration;
        const server = socketServer;
        socketServer = null;
        const host = ptyHost;
        ptyHost = null;
        const remote = remoteHost;
        remoteHost = null;
        const remoteControl = remoteLifecycle;
        remoteLifecycle = null;

        const socketStop = server?.stop();
        const hostStop = host?.stop();
        const remoteStop = remoteControl?.stop() ?? remote?.stop();
        const askpassStop = sshAskpass.stop();
        try {
          await Promise.all([socketStop, hostStop, remoteStop, askpassStop]);
          await diagnosticsWriter?.close();
          diagnosticsWriter = null;
          applyDiagnosticsLogPath(process.env, undefined);
          setDiagnosticsRecordSink(null);
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
    openMainWindow: (reason) => {
      rendererRecovery.registerWindow(openMainWindow(reason));
    },
    isReplacingRenderer: rendererRecovery.isReplacingRenderer,
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
  const startupSshTargetIds = collectSshStartupTargetIds({
    state: runtime.getState(),
    retained: retainedSessionInventory.loadAll(),
    conversions: conversionWal.loadAll(),
    operations: remoteOperationStore.loadAll()
  });
  void restoreSshStartupTargets({
    targetIds: startupSshTargetIds,
    restoreTarget: (targetId) => sshConnections.restoreTarget(targetId),
    onConnected: () => worktreeRuntime?.reconcileManagedSurfaces(),
    onFailure: (targetId, error) => {
      logDiagnostics("main.ssh-target.restore-failed", {
        targetId,
        message: error.message
      });
    }
  }).then((result) => {
    if (startupSshTargetIds.length === 0) return;
    logDiagnostics("main.ssh-target.restore-complete", {
      requested: startupSshTargetIds.length,
      connected: result.connected.length,
      failed: result.failed.length
    });
  });
  rendererRecovery.registerWindow(openMainWindow("initial"));
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

function getActiveRuntimeContext(state: AppState): {
  workspaceId?: string;
  paneId?: string;
  surfaceId?: string;
  sessionId?: string;
} {
  const window = state.windows[state.activeWindowId];
  const workspace = window
    ? state.workspaces[window.activeWorkspaceId]
    : undefined;
  const pane = workspace ? state.panes[workspace.activePaneId] : undefined;
  const surface = pane ? state.surfaces[pane.activeSurfaceId] : undefined;
  return {
    workspaceId: workspace?.id,
    paneId: pane?.id,
    surfaceId: surface?.id,
    sessionId: surface
      ? terminalSessionForSurface(state, surface.id)?.id
      : undefined
  };
}

function getRendererProcessId(window: BrowserWindow): number | undefined {
  try {
    return window.webContents.getOSProcessId();
  } catch {
    return undefined;
  }
}

function requireRemoteWorkspaceScope(
  state: AppState,
  targetId: string,
  workspaceId: string,
  paneId: string
): void {
  const workspace = state.workspaces[workspaceId];
  const pane = state.panes[paneId];
  if (
    !workspace ||
    !pane ||
    pane.workspaceId !== workspaceId ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== targetId
  ) {
    throw new Error("remote provider request is outside its workspace target");
  }
}

function requireRemoteSessionSurface(
  state: AppState,
  targetId: string,
  sessionId: string
): string {
  const session = state.sessions[sessionId];
  const surface = session ? state.surfaces[session.surfaceId] : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  if (
    !session ||
    !surface ||
    !workspace ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== targetId
  ) {
    throw new Error("remote session is outside its provider target");
  }
  return surface.id;
}

function deriveRemoteHome(roots: {
  installRoot: string;
  stateRoot: string;
}): string | undefined {
  const candidates = [
    [roots.installRoot, "/.local/share/kmux"],
    [roots.stateRoot, "/.local/state/kmux"]
  ] as const;
  for (const [root, suffix] of candidates) {
    if (root.endsWith(suffix)) {
      const home = root.slice(0, -suffix.length);
      if (posix.isAbsolute(home) && home !== "/") return home;
    }
  }
  return undefined;
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
