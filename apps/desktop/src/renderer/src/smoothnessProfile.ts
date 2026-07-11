import type {
  SmoothnessProfileEvent,
  SmoothnessProfileEventName
} from "../../shared/smoothnessProfile";

const PROFILE_BATCH_MAX_EVENTS = 256;
const PROFILE_BATCH_FLUSH_MS = 200;
const pendingEvents: SmoothnessProfileEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function isRendererSmoothnessProfileEnabled(): boolean {
  const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
  return Boolean(bridge?.profileSmoothnessEnabled?.());
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
    flushRendererSmoothnessProfileEvents();
    return;
  }
  flushTimer ??= setTimeout(
    flushRendererSmoothnessProfileEvents,
    PROFILE_BATCH_FLUSH_MS
  );
}

function flushRendererSmoothnessProfileEvents(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingEvents.length === 0) {
    return;
  }
  const events = pendingEvents.splice(0);
  const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
  if (bridge?.recordSmoothnessProfileEvents) {
    void bridge.recordSmoothnessProfileEvents(events);
    return;
  }
  for (const event of events) {
    void bridge?.recordSmoothnessProfileEvent?.(event);
  }
}
