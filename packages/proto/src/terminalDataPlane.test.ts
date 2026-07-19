import {
  TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_MAX_INPUT_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  isTerminalDataPlaneClientMessage,
  validateTerminalDataPlaneClientMessage,
  validateTerminalDataPlaneHostMessage
} from "./terminalDataPlane";
import { uint64, type Uint64 } from "./uint64";
import type {
  TerminalCheckpoint,
  TerminalCheckpointMetadata,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneHostMessage,
  TerminalSessionRef
} from "./terminalDataPlane";

const session: TerminalSessionRef = {
  surfaceId: "surface-1",
  sessionId: "session-1",
  epoch: "epoch-1"
};

const envelope = {
  protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  attachId: "attach-1",
  session
} as const;

function u(value: number): Uint64 {
  return uint64(BigInt(value));
}

function checkpoint(
  overrides: Partial<TerminalCheckpoint> = {}
): TerminalCheckpoint {
  return {
    format: "xterm-vt/1",
    session,
    sequence: u(4),
    data: "prompt> ",
    cols: 120,
    rows: 40,
    ...overrides
  };
}

function checkpointMetadata(
  overrides: Partial<TerminalCheckpoint> = {}
): TerminalCheckpointMetadata {
  const { data: _data, ...metadata } = checkpoint(overrides);
  return metadata;
}

describe("terminal data plane client validation", () => {
  it("accepts attach and validates the port capability", () => {
    const message: TerminalDataPlaneClientMessage = {
      ...envelope,
      type: "attach",
      resumeFromSequence: u(3),
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES
    };

    expect(
      validateTerminalDataPlaneClientMessage(message, {
        attachId: envelope.attachId,
        session
      })
    ).toEqual({ ok: true, value: message });
    expect(isTerminalDataPlaneClientMessage(message)).toBe(true);
    expect(
      validateTerminalDataPlaneClientMessage({
        ...message,
        creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES + 1
      })
    ).toEqual({
      ok: false,
      error: `creditBytes exceeds ${TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES} bytes`
    });
  });

  it("rejects stale attach and session epochs", () => {
    const message: TerminalDataPlaneClientMessage = {
      ...envelope,
      type: "credit",
      acknowledgedSequence: u(10),
      bytes: 1024
    };

    expect(
      validateTerminalDataPlaneClientMessage(message, {
        attachId: "attach-replaced",
        session
      })
    ).toEqual({
      ok: false,
      error: "attachId does not match the port capability"
    });
    expect(
      validateTerminalDataPlaneClientMessage(message, {
        attachId: envelope.attachId,
        session: { ...session, epoch: "epoch-2" }
      })
    ).toEqual({
      ok: false,
      error: "session does not match the port capability"
    });
  });

  it("enforces the UTF-8 input limit and byte-valued binary input", () => {
    const oversized = {
      ...envelope,
      type: "input:text",
      text: "한".repeat(Math.floor(TERMINAL_DATA_PLANE_MAX_INPUT_BYTES / 3) + 1)
    };
    const invalidBinary = {
      ...envelope,
      type: "input:binary",
      data: "λ"
    };

    expect(validateTerminalDataPlaneClientMessage(oversized)).toEqual({
      ok: false,
      error: `text exceeds ${TERMINAL_DATA_PLANE_MAX_INPUT_BYTES} bytes`
    });
    expect(validateTerminalDataPlaneClientMessage(invalidBinary)).toEqual({
      ok: false,
      error: "binary input must contain only byte-valued code units"
    });
  });

  it("rejects invalid resize geometry and malformed key modifiers", () => {
    expect(
      validateTerminalDataPlaneClientMessage({
        ...envelope,
        type: "resize",
        cols: 0,
        rows: 40
      })
    ).toMatchObject({ ok: false });
    expect(
      validateTerminalDataPlaneClientMessage({
        ...envelope,
        type: "input:key",
        input: { key: "Enter", ctrlKey: "yes" }
      })
    ).toEqual({
      ok: false,
      error: "input.ctrlKey must be a boolean when provided"
    });
  });
});

