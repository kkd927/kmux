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
    const logger = createRawTerminalEventStdoutLogger(
      {
        [PTY_STDOUT_LOGS_ENV]: "1"
      },
      (line) => writes.push(line)
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
    expect(JSON.parse(writes[0])).toEqual({
      scope: "pty-host.raw-terminal-event",
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
