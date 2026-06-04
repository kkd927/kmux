const DEFAULT_FOREGROUND_FIT_DELAY_MS = 120;

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

export interface TerminalForegroundFitOptions {
  targetWindow?: ForegroundFitWindow;
  targetDocument?: ForegroundFitDocument;
  isActive: () => boolean;
  fitAndSync: () => void | Promise<void>;
  delayMs?: number;
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
  delayMs = DEFAULT_FOREGROUND_FIT_DELAY_MS,
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
  let firstAnimationFrame: number | null = null;
  let secondAnimationFrame: number | null = null;
  let disposed = false;

  const clearScheduledFit = (): void => {
    if (timeout !== null) {
      clearTimeoutFn(timeout);
      timeout = null;
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
      firstAnimationFrame = targetWindow.requestAnimationFrame(() => {
        firstAnimationFrame = null;
        secondAnimationFrame = targetWindow.requestAnimationFrame(() => {
          secondAnimationFrame = null;
          runFit();
        });
      });
    }, delayMs);
  };

  const handleVisibilityChange = (): void => {
    if (targetDocument.visibilityState === "visible") {
      scheduleFit();
    }
  };

  targetWindow.addEventListener("focus", scheduleFit);
  targetWindow.addEventListener("pageshow", scheduleFit);
  targetDocument.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    scheduleFit,
    dispose: () => {
      disposed = true;
      targetWindow.removeEventListener("focus", scheduleFit);
      targetWindow.removeEventListener("pageshow", scheduleFit);
      targetDocument.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      clearScheduledFit();
    }
  };
}
