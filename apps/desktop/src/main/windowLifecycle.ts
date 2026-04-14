import {
  app,
  BrowserWindow,
  nativeImage,
  shell,
  type WebContents
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_SIDEBAR_WIDTH } from "@kmux/core";
import type {
  PersistedWindowState,
  WindowStateFileStore
} from "@kmux/persistence";

interface CreateMainWindowOptions {
  currentDir: string;
  loadWindowState: () => PersistedWindowState | null;
  onClose: (window: BrowserWindow) => void;
}

interface PersistWindowStateOptions {
  windowStateStore: WindowStateFileStore;
  window: BrowserWindow;
  getSidebarWidth: () => number | undefined;
}

export function setDevelopmentDockIcon(currentDir: string): void {
  if (process.platform !== "darwin" || app.isPackaged) {
    return;
  }

  const iconIcnsPath = join(currentDir, "../../build/icon.icns");
  const iconPngPath = join(currentDir, "../../build/icon.png");
  const iconPath = existsSync(iconIcnsPath) ? iconIcnsPath : iconPngPath;

  if (!existsSync(iconPath)) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

export function createMainWindow(
  options: CreateMainWindowOptions
): BrowserWindow {
  setDevelopmentDockIcon(options.currentDir);
  const savedWindowState = options.loadWindowState();
  const isMac = process.platform === "darwin";
  const backgroundTestWindow =
    process.env.NODE_ENV === "test" &&
    process.env.KMUX_E2E_WINDOW_MODE === "background";
  const offscreenTestX = -24000;
  const offscreenTestY = 120;
  const window = new BrowserWindow({
    width: savedWindowState?.width ?? 1277,
    height: savedWindowState?.height ?? 1179,
    x: backgroundTestWindow ? offscreenTestX : savedWindowState?.x,
    y: backgroundTestWindow ? offscreenTestY : savedWindowState?.y,
    show: !backgroundTestWindow,
    paintWhenInitiallyHidden: backgroundTestWindow,
    skipTaskbar: backgroundTestWindow,
    minWidth: 1024,
    minHeight: 760,
    frame: false,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? {
          trafficLightPosition: {
            x: 11,
            y: 10
          }
        }
      : {}),
    backgroundColor: "#12110f",
    webPreferences: {
      preload: join(options.currentDir, "../preload/index.mjs"),
      sandbox: false,
      backgroundThrottling: !backgroundTestWindow
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(options.currentDir, "../renderer/index.html"));
  }

  if (isMac) {
    window.setWindowButtonVisibility(true);
  }

  configureWindowWebContents(window.webContents);

  window.once("ready-to-show", () => {
    if (backgroundTestWindow) {
      window.setPosition(offscreenTestX, offscreenTestY);
      window.showInactive();
      return;
    }
    if (savedWindowState?.maximized) {
      window.maximize();
    }
  });
  window.on("close", () => options.onClose(window));

  return window;
}

export function persistWindowState(options: PersistWindowStateOptions): void {
  if (options.window.isDestroyed()) {
    return;
  }
  const bounds = options.window.isMaximized()
    ? options.window.getNormalBounds()
    : options.window.getBounds();
  options.windowStateStore.save({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: options.window.isMaximized(),
    sidebarWidth: options.getSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH
  });
}

function configureWindowWebContents(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("console-message", (details) => {
    console.log(
      `[renderer:${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`
    );
  });
  webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        "[renderer:did-fail-load]",
        errorCode,
        errorDescription,
        validatedURL
      );
    }
  );
}
