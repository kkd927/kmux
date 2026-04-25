import { describe, expect, it, vi } from "vitest";

import { prepareTerminalResize } from "./resizeRuntime";

describe("pty-host resize runtime", () => {
  it("flushes pending output before applying and acking a resize", () => {
    const events: string[] = [];
    const record = {
      sessionId: "session_1",
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
});
