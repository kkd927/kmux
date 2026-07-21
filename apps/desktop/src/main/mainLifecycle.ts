import { readFileSync } from "node:fs";

import { BrowserWindow } from "electron";

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface QuitConfirmationResult {
  confirmed: boolean;
  suppressFutureWarnings: boolean;
  restoreWorkspacesAfterQuit: boolean;
}

export interface QuitConfirmationOptions {
  restoreWorkspacesAfterQuit: boolean;
  iconPath?: string;
}

interface MainLifecycleOptions {
  isMac: boolean;
  shouldConfirmQuit?: boolean;
  app: {
    quit(): void;
  };
  getWindowCount(): number;
  openMainWindow(reason: "activate"): void;
  isReplacingRenderer?: () => boolean;
  getCurrentWindow(): BrowserWindow | null;
  getWarnBeforeQuit(): boolean;
  setWarnBeforeQuit(value: boolean): void;
  getRestoreWorkspacesAfterQuit(): boolean;
  setRestoreWorkspacesAfterQuit(value: boolean): void;
  confirmQuit: (
    window: BrowserWindow | null,
    options: QuitConfirmationOptions
  ) => Promise<QuitConfirmationResult>;
  shutdown: () => Promise<void>;
}

export interface MainLifecycleController {
  allowQuit(): void;
  isQuitInProgress(): boolean;
  handleActivate(): void;
  handleBeforeQuit(event: BeforeQuitEventLike): void;
  handleWindowAllClosed(): void;
}

export function createMainLifecycleController(
  options: MainLifecycleOptions
): MainLifecycleController {
  const shouldConfirmQuit = options.shouldConfirmQuit ?? true;
  let confirmationBypassed = false;
  let quitPhase: "idle" | "confirming" | "shutting-down" | "complete" = "idle";
  let shutdownPromise: Promise<void> | null = null;

  const shutdownOnce = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = options.shutdown().catch((error) => {
        console.error("[main:shutdown]", error);
      });
    }
    return shutdownPromise;
  };

  const beginShutdown = (): void => {
    if (quitPhase === "shutting-down" || quitPhase === "complete") {
      return;
    }
    quitPhase = "shutting-down";
    void shutdownOnce().finally(() => {
      if (quitPhase !== "shutting-down") {
        return;
      }
      quitPhase = "complete";
      options.app.quit();
    });
  };

  return {
    allowQuit(): void {
      confirmationBypassed = true;
    },
    isQuitInProgress(): boolean {
      return quitPhase !== "idle";
    },
    handleActivate(): void {
      if (options.getWindowCount() === 0) {
        options.openMainWindow("activate");
      }
    },
    handleBeforeQuit(event: BeforeQuitEventLike): void {
      if (quitPhase === "complete") {
        return;
      }

      // Electron does not await promises returned by before-quit listeners.
      // Hold the first quit until every runtime has acknowledged shutdown, then
      // re-enter app.quit() once in the complete phase.
      event.preventDefault();
      if (quitPhase === "confirming" || quitPhase === "shutting-down") {
        return;
      }

      const shouldWarn =
        options.isMac &&
        shouldConfirmQuit &&
        !confirmationBypassed &&
        options.getWarnBeforeQuit();

      if (!shouldWarn) {
        beginShutdown();
        return;
      }

      quitPhase = "confirming";
      void options
        .confirmQuit(options.getCurrentWindow(), {
          restoreWorkspacesAfterQuit: options.getRestoreWorkspacesAfterQuit()
        })
        .then((result) => {
          if (!result.confirmed) {
            quitPhase = "idle";
            return;
          }
          if (result.suppressFutureWarnings) {
            options.setWarnBeforeQuit(false);
          }
          options.setRestoreWorkspacesAfterQuit(
            result.restoreWorkspacesAfterQuit
          );
          beginShutdown();
        })
        .catch((error) => {
          quitPhase = "idle";
          console.error("[main:quit-confirmation]", error);
        });
    },
    handleWindowAllClosed(): void {
      if (
        !options.isMac &&
        options.getWindowCount() === 0 &&
        !options.isReplacingRenderer?.()
      ) {
        options.app.quit();
      }
    }
  };
}

