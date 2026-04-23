import type {
  SmoothnessProfileEvent,
  SmoothnessProfileEventName
} from "../../shared/smoothnessProfile";

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
  const bridge = window.kmux as Partial<typeof window.kmux> | undefined;
  void bridge?.recordSmoothnessProfileEvent?.(event);
}
