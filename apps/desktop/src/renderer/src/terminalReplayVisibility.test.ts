// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { createTerminalReplayVisibility } from "./terminalReplayVisibility";

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

  runAllAnimationFrames(): void {
    while (this.animationFrames.size > 0) {
      const entry = this.animationFrames.entries().next().value;
      if (!entry) {
        return;
      }
      const [id, callback] = entry;
      this.animationFrames.delete(id);
      callback(0);
    }
  }
}

describe("terminal replay visibility", () => {
  it("does not let a stale reveal clear a newer hide on the same terminal elements", () => {
    const frameTarget = new FakeAnimationFrameTarget();
    const host = document.createElement("div");
    const wrapper = document.createElement("div");
    const oldVisibility = createTerminalReplayVisibility({
      host,
      wrapper,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame
    });
    const newVisibility = createTerminalReplayVisibility({
      host,
      wrapper,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame
    });

    oldVisibility.hide();
    oldVisibility.revealAfterPaint();
    newVisibility.hide();
    frameTarget.runAllAnimationFrames();

    expect(host.dataset.terminalReplayHidden).toBeDefined();
    expect(wrapper.dataset.terminalReplayHidden).toBeDefined();
  });

  it("ignores async replay completion after dispose", () => {
    const frameTarget = new FakeAnimationFrameTarget();
    const host = document.createElement("div");
    const visibility = createTerminalReplayVisibility({
      host,
      wrapper: null,
      requestAnimationFrame: frameTarget.requestAnimationFrame,
      cancelAnimationFrame: frameTarget.cancelAnimationFrame
    });

    visibility.hide();
    visibility.dispose();
    visibility.revealAfterPaint();
    frameTarget.runAllAnimationFrames();

    expect(host.dataset.terminalReplayHidden).toBeUndefined();
  });
});
