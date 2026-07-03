import {
  isPaneDividerDragActive,
  subscribePaneDividerDrag
} from "./paneDividerDrag";

const DEFAULT_DIVIDER_FIT_THROTTLE_MS = 200;

export interface TerminalDividerFitThrottleOptions {
  runFit: () => void;
  isDragActive?: () => boolean;
  subscribeDragActive?: (listener: (active: boolean) => void) => () => void;
  throttleMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface TerminalDividerFitThrottleController {
  requestFit: () => void;
  dispose: () => void;
}

export function createTerminalDividerFitThrottle({
  runFit,
  isDragActive = isPaneDividerDragActive,
  subscribeDragActive = subscribePaneDividerDrag,
  throttleMs = DEFAULT_DIVIDER_FIT_THROTTLE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}: TerminalDividerFitThrottleOptions): TerminalDividerFitThrottleController {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const flushIfPending = (): void => {
    if (!pending) {
      return;
    }
    pending = false;
    runFit();
  };

  const fire = (): void => {
    timer = null;
    if (disposed) {
      return;
    }
    flushIfPending();
  };

  const requestFit = (): void => {
    if (disposed) {
      return;
    }
    if (!isDragActive()) {
      clearTimer();
      pending = false;
      runFit();
      return;
    }
    pending = true;
    if (timer === null) {
      timer = setTimeoutFn(fire, throttleMs);
    }
  };

  const unsubscribe = subscribeDragActive((dragActive) => {
    if (dragActive || disposed) {
      return;
    }
    clearTimer();
    flushIfPending();
  });

  return {
    requestFit,
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      clearTimer();
      pending = false;
    }
  };
}
