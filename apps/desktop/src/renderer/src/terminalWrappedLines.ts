import type {
  IBufferCell,
  IBufferLine,
  IBufferRange,
  Terminal
} from "@xterm/xterm";

export const WRAPPED_LINE_SCAN_LIMIT = 2048;
export const HARD_WRAP_MAX_LINES = 8;
const HARD_WRAP_RIGHT_MARGIN = 2;
const HARD_WRAP_MARGIN_MIN_COLS = 20;

const STRUCTURAL_LINE_START_RE =
  /^(?:[│┃┆┇┊┋├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┴┼╭╮╯╰┌┐└┘─━═║╔╗╚╝╠╣╦╩╬]|(?:[-*+•◦▪▸▹>$#%])\s|\d+[.)]\s|#{1,6}\s|```|~~~|---+|===+)/u;
const URL_SCHEME_PREFIX_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const FILE_BREAK_END_RE = /[/\-_.]$/;
const FILE_CONTINUATION_START_RE = /^[/:]/;
const WEB_BREAK_END_RE = /[/\-_?&=#%.~:+,;]$/;
const WEB_CONTINUATION_START_RE = /^[/?&#]/;
const WEB_URL_CHAR_START_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]/;

export type TerminalWrappedLineMode = "file" | "web";

export interface TerminalWrappedLineOptions {
  mode: TerminalWrappedLineMode;
  allowHardWrap?: boolean;
  scanLimit?: number;
  maxHardWrapLines?: number;
}

interface CellStyleSignature {
  readonly isFgDefault: boolean;
  readonly fgMode: number;
  readonly fgColor: number;
}

interface ScannedBufferLine {
  readonly lineIndex: number;
  readonly text: string;
  readonly isWrapped: boolean;
  readonly cols: number;
  readonly cellColumns: readonly number[];
  readonly cellEndColumns: readonly number[];
  readonly displayWidth: number;
  readonly firstStyle: CellStyleSignature | null;
  readonly lastStyle: CellStyleSignature | null;
}

export interface TerminalWrappedLineSegment {
  readonly lineIndex: number;
  readonly text: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly displayWidth: number;
  readonly isSoftWrapped: boolean;
  readonly joinedByHardWrap: boolean;
  readonly cellColumns: readonly number[];
  readonly cellEndColumns: readonly number[];
}

export interface TerminalWrappedLineWindow {
  readonly text: string;
  readonly anchorLineIndex: number;
  readonly startLineIndex: number;
  readonly endLineIndex: number;
  readonly segments: readonly TerminalWrappedLineSegment[];
  readonly hasHardWrapJoin: boolean;
  locateOffset(
    stringIndex: number
  ): { lineIndex: number; column: number } | null;
  mapRange(startIndex: number, endIndex: number): IBufferRange | null;
  intersectsLine(
    startIndex: number,
    endIndex: number,
    lineIndex: number
  ): boolean;
  crossesHardWrap(startIndex: number, endIndex: number): boolean;
}

export function getTerminalWrappedLineWindow(
  anchorLineIndex: number,
  terminal: Terminal,
  options: TerminalWrappedLineOptions
): TerminalWrappedLineWindow | null {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const anchor = scanBufferLine(terminal, anchorLineIndex, cell);
  if (!anchor) {
    return null;
  }

  const allowHardWrap = options.allowHardWrap ?? true;
  const scanLimit = options.scanLimit ?? WRAPPED_LINE_SCAN_LIMIT;
  const maxHardWrapLines = options.maxHardWrapLines ?? HARD_WRAP_MAX_LINES;

  const upper: Array<{ line: ScannedBufferLine; nextHardWrapped: boolean }> =
    [];
  if (anchor.text.length > 0 && !/^\s/u.test(anchor.text)) {
    let current = anchor;
    let totalLength = 0;
    let hardWrapSteps = 0;
    while (totalLength < scanLimit) {
      const prev = scanBufferLine(terminal, current.lineIndex - 1, cell);
      if (!prev) {
        break;
      }
      const isSoftJoin = current.isWrapped;
      const isHardJoin =
        !isSoftJoin &&
        allowHardWrap &&
        hardWrapSteps < maxHardWrapLines &&
        canJoinHardWrappedLines(prev, current, options.mode);
      if (!isSoftJoin && !isHardJoin) {
        break;
      }
      if (isHardJoin) {
        hardWrapSteps += 1;
      }
      upper.push({ line: prev, nextHardWrapped: isHardJoin });
      totalLength += prev.text.length;
      current = prev;
      if (prev.text.includes(" ")) {
        break;
      }
    }
    upper.reverse();
  }

  const lower: Array<{ line: ScannedBufferLine; joinedByHardWrap: boolean }> =
    [];
  {
    let current = anchor;
    let totalLength = 0;
    let hardWrapSteps = 0;
    while (totalLength < scanLimit) {
      const next = scanBufferLine(terminal, current.lineIndex + 1, cell);
      if (!next) {
        break;
      }
      const isSoftJoin = next.isWrapped;
      const isHardJoin =
        !isSoftJoin &&
        allowHardWrap &&
        hardWrapSteps < maxHardWrapLines &&
        canJoinHardWrappedLines(current, next, options.mode);
      if (!isSoftJoin && !isHardJoin) {
        break;
      }
      if (isHardJoin) {
        hardWrapSteps += 1;
      }
      lower.push({ line: next, joinedByHardWrap: isHardJoin });
      totalLength += next.text.length;
      current = next;
      if (next.text.includes(" ")) {
        break;
      }
    }
  }

  const ordered: Array<{ line: ScannedBufferLine; joinedByHardWrap: boolean }> =
    [];
  for (let i = 0; i < upper.length; i += 1) {
    ordered.push({
      line: upper[i].line,
      joinedByHardWrap: i > 0 ? upper[i - 1].nextHardWrapped : false
    });
  }
  ordered.push({
    line: anchor,
    joinedByHardWrap:
      upper.length > 0 ? upper[upper.length - 1].nextHardWrapped : false
  });
  for (const entry of lower) {
    ordered.push(entry);
  }

  const segments: TerminalWrappedLineSegment[] = [];
  const textParts: string[] = [];
  let offset = 0;
  let hasHardWrapJoin = false;

  for (const { line, joinedByHardWrap } of ordered) {
    const textStart = offset;
    const textEnd = textStart + line.text.length;
    offset = textEnd;
    if (joinedByHardWrap) {
      hasHardWrapJoin = true;
    }
    textParts.push(line.text);
    segments.push({
      lineIndex: line.lineIndex,
      text: line.text,
      textStart,
      textEnd,
      displayWidth: line.displayWidth,
      isSoftWrapped: line.isWrapped,
      joinedByHardWrap,
      cellColumns: line.cellColumns,
      cellEndColumns: line.cellEndColumns
    });
  }

  const text = textParts.join("");

  return {
    text,
    anchorLineIndex,
    startLineIndex: segments[0].lineIndex,
    endLineIndex: segments[segments.length - 1].lineIndex,
    segments,
    hasHardWrapJoin,
    locateOffset(stringIndex: number) {
      const seg = findSegmentForIndex(segments, stringIndex);
      if (!seg) {
        return null;
      }
      const localIndex = stringIndex - seg.textStart;
      const column = seg.cellColumns[localIndex];
      if (column === undefined) {
        return null;
      }
      return { lineIndex: seg.lineIndex, column };
    },
    mapRange(startIndex: number, endIndex: number): IBufferRange | null {
      if (startIndex < 0 || endIndex <= startIndex || endIndex > text.length) {
        return null;
      }
      const startSeg = findSegmentForIndex(segments, startIndex);
      const endSeg = findSegmentForIndex(segments, endIndex - 1);
      if (!startSeg || !endSeg) {
        return null;
      }
      const startCol = startSeg.cellColumns[startIndex - startSeg.textStart];
      const endCol = endSeg.cellEndColumns[endIndex - 1 - endSeg.textStart];
      if (startCol === undefined || endCol === undefined) {
        return null;
      }
      return {
        start: { x: startCol + 1, y: startSeg.lineIndex + 1 },
        end: { x: endCol, y: endSeg.lineIndex + 1 }
      };
    },
    intersectsLine(
      startIndex: number,
      endIndex: number,
      lineIndex: number
    ): boolean {
      if (startIndex < 0 || endIndex <= startIndex || endIndex > text.length) {
        return false;
      }
      const startSeg = findSegmentForIndex(segments, startIndex);
      const endSeg = findSegmentForIndex(segments, endIndex - 1);
      if (!startSeg || !endSeg) {
        return false;
      }
      return startSeg.lineIndex <= lineIndex && endSeg.lineIndex >= lineIndex;
    },
    crossesHardWrap(startIndex: number, endIndex: number): boolean {
      if (
        !hasHardWrapJoin ||
        startIndex < 0 ||
        endIndex <= startIndex ||
        endIndex > text.length
      ) {
        return false;
      }
      const startSegIndex = findSegmentIndexForIndex(segments, startIndex);
      const endSegIndex = findSegmentIndexForIndex(segments, endIndex - 1);
      if (
        startSegIndex === -1 ||
        endSegIndex === -1 ||
        startSegIndex >= endSegIndex
      ) {
        return false;
      }
      for (let i = startSegIndex + 1; i <= endSegIndex; i += 1) {
        if (segments[i].joinedByHardWrap) {
          return true;
        }
      }
      return false;
    }
  };
}

function scanBufferLine(
  terminal: Terminal,
  lineIndex: number,
  cell: IBufferCell
): ScannedBufferLine | null {
  if (lineIndex < 0) {
    return null;
  }
  const line: IBufferLine | undefined =
    terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return null;
  }

  const text = line.translateToString(true);
  const cols =
    typeof terminal.cols === "number" && terminal.cols > 0
      ? terminal.cols
      : line.length;

  if (text.length === 0) {
    return {
      lineIndex,
      text,
      isWrapped: line.isWrapped,
      cols,
      cellColumns: [],
      cellEndColumns: [],
      displayWidth: 0,
      firstStyle: null,
      lastStyle: null
    };
  }

  const cellColumns: number[] = [];
  const cellEndColumns: number[] = [];
  let displayWidth = 0;
  let firstStyle: CellStyleSignature | null = null;
  let lastStyle: CellStyleSignature | null = null;

  for (
    let col = 0;
    col < line.length && cellColumns.length < text.length;
    col += 1
  ) {
    const loaded = line.getCell(col, cell);
    if (!loaded) {
      break;
    }
    const width = loaded.getWidth();
    if (width === 0) {
      continue;
    }
    const chars = loaded.getChars();
    const renderedLength = chars.length || 1;
    const endCol = col + width;
    const style = readCellStyle(loaded);
    if (cellColumns.length === 0) {
      firstStyle = style;
    }
    lastStyle = style;
    const remaining = text.length - cellColumns.length;
    const pushCount = Math.min(renderedLength, remaining);
    for (let k = 0; k < pushCount; k += 1) {
      cellColumns.push(col);
      cellEndColumns.push(endCol);
    }
    displayWidth = endCol;
  }

  return {
    lineIndex,
    text,
    isWrapped: line.isWrapped,
    cols,
    cellColumns,
    cellEndColumns,
    displayWidth,
    firstStyle,
    lastStyle
  };
}

function canJoinHardWrappedLines(
  prev: ScannedBufferLine,
  next: ScannedBufferLine,
  mode: TerminalWrappedLineMode
): boolean {
  if (prev.text.length === 0 || next.text.length === 0) {
    return false;
  }
  if (/\s$/u.test(prev.text) || /^\s/u.test(next.text)) {
    return false;
  }
  if (next.cellColumns[0] !== 0) {
    return false;
  }
  if (STRUCTURAL_LINE_START_RE.test(next.text)) {
    return false;
  }
  if (!areBoundaryStylesCompatible(prev.lastStyle, next.firstStyle)) {
    return false;
  }

  const cols = Math.max(prev.cols, prev.displayWidth);
  if (cols <= 0) {
    return false;
  }
  const margin =
    cols >= HARD_WRAP_MARGIN_MIN_COLS ? HARD_WRAP_RIGHT_MARGIN : 0;
  const effectiveCols = cols - margin;
  const isFlushRightEdge = prev.displayWidth >= effectiveCols - 1;
  const nextAtomicWidth = measureFirstSlashSegmentDisplayWidth(next);
  if (!isFlushRightEdge && prev.displayWidth + nextAtomicWidth <= effectiveCols) {
    return false;
  }

  if (mode === "web") {
    if (URL_SCHEME_PREFIX_RE.test(next.text)) {
      return false;
    }
    if (!WEB_URL_CHAR_START_RE.test(next.text)) {
      return false;
    }
    return (
      isFlushRightEdge ||
      WEB_BREAK_END_RE.test(prev.text) ||
      WEB_CONTINUATION_START_RE.test(next.text)
    );
  }

  return (
    isFlushRightEdge ||
    FILE_BREAK_END_RE.test(prev.text) ||
    FILE_CONTINUATION_START_RE.test(next.text)
  );
}

function measureFirstSlashSegmentDisplayWidth(line: ScannedBufferLine): number {
  let endIndex = 0;
  while (endIndex < line.text.length) {
    const ch = line.text[endIndex];
    if (/\s/u.test(ch)) {
      break;
    }
    endIndex += 1;
    if (ch === "/") {
      break;
    }
  }
  if (endIndex <= 0) {
    return 0;
  }
  return line.cellEndColumns[endIndex - 1] ?? 0;
}

function readCellStyle(cell: IBufferCell): CellStyleSignature | null {
  if (
    typeof cell.isFgDefault !== "function" ||
    typeof cell.getFgColorMode !== "function" ||
    typeof cell.getFgColor !== "function"
  ) {
    return null;
  }
  return {
    isFgDefault: cell.isFgDefault(),
    fgMode: cell.getFgColorMode(),
    fgColor: cell.getFgColor()
  };
}

function areBoundaryStylesCompatible(
  prev: CellStyleSignature | null,
  next: CellStyleSignature | null
): boolean {
  if (!prev || !next) {
    return true;
  }
  if (prev.isFgDefault && next.isFgDefault) {
    return true;
  }
  return (
    prev.isFgDefault === next.isFgDefault &&
    prev.fgMode === next.fgMode &&
    prev.fgColor === next.fgColor
  );
}

function findSegmentForIndex(
  segments: readonly TerminalWrappedLineSegment[],
  stringIndex: number
): TerminalWrappedLineSegment | null {
  const index = findSegmentIndexForIndex(segments, stringIndex);
  return index === -1 ? null : segments[index];
}

function findSegmentIndexForIndex(
  segments: readonly TerminalWrappedLineSegment[],
  stringIndex: number
): number {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (stringIndex >= segment.textStart && stringIndex < segment.textEnd) {
      return i;
    }
  }
  return -1;
}
