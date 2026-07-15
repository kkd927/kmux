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

export type TerminalForegroundFitTrigger =
  | "window-focus"
  | "window-pageshow"
  | "window-resize"
  | "document-visible"
  | "fit-element-initial-measurement"
  | "fit-element-dimension-change"
  | "manual";

const NO_FOREGROUND_FIT_TRIGGERS: readonly TerminalForegroundFitTrigger[] = [];

export interface TerminalForegroundFitOptions {
  targetWindow?: ForegroundFitWindow;
  targetDocument?: ForegroundFitDocument;
  isActive: () => boolean;
  fitAndSync: (
    triggers: readonly TerminalForegroundFitTrigger[]
  ) => void | Promise<void>;
  /** Trigger metadata is diagnostic-only and remains unallocated when false. */
  shouldCollectTriggers?: () => boolean;
  getFitElement?: () => ForegroundFitElement | null;
  delayMs?: number;
  frameFallbackMs?: number;
  dimensionPollMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

export interface TerminalForegroundFitController {
  scheduleFit: (trigger?: TerminalForegroundFitTrigger) => void;
  dispose: () => void;
}

export function installTerminalForegroundFit({
  targetWindow = typeof window === "undefined" ? undefined : window,
  targetDocument = typeof document === "undefined" ? undefined : document,
  isActive,
  fitAndSync,
  shouldCollectTriggers = () => true,
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
  let pendingTriggers: Set<TerminalForegroundFitTrigger> | null = null;

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
      pendingTriggers = null;
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
    const triggers = pendingTriggers
      ? Array.from(pendingTriggers)
      : NO_FOREGROUND_FIT_TRIGGERS;
    pendingTriggers = null;
    try {
      void Promise.resolve(fitAndSync(triggers)).catch((error: unknown) => {
        onError?.(error);
      });
    } catch (error) {
      onError?.(error);
    }
  };

  const scheduleFit = (
    trigger: TerminalForegroundFitTrigger = "manual"
  ): void => {
    if (disposed || !isActive()) {
      return;
    }
    if (shouldCollectTriggers()) {
      pendingTriggers ??= new Set<TerminalForegroundFitTrigger>();
      pendingTriggers.add(trigger);
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
    const firstMeasurement = previousWidth === null || previousHeight === null;
    const changed =
      !firstMeasurement &&
      (Math.abs(width - previousWidth) >= 1 ||
        Math.abs(height - previousHeight) >= 1);
    lastObservedWidth = width;
    lastObservedHeight = height;
    if (firstMeasurement) {
      scheduleFit("fit-element-initial-measurement");
    } else if (changed) {
      scheduleFit("fit-element-dimension-change");
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
      scheduleFit("document-visible");
    }
  };

  const handleFocus = (): void => scheduleFit("window-focus");
  const handlePageShow = (): void => scheduleFit("window-pageshow");
  const handleResize = (): void => scheduleFit("window-resize");

  targetWindow.addEventListener("focus", handleFocus);
  targetWindow.addEventListener("pageshow", handlePageShow);
  targetWindow.addEventListener("resize", handleResize);
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
      targetWindow.removeEventListener("focus", handleFocus);
      targetWindow.removeEventListener("pageshow", handlePageShow);
      targetWindow.removeEventListener("resize", handleResize);
      targetDocument.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      clearScheduledFit();
      pendingTriggers = null;
    }
  };
}
