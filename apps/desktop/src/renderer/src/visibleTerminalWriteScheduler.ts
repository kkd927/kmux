export interface VisibleTerminalWriteSchedulerOptions {
  /**
   * The completion callback must run after xterm has parsed the supplied
   * payload. It is optional so non-stream presentation callers can keep using
   * a fire-and-forget writer.
   */
  write: (data: string, onWritten?: () => void) => void;
  /** Receives writer failures that occur later from a frame/timer callback. */
  onWriteError?: (error: unknown) => void;
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  now?: () => number;
  setTimeoutFn?: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  frameChunkChars?: number;
  catchUpPendingChars?: number;
  maxPresentationLagMs?: number;
  inputImmediateMs?: number;
}

export interface VisibleTerminalWriteScheduler {
  /**
   * Schedules data that the caller has already classified as plain,
   * append-only terminal output. ANSI/control redraws must use
   * writeImmediate instead.
   */
  writePlain(data: string, onWritten?: () => void): void;
  /**
   * Flushes older plain output first, then writes this payload immediately.
   * Use this for control/TUI output and while replaying or viewing scrollback.
   */
  writeImmediate(data: string, onWritten?: () => void): void;
  /**
   * Removes presentation delay from pending output and from output arriving
   * during the short interactive window following user input.
   */
  notifyInput(): void;
  flush(): void;
  dispose(): void;
}

interface PendingWrite {
  data: string;
  offset: number;
  enqueuedAt: number;
  onWritten?: () => void;
}

interface ConsumedWrite {
  data: string;
  completions: Array<() => void>;
}

const DEFAULT_FRAME_CHUNK_CHARS = 16 * 1024;
const DEFAULT_CATCH_UP_PENDING_CHARS = 32 * 1024;
export const VISIBLE_TERMINAL_DEFAULT_MAX_PRESENTATION_LAG_MS = 32;
const DEFAULT_INPUT_IMMEDIATE_MS = 100;

