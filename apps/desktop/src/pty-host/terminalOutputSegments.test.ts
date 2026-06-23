import { describe, expect, it } from "vitest";

import {
  flushTerminalOutputSegmenterState,
  splitTerminalOutputByOsc7
} from "./terminalOutputSegments";

describe("terminal output segments", () => {
  it("splits complete OSC 7 sequences away from visible output", () => {
    const result = splitTerminalOutputByOsc7({
      chunk: "before\x1b]7;file://host/repo\x07after"
    });

    expect(result).toEqual({
      segments: [
        { chunk: "before", recordCwd: true },
        { chunk: "\x1b]7;file://host/repo\x07", recordCwd: false },
        { chunk: "after", recordCwd: true }
      ],
      state: { pendingOsc7: false, pendingOsc7Prefix: "" }
    });
  });

  it("supports string-terminator OSC 7 sequences", () => {
    expect(
      splitTerminalOutputByOsc7({
        chunk: "\x1b]7;file://host/repo\x1b\\src/App.tsx"
      }).segments
    ).toEqual([
      { chunk: "\x1b]7;file://host/repo\x1b\\", recordCwd: false },
      { chunk: "src/App.tsx", recordCwd: true }
    ]);
  });

  it("carries pending OSC 7 state across chunks", () => {
    const first = splitTerminalOutputByOsc7({
      chunk: "before\x1b]7;file://host/repo"
    });
    const second = splitTerminalOutputByOsc7({
      chunk: "\x07after",
      state: first.state
    });

    expect(first).toEqual({
      segments: [
        { chunk: "before", recordCwd: true },
        { chunk: "\x1b]7;file://host/repo", recordCwd: false }
      ],
      state: { pendingOsc7: true, pendingOsc7Prefix: "" }
    });
    expect(second).toEqual({
      segments: [
        { chunk: "\x07", recordCwd: false },
        { chunk: "after", recordCwd: true }
      ],
      state: { pendingOsc7: false, pendingOsc7Prefix: "" }
    });
  });

  it.each([1, 2, 3])(
    "carries a partial OSC 7 prefix split after %i byte(s)",
    (splitIndex) => {
      const prefix = "\x1b]7;";
      const first = splitTerminalOutputByOsc7({
        chunk: `before${prefix.slice(0, splitIndex)}`
      });
      const second = splitTerminalOutputByOsc7({
        chunk: `${prefix.slice(splitIndex)}file://host/repo\x07src/App.tsx`,
        state: first.state
      });

      expect(first).toEqual({
        segments: [{ chunk: "before", recordCwd: true }],
        state: {
          pendingOsc7: false,
          pendingOsc7Prefix: prefix.slice(0, splitIndex)
        }
      });
      expect(second).toEqual({
        segments: [
          { chunk: "\x1b]7;file://host/repo\x07", recordCwd: false },
          { chunk: "src/App.tsx", recordCwd: true }
        ],
        state: { pendingOsc7: false, pendingOsc7Prefix: "" }
      });
    }
  );

  it("returns a partial OSC prefix to normal output when it is not OSC 7", () => {
    const first = splitTerminalOutputByOsc7({ chunk: "before\x1b]" });
    const second = splitTerminalOutputByOsc7({
      chunk: "8;id=1\x07after",
      state: first.state
    });

    expect(first).toEqual({
      segments: [{ chunk: "before", recordCwd: true }],
      state: { pendingOsc7: false, pendingOsc7Prefix: "\x1b]" }
    });
    expect(second).toEqual({
      segments: [{ chunk: "\x1b]8;id=1\x07after", recordCwd: true }],
      state: { pendingOsc7: false, pendingOsc7Prefix: "" }
    });
  });

  it("flushes a partial OSC 7 prefix candidate without dropping bytes", () => {
    const first = splitTerminalOutputByOsc7({ chunk: "before\x1b]" });
    const flushed = flushTerminalOutputSegmenterState(first.state);

    expect(first.segments).toEqual([{ chunk: "before", recordCwd: true }]);
    expect(flushed).toEqual({
      segments: [{ chunk: "\x1b]", recordCwd: true }],
      state: { pendingOsc7: false, pendingOsc7Prefix: "" }
    });
  });
});
