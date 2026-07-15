import type {
  SmoothnessProfileEvent,
  SmoothnessProfileEventName
} from "../../shared/smoothnessProfile";

const PROFILE_BATCH_MAX_EVENTS = 256;
const PROFILE_BATCH_FLUSH_MS = 200;
const pendingEvents: SmoothnessProfileEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushOperation = Promise.resolve();

export function isRendererSmoothnessProfileEnabled(): boolean {
  const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
  return Boolean(bridge?.profileSmoothnessEnabled?.());
}

export function subscribeRendererDiagnosticsLogging(
  listener: (enabled: boolean) => void
): () => void {
  const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
  return bridge?.subscribeDiagnosticsLogging?.(listener) ?? (() => {});
}

export function recordRendererSmoothnessProfileEvent(
  name: SmoothnessProfileEventName,
  details: Record<string, unknown>
): void {
  if (!isRendererSmoothnessProfileEnabled()) {
    return;
  }
  const event: SmoothnessProfileEvent = {
    source: "renderer",
    name,
    at: performance.now(),
    details
  };
  pendingEvents.push(event);
  if (pendingEvents.length >= PROFILE_BATCH_MAX_EVENTS) {
    void flushRendererSmoothnessProfileEvents();
    return;
  }
  flushTimer ??= setTimeout(
    () => void flushRendererSmoothnessProfileEvents(),
    PROFILE_BATCH_FLUSH_MS
  );
}

export function flushRendererSmoothnessProfileEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const events = pendingEvents.splice(0);
  if (events.length > 0) {
    const send = async (): Promise<void> => {
      const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
      if (bridge?.recordSmoothnessProfileEvents) {
        await bridge.recordSmoothnessProfileEvents(events);
        return;
      }
      for (const event of events) {
        await bridge?.recordSmoothnessProfileEvent?.(event);
      }
    };
    flushOperation = flushOperation.then(send, send).catch(() => undefined);
  }
  return flushOperation;
}

export async function clearRendererDiagnosticLog(): Promise<boolean> {
  await flushRendererSmoothnessProfileEvents();
  return window.kmux.clearDiagnosticLog();
}