export function createVisibleTerminalWriteScheduler(
  options: VisibleTerminalWriteSchedulerOptions
): VisibleTerminalWriteScheduler {
  const now = options.now ?? defaultNow;
  const requestFrame =
    options.requestAnimationFrame ??
    ((callback: (timestamp: number) => void): number =>
      defaultRequestAnimationFrame(callback, now));
  const cancelFrame =
    options.cancelAnimationFrame ?? defaultCancelAnimationFrame;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const frameChunkChars = requireIntegerAtLeast(
    options.frameChunkChars ?? DEFAULT_FRAME_CHUNK_CHARS,
    2,
    "frameChunkChars"
  );
  const catchUpPendingChars = requireIntegerAtLeast(
    options.catchUpPendingChars ?? DEFAULT_CATCH_UP_PENDING_CHARS,
    1,
    "catchUpPendingChars"
  );
  const maxPresentationLagMs = requireFiniteNonNegative(
    options.maxPresentationLagMs ??
      VISIBLE_TERMINAL_DEFAULT_MAX_PRESENTATION_LAG_MS,
    "maxPresentationLagMs"
  );
  const inputImmediateMs = requireFiniteNonNegative(
    options.inputImmediateMs ?? DEFAULT_INPUT_IMMEDIATE_MS,
    "inputImmediateMs"
  );

  const pending: PendingWrite[] = [];
  let pendingChars = 0;
  let frameHandle: number | null = null;
  let lagTimeout: ReturnType<typeof setTimeout> | null = null;
  let burstActive = false;
  let immediateUntil = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const clearLagTimeout = (): void => {
    if (lagTimeout === null) {
      return;
    }
    clearTimeoutFn(lagTimeout);
    lagTimeout = null;
  };

  const cancelScheduledFrame = (): void => {
    if (frameHandle === null) {
      return;
    }
    cancelFrame(frameHandle);
    frameHandle = null;
  };

  const oldestPendingAt = (): number | null => pending[0]?.enqueuedAt ?? null;

  const consumePending = (requestedChars: number): ConsumedWrite => {
    if (pendingChars === 0) {
      return { data: "", completions: [] };
    }

    let charsToConsume = Math.min(requestedChars, pendingChars);
    if (charsToConsume < pendingChars) {
      const lastCodeUnit = readPendingCodeUnit(charsToConsume - 1);
      const nextCodeUnit = readPendingCodeUnit(charsToConsume);
      if (isHighSurrogate(lastCodeUnit) && isLowSurrogate(nextCodeUnit)) {
        charsToConsume -= 1;
      }
    }

    const parts: string[] = [];
    const completions: Array<() => void> = [];
    let remaining = charsToConsume;
    while (remaining > 0) {
      const head = pending[0];
      if (!head) {
        break;
      }
      const available = head.data.length - head.offset;
      const consumed = Math.min(available, remaining);
      parts.push(head.data.slice(head.offset, head.offset + consumed));
      head.offset += consumed;
      remaining -= consumed;
      pendingChars -= consumed;
      if (head.offset === head.data.length) {
        pending.shift();
        if (head.onWritten) {
          completions.push(head.onWritten);
        }
      }
    }
    return { data: parts.join(""), completions };
  };

  const readPendingCodeUnit = (index: number): number => {
    let remaining = index;
    for (const entry of pending) {
      const available = entry.data.length - entry.offset;
      if (remaining < available) {
        return entry.data.charCodeAt(entry.offset + remaining);
      }
      remaining -= available;
    }
    return Number.NaN;
  };

  const write = (data: string, completions: Array<() => void>): void => {
    if (data.length === 0) {
      for (const complete of completions) {
        complete();
      }
      return;
    }
    try {
      if (completions.length === 0) {
        options.write(data);
        return;
      }
      let completed = false;
      options.write(data, () => {
        if (completed) {
          return;
        }
        completed = true;
        for (const complete of completions) {
          complete();
        }
      });
    } catch (error) {
      if (!options.onWriteError) {
        throw error;
      }
      options.onWriteError(error);
    }
  };

  const writeAllPending = (): void => {
    clearLagTimeout();
    const consumed = consumePending(pendingChars);
    write(consumed.data, consumed.completions);
  };

  const scheduleLagTimeout = (): void => {
    clearLagTimeout();
    const oldestAt = oldestPendingAt();
    if (oldestAt === null) {
      return;
    }
    const remainingMs = Math.max(0, maxPresentationLagMs - (now() - oldestAt));
    lagTimeout = setTimeoutFn(() => {
      lagTimeout = null;
      if (disposed || pendingChars === 0) {
        return;
      }
      const currentOldestAt = oldestPendingAt();
      if (
        currentOldestAt !== null &&
        now() - currentOldestAt < maxPresentationLagMs
      ) {
        scheduleLagTimeout();
        return;
      }
      writeAllPending();
      cancelScheduledFrame();
      burstActive = false;
    }, remainingMs);
  };

  const scheduleFrame = (): void => {
    if (frameHandle !== null || disposed) {
      return;
    }
    frameHandle = requestFrame(() => {
      frameHandle = null;
      if (disposed) {
        return;
      }
      if (pendingChars === 0) {
        clearLagTimeout();
        burstActive = false;
        return;
      }

      const oldestAt = oldestPendingAt();
      if (
        pendingChars > catchUpPendingChars ||
        (oldestAt !== null && now() - oldestAt >= maxPresentationLagMs)
      ) {
        writeAllPending();
        burstActive = false;
        return;
      }

      const consumed = consumePending(frameChunkChars);
      write(consumed.data, consumed.completions);
      if (pendingChars > 0) {
        scheduleLagTimeout();
      } else {
        clearLagTimeout();
      }
      // Keep one empty frame as the boundary between a burst and idle. Plain
      // output arriving before that frame stays paced rather than becoming a
      // second immediate write in the same visual frame.
      scheduleFrame();
    });
  };

  const flush = (): void => {
    if (disposed) {
      return;
    }
    writeAllPending();
    cancelScheduledFrame();
    burstActive = false;
  };

  return {
    writePlain(data: string, onWritten?: () => void): void {
      if (disposed || data.length === 0) {
        return;
      }
      const currentTime = now();
      if (currentTime < immediateUntil) {
        writeAllPending();
        write(data, onWritten ? [onWritten] : []);
        cancelScheduledFrame();
        burstActive = false;
        return;
      }
      if (!burstActive) {
        write(data, onWritten ? [onWritten] : []);
        burstActive = true;
        scheduleFrame();
        return;
      }

      const wasEmpty = pendingChars === 0;
      pending.push({ data, offset: 0, enqueuedAt: currentTime, onWritten });
      pendingChars += data.length;
      if (pendingChars > catchUpPendingChars) {
        flush();
        return;
      }
      if (wasEmpty) {
        scheduleLagTimeout();
      }
      scheduleFrame();
    },
    writeImmediate(data: string, onWritten?: () => void): void {
      if (disposed) {
        return;
      }
      flush();
      if (data.length > 0) {
        write(data, onWritten ? [onWritten] : []);
      } else {
        onWritten?.();
      }
    },
    notifyInput(): void {
      if (disposed) {
        return;
      }
      flush();
      immediateUntil = Math.max(immediateUntil, now() + inputImmediateMs);
    },
    flush,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelScheduledFrame();
      clearLagTimeout();
      pending.length = 0;
      pendingChars = 0;
      burstActive = false;
    }
  };
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function requireIntegerAtLeast(
  value: number,
  minimum: number,
  name: string
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function defaultNow(): number {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

function defaultRequestAnimationFrame(
  callback: (timestamp: number) => void,
  now: () => number
): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(now()), 16) as unknown as number;
}

function defaultCancelAnimationFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
