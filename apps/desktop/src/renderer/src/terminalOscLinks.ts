import type {
  IBufferCell,
  IBufferRange,
  ILink,
  ILinkHandler,
  ILinkProvider,
  ITerminalAddon,
  Terminal
} from "@xterm/xterm";

const MAX_OSC_LINK_SPAN_LINES = 16;
const OSC_HARD_WRAP_RIGHT_MARGIN = 2;
const OSC_HARD_WRAP_MARGIN_MIN_COLS = 20;

interface XtermInternalCell extends IBufferCell {
  hasExtendedAttrs(): boolean | number;
  extended: {
    urlId: number;
  };
}

interface XtermInternalBufferLine {
  isWrapped: boolean;
  length: number;
  getTrimmedLength(): number;
  loadCell(index: number, cell: XtermInternalCell): void;
}

interface XtermInternalBuffer {
  lines: {
    get(index: number): XtermInternalBufferLine | undefined;
  };
}

interface XtermInternalOscLinkService {
  getLinkData(linkId: number): { id?: string; uri: string } | undefined;
}

interface XtermInternalOptionsService {
  rawOptions?: {
    linkHandler?: ILinkHandler;
  };
}

interface XtermInternalOscLinkProvider extends ILinkProvider {
  _bufferService?: {
    buffer: XtermInternalBuffer;
    cols: number;
  };
  _oscLinkService?: XtermInternalOscLinkService;
  _optionsService?: XtermInternalOptionsService;
}

interface XtermTerminalWithLinkProviders extends Terminal {
  _core?: {
    _linkProviderService?: {
      linkProviders?: ILinkProvider[];
    };
    _bufferService?: {
      buffer: XtermInternalBuffer;
      cols: number;
    };
    _oscLinkService?: XtermInternalOscLinkService;
    _optionsService?: XtermInternalOptionsService;
  };
}

/**
 * Extends xterm.js 6.0's built-in OscLinkProvider so OSC 8 hyperlinks that wrap
 * across multiple buffer rows (soft wrap or TUI hard wrap) underline and
 * activate across the full visual span rather than stopping at the hovered row.
 */
export class MultilineOscLinksAddon implements ITerminalAddon {
  private restore: (() => void) | undefined;

  public activate(terminal: Terminal): void {
    this.restore = installMultilineOscLinkProvider(terminal);
  }

  public dispose(): void {
    this.restore?.();
    this.restore = undefined;
  }
}

export function installMultilineOscLinkProvider(
  terminal: Terminal
): () => void {
  const internal = terminal as XtermTerminalWithLinkProviders;
  const linkProviders = internal._core?._linkProviderService?.linkProviders;
  if (!Array.isArray(linkProviders) || linkProviders.length === 0) {
    return () => {};
  }

  const original = linkProviders[0] as XtermInternalOscLinkProvider | undefined;
  const bufferService =
    original?._bufferService ?? internal._core?._bufferService;
  const oscLinkService =
    original?._oscLinkService ?? internal._core?._oscLinkService;
  const optionsService =
    original?._optionsService ?? internal._core?._optionsService;

  if (
    !original ||
    typeof original.provideLinks !== "function" ||
    !bufferService?.buffer?.lines?.get ||
    !oscLinkService?.getLinkData
  ) {
    return () => {};
  }

  const wrapped: ILinkProvider = {
    provideLinks(y, callback) {
      original.provideLinks(y, (links) => {
        if (!links || links.length === 0) {
          callback(links);
          return;
        }
        try {
          // The public API creates a scratch cell. The internal buffer's null
          // cell is reused by xterm to fill erased rows and must stay blank.
          const cell = terminal.buffer.active.getNullCell() as XtermInternalCell;
          const expanded = links.map((link) =>
            expandOscLinkAcrossWrappedRows(
              link,
              cell,
              bufferService,
              oscLinkService,
              optionsService?.rawOptions?.linkHandler
            )
          );
          callback(expanded);
        } catch {
          callback(links);
        }
      });
    }
  };

  linkProviders[0] = wrapped;
  return () => {
    const currentIndex = linkProviders.indexOf(wrapped);
    if (currentIndex !== -1) {
      linkProviders[currentIndex] = original;
    }
  };
}

