import {app} from "electron";
import {homedir} from "node:os";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

import {createSettingsStore, defaultAppPaths, KmuxDatabase} from "@kmux/persistence";

import {createAppRuntime} from "./appRuntime";
import {registerIpcHandlers} from "./ipcHandlers";
import {createMetadataRuntime} from "./metadataRuntime";
import {PtyHostManager} from "./ptyHost";
import {KmuxSocketServer} from "./socketServer";
import {createTerminalBridge} from "./terminalBridge";
import {createMainWindow, persistWindowState, setDevelopmentDockIcon} from "./windowLifecycle";
import {AppStore} from "./store";

const paths = defaultAppPaths(homedir(), process.env);
const currentDir = dirname(fileURLToPath(import.meta.url));

let db: KmuxDatabase | null = null;
let ptyHost: PtyHostManager | null = null;
let socketServer: KmuxSocketServer | null = null;

async function bootstrap(): Promise<void> {
  setDevelopmentDockIcon(currentDir);
  const database = new KmuxDatabase(paths.dbPath);
  db = database;
  const settingsStore = createSettingsStore(paths.settingsPath);
  let metadataRuntime!: ReturnType<typeof createMetadataRuntime>;

  const runtime = createAppRuntime({
    paths,
    db: database,
    settingsStore,
    refreshMetadata: (...args) => metadataRuntime.refreshMetadata(...args),
    persistWindowState: (window) => {
      persistWindowState({
        db: database,
        window,
        getSidebarWidth: () => {
          const state = runtime.getState();
          return state.windows[state.activeWindowId]?.sidebarWidth;
        }
      });
    }
  });

  metadataRuntime = createMetadataRuntime({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction
  });

  const initial = runtime.restoreInitialState();
  runtime.setStore(new AppStore(initial));

  ptyHost = new PtyHostManager();
  runtime.setPtyHost(ptyHost);

  const terminalBridge = createTerminalBridge({
    getState: runtime.getState,
    dispatchAppAction: runtime.dispatchAppAction,
    getPtyHost: () => ptyHost
  });

  ptyHost.start();
  ptyHost.on("event", terminalBridge.handlePtyEvent);

  socketServer = new KmuxSocketServer({
    socketPath: paths.socketPath,
    getState: runtime.getState,
    dispatch: runtime.dispatchAppAction,
    sendSurfaceText: terminalBridge.sendText,
    sendSurfaceKey: terminalBridge.sendKey,
    identify: runtime.identify
  });
  await socketServer.start();

  registerIpcHandlers({
    getView: runtime.getView,
    dispatchAppAction: runtime.dispatchAppAction,
    attachSurface: terminalBridge.attachSurface,
    detachSurface: terminalBridge.detachSurface,
    sendText: terminalBridge.sendText,
    sendKeyInput: terminalBridge.sendKeyInput,
    resizeSurface: terminalBridge.resizeSurface,
    identify: runtime.identify
  });

  const mainWindow = createMainWindow({
    currentDir,
    loadWindowState: () => database.loadWindowState(),
    onClose: (window) => {
      persistWindowState({
        db: database,
        window,
        getSidebarWidth: () => {
          const state = runtime.getState();
          return state.windows[state.activeWindowId]?.sidebarWidth;
        }
      });
    }
  });
  runtime.setMainWindow(mainWindow);
  runtime.broadcastView();
  runtime.respawnRestoredSessions();

  app.on("before-quit", async () => {
    runtime.shutdown();
    await socketServer?.stop();
    ptyHost?.stop();
    db?.close();
  });
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
