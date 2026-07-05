import {
  type DragEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable, type ILinkHandler } from "@xterm/xterm";

import type {
  CreateImageAttachmentPayload,
  ImageAttachmentSource,
  KmuxSettings,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm,
  SurfaceVm
} from "@kmux/proto";
import {
  getTerminalSearchDecorations,
  normalizeShortcut,
  normalizeShortcutBinding
} from "@kmux/ui";
import type { ColorTheme } from "@kmux/ui";

import { Codicon } from "./Codicon";
import { SurfaceUsageAlertDot } from "./SurfaceUsageAlertDot";
import {
  applyPendingTerminalEnterRewrite,
  countSupportedImageFiles,
  createTerminalImeDuplicateCommitGuard,
  createTerminalPaneXtermTheme,
  formatDroppedFilePathsForTerminal,
  isSupportedImageMimeType,
  pasteClipboardIntoTerminal,
  resolveTerminalEnterRewrite,
  sanitizeTerminalPasteText,
  shouldDeferTerminalShortcutToIme,
  shouldUseImagePaste,
  shouldSuppressXtermDuringIme,
  type PendingTerminalEnterRewrite
} from "../terminalRenderer";
import {
  hydrateAttachedTerminal,
  reattachPreservedTerminal
} from "../terminalAttachHydration";
import {
  createTerminalLineCwdTracker,
  type TerminalLineCwdRange,
  type TerminalLineCwdTracker
} from "../terminalLineCwdTracker";
import { registerTerminalFileLinkProvider } from "../terminalFileLinks";
import {
  installTerminalForegroundFit,
  type TerminalForegroundFitController
} from "../terminalForegroundFit";
import { createTerminalReplayVisibility } from "../terminalReplayVisibility";
import {
  pauseTerminalRenderer,
  resumeAndRefreshTerminalRenderer
} from "../terminalRenderRefresh";
import { createTerminalChunkBatcher } from "../terminalChunkBatcher";
import * as terminalInstanceStore from "../terminalInstanceStore";
import { resizeTerminalKeepingBottomAnchor } from "../terminalResizeAnchor";
import { createTerminalResizeSync } from "../terminalResizeSync";
import { createTerminalDividerFitThrottle } from "../terminalDividerFitThrottle";
import {
  isPaneDividerDragActive,
  subscribePaneDividerDrag
} from "../paneDividerDrag";
import styles from "../styles/TerminalPane.module.css";
import { useSmoothnessRenderCounter } from "../hooks/useSmoothnessRenderCounter";
import {
  formatShortcutLabel,
  type ShortcutLabelStyle
} from "../shortcutLabels";
import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent
} from "../smoothnessProfile";
import { createSmoothnessProfileBucket } from "../../../shared/smoothnessProfileBucket";
import {
  isReservedSystemChordBinding,
  type KeyChord,
  type KeyboardShortcutPlatform
} from "../../../shared/platform/keyboardPolicy";
import { TERMINAL_LIVE_SCROLLBACK_LINES } from "../../../shared/terminalConfig";
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
import {
  buildSurfaceContextMenuEntries,
  type SurfaceContextAction,
  type SurfaceContextMenuEntry
} from "../../../shared/surfaceContextMenu";

export interface TerminalFocusRequest {
  surfaceId: string;
  token: number;
}

interface TerminalPaneProps {
  paneId: string;
  focused: boolean;
  active: boolean;
  surfaces: SurfaceVm[];
  activeSurfaceId: string;
  settings: KmuxSettings;
  reservedSystemChords: KeyChord[];
  keyboardPlatform: KeyboardShortcutPlatform;
  shortcutLabelStyle: ShortcutLabelStyle;
  copyModeSelectAllShortcut: KeyChord;
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
  onRestartSurface: (surfaceId: string) => void;
  onToggleSearch: (surfaceId: string | null) => void;
  focusRequest?: TerminalFocusRequest | null;
}

type TerminalSnapshotWithCwdRanges = {
  sequence: number | null;
  cwdRanges?: TerminalLineCwdRange[];
};

type OpenTerminalFilePathWithBaseCwd = (
  surfaceId: string,
  rawPath: string,
  baseCwd?: string
) => Promise<void>;

type TerminalWithPrivateTrimEvent = Terminal & {
  _core?: {
    _bufferService?: {
      buffer?: {
        lines?: {
          onTrim?: (listener: (amount: number) => void) => IDisposable;
        };
      };
    };
  };
};

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

type TerminalDiagnosticMetadata = {
  hydratedSequence: number | null;
  renderedSequence: number | null;
};

type TerminalDiagnosticElement = HTMLDivElement & {
  __kmuxTerminal?: Terminal;
  __kmuxTerminalDiagnostics?: TerminalDiagnosticMetadata;
};

type TerminalWriter = (
  terminal: Terminal,
  data: string,
  afterWrite?: () => void,
  profileSurfaceId?: string
) => boolean;

type TerminalFitAndSync = (
  terminal: Terminal,
  options?: { fit?: FitAddon | null; surfaceId?: string | null }
) => Promise<void>;

type TerminalRenderSinkContext = {
  terminal: Terminal;
  fit: FitAddon;
  surfaceId: string;
};

type SurfaceContextMenuState = {
  surfaceId: string;
  x: number;
  y: number;
  items: SurfaceContextMenuEntry[];
};

const PROFILE_TERMINAL_WRITE_BUCKET_MIN_WRITES = 100;
const UTF8_ENCODER = new TextEncoder();
const TERMINAL_WRITE_CALLBACK_TIMEOUT_MS = 10_000;
// Skip-ahead safety valve: agent CLI output tops out around 100-250KB/s, so
// this backlog is only reachable when a pathological flood (yes, cat of a
// huge file) outruns xterm parsing. Recovery re-hydrates from a fresh
// snapshot instead of replaying the backlog, trading flood scrollback
// (snapshots restore TERMINAL_RESTORE_SCROLLBACK_LINES) for a live screen.
const TERMINAL_LIVE_CHUNK_BACKLOG_LIMIT_CHARS = 8_000_000;
const EXTERNAL_TERMINAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);
const INACTIVE_WORKSPACE_RENDER_PAUSE_DELAY_MS = 2000;

function openExternalTerminalLink(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.warn("Ignoring invalid terminal link", rawUrl);
    return;
  }
  if (!EXTERNAL_TERMINAL_LINK_PROTOCOLS.has(url.protocol)) {
    console.warn("Ignoring unsupported terminal link protocol", url.protocol);
    return;
  }
  void window.kmux.openExternalUrl(url.toString()).catch((error) => {
    console.warn("Failed to open terminal link", error);
  });
}

