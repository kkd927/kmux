const DEFAULT_FOREGROUND_FIT_DELAY_MS = 120;
const DEFAULT_FOREGROUND_FIT_FRAME_FALLBACK_MS = 160;
const DEFAULT_FOREGROUND_FIT_DIMENSION_POLL_MS = 250;

type ForegroundFitWindow = Pick<
  Window,
  | "addEventListener"
  | "removeEventListener"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
>;

type ForegroundFitDocument = Pick<
  Document,
  "addEventListener" | "removeEventListener" | "visibilityState"
>;

interface ForegroundFitElement {
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "width" | "height">;
}

export interface TerminalForegroundFitOptions {
  targetWindow?: ForegroundFitWindow;
  targetDocument?: ForegroundFitDocument;
  isActive: () => boolean;
  fitAndSync: () => void | Promise<void>;
  getFitElement?: () => ForegroundFitElement | null;
  delayMs?: number;
  frameFallbackMs?: number;
  dimensionPollMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

export interface TerminalForegroundFitController {
  scheduleFit: () => void;
  dispose: () => void;
}

export function installTerminalForegroundFit({
  targetWindow = typeof window === "undefined" ? undefined : window,
  targetDocument = typeof document === "undefined" ? undefined : document,
  isActive,
  fitAndSync,
  getFitElement,
  delayMs = DEFAULT_FOREGROUND_FIT_DELAY_MS,
  frameFallbackMs = DEFAULT_FOREGROUND_FIT_FRAME_FALLBACK_MS,
  dimensionPollMs = DEFAULT_FOREGROUND_FIT_DIMENSION_POLL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onError
}: TerminalForegroundFitOptions): TerminalForegroundFitController {
  if (!targetWindow || !targetDocument) {
    return {
      scheduleFit: () => {},
      dispose: () => {}
    };
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let frameFallbackTimeout: ReturnType<typeof setTimeout> | null = null;
  let dimensionPollTimeout: ReturnType<typeof setTimeout> | null = null;
  let firstAnimationFrame: number | null = null;
  let secondAnimationFrame: number | null = null;
  let disposed = false;
  let lastObservedWidth: number | null = null;
  let lastObservedHeight: number | null = null;

  const clearScheduledFit = (): void => {
    if (timeout !== null) {
      clearTimeoutFn(timeout);
      timeout = null;
    }
    if (frameFallbackTimeout !== null) {
      clearTimeoutFn(frameFallbackTimeout);
      frameFallbackTimeout = null;
    }
    if (firstAnimationFrame !== null) {
      targetWindow.cancelAnimationFrame(firstAnimationFrame);
      firstAnimationFrame = null;
    }
    if (secondAnimationFrame !== null) {
      targetWindow.cancelAnimationFrame(secondAnimationFrame);
      secondAnimationFrame = null;
    }
  };

  const runFit = (): void => {
    if (disposed || !isActive()) {
      return;
    }
    if (frameFallbackTimeout !== null) {
      clearTimeoutFn(frameFallbackTimeout);
      frameFallbackTimeout = null;
    }
    if (firstAnimationFrame !== null) {
      targetWindow.cancelAnimationFrame(firstAnimationFrame);
      firstAnimationFrame = null;
    }
    if (secondAnimationFrame !== null) {
      targetWindow.cancelAnimationFrame(secondAnimationFrame);
      secondAnimationFrame = null;
    }
    try {
      void Promise.resolve(fitAndSync()).catch((error: unknown) => {
        onError?.(error);
      });
    } catch (error) {
      onError?.(error);
    }
  };

  const scheduleFit = (): void => {
    if (disposed || !isActive()) {
      return;
    }
    clearScheduledFit();
    timeout = setTimeoutFn(() => {
      timeout = null;
      frameFallbackTimeout = setTimeoutFn(runFit, frameFallbackMs);
      firstAnimationFrame = targetWindow.requestAnimationFrame(() => {
        firstAnimationFrame = null;
        secondAnimationFrame = targetWindow.requestAnimationFrame(() => {
          secondAnimationFrame = null;
          runFit();
        });
      });
    }, delayMs);
  };

  const checkFitElementDimensions = (): void => {
    if (!getFitElement || disposed || !isActive()) {
      return;
    }
    const element = getFitElement();
    const rect = element?.getBoundingClientRect();
    const width = rect?.width ?? null;
    const height = rect?.height ?? null;
    if (width === null || height === null || width <= 0 || height <= 0) {
      return;
    }

    const previousWidth = lastObservedWidth;
    const previousHeight = lastObservedHeight;
    const firstMeasurement =
      previousWidth === null || previousHeight === null;
    const changed =
      !firstMeasurement &&
      (Math.abs(width - previousWidth) >= 1 ||
        Math.abs(height - previousHeight) >= 1);
    lastObservedWidth = width;
    lastObservedHeight = height;
    if (firstMeasurement || changed) {
      scheduleFit();
    }
  };

  const scheduleDimensionPoll = (): void => {
    if (!getFitElement || disposed) {
      return;
    }
    dimensionPollTimeout = setTimeoutFn(() => {
      dimensionPollTimeout = null;
      if (disposed) {
        return;
      }
      checkFitElementDimensions();
      scheduleDimensionPoll();
    }, dimensionPollMs);
  };

  const handleVisibilityChange = (): void => {
    if (targetDocument.visibilityState === "visible") {
      scheduleFit();
    }
  };

  targetWindow.addEventListener("focus", scheduleFit);
  targetWindow.addEventListener("pageshow", scheduleFit);
  targetWindow.addEventListener("resize", scheduleFit);
  targetDocument.addEventListener("visibilitychange", handleVisibilityChange);
  checkFitElementDimensions();
  scheduleDimensionPoll();

  return {
    scheduleFit,
    dispose: () => {
      disposed = true;
      if (dimensionPollTimeout !== null) {
        clearTimeoutFn(dimensionPollTimeout);
        dimensionPollTimeout = null;
      }
      targetWindow.removeEventListener("focus", scheduleFit);
      targetWindow.removeEventListener("pageshow", scheduleFit);
      targetWindow.removeEventListener("resize", scheduleFit);
      targetDocument.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      clearScheduledFit();
    }
  };
}
