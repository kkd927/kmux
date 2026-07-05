import { vi } from "vitest";

const { browserWindowInstances, nextDialogResult } = vi.hoisted(() => ({
  browserWindowInstances: [] as Array<{
    options: Electron.BrowserWindowConstructorOptions;
    loadURL: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    setMenuBarVisibility: ReturnType<typeof vi.fn>;
    webContents: {
      executeJavaScript: ReturnType<typeof vi.fn>;
    };
    closedHandler?: () => void;
  }>,
  nextDialogResult: {
    current: null as QuitConfirmationResult | null
  }
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    options: Electron.BrowserWindowConstructorOptions;
    loadURL = vi.fn(async () => undefined);
    show = vi.fn();
    close = vi.fn(() => {
      this.destroyed = true;
      this.closedHandler?.();
    });
    isDestroyed = vi.fn(() => this.destroyed);
    setMenuBarVisibility = vi.fn();
    webContents = {
      executeJavaScript: vi.fn(async () => nextDialogResult.current)
    };
    closedHandler?: () => void;
    private destroyed = false;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.options = options;
      browserWindowInstances.push(this);
    }

    once(event: string, handler: () => void): void {
      if (event === "closed") {
        this.closedHandler = handler;
      }
    }
  }
}));

import {
  createMainLifecycleController,
  showQuitConfirmationDialog,
  type QuitConfirmationResult
} from "./mainLifecycle";

function createEvent() {
  return {
    preventDefault: vi.fn()
  };
}

function createDeferredResult() {
  let resolve!: (value: QuitConfirmationResult) => void;
  const promise = new Promise<QuitConfirmationResult>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("main lifecycle controller", () => {
  beforeEach(() => {
    browserWindowInstances.length = 0;
    nextDialogResult.current = null;
  });

  it("keeps the app alive when the last macOS window closes", () => {
    const app = { quit: vi.fn() };
    const controller = createMainLifecycleController({
      isMac: true,
      app,
      getWindowCount: () => 0,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    });

    controller.handleWindowAllClosed();

    expect(app.quit).not.toHaveBeenCalled();
  });

  it("quits on last window close outside macOS", () => {
    const app = { quit: vi.fn() };
    const controller = createMainLifecycleController({
      isMac: false,
      app,
      getWindowCount: () => 0,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    });

    controller.handleWindowAllClosed();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("reopens a main window on activate when none are open", () => {
    const openMainWindow = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      app: { quit: vi.fn() },
      getWindowCount: () => 0,
      openMainWindow,
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    });

    controller.handleActivate();

    expect(openMainWindow).toHaveBeenCalledTimes(1);
    expect(openMainWindow).toHaveBeenCalledWith("activate");
  });

  it("does not create a second window on activate when one is already open", () => {
    const openMainWindow = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      app: { quit: vi.fn() },
      getWindowCount: () => 1,
      openMainWindow,
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    });

    controller.handleActivate();

    expect(openMainWindow).not.toHaveBeenCalled();
  });

  it("prompts before quit on macOS when warn-before-quit is enabled", async () => {
    const deferred = createDeferredResult();
    const shutdown = vi.fn(async () => undefined);
    const app = { quit: vi.fn() };
    const setWarnBeforeQuit = vi.fn();
    const setRestoreWorkspacesAfterQuit = vi.fn();
    const confirmQuit = vi.fn(() => deferred.promise);
    const controller = createMainLifecycleController({
      isMac: true,
      app,
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit,
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit,
      confirmQuit,
      shutdown
    });

    const initialEvent = createEvent();
    controller.handleBeforeQuit(initialEvent);

    expect(initialEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();

    deferred.resolve({
      confirmed: true,
      suppressFutureWarnings: true,
      restoreWorkspacesAfterQuit: false
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(setWarnBeforeQuit).toHaveBeenCalledWith(false);
    expect(setRestoreWorkspacesAfterQuit).toHaveBeenCalledWith(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();

    controller.handleBeforeQuit(createEvent());

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("cancels quit when the confirmation dialog is dismissed", async () => {
    const shutdown = vi.fn(async () => undefined);
    const app = { quit: vi.fn() };
    const confirmQuit = vi.fn(async () => ({
      confirmed: false,
      suppressFutureWarnings: false,
      restoreWorkspacesAfterQuit: false
    }));
    const setRestoreWorkspacesAfterQuit = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      app,
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit,
      confirmQuit,
      shutdown
    });

    controller.handleBeforeQuit(createEvent());
    await Promise.resolve();
    await Promise.resolve();

    expect(app.quit).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(setRestoreWorkspacesAfterQuit).not.toHaveBeenCalled();
  });

  it("dedupes overlapping quit dialogs", () => {
    const deferred = createDeferredResult();
    const confirmQuit = vi.fn(() => deferred.promise);
    const controller = createMainLifecycleController({
      isMac: true,
      app: { quit: vi.fn() },
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit,
      shutdown: vi.fn(async () => undefined)
    });

    controller.handleBeforeQuit(createEvent());
    controller.handleBeforeQuit(createEvent());

    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("quits immediately without a dialog when warn-before-quit is disabled", () => {
    const shutdown = vi.fn(async () => undefined);
    const confirmQuit = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      app: { quit: vi.fn() },
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => false,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => false,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit,
      shutdown
    });

    const event = createEvent();
    controller.handleBeforeQuit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("can disable quit confirmation entirely for automated sessions", () => {
    const shutdown = vi.fn(async () => undefined);
    const confirmQuit = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      shouldConfirmQuit: false,
      app: { quit: vi.fn() },
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit,
      shutdown
    });

    const event = createEvent();
    controller.handleBeforeQuit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("can bypass the quit dialog for trusted quit paths", () => {
    const shutdown = vi.fn(async () => undefined);
    const confirmQuit = vi.fn();
    const controller = createMainLifecycleController({
      isMac: true,
      app: { quit: vi.fn() },
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      getRestoreWorkspacesAfterQuit: () => true,
      setRestoreWorkspacesAfterQuit: vi.fn(),
      confirmQuit,
      shutdown
    });

    controller.allowQuit();
    controller.handleBeforeQuit(createEvent());

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("opens a custom quit dialog with restore and warning checkboxes", async () => {
    nextDialogResult.current = {
      confirmed: true,
      suppressFutureWarnings: false,
      restoreWorkspacesAfterQuit: true
    };

    const result = await showQuitConfirmationDialog(null, {
      restoreWorkspacesAfterQuit: true
    });

    const dialogWindow = browserWindowInstances[0];
    const dataUrl = String(dialogWindow.loadURL.mock.calls[0]?.[0] ?? "");
    const html = decodeURIComponent(dataUrl.split(",", 2)[1] ?? "");

    expect(result).toEqual({
      confirmed: true,
      suppressFutureWarnings: false,
      restoreWorkspacesAfterQuit: true
    });
    expect(html).toContain("Don't warn again for Cmd+Q");
    expect(html).toContain("Restore workspaces next launch");
    expect(
      dialogWindow.webContents.executeJavaScript.mock.calls[0]?.[0]
    ).toContain("restoreWorkspaces.checked = true");
  });

  it("uses the provided restore preference as the custom quit dialog default", async () => {
    nextDialogResult.current = {
      confirmed: true,
      suppressFutureWarnings: false,
      restoreWorkspacesAfterQuit: false
    };

    await showQuitConfirmationDialog(null, {
      restoreWorkspacesAfterQuit: false
    });

    expect(
      browserWindowInstances[0].webContents.executeJavaScript.mock.calls[0]?.[0]
    ).toContain("restoreWorkspaces.checked = false");
  });
});
