import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  cloneState,
  createDefaultSettings,
  createInitialState,
  type AppAction,
  type AppEffect
} from "@kmux/core";
import { resolveGitBranch, resolveListeningPorts } from "@kmux/metadata";
import type {
  Id,
  PtyEvent,
  ShellIdentity,
  SurfaceChunkPayload,
  SurfaceExitPayload,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import {
  defaultAppPaths,
  createSettingsStore,
  KmuxDatabase
} from "@kmux/persistence";

import { AppStore } from "./store";
import { PtyHostManager } from "./ptyHost";
import { KmuxSocketServer } from "./socketServer";

const paths = defaultAppPaths(homedir(), process.env);
const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let db: KmuxDatabase | null = null;
let store: AppStore | null = null;
let ptyHost: PtyHostManager | null = null;
let socketServer: KmuxSocketServer | null = null;
let settingsStore = createSettingsStore(paths.settingsPath);
let persistTimer: NodeJS.Timeout | null = null;
const attachedSurfacesByContents = new Map<number, Set<Id>>();

function getState() {
  if (!store) {
    throw new Error("Store not ready");
  }
  return store.getState();
}

function getView() {
  if (!store) {
    throw new Error("Store not ready");
  }
  return store.getView();
}

function broadcastView(): void {
  const view = getView();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("kmux:view", view);
    window.setTitle(view.title);
  }
}

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    if (!db || !store) {
      return;
    }
    db.saveSnapshot(store.getState());
    settingsStore.save(store.getState().settings);
  }, 300);
}

function refreshMetadata(surfaceId: Id, cwd?: string, pid?: number): void {
  void (async () => {
    const [branch, ports] = await Promise.all([
      resolveGitBranch(cwd),
      resolveListeningPorts(pid)
    ]);
    store?.dispatch({
      type: "surface.metadata",
      surfaceId,
      branch: branch ?? undefined,
      ports
    });
  })();
}

function surfaceSessionId(surfaceId: Id): Id | null {
  const surface = getState().surfaces[surfaceId];
  return surface ? surface.sessionId : null;
}

function sendText(surfaceId: Id, text: string): void {
  const sessionId = surfaceSessionId(surfaceId);
  if (sessionId) {
    ptyHost?.sendText(sessionId, text);
  }
}

function sendKey(surfaceId: Id, key: string): void {
  const sessionId = surfaceSessionId(surfaceId);
  if (!sessionId) {
    return;
  }
  const input: TerminalKeyInput = {
    key
  };
  ptyHost?.sendKey(sessionId, input);
}

function handlePtyEvent(event: PtyEvent): void {
  if (!store) {
    return;
  }
  switch (event.type) {
    case "spawned":
      store.dispatch({
        type: "session.started",
        sessionId: event.sessionId,
        pid: event.pid
      });
      return;
    case "metadata":
      store.dispatch({
        type: "surface.metadata",
        surfaceId: event.payload.surfaceId,
        cwd: event.payload.cwd,
        title: event.payload.title,
        attention: event.payload.attention,
        unreadDelta: event.payload.unreadDelta
      });
      refreshMetadata(
        event.payload.surfaceId,
        event.payload.cwd,
        getState().sessions[
          getState().surfaces[event.payload.surfaceId]?.sessionId ?? ""
        ]?.pid
      );
      return;
    case "bell":
      if (!getState().surfaces[event.surfaceId]) {
        return;
      }
      if (!getState().panes[getState().surfaces[event.surfaceId].paneId]) {
        return;
      }
      store.dispatch({
        type: "notification.create",
        workspaceId:
          getState().panes[getState().surfaces[event.surfaceId].paneId]
            .workspaceId,
        paneId: getState().surfaces[event.surfaceId].paneId,
        surfaceId: event.surfaceId,
        title: event.title,
        message: event.cwd ?? "Bell received",
        source: "bell"
      });
      return;
    case "chunk":
      forwardTerminalChunk(event.payload);
      return;
    case "exit":
      store.dispatch({
        type: "session.exited",
        sessionId: event.payload.sessionId,
        exitCode: event.payload.exitCode
      });
      forwardTerminalExit(event.payload);
      return;
    case "error":
      console.error("[pty-host]", event.message);
      return;
    default:
      return;
  }
}

