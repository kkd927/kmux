import type { ShellStoreSnapshot } from "@kmux/proto";

export type SurfaceCloseStrategy =
  | {
      kind: "close-surface";
    }
  | {
      kind: "confirm-workspace-close";
      workspaceId: string;
      isLastWorkspace: boolean;
    };

export type PaneCloseStrategy =
  | {
      kind: "close-pane";
    }
  | {
      kind: "close-surface";
      surfaceId: string;
    }
  | {
      kind: "confirm-workspace-close";
      workspaceId: string;
      isLastWorkspace: boolean;
    };

export function determineSurfaceCloseStrategy(
  view: ShellStoreSnapshot,
  surfaceId: string
): SurfaceCloseStrategy {
  const paneTree = view.activeWorkspacePaneTree;
  const targetPane = Object.values(paneTree.panes).find((pane) =>
    pane.surfaceIds.includes(surfaceId)
  );
  if (!targetPane) {
    return { kind: "close-surface" };
  }

  const totalSurfaceCount = Object.values(paneTree.panes).reduce(
    (count, pane) => count + pane.surfaceIds.length,
    0
  );
  if (totalSurfaceCount !== 1) {
    return { kind: "close-surface" };
  }

  return {
    kind: "confirm-workspace-close",
    workspaceId: view.activeWorkspace.id,
    isLastWorkspace: view.workspaceRows.length === 1
  };
}

export function determinePaneCloseStrategy(
  view: ShellStoreSnapshot,
  paneId: string
): PaneCloseStrategy {
  const paneTree = view.activeWorkspacePaneTree;
  const targetPane = paneTree.panes[paneId];
  if (!targetPane) {
    return { kind: "close-pane" };
  }

  const surfaceId = targetPane.activeSurfaceId ?? targetPane.surfaceIds[0];
  if (!surfaceId) {
    return { kind: "close-pane" };
  }

  if (targetPane.surfaceIds.length > 1) {
    return {
      kind: "close-surface",
      surfaceId
    };
  }

  if (Object.keys(paneTree.panes).length > 1) {
    return { kind: "close-pane" };
  }

  const surfaceStrategy = determineSurfaceCloseStrategy(view, surfaceId);
  if (surfaceStrategy.kind === "confirm-workspace-close") {
    return surfaceStrategy;
  }

  return {
    kind: "close-surface",
    surfaceId
  };
}
