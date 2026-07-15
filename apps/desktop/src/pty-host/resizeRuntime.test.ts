import { describe, expect, it, vi } from "vitest";

import { prepareTerminalResize } from "./resizeRuntime";

describe("pty-host resize runtime", () => {
  it("resizes the PTY before applying the headless grid", () => {
    const events: string[] = [];
    const record = {
      sessionId: "session_1",
      surfaceId: "surface_1",
      cols: 80,
      rows: 24,
      terminal: {
        resize: vi.fn(() => {
          events.push("terminal.resize");
        })
      },
      ptyResize: {
        request: vi.fn(() => {
          events.push("ptyResize.request");
        })
      }
    };
    const resized = prepareTerminalResize({
      record,
      cols: 120,
      rows: 40,
      requestId: "resize_1"
    });

    expect(resized).toBe(true);
    expect(events).toEqual(["ptyResize.request", "terminal.resize"]);
    expect(record.ptyResize.request).toHaveBeenCalledWith(120, 40, {
      hold: false,
      requestId: "resize_1"
    });
  });

  it("marks gesture resizes as held pty commits", () => {
    const record = {
      sessionId: "session_1",
      surfaceId: "surface_1",
      cols: 80,
      rows: 24,
      terminal: { resize: vi.fn() },
      ptyResize: { request: vi.fn() }
    };

    prepareTerminalResize({
      record,
      cols: 100,
      rows: 24,
      gestureActive: true
    });

    expect(record.ptyResize.request).toHaveBeenCalledWith(100, 24, {
      hold: true
    });
  });

  it("releases a held PTY commit for a no-op grid resize", () => {
    const events: string[] = [];
    const record = {
      sessionId: "session_1",
      surfaceId: "surface_1",
      cols: 120,
      rows: 40,
      terminal: {
        resize: vi.fn(() => {
          events.push("terminal.resize");
        })
      },
      ptyResize: {
        request: vi.fn(() => {
          events.push("ptyResize.request");
        })
      }
    };
    const resized = prepareTerminalResize({
      record,
      cols: 120,
      rows: 40
    });

    expect(resized).toBe(false);
    expect(events).toEqual(["ptyResize.request"]);
    expect(record.terminal.resize).not.toHaveBeenCalled();
    // Grid no-ops still reach the pty sink: a held PTY commit converges to
    // the grid size through them (e.g. the gesture-end release request).
    expect(record.ptyResize.request).toHaveBeenCalledWith(120, 40, {
      hold: false
    });
  });
});
