import { clipboard, contextBridge, ipcRenderer } from "electron";
import { readFileSync, statSync } from "node:fs";

import type { AppAction } from "@kmux/core";
import type { SmoothnessProfileEvent } from "../shared/smoothnessProfile";
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
  SurfaceAttachCompletionResult,
  SurfaceAttachPayload,
  SurfaceCapturePayload,
  SurfaceSnapshotOptions,
  SurfaceChunkPayload,
  SurfaceResizePayload,
  SurfaceExitPayload,
  SurfaceSnapshotPayload,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  TerminalKeyInput,
  UpdaterState,
  WorktreeBulkRemoveResult,
  WorktreeConversionPreview,
  WorktreeRemoveResult,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import {
  collectClipboardImagePayloads,
  parseClipboardFileUrls
} from "./clipboardImages";

export type TerminalEvent =
  | { type: "chunk"; payload: SurfaceChunkPayload }
  | { type: "resize"; payload: SurfaceResizePayload }
  | { type: "exit"; payload: SurfaceExitPayload };

const api = {
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
  subscribeTerminal(listener: (event: TerminalEvent) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent
    ) => listener(payload);
    ipcRenderer.on("kmux:terminal-event", handler);
    return () => ipcRenderer.off("kmux:terminal-event", handler);
  },
  attachSurface(surfaceId: string): Promise<SurfaceAttachPayload | null> {
    return ipcRenderer.invoke("kmux:attach-surface", surfaceId);
  },
  completeAttachSurface(
    surfaceId: string,
    attachId: string
  ): Promise<SurfaceAttachCompletionResult> {
    return ipcRenderer.invoke(
      "kmux:attach-surface-complete",
      surfaceId,
      attachId
    );
  },
  detachSurface(surfaceId: string): Promise<void> {
    return ipcRenderer.invoke("kmux:detach-surface", surfaceId);
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
  readClipboardImages(): CreateImageAttachmentPayload[] {
    return collectClipboardImagePayloads({
      readNativeImagePng: () => {
        const image = clipboard.readImage();
        if (!image.isEmpty()) {
          const png = image.toPNG();
          return new Uint8Array(
            png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
          );
        }
        return readClipboardBuffer("public/png");
      },
      readFileUrls: () => {
        const bookmark = clipboard.readBookmark();
        const knownFormats = [
          readClipboardFormat("public/file-url"),
          readClipboardFormat("public/url"),
          readClipboardFormat("text/uri-list")
        ];
        const discoveredFormats = clipboard
          .availableFormats()
          .filter((format) => /file-url|uri-list|\burl\b/i.test(format))
          .map(readClipboardFormat);
        return parseClipboardFileUrls({
          bookmarkUrl: bookmark.url,
          rawValues: [...knownFormats, ...discoveredFormats]
        });
      },
      readFileSize: (path) => {
        try {
          return statSync(path).size;
        } catch {
          return null;
        }
      },
      readFileBytes: (path) => {
        try {
          return new Uint8Array(readFileSync(path));
        } catch {
          return null;
        }
      }
    });
  },
  resizeSurface(
    surfaceId: string,
    attachId: string | null,
    cols: number,
    rows: number
  ): Promise<void> {
    return ipcRenderer.invoke(
      "kmux:terminal:resize",
      surfaceId,
      attachId,
      cols,
      rows
    );
  },
  listTerminalFontFamilies(): Promise<string[]> {
    return ipcRenderer.invoke("kmux:terminal-typography:fonts:list");
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
  readClipboardText(): string {
    return clipboard.readText();
  },
  writeClipboardText(text: string): void {
    clipboard.writeText(text);
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
    y: number
  ): Promise<boolean> {
    return ipcRenderer.invoke("kmux:surface-context-menu", {
      surfaceId,
      x,
      y
    });
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
  }
};

function readClipboardFormat(format: string): string {
  try {
    return clipboard.read(format);
  } catch {
    return "";
  }
}

function readClipboardBuffer(format: string): Uint8Array | null {
  try {
    const buffer = clipboard.readBuffer(format);
    if (!buffer.byteLength) {
      return null;
    }
    return new Uint8Array(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      )
    );
  } catch {
    return null;
  }
}

const testApi = {
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
