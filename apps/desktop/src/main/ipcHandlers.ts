import {BrowserWindow, ipcMain} from "electron";

import type {AppAction} from "@kmux/core";
import type {Id, ShellIdentity, ShellViewModel, SurfaceSnapshotPayload, TerminalKeyInput} from "@kmux/proto";

import {buildNativeWorkspaceContextMenu} from "./workspaceContextMenu";

interface IpcHandlersOptions {
  getView: () => ShellViewModel;
  dispatchAppAction: (action: AppAction) => void;
  attachSurface: (
    contentsId: number,
    surfaceId: Id
  ) => Promise<SurfaceSnapshotPayload | null>;
  detachSurface: (contentsId: number, surfaceId: Id) => void;
  sendText: (surfaceId: Id, text: string) => void;
  sendKeyInput: (surfaceId: Id, input: TerminalKeyInput) => void;
  resizeSurface: (surfaceId: Id, cols: number, rows: number) => void;
  identify: () => ShellIdentity;
}

export function registerIpcHandlers(options: IpcHandlersOptions): void {
  ipcMain.handle("kmux:view:get", () => options.getView());
  ipcMain.handle("kmux:dispatch", (_event, action: AppAction) => {
    options.dispatchAppAction(action);
    return options.getView();
  });
  ipcMain.handle(
    "kmux:attach-surface",
    async (event, surfaceId: Id): Promise<SurfaceSnapshotPayload | null> =>
      options.attachSurface(event.sender.id, surfaceId)
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
