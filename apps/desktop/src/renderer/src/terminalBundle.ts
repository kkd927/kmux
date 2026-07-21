import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalInputDiagnosticKind, Uint64 } from "@kmux/proto";

import {
  createTerminalLineCwdTracker,
  type TerminalLineCwdTracker
} from "./terminalLineCwdTracker";
import { SupervisorTerminalQueryAuthorityAddon } from "./supervisorTerminalQueryAuthority";

export interface TerminalDiagnosticMetadata {
  hydratedSequence: Uint64 | null;
  renderedSequence: Uint64 | null;
  attachAvailableSequence: Uint64 | null;
  renderGeneration: number;
  /** All *At fields below use high-resolution Unix epoch milliseconds. */
  lastOnRenderAt: number | null;
  lastOnRenderSequence: Uint64 | null;
  lastScreenOnRenderAt: number | null;
  lastScreenOnRenderSequence: Uint64 | null;
  lastReceiveAt: number | null;
  lastReceiveSequence: Uint64 | null;
  lastScreenReceiveAt: number | null;
  lastScreenReceiveSequence: Uint64 | null;
  lastWriteAt: number | null;
  lastWriteSequence: Uint64 | null;
  lastScreenWriteAt: number | null;
  lastScreenWriteSequence: Uint64 | null;
  lastParsedAt: number | null;
  lastParsedSequence: Uint64 | null;
  lastScreenParsedAt: number | null;
  lastScreenParsedSequence: Uint64 | null;
  lastInputAt: number | null;
  lastInputKind: TerminalInputDiagnosticKind | null;
  lastInputBytes: number | null;
  lastFocusEventAt: number | null;
  lastFocusEvent: string | null;
}

export type TerminalHostElement = HTMLDivElement & {
  __kmuxTerminal?: Terminal;
  __kmuxTerminalDiagnostics?: TerminalDiagnosticMetadata;
};

/**
 * Everything whose lifetime is tied to one concrete xterm parser/widget.
 * Surface attachment and cache metadata deliberately live outside this bundle
 * so a checkpoint can replace the widget without replacing its capability.
 */
export interface TerminalBundle {
  host: TerminalHostElement;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  unicode11: Unicode11Addon;
  webLinks: WebLinksAddon;
  fileLinks: IDisposable;
  lineCwdTrimListener: IDisposable;
  lineCwds: TerminalLineCwdTracker;
}

export interface CreateTerminalBundleOptions {
  createTerminal(): Terminal;
  onWebLink(uri: string): void;
  registerFileLinks(
    terminal: Terminal,
    lineCwds: TerminalLineCwdTracker
  ): IDisposable;
  registerBufferTrimListener(
    terminal: Terminal,
    onTrim: (amount: number) => void
  ): IDisposable;
}

/** Shared by initial mount and offscreen checkpoint hydration. */
export function createTerminalBundle({
  createTerminal,
  onWebLink,
  registerFileLinks,
  registerBufferTrimListener
}: CreateTerminalBundleOptions): TerminalBundle {
  const host = document.createElement("div") as TerminalHostElement;
  host.style.cssText = "width:100%;height:100%;min-height:0;overflow:hidden;";
  const terminal = createTerminal();
  host.__kmuxTerminal = terminal;
  host.__kmuxTerminalDiagnostics = {
    hydratedSequence: null,
    renderedSequence: null,
    attachAvailableSequence: null,
    renderGeneration: 0,
    lastOnRenderAt: null,
    lastOnRenderSequence: null,
    lastScreenOnRenderAt: null,
    lastScreenOnRenderSequence: null,
    lastReceiveAt: null,
    lastReceiveSequence: null,
    lastScreenReceiveAt: null,
    lastScreenReceiveSequence: null,
    lastWriteAt: null,
    lastWriteSequence: null,
    lastScreenWriteAt: null,
    lastScreenWriteSequence: null,
    lastParsedAt: null,
    lastParsedSequence: null,
    lastScreenParsedAt: null,
    lastScreenParsedSequence: null,
    lastInputAt: null,
    lastInputKind: null,
    lastInputBytes: null,
    lastFocusEventAt: null,
    lastFocusEvent: null
  };

  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  const webLinks = new WebLinksAddon((_event, uri) => {
    onWebLink(uri);
  });
  const lineCwds = createTerminalLineCwdTracker();
  const lineCwdTrimListener = registerBufferTrimListener(terminal, (amount) => {
    lineCwds.handleTrim(amount);
  });

  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(unicode11);
  terminal.loadAddon(webLinks);
  const fileLinks = registerFileLinks(terminal, lineCwds);
  // Load last so these public parser handlers run before xterm's built-ins.
  // The supervisor answers model-state queries from its authoritative buffer;
  // the renderer still owns browser-only color, pixel, focus, and mouse data.
  terminal.loadAddon(new SupervisorTerminalQueryAuthorityAddon());
  terminal.unicode.activeVersion = "11";
  terminal.open(host);

  return {
    host,
    terminal,
    fit,
    search,
    unicode11,
    webLinks,
    fileLinks,
    lineCwdTrimListener,
    lineCwds
  };
}

export function disposeTerminalBundle(bundle: TerminalBundle): void {
  if (bundle.host.parentNode) {
    bundle.host.parentNode.removeChild(bundle.host);
  }
  bundle.fileLinks.dispose();
  bundle.lineCwdTrimListener.dispose();
  bundle.terminal.dispose();
}
