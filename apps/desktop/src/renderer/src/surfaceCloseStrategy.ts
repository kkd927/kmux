import type { ShellViewModel } from "@kmux/proto";

export type SurfaceCloseStrategy =
  | {
      kind: "close-surface";
    }
  | {
      kind: "confirm-workspace-close";
      workspaceId: string;
      isLastWorkspace: boolean;
    };

export function determineSurfaceCloseStrategy(
  view: ShellViewModel,
  surfaceId: string
): SurfaceCloseStrategy {
  const targetPane = Object.values(view.activeWorkspace.panes).find((pane) =>
    pane.surfaceIds.includes(surfaceId)
  );
  if (!targetPane) {
    return { kind: "close-surface" };
  }

  const totalSurfaceCount = Object.values(view.activeWorkspace.panes).reduce(
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
