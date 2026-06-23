import {
  app,
  BrowserWindow,
  nativeImage,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_SIDEBAR_WIDTH } from "@kmux/core";
import type {
  PersistedWindowState,
  WindowStateFileStore
} from "@kmux/persistence";
import type { MainWindowPlatformPolicy } from "./platform/runtime";

interface CreateMainWindowOptions {
  currentDir: string;
  loadWindowState: () => PersistedWindowState | null;
  onClose: (window: BrowserWindow) => void;
  platform: MainWindowPlatformPolicy;
}

interface PersistWindowStateOptions {
  windowStateStore: WindowStateFileStore;
  window: BrowserWindow;
  getSidebarVisible: () => boolean | undefined;
  getSidebarWidth: () => number | undefined;
}

export function setDevelopmentDockIcon(
  currentDir: string,
  platform: { supportsDock: boolean }
): void {
  if (!platform.supportsDock || app.isPackaged) {
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
  setDevelopmentDockIcon(options.currentDir, {
    supportsDock: options.platform.supportsDock
  });
  const savedWindowState = options.loadWindowState();
  const window = new BrowserWindow(
    buildMainWindowBrowserOptions({
      currentDir: options.currentDir,
      savedWindowState,
      platform: options.platform,
      env: process.env
    })
  );

  const backgroundTestWindow = isBackgroundTestWindow(process.env);
  const offscreenTestPosition = getOffscreenTestPosition();

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(options.currentDir, "../renderer/index.html"));
  }

  if (options.platform.isMac) {
    window.setWindowButtonVisibility(true);
  }

  configureWindowWebContents(window.webContents);

  window.once("ready-to-show", () => {
    if (backgroundTestWindow) {
      window.setPosition(offscreenTestPosition.x, offscreenTestPosition.y);
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

export function buildMainWindowBrowserOptions(options: {
  currentDir: string;
  savedWindowState: PersistedWindowState | null;
  platform: MainWindowPlatformPolicy;
  env?: NodeJS.ProcessEnv;
}): BrowserWindowConstructorOptions {
  const backgroundTestWindow = isBackgroundTestWindow(options.env ?? {});
  const offscreenTestPosition = getOffscreenTestPosition();
  const useNativeFrame =
    options.platform.windowChrome === "native" && !options.platform.isMac;
  const browserOptions: BrowserWindowConstructorOptions = {
    width: options.savedWindowState?.width ?? 1277,
    height: options.savedWindowState?.height ?? 1179,
    x: backgroundTestWindow
      ? offscreenTestPosition.x
      : options.savedWindowState?.x,
    y: backgroundTestWindow
      ? offscreenTestPosition.y
      : options.savedWindowState?.y,
    show: !backgroundTestWindow,
    paintWhenInitiallyHidden: backgroundTestWindow,
    skipTaskbar: backgroundTestWindow,
    minWidth: 1024,
    minHeight: 760,
    frame: useNativeFrame,
    backgroundColor: "#12110f",
    webPreferences: {
      preload: join(options.currentDir, "../preload/index.mjs"),
      sandbox: false,
      backgroundThrottling: false
    }
  };

  if (options.platform.isMac) {
    browserOptions.frame = false;
    browserOptions.titleBarStyle = "hiddenInset";
    browserOptions.trafficLightPosition = {
      x: 11,
      y: 10
    };
  } else if (!useNativeFrame) {
    browserOptions.titleBarStyle = "hidden";
  }

  return browserOptions;
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
    sidebarVisible: options.getSidebarVisible(),
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

function isBackgroundTestWindow(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test" && env.KMUX_E2E_WINDOW_MODE === "background";
}

function getOffscreenTestPosition(): { x: number; y: number } {
  return { x: -24000, y: 120 };
}
