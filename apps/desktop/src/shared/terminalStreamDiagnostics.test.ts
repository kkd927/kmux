import { describe, expect, it } from "vitest";
import { uint64 } from "@kmux/proto";

import { normalizeTerminalStreamErrorReport } from "./terminalStreamDiagnostics";

describe("terminal stream diagnostics", () => {
  it("normalizes a supported structured error and removes extra renderer fields", () => {
    expect(
      normalizeTerminalStreamErrorReport({
        surfaceId: "surface_1",
        sessionId: "session_1",
        ignored: "outside-contract",
        error: {
          kind: "sequence-gap",
          expectedSequence: uint64(41n),
          receivedSequence: uint64(43n),
          message: "expected sequence 41, received 43",
          ignored: "outside-contract"
        }
      })
    ).toEqual({
      surfaceId: "surface_1",
      sessionId: "session_1",
      error: {
        kind: "sequence-gap",
        expectedSequence: uint64(41n),
        receivedSequence: uint64(43n),
        message: "expected sequence 41, received 43"
      }
    });
  });

  it("rejects malformed reports and bounds renderer-controlled messages", () => {
    expect(
      normalizeTerminalStreamErrorReport({
        surfaceId: "surface_1",
        sessionId: "session_1",
        error: {
          kind: "host-error",
          code: "not-a-host-code",
          message: "failed",
          recoverable: false
        }
      })
    ).toBeNull();

    const normalized = normalizeTerminalStreamErrorReport({
      surfaceId: "surface_1",
      sessionId: "session_1",
      error: {
        kind: "sink-error",
        message: "x".repeat(5_000)
      }
    });

    expect(normalized?.error.message).toHaveLength(4_096);
    expect(normalized?.error.message.endsWith("…")).toBe(true);
  });
});
