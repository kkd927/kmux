import { vi } from "vitest";

const { showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox
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
    showMessageBox.mockReset();
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
    const confirmQuit = vi.fn(() => deferred.promise);
    const controller = createMainLifecycleController({
      isMac: true,
      app,
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit,
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
      suppressFutureWarnings: true
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(setWarnBeforeQuit).toHaveBeenCalledWith(false);
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
      suppressFutureWarnings: false
    }));
    const controller = createMainLifecycleController({
      isMac: true,
      app,
      getWindowCount: () => 1,
      openMainWindow: vi.fn(),
      getCurrentWindow: () => null,
      getWarnBeforeQuit: () => true,
      setWarnBeforeQuit: vi.fn(),
      confirmQuit,
      shutdown
    });

    controller.handleBeforeQuit(createEvent());
    await Promise.resolve();
    await Promise.resolve();

    expect(app.quit).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
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
      confirmQuit,
      shutdown
    });

    controller.allowQuit();
    controller.handleBeforeQuit(createEvent());

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("tells users that quit clears current workspaces for the next launch", async () => {
    showMessageBox.mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false
    });

    await showQuitConfirmationDialog(null);

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        detail:
          "This will close all windows and clear current workspaces for the next launch."
      })
    );
  });
});