const terminalLinkHandler: ILinkHandler = {
  allowNonHttpProtocols: false,
  activate: (_event, text) => openExternalTerminalLink(text)
};

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
  const lineCwdsRef = useRef<TerminalLineCwdTracker | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const surfaceWrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingEnterRewriteRef = useRef<PendingEnterRewrite | null>(null);
  const [query, setQuery] = useState("");
  const [copyMode, setCopyMode] = useState(false);
  const [surfaceDropDirection, setSurfaceDropDirection] =
    useState<SurfaceTabDropDirection | null>(null);
  const [imageDropActive, setImageDropActive] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<string | null>(null);
  const [surfaceContextMenu, setSurfaceContextMenu] =
    useState<SurfaceContextMenuState | null>(null);
  const surfaceContextMenuRef = useRef<HTMLDivElement>(null!);
  const activeSurfaceRef = useRef<SurfaceVm | null>(activeSurface);
  const paneActiveRef = useRef(props.active);
  const paneFocusedRef = useRef(props.focused);
  const previousPaneActiveRef = useRef(props.active);
  const foregroundFitRef = useRef<TerminalForegroundFitController | null>(null);
  const terminalInstanceKey = activeSurface.id;
  const previousActiveSurfaceIdRef = useRef(activeSurface.id);
  const copyModeRef = useRef(copyMode);
  const queryRef = useRef(query);
  const showSearchRef = useRef(props.showSearch);
  const shortcutsRef = useRef(props.settings.shortcuts);
  const reservedSystemChordsRef = useRef(props.reservedSystemChords);
  const keyboardPlatformRef = useRef(props.keyboardPlatform);
  const copyModeSelectAllShortcutRef = useRef(props.copyModeSelectAllShortcut);
  const onToggleSearchRef = useRef(props.onToggleSearch);
  const surfaceContextActionRef = useRef<
    (surfaceId: string, action: SurfaceContextAction) => void
  >(() => {});
  const surfaceSessionIdsRef = useRef(new Map<string, string>());
  const skipInitialTypographySyncRef = useRef(true);
  const attachmentStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const resizeGenerationRef = useRef(0);
  const resizeSyncRef = useRef<ReturnType<
    typeof createTerminalResizeSync
  > | null>(null);
  const writeTerminalRef = useRef<TerminalWriter>(() => false);
  const fitAndSyncTerminalRef = useRef<TerminalFitAndSync>(async () => {});
  const renderSinkContextRef = useRef<TerminalRenderSinkContext | null>(null);
  const pendingRendererRefreshFrameRef = useRef<number | null>(null);
  const pendingRendererRefreshesRef = useRef(new Map<Terminal, string>());
  const inactiveRendererPauseTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactiveRendererPauseReadyRef = useRef(false);
  // The xterm instance is surface-scoped, but PTY size is still synced from
  // the pane that currently displays the surface.
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
  const linuxImeDuplicateCommitGuardRef = useRef(
    createTerminalImeDuplicateCommitGuard()
  );
  const isPastingRef = useRef(false);

  function updateTerminalDiagnostics(
    surfaceId: string,
    terminal: Terminal,
    patch: Partial<TerminalDiagnosticMetadata>
  ): void {
    const elements = [
      containerRef.current as TerminalDiagnosticElement | null,
      surfaceWrapperRefs.current.get(surfaceId) as
        | TerminalDiagnosticElement
        | undefined
    ];
    for (const element of elements) {
      if (!element || element.__kmuxTerminal !== terminal) {
        continue;
      }
      const diagnostics = {
        hydratedSequence:
          element.__kmuxTerminalDiagnostics?.hydratedSequence ?? null,
        renderedSequence:
          element.__kmuxTerminalDiagnostics?.renderedSequence ?? null,
        ...patch
      };
      element.__kmuxTerminalDiagnostics = diagnostics;
      if (diagnostics.hydratedSequence === null) {
        delete element.dataset.terminalHydratedSequence;
      } else {
        element.dataset.terminalHydratedSequence = String(
          diagnostics.hydratedSequence
        );
      }
      if (diagnostics.renderedSequence === null) {
        delete element.dataset.terminalRenderedSequence;
      } else {
        element.dataset.terminalRenderedSequence = String(
          diagnostics.renderedSequence
        );
      }
    }
  }

  function clearWrapperTerminalDiagnostics(
    wrapper: ParentNode | null,
    terminal: Terminal
  ): void {
    const diagnosticWrapper = wrapper as TerminalDiagnosticElement | null;
    if (diagnosticWrapper?.__kmuxTerminal !== terminal) {
      return;
    }
    delete diagnosticWrapper.__kmuxTerminal;
    delete diagnosticWrapper.__kmuxTerminalDiagnostics;
    delete diagnosticWrapper.dataset.terminalHydratedSequence;
    delete diagnosticWrapper.dataset.terminalRenderedSequence;
    delete diagnosticWrapper.dataset.terminalViewportY;
    delete diagnosticWrapper.dataset.terminalBaseY;
    delete diagnosticWrapper.dataset.terminalBracketedPasteMode;
  }

  function attachTerminalHostToCurrentWrapper(
    surfaceId: string,
    terminal: Terminal,
    host: HTMLDivElement
  ): boolean {
    const wrapper = surfaceWrapperRefs.current.get(surfaceId);
    if (!wrapper) {
      return false;
    }

    const previousParent = host.parentNode;
    const moved = previousParent !== wrapper;
    if (moved) {
      clearWrapperTerminalDiagnostics(previousParent, terminal);
      wrapper.appendChild(host);
    }

    const diagnosticWrapper = wrapper as TerminalDiagnosticElement;
    diagnosticWrapper.__kmuxTerminal = terminal;
    diagnosticWrapper.__kmuxTerminalDiagnostics = (
      host as TerminalDiagnosticElement
    ).__kmuxTerminalDiagnostics;
    syncSurfaceTerminalMetrics(surfaceId, terminal);
    refreshVisibleSurfaceRenderer(surfaceId, terminal, { force: true });
    return moved;
  }

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
    () =>
      createTerminalPaneXtermTheme(
        props.terminalTheme.palette,
        props.colorTheme
      ),
    [props.colorTheme, terminalPaletteSignature]
  );
  const terminalSearchDecorations = useMemo(
    () => getTerminalSearchDecorations(props.colorTheme),
    [props.colorTheme]
  );
  const searchDecorationsRef = useRef(terminalSearchDecorations);

  activeSurfaceRef.current = activeSurface;
  paneActiveRef.current = props.active;
  paneFocusedRef.current = props.focused;
  copyModeRef.current = copyMode;
  queryRef.current = query;
  showSearchRef.current = props.showSearch;
  shortcutsRef.current = props.settings.shortcuts;
  reservedSystemChordsRef.current = props.reservedSystemChords;
  keyboardPlatformRef.current = props.keyboardPlatform;
  copyModeSelectAllShortcutRef.current = props.copyModeSelectAllShortcut;
  onToggleSearchRef.current = props.onToggleSearch;
  searchDecorationsRef.current = terminalSearchDecorations;
  if (!resizeSyncRef.current) {
    resizeSyncRef.current = createTerminalResizeSync({
      sendResize: (surfaceId, attachId, cols, rows, gestureActive) =>
        window.kmux.resizeSurface(
          surfaceId,
          attachId,
          cols,
          rows,
          gestureActive
        )
    });
  }

  function syncTerminalMetrics(terminal: Terminal | null): void {
    if (!activeSurface || !terminal) {
      return;
    }
    syncSurfaceTerminalMetrics(activeSurface.id, terminal);
  }

  function syncSurfaceTerminalMetrics(
    surfaceId: string,
    terminal: Terminal
  ): void {
    const wrapper = surfaceWrapperRefs.current.get(surfaceId);
    if (!wrapper) {
      return;
    }
    wrapper.dataset.terminalViewportY = String(
      terminal.buffer.active.viewportY
    );
    wrapper.dataset.terminalBaseY = String(terminal.buffer.active.baseY);
    wrapper.dataset.terminalBracketedPasteMode = String(
      terminal.modes.bracketedPasteMode
    );
  }

  function sessionIdForSurface(surfaceId: string): string | null {
    if (activeSurfaceRef.current?.id === surfaceId) {
      return activeSurfaceRef.current.sessionId;
    }
    return surfaceSessionIdsRef.current.get(surfaceId) ?? null;
  }

  function readyAttachIdForSurface(surfaceId: string): string | null {
    const sessionId = sessionIdForSurface(surfaceId);
    if (!sessionId) {
      return null;
    }
    return terminalInstanceStore.getReadyAttachId(surfaceId, sessionId);
  }

  function isVisibleSurfaceRenderer(surfaceId: string): boolean {
    if (!paneActiveRef.current) {
      return false;
    }
    const wrapper = surfaceWrapperRefs.current.get(surfaceId);
    if (wrapper?.dataset.active !== "true") {
      return false;
    }
    return true;
  }

  function refreshVisibleSurfaceRenderer(
    surfaceId: string,
    terminal: Terminal,
    options: { force?: boolean } = {}
  ): void {
    if (!isVisibleSurfaceRenderer(surfaceId)) {
      return;
    }
    resumeAndRefreshTerminalRenderer(terminal, options);
  }

  function scheduleVisibleSurfaceRendererRefresh(
    surfaceId: string,
    terminal: Terminal
  ): void {
    if (!isVisibleSurfaceRenderer(surfaceId)) {
      reassertInactiveWorkspaceRendererPause(terminal);
      return;
    }
    pendingRendererRefreshesRef.current.set(terminal, surfaceId);
    if (pendingRendererRefreshFrameRef.current !== null) {
      return;
    }
    pendingRendererRefreshFrameRef.current = requestAnimationFrame(() => {
      pendingRendererRefreshFrameRef.current = null;
      const pendingRefreshes = Array.from(
        pendingRendererRefreshesRef.current.entries()
      );
      pendingRendererRefreshesRef.current.clear();
      for (const [pendingTerminal, pendingSurfaceId] of pendingRefreshes) {
        // Non-forced: a running renderer already repaints dirty rows on its
        // own; this only resumes a paused renderer so streaming output does
        // not force a full-viewport re-render every animation frame.
        refreshVisibleSurfaceRenderer(pendingSurfaceId, pendingTerminal);
      }
    });
  }

  function cancelInactiveRendererPause(): void {
    if (inactiveRendererPauseTimerRef.current === null) {
      inactiveRendererPauseReadyRef.current = false;
      return;
    }
    clearTimeout(inactiveRendererPauseTimerRef.current);
    inactiveRendererPauseTimerRef.current = null;
    inactiveRendererPauseReadyRef.current = false;
  }

  function scheduleInactiveWorkspaceRendererPause(terminal: Terminal): void {
    cancelInactiveRendererPause();
    inactiveRendererPauseTimerRef.current = setTimeout(() => {
      inactiveRendererPauseTimerRef.current = null;
      if (paneActiveRef.current || terminalRef.current !== terminal) {
        inactiveRendererPauseReadyRef.current = false;
        return;
      }
      inactiveRendererPauseReadyRef.current = true;
      pauseTerminalRenderer(terminal);
    }, INACTIVE_WORKSPACE_RENDER_PAUSE_DELAY_MS);
  }

  function reassertInactiveWorkspaceRendererPause(terminal: Terminal): void {
    if (
      paneActiveRef.current ||
      !inactiveRendererPauseReadyRef.current ||
      terminalRef.current !== terminal
    ) {
      return;
    }
    pauseTerminalRenderer(terminal);
  }

  useEffect(() => {
    return () => {
      if (pendingRendererRefreshFrameRef.current !== null) {
        cancelAnimationFrame(pendingRendererRefreshFrameRef.current);
        pendingRendererRefreshFrameRef.current = null;
      }
      pendingRendererRefreshesRef.current.clear();
      cancelInactiveRendererPause();
    };
  }, []);

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

  function focusTerminalInput(
    surfaceId = activeSurfaceRef.current?.id ?? null
  ): void {
    const focusActiveTerminal = (remainingAttempts: number): void => {
      if (!surfaceId || !shouldFocusActiveTerminal(surfaceId)) {
        return;
      }
      const terminal = terminalRef.current;
      const textarea = terminal?.textarea ?? null;
      if (!terminal || !textarea) {
        if (remainingAttempts <= 0) {
          return;
        }
        requestAnimationFrame(() => {
          focusActiveTerminal(remainingAttempts - 1);
        });
        return;
      }
      window.focus();
      terminal.focus();
      textarea.focus({ preventScroll: true });
      if (remainingAttempts <= 0 || document.activeElement === textarea) {
        return;
      }
      requestAnimationFrame(() => {
        focusActiveTerminal(remainingAttempts - 1);
      });
    };

    focusActiveTerminal(30);
  }

  function isEditingOutsideTerminal(): boolean {
    const activeElement = document.activeElement;
    if (!activeElement || activeElement === document.body) {
      return false;
    }
    return !(
      activeElement instanceof HTMLTextAreaElement &&
      activeElement.classList.contains("xterm-helper-textarea")
    );
  }

  function shouldFocusActiveTerminal(surfaceId: string): boolean {
    return (
      paneFocusedRef.current &&
      paneActiveRef.current &&
      activeSurfaceRef.current?.id === surfaceId &&
      !showSearchRef.current &&
      !isEditingOutsideTerminal()
    );
  }

  function showAttachmentStatus(message: string): void {
    if (attachmentStatusTimerRef.current) {
      clearTimeout(attachmentStatusTimerRef.current);
      attachmentStatusTimerRef.current = null;
    }
    setAttachmentStatus(message);
    attachmentStatusTimerRef.current = setTimeout(() => {
      setAttachmentStatus(null);
      attachmentStatusTimerRef.current = null;
    }, 2600);
  }

  async function attachImagePayloads(
    terminal: Terminal,
    surfaceId: string,
    payloads: CreateImageAttachmentPayload[]
  ): Promise<boolean> {
    if (!payloads.length) {
      return false;
    }
    try {
      const result = await window.kmux.createImageAttachments(
        surfaceId,
        payloads
      );
      if (result.promptText) {
        const sanitizedPromptText = sanitizeTerminalPasteText(
          result.promptText
        );
        if (sanitizedPromptText) {
          terminal.paste(sanitizedPromptText);
        }
      }
      showAttachmentStatus(result.message);
      focusTerminalInput();
      return true;
    } catch (error) {
      console.warn("Failed to attach image to terminal prompt", error);
      showAttachmentStatus("Could not attach image");
      focusTerminalInput();
      return true;
    }
  }

  function setSurfaceWrapperRef(
    surfaceId: string,
    node: HTMLDivElement | null
  ): void {
    if (node) {
      surfaceWrapperRefs.current.set(surfaceId, node);
      return;
    }
    surfaceWrapperRefs.current.delete(surfaceId);
  }

  function applyTerminalResize(
    terminal: Terminal,
    input: {
      cols: number;
      rows: number;
      surfaceId: string | null;
      generation: number;
      previousCols: number;
      previousRows: number;
    }
  ): boolean {
    const { cols, rows, surfaceId, generation, previousCols, previousRows } =
      input;
    if (terminal.cols === cols && terminal.rows === rows) {
      return false;
    }

    const applyStartedAt = performance.now();
    try {
      resizeTerminalKeepingBottomAnchor(terminal, cols, rows);
      const applyEndedAt = performance.now();
      recordRendererSmoothnessProfileEvent("terminal.resize.apply", {
        paneId: props.paneId,
        surfaceId,
        generation,
        previousCols,
        previousRows,
        cols,
        rows,
        durationMs: applyEndedAt - applyStartedAt
      });
      requestAnimationFrame(() => {
        if (terminalRef.current !== terminal) {
          return;
        }
        recordRendererSmoothnessProfileEvent("terminal.reflow", {
          paneId: props.paneId,
          surfaceId,
          generation,
          cols,
          rows,
          viewportY: terminal.buffer.active.viewportY,
          baseY: terminal.buffer.active.baseY,
          durationMs: performance.now() - applyEndedAt
        });
      });
      return true;
    } catch {
      recordRendererSmoothnessProfileEvent("terminal.resize.apply", {
        paneId: props.paneId,
        surfaceId,
        generation,
        previousCols,
        previousRows,
        cols,
        rows,
        failed: true,
        durationMs: performance.now() - applyStartedAt
      });
      return false;
    }
  }

  async function fitAndSyncTerminal(
    terminal: Terminal,
    options: { fit?: FitAddon | null; surfaceId?: string | null } = {}
  ): Promise<void> {
    const fit = options.fit ?? fitRef.current;
    if (!fit) {
      return;
    }
    const surfaceId = options.surfaceId ?? activeSurfaceRef.current?.id ?? null;
    const requiresActiveSurface = !options.surfaceId;
    if (surfaceId) {
      refreshVisibleSurfaceRenderer(surfaceId, terminal, { force: true });
    }
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    const fitStartedAt = performance.now();
    const dims = fit.proposeDimensions();
    const fitDurationMs = performance.now() - fitStartedAt;
    const syncedSurfaceDimensions = surfaceId
      ? surfaceResizeDimensionsRef.current.get(surfaceId)
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
      surfaceId &&
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
      surfaceId,
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
    if (!terminalSizeChanged && (!surfaceId || surfaceSizeSynced)) {
      if (surfaceId) {
        syncSurfaceTerminalMetrics(surfaceId, terminal);
      } else {
        syncTerminalMetrics(terminal);
      }
      return;
    }
    const generation = ++resizeGenerationRef.current;
    const readyAttachId = surfaceId ? readyAttachIdForSurface(surfaceId) : null;
    const streamReady = Boolean(surfaceId && readyAttachId);
    const attachId = streamReady ? readyAttachId : null;
    if (!streamReady) {
      const resized = applyTerminalResize(terminal, {
        cols: dims.cols,
        rows: dims.rows,
        surfaceId,
        generation,
        previousCols,
        previousRows
      });
      if (!resized && terminalSizeChanged) {
        return;
      }
      if (surfaceId) {
        syncSurfaceTerminalMetrics(surfaceId, terminal);
      } else {
        syncTerminalMetrics(terminal);
      }
    }
    if (!surfaceId) {
      return;
    }

    const requestStartedAt = performance.now();
    recordRendererSmoothnessProfileEvent("terminal.resize.request", {
      paneId: props.paneId,
      surfaceId,
      generation,
      previousCols,
      previousRows,
      cols: dims.cols,
      rows: dims.rows
    });
    const resizeResult = await resizeSyncRef.current?.request({
      surfaceId,
      attachId,
      generation,
      cols: dims.cols,
      rows: dims.rows,
      gestureActive: isPaneDividerDragActive()
    });
    recordRendererSmoothnessProfileEvent("terminal.resize.ack", {
      paneId: props.paneId,
      surfaceId,
      generation,
      previousCols,
      previousRows,
      cols: dims.cols,
      rows: dims.rows,
      failed: resizeResult?.status === "failed",
      superseded: resizeResult?.status === "superseded",
      durationMs: performance.now() - requestStartedAt
    });
    if (
      resizeResult?.status !== "synced" ||
      generation !== resizeGenerationRef.current ||
      (requiresActiveSurface && terminalRef.current !== terminal) ||
      (requiresActiveSurface &&
        activeSurfaceRef.current?.id !== resizeResult.surfaceId)
    ) {
      return;
    }
    if (
      terminal.cols === resizeResult.cols &&
      terminal.rows === resizeResult.rows
    ) {
      surfaceResizeDimensionsRef.current.set(resizeResult.surfaceId, {
        cols: resizeResult.cols,
        rows: resizeResult.rows
      });
      syncSurfaceTerminalMetrics(resizeResult.surfaceId, terminal);
    }
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
    return matchesBinding(
      event,
      shortcutsRef.current[actionId],
      reservedSystemChordsRef.current
    );
  }

  function writeTerminal(
    terminal: Terminal,
    data: string,
    afterWrite?: () => void,
    profileSurfaceId = activeSurfaceRef.current?.id
  ): boolean {
    if (!isRendererSmoothnessProfileEnabled() || !profileSurfaceId) {
      terminal.write(data, () => {
        if (profileSurfaceId) {
          syncSurfaceTerminalMetrics(profileSurfaceId, terminal);
          scheduleVisibleSurfaceRendererRefresh(profileSurfaceId, terminal);
        } else {
          syncTerminalMetrics(terminal);
        }
        afterWrite?.();
      });
      return true;
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
      syncSurfaceTerminalMetrics(profileSurfaceId, terminal);
      scheduleVisibleSurfaceRendererRefresh(profileSurfaceId, terminal);
      afterWrite?.();
    });
    return true;
  }

  writeTerminalRef.current = writeTerminal;
  fitAndSyncTerminalRef.current = fitAndSyncTerminal;

  function registerTerminalBufferTrimHandler(
    terminal: Terminal,
    onTrim: (amount: number) => void
  ): IDisposable {
    const lines = (terminal as TerminalWithPrivateTrimEvent)._core
      ?._bufferService?.buffer?.lines;
    return lines?.onTrim?.(onTrim) ?? { dispose() {} };
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
    await window.kmux.writeClipboardText(selection);
  }

  async function pasteClipboard(
    terminal: Terminal,
    surfaceId: string
  ): Promise<void> {
    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      surfaceId,
      readClipboardText: () => window.kmux.readClipboardText(),
      readClipboardImages: () => window.kmux.readClipboardImages(),
      createImageAttachments: window.kmux.createImageAttachments,
      onImageAttachmentStatus: showAttachmentStatus,
      onImageAttachmentError: (error) => {
        console.warn("Failed to attach image to terminal prompt", error);
      }
    });
    if (didPaste) {
      focusTerminalInput();
    }
  }

  async function canPasteIntoSurface(): Promise<boolean> {
    if (copyModeRef.current || showSearchRef.current) {
      return false;
    }
    try {
      return await window.kmux.hasPasteableClipboardContent();
    } catch (error) {
      console.warn("Failed to inspect clipboard for surface menu", error);
      return false;
    }
  }

  async function surfaceMenuContextFor(surface: SurfaceVm) {
    const surfaceIsActive = activeSurfaceRef.current?.id === surface.id;
    const canPaste = surfaceIsActive ? await canPasteIntoSurface() : false;
    return {
      canCopy: surfaceIsActive && Boolean(terminalRef.current?.getSelection()),
      canPaste,
      canRestart: surface.sessionState !== "pending",
      sessionState: surface.sessionState,
      settings: {
        shortcuts: props.settings.shortcuts
      }
    };
  }

  function closeSurfaceContextMenu(): void {
    setSurfaceContextMenu(null);
  }

  function runSurfaceContextAction(
    surfaceId: string,
    action: SurfaceContextAction
  ): void {
    const targetSurface = props.surfaces.find(
      (surface) => surface.id === surfaceId
    );
    if (!targetSurface) {
      return;
    }
    closeSurfaceContextMenu();
    props.onFocusPane(props.paneId);
    props.onFocusSurface(surfaceId);

    const terminal = terminalRef.current;
    switch (action) {
      case "copy":
        if (terminal) {
          void copyTerminalSelection(terminal, false);
        }
        return;
      case "paste":
        if (terminal && !copyModeRef.current && !showSearchRef.current) {
          void pasteClipboard(terminal, surfaceId);
        }
        return;
      case "split-horizontally":
        props.onSplitDown(props.paneId);
        return;
      case "split-vertically":
        props.onSplitRight(props.paneId);
        return;
      case "restart-session":
        if (targetSurface.sessionState !== "pending") {
          props.onRestartSurface(surfaceId);
        }
        return;
      case "capture-diagnostics":
        void window.kmux.captureSurfaceDiagnostics(surfaceId).catch((error) => {
          console.warn("Failed to capture surface diagnostics", error);
        });
        return;
    }
  }

  surfaceContextActionRef.current = runSurfaceContextAction;

  useEffect(() => {
    return () => {
      writeProfileBucketRef.current.flushAll();
      if (attachmentStatusTimerRef.current) {
        clearTimeout(attachmentStatusTimerRef.current);
        attachmentStatusTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return window.kmux.subscribeSurfaceContextMenuAction((event) => {
      if (!props.surfaces.some((surface) => surface.id === event.surfaceId)) {
        return;
      }
      surfaceContextActionRef.current(event.surfaceId, event.action);
    });
  }, [props.surfaces]);

  useEffect(() => {
    if (!surfaceContextMenu) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      surfaceContextMenuRef.current
        ?.querySelector<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)'
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [surfaceContextMenu]);

  useLayoutEffect(() => {
    const wrapper = surfaceWrapperRefs.current.get(activeSurface.id);
    if (!wrapper) {
      return;
    }
    // Keep the terminal surface alive across tab switches and pane split
    // remounts. Full-screen TUIs keep mouse tracking state inside xterm, so
    // only release this instance when the surface itself is removed.
    const { instance } = terminalInstanceStore.acquire(
      terminalInstanceKey,
      () => {
        const host = document.createElement("div") as TerminalDiagnosticElement;
        host.style.cssText =
          "width:100%;height:100%;min-height:0;overflow:hidden;";
        const terminal = new Terminal({
          allowProposedApi: true,
          fontFamily: props.terminalTypography.resolvedFontFamily,
          fontSize: props.settings.terminalTypography.fontSize,
          lineHeight: props.settings.terminalTypography.lineHeight || 1.0,
          fontWeight: 400,
          cursorBlink: true,
          macOptionIsMeta: false,
          macOptionClickForcesSelection: props.keyboardPlatform === "darwin",
          altClickMovesCursor: false,
          rightClickSelectsWord: false,
          scrollback: TERMINAL_LIVE_SCROLLBACK_LINES,
          minimumContrastRatio: props.terminalTheme.minimumContrastRatio,
          theme: terminalTheme,
          linkHandler: terminalLinkHandler
        });
        host.__kmuxTerminal = terminal;
        host.__kmuxTerminalDiagnostics = {
          hydratedSequence: null,
          renderedSequence: null
        };
        const fit = new FitAddon();
        const search = new SearchAddon();
        const unicode11 = new Unicode11Addon();
        const webLinks = new WebLinksAddon((_event, uri) => {
          openExternalTerminalLink(uri);
        });
        const lineCwds = createTerminalLineCwdTracker();
        const lineCwdTrimListener = registerTerminalBufferTrimHandler(
          terminal,
          (amount) => {
            lineCwds.handleTrim(amount);
          }
        );
        terminal.loadAddon(fit);
        terminal.loadAddon(search);
        terminal.loadAddon(unicode11);
        terminal.loadAddon(webLinks);
        const openTerminalFilePath = window.kmux
          .openTerminalFilePath as OpenTerminalFilePathWithBaseCwd;
        const fileLinks = registerTerminalFileLinkProvider({
          terminal,
          getKeyboardPlatform: () => keyboardPlatformRef.current,
          surfaceId: activeSurface.id,
          openFilePath: (surfaceId, rawPath, baseCwd) =>
            openTerminalFilePath(surfaceId, rawPath, baseCwd),
          getCwdForBufferLine: (bufferLineNumber) =>
            lineCwds.getCwdForLine(bufferLineNumber)
        });
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
          lineCwds,
          lastHydratedSurfaceId: null,
          lastHydratedSurfaceSequence: null,
          attachmentCleanup: null,
          attachmentSessionId: null,
          attachmentToken: null,
          readyAttachId: null,
          pendingDetachPromise: null,
          renderSink: null
        };
      }
    );
    containerRef.current = instance.host;
    terminalRef.current = instance.terminal;
    fitRef.current = instance.fit;
    searchRef.current = instance.search;
    lineCwdsRef.current = instance.lineCwds;
    const moved = attachTerminalHostToCurrentWrapper(
      activeSurface.id,
      instance.terminal,
      instance.host
    );
    if (moved) {
      void fitAndSyncTerminal(instance.terminal, {
        fit: instance.fit,
        surfaceId: activeSurface.id
      });
    }
    return () => {
      clearWrapperTerminalDiagnostics(
        instance.host.parentNode,
        instance.terminal
      );
      if (terminalRef.current === instance.terminal) {
        terminalRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
        lineCwdsRef.current = null;
        containerRef.current = null;
      }
    };
  }, [activeSurface.id, terminalInstanceKey]);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    const host = containerRef.current;
    if (!terminal || !fit || !host || !activeSurface) {
      return;
    }

    const moved = attachTerminalHostToCurrentWrapper(
      activeSurface.id,
      terminal,
      host
    );
    if (moved) {
      void fitAndSyncTerminal(terminal, {
        fit,
        surfaceId: activeSurface.id
      });
    }
  });

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeSurface) {
      return;
    }
    const previousSessionId = surfaceSessionIdsRef.current.get(
      activeSurface.id
    );
    surfaceSessionIdsRef.current.set(activeSurface.id, activeSurface.sessionId);
    if (!previousSessionId || previousSessionId === activeSurface.sessionId) {
      return;
    }
    terminal.reset();
    terminal.clearSelection();
    terminalInstanceStore.detachAttachment(activeSurface.id);
    terminalInstanceStore.invalidateHydration(terminalInstanceKey);
    updateTerminalDiagnostics(activeSurface.id, terminal, {
      hydratedSequence: null,
      renderedSequence: null
    });
  }, [activeSurface.id, activeSurface.sessionId, terminalInstanceKey]);

  useEffect(() => {
    const previousSurfaceId = previousActiveSurfaceIdRef.current;
    previousActiveSurfaceIdRef.current = activeSurface.id;
    const previousSurfaceStillInPane = props.surfaces.some(
      (surface) => surface.id === previousSurfaceId
    );
    if (previousSurfaceId !== activeSurface.id && previousSurfaceStillInPane) {
      terminalInstanceStore.detachAttachment(previousSurfaceId);
    }
  }, [activeSurface.id, props.surfaces]);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    renderSinkContextRef.current =
      terminal && fit
        ? {
            terminal,
            fit,
            surfaceId: activeSurface.id
          }
        : null;
  });

  useLayoutEffect(() => {
    const context = renderSinkContextRef.current;
    if (!context) {
      return;
    }
    const initialTerminal = context.terminal;
    const initialFit = context.fit;
    const initialSurfaceId = context.surfaceId;
    const sink: terminalInstanceStore.TerminalRenderSink = {
      write: (data, afterWrite, profileSurfaceId) => {
        const current = renderSinkContextRef.current;
        return writeTerminalRef.current(
          current?.terminal ?? initialTerminal,
          data,
          afterWrite,
          profileSurfaceId ?? current?.surfaceId ?? initialSurfaceId
        );
      },
      fitAndSync: () => {
        const current = renderSinkContextRef.current;
        return fitAndSyncTerminalRef.current(
          current?.terminal ?? initialTerminal,
          {
            fit: current?.fit ?? initialFit,
            surfaceId: current?.surfaceId ?? initialSurfaceId
          }
        );
      },
      beforeFitAndSync: () => {
        const current = renderSinkContextRef.current;
        surfaceResizeDimensionsRef.current.delete(
          current?.surfaceId ?? initialSurfaceId
        );
      }
    };
    terminalInstanceStore.setRenderSink(terminalInstanceKey, sink);
    return () => {
      terminalInstanceStore.clearRenderSink(terminalInstanceKey, sink);
    };
  }, [terminalInstanceKey]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) {
      return;
    }
    const imeCompositionRef = { current: false };
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
      if (shouldDeferTerminalShortcutToIme(event, imeCompositionRef.current)) {
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
          void pasteClipboard(terminal, currentSurface.id);
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
          matchesBinding(
            event,
            copyModeSelectAllShortcutRef.current,
            reservedSystemChordsRef.current
          )
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
    const markTerminalPasteInProgress = (): void => {
      isPastingRef.current = true;
      setTimeout(() => {
        isPastingRef.current = false;
      }, 0);
    };
    const handleTerminalPaste = (event: ClipboardEvent) => {
      if (copyModeRef.current || showSearchRef.current) {
        const targetElement =
          event.target instanceof Element
            ? event.target
            : event.target instanceof Node
              ? event.target.parentElement
              : null;
        if (!targetElement?.closest(".xterm")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const sanitizedText = sanitizeTerminalPasteText(text);
        if (sanitizedText) {
          markTerminalPasteInProgress();
          terminal.paste(sanitizedText);
        }
        return;
      }
      const currentSurface = activeSurfaceRef.current;
      if (!currentSurface) {
        return;
      }
      const clipboardData = event.clipboardData;
      const imageCount = clipboardData
        ? countSupportedImageFiles(getImageFilesFromDataTransfer(clipboardData))
        : 0;
      const eventText = clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();

      const pasteSanitizedText = async (): Promise<void> => {
        let text = eventText;
        if (!text) {
          try {
            text = await window.kmux.readClipboardText();
          } catch (error) {
            console.warn("Failed to read clipboard text for paste", error);
          }
        }
        const sanitizedText = sanitizeTerminalPasteText(text);
        if (sanitizedText) {
          markTerminalPasteInProgress();
          terminal.paste(sanitizedText);
        }
      };

      void (async () => {
        let nativeImages: CreateImageAttachmentPayload[] = [];
        if (imageCount === 0) {
          try {
            nativeImages = await window.kmux.readClipboardImages();
          } catch (error) {
            console.warn("Failed to inspect native clipboard images", error);
          }
        }

        if (
          !shouldUseImagePaste({
            imageCount: imageCount + nativeImages.length,
            text: eventText
          })
        ) {
          await pasteSanitizedText();
          return;
        }

        const payloads =
          imageCount > 0 && clipboardData
            ? await createImageAttachmentPayloadsFromDataTransfer(
                clipboardData,
                "clipboard"
              )
            : [];
        payloads.push(...nativeImages);
        await attachImagePayloads(terminal, currentSurface.id, payloads);
      })();
    };

    container.addEventListener("keydown", handleTerminalShortcut, true);
    container.addEventListener("paste", handleTerminalPaste, true);
    const xtermTextarea = terminal.textarea;
    const handleCompositionStart = (): void => {
      imeCompositionRef.current = true;
      if (props.keyboardPlatform === "linux") {
        linuxImeDuplicateCommitGuardRef.current.compositionStart(
          xtermTextarea?.value ?? ""
        );
      }
    };
    const handleCompositionUpdate = (event: CompositionEvent): void => {
      if (props.keyboardPlatform === "linux") {
        linuxImeDuplicateCommitGuardRef.current.compositionUpdate(event.data);
      }
    };
    const handleCompositionEnd = (event: CompositionEvent): void => {
      imeCompositionRef.current = false;
      if (props.keyboardPlatform === "linux") {
        const commitText =
          linuxImeDuplicateCommitGuardRef.current.compositionEnd(
            xtermTextarea?.value ?? "",
            event.data
          );
        const currentSurface = activeSurfaceRef.current;
        if (commitText && currentSurface) {
          void window.kmux.sendText(currentSurface.id, commitText);
          if (xtermTextarea) {
            xtermTextarea.value = "";
          }
        }
      }
    };
    // Reset stale composition state if focus leaves the textarea (e.g. surface
    // switch, OS-level shortcut) without a matching compositionend.
    const handleTextareaBlur = (): void => {
      imeCompositionRef.current = false;
      if (props.keyboardPlatform === "linux") {
        linuxImeDuplicateCommitGuardRef.current.reset();
      }
    };
    if (xtermTextarea) {
      xtermTextarea.addEventListener(
        "compositionstart",
        handleCompositionStart
      );
      xtermTextarea.addEventListener(
        "compositionupdate",
        handleCompositionUpdate
      );
      xtermTextarea.addEventListener("compositionend", handleCompositionEnd);
      xtermTextarea.addEventListener("blur", handleTextareaBlur);
    }
    terminal.attachCustomKeyEventHandler(
      (event) =>
        !shouldSuppressXtermDuringIme(
          event,
          imeCompositionRef.current,
          props.keyboardPlatform
        )
    );
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    void fitAndSyncTerminal(terminal);
    const dividerFitThrottle = createTerminalDividerFitThrottle({
      runFit: () => {
        void fitAndSyncTerminal(terminal).catch(() => {
          // ignore resize errors during unmount
        });
      }
    });
    const foregroundFit = installTerminalForegroundFit({
      isActive: () =>
        paneActiveRef.current &&
        terminalRef.current === terminal &&
        Boolean(activeSurfaceRef.current),
      getFitElement: () => containerRef.current,
      fitAndSync: () => {
        dividerFitThrottle.requestFit();
      },
      onError: () => {
        // Ignore foreground revalidation races during unmount/surface switches.
      }
    });
    foregroundFitRef.current = foregroundFit;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        dividerFitThrottle.requestFit();
      }, 30);
    });
    resizeObserver.observe(container);

    // Requests sent during a drag carry gestureActive=true, which makes the
    // pty-host hold the SIGWINCH commit. The hold is released by a final
    // request after the gesture ends — force one even when the grid size
    // did not change since the last request.
    const unsubscribeDragRelease = subscribePaneDividerDrag((dragActive) => {
      if (dragActive) {
        return;
      }
      const surfaceId = activeSurfaceRef.current?.id;
      if (surfaceId) {
        surfaceResizeDimensionsRef.current.delete(surfaceId);
      }
      dividerFitThrottle.requestFit();
    });

    const disposeData = terminal.onData((data) => {
      const currentSurface = activeSurfaceRef.current;
      if (!currentSurface) {
        return;
      }
      let dataToSend = data;
      if (props.keyboardPlatform === "linux" && !isPastingRef.current) {
        const filteredData =
          linuxImeDuplicateCommitGuardRef.current.filterData(data);
        if (!filteredData) {
          return;
        }
        dataToSend = filteredData;
      }
      const rewrite = applyPendingTerminalEnterRewrite(
        currentSurface.id,
        dataToSend,
        pendingEnterRewriteRef.current
      );
      if (rewrite.clearPending) {
        clearPendingEnterRewrite();
      }
      void window.kmux.sendText(currentSurface.id, rewrite.data);
    });
    const disposeWriteParsed = terminal.onWriteParsed(() => {
      syncTerminalMetrics(terminal);
    });
    const disposeScroll = terminal.onScroll(() => {
      syncTerminalMetrics(terminal);
    });

    return () => {
      if (foregroundFitRef.current === foregroundFit) {
        foregroundFitRef.current = null;
      }
      foregroundFit.dispose();
      unsubscribeDragRelease();
      dividerFitThrottle.dispose();
      resizeObserver.disconnect();
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = null;
      }
      disposeData.dispose();
      disposeWriteParsed.dispose();
      disposeScroll.dispose();
      container.removeEventListener("keydown", handleTerminalShortcut, true);
      container.removeEventListener("paste", handleTerminalPaste, true);
      if (xtermTextarea) {
        xtermTextarea.removeEventListener(
          "compositionstart",
          handleCompositionStart
        );
        xtermTextarea.removeEventListener(
          "compositionupdate",
          handleCompositionUpdate
        );
        xtermTextarea.removeEventListener(
          "compositionend",
          handleCompositionEnd
        );
        xtermTextarea.removeEventListener("blur", handleTextareaBlur);
      }
      clearPendingEnterRewrite();
    };
  }, [props.keyboardPlatform, props.paneId, terminalInstanceKey]);

  useEffect(() => {
    const wasActive = previousPaneActiveRef.current;
    previousPaneActiveRef.current = props.active;
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (!props.active) {
      scheduleInactiveWorkspaceRendererPause(terminal);
      return;
    }
    cancelInactiveRendererPause();
    if (!wasActive) {
      const surfaceId = activeSurfaceRef.current?.id;
      if (surfaceId) {
        refreshVisibleSurfaceRenderer(surfaceId, terminal, { force: true });
      }
      foregroundFitRef.current?.scheduleFit();
    }
  }, [props.active, terminalInstanceKey]);

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
    terminalTheme,
    terminalInstanceKey
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeSurface) {
      return;
    }
    const surfaceId = activeSurface.id;
    const sessionId = activeSurface.sessionId;
    const existingAttachmentSessionId =
      terminalInstanceStore.getAttachmentSessionId(surfaceId);
    if (
      existingAttachmentSessionId &&
      existingAttachmentSessionId !== sessionId
    ) {
      terminalInstanceStore.detachAttachment(surfaceId);
    }
    if (terminalInstanceStore.hasAttachment(surfaceId, sessionId)) {
      return;
    }

    let attached = true;
    let terminalOperationQueue = Promise.resolve();
    let attachmentToken: terminalInstanceStore.TerminalAttachmentToken | null =
      null;
    const instanceKey = terminalInstanceKey;
    const attachedLineCwds = terminalInstanceStore.getLineCwdsForTerminal(
      instanceKey,
      terminal
    );
    const replayVisibility = createTerminalReplayVisibility({
      host: containerRef.current,
      wrapper: surfaceWrapperRefs.current.get(surfaceId) ?? null
    });
    const writeAttachedTerminal = (
      data: string,
      afterWrite?: () => void,
      profileSurfaceId = surfaceId
    ): boolean => {
      const sink = terminalInstanceStore.getRenderSink(instanceKey);
      if (sink) {
        return sink.write(data, afterWrite, profileSurfaceId);
      }
      if (terminalInstanceStore.isCurrentTerminal(instanceKey, terminal)) {
        terminal.write(data, () => {
          afterWrite?.();
        });
        return true;
      }
      return false;
    };
    const waitForAttachedTerminalWrite = (
      data: string,
      profileSurfaceId: string,
      afterWrite?: () => void
    ): Promise<boolean> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (didWrite: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(didWrite);
        };
        const timeout = setTimeout(() => {
          // Distinguishes "xterm never confirmed the write" from a dropped
          // write in captures and logs; the parse may still complete later,
          // but its bookkeeping callback is skipped once this fires.
          console.warn("kmux: terminal write callback timed out", {
            surfaceId: profileSurfaceId,
            bytes: data.length,
            timeoutMs: TERMINAL_WRITE_CALLBACK_TIMEOUT_MS
          });
          finish(false);
        }, TERMINAL_WRITE_CALLBACK_TIMEOUT_MS);
        let didScheduleWrite = false;
        try {
          didScheduleWrite = writeAttachedTerminal(
            data,
            () => {
              if (settled) {
                return;
              }
              try {
                afterWrite?.();
              } finally {
                finish(true);
              }
            },
            profileSurfaceId
          );
        } catch (error) {
          console.warn("Failed to write terminal output", error);
          finish(false);
          return;
        }
        if (!didScheduleWrite) {
          finish(false);
        }
      });
    const fitAttachedTerminal = async (): Promise<void> => {
      await terminalInstanceStore.getRenderSink(instanceKey)?.fitAndSync();
    };
    const isCurrentAttachedSession = (): boolean =>
      attached &&
      attachmentToken !== null &&
      terminalInstanceStore.isCurrentAttachment(
        surfaceId,
        sessionId,
        attachmentToken
      );
    const isCurrentSessionEvent = (payload: {
      surfaceId: string;
      sessionId: string;
    }): boolean =>
      payload.surfaceId === surfaceId &&
      payload.sessionId === sessionId &&
      attached &&
      attachmentToken !== null &&
      terminalInstanceStore.isCurrentAttachment(
        surfaceId,
        sessionId,
        attachmentToken
      );
    const isSameSurfaceSession = (payload: {
      surfaceId: string;
      sessionId: string;
    }): boolean =>
      payload.surfaceId === surfaceId &&
      payload.sessionId === sessionId &&
      surfaceSessionIdsRef.current.get(payload.surfaceId) === payload.sessionId;
    const enqueueTerminalOperation = (
      operation: () => Promise<void> | void
    ): void => {
      terminalOperationQueue = terminalOperationQueue
        .catch(() => undefined)
        .then(() => operation())
        .catch(() => undefined);
    };
    type LiveChunkPayloadWithCwd = {
      surfaceId: string;
      sessionId: string;
      sequence: number;
      chunk: string;
      cwd?: string;
    };
    // Chunks at or below the last replayed snapshot sequence are already in
    // the terminal; stragglers delivered around a re-hydration must not be
    // written again.
    let minLiveChunkSequence = 0;
    let recoveringFromChunkBacklog = false;
    const liveChunkBatcher =
      createTerminalChunkBatcher<LiveChunkPayloadWithCwd>({
        enqueueOperation: enqueueTerminalOperation,
        isCurrentEvent: (payload) =>
          payload.sequence > minLiveChunkSequence &&
          isCurrentSessionEvent(payload),
        writeChunk: (payload, afterParsed) =>
          writeAttachedTerminal(payload.chunk, afterParsed, payload.surfaceId),
        waitForFinalChunkWrite: (payload, afterParsed) =>
          waitForAttachedTerminalWrite(
            payload.chunk,
            payload.surfaceId,
            afterParsed
          ),
        readCursorLine: () =>
          terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
        readTrimmedLineCount: () =>
          attachedLineCwds?.getTrimmedLineCount() ?? 0,
        recordWrite: (range) => {
          attachedLineCwds?.recordWrite({
            startLine: range.startLine,
            endLine: range.endLine,
            cwd: range.cwd
          });
        },
        onBatchRendered: (payload) => {
          terminalInstanceStore.markSurfaceRendered(
            instanceKey,
            payload.surfaceId,
            payload.sequence
          );
          const renderedSequence =
            terminalInstanceStore.getLastHydratedSurfaceSequence(instanceKey);
          updateTerminalDiagnostics(payload.surfaceId, terminal, {
            renderedSequence
          });
        },
        backlogLimitChars: TERMINAL_LIVE_CHUNK_BACKLOG_LIMIT_CHARS,
        onBacklogExceeded: () => {
          recoverFromChunkBacklog();
        }
      });
    const markSnapshotRendered = (
      attachId: string,
      snapshot: TerminalSnapshotWithCwdRanges
    ) => {
      if (!isCurrentAttachedSession()) {
        return Promise.resolve({ status: "stale" as const });
      }
      if (typeof snapshot.sequence === "number") {
        minLiveChunkSequence = Math.max(
          minLiveChunkSequence,
          snapshot.sequence
        );
      }
      attachedLineCwds?.importSnapshotRanges(snapshot.cwdRanges);
      terminalInstanceStore.markSurfaceHydrated(
        instanceKey,
        surfaceId,
        snapshot.sequence
      );
      const renderedSequence =
        terminalInstanceStore.getLastHydratedSurfaceSequence(instanceKey);
      updateTerminalDiagnostics(surfaceId, terminal, {
        hydratedSequence: snapshot.sequence,
        renderedSequence
      });
      return window.kmux
        .completeAttachSurface(surfaceId, attachId, sessionId)
        .then((completion) => {
          const currentToken = attachmentToken;
          if (!currentToken || !isCurrentAttachedSession()) {
            return { status: "stale" as const };
          }
          if (completion.status === "ready") {
            terminalInstanceStore.markAttachmentReady(
              surfaceId,
              sessionId,
              attachId,
              currentToken
            );
          } else {
            terminalInstanceStore.clearAttachmentReady(
              surfaceId,
              sessionId,
              currentToken
            );
          }
          return completion;
        });
    };

    const unsubscribe = window.kmux.subscribeTerminal((event) => {
      if (event.type === "chunk" && isCurrentSessionEvent(event.payload)) {
        const payload = event.payload as typeof event.payload & {
          cwd?: string;
        };
        liveChunkBatcher.enqueue(payload);
      }
      if (event.type === "resize" && isCurrentSessionEvent(event.payload)) {
        const payload = event.payload;
        liveChunkBatcher.seal();
        enqueueTerminalOperation(() => {
          if (!isCurrentSessionEvent(payload)) {
            return;
          }
          if (
            !payload.attachId ||
            terminalInstanceStore.getReadyAttachId(
              payload.surfaceId,
              payload.sessionId
            ) !== payload.attachId
          ) {
            return;
          }
          applyTerminalResize(terminal, {
            cols: payload.cols,
            rows: payload.rows,
            surfaceId: payload.surfaceId,
            generation: resizeGenerationRef.current,
            previousCols: terminal.cols,
            previousRows: terminal.rows
          });
          surfaceResizeDimensionsRef.current.set(payload.surfaceId, {
            cols: payload.cols,
            rows: payload.rows
          });
          syncSurfaceTerminalMetrics(payload.surfaceId, terminal);
        });
      }
      if (event.type === "exit" && isCurrentSessionEvent(event.payload)) {
        const payload = event.payload;
        liveChunkBatcher.seal();
        enqueueTerminalOperation(async () => {
          if (!isSameSurfaceSession(payload)) {
            return;
          }
          await waitForAttachedTerminalWrite(
            `\r\n\u001b[31mSession exited${typeof payload.exitCode === "number" ? ` (${payload.exitCode})` : ""}\u001b[0m\r\n`,
            payload.surfaceId
          );
        });
      }
    });
    const cleanupAttachment = () => {
      if (!attached) {
        return;
      }
      attached = false;
      terminalInstanceStore.clearAttachment(surfaceId, cleanupAttachment);
      replayVisibility.dispose();
      unsubscribe();
      return window.kmux.detachSurface(surfaceId, sessionId).catch((error) => {
        console.warn("Failed to detach terminal surface", error);
      });
    };
    attachmentToken = terminalInstanceStore.registerAttachment(
      surfaceId,
      sessionId,
      cleanupAttachment
    );
    if (!attachmentToken) {
      attached = false;
      unsubscribe();
      return;
    }
    const attachCurrentSurface = async () => {
      await terminalInstanceStore.waitForPendingDetach(surfaceId);
      if (!isCurrentAttachedSession()) {
        return null;
      }
      return window.kmux.attachSurface(surfaceId, sessionId);
    };
    // Backlog skip-ahead: drop the unparsed chunk backlog and re-run the
    // preserved-terminal attach flow. The bridge resets the attachment to
    // hydrating (queueing further chunks), takes a fresh snapshot, and the
    // replay replaces the terminal content at the current sequence; the
    // minLiveChunkSequence gate rejects in-flight chunks the snapshot
    // already contains.
    const recoverFromChunkBacklog = (): void => {
      if (recoveringFromChunkBacklog || !isCurrentAttachedSession()) {
        return;
      }
      recoveringFromChunkBacklog = true;
      liveChunkBatcher.discardPending();
      void (async () => {
        try {
          await reattachPreservedTerminal({
            terminal,
            isMounted: isCurrentAttachedSession,
            isTerminalActive: (candidate) => candidate === terminal,
            waitForTerminalFonts,
            attachSurface: attachCurrentSurface,
            lastRenderedSequence:
              terminalInstanceStore.getLastHydratedSurfaceSequence(
                instanceKey
              ),
            beforeFitAndSync: () => {
              terminalInstanceStore
                .getRenderSink(instanceKey)
                ?.beforeFitAndSync?.();
            },
            fitAndSyncTerminal: fitAttachedTerminal,
            writeTerminal: (_terminal, data, afterWrite) => {
              const didScheduleWrite = writeAttachedTerminal(
                data,
                afterWrite,
                surfaceId
              );
              if (!didScheduleWrite) {
                terminalInstanceStore.invalidateHydration(instanceKey);
              }
              return didScheduleWrite;
            },
            onReplayStart: replayVisibility.hide,
            onReplayEnd: replayVisibility.revealAfterPaint,
            onSnapshotRendered: markSnapshotRendered
          });
        } finally {
          recoveringFromChunkBacklog = false;
        }
      })().catch(() => {
        // Mirror the mount flow: a failed re-attach leaves the bridge
        // without an attachment, so release the store side too and let the
        // next attach re-establish it.
        if (!attached) {
          return;
        }
        terminalInstanceStore.detachAttachment(surfaceId);
      });
    };

    void (async () => {
      if (!attached) {
        return;
      }
      const lastHydratedSurfaceId =
        terminalInstanceStore.getLastHydratedSurfaceId(instanceKey);
      if (lastHydratedSurfaceId === surfaceId) {
        await reattachPreservedTerminal({
          terminal,
          isMounted: isCurrentAttachedSession,
          isTerminalActive: (candidate) => candidate === terminal,
          waitForTerminalFonts,
          attachSurface: attachCurrentSurface,
          lastRenderedSequence:
            terminalInstanceStore.getLastHydratedSurfaceSequence(instanceKey),
          beforeFitAndSync: () => {
            // Force one resize after the surface is live so TUI mouse/scroll
            // state is refreshed without relying on a detached resize.
            terminalInstanceStore
              .getRenderSink(instanceKey)
              ?.beforeFitAndSync?.();
          },
          fitAndSyncTerminal: fitAttachedTerminal,
          writeTerminal: (_terminal, data, afterWrite) => {
            const didScheduleWrite = writeAttachedTerminal(
              data,
              afterWrite,
              surfaceId
            );
            if (!didScheduleWrite) {
              terminalInstanceStore.invalidateHydration(instanceKey);
            }
            return didScheduleWrite;
          },
          onReplayStart: replayVisibility.hide,
          onReplayEnd: replayVisibility.revealAfterPaint,
          onSnapshotRendered: markSnapshotRendered
        });
      } else {
        await hydrateAttachedTerminal({
          terminal,
          isMounted: isCurrentAttachedSession,
          isTerminalActive: (candidate) => candidate === terminal,
          waitForTerminalFonts,
          fitAndSyncTerminal: fitAttachedTerminal,
          attachSurface: attachCurrentSurface,
          writeTerminal: (_terminal, data, afterWrite) => {
            const didScheduleWrite = writeAttachedTerminal(
              data,
              afterWrite,
              surfaceId
            );
            if (!didScheduleWrite) {
              terminalInstanceStore.invalidateHydration(instanceKey);
            }
            return didScheduleWrite;
          },
          onReplayStart: replayVisibility.hide,
          onReplayEnd: replayVisibility.revealAfterPaint,
          onSnapshotRendered: markSnapshotRendered
        });
      }
      if (isCurrentAttachedSession() && shouldFocusActiveTerminal(surfaceId)) {
        focusTerminalInput();
      }
    })().catch(() => {
      if (!attached) {
        return;
      }
      terminalInstanceStore.detachAttachment(surfaceId);
    });
    return undefined;
  }, [activeSurface?.id, activeSurface?.sessionId, terminalInstanceKey]);

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
    if (!props.showSearch || !props.active) {
      return;
    }
    setCopyMode(false);
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [props.showSearch, props.active]);

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

  useLayoutEffect(() => {
    if (!shouldFocusActiveTerminal(activeSurface.id)) {
      return;
    }
    focusTerminalInput();
  }, [
    activeSurface.id,
    props.focused,
    props.active,
    props.showSearch,
    props.focusRequest
  ]);

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
      if (dataTransferHasFiles(event.dataTransfer)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setImageDropActive(true);
      }
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
    setImageDropActive(false);
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
    setImageDropActive(false);
  };

  const handleSurfaceDrop = async (
    event: DragEvent<HTMLDivElement>
  ): Promise<void> => {
    const payload = currentDropPayload(event);
    setSurfaceDropDirection(null);
    setImageDropActive(false);
    if (!payload && dataTransferHasFiles(event.dataTransfer)) {
      event.preventDefault();
      event.stopPropagation();
      const terminal = terminalRef.current;
      const currentSurface = activeSurfaceRef.current;
      if (!terminal || !currentSurface) {
        return;
      }
      const droppedFiles = getFilesFromDataTransfer(event.dataTransfer);
      const droppedPathText = formatDroppedFilePathsForTerminal(
        resolveFilePathsFromFiles(droppedFiles)
      );
      const payloads = await createImageAttachmentPayloadsFromFiles(
        droppedFiles,
        "drop"
      );
      if (!payloads.length) {
        if (droppedPathText) {
          terminal.paste(droppedPathText);
        } else {
          showAttachmentStatus("Could not read dropped file path");
        }
        focusTerminalInput();
        return;
      }
      await attachImagePayloads(terminal, currentSurface.id, payloads);
      return;
    }

    const direction = resolveDropDirection(event);
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

  function handleSurfaceTabContextMenu(
    event: MouseEvent,
    surfaceId: string
  ): void {
    event.preventDefault();
    event.stopPropagation();
    void openSurfaceContextMenu(surfaceId, event.clientX, event.clientY);
  }

  function handleTerminalContextMenu(event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    void openSurfaceContextMenu(activeSurface.id, event.clientX, event.clientY);
  }

  async function openSurfaceContextMenu(
    surfaceId: string,
    x: number,
    y: number
  ): Promise<void> {
    const surface = props.surfaces.find((entry) => entry.id === surfaceId);
    if (!surface) {
      return;
    }
    props.onFocusPane(props.paneId);
    props.onFocusSurface(surfaceId);
    try {
      const context = await surfaceMenuContextFor(surface);
      const items = buildSurfaceContextMenuEntries(context);
      const usedNative = await window.kmux.showSurfaceContextMenu(
        surfaceId,
        x,
        y,
        context
      );
      if (usedNative) {
        return;
      }
      const menuWidth = 248;
      const menuHeight = 224;
      setSurfaceContextMenu({
        surfaceId,
        items,
        x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))
      });
    } catch (error) {
      console.warn("Failed to show surface context menu", error);
    }
  }

  const copyModeSelectAllLabel =
    formatShortcutLabel(
      props.copyModeSelectAllShortcut,
      props.shortcutLabelStyle
    ) ?? props.copyModeSelectAllShortcut;

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
                onContextMenu={(event) =>
                  handleSurfaceTabContextMenu(event, surface.id)
                }
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
                    fallbackVisible={
                      surface.attention || surface.unreadCount > 0
                    }
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
                  props.settings.shortcuts["terminal.search.prev"],
                  props.reservedSystemChords
                )
              ) {
                event.preventDefault();
                stepSearch("prev");
                return;
              }
              if (
                matchesBinding(
                  event,
                  props.settings.shortcuts["terminal.search.next"],
                  props.reservedSystemChords
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
          Copy mode: arrows/page keys scroll, {copyModeSelectAllLabel} selects
          all, Esc exits
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
        data-image-drop-active={imageDropActive ? "true" : undefined}
        onDragOver={handleSurfaceDragOver}
        onDragLeave={handleSurfaceDragLeave}
        onDrop={(event) => {
          void handleSurfaceDrop(event);
        }}
        onContextMenu={handleTerminalContextMenu}
      >
        {showSurfaceDropPrompt ? (
          <div className={styles.surfaceDropPrompt} role="status">
            {SURFACE_TAB_DROP_PROMPT}
          </div>
        ) : null}
        {attachmentStatus ? (
          <div className={styles.attachmentStatus} role="status">
            {attachmentStatus}
          </div>
        ) : null}
        {tabs.map((surface) => {
          const selected = surface.id === activeSurface.id;
          return (
            <div
              key={surface.id}
              ref={(node) => setSurfaceWrapperRef(surface.id, node)}
              className={styles.terminalViewport}
              data-active={selected ? "true" : "false"}
              data-testid={`terminal-${surface.id}`}
              aria-label={`Terminal surface ${surface.title}`}
              aria-hidden={selected ? undefined : true}
            />
          );
        })}
      </div>
      {surfaceContextMenu ? (
        <SurfaceContextMenu
          position={surfaceContextMenu}
          items={surfaceContextMenu.items}
          shortcutLabelStyle={props.shortcutLabelStyle}
          menuRef={surfaceContextMenuRef}
          onClose={closeSurfaceContextMenu}
          onAction={(action) =>
            runSurfaceContextAction(surfaceContextMenu.surfaceId, action)
          }
        />
      ) : null}
    </div>
  );
}

