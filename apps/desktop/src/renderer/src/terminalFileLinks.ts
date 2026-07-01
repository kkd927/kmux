import type {
  IBufferLine,
  IDisposable,
  ILink,
  ILinkDecorations,
  Terminal
} from "@xterm/xterm";

import type { KeyboardShortcutPlatform } from "../../shared/platform/keyboardPolicy";

const WRAPPED_LINE_SCAN_LIMIT = 2048;
const MARKDOWN_ANGLE_LINK_TARGET_RE = /\[[^\]\n]*\]\(<([^>\n]+)>\)/g;
const MARKDOWN_LINK_TARGET_RE = /\[[^\]\n]*\]\(([^()\s]+)\)/g;
const QUOTED_PATH_RE = /(["'])([^"'\n]*[/~.][^"'\n]*)\1/g;
const ESCAPED_SPACE_PATH_RE =
  /(?:^|\s)((?:\/|~\/|\.{1,2}\/|[A-Za-z0-9_.@-]+\/)(?:\\ |[^\s])*(?:\\ [^\s]*)+)/g;
const TOKEN_RE = /\S+/g;
const LEADING_PATH_PUNCTUATION = new Set(["(", "[", "{", "<", '"', "'", "`"]);
const TRAILING_PATH_PUNCTUATION = new Set([
  ",",
  ".",
  ";",
  "!",
  "?",
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "`"
]);
const URL_LIKE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DOMAIN_LIKE_FIRST_SEGMENT_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const RELATIVE_FIRST_SEGMENT_RE = /^[A-Za-z0-9_.@-]+$/;

export interface TerminalFilePathCandidate {
  rawPath: string;
  startIndex: number;
  endIndex: number;
}

interface StrippedPathToken {
  text: string;
  leading: number;
  trailing: number;
}

interface TerminalFileLinkProviderOptions {
  terminal: Terminal;
  getKeyboardPlatform: () => KeyboardShortcutPlatform;
  surfaceId: string;
  openFilePath: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  getCwdForBufferLine?: (bufferLineNumber: number) => string | undefined;
}

export function isTerminalFileLinkModifierActive(
  event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">,
  platform: KeyboardShortcutPlatform
): boolean {
  if (platform === "darwin") {
    return event.metaKey;
  }
  return event.ctrlKey;
}

export function parseTerminalFilePathCandidates(
  text: string
): TerminalFilePathCandidate[] {
  const candidates: TerminalFilePathCandidate[] = [];
  const consumedRanges: Array<{ startIndex: number; endIndex: number }> = [];

  for (const match of text.matchAll(MARKDOWN_ANGLE_LINK_TARGET_RE)) {
    const fullMatch = match[0];
    const target = match[1];
    const fullStartIndex = match.index;
    const targetStartInMatch = fullMatch.indexOf("<") + 1;
    if (
      targetStartInMatch <= 0 ||
      hasConsumedRangeOverlap(consumedRanges, {
        startIndex: fullStartIndex,
        endIndex: fullStartIndex + fullMatch.length
      })
    ) {
      continue;
    }

    consumedRanges.push({
      startIndex: fullStartIndex,
      endIndex: fullStartIndex + fullMatch.length
    });
    addCandidateFromPathToken({
      candidates,
      sourceText: target,
      sourceStartIndex: fullStartIndex + targetStartInMatch,
      rawText: unescapePathText(target)
    });
  }

  for (const match of text.matchAll(MARKDOWN_LINK_TARGET_RE)) {
    const fullMatch = match[0];
    const target = match[1];
    const fullStartIndex = match.index;
    const targetStartInMatch = fullMatch.indexOf(`(${target}`) + 1;
    if (
      targetStartInMatch <= 0 ||
      hasConsumedRangeOverlap(consumedRanges, {
        startIndex: fullStartIndex,
        endIndex: fullStartIndex + fullMatch.length
      })
    ) {
      continue;
    }

    const targetStartIndex = fullStartIndex + targetStartInMatch;
    consumedRanges.push({
      startIndex: fullStartIndex,
      endIndex: fullStartIndex + fullMatch.length
    });
    addCandidateFromPathToken({
      candidates,
      sourceText: target,
      sourceStartIndex: targetStartIndex
    });
  }

  for (const match of text.matchAll(QUOTED_PATH_RE)) {
    const fullMatch = match[0];
    const rawTarget = match[2];
    const fullStartIndex = match.index;
    const targetStartIndex = fullStartIndex + match[1].length;
    if (
      hasConsumedRangeOverlap(consumedRanges, {
        startIndex: fullStartIndex,
        endIndex: fullStartIndex + fullMatch.length
      })
    ) {
      continue;
    }

    consumedRanges.push({
      startIndex: fullStartIndex,
      endIndex: fullStartIndex + fullMatch.length
    });
    addCandidateFromPathToken({
      candidates,
      sourceText: rawTarget,
      sourceStartIndex: targetStartIndex,
      rawText: unescapePathText(rawTarget)
    });
  }

  for (const match of text.matchAll(ESCAPED_SPACE_PATH_RE)) {
    const escapedTarget = match[1];
    const targetStartIndex = match.index + match[0].indexOf(escapedTarget);
    if (
      hasConsumedRangeOverlap(consumedRanges, {
        startIndex: targetStartIndex,
        endIndex: targetStartIndex + escapedTarget.length
      })
    ) {
      continue;
    }

    consumedRanges.push({
      startIndex: targetStartIndex,
      endIndex: targetStartIndex + escapedTarget.length
    });
    addCandidateFromPathToken({
      candidates,
      sourceText: escapedTarget,
      sourceStartIndex: targetStartIndex,
      rawText: unescapePathText(escapedTarget)
    });
  }

  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const tokenStart = match.index;
    const tokenEnd = tokenStart + token.length;
    if (
      hasConsumedRangeOverlap(consumedRanges, {
        startIndex: tokenStart,
        endIndex: tokenEnd
      })
    ) {
      continue;
    }

    addCandidateFromPathToken({
      candidates,
      sourceText: token,
      sourceStartIndex: tokenStart
    });
  }
  return candidates.sort((a, b) => a.startIndex - b.startIndex);
}

