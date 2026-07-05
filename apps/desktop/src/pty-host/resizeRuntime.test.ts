import { describe, expect, it, vi } from "vitest";

import {
  handleTerminalResizeRequest,
  prepareTerminalResize
} from "./resizeRuntime";

describe("pty-host resize runtime", () => {
  it("flushes pending output before applying and acking a resize", () => {
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
    const flushOutput = vi.fn(() => {
      events.push("flush");
    });

    const resized = prepareTerminalResize({
      record,
      cols: 120,
      rows: 40,
      flushOutput
    });

    events.push("ack");

    expect(resized).toBe(true);
    expect(events).toEqual([
      "flush",
      "ptyResize.request",
      "terminal.resize",
      "ack"
    ]);
    expect(record.ptyResize.request).toHaveBeenCalledWith(120, 40, {
      hold: false
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
      gestureActive: true,
      flushOutput: vi.fn()
    });

    expect(record.ptyResize.request).toHaveBeenCalledWith(100, 24, {
      hold: true
    });
  });

  it("emits a resize barrier after a valid no-op PTY resize", () => {
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
    const flushOutput = vi.fn(() => {
      events.push("flush");
    });
    const emitResize = vi.fn(() => {
      events.push("resize");
    });
    const emitAck = vi.fn(() => {
      events.push("ack");
    });

    handleTerminalResizeRequest({
      record,
      sessionId: "session_1",
      attachId: "attach_1",
      requestId: "resize_1",
      cols: 120,
      rows: 40,
      flushOutput,
      emitResize,
      emitAck
    });

    expect(events).toEqual(["flush", "ptyResize.request", "resize", "ack"]);
    expect(record.terminal.resize).not.toHaveBeenCalled();
    // Grid no-ops still reach the pty sink: a held PTY commit converges to
    // the grid size through them (e.g. the gesture-end release request).
    expect(record.ptyResize.request).toHaveBeenCalledWith(120, 40, {
      hold: false
    });
    expect(emitResize).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
      attachId: "attach_1",
      cols: 120,
      rows: 40
    });
    expect(emitAck).toHaveBeenCalledWith({
      sessionId: "session_1",
      requestId: "resize_1",
      cols: 120,
      rows: 40
    });
  });
});