function forwardTerminalChunk(payload: SurfaceChunkPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const attached = attachedSurfacesByContents.get(window.webContents.id);
    if (attached?.has(payload.surfaceId)) {
      window.webContents.send("kmux:terminal-event", {
        type: "chunk",
        payload
      });
    }
  }
}

function forwardTerminalExit(payload: SurfaceExitPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("kmux:terminal-event", {
      type: "exit",
      payload
    });
  }
}

function runEffects(effects: AppEffect[]): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "session.spawn":
        ptyHost?.send({
          type: "spawn",
          spec: {
            ...effect.spec,
            env: {
              ...effect.spec.env,
              KMUX_SOCKET_PATH: paths.socketPath
            }
          }
        });
        break;
      case "session.close":
        ptyHost?.send({
          type: "close",
          sessionId: effect.sessionId
        });
        break;
      case "metadata.refresh":
        refreshMetadata(effect.surfaceId ?? "", effect.cwd, effect.pid);
        break;
      case "notify.desktop":
        if (getState().settings.notificationDesktop) {
          new Notification({
            title: effect.notification.title,
            body: effect.notification.message
          }).show();
        }
        break;
      case "persist":
        schedulePersist();
        break;
      default:
        break;
    }
  }
  broadcastView();
}

function createMainWindow(): BrowserWindow {
  const savedWindowState = db?.loadWindowState();
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
      preload: join(currentDir, "../preload/index.mjs"),
      sandbox: false,
      backgroundThrottling: !backgroundTestWindow
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDir, "../renderer/index.html"));
  }

  if (isMac) {
    window.setWindowButtonVisibility(true);
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("console-message", (details) => {
    console.log(
      `[renderer:${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`
    );
  });
  window.webContents.on(
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
  window.on("close", () => persistWindowState(window));

  return window;
}

function persistWindowState(window: BrowserWindow): void {
  if (!db || window.isDestroyed()) {
    return;
  }
  const bounds = window.isMaximized()
    ? window.getNormalBounds()
    : window.getBounds();
  db.saveWindowState({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: window.isMaximized()
  });
}

function capabilityList(): string[] {
  return [
    "workspace.list",
    "workspace.create",
    "workspace.select",
    "workspace.current",
    "workspace.close",
    "surface.list",
    "surface.split",
    "surface.focus",
    "surface.send_text",
    "surface.send_key",
    "notification.create",
    "notification.list",
    "notification.clear",
    "sidebar.set_status",
    "sidebar.clear_status",
    "sidebar.set_progress",
    "sidebar.clear_progress",
    "sidebar.log",
    "sidebar.clear_log",
    "sidebar.state",
    "sidebar_state",
    "system.ping",
    "system.capabilities",
    "system.identify"
  ];
}

function restoreInitialState(): ReturnType<typeof createInitialState> {
  const snapshot = db?.loadSnapshot();
  const settings = settingsStore.load() ?? createDefaultSettings();
  const initial =
    snapshot && settings.startupRestore
      ? cloneState(snapshot)
      : createInitialState();

  initial.settings = {
    ...initial.settings,
    ...settings,
    shortcuts: {
      ...initial.settings.shortcuts,
      ...settings.shortcuts
    }
  };

  if (settings.startupRestore) {
    for (const session of Object.values(initial.sessions)) {
      if (session.runtimeState !== "exited") {
        session.runtimeState = "pending";
        delete session.pid;
        delete session.exitCode;
      }
    }
  }

  return initial;
}

function registerIpc(): void {
  ipcMain.handle("kmux:view:get", () => getView());
  ipcMain.handle("kmux:dispatch", (_event, action: AppAction) => {
    const effects = store?.dispatch(action) ?? [];
    runEffects(effects);
    return getView();
  });
  ipcMain.handle(
    "kmux:attach-surface",
    async (event, surfaceId: Id): Promise<SurfaceSnapshotPayload | null> => {
      const surface = getState().surfaces[surfaceId];
      if (!surface) {
        return null;
      }
      const attached =
        attachedSurfacesByContents.get(event.sender.id) ?? new Set<Id>();
      attached.add(surfaceId);
      attachedSurfacesByContents.set(event.sender.id, attached);
      ptyHost?.attach(surface.sessionId, surfaceId);
      return (await ptyHost?.snapshot(surface.sessionId, surfaceId)) ?? null;
    }
  );
  ipcMain.handle("kmux:detach-surface", (event, surfaceId: Id) => {
    const surface = getState().surfaces[surfaceId];
    const attached = attachedSurfacesByContents.get(event.sender.id);
    attached?.delete(surfaceId);
    if (surface) {
      ptyHost?.detach(surface.sessionId, surfaceId);
    }
  });
  ipcMain.handle("kmux:terminal:text", (_event, surfaceId: Id, text: string) =>
    sendText(surfaceId, text)
  );
  ipcMain.handle(
    "kmux:terminal:key",
    (_event, surfaceId: Id, input: TerminalKeyInput) => {
      const sessionId = surfaceSessionId(surfaceId);
      if (sessionId) {
        ptyHost?.sendKey(sessionId, input);
      }
    }
  );
  ipcMain.handle(
    "kmux:terminal:resize",
    (_event, surfaceId: Id, cols: number, rows: number) => {
      const sessionId = surfaceSessionId(surfaceId);
      if (sessionId) {
        ptyHost?.resize(sessionId, cols, rows);
      }
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
  ipcMain.handle("kmux:identify", (): ShellIdentity => {
    const state = getState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    return {
      socketPath: paths.socketPath,
      socketMode: state.settings.socketMode,
      windowId: state.activeWindowId,
      activeWorkspaceId: workspaceId,
      activeSurfaceId: surfaceId,
      capabilities: capabilityList()
    };
  });
}

async function bootstrap(): Promise<void> {
  db = new KmuxDatabase(paths.dbPath);
  const initial = restoreInitialState();

  store = new AppStore(initial);
  ptyHost = new PtyHostManager();
  ptyHost.start();
  ptyHost.on("event", handlePtyEvent);

  socketServer = new KmuxSocketServer({
    socketPath: paths.socketPath,
    getState,
    dispatch: (action) => {
      const effects = store?.dispatch(action) ?? [];
      runEffects(effects);
    },
    sendSurfaceText: sendText,
    sendSurfaceKey: sendKey,
    identify: () => {
      return {
        socketPath: paths.socketPath,
        socketMode: getState().settings.socketMode,
        windowId: getState().activeWindowId,
        activeWorkspaceId:
          getState().windows[getState().activeWindowId].activeWorkspaceId,
        activeSurfaceId:
          getState().panes[
            getState().workspaces[
              getState().windows[getState().activeWindowId].activeWorkspaceId
            ].activePaneId
          ].activeSurfaceId,
        capabilities: capabilityList()
      };
    }
  });
  await socketServer.start();
  registerIpc();

  mainWindow = createMainWindow();
  broadcastView();

  for (const session of Object.values(getState().sessions)) {
    if (session.runtimeState !== "exited") {
      const effects = [
        {
          type: "session.spawn",
          spec: {
            sessionId: session.id,
            surfaceId: session.surfaceId,
            workspaceId:
              getState().panes[getState().surfaces[session.surfaceId].paneId]
                .workspaceId,
            launch: session.launch,
            cols: 120,
            rows: 30,
            env: {
              KMUX_SOCKET_MODE: getState().settings.socketMode,
              KMUX_WORKSPACE_ID:
                getState().panes[getState().surfaces[session.surfaceId].paneId]
                  .workspaceId,
              KMUX_SURFACE_ID: session.surfaceId,
              KMUX_AUTH_TOKEN: session.authToken,
              TERM_PROGRAM: "kmux"
            }
          }
        }
      ];
      runEffects(effects as AppEffect[]);
    }
  }
}

app
  .whenReady()
  .then(bootstrap)
  .catch((error) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  if (mainWindow) {
    persistWindowState(mainWindow);
  }
  if (db && store) {
    db.saveSnapshot(store.getState());
    settingsStore.save(store.getState().settings);
  }
  await socketServer?.stop();
  ptyHost?.stop();
  db?.close();
});
