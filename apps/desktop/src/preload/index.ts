import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { AppAction } from "@kmux/core";
import type { RendererPlatformDescriptor } from "../shared/platform/rendererPlatform";
import {
  KMUX_TERMINAL_PORT_CHANNEL,
  KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
  type TerminalStreamAttachResult,
  type TerminalStreamGrant
} from "../shared/terminalPort";
import type { SmoothnessProfileEvent } from "../shared/smoothnessProfile";
import type {
  SurfaceContextAction,
  SurfaceContextMenuContext
} from "../shared/surfaceContextMenu";
import {
  KMUX_PROFILE_LOG_PATH_ENV,
  isSmoothnessProfileEnabled
} from "../shared/smoothnessProfile";
import type {
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  UsageViewSnapshot,
  SurfaceCapturePayload,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  TerminalKeyInput,
  UpdaterState,
  WorktreeBulkRemoveResult,
  WorktreeConversionPreview,
  WorktreeRemoveResult,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";

ipcRenderer.on(
  KMUX_TERMINAL_PORT_CHANNEL,
  (event, grant: TerminalStreamGrant) => {
    const port = event.ports[0];
    if (!port) {
      return;
    }
    try {
      window.postMessage(
        {
          type: KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
          grant
        },
        "*",
        [port]
      );
    } catch {
      port.close();
    }
  }
);

const api = {
  getPlatform(): Promise<RendererPlatformDescriptor> {
    return ipcRenderer.invoke("kmux:platform:get");
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  getShellState(): Promise<ShellStoreSnapshot> {
    return ipcRenderer.invoke("kmux:shell:get");
  },
  getUsageView(): Promise<UsageViewSnapshot> {
    return ipcRenderer.invoke("kmux:usage:get");
  },
  getExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot> {
    return ipcRenderer.invoke("kmux:external-sessions:get");
  },
  resumeExternalAgentSession(
    key: string
  ): Promise<ExternalAgentSessionResumeResult> {
    return ipcRenderer.invoke("kmux:external-sessions:resume", key);
  },
  getUpdaterState(): Promise<UpdaterState> {
    return ipcRenderer.invoke("kmux:updater:get");
  },
  dispatch(action: AppAction): Promise<void> {
    return ipcRenderer.invoke("kmux:dispatch", action);
  },
  subscribeShellPatches(listener: (patch: ShellPatch) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, patch: ShellPatch) =>
      listener(patch);
    ipcRenderer.on("kmux:shell-patch", handler);
    return () => ipcRenderer.off("kmux:shell-patch", handler);
  },
  subscribeUsage(listener: (snapshot: UsageViewSnapshot) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: UsageViewSnapshot
    ) => listener(snapshot);
    ipcRenderer.on("kmux:usage", handler);
    return () => ipcRenderer.off("kmux:usage", handler);
  },
  subscribeUpdater(listener: (state: UpdaterState) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdaterState) =>
      listener(state);
    ipcRenderer.on("kmux:updater", handler);
    return () => ipcRenderer.off("kmux:updater", handler);
  },
  attachTerminalStream(
    surfaceId: string,
    expectedSessionId: string
  ): Promise<TerminalStreamAttachResult> {
    return ipcRenderer.invoke(
      "kmux:terminal-stream:attach",
      surfaceId,
      expectedSessionId
    );
  },
  sendText(surfaceId: string, text: string): Promise<void> {
    return ipcRenderer.invoke("kmux:terminal:text", surfaceId, text);
  },
  sendKey(surfaceId: string, input: TerminalKeyInput): Promise<void> {
    return ipcRenderer.invoke("kmux:terminal:key", surfaceId, input);
  },
  openExternalUrl(url: string): Promise<void> {
    return ipcRenderer.invoke("kmux:external-url:open", url);
  },
  openTerminalFilePath(
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ): Promise<void> {
    return ipcRenderer.invoke(
      "kmux:terminal-file:open",
      surfaceId,
      rawPath,
      baseCwd
    );
  },
  resolveTerminalFileLinks(
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ): Promise<TerminalFileLinkResolveResult> {
    return ipcRenderer.invoke(
      "kmux:terminal-file-links:resolve",
      surfaceId,
      candidates
    );
  },
  createImageAttachments(
    surfaceId: string,
    payloads: CreateImageAttachmentPayload[]
  ): Promise<CreateImageAttachmentsResult> {
    return ipcRenderer.invoke(
      "kmux:image-attachments:create",
      surfaceId,
      payloads
    );
  },
  readClipboardImages(): Promise<CreateImageAttachmentPayload[]> {
    return ipcRenderer.invoke("kmux:clipboard:read-images");
  },
  hasPasteableClipboardContent(): Promise<boolean> {
    return ipcRenderer.invoke("kmux:clipboard:has-pasteable-content");
  },
  previewTerminalTypography(
    settings: TerminalTypographySettings
  ): Promise<ResolvedTerminalTypographyVm> {
    return ipcRenderer.invoke("kmux:terminal-typography:preview", settings);
  },
  reportTerminalTypographyProbe(
    report: TerminalTypographyProbeReport
  ): Promise<void> {
    return ipcRenderer.invoke("kmux:terminal-typography:probe-report", report);
  },
  importTerminalThemePalette(): Promise<ImportedTerminalThemePalette | null> {
    return ipcRenderer.invoke("kmux:terminal-theme:import");
  },
  exportTerminalThemePalette(
    suggestedName: string,
    palette: TerminalColorPalette
  ): Promise<boolean> {
    return ipcRenderer.invoke(
      "kmux:terminal-theme:export",
      suggestedName,
      palette
    );
  },
  openSettingsJson(): Promise<void> {
    return ipcRenderer.invoke("kmux:settings-json:open");
  },
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("kmux:clipboard:read-text");
  },
  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke("kmux:clipboard:write-text", text);
  },
  windowControl(
    action: "minimize" | "maximize" | "fullscreen" | "close"
  ): Promise<void> {
    return ipcRenderer.invoke("kmux:window-control", action);
  },
  showWorkspaceContextMenu(
    workspaceId: string,
    x: number,
    y: number
  ): Promise<boolean> {
    return ipcRenderer.invoke("kmux:workspace-context-menu", {
      workspaceId,
      x,
      y
    });
  },
  captureSurfaceDiagnostics(surfaceId: string): Promise<SurfaceCapturePayload> {
    return ipcRenderer.invoke("kmux:surface-diagnostics:capture", surfaceId);
  },
  showSurfaceContextMenu(
    surfaceId: string,
    x: number,
    y: number,
    context: SurfaceContextMenuContext
  ): Promise<void> {
    return ipcRenderer.invoke("kmux:surface-context-menu", {
      surfaceId,
      x,
      y,
      context
    });
  },
  subscribeSurfaceContextMenuAction(
    listener: (event: {
      surfaceId: string;
      action: SurfaceContextAction;
    }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { surfaceId: string; action: SurfaceContextAction }
    ) => listener(payload);
    ipcRenderer.on("kmux:surface-context-menu-action", handler);
    return () => ipcRenderer.off("kmux:surface-context-menu-action", handler);
  },
  subscribeWorkspaceRenameRequest(
    listener: (workspaceId: string) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) =>
      listener(workspaceId);
    ipcRenderer.on("kmux:workspace-rename-request", handler);
    return () => ipcRenderer.off("kmux:workspace-rename-request", handler);
  },
  subscribeWorkspaceCloseRequest(
    listener: (workspaceId: string) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) =>
      listener(workspaceId);
    ipcRenderer.on("kmux:workspace-close-request", handler);
    return () => ipcRenderer.off("kmux:workspace-close-request", handler);
  },
  subscribeWorkspaceCloseOthersRequest(
    listener: (workspaceId: string) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) =>
      listener(workspaceId);
    ipcRenderer.on("kmux:workspace-close-others-request", handler);
    return () =>
      ipcRenderer.off("kmux:workspace-close-others-request", handler);
  },
  subscribeWorkspaceWorktreeConvertRequest(
    listener: (workspaceId: string) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) =>
      listener(workspaceId);
    ipcRenderer.on("kmux:workspace-worktree-convert-request", handler);
    return () =>
      ipcRenderer.off("kmux:workspace-worktree-convert-request", handler);
  },
  prepareWorktreeConversion(
    workspaceId: string
  ): Promise<WorktreeConversionPreview | null> {
    return ipcRenderer.invoke("kmux:worktree:prepare-conversion", workspaceId);
  },
  createWorktreeWorkspace(
    workspaceId: string,
    name: string
  ): Promise<WorkspaceWorktreeMetadata> {
    return ipcRenderer.invoke("kmux:worktree:create-workspace", {
      workspaceId,
      name
    });
  },
  convertDetectedWorktree(
    workspaceId: string
  ): Promise<WorkspaceWorktreeMetadata> {
    return ipcRenderer.invoke("kmux:worktree:convert-detected", workspaceId);
  },
  removeWorkspaceWorktree(
    workspaceId: string,
    force: boolean
  ): Promise<WorktreeRemoveResult> {
    return ipcRenderer.invoke("kmux:worktree:remove", {
      workspaceId,
      force
    });
  },
  removeWorkspaceWorktrees(
    workspaceIds: string[],
    force: boolean
  ): Promise<WorktreeBulkRemoveResult> {
    return ipcRenderer.invoke("kmux:worktree:remove-many", {
      workspaceIds,
      force
    });
  },
  identify(): Promise<ShellIdentity> {
    return ipcRenderer.invoke("kmux:identify");
  },
  setUsageDashboardOpen(open: boolean): Promise<void> {
    return ipcRenderer.invoke("kmux:usage:dashboard-open", open);
  },
  downloadAvailableUpdate(): Promise<void> {
    return ipcRenderer.invoke("kmux:updater:download");
  },
  installDownloadedUpdate(): Promise<void> {
    return ipcRenderer.invoke("kmux:updater:install");
  },
  profileSmoothnessEnabled(): boolean {
    return isSmoothnessProfileEnabled({
      [KMUX_PROFILE_LOG_PATH_ENV]: process.env[KMUX_PROFILE_LOG_PATH_ENV]
    });
  },
  recordSmoothnessProfileEvent(event: SmoothnessProfileEvent): Promise<void> {
    return ipcRenderer.invoke("kmux:profile:event", event);
  },
  recordSmoothnessProfileEvents(
    events: SmoothnessProfileEvent[]
  ): Promise<void> {
    return ipcRenderer.invoke("kmux:profile:events", events);
  }
};

const testApi = {
  getRuntimeEnv(): Record<string, string> {
    return {
      APPIMAGE: process.env.APPIMAGE ?? "",
      APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? "",
      KMUX_PACKAGED_EXECUTABLE_PATH:
        process.env.KMUX_PACKAGED_EXECUTABLE_PATH ?? ""
    };
  },
  snapshotSurface(
    surfaceId: string,
    options?: SurfaceSnapshotOptions
  ): Promise<SurfaceSnapshotPayload | null> {
    return ipcRenderer.invoke("kmux:snapshot-surface", surfaceId, options);
  },
  subscribeExternalUrlOpen(listener: (url: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, url: string) =>
      listener(url);
    ipcRenderer.on("kmux:external-url:opened", handler);
    return () => ipcRenderer.off("kmux:external-url:opened", handler);
  }
};

contextBridge.exposeInMainWorld("kmux", api);
if (
  process.env.NODE_ENV === "test" ||
  process.env.KMUX_ENABLE_TEST_API === "1"
) {
  // Keep renderer inspection helpers off the production bridge surface.
  contextBridge.exposeInMainWorld("kmuxTest", testApi);
}