describe("terminal data plane host validation", () => {
  it("accepts streamed checkpoint begin and warm-resume attach results", () => {
    const cold: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "checkpoint:begin",
      checkpointId: "checkpoint-1",
      purpose: { kind: "attach" },
      metadata: checkpointMetadata(),
      totalBytes: 8
    };
    const warm: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "attached",
      mode: "resume",
      resumedFromSequence: u(4),
      sequence: u(8),
      cols: 120,
      rows: 40
    };

    expect(validateTerminalDataPlaneHostMessage(cold)).toEqual({
      ok: true,
      value: cold
    });
    expect(validateTerminalDataPlaneHostMessage(warm)).toEqual({
      ok: true,
      value: warm
    });

    const emptyCheckpoint: TerminalDataPlaneHostMessage = {
      ...cold,
      metadata: checkpointMetadata({ data: "", sequence: u(0) }),
      totalBytes: 0
    };
    expect(validateTerminalDataPlaneHostMessage(emptyCheckpoint)).toEqual({
      ok: true,
      value: emptyCheckpoint
    });
  });

  it("requires bounded ArrayBuffer checkpoint chunks and a SHA-256 end digest", () => {
    const bytes = new TextEncoder().encode("prompt> ");
    const chunk: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "checkpoint:chunk",
      checkpointId: "checkpoint-1",
      offset: 0,
      data: bytes.buffer
    };
    const end: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "checkpoint:end",
      checkpointId: "checkpoint-1",
      digest: "0".repeat(64)
    };

    expect(validateTerminalDataPlaneHostMessage(chunk)).toEqual({
      ok: true,
      value: chunk
    });
    expect(validateTerminalDataPlaneHostMessage(end)).toEqual({
      ok: true,
      value: end
    });
    expect(
      validateTerminalDataPlaneHostMessage({ ...chunk, data: "cHJvbXB0PiA=" })
    ).toEqual({
      ok: false,
      error: "checkpoint chunk data must be an ArrayBuffer"
    });
  });

  it("rejects unknown fields at message and nested protocol boundaries", () => {
    expect(
      validateTerminalDataPlaneClientMessage({
        ...envelope,
        type: "input:text",
        text: "hello",
        unbounded: "not part of the protocol"
      })
    ).toEqual({
      ok: false,
      error: "message contains unexpected field unbounded"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...envelope,
        type: "checkpoint:begin",
        checkpointId: "checkpoint-1",
        purpose: { kind: "attach" },
        metadata: { ...checkpointMetadata(), unbounded: true },
        totalBytes: 8
      })
    ).toEqual({
      ok: false,
      error: "checkpoint metadata contains unexpected field unbounded"
    });
  });

  it("accepts ordered output segments with declared byte credit", () => {
    const message: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "delta",
      delta: {
        type: "output",
        fromSequence: u(4),
        sequence: u(6),
        byteLength: 12,
        segments: [
          { sequence: u(5), data: "hello ", byteLength: 6 },
          { sequence: u(6), data: "world\n", byteLength: 6, cwd: "/repo" }
        ]
      }
    };

    expect(validateTerminalDataPlaneHostMessage(message)).toEqual({
      ok: true,
      value: message
    });
  });

  it("validates optional cross-process output telemetry", () => {
    const message: TerminalDataPlaneHostMessage = {
      ...envelope,
      telemetry: { portSentAt: 1_003.5 },
      type: "delta",
      delta: {
        type: "output",
        fromSequence: u(4),
        sequence: u(5),
        byteLength: 5,
        segments: [
          {
            sequence: u(5),
            data: "hello",
            byteLength: 5,
            telemetry: {
              ptyReadAt: 1_000.25,
              headlessCommitAt: 1_002.75,
              outputKind: "screen",
              visibleAtPtyRead: true,
              inputAcceptedAt: 999.75,
              inputSequence: u(1)
              inputKind: "mouse"
            }
          }
        ]
      }
    };

    expect(validateTerminalDataPlaneHostMessage(message)).toEqual({
      ok: true,
      value: message
    });
    if (message.type !== "delta" || message.delta.type !== "output") {
      throw new Error("expected output delta");
    }
    const firstSegment = message.delta.segments[0];
    if (!firstSegment) {
      throw new Error("expected output segment");
    }
    expect(
      validateTerminalDataPlaneHostMessage({
        ...message,
        delta: {
          ...message.delta,
          segments: [
            {
              ...firstSegment,
              telemetry: { ptyReadAt: 2_000, headlessCommitAt: 1_999 }
            }
          ]
        }
      })
    ).toEqual({
      ok: false,
      error:
        "delta.segments[0].telemetry.headlessCommitAt must not precede ptyReadAt"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...message,
        delta: {
          ...message.delta,
          segments: [
            {
              ...firstSegment,
              telemetry: {
                ptyReadAt: 2_000,
                headlessCommitAt: 2_001,
                visibleAtPtyRead: "yes"
              }
            }
          ]
        }
      })
    ).toEqual({
      ok: false,
      error:
        "delta.segments[0].telemetry.visibleAtPtyRead must be a boolean when provided"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...message,
        delta: {
          ...message.delta,
          segments: [
            {
              ...firstSegment,
              telemetry: {
                ptyReadAt: 2_000,
                headlessCommitAt: 2_001,
                outputKind: "title-ish"
              }
            }
          ]
        }
      })
    ).toEqual({
      ok: false,
      error: "delta.segments[0].telemetry.outputKind is invalid"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...message,
        delta: {
          ...message.delta,
          segments: [
            {
              ...firstSegment,
              telemetry: {
                ptyReadAt: 2_000,
                headlessCommitAt: 2_001,
                inputKind: "mouse"
              }
            }
          ]
        }
      })
    ).toEqual({
      ok: false,
      error:
        "delta.segments[0].telemetry.inputKind requires inputAcceptedAt and inputSequence"
    });
  });

  it("rejects gaps inside one delta and inconsistent declared bytes", () => {
    const base = {
      ...envelope,
      type: "delta",
      delta: {
        type: "output",
        fromSequence: u(4),
        sequence: u(6),
        byteLength: 6,
        segments: [{ sequence: u(5), data: "hello\n", byteLength: 6 }]
      }
    };

    expect(validateTerminalDataPlaneHostMessage(base)).toEqual({
      ok: false,
      error: "the final delta segment sequence must equal delta.sequence"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...base,
        delta: {
          ...base.delta,
          sequence: u(7),
          byteLength: 7,
          segments: [
            { sequence: u(5), data: "hello\n", byteLength: 6 },
            { sequence: u(7), data: ">", byteLength: 1 }
          ]
        }
      })
    ).toEqual({
      ok: false,
      error: "delta segment sequences must be contiguous"
    });
    expect(
      validateTerminalDataPlaneHostMessage({
        ...base,
        delta: { ...base.delta, sequence: u(5), byteLength: 7 }
      })
    ).toEqual({
      ok: false,
      error: "delta.byteLength must equal the sum of segment byteLength values"
    });

    expect(
      validateTerminalDataPlaneHostMessage({
        ...base,
        delta: {
          ...base.delta,
          sequence: u(5),
          byteLength: 1,
          segments: [{ sequence: u(5), data: "한", byteLength: 1 }]
        }
      })
    ).toEqual({
      ok: false,
      error: "delta.segments[0].byteLength does not match its UTF-8 data"
    });
  });

  it("rejects a checkpoint for another epoch", () => {
    expect(
      validateTerminalDataPlaneHostMessage({
        ...envelope,
        type: "checkpoint:begin",
        checkpointId: "checkpoint-stale",
        purpose: {
          kind: "resync",
          missingFromSequence: u(4),
          retainedFromSequence: u(8)
        },
        metadata: checkpointMetadata({
          session: { ...session, epoch: "epoch-stale" },
          sequence: u(8)
        }),
        totalBytes: 8
      })
    ).toEqual({
      ok: false,
      error: "checkpoint session does not match the message session"
    });
  });

  it("accepts a checkpoint when no delta remains after the authoritative sequence", () => {
    const message: TerminalDataPlaneHostMessage = {
      ...envelope,
      type: "checkpoint:begin",
      checkpointId: "checkpoint-resync",
      purpose: {
        kind: "resync",
        missingFromSequence: u(4),
        retainedFromSequence: u(9)
      },
      metadata: checkpointMetadata({ sequence: u(8) }),
      totalBytes: 8
    };

    expect(validateTerminalDataPlaneHostMessage(message)).toEqual({
      ok: true,
      value: message
    });
  });
});
