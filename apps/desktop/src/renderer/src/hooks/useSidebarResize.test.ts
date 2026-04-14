import {describe, expect, it} from "vitest";

import {clampSidebarWidthForWindow, maxSidebarWidthForWindow} from "./useSidebarResize";

describe("sidebar sizing helpers", () => {
  it("clamps wide windows to the full sidebar range", () => {
    expect(maxSidebarWidthForWindow(1400)).toBe(320);
    expect(clampSidebarWidthForWindow(400, 1400)).toBe(320);
    expect(clampSidebarWidthForWindow(80, 1400)).toBe(110);
  });

  it("clamps narrow windows to the reduced maximum without mutating the source width", () => {
    expect(maxSidebarWidthForWindow(1000)).toBe(272);
    expect(clampSidebarWidthForWindow(320, 1000)).toBe(272);
    expect(clampSidebarWidthForWindow(271.6, 1000)).toBe(272);
  });
});
