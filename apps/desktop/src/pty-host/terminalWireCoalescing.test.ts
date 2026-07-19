import type {
  TerminalDelta,
  TerminalOutputSegment,
  TerminalSessionRef
} from "@kmux/proto";
import {
  TERMINAL_DATA_PLANE_MAX_DELTA_BYTES,
  TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES,
  TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES,
  TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64,
  type Uint64,
  validateTerminalDataPlaneHostMessage
} from "@kmux/proto";
import { describe, expect, it } from "vitest";

import {
  coalesceTerminalOutputForWire,
  coalesceTerminalDeltasForWire,
  sliceTerminalOutputAfterSequence,
  splitTerminalOutputText,
  terminalDeltaRetainedBytes
} from "./terminalWireCoalescing";

function segment(sequence: number, byteLength: number): TerminalOutputSegment {
  return { sequence: u(sequence), byteLength, data: "x".repeat(byteLength) };
}

function u(value: number): Uint64 {
  return uint64(BigInt(value));
}

describe("coalesceTerminalOutputForWire", () => {
  it("splits oversized PTY reads without breaking Unicode code points", () => {
    const chunks = splitTerminalOutputText(`ab😀cd한ef`, 7);

    expect(chunks.join("")).toBe(`ab😀cd한ef`);
    expect(chunks.map((chunk) => Buffer.byteLength(chunk, "utf8"))).toEqual([
      7, 6
    ]);
  });

  it("groups adjacent source segments up to the wire limit", () => {
    const deltas = coalesceTerminalOutputForWire(
      [segment(1, 4), segment(2, 4), segment(3, 4)],
      8
    );

    expect(
      deltas.map(({ fromSequence, sequence, byteLength }) => ({
        fromSequence,
        sequence,
        byteLength
      }))
    ).toEqual([
      { fromSequence: u(0), sequence: u(2), byteLength: 8 },
      { fromSequence: u(2), sequence: u(3), byteLength: 4 }
    ]);
  });

  it("keeps one oversized source segment intact and isolated", () => {
    const deltas = coalesceTerminalOutputForWire(
      [segment(1, 20), segment(2, 2)],
      8
    );

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      fromSequence: u(0),
      sequence: u(1),
      byteLength: 20,
      segments: [{ sequence: u(1) }]
    });
    expect(deltas[1]).toMatchObject({
      fromSequence: u(1),
      sequence: u(2),
      byteLength: 2
    });
  });

  it("accounts retained cwd UTF-8 bytes separately from output credit", () => {
    const delta: Extract<TerminalDelta, { type: "output" }> = {
      type: "output",
      fromSequence: u(0),
      sequence: u(1),
      byteLength: 1,
      segments: [{ sequence: u(1), data: "x", byteLength: 1, cwd: "/한" }]
    };

    expect(terminalDeltaRetainedBytes(delta)).toBe(5);
    expect(delta.byteLength).toBe(1);
  });

  it("slices a retained output after an internal segment cursor", () => {
    const output: Extract<TerminalDelta, { type: "output" }> = {
      type: "output",
      fromSequence: u(10),
      sequence: u(13),
      byteLength: 12,
      segments: [segment(11, 3), segment(12, 4), segment(13, 5)]
    };
    output.segments[2]!.cwd = "/workspace";

    expect(sliceTerminalOutputAfterSequence(output, u(12))).toEqual({
      type: "output",
      fromSequence: u(12),
      sequence: u(13),
      byteLength: 5,
      segments: [
        {
          sequence: u(13),
          data: "xxxxx",
          byteLength: 5,
          cwd: "/workspace"
        }
      ]
    });
    expect(sliceTerminalOutputAfterSequence(output, u(10))).toBeNull();
    expect(sliceTerminalOutputAfterSequence(output, u(13))).toBeNull();
    expect(
      sliceTerminalOutputAfterSequence(
        { type: "resize", sequence: u(13), cols: 80, rows: 24 },
        u(12)
      )
    ).toBeNull();
  });

  it("keeps input-correlated segments isolated for latency tracing", () => {
    const inputSegment = segment(2, 4);
    inputSegment.telemetry = {
      ptyReadAt: 20,
      headlessCommitAt: 21,
      inputAcceptedAt: 19,
      inputSequence: u(1)
    };

    const deltas = coalesceTerminalOutputForWire(
      [segment(1, 4), inputSegment, segment(3, 4)],
      16
    );

    expect(deltas).toMatchObject([
      { fromSequence: u(0), sequence: u(1), byteLength: 4 },
      { fromSequence: u(1), sequence: u(2), byteLength: 4 },
      { fromSequence: u(2), sequence: u(3), byteLength: 4 }
    ]);
  });

  it("splits tiny source segments at the protocol count limit", () => {
    const sourceSegments = Array.from(
      { length: TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS + 1 },
      (_, index) => segment(index + 1, 1)
    );
    const deltas = coalesceTerminalOutputForWire(sourceSegments, 64 * 1024);

    expect(
      deltas.map((delta) => ({
        fromSequence: delta.fromSequence,
        sequence: delta.sequence,
        byteLength: delta.byteLength,
        segments: delta.segments.length
      }))
    ).toEqual([
      {
        fromSequence: u(0),
        sequence: u(TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS),
        byteLength: TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS,
        segments: TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS
      },
      {
        fromSequence: u(TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS),
        sequence: u(TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS + 1),
        byteLength: 1,
        segments: 1
      }
    ]);

    const session: TerminalSessionRef = {
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "epoch_1"
    };
    for (const delta of deltas) {
      expect(
        validateTerminalDataPlaneHostMessage({
          protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
          attachId: "attach_1",
          session,
          type: "delta",
          delta
        })
      ).toMatchObject({ ok: true });
    }
  });

  it("bounds repeated cwd metadata per wire delta while preserving a legal large source", () => {
    const cwd = `/${"a".repeat(
      TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES - 1
    )}`;
    const cwdSegments = Array.from({ length: 5 }, (_, index) => ({
      ...segment(index + 1, 1),
      cwd
    }));
    const deltas = coalesceTerminalOutputForWire(
      cwdSegments,
      TERMINAL_DATA_PLANE_MAX_DELTA_BYTES
    );

    expect(deltas.map((delta) => delta.segments.length)).toEqual([3, 2]);
    expect(
      deltas.every(
        (delta) =>
          terminalDeltaRetainedBytes(delta) <=
          TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES
      )
    ).toBe(true);

    const session: TerminalSessionRef = {
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "epoch_1"
    };
    for (const delta of deltas) {
      expect(
        validateTerminalDataPlaneHostMessage({
          protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
          attachId: "attach_1",
          session,
          type: "delta",
          delta
        })
      ).toMatchObject({ ok: true });
    }
    expect(
      validateTerminalDataPlaneHostMessage({
        protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
        attachId: "attach_1",
        session,
        type: "delta",
        delta: {
          type: "output",
          fromSequence: u(0),
          sequence: u(5),
          byteLength: 5,
          segments: cwdSegments
        }
      })
    ).toMatchObject({ ok: false });

    const largeSource = {
      sequence: u(1),
      data: "x".repeat(TERMINAL_DATA_PLANE_MAX_DELTA_BYTES),
      byteLength: TERMINAL_DATA_PLANE_MAX_DELTA_BYTES,
      cwd
    } satisfies TerminalOutputSegment;
    const [largeDelta] = coalesceTerminalOutputForWire([largeSource]);
    expect(terminalDeltaRetainedBytes(largeDelta)).toBe(
      TERMINAL_DATA_PLANE_MAX_DELTA_BYTES +
        TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
    );
    expect(
      validateTerminalDataPlaneHostMessage({
        protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
        attachId: "attach_1",
        session,
        type: "delta",
        delta: largeDelta
      })
    ).toMatchObject({ ok: true });
  });

  it("coalesces ring replay output without crossing resize barriers", () => {
    const output = (sequence: number): TerminalDelta => ({
      type: "output",
      fromSequence: u(sequence - 1),
      sequence: u(sequence),
      byteLength: 4,
      segments: [segment(sequence, 4)]
    });
    const deltas = coalesceTerminalDeltasForWire(
      [
        output(1),
        output(2),
        { type: "resize", sequence: u(3), cols: 100, rows: 30 },
        output(4)
      ],
      16
    );

    expect(deltas).toMatchObject([
      { type: "output", fromSequence: u(0), sequence: u(2), byteLength: 8 },
      { type: "resize", sequence: u(3), cols: 100, rows: 30 },
      { type: "output", fromSequence: u(3), sequence: u(4), byteLength: 4 }
    ]);
  });
});
