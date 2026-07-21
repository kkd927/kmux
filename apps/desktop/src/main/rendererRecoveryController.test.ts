import type { BrowserWindow, RenderProcessGoneDetails } from "electron";
import { describe, expect, it, vi } from "vitest";

import { createRendererRecoveryController } from "./rendererRecoveryController";

type Handler = (...args: any[]) => void;

function createWindow(id: number) {
  const windowHandlers = new Map<string, Handler[]>();
  const webContentsHandlers = new Map<string, Handler[]>();
  let destroyed = false;
  const window = {
    webContents: {
      id,
      getOSProcessId: () => 10_000 + id,
      on: (event: string, handler: Handler) => {
        const handlers = webContentsHandlers.get(event) ?? [];
        handlers.push(handler);
        webContentsHandlers.set(event, handlers);
      },
      removeListener: (event: string, handler: Handler) => {
        webContentsHandlers.set(
          event,
          (webContentsHandlers.get(event) ?? []).filter(
            (candidate) => candidate !== handler
          )
        );
      },
      once: (event: string, handler: Handler) => {
        const onceHandler: Handler = (...args) => {
          const handlers = webContentsHandlers.get(event) ?? [];
          webContentsHandlers.set(
            event,
            handlers.filter((candidate) => candidate !== onceHandler)
          );
          handler(...args);
        };
        const handlers = webContentsHandlers.get(event) ?? [];
        handlers.push(onceHandler);
        webContentsHandlers.set(event, handlers);
      }
    },
    once: (event: string, handler: Handler) => {
      const handlers = windowHandlers.get(event) ?? [];
      handlers.push(handler);
      windowHandlers.set(event, handlers);
    },
    removeListener: (event: string, handler: Handler) => {
      windowHandlers.set(
        event,
        (windowHandlers.get(event) ?? []).filter(
          (candidate) => candidate !== handler
        )
      );
    },
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
    getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
    })
  } as unknown as BrowserWindow;
  return {
    window,
    emitWindow(event: string, ...args: unknown[]) {
      for (const handler of windowHandlers.get(event) ?? []) handler(...args);
    },
    emitWebContents(event: string, ...args: unknown[]) {
      for (const handler of webContentsHandlers.get(event) ?? []) {
        handler({}, ...args);
      }
    }
  };
}

