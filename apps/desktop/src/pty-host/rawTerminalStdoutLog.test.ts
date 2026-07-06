import { describe, expect, it } from "vitest";

import { PTY_STDOUT_LOGS_ENV } from "../shared/diagnostics";
import { createRawTerminalEventStdoutLogger } from "./rawTerminalStdoutLog";

describe("raw terminal stdout logging", () => {
  it("does not write when the stdout logging flag is disabled", () => {
    const writes: string[] = [];
    const logger = createRawTerminalEventStdoutLogger(
      {
        [PTY_STDOUT_LOGS_ENV]: "0"
      },
      (line) => writes.push(line)
    );

    logger({
      kind: "osc.9",
      surfaceId: "surface_1",
      sessionId: "session_1",
      payloadLength: 42,
      parsed: true
    });

    expect(writes).toEqual([]);
  });

  it("writes only redacted terminal event metadata when enabled", () => {
    const writes: string[] = [];
    const now = new Date(2026, 6, 6, 20, 29, 3, 938);
    const logger = createRawTerminalEventStdoutLogger(
      {
        [PTY_STDOUT_LOGS_ENV]: "1"
      },
      (line) => writes.push(line),
      () => now
    );

    logger({
      kind: "osc.777",
      surfaceId: "surface_1",
      sessionId: "session_1",
      payloadLength: 128,
      parsed: true,
      hasTitle: true,
      hasMessage: true
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("2026-07-06 20:29:03.938 ")).toBe(true);
    const jsonStart = writes[0].indexOf("{");
    expect(jsonStart).toBeGreaterThan(0);
    expect(JSON.parse(writes[0].slice(jsonStart))).toEqual({
      scope: "pty-host.raw-terminal-event",
      timestamp: now.toISOString(),
      kind: "osc.777",
      surfaceId: "surface_1",
      sessionId: "session_1",
      payloadLength: 128,
      parsed: true,
      hasTitle: true,
      hasMessage: true
    });
    expect(writes[0]).not.toContain("title=");
    expect(writes[0]).not.toContain("message=");
  });
});
