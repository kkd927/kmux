import type {
  IBufferLine,
  IDisposable,
  ILink,
  ILinkDecorations,
  Terminal
} from "@xterm/xterm";
import type {
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolved,
  TerminalFileLinkResolveResult,
  TerminalFileLinkActivationDto
} from "@kmux/proto";

import type { KeyboardShortcutPlatform } from "../../shared/platform/keyboardPolicy";

const WRAPPED_LINE_SCAN_LIMIT = 2048;
const URL_LIKE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const LINK_WITH_SUFFIX_PATH_CHARACTERS =
  /(?<path>(?:file:\/\/\/)?[^\s|<>[({][^\s|<>]*)$/;

enum RegexPathConstants {
  PathPrefix = "(?:\\.\\.?|\\~|file:\\/\\/)",
  PathSeparatorClause = "\\/",
  // Ported from VS Code Code - OSS terminalLinkParsing.ts. Quotes, colons,
  // semicolons, and brackets are treated as terminal separators.
  ExcludedPathCharactersClause = "[^\\0<>\\?\\s!`&*()'\":;\\\\]",
  ExcludedStartPathCharactersClause = "[^\\0<>\\?\\s!`&*()\\[\\]'\":;\\\\]"
}

const UNIX_LOCAL_LINK_CLAUSE =
  "(?:(?:" +
  RegexPathConstants.PathPrefix +
  "|(?:" +
  RegexPathConstants.ExcludedStartPathCharactersClause +
  RegexPathConstants.ExcludedPathCharactersClause +
  "*))?(?:" +
  RegexPathConstants.PathSeparatorClause +
  "(?:" +
  RegexPathConstants.ExcludedPathCharactersClause +
  ")+)+)";
const MARKDOWN_ANGLE_LINK_TARGET_RE = /\[[^\]\n]*\]\(<([^>\n]+)>\)/g;
const QUOTED_SPACE_PATH_RE = /(["'])([^"'\n]*\s[^"'\n]*[/~.][^"'\n]*)\1/g;
const ESCAPED_SPACE_PATH_RE =
  /(?:^|\s)((?:\/|~\/|\.{1,2}\/|[A-Za-z0-9_.@-]+\/)(?:\\ |[^\s])*(?:\\ [^\s]*)+)/g;

export interface TerminalFilePathCandidate {
  rawPath: string;
  linkText: string;
  startIndex: number;
  endIndex: number;
  hasSuffix: boolean;
}

interface ParsedTerminalLink {
  path: LinkPartialRange;
  prefix?: LinkPartialRange;
  suffix?: LinkSuffix;
}

interface LinkSuffix {
  row: number | undefined;
  col: number | undefined;
  rowEnd: number | undefined;
  colEnd: number | undefined;
  suffix: LinkPartialRange;
}

interface LinkPartialRange {
  index: number;
  text: string;
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
  resolveFileLinks?: (
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult>;
  activateFileLink?: (request: TerminalFileLinkActivationDto) => Promise<void>;
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
  const parsedLinks = detectLinks(text);
  return parsedLinks
    .filter((parsedLink) => !hasInnerBracketVariant(parsedLink, parsedLinks))
    .filter((parsedLink) => !isUnsupportedLocalPathMatch(text, parsedLink))
    .filter((parsedLink) =>
      isPathLikeTerminalFileCandidate(parsedLink.path.text)
    )
    .map((parsedLink) => toTerminalFilePathCandidate(text, parsedLink));
}

export function parseTerminalFilePathFallbackCandidates(
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
      !/\s/.test(target) ||
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
    addFallbackCandidateFromPathToken({
      candidates,
      sourceText: target,
      sourceStartIndex: fullStartIndex + targetStartInMatch
    });
  }

  for (const match of text.matchAll(QUOTED_SPACE_PATH_RE)) {
    const fullMatch = match[0];
    const target = match[2];
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
    addFallbackCandidateFromPathToken({
      candidates,
      sourceText: target,
      sourceStartIndex: targetStartIndex
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
    addFallbackCandidateFromPathToken({
      candidates,
      sourceText: escapedTarget,
      sourceStartIndex: targetStartIndex,
      rawText: unescapePathText(escapedTarget)
    });
  }

  return candidates.sort((a, b) => a.startIndex - b.startIndex);
}

export function registerTerminalFileLinkProvider({
  terminal,
  getKeyboardPlatform,
  surfaceId,
  openFilePath,
  resolveFileLinks = (id, candidates) =>
    window.kmux.resolveTerminalFileLinks(id, candidates),
  activateFileLink = (request) => window.kmux.activateTerminalFileLink(request),
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
      void provideValidatedTerminalFileLinks({
        text,
        startLineIndex,
        terminal,
        surfaceId,
        openFilePath,
        activateFileLink,
        resolveFileLinks,
        getCwdForBufferLine,
        getKeyboardPlatform,
        activeDecorations,
        updateModifierFromEvent
      })
        .then((links) => {
          callback(links.length > 0 ? links : undefined);
        })
        .catch((error) => {
          console.warn("Failed to resolve terminal file links", error);
          callback(undefined);
        });
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

async function provideValidatedTerminalFileLinks({
  text,
  startLineIndex,
  terminal,
  surfaceId,
  openFilePath,
  activateFileLink,
  resolveFileLinks,
  getCwdForBufferLine,
  getKeyboardPlatform,
  activeDecorations,
  updateModifierFromEvent
}: {
  text: string;
  startLineIndex: number;
  terminal: Terminal;
  surfaceId: string;
  openFilePath: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  activateFileLink: (request: TerminalFileLinkActivationDto) => Promise<void>;
  resolveFileLinks: (
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult>;
  getCwdForBufferLine?: (bufferLineNumber: number) => string | undefined;
  getKeyboardPlatform: () => KeyboardShortcutPlatform;
  activeDecorations: Set<ILinkDecorations>;
  updateModifierFromEvent: (
    event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">
  ) => void;
}): Promise<ILink[]> {
  const primaryCandidates = toResolveCandidates({
    candidates: parseTerminalFilePathCandidates(text),
    idPrefix: "primary",
    startLineIndex,
    terminal,
    getCwdForBufferLine
  });
  let resolved = await resolveTerminalFileLinksSafely(
    resolveFileLinks,
    surfaceId,
    primaryCandidates
  );

  if (resolved.links.length === 0) {
    const fallbackCandidates = toResolveCandidates({
      candidates: parseTerminalFilePathFallbackCandidates(text),
      idPrefix: "fallback",
      startLineIndex,
      terminal,
      getCwdForBufferLine
    });
    if (fallbackCandidates.length > 0) {
      resolved = await resolveTerminalFileLinksSafely(
        resolveFileLinks,
        surfaceId,
        fallbackCandidates
      );
    }
  }

  return resolved.links
    .map((candidate) =>
      createTerminalFileLink({
        candidate,
        startLineIndex,
        terminal,
        surfaceId,
        openFilePath,
        activateFileLink,
        getKeyboardPlatform,
        activeDecorations,
        updateModifierFromEvent
      })
    )
    .filter((link): link is ILink => link !== null);
}

function toResolveCandidates({
  candidates,
  idPrefix,
  startLineIndex,
  terminal,
  getCwdForBufferLine
}: {
  candidates: TerminalFilePathCandidate[];
  idPrefix: string;
  startLineIndex: number;
  terminal: Terminal;
  getCwdForBufferLine?: (bufferLineNumber: number) => string | undefined;
}): TerminalFileLinkResolveCandidate[] {
  return candidates.map((candidate, index) => {
    const [startLine] = mapStringIndex(
      terminal,
      startLineIndex,
      0,
      candidate.startIndex
    );
    const baseCwd =
      startLine >= 0 ? getCwdForBufferLine?.(startLine) : undefined;
    return {
      id: `${idPrefix}-${index}`,
      rawPath: candidate.rawPath,
      linkText: candidate.linkText,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      hasSuffix: candidate.hasSuffix,
      ...(baseCwd !== undefined ? { baseCwd } : {})
    };
  });
}

async function resolveTerminalFileLinksSafely(
  resolveFileLinks: (
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult>,
  surfaceId: string,
  candidates: TerminalFileLinkResolveCandidate[]
): Promise<TerminalFileLinkResolveResult> {
  if (candidates.length === 0) {
    return { links: [] };
  }
  try {
    return await resolveFileLinks(surfaceId, candidates);
  } catch {
    return { links: [] };
  }
}

function createTerminalFileLink({
  candidate,
  startLineIndex,
  terminal,
  surfaceId,
  openFilePath,
  activateFileLink,
  getKeyboardPlatform,
  activeDecorations,
  updateModifierFromEvent
}: {
  candidate: TerminalFileLinkResolved;
  startLineIndex: number;
  terminal: Terminal;
  surfaceId: string;
  openFilePath: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  activateFileLink: (request: TerminalFileLinkActivationDto) => Promise<void>;
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

  const initialDecorations: ILinkDecorations = {
    pointerCursor: false,
    underline: false
  };
  let trackedDecorations: ILinkDecorations | null = null;
  let hovered = false;

  const trackDecorations = (nextDecorations: ILinkDecorations): void => {
    if (trackedDecorations === nextDecorations) {
      return;
    }
    if (trackedDecorations) {
      activeDecorations.delete(trackedDecorations);
    }
    trackedDecorations = nextDecorations;
    activeDecorations.add(nextDecorations);
  };

  const updateLinkDecorations = (active: boolean): void => {
    const currentDecorations = link.decorations ?? initialDecorations;
    trackDecorations(currentDecorations);
    currentDecorations.pointerCursor = active;
    currentDecorations.underline = active;
  };

  const leave = (): void => {
    hovered = false;
    if (trackedDecorations) {
      activeDecorations.delete(trackedDecorations);
      trackedDecorations.pointerCursor = false;
      trackedDecorations.underline = false;
      trackedDecorations = null;
    }
    if (link.decorations && link.decorations !== initialDecorations) {
      link.decorations.pointerCursor = false;
      link.decorations.underline = false;
    }
    initialDecorations.pointerCursor = false;
    initialDecorations.underline = false;
  };

  const link: ILink = {
    range: {
      start: { x: startColumn + 1, y: startLine + 1 },
      end: { x: endColumn, y: endLine + 1 }
    },
    text: candidate.linkText,
    decorations: initialDecorations,
    activate: (event) => {
      if (!isTerminalFileLinkModifierActive(event, getKeyboardPlatform())) {
        return;
      }
      const activation =
        candidate.activation === "markdown-preview"
          ? activateFileLink({
              sourceSurfaceId: surfaceId,
              rawPath: candidate.openRawPath,
              ...(candidate.baseCwd === undefined
                ? {}
                : { baseCwd: candidate.baseCwd })
            })
          : openFilePath(surfaceId, candidate.resolvedPath);
      void activation.catch((error) => {
        console.warn("Failed to open terminal file path", error);
      });
    },
    hover: (event) => {
      hovered = true;
      updateModifierFromEvent(event);
      updateLinkDecorations(
        isTerminalFileLinkModifierActive(event, getKeyboardPlatform())
      );
      queueMicrotask(() => {
        if (hovered) {
          updateLinkDecorations(
            isTerminalFileLinkModifierActive(event, getKeyboardPlatform())
          );
        }
      });
    },
    leave,
    dispose: leave
  };
  return link;
}

function toTerminalFilePathCandidate(
  text: string,
  parsedLink: ParsedTerminalLink
): TerminalFilePathCandidate {
  const startIndex = parsedLink.prefix?.index ?? parsedLink.path.index;
  const endIndex = parsedLink.suffix
    ? parsedLink.suffix.suffix.index + parsedLink.suffix.suffix.text.length
    : parsedLink.path.index + parsedLink.path.text.length;

  return {
    rawPath: parsedLink.path.text,
    linkText: text.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    hasSuffix: parsedLink.suffix !== undefined
  };
}

function addFallbackCandidateFromPathToken({
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
  const { rawPath, hasSuffix } = splitTerminalFilePathSuffix(rawText);
  if (!rawPath || !isPathLikeTerminalFileCandidate(rawPath)) {
    return;
  }

  candidates.push({
    rawPath,
    linkText: sourceText,
    startIndex: sourceStartIndex,
    endIndex: sourceStartIndex + sourceText.length,
    hasSuffix
  });
}

function splitTerminalFilePathSuffix(text: string): {
  rawPath: string;
  hasSuffix: boolean;
} {
  const suffixMatch = generateLinkSuffixRegex(true).exec(text);
  if (!suffixMatch || suffixMatch.index <= 0) {
    return { rawPath: text, hasSuffix: false };
  }

  return {
    rawPath: text.slice(0, suffixMatch.index),
    hasSuffix: true
  };
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

function isPathLikeTerminalFileCandidate(text: string): boolean {
  return (
    text.startsWith("/") ||
    text.startsWith("~/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.includes("/")
  );
}

function hasInnerBracketVariant(
  parsedLink: ParsedTerminalLink,
  parsedLinks: ParsedTerminalLink[]
): boolean {
  if (!parsedLink.suffix || !/[[(]/.test(parsedLink.path.text)) {
    return false;
  }

  return parsedLinks.some(
    (otherLink) =>
      otherLink !== parsedLink &&
      otherLink.suffix === parsedLink.suffix &&
      otherLink.path.index > parsedLink.path.index &&
      otherLink.path.index < parsedLink.path.index + parsedLink.path.text.length
  );
}

function isUnsupportedLocalPathMatch(
  line: string,
  parsedLink: ParsedTerminalLink
): boolean {
  const pathText = parsedLink.path.text;
  if (
    !pathText ||
    pathText.includes("\0") ||
    pathText.startsWith("//") ||
    URL_LIKE_PROTOCOL_RE.test(pathText)
  ) {
    return true;
  }

  const tokenPrefix = line.slice(0, parsedLink.path.index).split(/\s/).at(-1);
  return tokenPrefix?.includes("://") ?? false;
}

function detectLinks(line: string): ParsedTerminalLink[] {
  const results = detectLinksViaSuffix(line);
  const noSuffixPaths = detectPathsNoSuffix(line);
  binaryInsertList(results, noSuffixPaths);
  return results;
}

function binaryInsertList(
  list: ParsedTerminalLink[],
  newItems: ParsedTerminalLink[]
): void {
  if (list.length === 0) {
    list.push(...newItems);
  }
  for (const item of newItems) {
    binaryInsert(list, item, 0, list.length);
  }
}

function binaryInsert(
  list: ParsedTerminalLink[],
  newItem: ParsedTerminalLink,
  low: number,
  high: number
): void {
  if (list.length === 0) {
    list.push(newItem);
    return;
  }
  if (low > high) {
    return;
  }

  const mid = Math.floor((low + high) / 2);
  if (
    mid >= list.length ||
    (newItem.path.index < list[mid].path.index &&
      (mid === 0 || newItem.path.index > list[mid - 1].path.index))
  ) {
    if (
      mid >= list.length ||
      (newItem.path.index + newItem.path.text.length < list[mid].path.index &&
        (mid === 0 ||
          newItem.path.index >
            list[mid - 1].path.index + list[mid - 1].path.text.length))
    ) {
      list.splice(mid, 0, newItem);
    }
    return;
  }
  if (newItem.path.index > list[mid].path.index) {
    binaryInsert(list, newItem, mid + 1, high);
  } else {
    binaryInsert(list, newItem, low, mid - 1);
  }
}

function detectLinksViaSuffix(line: string): ParsedTerminalLink[] {
  const results: ParsedTerminalLink[] = [];
  const suffixes = detectLinkSuffixes(line);

  for (const suffix of suffixes) {
    const beforeSuffix = line.substring(0, suffix.suffix.index);
    const possiblePathMatch = beforeSuffix.match(
      LINK_WITH_SUFFIX_PATH_CHARACTERS
    );
    if (
      !possiblePathMatch ||
      possiblePathMatch.index === undefined ||
      !possiblePathMatch.groups?.path
    ) {
      continue;
    }

    let linkStartIndex = possiblePathMatch.index;
    let path = possiblePathMatch.groups.path;
    let prefix: LinkPartialRange | undefined;
    const prefixMatch = path.match(/^(?<prefix>['"]+)/);
    if (prefixMatch?.groups?.prefix) {
      prefix = {
        index: linkStartIndex,
        text: prefixMatch.groups.prefix
      };
      path = path.substring(prefix.text.length);

      if (path.trim().length === 0) {
        continue;
      }

      if (
        prefixMatch.groups.prefix.length > 1 &&
        suffix.suffix.text[0].match(/['"]/) &&
        prefixMatch.groups.prefix[prefixMatch.groups.prefix.length - 1] ===
          suffix.suffix.text[0]
      ) {
        const trimPrefixAmount = prefixMatch.groups.prefix.length - 1;
        prefix.index += trimPrefixAmount;
        prefix.text =
          prefixMatch.groups.prefix[prefixMatch.groups.prefix.length - 1];
        linkStartIndex += trimPrefixAmount;
      }
    }

    results.push({
      path: {
        index: linkStartIndex + (prefix?.text.length || 0),
        text: path
      },
      prefix,
      suffix
    });

    const openingBracketMatch = path.matchAll(/(?<bracket>[[(])(?![\])])/g);
    for (const match of openingBracketMatch) {
      const bracket = match.groups?.bracket;
      if (!bracket) {
        continue;
      }
      results.push({
        path: {
          index: linkStartIndex + (prefix?.text.length || 0) + match.index + 1,
          text: path.substring(match.index + bracket.length)
        },
        prefix,
        suffix
      });
    }
  }

  return results;
}

function detectLinkSuffixes(line: string): LinkSuffix[] {
  let match: RegExpExecArray | null;
  const results: LinkSuffix[] = [];
  const linkSuffixRegex = generateLinkSuffixRegex(false);
  while ((match = linkSuffixRegex.exec(line)) !== null) {
    const suffix = toLinkSuffix(match);
    if (suffix === null) {
      break;
    }
    results.push(suffix);
  }
  return results;
}

function toLinkSuffix(match: RegExpExecArray | null): LinkSuffix | null {
  const groups = match?.groups;
  if (!groups || match.length < 1) {
    return null;
  }
  return {
    row: parseIntOptional(groups.row0 || groups.row1 || groups.row2),
    col: parseIntOptional(groups.col0 || groups.col1 || groups.col2),
    rowEnd: parseIntOptional(
      groups.rowEnd0 || groups.rowEnd1 || groups.rowEnd2
    ),
    colEnd: parseIntOptional(
      groups.colEnd0 || groups.colEnd1 || groups.colEnd2
    ),
    suffix: { index: match.index, text: match[0] }
  };
}

function parseIntOptional(value: string | undefined): number | undefined {
  if (value === undefined) {
    return value;
  }
  return parseInt(value);
}

function generateLinkSuffixRegex(eolOnly: boolean): RegExp {
  let rowIndex = 0;
  let colIndex = 0;
  let rowEndIndex = 0;
  let colEndIndex = 0;
  const row = (): string => `(?<row${rowIndex++}>\\d+)`;
  const col = (): string => `(?<col${colIndex++}>\\d+)`;
  const rowEnd = (): string => `(?<rowEnd${rowEndIndex++}>\\d+)`;
  const colEnd = (): string => `(?<colEnd${colEndIndex++}>\\d+)`;
  const eolSuffix = eolOnly ? "$" : "";
  const lineAndColumnRegexClauses = [
    `(?::|#| |['"],|, )${row()}([:.]${col()}(?:-(?:${rowEnd()}\\.)?${colEnd()})?)?` +
      eolSuffix,
    `['"]?(?:,? |: ?| on )lines? ${row()}(?:-${rowEnd()})?(?:,? (?:col(?:umn)?|characters?) ${col()}(?:-${colEnd()})?)?` +
      eolSuffix,
    `:? ?[\\[\\(]${row()}(?:(?:, ?|:)${col()})?[\\]\\)]` + eolSuffix
  ];
  const suffixClause = lineAndColumnRegexClauses
    .join("|")
    .replace(/ /g, `[${"\u00A0"} ]`);
  return new RegExp(`(${suffixClause})`, eolOnly ? undefined : "g");
}

function detectPathsNoSuffix(line: string): ParsedTerminalLink[] {
  const results: ParsedTerminalLink[] = [];
  const regex = new RegExp(UNIX_LOCAL_LINK_CLAUSE, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    let linkText = match[0];
    let index = match.index;
    if (!linkText) {
      break;
    }

    if (
      ((line.startsWith("--- a/") || line.startsWith("+++ b/")) &&
        index === 4) ||
      (line.startsWith("diff --git") &&
        (linkText.startsWith("a/") || linkText.startsWith("b/")))
    ) {
      linkText = linkText.substring(2);
      index += 2;
    }

    results.push({
      path: {
        index,
        text: linkText
      },
      prefix: undefined,
      suffix: undefined
    });
  }

  return results;
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