export function registerTerminalFileLinkProvider({
  terminal,
  getKeyboardPlatform,
  surfaceId,
  openFilePath,
  getCwdForBufferLine
}: TerminalFileLinkProviderOptions): IDisposable {
  const activeDecorations = new Set<ILinkDecorations>();
  let modifierActive = false;

  const updateActiveDecorations = (): void => {
    for (const decorations of activeDecorations) {
      decorations.pointerCursor = modifierActive;
      decorations.underline = modifierActive;
    }
  };

  const updateModifierFromEvent = (
    event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">
  ): void => {
    const nextModifierActive = isTerminalFileLinkModifierActive(
      event,
      getKeyboardPlatform()
    );
    if (modifierActive !== nextModifierActive) {
      modifierActive = nextModifierActive;
      updateActiveDecorations();
    }
  };

  const resetModifier = (): void => {
    if (modifierActive) {
      modifierActive = false;
      updateActiveDecorations();
    }
  };

  const linkRegistration = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const [lines, startLineIndex] = getWindowedLineStrings(
        bufferLineNumber - 1,
        terminal
      );
      if (lines.length === 0) {
        callback(undefined);
        return;
      }

      const text = lines.join("");
      const links = parseTerminalFilePathCandidates(text)
        .map((candidate) =>
          createTerminalFileLink({
            candidate,
            startLineIndex,
            terminal,
            surfaceId,
            openFilePath,
            getCwdForBufferLine,
            getKeyboardPlatform,
            activeDecorations,
            updateModifierFromEvent
          })
        )
        .filter((link): link is ILink => link !== null);

      callback(links.length > 0 ? links : undefined);
    }
  });

  window.addEventListener("keydown", updateModifierFromEvent, true);
  window.addEventListener("keyup", updateModifierFromEvent, true);
  window.addEventListener("blur", resetModifier, true);

  return {
    dispose() {
      linkRegistration.dispose();
      window.removeEventListener("keydown", updateModifierFromEvent, true);
      window.removeEventListener("keyup", updateModifierFromEvent, true);
      window.removeEventListener("blur", resetModifier, true);
      activeDecorations.clear();
    }
  };
}

function createTerminalFileLink({
  candidate,
  startLineIndex,
  terminal,
  surfaceId,
  openFilePath,
  getCwdForBufferLine,
  getKeyboardPlatform,
  activeDecorations,
  updateModifierFromEvent
}: {
  candidate: TerminalFilePathCandidate;
  startLineIndex: number;
  terminal: Terminal;
  surfaceId: string;
  openFilePath: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  getCwdForBufferLine?: (bufferLineNumber: number) => string | undefined;
  getKeyboardPlatform: () => KeyboardShortcutPlatform;
  activeDecorations: Set<ILinkDecorations>;
  updateModifierFromEvent: (
    event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">
  ) => void;
}): ILink | null {
  const [startLine, startColumn] = mapStringIndex(
    terminal,
    startLineIndex,
    0,
    candidate.startIndex
  );
  const [endLine, endColumn] = mapStringIndex(
    terminal,
    startLine,
    startColumn,
    candidate.endIndex - candidate.startIndex
  );
  if (
    startLine === -1 ||
    startColumn === -1 ||
    endLine === -1 ||
    endColumn === -1
  ) {
    return null;
  }

  const decorations: ILinkDecorations = {
    pointerCursor: false,
    underline: false
  };
  const baseCwd = getCwdForBufferLine?.(startLine);

  const leave = (): void => {
    activeDecorations.delete(decorations);
    decorations.pointerCursor = false;
    decorations.underline = false;
  };

  return {
    range: {
      start: { x: startColumn + 1, y: startLine + 1 },
      end: { x: endColumn, y: endLine + 1 }
    },
    text: candidate.rawPath,
    decorations,
    activate: (event) => {
      if (!isTerminalFileLinkModifierActive(event, getKeyboardPlatform())) {
        return;
      }
      void openFilePath(surfaceId, candidate.rawPath, baseCwd).catch(
        (error) => {
          console.warn("Failed to open terminal file path", error);
        }
      );
    },
    hover: (event) => {
      activeDecorations.add(decorations);
      updateModifierFromEvent(event);
      decorations.pointerCursor = isTerminalFileLinkModifierActive(
        event,
        getKeyboardPlatform()
      );
      decorations.underline = decorations.pointerCursor;
    },
    leave,
    dispose: leave
  };
}

