import { useEffect } from "react";

import { releaseMarkdownSurfaceCache } from "../surfaces/markdownSurfaceCache";
import { subscribeRemovedSurfaces } from "./useShellStore";

export function useMarkdownSurfaceCacheCleanup(): void {
  useEffect(
    () =>
      subscribeRemovedSurfaces((surfaceIds) => {
        for (const surfaceId of surfaceIds) {
          releaseMarkdownSurfaceCache(surfaceId);
        }
      }),
    []
  );
}
