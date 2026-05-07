import { useEffect, useMemo, useRef } from "react";

import type { Id, ShellStoreSnapshot } from "@kmux/proto";

interface UseWorkspaceWebglLruSyncOptions {
  activeWorkspacePaneTree: ShellStoreSnapshot["activeWorkspacePaneTree"] | null;
  workspacePaneTrees: ShellStoreSnapshot["workspacePaneTrees"];
  touchPane: (paneId: Id) => void;
  forgetPane: (paneId: Id) => void;
  releaseTerminalSurface: (surfaceId: Id) => void;
}

export function useWorkspaceWebglLruSync({
  activeWorkspacePaneTree,
  workspacePaneTrees,
  touchPane,
  forgetPane,
  releaseTerminalSurface
}: UseWorkspaceWebglLruSyncOptions): void {
  const activePaneId = activeWorkspacePaneTree?.activePaneId ?? null;

  useEffect(() => {
    if (activePaneId) {
      touchPane(activePaneId);
    }
  }, [activePaneId, touchPane]);

  const allPaneIds = useMemo(
    () =>
      Object.values(workspacePaneTrees)
        .flatMap((tree) => Object.keys(tree.panes))
        .sort(),
    [workspacePaneTrees]
  );
  const allSurfaceIds = useMemo(
    () =>
      Object.values(workspacePaneTrees)
        .flatMap((tree) => Object.keys(tree.surfaces))
        .sort(),
    [workspacePaneTrees]
  );
  const prevAllPaneIdsRef = useRef(new Set<Id>());
  const prevAllSurfaceIdsRef = useRef(new Set<Id>());

  useEffect(() => {
    const currentIds = new Set(allPaneIds);
    for (const paneId of prevAllPaneIdsRef.current) {
      if (!currentIds.has(paneId)) {
        forgetPane(paneId);
      }
    }
    prevAllPaneIdsRef.current = currentIds;
  }, [allPaneIds, forgetPane]);

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
