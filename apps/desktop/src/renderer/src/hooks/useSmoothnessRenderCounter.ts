import { useEffect, useRef } from "react";

import type { SmoothnessProfileEventName } from "../../../shared/smoothnessProfile";
import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent
} from "../smoothnessProfile";

export function useSmoothnessRenderCounter(
  eventName: Extract<
    SmoothnessProfileEventName,
    "pane-tree.render" | "terminal-pane.render"
  >,
  details: () => Record<string, unknown>
): void {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    if (!isRendererSmoothnessProfileEnabled()) {
      return;
    }
    recordRendererSmoothnessProfileEvent(eventName, {
      ...details(),
      renderCount: renderCountRef.current
    });
  });
}
