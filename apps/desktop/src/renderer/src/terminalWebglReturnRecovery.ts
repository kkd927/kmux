const DEFAULT_WEBGL_RETURN_RECOVERY_MIN_INTERVAL_MS = 1000;

export interface TerminalWebglReturnRecoveryOptions {
  window: Window;
  document: Document;
  recover: () => void;
  minIntervalMs?: number;
  now?: () => number;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

export function installTerminalWebglReturnRecovery(
  options: TerminalWebglReturnRecoveryOptions
): () => void {
  const minIntervalMs =
    options.minIntervalMs ?? DEFAULT_WEBGL_RETURN_RECOVERY_MIN_INTERVAL_MS;
  const now = options.now ?? (() => options.window.performance.now());
  const requestFrame =
    options.requestAnimationFrame ??
    ((callback) => options.window.requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelAnimationFrame ??
    ((handle) => options.window.cancelAnimationFrame(handle));
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let frame: number | null = null;

  const scheduleRecovery = (): void => {
    if (options.document.visibilityState !== "visible") {
      return;
    }
    const currentTime = now();
    if (currentTime - lastRecoveryAt < minIntervalMs) {
      return;
    }
    lastRecoveryAt = currentTime;
    if (frame !== null) {
      cancelFrame(frame);
    }
    frame = requestFrame(() => {
      frame = null;
      options.recover();
    });
  };

  options.window.addEventListener("focus", scheduleRecovery);
  options.document.addEventListener("visibilitychange", scheduleRecovery);

  return () => {
    options.window.removeEventListener("focus", scheduleRecovery);
    options.document.removeEventListener("visibilitychange", scheduleRecovery);
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };
}
