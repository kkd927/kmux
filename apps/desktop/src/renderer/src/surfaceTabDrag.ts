export const SURFACE_TAB_DRAG_MIME = "application/x-kmux-surface-tab";
export const SURFACE_TAB_DROP_PROMPT =
  "Drop on a pane edge to move this surface";

export type SurfaceTabDragPayload = {
  surfaceId: string;
  sourcePaneId: string;
};

export type SurfaceTabDropDirection = "left" | "right" | "down";

type DropRect = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

const HALF_ZONE_RATIO = 0.5;

export function encodeSurfaceTabDragPayload(
  payload: SurfaceTabDragPayload
): string {
  return JSON.stringify(payload);
}

export function decodeSurfaceTabDragPayload(
  value: string
): SurfaceTabDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<SurfaceTabDragPayload>;
    if (
      typeof parsed.surfaceId === "string" &&
      parsed.surfaceId &&
      typeof parsed.sourcePaneId === "string" &&
      parsed.sourcePaneId
    ) {
      return {
        surfaceId: parsed.surfaceId,
        sourcePaneId: parsed.sourcePaneId
      };
    }
  } catch {
    // Drag payloads can be absent or owned by another app.
  }
  return null;
}

export function resolveSurfaceTabDropDirection(
  rect: DropRect,
  clientX: number,
  clientY: number
): SurfaceTabDropDirection | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  if (y >= HALF_ZONE_RATIO) {
    return "down";
  }
  if (x <= HALF_ZONE_RATIO) {
    return "left";
  }
  return "right";
}

export function canDropSurfaceTabOnPane(
  payload: SurfaceTabDragPayload,
  targetPaneId: string,
  targetSurfaceCount: number
): boolean {
  return payload.sourcePaneId !== targetPaneId || targetSurfaceCount > 1;
}
