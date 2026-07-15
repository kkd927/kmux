import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTerminalForegroundFit } from "./terminalForegroundFit";

class FakeWindow extends EventTarget {
  private nextAnimationFrameId = 1;
  private readonly animationFrames = new Map<number, FrameRequestCallback>();

  requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
    const id = this.nextAnimationFrameId++;
    this.animationFrames.set(id, callback);
    return id;
  });

  cancelAnimationFrame = vi.fn((id: number): void => {
    this.animationFrames.delete(id);
  });

  runNextAnimationFrame(): void {
    const entry = this.animationFrames.entries().next().value;
    if (!entry) {
      return;
    }
    const [id, callback] = entry;
    this.animationFrames.delete(id);
    callback(0);
  }

  pendingAnimationFrameCount(): number {
    return this.animationFrames.size;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

class FakeFitElement {
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getBoundingClientRect(): Pick<DOMRect, "width" | "height"> {
    return {
      width: this.width,
      height: this.height
    };
  }
}

function dispatch(target: EventTarget, type: string): void {
  target.dispatchEvent(new Event(type));
}

describe("terminal foreground fit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fits after a focused window has settled for two animation frames", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();

    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    dispatch(targetWindow, "focus");

    vi.advanceTimersByTime(119);
    expect(fitAndSync).not.toHaveBeenCalled();
    expect(targetWindow.requestAnimationFrame).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(targetWindow.requestAnimationFrame).toHaveBeenCalledTimes(1);
    targetWindow.runNextAnimationFrame();
    expect(fitAndSync).not.toHaveBeenCalled();

    targetWindow.runNextAnimationFrame();
    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenCalledWith(["window-focus"]);
    controller.dispose();
  });

  it("allows visible workspace transitions to schedule the same settled fit", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    controller.scheduleFit("manual");

    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenCalledWith(["manual"]);
    controller.dispose();
  });

  it("fits after the renderer viewport resizes", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    dispatch(targetWindow, "resize");

    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenCalledWith(["window-resize"]);
    controller.dispose();
  });

  it("uses a timeout fallback when animation frames are throttled", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync,
      frameFallbackMs: 80
    });

    dispatch(targetWindow, "resize");

    vi.advanceTimersByTime(120);
    expect(fitAndSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenLastCalledWith(["window-resize"]);
    expect(targetWindow.pendingAnimationFrameCount()).toBe(0);
    controller.dispose();
  });

  it("polls the fit element when browser resize events are missed", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitElement = new FakeFitElement(640, 400);
    const fitAndSync = vi.fn();
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      getFitElement: () => fitElement,
      fitAndSync,
      dimensionPollMs: 50
    });

    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();
    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenLastCalledWith([
      "fit-element-initial-measurement"
    ]);

    vi.advanceTimersByTime(50);
    expect(fitAndSync).toHaveBeenCalledTimes(1);

    fitElement.setSize(900, 600);
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).toHaveBeenCalledTimes(2);
    expect(fitAndSync).toHaveBeenLastCalledWith([
      "fit-element-dimension-change"
    ]);
    controller.dispose();
  });

  it("schedules only when visibility changes back to visible", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();

    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    targetDocument.visibilityState = "hidden";
    dispatch(targetDocument, "visibilitychange");
    vi.advanceTimersByTime(120);
    expect(targetWindow.requestAnimationFrame).not.toHaveBeenCalled();

    targetDocument.visibilityState = "visible";
    dispatch(targetDocument, "visibilitychange");
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenCalledWith(["document-visible"]);
    controller.dispose();
  });

  it("debounces foreground events into one fit", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();

    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    dispatch(targetWindow, "focus");
    vi.advanceTimersByTime(60);
    dispatch(targetWindow, "pageshow");
    vi.advanceTimersByTime(119);
    expect(targetWindow.requestAnimationFrame).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).toHaveBeenCalledTimes(1);
    expect(fitAndSync).toHaveBeenCalledWith([
      "window-focus",
      "window-pageshow"
    ]);
    controller.dispose();
  });

  it("collects trigger metadata only while diagnostics are enabled", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    let diagnosticsEnabled = false;
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      shouldCollectTriggers: () => diagnosticsEnabled,
      fitAndSync
    });

    dispatch(targetWindow, "focus");
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();
    expect(fitAndSync).toHaveBeenLastCalledWith([]);

    diagnosticsEnabled = true;
    dispatch(targetWindow, "resize");
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    targetWindow.runNextAnimationFrame();
    expect(fitAndSync).toHaveBeenLastCalledWith(["window-resize"]);
    controller.dispose();
  });

  it("skips inactive terminals before scheduling and before fitting", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    let active = false;

    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => active,
      fitAndSync
    });

    dispatch(targetWindow, "focus");
    vi.advanceTimersByTime(120);
    expect(targetWindow.requestAnimationFrame).not.toHaveBeenCalled();

    active = true;
    dispatch(targetWindow, "focus");
    vi.advanceTimersByTime(120);
    targetWindow.runNextAnimationFrame();
    active = false;
    targetWindow.runNextAnimationFrame();

    expect(fitAndSync).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("removes listeners and cancels pending work on cleanup", () => {
    const targetWindow = new FakeWindow();
    const targetDocument = new FakeDocument();
    const fitAndSync = vi.fn();
    const controller = installTerminalForegroundFit({
      targetWindow,
      targetDocument,
      isActive: () => true,
      fitAndSync
    });

    dispatch(targetWindow, "focus");
    controller.dispose();
    vi.advanceTimersByTime(120);
    dispatch(targetWindow, "focus");
    targetDocument.visibilityState = "visible";
    dispatch(targetDocument, "visibilitychange");
    dispatch(targetWindow, "resize");
    controller.scheduleFit();
    vi.advanceTimersByTime(120);

    expect(targetWindow.requestAnimationFrame).not.toHaveBeenCalled();
    expect(targetWindow.pendingAnimationFrameCount()).toBe(0);
    expect(fitAndSync).not.toHaveBeenCalled();
  });
});
