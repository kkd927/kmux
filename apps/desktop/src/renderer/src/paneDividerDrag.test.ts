import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginPaneDividerDrag,
  endPaneDividerDrag,
  isPaneDividerDragActive,
  resetPaneDividerDragForTests,
  subscribePaneDividerDrag
} from "./paneDividerDrag";

afterEach(() => {
  resetPaneDividerDragForTests();
});

describe("pane divider drag", () => {
  it("starts inactive", () => {
    expect(isPaneDividerDragActive()).toBe(false);
  });

  it("marks the drag active and notifies subscribers on begin", () => {
    const listener = vi.fn();
    subscribePaneDividerDrag(listener);

    beginPaneDividerDrag();

    expect(isPaneDividerDragActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("marks the drag inactive and notifies subscribers on end", () => {
    const listener = vi.fn();
    beginPaneDividerDrag();
    subscribePaneDividerDrag(listener);

    endPaneDividerDrag();

    expect(isPaneDividerDragActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("is idempotent across repeated begin calls", () => {
    const listener = vi.fn();
    subscribePaneDividerDrag(listener);

    beginPaneDividerDrag();
    beginPaneDividerDrag();
    beginPaneDividerDrag();

    expect(isPaneDividerDragActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when ending without an active drag", () => {
    const listener = vi.fn();
    subscribePaneDividerDrag(listener);

    endPaneDividerDrag();

    expect(isPaneDividerDragActive()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePaneDividerDrag(listener);

    unsubscribe();
    beginPaneDividerDrag();

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps notifying remaining listeners when one unsubscribes itself mid-dispatch", () => {
    const other = vi.fn();
    let unsubscribeSelf: (() => void) | null = null;
    const self = vi.fn(() => {
      unsubscribeSelf?.();
    });
    unsubscribeSelf = subscribePaneDividerDrag(self);
    subscribePaneDividerDrag(other);

    beginPaneDividerDrag();
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);

    endPaneDividerDrag();
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("resets active state and listeners for tests", () => {
    const listener = vi.fn();
    subscribePaneDividerDrag(listener);
    beginPaneDividerDrag();
    expect(isPaneDividerDragActive()).toBe(true);

    resetPaneDividerDragForTests();
    listener.mockClear();

    expect(isPaneDividerDragActive()).toBe(false);
    beginPaneDividerDrag();
    expect(listener).not.toHaveBeenCalled();
  });
});
