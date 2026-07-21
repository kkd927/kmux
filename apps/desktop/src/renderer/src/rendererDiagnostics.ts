import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent,
  subscribeRendererDiagnosticsLogging
} from "./smoothnessProfile";

const SAMPLE_INTERVAL_MS = 5_000;
const INTERACTION_RATE_LIMIT_MS = 250;
const INTERACTION_EVENTS = [
  "pointerdown",
  "click",
  "keydown",
  "input",
  "paste",
  "wheel",
  "touchstart",
  "focusin"
] as const;

interface ChromiumPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function installRendererDiagnostics(): () => void {
  let enabled = isRendererSmoothnessProfileEnabled();
  let expectedSampleAt = performance.now() + SAMPLE_INTERVAL_MS;
  const lastInteractionAt = new Map<string, number>();
  const unsubscribe = subscribeRendererDiagnosticsLogging((nextEnabled) => {
    enabled = nextEnabled;
    expectedSampleAt = performance.now() + SAMPLE_INTERVAL_MS;
    if (!enabled) {
      lastInteractionAt.clear();
    }
  });

  const onInteraction = (event: Event): void => {
    if (!enabled) return;
    const target = event.target instanceof Element ? event.target : null;
    const targetRole = target?.getAttribute("role") ?? undefined;
    const targetTestId =
      target?.closest<HTMLElement>("[data-testid]")?.dataset.testid;
    const rateLimitKey = `${event.type}:${targetRole ?? ""}:${targetTestId ?? ""}`;
    const interactionAt = performance.now();
    const previousAt = lastInteractionAt.get(rateLimitKey) ?? -Infinity;
    if (interactionAt - previousAt < INTERACTION_RATE_LIMIT_MS) return;
    lastInteractionAt.set(rateLimitKey, interactionAt);

    let byteLength: number | undefined;
    if (event instanceof InputEvent && typeof event.data === "string") {
      byteLength = new TextEncoder().encode(event.data).byteLength;
    }
    recordRendererSmoothnessProfileEvent("renderer.interaction", {
      eventType: event.type,
      targetRole,
      targetTestId,
      byteLength
    });
  };

  for (const eventName of INTERACTION_EVENTS) {
    window.addEventListener(eventName, onInteraction, { capture: true });
  }

  const onError = (event: ErrorEvent): void => {
    if (!enabled) return;
    recordRendererSmoothnessProfileEvent("renderer.error", {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (!enabled) return;
    const reason = event.reason;
    recordRendererSmoothnessProfileEvent("renderer.unhandled-rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  const sampleTimer = window.setInterval(() => {
    const sampledAt = performance.now();
    const eventLoopDelayMs = Math.max(0, sampledAt - expectedSampleAt);
    expectedSampleAt = sampledAt + SAMPLE_INTERVAL_MS;
    if (!enabled) return;
    const memory = (
      performance as Performance & { memory?: ChromiumPerformanceMemory }
    ).memory;
    recordRendererSmoothnessProfileEvent("renderer.event-loop-memory.sample", {
      eventLoopDelayMs,
      visibilityState: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      usedJSHeapSize: memory?.usedJSHeapSize,
      totalJSHeapSize: memory?.totalJSHeapSize,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit
    });
  }, SAMPLE_INTERVAL_MS);

  return () => {
    unsubscribe();
    window.clearInterval(sampleTimer);
    for (const eventName of INTERACTION_EVENTS) {
      window.removeEventListener(eventName, onInteraction, { capture: true });
    }
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
