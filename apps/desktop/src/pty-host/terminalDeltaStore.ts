import { uint64, type Uint64 } from "@kmux/proto";

export interface TerminalDeltaRange {
  fromSequence: Uint64;
  sequence: Uint64;
}

export interface TerminalDeltaStoreOptions<T> {
  maxSessionBytes: number;
  maxSessionEvents: number;
  maxTotalBytes: number;
  maxTotalEvents: number;
  rangeOf: (delta: T) => TerminalDeltaRange;
  /** Heap-retention accounting used for ring eviction. */
  sizeOf: (delta: T) => number;
  /** Optional wire-flow accounting used for bounded replay windows. */
  replaySizeOf?: (delta: T) => number;
  /** Rebuilds the replayable suffix after a cursor inside one retained delta. */
  sliceAfterInternalCursor?: (delta: T, sequence: Uint64) => T | null;
}

export interface TerminalDeltaReplayWindow {
  /**
   * Maximum positive-byte payload to copy into one replay result. Zero-byte
   * mutations remain ordered and do not consume this budget.
   */
  maxBytes?: number;
  /** Maximum number of retained mutations to copy into one replay result. */
  maxEvents?: number;
}

export type TerminalDeltaReplay<T> =
  | { status: "ok"; latestSequence: Uint64; deltas: T[] }
  | {
      status: "gap";
      latestSequence: Uint64;
      retainedFromSequence: Uint64;
    };

export interface TerminalDeltaStoreStats {
  sessions: number;
  events: number;
  bytes: number;
  maxSessionBytes: number;
  maxSessionEvents: number;
  maxTotalBytes: number;
  maxTotalEvents: number;
  peakSessionBytes: number;
  peakSessionEvents: number;
  peakTotalBytes: number;
  peakTotalEvents: number;
  boundViolationCount: number;
  oversizedDeltaCount: number;
  replayLookupMissCount: number;
  internalCursorMissCount: number;
  internalCursorMissEpisodeCount: number;
}

export interface TerminalDeltaSessionStats {
  events: number;
  bytes: number;
  maxBytes: number;
  maxEvents: number;
  peakBytes: number;
  peakEvents: number;
  latestSequence: Uint64;
  retainedFromSequence: Uint64;
}

interface StoredDelta<T> {
  value: T;
  range: TerminalDeltaRange;
  bytes: number;
  replayBytes: number;
  ordinal: number;
}

interface SessionRing<T> {
  // Slots before head are cleared immediately so evicted terminal strings are
  // not retained until the next array compaction.
  entries: Array<StoredDelta<T> | undefined>;
  head: number;
  bytes: number;
  latestSequence: Uint64;
  peakBytes: number;
  peakEvents: number;
}

/**
 * Shared committed-delta storage for every PTY session. Each session and the
 * supervisor as a whole have hard bounds; trimming only advances replay
 * cursors and never creates a private subscriber queue.
 */
export class TerminalDeltaStore<T> {
  private readonly rings = new Map<string, SessionRing<T>>();
  private totalBytes = 0;
  private totalEvents = 0;
  private nextOrdinal = 1;
  private peakSessionBytes = 0;
  private peakSessionEvents = 0;
  private peakTotalBytes = 0;
  private peakTotalEvents = 0;
  private boundViolationCount = 0;
  private oversizedDeltaCount = 0;
  private replayLookupMissCount = 0;
  private internalCursorMissCount = 0;
  private internalCursorMissEpisodeCount = 0;
  private readonly lastInternalCursorMissBySession = new Map<string, Uint64>();

  constructor(private readonly options: TerminalDeltaStoreOptions<T>) {
    requirePositiveInteger(options.maxSessionBytes, "maxSessionBytes");
    requirePositiveInteger(options.maxSessionEvents, "maxSessionEvents");
    requirePositiveInteger(options.maxTotalBytes, "maxTotalBytes");
    requirePositiveInteger(options.maxTotalEvents, "maxTotalEvents");
  }

  append(sessionId: string, delta: T): void {
    const range = this.options.rangeOf(delta);
    validateRange(range);
    const bytes = this.options.sizeOf(delta);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("delta size must be a non-negative safe integer");
    }
    const replayBytes = this.options.replaySizeOf?.(delta) ?? bytes;
    if (!Number.isSafeInteger(replayBytes) || replayBytes < 0) {
      throw new RangeError(
        "delta replay size must be a non-negative safe integer"
      );
    }

