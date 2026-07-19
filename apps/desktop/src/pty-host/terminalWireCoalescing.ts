import type {
  TerminalDelta,
  TerminalOutputSegment,
  Uint64
} from "@kmux/proto";
import {
  TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES,
  TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS,
  uint64
} from "@kmux/proto";

export const TERMINAL_WIRE_OUTPUT_MAX_BYTES = 16 * 1024;
export const TERMINAL_OUTPUT_SEGMENT_MAX_BYTES = 64 * 1024;

function terminalOutputSegmentRetainedBytes(
  segment: TerminalOutputSegment
): number {
  return (
    segment.byteLength +
    (segment.cwd === undefined ? 0 : Buffer.byteLength(segment.cwd, "utf8"))
  );
}

export function terminalDeltaRetainedBytes(delta: TerminalDelta): number {
  if (delta.type !== "output") {
    return 0;
  }
  return delta.segments.reduce(
    (bytes, segment) => bytes + terminalOutputSegmentRetainedBytes(segment),
    0
  );
}

/** Returns the retained output suffix after a wire-visible segment cursor. */
export function sliceTerminalOutputAfterSequence(
  delta: TerminalDelta,
  sequence: Uint64
): TerminalDelta | null {
  const segmentIndex = terminalOutputSegmentIndexAfter(delta, sequence);
  if (delta.type !== "output" || segmentIndex === null) {
    return null;
  }
  const segments = delta.segments.slice(segmentIndex);
  return {
    type: "output",
    fromSequence: sequence,
    sequence: delta.sequence,
    byteLength: segments.reduce(
      (byteLength, segment) => byteLength + segment.byteLength,
      0
    ),
    segments
  };
}

function terminalOutputSegmentIndexAfter(
  delta: TerminalDelta,
  sequence: Uint64
): number | null {
  if (
    delta.type !== "output" ||
    sequence <= delta.fromSequence ||
    sequence >= delta.sequence
  ) {
    return null;
  }
  const segmentIndex = Number(sequence - delta.fromSequence);
  return delta.segments[segmentIndex - 1]?.sequence === sequence &&
    delta.segments[segmentIndex]?.sequence === sequence + 1n
    ? segmentIndex
    : null;
}

/** Splits PTY text on Unicode code-point boundaries before sequencing it. */
export function splitTerminalOutputText(
  data: string,
  maxBytes = TERMINAL_OUTPUT_SEGMENT_MAX_BYTES
): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError("maxBytes must be a safe integer of at least 4");
  }
  if (!data) {
    return [];
  }

  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let offset = 0;
  for (const character of data) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunkBytes > 0 && chunkBytes + characterBytes > maxBytes) {
      chunks.push(data.slice(chunkStart, offset));
      chunkStart = offset;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    offset += character.length;
  }
  chunks.push(data.slice(chunkStart));
  return chunks;
}

/**
 * Coalesces adjacent committed source segments without splitting a source
 * segment. An individually large PTY segment is therefore sent on its own.
 */
export function coalesceTerminalOutputForWire(
  segments: TerminalOutputSegment[],
  maxBytes = TERMINAL_WIRE_OUTPUT_MAX_BYTES
): Array<Extract<TerminalDelta, { type: "output" }>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const deltas: Array<Extract<TerminalDelta, { type: "output" }>> = [];
  let pending: TerminalOutputSegment[] = [];
  let pendingBytes = 0;
  let pendingRetainedBytes = 0;

  const flush = (): void => {
    const first = pending[0];
    const last = pending.at(-1);
    if (!first || !last) {
      return;
    }
    deltas.push({
      type: "output",
      fromSequence: uint64(first.sequence - 1n),
      sequence: last.sequence,
      byteLength: pendingBytes,
      segments: pending
    });
    pending = [];
    pendingBytes = 0;
    pendingRetainedBytes = 0;
  };

  for (const segment of segments) {
    // Keep input-correlated output independently observable. Combining two
    // such source segments into one wire delta would collapse their distinct
    // input-to-render traces even though the terminal bytes remain ordered.
    if (segment.telemetry?.inputAcceptedAt !== undefined) {
      flush();
      pending.push(segment);
      pendingBytes = segment.byteLength;
      pendingRetainedBytes = terminalOutputSegmentRetainedBytes(segment);
      flush();
      continue;
    }
    const segmentRetainedBytes = terminalOutputSegmentRetainedBytes(segment);
    if (
      pending.length > 0 &&
      (pendingBytes + segment.byteLength > maxBytes ||
        pendingRetainedBytes + segmentRetainedBytes >
          TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES)
    ) {
      flush();
    }
    pending.push(segment);
    pendingBytes += segment.byteLength;
    pendingRetainedBytes += segmentRetainedBytes;
    if (
      pendingBytes >= maxBytes ||
      pendingRetainedBytes >= TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES ||
      pending.length >= TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS
    ) {
      flush();
    }
  }
  flush();
  return deltas;
}

/** Coalesces ring replay output while preserving resize mutation barriers. */
export function coalesceTerminalDeltasForWire(
  deltas: TerminalDelta[],
  maxBytes = TERMINAL_WIRE_OUTPUT_MAX_BYTES
): TerminalDelta[] {
  const result: TerminalDelta[] = [];
  let pendingSegments: TerminalOutputSegment[] = [];

  const flushOutput = (): void => {
    if (pendingSegments.length === 0) {
      return;
    }
    result.push(...coalesceTerminalOutputForWire(pendingSegments, maxBytes));
    pendingSegments = [];
  };

  for (const delta of deltas) {
    if (delta.type === "output") {
      pendingSegments.push(...delta.segments);
      continue;
    }
    flushOutput();
    result.push(delta);
  }
  flushOutput();
  return result;
}
