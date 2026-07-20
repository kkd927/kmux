import {
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  type Uint64
} from "@kmux/proto";

export interface TerminalSnapshotMaterialization {
  vt: string;
  scrollbackLines: number;
}

interface SnapshotCacheRequest {
  sequence: Uint64;
  cols: number;
  rows: number;
  requestedScrollbackLines: number;
  maxBytes?: number;
  serialize: (scrollbackLines: number) => string;
}

interface SnapshotCacheEntry extends TerminalSnapshotMaterialization {
  sequence: Uint64;
  cols: number;
  rows: number;
  requestedScrollbackLines: number;
  maxBytes: number;
}

export class TerminalCheckpointTooLargeError extends Error {
  readonly code = "terminal-checkpoint-screen-too-large";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `screen-only terminal checkpoint is ${actualBytes} bytes; maximum is ${maxBytes}`
    );
    this.name = "TerminalCheckpointTooLargeError";
  }
}

export function isTerminalCheckpointTooLargeError(
  error: unknown
): error is TerminalCheckpointTooLargeError {
  return error instanceof TerminalCheckpointTooLargeError;
}

export function materializeBoundedTerminalSnapshot(options: {
  requestedScrollbackLines: number;
  maxBytes?: number;
  serialize: (scrollbackLines: number) => string;
}): TerminalSnapshotMaterialization {
  const requestedScrollbackLines = requireNonNegativeInteger(
    options.requestedScrollbackLines,
    "requestedScrollbackLines"
  );
  const maxBytes = requirePositiveInteger(
    options.maxBytes ?? TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
    "maxBytes"
  );
  const fullVt = options.serialize(requestedScrollbackLines);
  const fullBytes = Buffer.byteLength(fullVt, "utf8");
  if (fullBytes <= maxBytes) {
    return { vt: fullVt, scrollbackLines: requestedScrollbackLines };
  }

  if (requestedScrollbackLines === 0) {
    throw new TerminalCheckpointTooLargeError(fullBytes, maxBytes);
  }
  const screenVt = options.serialize(0);
  const screenBytes = Buffer.byteLength(screenVt, "utf8");
  if (screenBytes > maxBytes) {
    throw new TerminalCheckpointTooLargeError(screenBytes, maxBytes);
  }

  const availableScrollbackBytes = maxBytes - screenBytes;
  let candidate = conservativeScrollbackCandidate({
    lines: requestedScrollbackLines,
    serializedBytes: fullBytes,
    screenBytes,
    availableScrollbackBytes,
    safetyFactor: 0.9
  });
  // Serialization size is usually close to linear in retained lines. A few
  // ratio corrections cover style-density discontinuities without generating
  // thirteen multi-megabyte strings for a binary search. The screen-only
  // materialization is the bounded final fallback.
  for (let attempt = 0; attempt < 3 && candidate > 0; attempt += 1) {
    const vt = options.serialize(candidate);
    const serializedBytes = Buffer.byteLength(vt, "utf8");
    if (serializedBytes <= maxBytes) {
      return { vt, scrollbackLines: candidate };
    }
    candidate = conservativeScrollbackCandidate({
      lines: candidate,
      serializedBytes,
      screenBytes,
      availableScrollbackBytes,
      safetyFactor: 0.85
    });
  }
  return { vt: screenVt, scrollbackLines: 0 };
}

export class SnapshotCache {
  private entry: SnapshotCacheEntry | null = null;

  invalidate(): void {
    this.entry = null;
  }

  get(request: SnapshotCacheRequest): TerminalSnapshotMaterialization {
    const maxBytes =
      request.maxBytes ?? TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES;
    if (
      this.entry &&
      this.entry.sequence === request.sequence &&
      this.entry.cols === request.cols &&
      this.entry.rows === request.rows &&
      this.entry.requestedScrollbackLines ===
        request.requestedScrollbackLines &&
      this.entry.maxBytes === maxBytes
    ) {
      return { vt: this.entry.vt, scrollbackLines: this.entry.scrollbackLines };
    }

    const materialization = materializeBoundedTerminalSnapshot({
      requestedScrollbackLines: request.requestedScrollbackLines,
      maxBytes,
      serialize: request.serialize
    });
    this.entry = {
      sequence: request.sequence,
      cols: request.cols,
      rows: request.rows,
      requestedScrollbackLines: request.requestedScrollbackLines,
      maxBytes,
      ...materialization
    };
    return { ...materialization };
  }
}

function conservativeScrollbackCandidate(options: {
  lines: number;
  serializedBytes: number;
  screenBytes: number;
  availableScrollbackBytes: number;
  safetyFactor: number;
}): number {
  if (options.lines <= 0 || options.availableScrollbackBytes <= 0) {
    return 0;
  }
  const observedScrollbackBytes = Math.max(
    1,
    options.serializedBytes - options.screenBytes
  );
  const estimated = Math.floor(
    options.lines *
      (options.availableScrollbackBytes / observedScrollbackBytes) *
      options.safetyFactor
  );
  return Math.max(0, Math.min(options.lines - 1, estimated));
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
