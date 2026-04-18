import { clipboard, contextBridge, ipcRenderer } from "electron";

import type { AppAction } from "@kmux/core";
import type {
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  ShellIdentity,
  ShellViewModel,
  UsageViewSnapshot,
  SurfaceSnapshotOptions,
  SurfaceChunkPayload,
  SurfaceExitPayload,
  SurfaceSnapshotPayload,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  TerminalKeyInput
} from "@kmux/proto";

export type TerminalEvent =
  | { type: "chunk"; payload: SurfaceChunkPayload }
  | { type: "exit"; payload: SurfaceExitPayload };

const api = {
  getView(): Promise<ShellViewModel> {
    return ipcRenderer.invoke("kmux:view:get");
  },
  getUsageView(): Promise<UsageViewSnapshot> {
    return ipcRenderer.invoke("kmux:usage:get");
  },
  dispatch(action: AppAction): Promise<ShellViewModel> {
    return ipcRenderer.invoke("kmux:dispatch", action);
  },
  subscribeView(listener: (view: ShellViewModel) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, view: ShellViewModel) =>
      listener(view);
    ipcRenderer.on("kmux:view", handler);
    return () => ipcRenderer.off("kmux:view", handler);
  },
  subscribeUsage(listener: (snapshot: UsageViewSnapshot) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: UsageViewSnapshot
    ) => listener(snapshot);
    ipcRenderer.on("kmux:usage", handler);
    return () => ipcRenderer.off("kmux:usage", handler);
  },
  subscribeTerminal(listener: (event: TerminalEvent) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent
    ) => listener(payload);
    ipcRenderer.on("kmux:terminal-event", handler);
    return () => ipcRenderer.off("kmux:terminal-event", handler);
  },
  attachSurface(surfaceId: string): Promise<SurfaceSnapshotPayload | null> {
    return ipcRenderer.invoke("kmux:attach-surface", surfaceId);
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
  resizeSurface(surfaceId: string, cols: number, rows: number): Promise<void> {
    return ipcRenderer.invoke("kmux:terminal:resize", surfaceId, cols, rows);
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
  subscribeWorkspaceRenameRequest(
    listener: (workspaceId: string) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      workspaceId: string
    ) => listener(workspaceId);
    ipcRenderer.on("kmux:workspace-rename-request", handler);
    return () => ipcRenderer.off("kmux:workspace-rename-request", handler);
  },
  identify(): Promise<ShellIdentity> {
    return ipcRenderer.invoke("kmux:identify");
  },
  setUsageDashboardOpen(open: boolean): Promise<void> {
    return ipcRenderer.invoke("kmux:usage:dashboard-open", open);
  }
};

const testApi = {
  snapshotSurface(
    surfaceId: string,
    options?: SurfaceSnapshotOptions
  ): Promise<SurfaceSnapshotPayload | null> {
    return ipcRenderer.invoke("kmux:snapshot-surface", surfaceId, options);
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