function addCandidateFromPathToken({
  candidates,
  sourceText,
  sourceStartIndex,
  rawText = sourceText
}: {
  candidates: TerminalFilePathCandidate[];
  sourceText: string;
  sourceStartIndex: number;
  rawText?: string;
}): void {
  const stripped = stripPathToken(rawText);
  if (!stripped.text || !isTerminalFilePathCandidate(stripped.text)) {
    return;
  }

  candidates.push({
    rawPath: stripped.text,
    startIndex: sourceStartIndex + stripped.leading,
    endIndex: sourceStartIndex + sourceText.length - stripped.trailing
  });
}

function hasConsumedRangeOverlap(
  consumedRanges: Array<{ startIndex: number; endIndex: number }>,
  candidateRange: { startIndex: number; endIndex: number }
): boolean {
  return consumedRanges.some(
    (range) =>
      candidateRange.startIndex < range.endIndex &&
      candidateRange.endIndex > range.startIndex
  );
}

function unescapePathText(text: string): string {
  return text.replace(/\\ /g, " ");
}

function stripPathToken(token: string): StrippedPathToken {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PATH_PUNCTUATION.has(token[start])) {
    start += 1;
  }
  while (end > start && shouldStripTrailingCharacter(token.slice(start, end))) {
    end -= 1;
  }

  return {
    text: token.slice(start, end),
    leading: start,
    trailing: token.length - end
  };
}

function shouldStripTrailingCharacter(text: string): boolean {
  const trailing = text[text.length - 1];
  if (trailing === ":") {
    return !/:\d+(?::\d+)?$/.test(text);
  }
  return TRAILING_PATH_PUNCTUATION.has(trailing);
}

function isTerminalFilePathCandidate(text: string): boolean {
  if (!text || text.includes("\0") || URL_LIKE_PROTOCOL_RE.test(text)) {
    return false;
  }
  if (/^\/(?!\/).+/.test(text)) {
    return true;
  }
  if (/^~\/.+/.test(text)) {
    return true;
  }
  if (/^(?:\.\/|\.\.\/).+/.test(text)) {
    return true;
  }
  if (!text.includes("/") || text.startsWith("//")) {
    return false;
  }

  const firstSegment = text.slice(0, text.indexOf("/"));
  if (
    !RELATIVE_FIRST_SEGMENT_RE.test(firstSegment) ||
    DOMAIN_LIKE_FIRST_SEGMENT_RE.test(firstSegment)
  ) {
    return false;
  }
  return true;
}

function getWindowedLineStrings(
  lineIndex: number,
  terminal: Terminal
): [string[], number] {
  let line: IBufferLine | undefined;
  let topIndex = lineIndex;
  let bottomIndex = lineIndex;
  let length = 0;
  let content = "";
  const lines: string[] = [];

  line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return [lines, topIndex];
  }

  const currentContent = line.translateToString(true);
  if (line.isWrapped && currentContent[0] !== " ") {
    while (
      (line = terminal.buffer.active.getLine(--topIndex)) &&
      length < WRAPPED_LINE_SCAN_LIMIT
    ) {
      content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.includes(" ")) {
        break;
      }
    }
    lines.reverse();
  }

  lines.push(currentContent);

  length = 0;
  while (
    (line = terminal.buffer.active.getLine(++bottomIndex)) &&
    line.isWrapped &&
    length < WRAPPED_LINE_SCAN_LIMIT
  ) {
    content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.includes(" ")) {
      break;
    }
  }

  return [lines, topIndex];
}

function mapStringIndex(
  terminal: Terminal,
  lineIndex: number,
  rowIndex: number,
  stringIndex: number
): [number, number] {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let start = rowIndex;

  while (stringIndex) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      return [-1, -1];
    }

    for (let i = start; i < line.length; i += 1) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;
        if (i === line.length - 1 && chars === "") {
          const nextLine = buffer.getLine(lineIndex + 1);
          if (nextLine?.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) {
              stringIndex += 1;
            }
          }
        }
      }
      if (stringIndex < 0) {
        return [lineIndex, i];
      }
    }
    lineIndex += 1;
    start = 0;
  }

  return [lineIndex, start];
}