export async function showQuitConfirmationDialog(
  window: BrowserWindow | null,
  options: QuitConfirmationOptions
): Promise<QuitConfirmationResult> {
  const initialRestore = options.restoreWorkspacesAfterQuit;
  const iconDataUrl = loadQuitDialogIconDataUrl(options.iconPath);
  const cancelResult = {
    confirmed: false,
    suppressFutureWarnings: false,
    restoreWorkspacesAfterQuit: initialRestore
  } satisfies QuitConfirmationResult;
  const quitWindow = new BrowserWindow({
    width: 460,
    height: 238,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Quit kmux?",
    backgroundColor: "#ececec",
    parent: window ?? undefined,
    modal: Boolean(window),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  quitWindow.setMenuBarVisibility?.(false);

  let closed = false;
  const closedResult = new Promise<QuitConfirmationResult>((resolve) => {
    quitWindow.once("closed", () => {
      closed = true;
      resolve(cancelResult);
    });
  });

  await quitWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      buildQuitConfirmationHtml(initialRestore, iconDataUrl)
    )}`
  );

  if (!quitWindow.isDestroyed()) {
    quitWindow.show();
  }

  const interactionResult = quitWindow.webContents.executeJavaScript(
    buildQuitConfirmationScript(initialRestore),
    true
  ) as Promise<QuitConfirmationResult>;
  const result = normalizeQuitConfirmationResult(
    await Promise.race([interactionResult, closedResult]),
    initialRestore
  );

  if (!closed && !quitWindow.isDestroyed()) {
    quitWindow.close();
  }
  return result;
}

function normalizeQuitConfirmationResult(
  result: unknown,
  fallbackRestoreWorkspacesAfterQuit: boolean
): QuitConfirmationResult {
  const record =
    result && typeof result === "object"
      ? (result as Partial<QuitConfirmationResult>)
      : {};
  return {
    confirmed: record.confirmed === true,
    suppressFutureWarnings: record.suppressFutureWarnings === true,
    restoreWorkspacesAfterQuit:
      typeof record.restoreWorkspacesAfterQuit === "boolean"
        ? record.restoreWorkspacesAfterQuit
        : fallbackRestoreWorkspacesAfterQuit
  };
}

function buildQuitConfirmationHtml(
  restoreWorkspacesAfterQuit: boolean,
  iconDataUrl: string | null
): string {
  const iconMarkup = iconDataUrl
    ? `<img class="icon" alt="" src="${escapeHtmlAttribute(iconDataUrl)}" />`
    : "";
  const mainClass = iconDataUrl ? "" : ` class="no-icon"`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <title>Quit kmux?</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #ececec;
        color: #1f1f1f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        background: #ececec;
      }
      main {
        width: 100%;
        padding: 22px 20px 18px;
        display: grid;
        grid-template-columns: 64px 1fr;
        column-gap: 16px;
      }
      main.no-icon {
        grid-template-columns: 1fr;
      }
      .icon {
        width: 64px;
        height: 64px;
        border-radius: 14px;
        object-fit: contain;
      }
      .content {
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      h1 {
        margin: 0;
        font-size: 13px;
        line-height: 1.35;
        font-weight: 700;
        letter-spacing: 0;
      }
      p {
        margin: 6px 0 0;
        color: #3d3d3d;
        font-size: 13px;
        line-height: 1.35;
      }
      .options {
        display: grid;
        gap: 7px;
        margin-top: 13px;
      }
      label {
        display: flex;
        gap: 7px;
        align-items: center;
        color: #1f1f1f;
        font-size: 13px;
        line-height: 1.25;
      }
      input {
        margin: 0;
      }
      .actions {
        margin-top: 18px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        min-width: 86px;
        height: 24px;
        padding: 0 14px;
        font-size: 13px;
        font-family: inherit;
        line-height: 20px;
        border-radius: 5px;
        border: 1px solid rgba(0, 0, 0, 0.22);
        background: linear-gradient(#ffffff, #e9e9e9);
        color: #1f1f1f;
      }
      button:active { background: linear-gradient(#dddddd, #f4f4f4); }
      button.primary {
        border-color: #0066d9;
        background: linear-gradient(#0a84ff, #006edb);
        color: #ffffff;
      }
      button.primary:active { background: linear-gradient(#006edb, #0a84ff); }
      @media (prefers-color-scheme: dark) {
        :root {
          background: #2b2b2b;
          color: #f4f4f4;
        }
        body { background: #2b2b2b; }
        p { color: #c8c8c8; }
        label { color: #f0f0f0; }
        button {
          border-color: rgba(255, 255, 255, 0.18);
          background: linear-gradient(#5a5a5d, #47474a);
          color: #f4f4f4;
        }
        button:active { background: linear-gradient(#3f3f42, #565659); }
        button.primary {
          border-color: #1676e7;
          background: linear-gradient(#0a84ff, #006edb);
          color: #ffffff;
        }
      }
    </style>
  </head>
  <body>
    <main${mainClass}>
      ${iconMarkup}
      <div class="content">
        <h1>Are you sure you want to quit kmux?</h1>
        <p>All kmux windows will close. Interrupted workspaces still restore after a crash.</p>
        <div class="options">
          <label>
            <input id="suppress-warning" type="checkbox" />
            <span>Don't warn again for Cmd+Q</span>
          </label>
          <label>
            <input id="restore-workspaces" type="checkbox"${restoreWorkspacesAfterQuit ? " checked" : ""} />
            <span>Restore workspaces next launch</span>
          </label>
        </div>
        <div class="actions">
          <button id="cancel" type="button">Cancel</button>
          <button id="quit" type="button" class="primary" autofocus>Quit</button>
        </div>
      </div>
    </main>
  </body>
</html>`;
}

function loadQuitDialogIconDataUrl(
  iconPath: string | undefined
): string | null {
  if (!iconPath) {
    return null;
  }
  try {
    const icon = readFileSync(iconPath);
    return `data:image/png;base64,${icon.toString("base64")}`;
  } catch {
    return null;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function buildQuitConfirmationScript(
  restoreWorkspacesAfterQuit: boolean
): string {
  return `new Promise((resolve) => {
  const suppressWarning = document.getElementById("suppress-warning");
  const restoreWorkspaces = document.getElementById("restore-workspaces");
  const cancel = document.getElementById("cancel");
  const quit = document.getElementById("quit");
  restoreWorkspaces.checked = ${JSON.stringify(restoreWorkspacesAfterQuit)};
  const finish = (confirmed) => resolve({
    confirmed,
    suppressFutureWarnings: Boolean(suppressWarning.checked),
    restoreWorkspacesAfterQuit: Boolean(restoreWorkspaces.checked)
  });
  cancel.addEventListener("click", () => finish(false));
  quit.addEventListener("click", () => finish(true));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      finish(false);
    }
    if (event.key === "Enter") {
      finish(true);
    }
  });
})`;
}