const gone = (reason = "crashed"): RenderProcessGoneDetails => ({
  reason: reason as RenderProcessGoneDetails["reason"],
  exitCode: 9
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("renderer recovery controller", () => {
  it("replaces an unexpectedly gone renderer once and preserves window state", () => {
    const first = createWindow(1);
    const replacement = createWindow(2);
    const openMainWindow = vi.fn(() => replacement.window);
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({ surfaceId: "surface-1" }),
      log: vi.fn(),
      showRecoveryLimitDialog: vi.fn(),
      quit: vi.fn()
    });
    controller.registerWindow(first.window);

    first.emitWebContents("render-process-gone", gone());
    first.emitWebContents("render-process-gone", gone());

    expect(first.window.destroy).toHaveBeenCalledOnce();
    expect(openMainWindow).toHaveBeenCalledOnce();
    expect(openMainWindow).toHaveBeenCalledWith("recovery", {
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      maximized: false,
      fullscreen: false
    });
    expect(controller.isReplacingRenderer()).toBe(true);
    replacement.emitWebContents("did-finish-load");
    expect(controller.isReplacingRenderer()).toBe(false);
  });

  it("does not recover a clean close, app quit, or stale window", () => {
    const clean = createWindow(1);
    const stale = createWindow(2);
    const current = createWindow(3);
    let quitting = false;
    const openMainWindow = vi.fn(() => createWindow(4).window);
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => quitting,
      getDiagnosticContext: () => ({}),
      log: vi.fn(),
      showRecoveryLimitDialog: vi.fn(),
      quit: vi.fn()
    });

    controller.registerWindow(clean.window);
    clean.emitWindow("close");
    clean.emitWebContents("render-process-gone", gone());
    controller.registerWindow(stale.window);
    controller.registerWindow(current.window);
    stale.emitWebContents("render-process-gone", gone());
    quitting = true;
    current.emitWebContents("render-process-gone", gone());

    expect(openMainWindow).not.toHaveBeenCalled();
  });

  it("ends only the current recovery attempt when its window closes before load", () => {
    const first = createWindow(1);
    const replacement = createWindow(2);
    const log = vi.fn();
    const controller = createRendererRecoveryController({
      openMainWindow: vi.fn(() => replacement.window),
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({}),
      log,
      showRecoveryLimitDialog: vi.fn(),
      quit: vi.fn()
    });
    controller.registerWindow(first.window);

    first.emitWebContents("render-process-gone", gone());
    expect(controller.isReplacingRenderer()).toBe(true);
    replacement.emitWindow("closed");

    expect(controller.isReplacingRenderer()).toBe(false);
    expect(log).toHaveBeenCalledWith(
      "main.renderer.recovery.failed",
      expect.objectContaining({
        attemptId: 1,
        failureReason: "window-closed-before-load"
      })
    );
  });

  it("routes a main-frame load failure through a fresh user recovery choice", async () => {
    const first = createWindow(1);
    const failedReplacement = createWindow(2);
    const reopenedReplacement = createWindow(3);
    const openMainWindow = vi
      .fn()
      .mockReturnValueOnce(failedReplacement.window)
      .mockReturnValueOnce(reopenedReplacement.window);
    const showRecoveryLimitDialog = vi.fn(async () => "reopen" as const);
    const log = vi.fn();
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({}),
      log,
      showRecoveryLimitDialog,
      quit: vi.fn()
    });
    controller.registerWindow(first.window);

    first.emitWebContents("render-process-gone", gone());
    failedReplacement.emitWebContents(
      "did-fail-load",
      -105,
      "SUBFRAME_FAILED",
      "file:///renderer/subframe.html",
      false
    );
    failedReplacement.emitWebContents(
      "did-fail-load",
      -3,
      "ERR_ABORTED",
      "file:///renderer/index.html",
      true
    );
    expect(showRecoveryLimitDialog).not.toHaveBeenCalled();
    expect(controller.isReplacingRenderer()).toBe(true);
    failedReplacement.emitWebContents(
      "did-fail-load",
      -105,
      "NAME_NOT_RESOLVED",
      "file:///renderer/index.html",
      true
    );
    await flushMicrotasks();

    expect(failedReplacement.window.destroy).toHaveBeenCalledOnce();
    expect(showRecoveryLimitDialog).toHaveBeenCalledOnce();
    expect(openMainWindow).toHaveBeenCalledTimes(2);
    expect(controller.isReplacingRenderer()).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "main.renderer.recovery.failed",
      expect.objectContaining({
        attemptId: 1,
        failureReason: "window-load-failed",
        errorCode: -105
      })
    );

    reopenedReplacement.emitWebContents("did-finish-load");
    expect(controller.isReplacingRenderer()).toBe(false);
  });

  it("does not let a stale recovery window close a newer attempt", () => {
    const first = createWindow(1);
    const firstReplacement = createWindow(2);
    const secondReplacement = createWindow(3);
    const openMainWindow = vi
      .fn()
      .mockReturnValueOnce(firstReplacement.window)
      .mockReturnValueOnce(secondReplacement.window);
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({}),
      log: vi.fn(),
      showRecoveryLimitDialog: vi.fn(),
      quit: vi.fn()
    });
    controller.registerWindow(first.window);

    first.emitWebContents("render-process-gone", gone());
    firstReplacement.emitWebContents("render-process-gone", gone());
    firstReplacement.emitWindow("closed");

    expect(controller.isReplacingRenderer()).toBe(true);
    secondReplacement.emitWebContents("did-finish-load");
    expect(controller.isReplacingRenderer()).toBe(false);
  });

  it("pauses after three crashes in five minutes and obeys the native choice", async () => {
    let windowId = 1;
    const first = createWindow(windowId++);
    const opened: ReturnType<typeof createWindow>[] = [];
    const openMainWindow = vi.fn(() => {
      const next = createWindow(windowId++);
      opened.push(next);
      return next.window;
    });
    const showRecoveryLimitDialog = vi.fn(async () => "quit" as const);
    const quit = vi.fn();
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({}),
      log: vi.fn(),
      showRecoveryLimitDialog,
      quit,
      now: () => 1_000
    });
    controller.registerWindow(first.window);

    first.emitWebContents("render-process-gone", gone());
    opened[0].emitWebContents("render-process-gone", gone());
    opened[1].emitWebContents("render-process-gone", gone());
    await flushMicrotasks();

    expect(openMainWindow).toHaveBeenCalledTimes(2);
    expect(showRecoveryLimitDialog).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("logs unresponsive and responsive without replacing the renderer", () => {
    const first = createWindow(1);
    const log = vi.fn();
    const openMainWindow = vi.fn(() => createWindow(2).window);
    const controller = createRendererRecoveryController({
      openMainWindow,
      isAppQuitting: () => false,
      getDiagnosticContext: () => ({ workspaceId: "workspace-1" }),
      log,
      showRecoveryLimitDialog: vi.fn(),
      quit: vi.fn()
    });
    controller.registerWindow(first.window);

    first.emitWebContents("unresponsive");
    first.emitWebContents("responsive");

    expect(openMainWindow).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([scope]) => scope)).toEqual([
      "main.renderer.unresponsive",
      "main.renderer.responsive"
    ]);
  });
});
