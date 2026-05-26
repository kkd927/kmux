import { useEffect, useMemo, useRef } from "react";

import type { Id, ShellStoreSnapshot } from "@kmux/proto";

interface UseTerminalInstanceCleanupOptions {
  workspacePaneTrees: ShellStoreSnapshot["workspacePaneTrees"];
  releaseTerminalSurface: (surfaceId: Id) => void;
}

export function useTerminalInstanceCleanup({
  workspacePaneTrees,
  releaseTerminalSurface
}: UseTerminalInstanceCleanupOptions): void {
  const allSurfaceIds = useMemo(
    () =>
      Object.values(workspacePaneTrees)
        .flatMap((tree) => Object.keys(tree.surfaces))
        .sort(),
    [workspacePaneTrees]
  );
  const prevAllSurfaceIdsRef = useRef(new Set<Id>());

  useEffect(() => {
    const currentIds = new Set(allSurfaceIds);
    for (const surfaceId of prevAllSurfaceIdsRef.current) {
      if (!currentIds.has(surfaceId)) {
        releaseTerminalSurface(surfaceId);
      }
    }
    prevAllSurfaceIdsRef.current = currentIds;
  }, [allSurfaceIds, releaseTerminalSurface]);
}
