// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { installTerminalWebglReturnRecovery } from "./terminalWebglReturnRecovery";

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state
  });
}

function createFrameScheduler(): {
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  flush: () => void;
} {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  return {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }),
    cancelAnimationFrame: vi.fn((handle: number) => {
      callbacks.delete(handle);
    }),
    flush: () => {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [handle, callback] of pending) {
        callback(handle);
      }
    }
  };
}

afterEach(() => {
  setVisibilityState("visible");
});

describe("installTerminalWebglReturnRecovery", () => {
  it("recovers WebGL texture atlases on app focus after the frame boundary", () => {
    setVisibilityState("visible");
    const recover = vi.fn();
    const frames = createFrameScheduler();
    const dispose = installTerminalWebglReturnRecovery({
      window,
      document,
      recover,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    });

    window.dispatchEvent(new Event("focus"));

    expect(recover).not.toHaveBeenCalled();
    frames.flush();
    expect(recover).toHaveBeenCalledOnce();

    dispose();
  });

  it("skips recovery while the document is hidden", () => {
    setVisibilityState("hidden");
    const recover = vi.fn();
    const frames = createFrameScheduler();
    const dispose = installTerminalWebglReturnRecovery({
      window,
      document,
      recover,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    });

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    frames.flush();

    expect(recover).not.toHaveBeenCalled();

    dispose();
  });

  it("throttles focus and visible events from the same app return", () => {
    setVisibilityState("visible");
    let now = 100;
    const recover = vi.fn();
    const frames = createFrameScheduler();
    const dispose = installTerminalWebglReturnRecovery({
      window,
      document,
      recover,
      now: () => now,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    });

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    frames.flush();

    expect(recover).toHaveBeenCalledOnce();

    now += 1001;
    window.dispatchEvent(new Event("focus"));
    frames.flush();

    expect(recover).toHaveBeenCalledTimes(2);

    dispose();
  });
});
