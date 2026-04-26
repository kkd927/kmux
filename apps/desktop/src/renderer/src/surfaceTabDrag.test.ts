import { describe, expect, it } from "vitest";

import {
  canDropSurfaceTabOnPane,
  decodeSurfaceTabDragPayload,
  encodeSurfaceTabDragPayload,
  resolveSurfaceTabDropDirection,
  SURFACE_TAB_DROP_PROMPT
} from "./surfaceTabDrag";

const rect = {
  left: 100,
  top: 200,
  width: 300,
  height: 240
};

describe("surface tab drag helpers", () => {
  it("encodes and decodes surface tab drag payloads", () => {
    const encoded = encodeSurfaceTabDragPayload({
      surfaceId: "surface_1",
      sourcePaneId: "pane_1"
    });

    expect(decodeSurfaceTabDragPayload(encoded)).toEqual({
      surfaceId: "surface_1",
      sourcePaneId: "pane_1"
    });
    expect(decodeSurfaceTabDragPayload("{")).toBeNull();
    expect(decodeSurfaceTabDragPayload('{"surfaceId":"surface_1"}')).toBeNull();
  });

  it("maps pointer positions to half-pane drop directions", () => {
    expect(resolveSurfaceTabDropDirection(rect, 120, 260)).toBe("left");
    expect(resolveSurfaceTabDropDirection(rect, 249, 260)).toBe("left");
    expect(resolveSurfaceTabDropDirection(rect, 251, 260)).toBe("right");
    expect(resolveSurfaceTabDropDirection(rect, 380, 260)).toBe("right");
    expect(resolveSurfaceTabDropDirection(rect, 250, 321)).toBe("down");
    expect(resolveSurfaceTabDropDirection(rect, 120, 421)).toBe("down");
  });

  it("rejects a self split move when the source pane has only one surface", () => {
    expect(
      canDropSurfaceTabOnPane(
        { surfaceId: "surface_1", sourcePaneId: "pane_1" },
        "pane_1",
        1
      )
    ).toBe(false);
    expect(
      canDropSurfaceTabOnPane(
        { surfaceId: "surface_1", sourcePaneId: "pane_1" },
        "pane_1",
        2
      )
    ).toBe(true);
    expect(
      canDropSurfaceTabOnPane(
        { surfaceId: "surface_1", sourcePaneId: "pane_1" },
        "pane_2",
        1
      )
    ).toBe(true);
  });

  it("uses kmux-specific prompt text while dragging a surface tab", () => {
    expect(SURFACE_TAB_DROP_PROMPT).toBe(
      "Drop on a pane edge to move this surface"
    );
  });
});
