import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type {
  KmuxSettings,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm,
  SurfaceVm
} from "@kmux/proto";
import {
  createXtermTheme,
  getTerminalSearchDecorations,
  normalizeShortcut
} from "@kmux/ui";
import type { ColorTheme } from "@kmux/ui";

import { Codicon } from "./Codicon";
import { SurfaceUsageAlertDot } from "./SurfaceUsageAlertDot";
import {
  applyPendingTerminalEnterRewrite,
  applyTerminalWebglPreference,
  pasteClipboardIntoTerminal,
  resolveTerminalEnterRewrite,
  shouldSwallowImeCompositionMetaKey,
  type PendingTerminalEnterRewrite,
  type DisposableAddon
} from "../terminalRenderer";
import { hydrateAttachedTerminal } from "../terminalAttachHydration";
import styles from "../styles/TerminalPane.module.css";
import { useSmoothnessRenderCounter } from "../hooks/useSmoothnessRenderCounter";
import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent
} from "../smoothnessProfile";
import { createSmoothnessProfileBucket } from "../../../shared/smoothnessProfileBucket";
import {
  canDropSurfaceTabOnPane,
  decodeSurfaceTabDragPayload,
  encodeSurfaceTabDragPayload,
  resolveSurfaceTabDropDirection,
  SURFACE_TAB_DRAG_MIME,
  SURFACE_TAB_DROP_PROMPT,
  type SurfaceTabDragPayload,
  type SurfaceTabDropDirection
} from "../surfaceTabDrag";

