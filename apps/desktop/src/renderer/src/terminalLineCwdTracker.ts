export interface TerminalLineCwdRange {
  startLine: number;
  endLine: number;
  cwd: string;
}

export interface TerminalLineCwdTracker {
  getTrimmedLineCount(): number;
  handleTrim(amount: number): void;
  importSnapshotRanges(ranges: TerminalLineCwdRange[] | undefined): void;
  recordWrite(input: {
    startLine: number;
    endLine: number;
    cwd: string | undefined;
  }): void;
  getCwdForLine(line: number): string | undefined;
  clear(): void;
}

const PRUNE_TRIM_INTERVAL = 4096;

export function createTerminalLineCwdTracker(): TerminalLineCwdTracker {
  // Keys are absolute line numbers. Public APIs still use xterm buffer
  // coordinates, where buffer line L maps to absolute L + trimmedLineCount.
  const lineCwds = new Map<number, string>();
  let trimmedLineCount = 0;
  let lastPruneTrimCount = 0;

  function toAbsoluteLine(line: number): number | null {
    const normalizedLine = normalizeLine(line);
    return normalizedLine === null ? null : normalizedLine + trimmedLineCount;
  }

  function setRange(startLine: number, endLine: number, cwd: string): void {
    const absoluteStart = toAbsoluteLine(startLine);
    const absoluteEnd = toAbsoluteLine(endLine);
    if (absoluteStart === null || absoluteEnd === null) {
      return;
    }

    const firstLine = Math.min(absoluteStart, absoluteEnd);
    const lastLine = Math.max(absoluteStart, absoluteEnd);
    for (let line = firstLine; line <= lastLine; line += 1) {
      lineCwds.set(line, cwd);
    }
  }

  function pruneTrimmedLines(): void {
    if (trimmedLineCount - lastPruneTrimCount < PRUNE_TRIM_INTERVAL) {
      return;
    }
    lastPruneTrimCount = trimmedLineCount;
    for (const line of lineCwds.keys()) {
      if (line < trimmedLineCount) {
        lineCwds.delete(line);
      }
    }
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
      pruneTrimmedLines();
    },
    importSnapshotRanges(ranges) {
      lineCwds.clear();
      lastPruneTrimCount = trimmedLineCount;
      for (const range of ranges ?? []) {
        setRange(range.startLine, range.endLine, range.cwd);
      }
    },
    recordWrite({ startLine, endLine, cwd }) {
      if (!cwd) {
        return;
      }
      setRange(startLine, endLine, cwd);
    },
    getCwdForLine(line) {
      const absoluteLine = toAbsoluteLine(line);
      return absoluteLine === null ? undefined : lineCwds.get(absoluteLine);
    },
    clear() {
      lineCwds.clear();
      trimmedLineCount = 0;
      lastPruneTrimCount = 0;
    }
  };
}

function normalizeLine(line: number): number | null {
  if (!Number.isFinite(line)) {
    return null;
  }
  return Math.max(0, Math.floor(line));
}

function normalizeTrimAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.floor(amount);
}
