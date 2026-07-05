import { describe, expect, it, vi } from "vitest";

import { resizeTerminalKeepingBottomAnchor } from "./terminalResizeAnchor";

function createTerminal(options: {
  viewportY: number;
  baseY: number;
  afterResize?: { viewportY: number; baseY: number };
}): {
  buffer: { active: { viewportY: number; baseY: number } };
  resize: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
} {
  const active = { viewportY: options.viewportY, baseY: options.baseY };
  return {
    buffer: { active },
    resize: vi.fn(() => {
      if (options.afterResize) {
        active.viewportY = options.afterResize.viewportY;
        active.baseY = options.afterResize.baseY;
      }
    }),
    scrollToBottom: vi.fn()
  };
}

describe("resizeTerminalKeepingBottomAnchor", () => {
  it("re-pins the viewport when a bottom-following terminal drifts on resize", () => {
    const terminal = createTerminal({
      viewportY: 120,
      baseY: 120,
      afterResize: { viewportY: 96, baseY: 132 }
    });

    resizeTerminalKeepingBottomAnchor(terminal, 100, 30);

    expect(terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when reflow already kept the viewport at the bottom", () => {
    const terminal = createTerminal({
      viewportY: 120,
      baseY: 120,
      afterResize: { viewportY: 132, baseY: 132 }
    });

    resizeTerminalKeepingBottomAnchor(terminal, 100, 30);

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("leaves the viewport alone when the user had scrolled up", () => {
    const terminal = createTerminal({
      viewportY: 40,
      baseY: 120,
      afterResize: { viewportY: 35, baseY: 132 }
    });

    resizeTerminalKeepingBottomAnchor(terminal, 100, 30);

    expect(terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });
});
