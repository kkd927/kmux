import { describe, expect, it, beforeEach } from "vitest";

import {
  applyMarkdownDocumentEvent,
  clearMarkdownSurfaceCacheForTest,
  readMarkdownSurfaceCache,
  sameMarkdownRenderState,
  updateMarkdownSurfaceScroll
} from "./markdownSurfaceCache";

describe("markdownSurfaceCache", () => {
  beforeEach(clearMarkdownSurfaceCacheForTest);

  it("rejects stale events and coalesces snapshots with the same visible body", () => {
    const first = applyMarkdownDocumentEvent({
      type: "snapshot",
      surfaceId: "surface_1",
      revision: 2,
      text: "# Current",
      byteLength: 9
    });
    const duplicate = applyMarkdownDocumentEvent({
      type: "snapshot",
      surfaceId: "surface_1",
      revision: 3,
      text: "# Current",
      byteLength: 9
    });

    expect(first).not.toBeNull();
    expect(duplicate).not.toBeNull();
    expect(sameMarkdownRenderState(first!, duplicate!)).toBe(true);
    expect(
      applyMarkdownDocumentEvent({
        type: "offline",
        surfaceId: "surface_1",
        revision: 1
      })
    ).toBeNull();
    expect(readMarkdownSurfaceCache("surface_1")).toMatchObject({
      revision: 3,
      status: "ready",
      text: "# Current"
    });
  });

  it("preserves the last successful body and scroll position while offline", () => {
    applyMarkdownDocumentEvent({
      type: "snapshot",
      surfaceId: "surface_1",
      revision: 1,
      text: "available offline",
      byteLength: 17
    });
    updateMarkdownSurfaceScroll("surface_1", 240);
    applyMarkdownDocumentEvent({
      type: "offline",
      surfaceId: "surface_1",
      revision: 2
    });

    expect(readMarkdownSurfaceCache("surface_1")).toMatchObject({
      status: "offline",
      text: "available offline",
      scrollTop: 240
    });
  });

  it("keeps an empty successful document through later loading events", () => {
    applyMarkdownDocumentEvent({
      type: "snapshot",
      surfaceId: "surface_empty",
      revision: 1,
      text: "",
      byteLength: 0
    });
    applyMarkdownDocumentEvent({
      type: "loading",
      surfaceId: "surface_empty",
      revision: 2
    });

    expect(readMarkdownSurfaceCache("surface_empty")).toMatchObject({
      status: "ready",
      text: ""
    });
  });

  it("bounds cached closed-or-forgotten surfaces", () => {
    applyMarkdownDocumentEvent({
      type: "snapshot",
      surfaceId: "oldest",
      revision: 1,
      text: "old",
      byteLength: 3
    });
    for (let index = 0; index < 32; index += 1) {
      readMarkdownSurfaceCache(`surface_${index}`);
    }

    expect(readMarkdownSurfaceCache("oldest")).toMatchObject({
      revision: 0,
      status: "loading"
    });
  });
});