function SurfaceContextMenu(props: {
  position: { x: number; y: number };
  items: SurfaceContextMenuEntry[];
  shortcutLabelStyle: ShortcutLabelStyle;
  menuRef: RefObject<HTMLDivElement>;
  onClose: () => void;
  onAction: (action: SurfaceContextAction) => void;
}): JSX.Element {
  return (
    <div
      className={styles.surfaceMenuOverlay}
      onClick={props.onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div
        className={styles.surfaceMenu}
        ref={props.menuRef}
        role="menu"
        aria-label="Surface menu"
        style={{
          left: props.position.x,
          top: props.position.y
        }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
            return;
          }
          const enabledItems = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[role="menuitem"]:not(:disabled)'
            )
          );
          if (!enabledItems.length) {
            return;
          }
          const currentIndex = enabledItems.findIndex(
            (item) => item === document.activeElement
          );
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex =
              currentIndex === -1
                ? step > 0
                  ? 0
                  : enabledItems.length - 1
                : (currentIndex + step + enabledItems.length) %
                  enabledItems.length;
            enabledItems[nextIndex]?.focus();
            return;
          }
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            enabledItems[
              event.key === "Home" ? 0 : enabledItems.length - 1
            ]?.focus();
          }
        }}
      >
        {props.items.map((item) =>
          item.kind === "separator" ? (
            <div
              key={item.id}
              className={styles.surfaceMenuSeparator}
              role="separator"
            />
          ) : (
            <button
              key={item.id}
              role="menuitem"
              className={styles.surfaceMenuItem}
              disabled={item.disabled}
              onClick={() => props.onAction(item.action)}
            >
              <span className={styles.surfaceMenuLabel}>{item.label}</span>
              {item.shortcut ? (
                <span className={styles.surfaceMenuShortcut} aria-hidden="true">
                  {formatShortcutLabel(item.shortcut, props.shortcutLabelStyle)}
                </span>
              ) : null}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) {
    return true;
  }
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

function getFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const filesFromItems = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return filesFromItems.length ? filesFromItems : Array.from(dataTransfer.files);
}

function getImageFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  return getFilesFromDataTransfer(dataTransfer).filter(isPotentialImageFile);
}

