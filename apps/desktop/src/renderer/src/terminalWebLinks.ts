import type {
  IDisposable,
  ILink,
  ITerminalAddon,
  Terminal
} from "@xterm/xterm";

import { getTerminalWrappedLineWindow } from "./terminalWrappedLines";

// Matches http:// and https:// URLs while excluding trailing punctuation and
// enclosing brackets (matching @xterm/addon-web-links's strictUrlRegex).
const STRICT_URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;

export type TerminalWebLinkHandler = (event: MouseEvent, uri: string) => void;

export class TerminalWebLinksAddon implements ITerminalAddon {
  private linkProvider: IDisposable | undefined;

  constructor(private readonly handler: TerminalWebLinkHandler) {}

  public activate(terminal: Terminal): void {
    this.linkProvider = registerTerminalWebLinkProvider(terminal, this.handler);
  }

  public dispose(): void {
    this.linkProvider?.dispose();
    this.linkProvider = undefined;
  }
}

export function registerTerminalWebLinkProvider(
  terminal: Terminal,
  activate: TerminalWebLinkHandler
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const links = computeTerminalWebLinks(
        bufferLineNumber,
        terminal,
        activate
      );
      callback(links.length > 0 ? links : undefined);
    }
  });
}

export function computeTerminalWebLinks(
  bufferLineNumber: number,
  terminal: Terminal,
  activate: TerminalWebLinkHandler
): ILink[] {
  const anchorLineIndex = bufferLineNumber - 1;
  const window = getTerminalWrappedLineWindow(anchorLineIndex, terminal, {
    mode: "web"
  });
  if (!window || window.text.length === 0) {
    return [];
  }

  const regex = new RegExp(STRICT_URL_REGEX.source, "g");
  const result: ILink[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(window.text)) !== null) {
    const text = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + text.length;

    if (!window.intersectsLine(startIndex, endIndex, anchorLineIndex)) {
      continue;
    }
    if (!isValidWebUrl(text)) {
      continue;
    }

    const range = window.mapRange(startIndex, endIndex);
    if (!range) {
      continue;
    }

    result.push({
      range,
      text,
      activate
    });
  }

  return result;
}

function isValidWebUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return urlString
      .toLocaleLowerCase()
      .startsWith(parsedBase.toLocaleLowerCase());
  } catch {
    return false;
  }
}
