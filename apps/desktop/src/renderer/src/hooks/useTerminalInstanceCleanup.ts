import { useEffect } from "react";

import type { Id } from "@kmux/proto";
import { subscribeRemovedTerminalSurfaces } from "./useShellStore";

interface UseTerminalInstanceCleanupOptions {
  releaseTerminalSurface: (surfaceId: Id) => void;
  forgetTerminalStreamSurface?: (surfaceId: Id) => void;
}

export function useTerminalInstanceCleanup({
  releaseTerminalSurface,
  forgetTerminalStreamSurface
}: UseTerminalInstanceCleanupOptions): void {
  useEffect(
    () =>
      subscribeRemovedTerminalSurfaces((surfaceIds) => {
        for (const surfaceId of surfaceIds) {
          forgetTerminalStreamSurface?.(surfaceId);
          releaseTerminalSurface(surfaceId);
        }
      }),
    [forgetTerminalStreamSurface, releaseTerminalSurface]
  );
}
