import { BrowserWindow, ipcMain } from "electron";

import type { AppAction } from "@kmux/core";
import type {
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  Id,
  ImportedTerminalThemePalette,
  ResolvedTerminalTypographyVm,
  ShellIdentity,
  ShellStoreSnapshot,
  SurfaceAttachCompletionResult,
  SurfaceAttachPayload,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalColorPalette,
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

import { buildNativeWorkspaceContextMenu } from "./workspaceContextMenu";
import type { SmoothnessProfileEvent } from "../shared/smoothnessProfile";
import type { WorkspaceContextView } from "../shared/workspaceContextMenu";

interface IpcHandlersOptions {
  getShellState: () => ShellStoreSnapshot;
  getWorkspaceContextView: () => WorkspaceContextView;
  getUsageView: () => UsageViewSnapshot;
  getExternalAgentSessions: () => ExternalAgentSessionsSnapshot;
  resumeExternalAgentSession: (key: string) => ExternalAgentSessionResumeResult;
  createImageAttachments: (
    surfaceId: Id,
    payloads: CreateImageAttachmentPayload[]
  ) => Promise<CreateImageAttachmentsResult>;
  getUpdaterState: () => UpdaterState;
  dispatchAppAction: (action: AppAction) => void;
  attachSurface: (
    contentsId: number,
    surfaceId: Id
  ) => Promise<SurfaceAttachPayload | null>;
  completeAttachSurface: (
    contentsId: number,
    surfaceId: Id,
    attachId: Id
  ) => Promise<SurfaceAttachCompletionResult>;
  snapshotSurface: (
    surfaceId: Id,
    options?: SurfaceSnapshotOptions
  ) => Promise<SurfaceSnapshotPayload | null>;
  detachSurface: (contentsId: number, surfaceId: Id) => void;
  sendText: (surfaceId: Id, text: string) => void;
  sendKeyInput: (surfaceId: Id, input: TerminalKeyInput) => void;
  openExternalUrl: (url: string) => Promise<void>;
  resizeSurface: (
    contentsId: number,
    surfaceId: Id,
    attachId: Id | null,
    cols: number,
    rows: number
  ) => Promise<void>;
  identify: () => ShellIdentity;
  listTerminalFontFamilies: () => Promise<string[]>;
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
  recordProfileEvent?: (event: SmoothnessProfileEvent) => void;
}

export function registerIpcHandlers(options: IpcHandlersOptions): void {
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
  ipcMain.handle("kmux:updater:get", () => options.getUpdaterState());
  ipcMain.handle("kmux:dispatch", (_event, action: AppAction) => {
    options.dispatchAppAction(action);
  });
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
    "kmux:attach-surface",
    async (event, surfaceId: Id): Promise<SurfaceAttachPayload | null> =>
      options.attachSurface(event.sender.id, surfaceId)
  );
  ipcMain.handle(
    "kmux:attach-surface-complete",
    (
      event,
      surfaceId: Id,
      attachId: Id
    ): Promise<SurfaceAttachCompletionResult> =>
      options.completeAttachSurface(event.sender.id, surfaceId, attachId)
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
  ipcMain.handle("kmux:detach-surface", (event, surfaceId: Id) => {
    options.detachSurface(event.sender.id, surfaceId);
  });
  ipcMain.handle("kmux:terminal:text", (_event, surfaceId: Id, text: string) =>
    options.sendText(surfaceId, text)
  );
  ipcMain.handle(
    "kmux:terminal:key",
    (_event, surfaceId: Id, input: TerminalKeyInput) => {
      options.sendKeyInput(surfaceId, input);
    }
  );
  ipcMain.handle("kmux:external-url:open", async (event, url: string) => {
    await options.openExternalUrl(url);
    event.sender.send("kmux:external-url:opened", url);
  });
  ipcMain.handle(
    "kmux:terminal:resize",
    async (
      event,
      surfaceId: Id,
      attachId: Id | null,
      cols: number,
      rows: number
    ) => {
      await options.resizeSurface(
        event.sender.id,
        surfaceId,
        attachId,
        cols,
        rows
      );
    }
  );
  ipcMain.handle("kmux:terminal-typography:fonts:list", () =>
    options.listTerminalFontFamilies()
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
    "kmux:workspace-context-menu",
    async (
      event,
      payload: { workspaceId: Id; x: number; y: number }
    ): Promise<boolean> => {
      if (process.env.NODE_ENV === "test") {
        return false;
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      const menu = buildNativeWorkspaceContextMenu({
        workspaceId: payload.workspaceId,
        getContextView: options.getWorkspaceContextView,
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
        dispatch: options.dispatchAppAction
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
