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
      pty: {
        resize: vi.fn(() => {
          events.push("pty.resize");
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
    expect(events).toEqual(["flush", "terminal.resize", "pty.resize", "ack"]);
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
      pty: {
        resize: vi.fn(() => {
          events.push("pty.resize");
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
      requestId: "resize_1",
      cols: 120,
      rows: 40,
      flushOutput,
      emitResize,
      emitAck
    });

    expect(events).toEqual(["flush", "resize", "ack"]);
    expect(record.terminal.resize).not.toHaveBeenCalled();
    expect(record.pty.resize).not.toHaveBeenCalled();
    expect(emitResize).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
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
