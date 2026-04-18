import {BrowserWindow, ipcMain} from "electron";

import type {AppAction} from "@kmux/core";
import type {
  Id,
  ImportedTerminalThemePalette,
  ResolvedTerminalTypographyVm,
  ShellIdentity,
  ShellViewModel,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalColorPalette,
  TerminalKeyInput,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  UsageViewSnapshot
} from "@kmux/proto";

import {buildNativeWorkspaceContextMenu} from "./workspaceContextMenu";

interface IpcHandlersOptions {
  getView: () => ShellViewModel;
  getUsageView: () => UsageViewSnapshot;
  dispatchAppAction: (action: AppAction) => void;
  attachSurface: (
    contentsId: number,
    surfaceId: Id
  ) => Promise<SurfaceSnapshotPayload | null>;
  snapshotSurface: (
    surfaceId: Id,
    options?: SurfaceSnapshotOptions
  ) => Promise<SurfaceSnapshotPayload | null>;
  detachSurface: (contentsId: number, surfaceId: Id) => void;
  sendText: (surfaceId: Id, text: string) => void;
  sendKeyInput: (surfaceId: Id, input: TerminalKeyInput) => void;
  resizeSurface: (surfaceId: Id, cols: number, rows: number) => void;
  identify: () => ShellIdentity;
  listTerminalFontFamilies: () => Promise<string[]>;
  previewTerminalTypography: (
    settings: TerminalTypographySettings
  ) => Promise<ResolvedTerminalTypographyVm>;
  reportTerminalTypographyProbe: (report: TerminalTypographyProbeReport) => void;
  importTerminalThemePalette: (
    window: BrowserWindow | null
  ) => Promise<ImportedTerminalThemePalette | null>;
  exportTerminalThemePalette: (
    window: BrowserWindow | null,
    suggestedName: string,
    palette: TerminalColorPalette
  ) => Promise<boolean>;
  setUsageDashboardOpen: (open: boolean) => void;
}

export function registerIpcHandlers(options: IpcHandlersOptions): void {
  ipcMain.handle("kmux:view:get", () => options.getView());
  ipcMain.handle("kmux:usage:get", () => options.getUsageView());
  ipcMain.handle("kmux:dispatch", (_event, action: AppAction) => {
    options.dispatchAppAction(action);
    return options.getView();
  });
  ipcMain.handle("kmux:usage:dashboard-open", (_event, open: boolean) => {
    options.setUsageDashboardOpen(Boolean(open));
  });
  ipcMain.handle(
    "kmux:attach-surface",
    async (event, surfaceId: Id): Promise<SurfaceSnapshotPayload | null> =>
      options.attachSurface(event.sender.id, surfaceId)
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
  ipcMain.handle(
    "kmux:terminal:resize",
    (_event, surfaceId: Id, cols: number, rows: number) => {
      options.resizeSurface(surfaceId, cols, rows);
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
        getView: options.getView,
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