function expandOscLinkAcrossWrappedRows(
  link: ILink,
  cell: XtermInternalCell,
  bufferService: { buffer: XtermInternalBuffer; cols: number },
  oscLinkService: XtermInternalOscLinkService,
  linkHandler: ILinkHandler | undefined
): ILink {
  const buffer = bufferService.buffer;
  const anchorRowIndex = link.range.start.y - 1;
  const anchorLine = buffer.lines.get(anchorRowIndex);
  if (!anchorLine) {
    return link;
  }

  const anchorStartCol = link.range.start.x - 1;
  const anchorUrlId = readUrlId(anchorLine, anchorStartCol, cell);
  if (anchorUrlId === 0) {
    return link;
  }

  const targetUri = link.text;
  let startY = link.range.start.y;
  let startX = link.range.start.x;
  let endY = link.range.end.y;
  let endX = link.range.end.x;
  let startUrlId = anchorUrlId;
  let endUrlId = anchorUrlId;

  // Expand upward while the link starts at column 0 of the current start row.
  let stepsUp = 0;
  let currentStartLine = anchorLine;
  while (startX === 1 && stepsUp < MAX_OSC_LINK_SPAN_LINES) {
    const prevRowIndex = startY - 2;
    if (prevRowIndex < 0) {
      break;
    }
    const prevLine = buffer.lines.get(prevRowIndex);
    if (!prevLine) {
      break;
    }
    const prevTrimmed = prevLine.getTrimmedLength();
    if (prevTrimmed <= 0) {
      break;
    }
    const prevLastUrlId = readUrlId(prevLine, prevTrimmed - 1, cell);
    if (
      !canBridgeOscRows({
        nextLine: currentStartLine,
        prevTrimmed,
        prevUrlId: prevLastUrlId,
        nextUrlId: startUrlId,
        targetUri,
        cols: bufferService.cols,
        oscLinkService,
        cell
      })
    ) {
      break;
    }
    let runStart = prevTrimmed - 1;
    while (runStart > 0 && readUrlId(prevLine, runStart - 1, cell) === prevLastUrlId) {
      runStart -= 1;
    }
    startY = prevRowIndex + 1;
    startX = runStart + 1;
    startUrlId = prevLastUrlId;
    currentStartLine = prevLine;
    stepsUp += 1;
  }

  // Expand downward while the link reaches the trimmed end of the current end row.
  let stepsDown = 0;
  let currentEndLine = anchorLine;
  while (
    endX >= currentEndLine.getTrimmedLength() &&
    stepsDown < MAX_OSC_LINK_SPAN_LINES
  ) {
    const nextRowIndex = endY;
    const nextLine = buffer.lines.get(nextRowIndex);
    if (!nextLine) {
      break;
    }
    const nextTrimmed = nextLine.getTrimmedLength();
    if (nextTrimmed <= 0) {
      break;
    }
    const nextFirstUrlId = readUrlId(nextLine, 0, cell);
    if (
      !canBridgeOscRows({
        nextLine,
        prevTrimmed: currentEndLine.getTrimmedLength(),
        prevUrlId: endUrlId,
        nextUrlId: nextFirstUrlId,
        targetUri,
        cols: bufferService.cols,
        oscLinkService,
        cell
      })
    ) {
      break;
    }
    let runEnd = 1;
    while (
      runEnd < nextTrimmed &&
      readUrlId(nextLine, runEnd, cell) === nextFirstUrlId
    ) {
      runEnd += 1;
    }
    endY = nextRowIndex + 1;
    endX = runEnd;
    endUrlId = nextFirstUrlId;
    currentEndLine = nextLine;
    stepsDown += 1;
  }

  if (
    startX === link.range.start.x &&
    startY === link.range.start.y &&
    endX === link.range.end.x &&
    endY === link.range.end.y
  ) {
    return link;
  }

  const range: IBufferRange = {
    start: { x: startX, y: startY },
    end: { x: endX, y: endY }
  };

  return {
    ...link,
    range,
    activate: linkHandler
      ? (event, text) => linkHandler.activate(event, text, range)
      : link.activate,
    hover: linkHandler?.hover
      ? (event, text) => linkHandler.hover?.(event, text, range)
      : link.hover,
    leave: linkHandler?.leave
      ? (event, text) => linkHandler.leave?.(event, text, range)
      : link.leave
  };
}

function canBridgeOscRows({
  nextLine,
  prevTrimmed,
  prevUrlId,
  nextUrlId,
  targetUri,
  cols,
  oscLinkService,
  cell
}: {
  nextLine: XtermInternalBufferLine;
  prevTrimmed: number;
  prevUrlId: number;
  nextUrlId: number;
  targetUri: string;
  cols: number;
  oscLinkService: XtermInternalOscLinkService;
  cell: XtermInternalCell;
}): boolean {
  if (prevUrlId === 0 || nextUrlId === 0) {
    return false;
  }
  // Exact same OSC 8 link instance (soft-wrapped, kept open across \n, or same id=).
  if (prevUrlId === nextUrlId) {
    return true;
  }
  // Distinct OSC 8 instances pointing to the exact same URI (e.g. a TUI closed
  // OSC 8 before \n and re-opened it on the next wrapped row without id=).
  const prevUri = oscLinkService.getLinkData(prevUrlId)?.uri;
  const nextUri = oscLinkService.getLinkData(nextUrlId)?.uri;
  if (!prevUri || prevUri !== targetUri || nextUri !== targetUri) {
    return false;
  }
  if (nextLine.isWrapped) {
    return true;
  }
  const effectiveCols =
    cols >= OSC_HARD_WRAP_MARGIN_MIN_COLS
      ? cols - OSC_HARD_WRAP_RIGHT_MARGIN
      : cols;
  if (prevTrimmed >= effectiveCols - 1) {
    return true;
  }
  const nextTrimmed = nextLine.getTrimmedLength();
  let nextLinkWidth = 0;
  while (
    nextLinkWidth < nextTrimmed &&
    readUrlId(nextLine, nextLinkWidth, cell) === nextUrlId
  ) {
    nextLinkWidth += 1;
  }
  return prevTrimmed + nextLinkWidth > effectiveCols;
}

function readUrlId(
  line: XtermInternalBufferLine,
  col: number,
  cell: XtermInternalCell
): number {
  if (col < 0 || col >= line.length) {
    return 0;
  }
  line.loadCell(col, cell);
  return cell.hasExtendedAttrs() ? cell.extended.urlId || 0 : 0;
}