function resolveFilePathsFromFiles(files: File[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    try {
      paths.push(window.kmux.getPathForFile(file));
    } catch (error) {
      console.warn("Failed to resolve dropped file path", error);
    }
  }
  return paths;
}

async function createImageAttachmentPayloadsFromDataTransfer(
  dataTransfer: DataTransfer,
  source: ImageAttachmentSource
): Promise<CreateImageAttachmentPayload[]> {
  return createImageAttachmentPayloadsFromFiles(
    getImageFilesFromDataTransfer(dataTransfer),
    source
  );
}

async function createImageAttachmentPayloadsFromFiles(
  files: File[],
  source: ImageAttachmentSource
): Promise<CreateImageAttachmentPayload[]> {
  const imageFiles = files.filter(isPotentialImageFile);
  const payloads = await Promise.all(
    imageFiles.map(async (file): Promise<CreateImageAttachmentPayload> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return {
        source,
        originalName: file.name || undefined,
        mimeType: file.type || undefined,
        bytes
      };
    })
  );
  return payloads;
}

function isPotentialImageFile(file: File): boolean {
  return (
    isSupportedImageMimeType(file.type) ||
    /\.(png|jpe?g|gif|webp)$/i.test(file.name)
  );
}

function matchesBinding(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
  >,
  binding: string | undefined,
  reservedSystemChords: KeyChord[] = []
): boolean {
  if (!binding) {
    return false;
  }
  if (isReservedSystemChordBinding(binding, reservedSystemChords)) {
    return false;
  }
  return normalizeShortcutBinding(binding) === normalizeShortcut(event);
}