interface TerminalPaneProps {
  paneId: string;
  focused: boolean;
  surfaces: SurfaceVm[];
  activeSurfaceId: string;
  settings: KmuxSettings;
  terminalTypography: ResolvedTerminalTypographyVm;
  terminalTheme: ResolvedTerminalThemeVm;
  colorTheme: ColorTheme;
  showSearch: boolean;
  draggedSurfaceTab: SurfaceTabDragPayload | null;
  onFocusPane: (paneId: string) => void;
  onFocusSurface: (surfaceId: string) => void;
  onCreateSurface: (paneId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
  onCloseOthers: (surfaceId: string) => void;
  onMoveSurfaceToSplit: (
    surfaceId: string,
    targetPaneId: string,
    direction: SurfaceTabDropDirection
  ) => void;
  onSurfaceTabDragStart: (payload: SurfaceTabDragPayload) => void;
  onSurfaceTabDragEnd: () => void;
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

type PendingEnterRewrite = PendingTerminalEnterRewrite & {
  timeout: ReturnType<typeof setTimeout>;
};

const PROFILE_TERMINAL_WRITE_BUCKET_MIN_WRITES = 100;
const UTF8_ENCODER = new TextEncoder();

export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const activeSurface =
    props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ??
    props.surfaces[0];
  useSmoothnessRenderCounter("terminal-pane.render", () => ({
    paneId: props.paneId,
    activeSurfaceId: activeSurface?.id,
    surfaceCount: props.surfaces.length
  }));
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<DisposableAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingEnterRewriteRef = useRef<PendingEnterRewrite | null>(null);
  const [query, setQuery] = useState("");
  const [copyMode, setCopyMode] = useState(false);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [surfaceDropDirection, setSurfaceDropDirection] =
    useState<SurfaceTabDropDirection | null>(null);
  const activeSurfaceRef = useRef<SurfaceVm | null>(activeSurface);
  const copyModeRef = useRef(copyMode);
  const queryRef = useRef(query);
  const showSearchRef = useRef(props.showSearch);
  const shortcutsRef = useRef(props.settings.shortcuts);
  const onToggleSearchRef = useRef(props.onToggleSearch);
  const skipInitialTypographySyncRef = useRef(true);
  const skipInitialWebglSyncRef = useRef(true);
  const runtimeRecoveryPendingRef = useRef(false);
  const webglContextLossSubscriptionRef = useRef<{
    dispose(): void;
  } | null>(null);
  const resizeGenerationRef = useRef(0);
  // The xterm instance is pane-scoped, but PTY size is surface-scoped.
  const surfaceResizeDimensionsRef = useRef(
    new Map<string, { cols: number; rows: number }>()
  );
  const writeProfileBucketRef = useRef(
    createSmoothnessProfileBucket<{
      paneId: string;
      surfaceId: string;
      startedAt: number;
      writes: number;
      bytes: number;
      maxDurationMs: number;
      maxQueueDepth: number;
      queueDepth: number;
    }>({
      minEvents: PROFILE_TERMINAL_WRITE_BUCKET_MIN_WRITES,
      maxDurationMs: 1000,
      now: () => performance.now(),
      createDetails: (key, startedAt) => {
        const [paneId, surfaceId] = key.split("\u0000");
        return {
          paneId,
          surfaceId,
          startedAt,
          writes: 0,
          bytes: 0,
          maxDurationMs: 0,
          maxQueueDepth: 0,
          queueDepth: 0
        };
      },
      onFlush: (details, durationMs) => {
        recordRendererSmoothnessProfileEvent("terminal.write.bucket", {
          ...details,
          durationMs
        });
      }
    })
  );
  const terminalPaletteSignature = [
    props.terminalTheme.palette.background,
    props.terminalTheme.palette.foreground,
    props.terminalTheme.palette.cursor,
    props.terminalTheme.palette.cursorText,
    props.terminalTheme.palette.selectionBackground,
    props.terminalTheme.palette.selectionForeground,
    props.terminalTheme.palette.ansi.join("\u0000")
  ].join("\u0001");
  const terminalTheme = useMemo(
    () => createXtermTheme(props.terminalTheme.palette, props.colorTheme),
    [props.colorTheme, terminalPaletteSignature]
  );
  const terminalSearchDecorations = useMemo(
    () => getTerminalSearchDecorations(props.colorTheme),
    [props.colorTheme]
  );
  const searchDecorationsRef = useRef(terminalSearchDecorations);

  activeSurfaceRef.current = activeSurface;
  copyModeRef.current = copyMode;
  queryRef.current = query;
  showSearchRef.current = props.showSearch;
  shortcutsRef.current = props.settings.shortcuts;
  onToggleSearchRef.current = props.onToggleSearch;
  searchDecorationsRef.current = terminalSearchDecorations;

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
    containerRef.current.dataset.terminalBracketedPasteMode = String(
      terminal.modes.bracketedPasteMode
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
      scrollable.style.setProperty(
        "background-color",
        terminalTheme.background
      );
    }
  }

  function focusTerminalInput(): void {
    requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
  }

  function scheduleRuntimeRecovery(terminal: Terminal): void {
    if (
      runtimeRecoveryPendingRef.current ||
      terminalRef.current !== terminal
    ) {
      return;
    }

    runtimeRecoveryPendingRef.current = true;
    setRuntimeGeneration((current) => current + 1);
  }

  function bindWebglContextLoss(
    addon: DisposableAddon | null,
    terminal: Terminal
  ): void {
    webglContextLossSubscriptionRef.current?.dispose();
    webglContextLossSubscriptionRef.current = null;
    if (!(addon instanceof WebglAddon)) {
      return;
    }

    webglContextLossSubscriptionRef.current = addon.onContextLoss(() => {
      scheduleRuntimeRecovery(terminal);
    });
  }

