import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalDividerFitThrottle } from "./terminalDividerFitThrottle";

function createFakeDrag(): {
  isDragActive: () => boolean;
  subscribeDragActive: (listener: (active: boolean) => void) => () => void;
  begin: () => void;
  end: () => void;
} {
  let active = false;
  const listeners = new Set<(active: boolean) => void>();
  return {
    isDragActive: () => active,
    subscribeDragActive: (listener: (active: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(): void {
      active = true;
      for (const listener of [...listeners]) {
        listener(true);
      }
    },
    end(): void {
      active = false;
      for (const listener of [...listeners]) {
        listener(false);
      }
    }
  };
}

describe("terminal divider fit throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through synchronously when no drag is active", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    controller.requestFit();
    controller.requestFit();
    controller.requestFit();

    expect(runFit).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("defers fits during a drag and coalesces them into one trailing run", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    controller.requestFit();
    expect(runFit).not.toHaveBeenCalled();

    controller.requestFit();
    controller.requestFit();
    controller.requestFit();
    controller.requestFit();
    expect(runFit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(runFit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(runFit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("runs at most once per throttle window during a sustained drag", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    controller.requestFit();
    vi.advanceTimersByTime(200);
    expect(runFit).toHaveBeenCalledTimes(1);

    controller.requestFit();
    vi.advanceTimersByTime(200);
    expect(runFit).toHaveBeenCalledTimes(2);

    controller.requestFit();
    vi.advanceTimersByTime(200);
    expect(runFit).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("flushes a pending fit immediately when the drag ends", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    controller.requestFit();
    vi.advanceTimersByTime(100);
    expect(runFit).not.toHaveBeenCalled();

    drag.end();
    expect(runFit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    expect(runFit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not run on drag end when nothing is pending", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    vi.advanceTimersByTime(200);
    drag.end();

    expect(runFit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("flushes only the pending fit when the drag ends between ticks, with no run after", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    controller.requestFit();
    vi.advanceTimersByTime(200);
    expect(runFit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    controller.requestFit();
    vi.advanceTimersByTime(50);
    drag.end();

    expect(runFit).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(500);
    expect(runFit).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("stops running fits after dispose, even if a run was pending", () => {
    const drag = createFakeDrag();
    const runFit = vi.fn();
    const controller = createTerminalDividerFitThrottle({
      runFit,
      isDragActive: drag.isDragActive,
      subscribeDragActive: drag.subscribeDragActive
    });

    drag.begin();
    controller.requestFit();
    controller.dispose();

    vi.advanceTimersByTime(500);
    expect(runFit).not.toHaveBeenCalled();

    drag.end();
    expect(runFit).not.toHaveBeenCalled();

    controller.requestFit();
    expect(runFit).not.toHaveBeenCalled();
  });
});
