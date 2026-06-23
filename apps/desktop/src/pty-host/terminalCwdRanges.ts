import type { SurfaceSnapshotCwdRange } from "@kmux/proto";

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
  const ranges: SurfaceSnapshotCwdRange[] = [];
  let trimmedLineCount = 0;

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
      for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const range = ranges[index];
        range.startLine -= normalizedAmount;
        range.endLine -= normalizedAmount;
        if (range.endLine < 0) {
          ranges.splice(index, 1);
          continue;
        }
        range.startLine = Math.max(0, range.startLine);
      }
    },
    recordWrite(input) {
      if (!input.cwd) {
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
      const previous = ranges[ranges.length - 1];
      if (
        previous?.cwd === next.cwd &&
        previous.endLine + 1 >= next.startLine
      ) {
        previous.endLine = Math.max(previous.endLine, next.endLine);
        return;
      }
      ranges.push(next);
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
      return ranges
        .map((range) => {
          const startLine = Math.max(range.startLine, windowStart);
          const endLine = Math.min(range.endLine, windowEnd);
          return {
            startLine: startLine - lineOffset,
            endLine: endLine - lineOffset,
            cwd: range.cwd
          };
        })
        .filter((range) => range.endLine >= range.startLine);
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