  async function fitAndSyncTerminal(terminal: Terminal): Promise<void> {
    const fit = fitRef.current;
    if (!fit) {
      return;
    }
    const currentSurface = activeSurfaceRef.current;
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    const fitStartedAt = performance.now();
    const dims = fit.proposeDimensions();
    const fitDurationMs = performance.now() - fitStartedAt;
    const syncedSurfaceDimensions = currentSurface
      ? surfaceResizeDimensionsRef.current.get(currentSurface.id)
      : undefined;
    const terminalSizeChanged = Boolean(
      dims &&
        Number.isFinite(dims.cols) &&
        Number.isFinite(dims.rows) &&
        dims.cols > 0 &&
        dims.rows > 0 &&
        (dims.cols !== previousCols || dims.rows !== previousRows)
    );
    const surfaceSizeSynced = Boolean(
      currentSurface &&
        dims &&
        syncedSurfaceDimensions?.cols === dims.cols &&
        syncedSurfaceDimensions?.rows === dims.rows
    );
    const validDims = Boolean(
      dims &&
        Number.isFinite(dims.cols) &&
        Number.isFinite(dims.rows) &&
        dims.cols > 0 &&
        dims.rows > 0
    );
    recordRendererSmoothnessProfileEvent("terminal.fit", {
      paneId: props.paneId,
      surfaceId: currentSurface?.id,
      previousCols,
      previousRows,
      cols: dims?.cols ?? null,
      rows: dims?.rows ?? null,
      valid: validDims,
      changed: validDims ? terminalSizeChanged : false,
      surfaceSynced: validDims ? surfaceSizeSynced : false,
      durationMs: fitDurationMs
    });
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols <= 0 ||
      dims.rows <= 0
    ) {
      return;
    }
    if (!terminalSizeChanged && (!currentSurface || surfaceSizeSynced)) {
      syncTerminalMetrics(terminal);
      return;
    }
    const generation = ++resizeGenerationRef.current;
    let resizedSurfaceId: string | null = null;
    if (currentSurface) {
      const requestStartedAt = performance.now();
      recordRendererSmoothnessProfileEvent("terminal.resize.request", {
        paneId: props.paneId,
        surfaceId: currentSurface.id,
        generation,
        previousCols,
        previousRows,
        cols: dims.cols,
        rows: dims.rows
      });
      let failed = false;
      try {
        await window.kmux.resizeSurface(
          currentSurface.id,
          dims.cols,
          dims.rows
        );
        resizedSurfaceId = currentSurface.id;
      } catch {
        failed = true;
        // ignore; a superseding resize or teardown is already in flight
      } finally {
        recordRendererSmoothnessProfileEvent("terminal.resize.ack", {
          paneId: props.paneId,
          surfaceId: currentSurface.id,
          generation,
          previousCols,
          previousRows,
          cols: dims.cols,
          rows: dims.rows,
          failed,
          durationMs: performance.now() - requestStartedAt
        });
      }
    }
    if (
      generation !== resizeGenerationRef.current ||
      terminalRef.current !== terminal
    ) {
      return;
    }
    if (resizedSurfaceId) {
      surfaceResizeDimensionsRef.current.set(resizedSurfaceId, {
        cols: dims.cols,
        rows: dims.rows
      });
    }
    if (terminal.cols !== dims.cols || terminal.rows !== dims.rows) {
      const applyStartedAt = performance.now();
      try {
        terminal.resize(dims.cols, dims.rows);
        const applyEndedAt = performance.now();
        recordRendererSmoothnessProfileEvent("terminal.resize.apply", {
          paneId: props.paneId,
          surfaceId: currentSurface?.id,
          generation,
          previousCols,
          previousRows,
          cols: dims.cols,
          rows: dims.rows,
          durationMs: applyEndedAt - applyStartedAt
        });
        requestAnimationFrame(() => {
          if (terminalRef.current !== terminal) {
            return;
          }
          recordRendererSmoothnessProfileEvent("terminal.reflow", {
            paneId: props.paneId,
            surfaceId: currentSurface?.id,
            generation,
            cols: dims.cols,
            rows: dims.rows,
            viewportY: terminal.buffer.active.viewportY,
            baseY: terminal.buffer.active.baseY,
            durationMs: performance.now() - applyEndedAt
          });
        });
      } catch {
        recordRendererSmoothnessProfileEvent("terminal.resize.apply", {
          paneId: props.paneId,
          surfaceId: currentSurface?.id,
          generation,
          previousCols,
          previousRows,
          cols: dims.cols,
          rows: dims.rows,
          failed: true,
          durationMs: performance.now() - applyStartedAt
        });
        // terminal may have been disposed mid-await
        return;
      }
    }
    syncTerminalMetrics(terminal);
  }

  async function waitForTerminalFonts(): Promise<void> {
    if (typeof document === "undefined" || !("fonts" in document)) {
      return;
    }
    if (document.fonts.status === "loaded") {
      return;
    }
    await document.fonts.ready;
  }

  function matchesTerminalShortcut(
    event: Pick<
      KeyboardEvent,
      "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
    >,
    actionId: string
  ): boolean {
    return matchesBinding(event, shortcutsRef.current[actionId]);
  }

  function writeTerminal(
    terminal: Terminal,
    data: string,
    afterWrite?: () => void,
    profileSurfaceId = activeSurfaceRef.current?.id
  ): void {
    if (!isRendererSmoothnessProfileEnabled() || !profileSurfaceId) {
      terminal.write(data, () => {
        syncTerminalMetrics(terminal);
        afterWrite?.();
      });
      return;
    }
    const bucketKey = `${props.paneId}\u0000${profileSurfaceId}`;
    const startedAt = performance.now();
    writeProfileBucketRef.current.update(bucketKey, (profile) => {
      profile.writes += 1;
      profile.bytes += UTF8_ENCODER.encode(data).byteLength;
      profile.queueDepth += 1;
      profile.maxQueueDepth = Math.max(
        profile.maxQueueDepth,
        profile.queueDepth
      );
    });
    terminal.write(data, () => {
      const now = performance.now();
      writeProfileBucketRef.current.record(bucketKey, (profile) => {
        profile.queueDepth = Math.max(0, profile.queueDepth - 1);
        profile.maxDurationMs = Math.max(
          profile.maxDurationMs,
          now - startedAt
        );
      });
      syncTerminalMetrics(terminal);
      afterWrite?.();
    });
  }

  function toggleSearch(surfaceId: string | null): void {
    if (surfaceId) {
      setCopyMode(false);
    }
    onToggleSearchRef.current(surfaceId);
    if (!surfaceId) {
      focusTerminalInput();
    }
  }

  function stepSearch(direction: "next" | "prev"): void {
    const term = queryRef.current.trim();
    if (!term) {
      return;
    }
    const decorations = searchDecorationsRef.current;

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
        searchAddon._selectResult(targetMatch, decorations, false);
        return;
      }
    }

    if (direction === "next") {
      searchRef.current?.findNext(term, {
        decorations
      });
      return;
    }
    searchRef.current?.findPrevious(term, {
      decorations
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

  function pasteClipboard(terminal: Terminal): void {
    pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => window.kmux.readClipboardText()
    });
  }

  useEffect(() => {
    return () => {
      writeProfileBucketRef.current.flushAll();
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    runtimeRecoveryPendingRef.current = false;
    const container = containerRef.current;

    const terminal = new Terminal({
      allowProposedApi: true,
      fontFamily: props.terminalTypography.resolvedFontFamily,
      fontSize: props.settings.terminalTypography.fontSize,
      lineHeight: props.settings.terminalTypography.lineHeight || 1.0,
      fontWeight: 400,
      cursorBlink: true,
      macOptionIsMeta: false,
      scrollback: 5000,
      minimumContrastRatio: props.terminalTheme.minimumContrastRatio,
      theme: terminalTheme
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode11 = new Unicode11Addon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";
    const clearPendingEnterRewrite = () => {
      const pending = pendingEnterRewriteRef.current;
      if (pending) {
        clearTimeout(pending.timeout);
        pendingEnterRewriteRef.current = null;
      }
    };
    const queueEnterRewrite = (
      event: KeyboardEvent,
      surfaceId: string
    ): void => {
      const rewrite = resolveTerminalEnterRewrite(event);
      if (!rewrite) {
        return;
      }
      clearPendingEnterRewrite();
      const timeout = setTimeout(() => {
        const pending = pendingEnterRewriteRef.current;
        if (
          pending?.surfaceId === surfaceId &&
          pending.sequence === rewrite.sequence
        ) {
          pendingEnterRewriteRef.current = null;
        }
      }, 100);
      pendingEnterRewriteRef.current = {
        surfaceId,
        sequence: rewrite.sequence,
        timeout
      };
    };
    const handleTerminalShortcut = (event: KeyboardEvent) => {
      const currentSurface = activeSurfaceRef.current;
      if (!currentSurface) {
        return;
      }
      queueEnterRewrite(event, currentSurface.id);
      if (matchesTerminalShortcut(event, "terminal.copyMode")) {
        event.preventDefault();
        event.stopPropagation();
        if (!copyModeRef.current && showSearchRef.current) {
          toggleSearch(null);
        }
        setCopyMode((current) => !current);
        return;
      }
      if (matchesTerminalShortcut(event, "terminal.search")) {
        event.preventDefault();
        event.stopPropagation();
        toggleSearch(showSearchRef.current ? null : currentSurface.id);
        return;
      }
      if (matchesTerminalShortcut(event, "terminal.search.next")) {
        event.preventDefault();
        event.stopPropagation();
        stepSearch("next");
        return;
      }
      if (matchesTerminalShortcut(event, "terminal.search.prev")) {
        event.preventDefault();
        event.stopPropagation();
        stepSearch("prev");
        return;
      }
      if (matchesTerminalShortcut(event, "terminal.copy")) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection(terminal, copyModeRef.current);
        return;
      }
      if (matchesTerminalShortcut(event, "terminal.paste")) {
        event.preventDefault();
        event.stopPropagation();
        if (!copyModeRef.current) {
          pasteClipboard(terminal);
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
    const imeCompositionRef = { current: false };
    const handleCompositionStart = (): void => {
      imeCompositionRef.current = true;
    };
    const handleCompositionEnd = (): void => {
      imeCompositionRef.current = false;
    };
    const xtermTextarea = terminal.textarea;
    if (xtermTextarea) {
      xtermTextarea.addEventListener("compositionstart", handleCompositionStart);
      xtermTextarea.addEventListener("compositionend", handleCompositionEnd);
    }
    terminal.attachCustomKeyEventHandler((event) =>
      !shouldSwallowImeCompositionMetaKey(event, imeCompositionRef.current)
    );
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    webglAddonRef.current = applyTerminalWebglPreference({
      terminal,
      currentAddon: webglAddonRef.current,
      useWebgl: props.settings.terminalUseWebgl,
      createAddon: () => new WebglAddon(),
      onLoadError: (error) => {
        console.warn(
          "Failed to load the WebGL terminal renderer; falling back to the default renderer",
          error
        );
      }
    });
    bindWebglContextLoss(webglAddonRef.current, terminal);
    void fitAndSyncTerminal(terminal);

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        void fitAndSyncTerminal(terminal).catch(() => {
          // ignore resize errors during unmount
        });
      }, 30);
    });
    resizeObserver.observe(containerRef.current);

    const disposeData = terminal.onData((data) => {
      const currentSurface = activeSurfaceRef.current;
      if (currentSurface) {
        const rewrite = applyPendingTerminalEnterRewrite(
          currentSurface.id,
          data,
          pendingEnterRewriteRef.current
        );
        if (rewrite.clearPending) {
          clearPendingEnterRewrite();
        }
        void window.kmux.sendText(currentSurface.id, rewrite.data);
      }
    });
    const disposeWriteParsed = terminal.onWriteParsed(() => {
      syncTerminalMetrics(terminal);
    });
    const disposeScroll = terminal.onScroll(() => {
      syncTerminalMetrics(terminal);
    });

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = null;
      }
      disposeData.dispose();
      disposeWriteParsed.dispose();
      disposeScroll.dispose();
      container.removeEventListener("keydown", handleTerminalShortcut, true);
      if (xtermTextarea) {
        xtermTextarea.removeEventListener(
          "compositionstart",
          handleCompositionStart
        );
        xtermTextarea.removeEventListener(
          "compositionend",
          handleCompositionEnd
        );
      }
      clearPendingEnterRewrite();
      webglContextLossSubscriptionRef.current?.dispose();
      webglContextLossSubscriptionRef.current = null;
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [props.paneId, runtimeGeneration]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (skipInitialTypographySyncRef.current) {
      skipInitialTypographySyncRef.current = false;
      return;
    }

    terminal.options.fontFamily = props.terminalTypography.resolvedFontFamily;
    terminal.options.fontSize = props.settings.terminalTypography.fontSize;
    terminal.options.lineHeight =
      props.settings.terminalTypography.lineHeight || 1.0;
    terminal.options.minimumContrastRatio =
      props.terminalTheme.minimumContrastRatio;
    terminal.options.theme = { ...terminalTheme };
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    void fitAndSyncTerminal(terminal);
  }, [
    props.terminalTypography.resolvedFontFamily,
    props.settings.terminalTypography.fontSize,
    props.settings.terminalTypography.lineHeight,
    props.terminalTheme.minimumContrastRatio,
    terminalTheme
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (skipInitialWebglSyncRef.current) {
      skipInitialWebglSyncRef.current = false;
      return;
    }

    webglAddonRef.current = applyTerminalWebglPreference({
      terminal,
      currentAddon: webglAddonRef.current,
      useWebgl: props.settings.terminalUseWebgl,
      createAddon: () => new WebglAddon(),
      onLoadError: (error) => {
        console.warn(
          "Failed to load the WebGL terminal renderer; falling back to the default renderer",
          error
        );
      }
    });
    bindWebglContextLoss(webglAddonRef.current, terminal);
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    void fitAndSyncTerminal(terminal);
  }, [props.settings.terminalUseWebgl, runtimeGeneration]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeSurface) {
      return;
    }

    let mounted = true;

    const unsubscribe = window.kmux.subscribeTerminal((event) => {
      if (!terminalRef.current) {
        return;
      }
      if (
        event.type === "chunk" &&
        event.payload.surfaceId === activeSurface.id
      ) {
        writeTerminal(
          terminalRef.current,
          event.payload.chunk,
          undefined,
          event.payload.surfaceId
        );
      }
      if (
        event.type === "exit" &&
        event.payload.surfaceId === activeSurface.id
      ) {
        writeTerminal(
          terminalRef.current,
          `\r\n\u001b[31mSession exited${typeof event.payload.exitCode === "number" ? ` (${event.payload.exitCode})` : ""}\u001b[0m\r\n`,
          undefined,
          event.payload.surfaceId
        );
      }
    });

    void (async () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      await hydrateAttachedTerminal({
        terminal,
        isMounted: () => mounted,
        isTerminalActive: (candidate) => terminalRef.current === candidate,
        waitForTerminalFonts,
        fitAndSyncTerminal,
        attachSurface: () => window.kmux.attachSurface(activeSurface.id),
        writeTerminal: (terminal, data, afterWrite) =>
          writeTerminal(terminal, data, afterWrite, activeSurface.id)
      });
    })();

    return () => {
      mounted = false;
      unsubscribe();
      void window.kmux.detachSurface(activeSurface.id);
    };
  }, [activeSurface?.id, props.paneId, runtimeGeneration]);

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
    const pending = pendingEnterRewriteRef.current;
    if (pending) {
      clearTimeout(pending.timeout);
      pendingEnterRewriteRef.current = null;
    }
  }, [activeSurface.id]);

  useEffect(() => {
    if (!props.draggedSurfaceTab) {
      setSurfaceDropDirection(null);
    }
  }, [props.draggedSurfaceTab]);

  useEffect(() => {
    if (!props.focused || props.showSearch) {
      return;
    }
    const activeElement = document.activeElement;
    const editingOutsideTerminal =
      activeElement instanceof HTMLInputElement ||
      (activeElement instanceof HTMLTextAreaElement &&
        !activeElement.classList.contains("xterm-helper-textarea")) ||
      (activeElement instanceof HTMLElement && activeElement.isContentEditable);
    if (editingOutsideTerminal) {
      return;
    }
    focusTerminalInput();
  }, [activeSurface.id, props.focused, props.showSearch, runtimeGeneration]);

  const tabs = useMemo(() => props.surfaces, [props.surfaces]);
  const showMeta = Boolean(
    activeSurface.cwd ||
    activeSurface.branch ||
    activeSurface.ports.length ||
    activeSurface.attention
  );
  const showSurfaceDropPrompt = Boolean(
    props.draggedSurfaceTab &&
      canDropSurfaceTabOnPane(
        props.draggedSurfaceTab,
        props.paneId,
        props.surfaces.length
      )
  );

  const resolveDropDirection = (
    event: DragEvent<HTMLDivElement>
  ): SurfaceTabDropDirection | null =>
    resolveSurfaceTabDropDirection(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY
    );

  const currentDropPayload = (
    event: DragEvent<HTMLDivElement>
  ): SurfaceTabDragPayload | null =>
    props.draggedSurfaceTab ??
    decodeSurfaceTabDragPayload(
      event.dataTransfer.getData(SURFACE_TAB_DRAG_MIME)
    );

  const handleSurfaceDragOver = (event: DragEvent<HTMLDivElement>): void => {
    const payload = props.draggedSurfaceTab;
    if (!payload) {
      return;
    }
    const direction = resolveDropDirection(event);
    if (
      !direction ||
      !canDropSurfaceTabOnPane(payload, props.paneId, props.surfaces.length)
    ) {
      setSurfaceDropDirection(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setSurfaceDropDirection((current) =>
      current === direction ? current : direction
    );
  };

  const handleSurfaceDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setSurfaceDropDirection(null);
  };

  const handleSurfaceDrop = (event: DragEvent<HTMLDivElement>): void => {
    const payload = currentDropPayload(event);
    const direction = resolveDropDirection(event);
    setSurfaceDropDirection(null);
    props.onSurfaceTabDragEnd();
    if (
      !payload ||
      !direction ||
      !canDropSurfaceTabOnPane(payload, props.paneId, props.surfaces.length)
    ) {
      return;
    }
    event.preventDefault();
    props.onMoveSurfaceToSplit(payload.surfaceId, props.paneId, direction);
  };

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
                  draggable
                  onDragStart={(event) => {
                    const payload = {
                      surfaceId: surface.id,
                      sourcePaneId: props.paneId
                    };
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      SURFACE_TAB_DRAG_MIME,
                      encodeSurfaceTabDragPayload(payload)
                    );
                    event.dataTransfer.setData("text/plain", surface.id);
                    props.onSurfaceTabDragStart(payload);
                  }}
                  onDragEnd={() => {
                    setSurfaceDropDirection(null);
                    props.onSurfaceTabDragEnd();
                  }}
                  title={surface.cwd ?? surface.title}
                >
                  <span className={styles.tabIcon}>
                    <Codicon name="terminal" />
                  </span>
                  <span className={styles.tabLabel}>{surface.title}</span>
                  <SurfaceUsageAlertDot
                    fallbackVisible={surface.attention || surface.unreadCount > 0}
                  />
                  {surface.unreadCount > 0 ? (
                    <span
                      className={styles.badge}
                      data-testid={`surface-unread-badge-${surface.id}`}
                    >
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
        <div className={styles.headerTrailing}>
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
        </div>
      ) : null}
      <div
        className={styles.terminal}
        data-surface-drop-direction={surfaceDropDirection ?? undefined}
        onDragOver={handleSurfaceDragOver}
        onDragLeave={handleSurfaceDragLeave}
        onDrop={handleSurfaceDrop}
      >
        {showSurfaceDropPrompt ? (
          <div className={styles.surfaceDropPrompt} role="status">
            {SURFACE_TAB_DROP_PROMPT}
          </div>
        ) : null}
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
