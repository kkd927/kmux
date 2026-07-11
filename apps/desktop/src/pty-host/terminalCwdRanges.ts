import type { SurfaceSnapshotCwdRange } from "@kmux/proto";
import {
  TERMINAL_DATA_PLANE_MAX_CWD_RANGES,
  TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
} from "@kmux/proto";

export const TERMINAL_CWD_RANGE_MAX_RETAINED_BYTES = 4 * 1024 * 1024;

interface StoredCwdRange {
  range: SurfaceSnapshotCwdRange;
  cwdBytes: number;
}

export interface TerminalCwdRangeTrackerLineSource {
  getBufferLength(): number;
}

export interface TerminalCwdRangeTracker {
  getTrimmedLineCount(): number;
  handleTrim(amount: number): void;
  recordWrite(input: {
    startLine: number;
    endLine: number;
    cwd: string | undefined;
  }): void;
  snapshotRanges(
    options?: TerminalCwdRangeSnapshotOptions
  ): SurfaceSnapshotCwdRange[];
}

export interface TerminalCwdRangeSnapshotOptions {
  startLine?: number;
  endLine?: number;
  lineOffset?: number;
}

export interface TerminalCwdRangeSnapshotWindow {
  startLine: number;
  endLine: number;
  lineOffset: number;
}

export function createTerminalCwdRangeTracker(
  lineSource: TerminalCwdRangeTrackerLineSource
): TerminalCwdRangeTracker {
  const ranges: Array<StoredCwdRange | undefined> = [];
  let rangeHead = 0;
  let retainedCwdBytes = 0;
  let trimmedLineCount = 0;

  function retainedRangeCount(): number {
    return ranges.length - rangeHead;
  }

  function evictOldestRange(): void {
    const oldest = ranges[rangeHead];
    if (!oldest) {
      rangeHead += 1;
      return;
    }
    ranges[rangeHead] = undefined;
    rangeHead += 1;
    retainedCwdBytes = Math.max(0, retainedCwdBytes - oldest.cwdBytes);
  }

  function compactRangeHead(): void {
    if (rangeHead < 1_024) {
      return;
    }
    ranges.splice(0, rangeHead);
    rangeHead = 0;
  }

  function enforceRangeBounds(): void {
    while (
      retainedRangeCount() > TERMINAL_DATA_PLANE_MAX_CWD_RANGES ||
      retainedCwdBytes > TERMINAL_CWD_RANGE_MAX_RETAINED_BYTES
    ) {
      evictOldestRange();
    }
    compactRangeHead();
  }

  function normalizeRange(input: {
    startLine: number;
    endLine: number;
    cwd: string;
  }): SurfaceSnapshotCwdRange | null {
    const length = lineSource.getBufferLength();
    if (length <= 0) {
      return null;
    }
    const startLine = Math.max(0, Math.min(input.startLine, length - 1));
    const endLine = Math.max(startLine, Math.min(input.endLine, length - 1));
    return { startLine, endLine, cwd: input.cwd };
  }

  return {
    getTrimmedLineCount() {
      return trimmedLineCount;
    },
    handleTrim(amount) {
      const normalizedAmount = normalizeTrimAmount(amount);
      if (normalizedAmount <= 0) {
        return;
      }
      trimmedLineCount += normalizedAmount;
      const retained: StoredCwdRange[] = [];
      retainedCwdBytes = 0;
      for (let index = rangeHead; index < ranges.length; index += 1) {
        const stored = ranges[index];
        if (!stored) {
          continue;
        }
        const range = stored.range;
        range.startLine -= normalizedAmount;
        range.endLine -= normalizedAmount;
        if (range.endLine < 0) {
          continue;
        }
        range.startLine = Math.max(0, range.startLine);
        retained.push(stored);
        retainedCwdBytes += stored.cwdBytes;
      }
      ranges.length = 0;
      for (const stored of retained) {
        ranges.push(stored);
      }
      rangeHead = 0;
    },
    recordWrite(input) {
      if (!input.cwd) {
        return;
      }
      const cwdBytes = Buffer.byteLength(input.cwd, "utf8");
      if (cwdBytes > TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES) {
        return;
      }
      const next = normalizeRange({
        startLine: input.startLine,
        endLine: input.endLine,
        cwd: input.cwd
      });
      if (!next) {
        return;
      }
      const previous = ranges[ranges.length - 1]?.range;
      if (
        previous?.cwd === next.cwd &&
        previous.endLine + 1 >= next.startLine
      ) {
        previous.endLine = Math.max(previous.endLine, next.endLine);
        return;
      }
      ranges.push({ range: next, cwdBytes });
      retainedCwdBytes += cwdBytes;
      enforceRangeBounds();
    },
    snapshotRanges(options = {}) {
      const length = lineSource.getBufferLength();
      if (length <= 0) {
        return [];
      }
      const windowStart = Math.max(0, options.startLine ?? 0);
      const windowEnd = Math.min(length - 1, options.endLine ?? length - 1);
      const lineOffset = options.lineOffset ?? 0;
      if (windowEnd < windowStart) {
        return [];
      }
      const snapshot: SurfaceSnapshotCwdRange[] = [];
      for (let index = rangeHead; index < ranges.length; index += 1) {
        const range = ranges[index]?.range;
        if (!range) {
          continue;
        }
        const startLine = Math.max(range.startLine, windowStart);
        const endLine = Math.min(range.endLine, windowEnd);
        if (endLine < startLine) {
          continue;
        }
        snapshot.push({
          startLine: startLine - lineOffset,
          endLine: endLine - lineOffset,
          cwd: range.cwd
        });
      }
      return snapshot;
    }
  };
}

function normalizeTrimAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.floor(amount);
}

export function createTerminalCwdRangeSnapshotWindow({
  baseY,
  bufferLength,
  restoreScrollbackLines
}: {
  baseY: number;
  bufferLength: number;
  restoreScrollbackLines: number;
}): TerminalCwdRangeSnapshotWindow {
  const endLine = Math.max(-1, bufferLength - 1);
  if (endLine < 0) {
    return {
      startLine: 0,
      endLine,
      lineOffset: 0
    };
  }
  const startLine = Math.min(
    Math.max(0, baseY - restoreScrollbackLines),
    endLine
  );
  return {
    startLine,
    endLine,
    lineOffset: startLine
  };
}
