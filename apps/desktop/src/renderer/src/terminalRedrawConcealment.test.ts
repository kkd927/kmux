import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalRedrawConcealment } from "./terminalRedrawConcealment";

class FakeAnimationFrameTarget {
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
}

describe("terminal redraw concealment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides during a resize redraw and reveals after the quiet window settles for two frames", () => {
    const frameTarget = new FakeAnimationFrameTarget();
    const events: string[] = [];
    let now = 0;
    const concealment = createTerminalRedrawConcealment({
      hide: (surfaceId) => {
        events.push(`hide:${surfaceId}`);
      },
      reveal: (surfaceId) => {
        events.push(`reveal:${surfaceId}`);
      },
      now: () => now,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame,
      quietMs: 100,
      maxMs: 400
    });

    concealment.start("surface_1");

    expect(events).toEqual(["hide:surface_1"]);
    now = 99;
    vi.advanceTimersByTime(99);
    expect(events).toEqual(["hide:surface_1"]);

    now = 100;
    vi.advanceTimersByTime(1);
    expect(frameTarget.requestAnimationFrame).toHaveBeenCalledTimes(1);
    frameTarget.runNextAnimationFrame();
    expect(events).toEqual(["hide:surface_1"]);

    frameTarget.runNextAnimationFrame();
    expect(events).toEqual(["hide:surface_1", "reveal:surface_1"]);
  });

  it("extends the quiet window while redraw chunks arrive but reveals at the max window", () => {
    const frameTarget = new FakeAnimationFrameTarget();
    const events: string[] = [];
    let now = 0;
    const concealment = createTerminalRedrawConcealment({
      hide: (surfaceId) => {
        events.push(`hide:${surfaceId}`);
      },
      reveal: (surfaceId) => {
        events.push(`reveal:${surfaceId}`);
      },
      now: () => now,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame,
      quietMs: 100,
      maxMs: 250
    });

    concealment.start("surface_1");
    now = 80;
    vi.advanceTimersByTime(80);
    concealment.touch("surface_1");

    now = 160;
    vi.advanceTimersByTime(80);
    concealment.touch("surface_1");

    now = 249;
    vi.advanceTimersByTime(89);
    expect(events).toEqual(["hide:surface_1"]);

    now = 250;
    vi.advanceTimersByTime(1);
    frameTarget.runNextAnimationFrame();
    frameTarget.runNextAnimationFrame();

    expect(events).toEqual(["hide:surface_1", "reveal:surface_1"]);
  });

  it("reveals immediately and cancels pending timers on cleanup", () => {
    const frameTarget = new FakeAnimationFrameTarget();
    const events: string[] = [];
    const concealment = createTerminalRedrawConcealment({
      hide: (surfaceId) => {
        events.push(`hide:${surfaceId}`);
      },
      reveal: (surfaceId) => {
        events.push(`reveal:${surfaceId}`);
      },
      now: () => 0,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame,
      quietMs: 100,
      maxMs: 400
    });

    concealment.start("surface_1");
    concealment.revealNow("surface_1");
    vi.advanceTimersByTime(100);

    expect(events).toEqual(["hide:surface_1", "reveal:surface_1"]);
    expect(frameTarget.requestAnimationFrame).not.toHaveBeenCalled();
  });
});
