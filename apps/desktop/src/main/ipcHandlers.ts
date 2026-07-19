import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { RemoteOperationCommandResult } from "@kmux/core";

import type {
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  Id,
  ImportedTerminalThemePalette,
  ResolvedTerminalTypographyVm,
  RetainedRemoteSessionResourceKey,
  RetainedRemoteSessionsSnapshot,
  ShellIdentity,
  ShellStoreSnapshot,
  SshConnectionsSnapshot,
  SshAskpassResponseRequest,
  SshProfileDto,
  SshProfileSaveRequest,
  SshRuntimeCleanReport,
  SshRuntimeResetReport,
  SshWorkspaceCancelRequest,
  SshWorkspaceCommitRequest,
  SshWorkspaceOpenResult,
  SshWorkspacePrepareRequest,
  SshWorkspacePrepareResult,
  SurfaceCapturePayload,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalColorPalette,
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult,
  TerminalKeyInput,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  UpdaterState,
  UsageViewSnapshot,
  WorktreeConversionPreview,
  WorktreeBulkRemoveResult,
  WorktreeRemoveResult,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";

import {
  buildNativeSurfaceContextMenu,
  buildNativeWorkspaceContextMenu
} from "./workspaceContextMenu";
import {
  createMainClipboardService,
  type MainClipboardService
} from "./clipboard";
import type { RendererPlatformDescriptor } from "../shared/platform/rendererPlatform";
import type { SmoothnessProfileEvent } from "../shared/smoothnessProfile";
import type { WorkspaceContextView } from "../shared/workspaceContextMenu";
import type { SurfaceContextMenuContext } from "../shared/surfaceContextMenu";
import type { TerminalStreamAttachResult } from "../shared/terminalPort";
import {
  normalizeTerminalStreamErrorReport,
  type TerminalStreamErrorReport
} from "../shared/terminalStreamDiagnostics";

interface IpcHandlersOptions {
  getPlatformDescriptor: () => RendererPlatformDescriptor;
  getShellState: () => ShellStoreSnapshot;
  getWorkspaceContextView: () => WorkspaceContextView;
  getUsageView: () => UsageViewSnapshot;
  getExternalAgentSessions: () =>
    | ExternalAgentSessionsSnapshot
    | Promise<ExternalAgentSessionsSnapshot>;
  resumeExternalAgentSession: (key: string) => ExternalAgentSessionResumeResult;
  createImageAttachments: (
    surfaceId: Id,
    payloads: CreateImageAttachmentPayload[]
  ) => Promise<CreateImageAttachmentsResult>;
  getUpdaterState: () => UpdaterState;
  dispatchRendererAction: (action: unknown) => void | Promise<void>;
  getRetainedRemoteSessions: () => RetainedRemoteSessionsSnapshot;
  terminateRetainedRemoteSession: (
    resourceKey: RetainedRemoteSessionResourceKey
  ) => Promise<RemoteOperationCommandResult>;
  getSshConnections: (
    resolveEffective: boolean
  ) => Promise<SshConnectionsSnapshot>;
  listSshConfigAliases: () => string[] | Promise<string[]>;
  importSshConfigAliases: (
    aliases: string[]
  ) => Promise<SshConnectionsSnapshot>;
  saveSshProfile: (request: SshProfileSaveRequest) => SshProfileDto;
  duplicateSshProfile: (profileId: Id) => SshProfileDto;
  deleteSshProfile: (profileId: Id) => void;
  testSshProfile: (profileId: Id) => Promise<SshConnectionsSnapshot>;
  rebindSshProfile: (profileId: Id) => Promise<SshConnectionsSnapshot>;
  cleanSshRuntime: (profileId: Id) => Promise<SshRuntimeCleanReport>;
  resetSshRuntime: (profileId: Id) => Promise<SshRuntimeResetReport>;
  prepareSshWorkspace: (
    request: SshWorkspacePrepareRequest
  ) => Promise<SshWorkspacePrepareResult>;
  commitSshWorkspace: (
    request: SshWorkspaceCommitRequest
  ) => Promise<SshWorkspaceOpenResult>;
  cancelSshWorkspacePreparation: (request: SshWorkspaceCancelRequest) => void;
  respondSshAskpass: (request: SshAskpassResponseRequest) => void;
  closeWorkspaceSafely: (workspaceId: Id) => void | Promise<void>;
  closeOtherWorkspacesSafely: (workspaceId: Id) => void | Promise<void>;
  attachTerminalStream: (
    event: IpcMainInvokeEvent,
    surfaceId: Id,
    expectedSessionId: Id
  ) => TerminalStreamAttachResult;
  reportTerminalStreamError: (report: TerminalStreamErrorReport) => void;
  snapshotSurface: (
    surfaceId: Id,
    options?: SurfaceSnapshotOptions
  ) => Promise<SurfaceSnapshotPayload | null>;
  sendText: (surfaceId: Id, text: string) => void;
  sendKeyInput: (surfaceId: Id, input: TerminalKeyInput) => void;
  openExternalUrl: (surfaceId: Id, url: string) => Promise<void>;
  openTerminalFilePath: (
    surfaceId: Id,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  resolveTerminalFileLinks: (
    surfaceId: Id,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult> | TerminalFileLinkResolveResult;
  identify: () => ShellIdentity;
  previewTerminalTypography: (
    settings: TerminalTypographySettings
  ) => Promise<ResolvedTerminalTypographyVm>;
  reportTerminalTypographyProbe: (
    report: TerminalTypographyProbeReport
  ) => void;
  importTerminalThemePalette: (
    window: BrowserWindow | null
  ) => Promise<ImportedTerminalThemePalette | null>;
  exportTerminalThemePalette: (
    window: BrowserWindow | null,
    suggestedName: string,
    palette: TerminalColorPalette
  ) => Promise<boolean>;
  openSettingsJson: () => Promise<void>;
  clearDiagnosticLog: () => boolean | Promise<boolean>;
  isSurfaceDiagnosticsEnabled: () => boolean;
  captureSurfaceDiagnostics: (surfaceId: Id) => Promise<SurfaceCapturePayload>;
  prepareWorktreeConversion: (
    workspaceId: Id
  ) => Promise<WorktreeConversionPreview | null>;
  createWorktreeWorkspace: (
    workspaceId: Id,
    name: string
  ) => Promise<WorkspaceWorktreeMetadata>;
  convertDetectedWorktree: (
    workspaceId: Id
  ) => Promise<WorkspaceWorktreeMetadata>;
  removeWorkspaceWorktree: (
    workspaceId: Id,
    force: boolean
  ) => Promise<WorktreeRemoveResult>;
  removeWorkspaceWorktrees: (
    workspaceIds: Id[],
    force: boolean
  ) => Promise<WorktreeBulkRemoveResult>;
  setUsageDashboardOpen: (open: boolean) => void;
  downloadAvailableUpdate: () => Promise<void>;
  installDownloadedUpdate: () => void;
  clipboard?: MainClipboardService;
  recordProfileEvent?: (event: SmoothnessProfileEvent) => void;
  recordProfileEvents?: (events: SmoothnessProfileEvent[]) => void;
}

export function registerIpcHandlers(options: IpcHandlersOptions): void {
  const clipboardService = options.clipboard ?? createMainClipboardService();

  ipcMain.handle("kmux:platform:get", () => options.getPlatformDescriptor());
  ipcMain.handle("kmux:shell:get", () => options.getShellState());
  ipcMain.handle("kmux:usage:get", () => options.getUsageView());
  ipcMain.handle("kmux:external-sessions:get", () =>
    options.getExternalAgentSessions()
  );
  ipcMain.handle("kmux:external-sessions:resume", (_event, key: string) =>
    options.resumeExternalAgentSession(key)
  );
  ipcMain.handle(
    "kmux:image-attachments:create",
    (_event, surfaceId: Id, payloads: CreateImageAttachmentPayload[]) =>
      options.createImageAttachments(surfaceId, payloads)
  );
  ipcMain.handle("kmux:clipboard:read-text", () => clipboardService.readText());
  ipcMain.handle("kmux:clipboard:write-text", (_event, text: string) => {
    clipboardService.writeText(text);
  });
  ipcMain.handle("kmux:clipboard:read-images", () =>
    clipboardService.readImages()
  );
  ipcMain.handle("kmux:clipboard:has-pasteable-content", () =>
    clipboardService.hasPasteableContent()
  );
  ipcMain.handle("kmux:updater:get", () => options.getUpdaterState());
  ipcMain.handle("kmux:dispatch", (event, action: unknown) => {
    assertTrustedMainFrame(event, "renderer dispatch");
    return options.dispatchRendererAction(action);
  });
  ipcMain.handle("kmux:remote-retained-sessions:get", (event) => {
    assertTrustedMainFrame(event, "retained-session inventory");
    return options.getRetainedRemoteSessions();
  });
  ipcMain.handle(
    "kmux:remote-retained-sessions:terminate",
    (event, resourceKey: RetainedRemoteSessionResourceKey) => {
      assertTrustedMainFrame(event, "retained-session termination");
      return options.terminateRetainedRemoteSession(resourceKey);
    }
  );
  ipcMain.handle(
    "kmux:ssh-connections:get",
    (event, resolveEffective: boolean) => {
      assertTrustedMainFrame(event, "SSH connection listing");
      return options.getSshConnections(resolveEffective === true);
    }
  );
  ipcMain.handle("kmux:ssh-connections:aliases", (event) => {
    assertTrustedMainFrame(event, "OpenSSH alias listing");
    return options.listSshConfigAliases();
  });
  ipcMain.handle(
    "kmux:ssh-connections:import-aliases",
    (event, aliases: string[]) => {
      assertTrustedMainFrame(event, "OpenSSH alias import");
      return options.importSshConfigAliases(aliases);
    }
  );
  ipcMain.handle(
    "kmux:ssh-connections:save",
    (event, request: SshProfileSaveRequest) => {
      assertTrustedMainFrame(event, "SSH connection save");
      return options.saveSshProfile(request);
    }
  );
  ipcMain.handle(
    "kmux:ssh-connections:duplicate",
    (event, profileId: Id) => {
      assertTrustedMainFrame(event, "SSH connection duplicate");
      return options.duplicateSshProfile(profileId);
    }
  );
  ipcMain.handle("kmux:ssh-connections:delete", (event, profileId: Id) => {
    assertTrustedMainFrame(event, "SSH connection delete");
    options.deleteSshProfile(profileId);
  });
  ipcMain.handle("kmux:ssh-connections:test", (event, profileId: Id) => {
    assertTrustedMainFrame(event, "SSH connection test");
    return options.testSshProfile(profileId);
  });
  ipcMain.handle("kmux:ssh-connections:rebind", (event, profileId: Id) => {
    assertTrustedMainFrame(event, "SSH connection rebind");
    return options.rebindSshProfile(profileId);
  });
  ipcMain.handle("kmux:ssh-connections:runtime-clean", (event, profileId: Id) => {
    assertTrustedMainFrame(event, "SSH runtime clean");
    return options.cleanSshRuntime(profileId);
  });
  ipcMain.handle("kmux:ssh-connections:runtime-reset", (event, profileId: Id) => {
    assertTrustedMainFrame(event, "SSH runtime reset");
    return options.resetSshRuntime(profileId);
  });
  ipcMain.handle(
    "kmux:ssh-workspace:prepare",
    (event, request: SshWorkspacePrepareRequest) => {
      assertTrustedMainFrame(event, "SSH workspace prepare");
      return options.prepareSshWorkspace(request);
    }
  );
  ipcMain.handle(
    "kmux:ssh-workspace:commit",
    (event, request: SshWorkspaceCommitRequest) => {
      assertTrustedMainFrame(event, "SSH workspace commit");
      return options.commitSshWorkspace(request);
    }
  );
  ipcMain.handle(
    "kmux:ssh-workspace:cancel",
    (event, request: SshWorkspaceCancelRequest) => {
      assertTrustedMainFrame(event, "SSH workspace cancel");
      options.cancelSshWorkspacePreparation(request);
    }
  );
  ipcMain.handle(
    "kmux:ssh-askpass:respond",
    (event, request: SshAskpassResponseRequest) => {
      assertTrustedMainFrame(event, "SSH askpass response");
      options.respondSshAskpass(request);
    }
  );
  ipcMain.handle("kmux:workspace:close-safely", (event, workspaceId: Id) => {
    assertTrustedMainFrame(event, "workspace close");
    return options.closeWorkspaceSafely(workspaceId);
  });
  ipcMain.handle(
    "kmux:workspace:close-others-safely",
    (event, workspaceId: Id) => {
      assertTrustedMainFrame(event, "workspace close-others");
      return options.closeOtherWorkspacesSafely(workspaceId);
    }
  );
  ipcMain.handle("kmux:usage:dashboard-open", (_event, open: boolean) => {
    options.setUsageDashboardOpen(Boolean(open));
  });
  ipcMain.handle("kmux:updater:download", () =>
    options.downloadAvailableUpdate()
  );
  ipcMain.handle("kmux:updater:install", () => {
    options.installDownloadedUpdate();
  });
  ipcMain.handle(
    "kmux:profile:event",
    (_event, event: SmoothnessProfileEvent) => {
      options.recordProfileEvent?.(event);
    }
  );
  ipcMain.handle(
    "kmux:profile:events",
    (_event, events: SmoothnessProfileEvent[]) => {
      if (Array.isArray(events)) {
        options.recordProfileEvents?.(events.slice(0, 256));
      }
    }
  );
  ipcMain.handle(
    "kmux:terminal-stream:attach",
    (event, surfaceId: Id, expectedSessionId: Id) =>
      options.attachTerminalStream(event, surfaceId, expectedSessionId)
  );
  ipcMain.handle(
    "kmux:terminal-stream:report-error",
    (_event, report: unknown) => {
      const normalized = normalizeTerminalStreamErrorReport(report);
      if (!normalized) {
        throw new Error("Invalid terminal stream error report");
      }
      options.reportTerminalStreamError(normalized);
    }
  );
  ipcMain.handle(
    "kmux:snapshot-surface",
    async (
      _event,
      surfaceId: Id,
      snapshotOptions?: SurfaceSnapshotOptions
    ): Promise<SurfaceSnapshotPayload | null> =>
      options.snapshotSurface(surfaceId, snapshotOptions)
  );
  ipcMain.handle("kmux:terminal:text", (_event, surfaceId: Id, text: string) =>
    options.sendText(surfaceId, text)
  );
  ipcMain.handle(
    "kmux:terminal:key",
    (_event, surfaceId: Id, input: TerminalKeyInput) => {
      options.sendKeyInput(surfaceId, input);
    }
  );
  ipcMain.handle(
    "kmux:external-url:open",
    async (event, surfaceId: Id, url: string) => {
      await options.openExternalUrl(surfaceId, url);
      event.sender.send("kmux:external-url:opened", url);
    }
  );
  ipcMain.handle(
    "kmux:terminal-file:open",
    (_event, surfaceId: Id, rawPath: string, baseCwd?: string) =>
      options.openTerminalFilePath(surfaceId, rawPath, baseCwd)
  );
  ipcMain.handle(
    "kmux:terminal-file-links:resolve",
    (_event, surfaceId: Id, candidates: TerminalFileLinkResolveCandidate[]) =>
      options.resolveTerminalFileLinks(surfaceId, candidates)
  );
  ipcMain.handle(
    "kmux:terminal-typography:preview",
    (_event, settings: TerminalTypographySettings) =>
      options.previewTerminalTypography(settings)
  );
  ipcMain.handle(
    "kmux:terminal-typography:probe-report",
    (_event, report: TerminalTypographyProbeReport) => {
      options.reportTerminalTypographyProbe(report);
    }
  );
  ipcMain.handle("kmux:terminal-theme:import", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return options.importTerminalThemePalette(window);
  });
  ipcMain.handle(
    "kmux:terminal-theme:export",
    (event, suggestedName: string, palette: TerminalColorPalette) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return options.exportTerminalThemePalette(window, suggestedName, palette);
    }
  );
  ipcMain.handle("kmux:settings-json:open", () => options.openSettingsJson());
  ipcMain.handle("kmux:diagnostics:clear-log", () =>
    options.clearDiagnosticLog()
  );
  ipcMain.handle(
    "kmux:surface-diagnostics:capture",
    async (_event, surfaceId: Id): Promise<SurfaceCapturePayload> => {
      if (!options.isSurfaceDiagnosticsEnabled()) {
        throw new Error("Surface diagnostic capture is disabled");
      }
      return options.captureSurfaceDiagnostics(surfaceId);
    }
  );
  ipcMain.handle(
    "kmux:worktree:prepare-conversion",
    (_event, workspaceId: Id) => options.prepareWorktreeConversion(workspaceId)
  );
  ipcMain.handle(
    "kmux:worktree:create-workspace",
    (_event, payload: { workspaceId: Id; name: string }) =>
      options.createWorktreeWorkspace(payload.workspaceId, payload.name)
  );
  ipcMain.handle("kmux:worktree:convert-detected", (_event, workspaceId: Id) =>
    options.convertDetectedWorktree(workspaceId)
  );
  ipcMain.handle(
    "kmux:worktree:remove",
    (_event, payload: { workspaceId: Id; force: boolean }) =>
      options.removeWorkspaceWorktree(
        payload.workspaceId,
        payload.force === true
      )
  );
  ipcMain.handle(
    "kmux:worktree:remove-many",
    (_event, payload: { workspaceIds: Id[]; force: boolean }) =>
      options.removeWorkspaceWorktrees(
        Array.isArray(payload.workspaceIds) ? payload.workspaceIds : [],
        payload.force === true
      )
  );
  ipcMain.handle(
    "kmux:window-control",
    (event, action: "minimize" | "maximize" | "fullscreen" | "close") => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return;
      }
      if (action === "minimize") {
        window.minimize();
      } else if (action === "fullscreen") {
        window.setFullScreen(!window.isFullScreen());
      } else if (action === "maximize") {
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
      } else {
        window.close();
      }
    }
  );
  ipcMain.handle(
    "kmux:surface-context-menu",
    async (
      event,
      payload: {
        surfaceId: Id;
        x: number;
        y: number;
        context: SurfaceContextMenuContext;
      }
    ): Promise<void> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return;
      }

      const keyboardPolicy = options.getPlatformDescriptor().keyboard;
      const menu = buildNativeSurfaceContextMenu({
        surfaceId: payload.surfaceId,
        context: {
          ...payload.context,
          diagnosticsEnabled: options.isSurfaceDiagnosticsEnabled()
        },
        reservedSystemChords: keyboardPolicy.reservedSystemChords,
        onAction: (surfaceId, action) => {
          event.sender.send("kmux:surface-context-menu-action", {
            surfaceId,
            action
          });
        }
      });
      if (!menu) {
        return;
      }

      menu.popup({
        window,
        x: Math.round(payload.x),
        y: Math.round(payload.y)
      });
    }
  );
  ipcMain.handle(
    "kmux:workspace-context-menu",
    async (
      event,
      payload: { workspaceId: Id; x: number; y: number }
    ): Promise<boolean> => {
      if (process.env.NODE_ENV === "test") {
        return false;
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      const keyboardPolicy = options.getPlatformDescriptor().keyboard;
      const menu = buildNativeWorkspaceContextMenu({
        workspaceId: payload.workspaceId,
        getContextView: options.getWorkspaceContextView,
        reservedSystemChords: keyboardPolicy.reservedSystemChords,
        openSshWorkspace: (workspaceId) => {
          event.sender.send("kmux:ssh-workspace-open-request", workspaceId);
        },
        convertToWorktree: (workspaceId) => {
          event.sender.send(
            "kmux:workspace-worktree-convert-request",
            workspaceId
          );
        },
        closeWorkspace: (workspaceId) => {
          event.sender.send("kmux:workspace-close-request", workspaceId);
        },
        closeOtherWorkspaces: (workspaceId) => {
          event.sender.send("kmux:workspace-close-others-request", workspaceId);
        },
        rename: (workspaceId) => {
          event.sender.send("kmux:workspace-rename-request", workspaceId);
        },
        dispatch: options.dispatchRendererAction
      });
      if (!window || !menu) {
        return false;
      }

      menu.popup({
        window,
        x: Math.round(payload.x),
        y: Math.round(payload.y)
      });
      return true;
    }
  );
  ipcMain.handle("kmux:identify", (): ShellIdentity => options.identify());
}

function assertTrustedMainFrame(
  event: IpcMainInvokeEvent,
  operation: string
): void {
  const frame = event.senderFrame;
  if (
    !frame ||
    frame !== event.sender.mainFrame ||
    frame.detached ||
    frame.isDestroyed()
  ) {
    throw new Error(`${operation} requires the trusted main frame`);
  }
}
