import { useEffect, useMemo, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type { KmuxSettings, SurfaceVm } from "@kmux/proto";
import {
  getTerminalSearchDecorations,
  getXtermTheme,
  normalizeShortcut
} from "@kmux/ui";
import type { ColorTheme } from "@kmux/ui";

import { Codicon } from "./Codicon";
import styles from "../styles/TerminalPane.module.css";

interface TerminalPaneProps {
  paneId: string;
  focused: boolean;
  surfaces: SurfaceVm[];
  activeSurfaceId: string;
  settings: KmuxSettings;
  colorTheme: ColorTheme;
  showSearch: boolean;
  focusTerminalRequest: { surfaceId: string; token: number } | null;
  onConsumeFocusTerminalRequest: (token: number) => void;
  onFocusPane: (paneId: string) => void;
  onFocusSurface: (surfaceId: string) => void;
  onCreateSurface: (paneId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
  onCloseOthers: (surfaceId: string) => void;
  onSplitRight: (paneId: string) => void;
  onSplitDown: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onToggleSearch: (surfaceId: string | null) => void;
}

type SearchMatch = {
  row: number;
  col: number;
  size: number;
  term: string;
};

type SearchAddonWithInternals = SearchAddon & {
  _resultTracker?: {
    searchResults?: SearchMatch[];
    selectedDecoration?: { match: SearchMatch };
  };
  _selectResult?: (
    result: SearchMatch,
    options: ReturnType<typeof getTerminalSearchDecorations>,
    noScroll?: boolean
  ) => boolean;
};

export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const activeSurface =
    props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ??
    props.surfaces[0];
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [copyMode, setCopyMode] = useState(false);
  const activeSurfaceRef = useRef<SurfaceVm | null>(activeSurface);
  const copyModeRef = useRef(copyMode);
  const queryRef = useRef(query);
  const showSearchRef = useRef(props.showSearch);
  const handledFocusRequestTokenRef = useRef<number | null>(null);
  const terminalTheme = useMemo(
    () => getXtermTheme(props.colorTheme),
    [props.colorTheme]
  );
  const terminalSearchDecorations = useMemo(
    () => getTerminalSearchDecorations(props.colorTheme),
    [props.colorTheme]
  );

  activeSurfaceRef.current = activeSurface;
  copyModeRef.current = copyMode;
  queryRef.current = query;
  showSearchRef.current = props.showSearch;

  function syncTerminalMetrics(terminal: Terminal | null): void {
    if (!containerRef.current || !terminal) {
      return;
    }
    containerRef.current.dataset.terminalViewportY = String(
      terminal.buffer.active.viewportY
    );
    containerRef.current.dataset.terminalBaseY = String(
      terminal.buffer.active.baseY
    );
  }

  function syncTerminalViewportBackground(): void {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.style.setProperty("background-color", terminalTheme.background);
    }
    const scrollable = container.querySelector<HTMLElement>(
      ".xterm-scrollable-element"
    );
    if (scrollable) {
      scrollable.style.setProperty("background-color", terminalTheme.background);
    }
  }

  function focusTerminalInput(): void {
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
    });
  }

  function toggleSearch(surfaceId: string | null): void {
    if (surfaceId) {
      setCopyMode(false);
    }
    props.onToggleSearch(surfaceId);
    if (!surfaceId) {
      focusTerminalInput();
    }
  }

  function stepSearch(direction: "next" | "prev"): void {
    const term = queryRef.current.trim();
    if (!term) {
      return;
    }

    const searchAddon = searchRef.current as SearchAddonWithInternals | null;
    const results = searchAddon?._resultTracker?.searchResults ?? [];
    const currentMatch = searchAddon?._resultTracker?.selectedDecoration?.match;

    if (
      results.length > 0 &&
      typeof searchAddon?._selectResult === "function"
    ) {
      const currentIndex = currentMatch
        ? results.findIndex(
            (result) =>
              result.row === currentMatch.row &&
              result.col === currentMatch.col &&
              result.size === currentMatch.size
          )
        : -1;
      const nextIndex =
        direction === "next"
          ? currentIndex >= 0
            ? (currentIndex + 1) % results.length
            : 0
          : currentIndex >= 0
            ? (currentIndex - 1 + results.length) % results.length
            : results.length - 1;
      const targetMatch = results[nextIndex];

      if (targetMatch) {
        searchAddon._selectResult(
          targetMatch,
          terminalSearchDecorations,
          false
        );
        return;
      }
    }

    if (direction === "next") {
      searchRef.current?.findNext(term, {
        decorations: terminalSearchDecorations
      });
      return;
    }
    searchRef.current?.findPrevious(term, {
      decorations: terminalSearchDecorations
    });
  }

  async function copyTerminalSelection(
    terminal: Terminal,
    fallbackSelectAll = false
  ): Promise<void> {
    if (fallbackSelectAll) {
      terminal.selectAll();
    }
    const selection = terminal.getSelection();
    if (!selection) {
      return;
    }
    window.kmux.writeClipboardText(selection);
  }

  async function pasteClipboard(surfaceId: string): Promise<void> {
    const text = window.kmux.readClipboardText();
    if (!text) {
      return;
    }
    await window.kmux.sendText(surfaceId, text);
  }

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const container = containerRef.current;

    const terminal = new Terminal({
      allowProposedApi: true,
      fontFamily: props.settings.terminalFontFamily,
      fontSize: props.settings.terminalFontSize,
      lineHeight: props.settings.terminalLineHeight || 1.0,
      fontWeight: "normal",
      cursorBlink: true,
      macOptionIsMeta: true,
      theme: terminalTheme
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    const handleTerminalShortcut = (event: KeyboardEvent) => {
      const currentSurface = activeSurfaceRef.current;
      if (!currentSurface) {
        return;
      }
      if (
        matchesBinding(event, props.settings.shortcuts["terminal.copyMode"])
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!copyModeRef.current && showSearchRef.current) {
          toggleSearch(null);
        }
        setCopyMode((current) => !current);
        return;
      }
      if (matchesBinding(event, props.settings.shortcuts["terminal.search"])) {
        event.preventDefault();
        event.stopPropagation();
        toggleSearch(showSearchRef.current ? null : currentSurface.id);
        return;
      }
      if (
        matchesBinding(event, props.settings.shortcuts["terminal.search.next"])
      ) {
        event.preventDefault();
        event.stopPropagation();
        stepSearch("next");
        return;
      }
      if (
        matchesBinding(event, props.settings.shortcuts["terminal.search.prev"])
      ) {
        event.preventDefault();
        event.stopPropagation();
        stepSearch("prev");
        return;
      }
      if (matchesBinding(event, props.settings.shortcuts["terminal.copy"])) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection(terminal, copyModeRef.current);
        return;
      }
      if (matchesBinding(event, props.settings.shortcuts["terminal.paste"])) {
        event.preventDefault();
        event.stopPropagation();
        if (!copyModeRef.current) {
          void pasteClipboard(currentSurface.id);
        }
        return;
      }
      if (copyModeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          setCopyMode(false);
          terminal.clearSelection();
          focusTerminalInput();
          return;
        }
        if (
          event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.key.toUpperCase() === "A"
        ) {
          terminal.selectAll();
          return;
        }
        switch (event.key) {
          case "ArrowUp":
            terminal.scrollLines(-1);
            syncTerminalMetrics(terminal);
            return;
          case "ArrowDown":
            terminal.scrollLines(1);
            syncTerminalMetrics(terminal);
            return;
          case "PageUp":
            terminal.scrollPages(-1);
            syncTerminalMetrics(terminal);
            return;
          case "PageDown":
            terminal.scrollPages(1);
            syncTerminalMetrics(terminal);
            return;
          case "Home":
            terminal.scrollToTop();
            syncTerminalMetrics(terminal);
            return;
          case "End":
            terminal.scrollToBottom();
            syncTerminalMetrics(terminal);
            return;
          default:
            return;
        }
      }
    };

    container.addEventListener("keydown", handleTerminalShortcut, true);
    terminal.open(container);
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    try {
      const webgl = new WebglAddon();
      terminal.loadAddon(webgl);
    } catch (e) {
      console.warn("Failed to load WebGL addon", e);
    }
    fit.fit();
    syncTerminalMetrics(terminal);

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        try {
          fit.fit();
          const currentSurface = activeSurfaceRef.current;
          if (currentSurface) {
            void window.kmux.resizeSurface(
              currentSurface.id,
              terminal.cols,
              terminal.rows
            );
          }
          syncTerminalMetrics(terminal);
        } catch {
          // ignore resize errors during unmount
        }
      }, 30);
    });
    resizeObserver.observe(containerRef.current);

    const disposeData = terminal.onData((data) => {
      const currentSurface = activeSurfaceRef.current;
      if (currentSurface) {
        void window.kmux.sendText(currentSurface.id, data);
      }
    });
    const disposeScroll = terminal.onScroll(() => {
      syncTerminalMetrics(terminal);
    });

    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    return () => {
      resizeObserver.disconnect();
      disposeData.dispose();
      disposeScroll.dispose();
      container.removeEventListener("keydown", handleTerminalShortcut, true);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [
    props.paneId,
    props.settings.terminalFontFamily,
    props.settings.terminalFontSize,
    props.settings.terminalLineHeight,
    terminalTheme
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeSurface) {
      return;
    }

    let mounted = true;
    void window.kmux.attachSurface(activeSurface.id).then((snapshot) => {
      if (!mounted || !snapshot || !terminalRef.current) {
        return;
      }
      terminalRef.current.reset();
      terminalRef.current.write(snapshot.vt);
      syncTerminalMetrics(terminalRef.current);
      fitRef.current?.fit();
      void window.kmux.resizeSurface(
        activeSurface.id,
        terminalRef.current.cols,
        terminalRef.current.rows
      );
    });

    const unsubscribe = window.kmux.subscribeTerminal((event) => {
      if (!terminalRef.current) {
        return;
      }
      if (
        event.type === "chunk" &&
        event.payload.surfaceId === activeSurface.id
      ) {
        terminalRef.current.write(event.payload.chunk);
        syncTerminalMetrics(terminalRef.current);
      }
      if (
        event.type === "exit" &&
        event.payload.surfaceId === activeSurface.id
      ) {
        terminalRef.current.writeln("");
        terminalRef.current.writeln(
          `\u001b[31mSession exited${typeof event.payload.exitCode === "number" ? ` (${event.payload.exitCode})` : ""}\u001b[0m`
        );
        syncTerminalMetrics(terminalRef.current);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
      void window.kmux.detachSurface(activeSurface.id);
    };
  }, [
    activeSurface?.id,
    props.settings.terminalFontFamily,
    props.settings.terminalFontSize,
    props.settings.terminalLineHeight
  ]);

  useEffect(() => {
    if (!props.showSearch || !query) {
      searchRef.current?.clearDecorations();
      terminalRef.current?.clearSelection();
      return;
    }
    searchRef.current?.findNext(query, {
      incremental: true,
      decorations: terminalSearchDecorations
    });
  }, [props.showSearch, query, terminalSearchDecorations]);

  useEffect(() => {
    if (!props.showSearch) {
      return;
    }
    setCopyMode(false);
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [props.showSearch]);

  useEffect(() => {
    setCopyMode(false);
  }, [activeSurface.id]);

  useEffect(() => {
    if (!props.focusTerminalRequest) {
      return;
    }
    if (
      handledFocusRequestTokenRef.current === props.focusTerminalRequest.token
    ) {
      return;
    }
    if (props.focusTerminalRequest.surfaceId !== activeSurface.id) {
      return;
    }
    handledFocusRequestTokenRef.current = props.focusTerminalRequest.token;
    focusTerminalInput();
    props.onConsumeFocusTerminalRequest(props.focusTerminalRequest.token);
  }, [activeSurface.id, props.focusTerminalRequest]);

  const tabs = useMemo(() => props.surfaces, [props.surfaces]);
  const showMeta = Boolean(
    activeSurface.cwd ||
    activeSurface.branch ||
    activeSurface.ports.length ||
    activeSurface.attention
  );

  return (
    <div
      className={styles.pane}
      data-pane-id={props.paneId}
      data-active-surface-id={activeSurface.id}
      data-focused={props.focused}
      data-copy-mode={copyMode}
      onMouseDown={() => props.onFocusPane(props.paneId)}
    >
      <div className={styles.header}>
        <div
          className={styles.tabs}
          role="tablist"
          aria-label={`Pane ${props.paneId} surfaces`}
          onWheel={(event) => {
            if (event.deltaY !== 0) {
              event.currentTarget.scrollBy({
                left: event.deltaY,
                behavior: "auto"
              });
            }
          }}
        >
          {tabs.map((surface) => {
            const selected = surface.id === props.activeSurfaceId;
            const active = selected && props.focused;
            return (
              <div
                key={surface.id}
                className={styles.tabItem}
                data-selected={selected}
                data-active={active}
                data-surface-id={surface.id}
              >
                <button
                  className={styles.tab}
                  role="tab"
                  aria-selected={surface.id === props.activeSurfaceId}
                  aria-label={`Focus surface ${surface.title}`}
                  onClick={() => props.onFocusSurface(surface.id)}
                  title={surface.cwd ?? surface.title}
                >
                  <span className={styles.tabIcon}>
                    <Codicon name="terminal" />
                  </span>
                  <span className={styles.tabLabel}>{surface.title}</span>
                  {surface.attention ? (
                    <span className={styles.attentionDot} />
                  ) : null}
                  {surface.unreadCount > 0 ? (
                    <span className={styles.badge}>
                      {surface.unreadCount}
                    </span>
                  ) : null}
                </button>
                <button
                  className={styles.tabClose}
                  aria-label={`Close tab ${surface.title}`}
                  title={`Close tab ${surface.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCloseSurface(surface.id);
                  }}
                >
                  <Codicon name="close" />
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.controls}>
          <button
            title="New tab"
            aria-label="Create new tab"
            onClick={() => props.onCreateSurface(props.paneId)}
          >
            <Codicon name="add" />
          </button>
          <button
            title="Split right"
            aria-label="Split active pane right"
            onClick={() => props.onSplitRight(props.paneId)}
          >
            <Codicon name="split-horizontal" />
          </button>
          <button
            title="Split down"
            aria-label="Split active pane down"
            onClick={() => props.onSplitDown(props.paneId)}
          >
            <Codicon name="split-vertical" />
          </button>
          <button
            title="Close pane"
            aria-label="Close active pane"
            onClick={() => props.onClosePane(props.paneId)}
          >
            <Codicon name="close" />
          </button>
        </div>
      </div>
      {props.showSearch ? (
        <div className={styles.searchBar}>
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Find in terminal"
            placeholder="Find in terminal"
            onKeyDown={(event) => {
              if (
                matchesBinding(
                  event,
                  props.settings.shortcuts["terminal.search.prev"]
                )
              ) {
                event.preventDefault();
                stepSearch("prev");
                return;
              }
              if (
                matchesBinding(
                  event,
                  props.settings.shortcuts["terminal.search.next"]
                )
              ) {
                event.preventDefault();
                stepSearch("next");
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                stepSearch("next");
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                toggleSearch(null);
              }
            }}
          />
          <button
            aria-label="Find previous result"
            onClick={() => stepSearch("prev")}
          >
            ↑
          </button>
          <button
            aria-label="Find next result"
            onClick={() => stepSearch("next")}
          >
            ↓
          </button>
          <button
            aria-label="Close terminal search"
            onClick={() => toggleSearch(null)}
          >
            Close
          </button>
        </div>
      ) : null}
      {copyMode ? (
        <div className={styles.copyModeBadge}>
          Copy mode: arrows/page keys scroll, Cmd+A selects all, Esc exits
        </div>
      ) : null}
      {showMeta ? (
        <div className={styles.meta}>
          {activeSurface.cwd ? (
            <span className={styles.metaLabel}>{activeSurface.cwd}</span>
          ) : null}
          {activeSurface.branch ? (
            <span className={styles.metaChip}>{activeSurface.branch}</span>
          ) : null}
          {activeSurface.ports.map((port) => (
            <span key={port} className={styles.metaChip}>
              {port}
            </span>
          ))}
          {activeSurface.attention ? (
            <span className={styles.attention}>attention</span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.terminal}>
        <div
          ref={containerRef}
          className={styles.terminalViewport}
          data-testid={`terminal-${activeSurface.id}`}
          aria-label={`Terminal surface ${activeSurface.title}`}
        />
      </div>
    </div>
  );
}

function matchesBinding(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
  >,
  binding: string | undefined
): boolean {
  if (!binding) {
    return false;
  }
  return binding === normalizeShortcut(event);
}