    const ring = this.rings.get(sessionId) ?? this.createRing(sessionId);
    if (range.fromSequence !== ring.latestSequence) {
      throw new Error(
        `non-contiguous terminal delta for ${sessionId}: expected previous sequence ${ring.latestSequence}, received ${range.fromSequence}`
      );
    }
    ring.latestSequence = range.sequence;

    if (
      bytes > this.options.maxSessionBytes ||
      bytes > this.options.maxTotalBytes
    ) {
      this.oversizedDeltaCount += 1;
      this.clearRetained(ring);
      return;
    }

    ring.entries.push({
      value: delta,
      range,
      bytes,
      replayBytes,
      ordinal: this.nextOrdinal
    });
    this.nextOrdinal += 1;
    ring.bytes += bytes;
    this.totalBytes += bytes;
    this.totalEvents += 1;

    while (
      ring.bytes > this.options.maxSessionBytes ||
      this.eventCount(ring) > this.options.maxSessionEvents
    ) {
      this.evictHead(ring);
    }
    while (
      this.totalBytes > this.options.maxTotalBytes ||
      this.totalEvents > this.options.maxTotalEvents
    ) {
      const oldestRing = this.findRingWithOldestEntry();
      if (!oldestRing) {
        break;
      }
      this.evictHead(oldestRing);
    }
    this.recordBounds(ring);
  }

  replayAfter(
    sessionId: string,
    sequence: Uint64,
    window: TerminalDeltaReplayWindow = {}
  ): TerminalDeltaReplay<T> {
    const maxBytes = normalizeReplayLimit(window.maxBytes, "maxBytes");
    const maxEvents = normalizeReplayLimit(window.maxEvents, "maxEvents");
    const ring = this.rings.get(sessionId);
    if (!ring) {
      return sequence === 0n
        ? { status: "ok", latestSequence: uint64(0n), deltas: [] }
        : {
            status: "gap",
            latestSequence: uint64(0n),
            retainedFromSequence: uint64(1n)
          };
    }
    if (sequence === ring.latestSequence) {
      return { status: "ok", latestSequence: ring.latestSequence, deltas: [] };
    }
    if (sequence > ring.latestSequence) {
      return {
        status: "gap",
        latestSequence: ring.latestSequence,
        retainedFromSequence: uint64(
          (ring.entries[ring.head]?.range.fromSequence ?? ring.latestSequence) +
            1n
        )
      };
    }

    let replayIndex = this.findReplayIndex(ring, sequence);
    const first = ring.entries[ring.head];
    let internalSuffix:
      | { value: T; replayBytes: number }
      | undefined;
    if (replayIndex < 0) {
      this.replayLookupMissCount += 1;
      const containingIndex = this.findContainingReplayIndex(ring, sequence);
      const containingEntry =
        containingIndex < 0 ? undefined : ring.entries[containingIndex];
      const slicedValue = containingEntry
        ? this.options.sliceAfterInternalCursor?.(
            containingEntry.value,
            sequence
          )
        : undefined;
      if (
        containingEntry &&
        slicedValue !== null &&
        slicedValue !== undefined
      ) {
        const slicedRange = this.options.rangeOf(slicedValue);
        if (
          slicedRange.fromSequence !== sequence ||
          slicedRange.sequence !== containingEntry.range.sequence
        ) {
          throw new Error(
            "internal terminal delta suffix must preserve the requested and retained sequence boundaries"
          );
        }
        const replayBytes =
          this.options.replaySizeOf?.(slicedValue) ??
          this.options.sizeOf(slicedValue);
        if (!Number.isSafeInteger(replayBytes) || replayBytes < 0) {
          throw new RangeError(
            "internal terminal delta suffix replay size must be a non-negative safe integer"
          );
        }
        this.internalCursorMissCount += 1;
        if (this.lastInternalCursorMissBySession.get(sessionId) !== sequence) {
          this.lastInternalCursorMissBySession.set(sessionId, sequence);
          this.internalCursorMissEpisodeCount += 1;
        }
        internalSuffix = {
          value: slicedValue,
          replayBytes
        };
        replayIndex = containingIndex + 1;
      } else {
        return {
          status: "gap",
          latestSequence: ring.latestSequence,
          retainedFromSequence:
            first === undefined
              ? uint64(ring.latestSequence + 1n)
              : uint64(first.range.fromSequence + 1n)
        };
      }
    }

    const deltas: T[] = [];
    let replayBytes = 0;
    const appendReplayDelta = (
      value: T,
      valueReplayBytes: number
    ): "continue" | "stop" => {
      if (deltas.length >= maxEvents) {
        return "stop";
      }
      if (
        valueReplayBytes > 0 &&
        replayBytes + valueReplayBytes > maxBytes
      ) {
        // Preserve a source delta that is larger than the requested window as
        // one standalone replay item. If ordered zero-byte mutations were
        // already selected, return them first and leave the output at the next
        // exact cursor.
        if (deltas.length > 0) {
          return "stop";
        }
        deltas.push(value);
        return "stop";
      }
      deltas.push(value);
      replayBytes += valueReplayBytes;
      return "continue";
    };
    if (
      internalSuffix &&
      appendReplayDelta(internalSuffix.value, internalSuffix.replayBytes) ===
        "stop"
    ) {
      return { status: "ok", latestSequence: ring.latestSequence, deltas };
    }
    for (let index = replayIndex; index < ring.entries.length; index += 1) {
      const entry = ring.entries[index];
      if (!entry) {
        continue;
      }
      if (appendReplayDelta(entry.value, entry.replayBytes) === "stop") {
        break;
      }
    }
    return { status: "ok", latestSequence: ring.latestSequence, deltas };
  }

  latestSequence(sessionId: string): Uint64 {
    return this.rings.get(sessionId)?.latestSequence ?? uint64(0n);
  }

  removeSession(sessionId: string): void {
    const ring = this.rings.get(sessionId);
    if (!ring) {
      return;
    }
    this.clearRetained(ring);
    this.rings.delete(sessionId);
    this.lastInternalCursorMissBySession.delete(sessionId);
  }

  clear(): void {
    this.rings.clear();
    this.totalBytes = 0;
    this.totalEvents = 0;
    this.lastInternalCursorMissBySession.clear();
  }

  stats(): TerminalDeltaStoreStats {
    return {
      sessions: this.rings.size,
      events: this.totalEvents,
      bytes: this.totalBytes,
      maxSessionBytes: this.options.maxSessionBytes,
      maxSessionEvents: this.options.maxSessionEvents,
      maxTotalBytes: this.options.maxTotalBytes,
      maxTotalEvents: this.options.maxTotalEvents,
      peakSessionBytes: this.peakSessionBytes,
      peakSessionEvents: this.peakSessionEvents,
      peakTotalBytes: this.peakTotalBytes,
      peakTotalEvents: this.peakTotalEvents,
      boundViolationCount: this.boundViolationCount,
      oversizedDeltaCount: this.oversizedDeltaCount,
      replayLookupMissCount: this.replayLookupMissCount,
      internalCursorMissCount: this.internalCursorMissCount,
      internalCursorMissEpisodeCount: this.internalCursorMissEpisodeCount
    };
  }

  sessionStats(sessionId: string): TerminalDeltaSessionStats {
    const ring = this.rings.get(sessionId);
    if (!ring) {
      return {
        events: 0,
        bytes: 0,
        maxBytes: this.options.maxSessionBytes,
        maxEvents: this.options.maxSessionEvents,
        peakBytes: 0,
        peakEvents: 0,
        latestSequence: uint64(0n),
        retainedFromSequence: uint64(1n)
      };
    }
    return {
      events: this.eventCount(ring),
      bytes: ring.bytes,
      maxBytes: this.options.maxSessionBytes,
      maxEvents: this.options.maxSessionEvents,
      peakBytes: ring.peakBytes,
      peakEvents: ring.peakEvents,
      latestSequence: ring.latestSequence,
      retainedFromSequence:
        uint64(
          (ring.entries[ring.head]?.range.fromSequence ?? ring.latestSequence) +
            1n
        )
    };
  }

  private createRing(sessionId: string): SessionRing<T> {
    const ring: SessionRing<T> = {
      entries: [],
      head: 0,
      bytes: 0,
      latestSequence: uint64(0n),
      peakBytes: 0,
      peakEvents: 0
    };
    this.rings.set(sessionId, ring);
    return ring;
  }

  private eventCount(ring: SessionRing<T>): number {
    return ring.entries.length - ring.head;
  }

  private recordBounds(ring: SessionRing<T>): void {
    const sessionEvents = this.eventCount(ring);
    ring.peakBytes = Math.max(ring.peakBytes, ring.bytes);
    ring.peakEvents = Math.max(ring.peakEvents, sessionEvents);
    this.peakSessionBytes = Math.max(this.peakSessionBytes, ring.bytes);
    this.peakSessionEvents = Math.max(this.peakSessionEvents, sessionEvents);
    this.peakTotalBytes = Math.max(this.peakTotalBytes, this.totalBytes);
    this.peakTotalEvents = Math.max(this.peakTotalEvents, this.totalEvents);
    if (
      ring.bytes > this.options.maxSessionBytes ||
      sessionEvents > this.options.maxSessionEvents ||
      this.totalBytes > this.options.maxTotalBytes ||
      this.totalEvents > this.options.maxTotalEvents
    ) {
      this.boundViolationCount += 1;
    }
  }

  private evictHead(ring: SessionRing<T>): void {
    const evictedIndex = ring.head;
    const entry = ring.entries[evictedIndex];
    if (!entry) {
      return;
    }
    ring.entries[evictedIndex] = undefined;
    ring.head += 1;
    ring.bytes = Math.max(0, ring.bytes - entry.bytes);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    this.totalEvents = Math.max(0, this.totalEvents - 1);
    this.compact(ring);
  }

  private clearRetained(ring: SessionRing<T>): void {
    this.totalBytes = Math.max(0, this.totalBytes - ring.bytes);
    this.totalEvents = Math.max(0, this.totalEvents - this.eventCount(ring));
    ring.entries.length = 0;
    ring.head = 0;
    ring.bytes = 0;
  }

  private compact(ring: SessionRing<T>): void {
    if (ring.head === ring.entries.length) {
      ring.entries.length = 0;
      ring.head = 0;
      return;
    }
    if (ring.head >= 1024 && ring.head * 2 >= ring.entries.length) {
      ring.entries.splice(0, ring.head);
      ring.head = 0;
    }
  }

  private findRingWithOldestEntry(): SessionRing<T> | null {
    let oldestRing: SessionRing<T> | null = null;
    let oldestOrdinal = Number.POSITIVE_INFINITY;
    for (const ring of this.rings.values()) {
      const ordinal = ring.entries[ring.head]?.ordinal;
      if (ordinal !== undefined && ordinal < oldestOrdinal) {
        oldestOrdinal = ordinal;
        oldestRing = ring;
      }
    }
    return oldestRing;
  }

  private findReplayIndex(ring: SessionRing<T>, sequence: Uint64): number {
    let low = ring.head;
    let high = ring.entries.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = ring.entries[middle];
      // Cleared slots exist only before ring.head, so a missing live-range
      // entry indicates an internal invariant violation rather than a gap.
      if (!entry) {
        throw new Error("terminal delta ring contains an empty live entry");
      }
      if (entry.range.fromSequence === sequence) {
        return middle;
      }
      if (entry.range.fromSequence < sequence) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -1;
  }

  private findContainingReplayIndex(
    ring: SessionRing<T>,
    sequence: Uint64
  ): number {
    let low = ring.head;
    let high = ring.entries.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = ring.entries[middle];
      if (!entry) {
        throw new Error("terminal delta ring contains an empty live entry");
      }
      if (sequence <= entry.range.fromSequence) {
        high = middle - 1;
      } else if (sequence >= entry.range.sequence) {
        low = middle + 1;
      } else {
        return middle;
      }
    }
    return -1;
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function normalizeReplayLimit(value: number | undefined, name: string): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateRange(range: TerminalDeltaRange): void {
  if (
    typeof range.fromSequence !== "bigint" ||
    typeof range.sequence !== "bigint" ||
    range.fromSequence < 0n ||
    range.sequence <= range.fromSequence
  ) {
    throw new RangeError("delta sequence range is invalid");
  }
}
