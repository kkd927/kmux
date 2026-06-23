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

export function createTerminalLineCwdTracker(): TerminalLineCwdTracker {
  const lineCwds = new Map<number, string>();
  let trimmedLineCount = 0;

  function setRange(startLine: number, endLine: number, cwd: string): void {
    const normalizedStart = normalizeLine(startLine);
    const normalizedEnd = normalizeLine(endLine);
    if (normalizedStart === null || normalizedEnd === null) {
      return;
    }

    const firstLine = Math.min(normalizedStart, normalizedEnd);
    const lastLine = Math.max(normalizedStart, normalizedEnd);
    for (let line = firstLine; line <= lastLine; line += 1) {
      lineCwds.set(line, cwd);
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
      const shiftedLineCwds = new Map<number, string>();
      for (const [line, cwd] of lineCwds.entries()) {
        const shiftedLine = line - normalizedAmount;
        if (shiftedLine >= 0) {
          shiftedLineCwds.set(shiftedLine, cwd);
        }
      }
      lineCwds.clear();
      for (const [line, cwd] of shiftedLineCwds.entries()) {
        lineCwds.set(line, cwd);
      }
    },
    importSnapshotRanges(ranges) {
      lineCwds.clear();
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
      const normalizedLine = normalizeLine(line);
      return normalizedLine === null ? undefined : lineCwds.get(normalizedLine);
    },
    clear() {
      lineCwds.clear();
      trimmedLineCount = 0;
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
