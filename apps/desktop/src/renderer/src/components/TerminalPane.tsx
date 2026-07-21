import {
  type DragEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { flushSync } from "react-dom";

import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { Terminal, type IDisposable, type ILinkHandler } from "@xterm/xterm";

import type {
  CreateImageAttachmentPayload,
  ImageAttachmentSource,
  KmuxSettings,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm,
  SurfaceVm,
  TerminalDelta
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
  createTerminalImeInputController,
  createTerminalPaneXtermTheme,
  formatDroppedFilePathsForTerminal,
  isSupportedImageMimeType,
  pasteClipboardIntoTerminal,
  resolveTerminalEnterRewrite,
  resolveTerminalImeKeyAction,
  resolveTerminalImeNavigationSequence,
  sanitizeTerminalPasteText,
  shouldDeferTerminalShortcutToIme,
  shouldUseImagePaste,
  type PendingTerminalEnterRewrite,
  type TerminalImeNavigationKey
} from "../terminalRenderer";
import { type TerminalLineCwdTracker } from "../terminalLineCwdTracker";
import { registerTerminalFileLinkProvider } from "../terminalFileLinks";
import {
  installTerminalForegroundFit,
  type TerminalForegroundFitController
} from "../terminalForegroundFit";
import { SurfaceTerminalCheckpointController } from "../terminalCheckpointController";
import {
  createTerminalBundle,
  type TerminalBundle,
  type TerminalDiagnosticMetadata,
  type TerminalHostElement
} from "../terminalBundle";
import { refreshTerminalRenderer } from "../terminalRenderRefresh";
import * as terminalInstanceStore from "../terminalInstanceStore";
import {
  terminalStreamClient,
  type AttachedTerminalStream,
  TerminalStreamPendingInputBuffer
} from "../terminalStreamClient";
import type { TerminalStreamSink } from "../terminalStreamRouter";
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
  recordRendererSmoothnessProfileEvent,
  subscribeRendererDiagnosticsLogging
} from "../smoothnessProfile";
import { createSmoothnessProfileBucket } from "../../../shared/smoothnessProfileBucket";
import {
  isReservedSystemChordBinding,
  type KeyChord,
  type KeyboardShortcutPlatform
} from "../../../shared/platform/keyboardPolicy";
import { TERMINAL_LIVE_SCROLLBACK_LINES } from "../../../shared/terminalConfig";
import { terminalDataPlaneNowMs } from "../../../shared/terminalDataPlaneMetrics";
import {
  classifyTerminalBinaryInput,
  classifyTerminalTextInput
} from "../../../shared/terminalInteractionDiagnostics";
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
import { type SurfaceContextAction } from "../../../shared/surfaceContextMenu";

export interface TerminalFocusRequest {
  surfaceId: string;
  token: number;
}

interface TerminalPaneProps {
  paneId: string;
  focused: boolean;
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

type TerminalWriter = (
  terminal: Terminal,
  data: string,
  afterWrite?: () => void,
  profileSurfaceId?: string
) => boolean;

type TerminalFitAndSync = (
  terminal: Terminal,
  options?: {
    fit?: FitAddon | null;
    surfaceId?: string | null;
    force?: boolean;
    triggers?: readonly string[];
  }
) => Promise<void>;

type TerminalRenderSinkContext = {
  terminal: Terminal;
  fit: FitAddon;
  surfaceId: string;
};

const PROFILE_TERMINAL_WRITE_BUCKET_MIN_WRITES = 100;
const UTF8_ENCODER = new TextEncoder();
const TERMINAL_ATTACH_REARM_INITIAL_DELAY_MS = 1_000;
const TERMINAL_ATTACH_REARM_MAX_DELAY_MS = 30_000;
const TERMINAL_DIRECT_RESIZE_ACK_TIMEOUT_MS = 10_000;
let nextTerminalDirectResizeRequestId = 0;

function terminalActiveElementKind(
  element: Element | null,
  terminalTextarea: HTMLTextAreaElement | undefined
): string {
  if (!element) {
    return "none";
  }
  if (element === terminalTextarea) {
    return "terminal-textarea";
  }
  if (element === document.body) {
    return "body";
  }
  if (element instanceof HTMLInputElement) {
    return "input";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "textarea";
  }
  if (element instanceof HTMLButtonElement) {
    return "button";
  }
  if (element instanceof HTMLAnchorElement) {
    return "link";
  }
  return element instanceof HTMLElement
    ? element.tagName.toLowerCase()
    : "other";
}

interface TerminalFitMemo {
  width: number;
  height: number;
  cols: number;
  rows: number;
  optionsKey: string;
}

function terminalFitOptionsKey(terminal: Terminal): string {
  const options = terminal.options;
  return JSON.stringify([
    options.fontFamily,
    options.fontSize,
    options.fontWeight,
    options.fontWeightBold,
    options.lineHeight,
    options.letterSpacing,
    typeof window === "undefined" ? 1 : window.devicePixelRatio
  ]);
}
const EXTERNAL_TERMINAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);

interface PendingTerminalResize {
  sessionId: string;
  cols: number;
  rows: number;
  gestureActive: boolean;
  trigger?: string;
}

interface PendingDirectResizeAcknowledgement {
  attachId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}

interface TerminalCwdWriteCursor {
  pendingWrites: number;
  nextStartLine: number;
  trimmedLineCount: number;
}

function cwdAtDataOffset(
  delta: Extract<TerminalDelta, { type: "output" }>,
  dataOffset: number
): string | undefined {
  let offset = 0;
  for (const segment of delta.segments) {
    const nextOffset = offset + segment.data.length;
    if (dataOffset < nextOffset) {
      return segment.cwd;
    }
    offset = nextOffset;
  }
  return delta.segments.at(-1)?.cwd;
}

function outputRangeAffectsScreen(
  delta: Extract<TerminalDelta, { type: "output" }>,
  dataOffset: number,
  dataLength: number
): boolean {
  const dataEnd = dataOffset + dataLength;
  let segmentStart = 0;
  for (const segment of delta.segments) {
    const segmentEnd = segmentStart + segment.data.length;
    if (
      segmentEnd > dataOffset &&
      segmentStart < dataEnd &&
      (segment.telemetry?.outputKind === "screen" ||
        segment.telemetry?.outputKind === "mixed")
    ) {
      return true;
    }
    segmentStart = segmentEnd;
  }
  return false;
}

function openExternalTerminalLink(surfaceId: string, rawUrl: string): void {
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
  void window.kmux.openExternalUrl(surfaceId, url.toString()).catch((error) => {
    console.warn("Failed to open terminal link", error);
  });
}

function terminalLinkHandler(surfaceId: string): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate: (_event, text) => openExternalTerminalLink(surfaceId, text)
  };
}

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
  const cwdWriteCursorsRef = useRef(
    new WeakMap<Terminal, TerminalCwdWriteCursor>()
  );
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
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [terminalAttachmentGeneration, setTerminalAttachmentGeneration] =
    useState(0);
  const [terminalDiagnosticsEnabled, setTerminalDiagnosticsEnabled] = useState(
    () => isRendererSmoothnessProfileEnabled()
  );
  const activeSurfaceRef = useRef<SurfaceVm | null>(activeSurface);
  const paneFocusedRef = useRef(props.focused);
  const terminalDiagnosticsEnabledRef = useRef(terminalDiagnosticsEnabled);
  const foregroundFitRef = useRef<TerminalForegroundFitController | null>(null);
  const terminalInstanceKey = activeSurface.id;
  const terminalStreamEligible = activeSurface.sessionState !== "pending";
  const storageStatusMessage = remoteStorageStatusMessage(
    activeSurface.storageStatus
  );
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
  const terminalStreamRef = useRef<AttachedTerminalStream | null>(null);
  const terminalCheckpointControllerRef =
    useRef<SurfaceTerminalCheckpointController | null>(null);
  const createTerminalBundleRef = useRef<(surfaceId: string) => TerminalBundle>(
    () => {
      throw new Error("terminal bundle factory is not ready");
    }
  );
  const pendingTerminalStreamInputRef = useRef(
    new TerminalStreamPendingInputBuffer()
  );
  const terminalFitMemosRef = useRef(new WeakMap<Terminal, TerminalFitMemo>());
  const pendingDirectResizeAcksRef = useRef(
    new Map<string, PendingDirectResizeAcknowledgement>()
  );
  const pendingTerminalResizeRef = useRef(
    new Map<string, PendingTerminalResize>()
  );
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
  const terminalImeInputControllerRef = useRef(
    createTerminalImeInputController()
  );
  const isPastingRef = useRef(false);

  function updateTerminalDiagnostics(
    surfaceId: string,
    terminal: Terminal,
    patch: Partial<TerminalDiagnosticMetadata>
  ): void {
    const elements = [
      containerRef.current as TerminalHostElement | null,
      surfaceWrapperRefs.current.get(surfaceId) as
        | TerminalHostElement
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
        attachAvailableSequence:
          element.__kmuxTerminalDiagnostics?.attachAvailableSequence ?? null,
        renderGeneration:
          element.__kmuxTerminalDiagnostics?.renderGeneration ?? 0,
        lastOnRenderAt:
          element.__kmuxTerminalDiagnostics?.lastOnRenderAt ?? null,
        lastOnRenderSequence:
          element.__kmuxTerminalDiagnostics?.lastOnRenderSequence ?? null,
        lastScreenOnRenderAt:
          element.__kmuxTerminalDiagnostics?.lastScreenOnRenderAt ?? null,
        lastScreenOnRenderSequence:
          element.__kmuxTerminalDiagnostics?.lastScreenOnRenderSequence ?? null,
        lastReceiveAt: element.__kmuxTerminalDiagnostics?.lastReceiveAt ?? null,
        lastReceiveSequence:
          element.__kmuxTerminalDiagnostics?.lastReceiveSequence ?? null,
        lastScreenReceiveAt:
          element.__kmuxTerminalDiagnostics?.lastScreenReceiveAt ?? null,
        lastScreenReceiveSequence:
          element.__kmuxTerminalDiagnostics?.lastScreenReceiveSequence ?? null,
        lastWriteAt: element.__kmuxTerminalDiagnostics?.lastWriteAt ?? null,
        lastWriteSequence:
          element.__kmuxTerminalDiagnostics?.lastWriteSequence ?? null,
        lastScreenWriteAt:
          element.__kmuxTerminalDiagnostics?.lastScreenWriteAt ?? null,
        lastScreenWriteSequence:
          element.__kmuxTerminalDiagnostics?.lastScreenWriteSequence ?? null,
        lastParsedAt: element.__kmuxTerminalDiagnostics?.lastParsedAt ?? null,
        lastParsedSequence:
          element.__kmuxTerminalDiagnostics?.lastParsedSequence ?? null,
        lastScreenParsedAt:
          element.__kmuxTerminalDiagnostics?.lastScreenParsedAt ?? null,
        lastScreenParsedSequence:
          element.__kmuxTerminalDiagnostics?.lastScreenParsedSequence ?? null,
        lastInputAt: element.__kmuxTerminalDiagnostics?.lastInputAt ?? null,
        lastInputKind: element.__kmuxTerminalDiagnostics?.lastInputKind ?? null,
        lastInputBytes:
          element.__kmuxTerminalDiagnostics?.lastInputBytes ?? null,
        lastFocusEventAt:
          element.__kmuxTerminalDiagnostics?.lastFocusEventAt ?? null,
        lastFocusEvent:
          element.__kmuxTerminalDiagnostics?.lastFocusEvent ?? null,
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
      if (diagnostics.attachAvailableSequence === null) {
        delete element.dataset.terminalAttachAvailableSequence;
      } else {
        element.dataset.terminalAttachAvailableSequence = String(
          diagnostics.attachAvailableSequence
        );
      }
      element.dataset.terminalRenderGeneration = String(
        diagnostics.renderGeneration
      );
      if (diagnostics.lastOnRenderAt === null) {
        delete element.dataset.terminalLastOnRenderAt;
      } else {
        element.dataset.terminalLastOnRenderAt = String(
          diagnostics.lastOnRenderAt
        );
      }
    }
  }

  function clearWrapperTerminalDiagnostics(
    wrapper: ParentNode | null,
    terminal: Terminal
  ): void {
    const diagnosticWrapper = wrapper as TerminalHostElement | null;
    if (diagnosticWrapper?.__kmuxTerminal !== terminal) {
      return;
    }
    delete diagnosticWrapper.__kmuxTerminal;
    delete diagnosticWrapper.__kmuxTerminalDiagnostics;
    delete diagnosticWrapper.dataset.terminalHydratedSequence;
    delete diagnosticWrapper.dataset.terminalRenderedSequence;
    delete diagnosticWrapper.dataset.terminalAttachAvailableSequence;
    delete diagnosticWrapper.dataset.terminalRenderGeneration;
    delete diagnosticWrapper.dataset.terminalLastOnRenderAt;
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

    const diagnosticWrapper = wrapper as TerminalHostElement;
    diagnosticWrapper.__kmuxTerminal = terminal;
    diagnosticWrapper.__kmuxTerminalDiagnostics = (
      host as TerminalHostElement
    ).__kmuxTerminalDiagnostics;
    syncSurfaceTerminalMetrics(surfaceId, terminal);
    if (moved) {
      refreshTerminalRenderer(terminal);
    }
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
  paneFocusedRef.current = props.focused;
  terminalDiagnosticsEnabledRef.current = terminalDiagnosticsEnabled;
  copyModeRef.current = copyMode;
  queryRef.current = query;
  showSearchRef.current = props.showSearch;
  shortcutsRef.current = props.settings.shortcuts;
  reservedSystemChordsRef.current = props.reservedSystemChords;
  keyboardPlatformRef.current = props.keyboardPlatform;
  copyModeSelectAllShortcutRef.current = props.copyModeSelectAllShortcut;
  onToggleSearchRef.current = props.onToggleSearch;
  searchDecorationsRef.current = terminalSearchDecorations;
  createTerminalBundleRef.current = (surfaceId: string): TerminalBundle =>
    createTerminalBundle({
      createTerminal: () =>
        new Terminal({
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
          linkHandler: terminalLinkHandler(surfaceId)
        }),
      onWebLink: (url) => openExternalTerminalLink(surfaceId, url),
      registerBufferTrimListener: registerTerminalBufferTrimHandler,
      registerFileLinks: (terminal, lineCwds) => {
        const openTerminalFilePath = window.kmux
          .openTerminalFilePath as OpenTerminalFilePathWithBaseCwd;
        return registerTerminalFileLinkProvider({
          terminal,
          getKeyboardPlatform: () => keyboardPlatformRef.current,
          surfaceId,
          openFilePath: (targetSurfaceId, rawPath, baseCwd) =>
            openTerminalFilePath(targetSurfaceId, rawPath, baseCwd),
          getCwdForBufferLine: (bufferLineNumber) =>
            lineCwds.getCwdForLine(bufferLineNumber)
        });
      }
    });

  function rejectPendingDirectResizeAcknowledgements(
    attachId: string | null,
    reason: string
  ): void {
    for (const [requestId, pending] of pendingDirectResizeAcksRef.current) {
      if (attachId && pending.attachId !== attachId) {
        continue;
      }
      pendingDirectResizeAcksRef.current.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
  }

  if (!resizeSyncRef.current) {
    resizeSyncRef.current = createTerminalResizeSync({
      sendResize: (
        surfaceId,
        attachId,
        cols,
        rows,
        gestureActive,
        generation,
        trigger
      ) => {
        const stream = terminalStreamRef.current;
        if (
          stream &&
          !stream.registration.closed &&
          stream.grant.attachId === attachId &&
          stream.grant.session.surfaceId === surfaceId
        ) {
          const requestId = `renderer_resize_${++nextTerminalDirectResizeRequestId}`;
          if (isRendererSmoothnessProfileEnabled()) {
            recordRendererSmoothnessProfileEvent("terminal.resize.transport", {
              paneId: props.paneId,
              surfaceId,
              attachId,
              requestId,
              generation,
              cols,
              rows,
              gestureActive,
              trigger: trigger ?? "unspecified"
            });
          }
          return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingDirectResizeAcksRef.current.delete(requestId);
              reject(
                new Error("terminal direct resize acknowledgement timed out")
              );
            }, TERMINAL_DIRECT_RESIZE_ACK_TIMEOUT_MS);
            pendingDirectResizeAcksRef.current.set(requestId, {
              attachId,
              timeout,
              resolve,
              reject
            });
            try {
              stream.registration.resize(cols, rows, {
                requestId,
                gestureActive
              });
            } catch (error) {
              pendingDirectResizeAcksRef.current.delete(requestId);
              clearTimeout(timeout);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        }
        return Promise.reject(
          new Error("terminal stream is not ready for direct resize")
        );
      }
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

  function sendTerminalText(surfaceId: string, text: string): void {
    const stream = terminalStreamRef.current;
    const sessionId = sessionIdForSurface(surfaceId);
    const diagnosticWrapper = surfaceWrapperRefs.current.get(surfaceId);
    if (
      terminalDiagnosticsEnabledRef.current &&
      activeSurfaceRef.current?.id === surfaceId &&
      terminalRef.current
    ) {
      updateTerminalDiagnostics(surfaceId, terminalRef.current, {
        lastInputAt: terminalDataPlaneNowMs(performance),
        lastInputKind: classifyTerminalTextInput(text),
        lastInputBytes: UTF8_ENCODER.encode(text).byteLength
      });
    }
    if (
      stream?.grant.session.surfaceId === surfaceId &&
      stream.grant.session.sessionId === sessionId &&
      !stream.registration.closed
    ) {
      if (diagnosticWrapper) {
        diagnosticWrapper.dataset.terminalLastInputRoute = "live-stream";
        diagnosticWrapper.dataset.terminalLastInputBytes = String(text.length);
      }
      stream.registration.sendText(text);
      return;
    }
    if (diagnosticWrapper) {
      diagnosticWrapper.dataset.terminalLastInputRoute = "pending-stream";
      diagnosticWrapper.dataset.terminalLastInputBytes = String(text.length);
    }
    if (
      !sessionId ||
      !pendingTerminalStreamInputRef.current.enqueueText(
        surfaceId,
        sessionId,
        text
      )
    ) {
      showAttachmentStatus("Terminal input buffer full");
    }
  }

  function sendTerminalBinary(surfaceId: string, data: string): void {
    const stream = terminalStreamRef.current;
    const sessionId = sessionIdForSurface(surfaceId);
    const diagnosticWrapper = terminalDiagnosticsEnabledRef.current
      ? surfaceWrapperRefs.current.get(surfaceId)
      : undefined;
    if (
      terminalDiagnosticsEnabledRef.current &&
      activeSurfaceRef.current?.id === surfaceId &&
      terminalRef.current
    ) {
      updateTerminalDiagnostics(surfaceId, terminalRef.current, {
        lastInputAt: terminalDataPlaneNowMs(performance),
        lastInputKind: classifyTerminalBinaryInput(data),
        lastInputBytes: data.length
      });
    }
    if (
      stream?.grant.session.surfaceId === surfaceId &&
      stream.grant.session.sessionId === sessionId &&
      !stream.registration.closed
    ) {
      if (diagnosticWrapper) {
        diagnosticWrapper.dataset.terminalLastInputRoute = "live-stream";
        diagnosticWrapper.dataset.terminalLastInputBytes = String(data.length);
      }
      stream.registration.sendBinary(data);
      return;
    }
    if (diagnosticWrapper) {
      diagnosticWrapper.dataset.terminalLastInputRoute = "pending-stream";
      diagnosticWrapper.dataset.terminalLastInputBytes = String(data.length);
    }
    if (
      !sessionId ||
      !pendingTerminalStreamInputRef.current.enqueueBinary(
        surfaceId,
        sessionId,
        data
      )
    ) {
      showAttachmentStatus("Terminal input buffer full");
    }
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

  function focusTerminalInput(
    surfaceId = activeSurfaceRef.current?.id ?? null
  ): void {
    if (terminalDiagnosticsEnabledRef.current) {
      const terminal = terminalRef.current;
      const currentSurface = activeSurfaceRef.current;
      const stream = terminalStreamRef.current;
      const attachedStream =
        currentSurface &&
        stream?.grant.session.surfaceId === currentSurface.id &&
        stream.grant.session.sessionId === currentSurface.sessionId
          ? stream
          : null;
      const observedAt = terminalDataPlaneNowMs(performance);
      if (terminal && currentSurface?.id === surfaceId) {
        updateTerminalDiagnostics(currentSurface.id, terminal, {
          lastFocusEventAt: observedAt,
          lastFocusEvent: "focus-request"
        });
      }
      recordRendererSmoothnessProfileEvent("terminal.focus.lifecycle", {
        event: "focus-request",
        observedAt,
        paneId: props.paneId,
        paneFocused: paneFocusedRef.current,
        requestedSurfaceId: surfaceId,
        surfaceId: currentSurface?.id ?? null,
        sessionId: currentSurface?.sessionId ?? null,
        attachId: attachedStream?.grant.attachId ?? null,
        epoch: attachedStream?.grant.session.epoch ?? null,
        focusEligible: surfaceId ? shouldFocusActiveTerminal(surfaceId) : false,
        documentHasFocus: document.hasFocus(),
        documentVisibility: document.visibilityState,
        activeElementKind: terminalActiveElementKind(
          document.activeElement,
          terminal?.textarea
        ),
        terminalTextareaFocused:
          Boolean(terminal?.textarea) &&
          document.activeElement === terminal?.textarea,
        sendFocusMode: terminal?.modes.sendFocusMode ?? null,
        cols: terminal?.cols ?? null,
        rows: terminal?.rows ?? null
      });
    }

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
      trigger?: string;
    }
  ): boolean {
    const {
      cols,
      rows,
      surfaceId,
      generation,
      previousCols,
      previousRows,
      trigger = "unspecified"
    } = input;
    if (terminal.cols === cols && terminal.rows === rows) {
      return true;
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
        trigger,
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
          trigger,
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
        trigger,
        failed: true,
        durationMs: performance.now() - applyStartedAt
      });
      return false;
    }
  }

  async function fitAndSyncTerminal(
    terminal: Terminal,
    options: {
      fit?: FitAddon | null;
      surfaceId?: string | null;
      force?: boolean;
      triggers?: readonly string[];
    } = {}
  ): Promise<void> {
    const fit = options.fit ?? fitRef.current;
    if (!fit) {
      return;
    }
    const surfaceId = options.surfaceId ?? activeSurfaceRef.current?.id ?? null;
    const requiresActiveSurface = !options.surfaceId;
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    const fitHost = surfaceId
      ? terminalInstanceStore.getTerminalBundle(surfaceId)?.host
      : containerRef.current;
    const fitRect = fitHost?.getBoundingClientRect();
    const diagnosticsEnabled = isRendererSmoothnessProfileEnabled();
    const triggers = diagnosticsEnabled
      ? options.triggers && options.triggers.length > 0
        ? Array.from(new Set(options.triggers))
        : ["unspecified"]
      : undefined;
    const trigger = triggers?.join(",");
    const diagnosticContext = diagnosticsEnabled
      ? {
          triggers,
          hostWidth: fitRect?.width ?? null,
          hostHeight: fitRect?.height ?? null,
          windowInnerWidth:
            typeof window === "undefined" ? null : window.innerWidth,
          windowInnerHeight:
            typeof window === "undefined" ? null : window.innerHeight,
          documentVisibility:
            typeof document === "undefined" ? null : document.visibilityState,
          documentFocused:
            typeof document === "undefined" ? null : document.hasFocus(),
          bufferType: terminal.buffer.active.type,
          viewportY: terminal.buffer.active.viewportY,
          baseY: terminal.buffer.active.baseY
        }
      : undefined;
    const optionsKey = terminalFitOptionsKey(terminal);
    const fitMemo = terminalFitMemosRef.current.get(terminal);
    const syncedSurfaceDimensions = surfaceId
      ? surfaceResizeDimensionsRef.current.get(surfaceId)
      : undefined;
    const surfaceAlreadySynced = Boolean(
      surfaceId &&
      syncedSurfaceDimensions?.cols === previousCols &&
      syncedSurfaceDimensions?.rows === previousRows
    );
    if (
      fitRect &&
      fitMemo &&
      Math.abs(fitMemo.width - fitRect.width) < 0.5 &&
      Math.abs(fitMemo.height - fitRect.height) < 0.5 &&
      fitMemo.cols === previousCols &&
      fitMemo.rows === previousRows &&
      fitMemo.optionsKey === optionsKey &&
      !options.force &&
      (!surfaceId || surfaceAlreadySynced)
    ) {
      if (diagnosticContext) {
        recordRendererSmoothnessProfileEvent("terminal.fit", {
          paneId: props.paneId,
          surfaceId,
          previousCols,
          previousRows,
          cols: previousCols,
          rows: previousRows,
          valid: true,
          changed: false,
          surfaceSynced: surfaceAlreadySynced,
          skipped: true,
          ...diagnosticContext,
          durationMs: 0
        });
      }
      if (surfaceId) {
        syncSurfaceTerminalMetrics(surfaceId, terminal);
      } else {
        syncTerminalMetrics(terminal);
      }
      return;
    }
    const fitStartedAt = performance.now();
    const dims = fit.proposeDimensions();
    const fitDurationMs = performance.now() - fitStartedAt;
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
    if (diagnosticContext) {
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
        ...diagnosticContext,
        durationMs: fitDurationMs
      });
    }
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols <= 0 ||
      dims.rows <= 0
    ) {
      return;
    }
    if (fitRect) {
      terminalFitMemosRef.current.set(terminal, {
        width: fitRect.width,
        height: fitRect.height,
        cols: dims.cols,
        rows: dims.rows,
        optionsKey
      });
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
      const preserveResumeGeometry = Boolean(
        surfaceId &&
        terminalInstanceStore.getLastHydratedSurfaceId(surfaceId) ===
          surfaceId &&
        terminalInstanceStore.getLastHydratedSurfaceSequence(surfaceId) !== null
      );
      if (!preserveResumeGeometry) {
        const resized = applyTerminalResize(terminal, {
          cols: dims.cols,
          rows: dims.rows,
          surfaceId,
          generation,
          previousCols,
          previousRows,
          trigger
        });
        if (!resized && terminalSizeChanged) {
          return;
        }
      }
      if (surfaceId) {
        const sessionId = sessionIdForSurface(surfaceId);
        if (sessionId) {
          pendingTerminalResizeRef.current.set(surfaceId, {
            sessionId,
            cols: dims.cols,
            rows: dims.rows,
            gestureActive: isPaneDividerDragActive(),
            trigger
          });
        }
        if (!preserveResumeGeometry) {
          syncSurfaceTerminalMetrics(surfaceId, terminal);
        }
      } else {
        syncTerminalMetrics(terminal);
      }
      return;
    }
    if (!surfaceId) {
      return;
    }

    const requestStartedAt = diagnosticsEnabled ? performance.now() : null;
    if (diagnosticsEnabled) {
      recordRendererSmoothnessProfileEvent("terminal.resize.request", {
        paneId: props.paneId,
        surfaceId,
        generation,
        previousCols,
        previousRows,
        cols: dims.cols,
        rows: dims.rows,
        triggers,
        attachId
      });
    }
    const resizeResult = await resizeSyncRef.current?.request({
      surfaceId,
      attachId,
      generation,
      cols: dims.cols,
      rows: dims.rows,
      gestureActive: isPaneDividerDragActive(),
      trigger
    });
    if (isRendererSmoothnessProfileEnabled()) {
      recordRendererSmoothnessProfileEvent("terminal.resize.ack", {
        paneId: props.paneId,
        surfaceId,
        generation,
        previousCols,
        previousRows,
        cols: dims.cols,
        rows: dims.rows,
        triggers: triggers ?? ["diagnostics-enabled-after-request"],
        attachId,
        failed: resizeResult?.status === "failed",
        superseded: resizeResult?.status === "superseded",
        durationMs:
          requestStartedAt === null
            ? null
            : performance.now() - requestStartedAt
      });
    }
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
        try {
          if (profileSurfaceId) {
            syncSurfaceTerminalMetrics(profileSurfaceId, terminal);
          } else {
            syncTerminalMetrics(terminal);
          }
        } catch (error) {
          console.warn("Failed to update terminal write metrics", error);
        } finally {
          afterWrite?.();
        }
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
      try {
        const now = performance.now();
        writeProfileBucketRef.current.record(bucketKey, (profile) => {
          profile.queueDepth = Math.max(0, profile.queueDepth - 1);
          profile.maxDurationMs = Math.max(
            profile.maxDurationMs,
            now - startedAt
          );
        });
        syncSurfaceTerminalMetrics(profileSurfaceId, terminal);
      } catch (error) {
        console.warn("Failed to update profiled terminal write metrics", error);
      } finally {
        afterWrite?.();
      }
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
    if (action !== "capture-diagnostics") {
      props.onFocusPane(props.paneId);
      props.onFocusSurface(surfaceId);
    }

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

  useEffect(
    () =>
      subscribeRendererDiagnosticsLogging(() => {
        const enabled = isRendererSmoothnessProfileEnabled();
        terminalDiagnosticsEnabledRef.current = enabled;
        setTerminalDiagnosticsEnabled(enabled);
      }),
    []
  );

  useEffect(() => {
    return window.kmux.subscribeSurfaceContextMenuAction((event) => {
      if (!props.surfaces.some((surface) => surface.id === event.surfaceId)) {
        return;
      }
      surfaceContextActionRef.current(event.surfaceId, event.action);
    });
  }, [props.surfaces]);

  useLayoutEffect(() => {
    const wrapper = surfaceWrapperRefs.current.get(activeSurface.id);
    if (!wrapper) {
      return;
    }
    // Keep the terminal surface alive across tab switches and pane split
    // remounts. Full-screen TUIs keep mouse tracking state inside xterm, so
    // only release this instance when the surface itself is removed.
    const { instance, visibilityPin, isNew } =
      terminalInstanceStore.acquireVisible(terminalInstanceKey, () => ({
        ...createTerminalBundleRef.current(activeSurface.id),
        lastHydratedSurfaceId: null,
        lastHydratedSurfaceSequence: null,
        attachmentCleanup: null,
        attachmentSessionId: null,
        attachmentToken: null,
        readyAttachId: null,
        renderSink: null
      }));
    recordRendererSmoothnessProfileEvent("terminal.data-plane.cache", {
      surfaceId: activeSurface.id,
      isNew,
      lastHydratedSurfaceId: instance.lastHydratedSurfaceId,
      lastHydratedSurfaceSequence: instance.lastHydratedSurfaceSequence
    });
    let checkpointBindingToken: ReturnType<
      SurfaceTerminalCheckpointController["bind"]
    > | null = null;
    instance.checkpointController ??= new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => {
        const current =
          terminalInstanceStore.getTerminalBundle(terminalInstanceKey);
        if (!current) {
          throw new Error("terminal surface was released");
        }
        return current;
      },
      beginCooperativeWrite: (laneId, data, write) =>
        terminalStreamClient.beginCooperativeWrite(laneId, data, write)
    });
    const checkpointController = instance.checkpointController;
    terminalCheckpointControllerRef.current = checkpointController;
    checkpointBindingToken = checkpointController.bind({
      createBundle: () => createTerminalBundleRef.current(activeSurface.id),
      getWrapper: () =>
        surfaceWrapperRefs.current.get(activeSurface.id) ?? null,
      commitBundle: (expected, replacement, checkpoint, swapGeneration) => {
        const currentWrapper = surfaceWrapperRefs.current.get(activeSurface.id);
        if (!currentWrapper) {
          return false;
        }
        const previousHydration = {
          surfaceId:
            terminalInstanceStore.getLastHydratedSurfaceId(terminalInstanceKey),
          sequence:
            terminalInstanceStore.getLastHydratedSurfaceSequence(
              terminalInstanceKey
            )
        };
        const previousInputReady = currentWrapper.dataset.terminalInputReady;
        const previous = terminalInstanceStore.replaceTerminalBundle(
          terminalInstanceKey,
          expected.terminal,
          replacement
        );
        if (!previous) {
          return false;
        }
        try {
          clearWrapperTerminalDiagnostics(
            previous.host.parentNode,
            previous.terminal
          );
          if (previous.host.parentNode === currentWrapper) {
            currentWrapper.replaceChild(replacement.host, previous.host);
          } else {
            previous.host.remove();
            currentWrapper.appendChild(replacement.host);
          }
          containerRef.current = replacement.host;
          terminalRef.current = replacement.terminal;
          fitRef.current = replacement.fit;
          searchRef.current = replacement.search;
          lineCwdsRef.current = replacement.lineCwds;
          renderSinkContextRef.current = {
            terminal: replacement.terminal,
            fit: replacement.fit,
            surfaceId: activeSurface.id
          };
          delete currentWrapper.dataset.terminalInputReady;
          attachTerminalHostToCurrentWrapper(
            activeSurface.id,
            replacement.terminal,
            replacement.host
          );
          refreshTerminalRenderer(replacement.terminal);
          terminalInstanceStore.markSurfaceHydrated(
            terminalInstanceKey,
            activeSurface.id,
            checkpoint.sequence
          );
          updateTerminalDiagnostics(activeSurface.id, replacement.terminal, {
            hydratedSequence: checkpoint.sequence,
            renderedSequence: checkpoint.sequence,
            renderGeneration: swapGeneration,
            lastOnRenderAt: null
          });
          flushSync(() => {
            setTerminalGeneration((generation) => generation + 1);
          });
          return true;
        } catch (error) {
          const rolledBack = terminalInstanceStore.replaceTerminalBundle(
            terminalInstanceKey,
            replacement.terminal,
            previous
          );
          if (rolledBack) {
            terminalInstanceStore.restoreHydrationState(
              terminalInstanceKey,
              previousHydration.surfaceId,
              previousHydration.sequence
            );
            replacement.host.remove();
            currentWrapper.appendChild(previous.host);
            containerRef.current = previous.host;
            terminalRef.current = previous.terminal;
            fitRef.current = previous.fit;
            searchRef.current = previous.search;
            lineCwdsRef.current = previous.lineCwds;
            renderSinkContextRef.current = {
              terminal: previous.terminal,
              fit: previous.fit,
              surfaceId: activeSurface.id
            };
            attachTerminalHostToCurrentWrapper(
              activeSurface.id,
              previous.terminal,
              previous.host
            );
            if (previousInputReady === undefined) {
              delete currentWrapper.dataset.terminalInputReady;
            } else {
              currentWrapper.dataset.terminalInputReady = previousInputReady;
            }
            refreshTerminalRenderer(previous.terminal);
          }
          console.warn("Failed to commit terminal checkpoint", error);
          return false;
        }
      }
    });
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
        surfaceId: activeSurface.id,
        triggers: ["surface-host-acquired"]
      });
    }
    return () => {
      if (checkpointBindingToken) {
        instance.checkpointController?.unbind(checkpointBindingToken);
      }
      const ownedWrapper = wrapper as TerminalHostElement;
      if (ownedWrapper.__kmuxTerminal) {
        clearWrapperTerminalDiagnostics(
          ownedWrapper,
          ownedWrapper.__kmuxTerminal
        );
      }
      if (terminalRef.current === instance.terminal) {
        terminalRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
        lineCwdsRef.current = null;
        containerRef.current = null;
      }
      if (
        terminalCheckpointControllerRef.current ===
        instance.checkpointController
      ) {
        terminalCheckpointControllerRef.current = null;
      }
      terminalInstanceStore.releaseVisibilityPin(
        terminalInstanceKey,
        visibilityPin
      );
    };
  }, [activeSurface.id, terminalInstanceKey]);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const renderListener = terminal.onRender(() => {
      const diagnostics = (containerRef.current as TerminalHostElement | null)
        ?.__kmuxTerminalDiagnostics;
      const renderedAt = terminalDataPlaneNowMs(performance);
      const pendingScreenSequence =
        diagnostics?.lastScreenParsedSequence ?? null;
      const screenRenderPending =
        pendingScreenSequence !== null &&
        (diagnostics?.lastScreenOnRenderSequence === null ||
          diagnostics?.lastScreenOnRenderSequence === undefined ||
          pendingScreenSequence > diagnostics.lastScreenOnRenderSequence);
      updateTerminalDiagnostics(activeSurface.id, terminal, {
        lastOnRenderAt: renderedAt,
        ...(terminalDiagnosticsEnabledRef.current
          ? {
              lastOnRenderSequence:
                diagnostics?.lastParsedSequence ??
                diagnostics?.renderedSequence ??
                null,
              ...(screenRenderPending
                ? {
                    lastScreenOnRenderAt: renderedAt,
                    lastScreenOnRenderSequence: pendingScreenSequence
                  }
                : {})
            }
          : {})
      });
      terminalStreamRef.current?.registration.notifyRendered();
    });
    return () => renderListener.dispose();
  }, [activeSurface.id, terminalGeneration, terminalInstanceKey]);

  useEffect(() => {
    if (!terminalDiagnosticsEnabled) {
      return;
    }
    const terminal = terminalRef.current;
    const terminalTextarea = terminal?.textarea;
    if (!terminal || !terminalTextarea) {
      return;
    }

    const recordLifecycle = (
      event: string,
      target: EventTarget | null = document.activeElement,
      extraDetails: Record<string, unknown> = {}
    ): void => {
      if (
        !terminalDiagnosticsEnabledRef.current ||
        terminalRef.current !== terminal ||
        activeSurfaceRef.current?.id !== activeSurface.id
      ) {
        return;
      }
      const observedAt = terminalDataPlaneNowMs(performance);
      if (
        event !== "diagnostics-snapshot" &&
        event !== "terminal-modes-changed"
      ) {
        updateTerminalDiagnostics(activeSurface.id, terminal, {
          lastFocusEventAt: observedAt,
          lastFocusEvent: event
        });
      }
      const diagnostics = (containerRef.current as TerminalHostElement | null)
        ?.__kmuxTerminalDiagnostics;
      const stream = terminalStreamRef.current;
      const attachedStream =
        stream?.grant.session.surfaceId === activeSurface.id &&
        stream.grant.session.sessionId === activeSurface.sessionId
          ? stream
          : null;
      recordRendererSmoothnessProfileEvent("terminal.focus.lifecycle", {
        event,
        observedAt,
        paneId: props.paneId,
        paneFocused: paneFocusedRef.current,
        surfaceId: activeSurface.id,
        sessionId: activeSurface.sessionId,
        attachId: attachedStream?.grant.attachId ?? null,
        epoch: attachedStream?.grant.session.epoch ?? null,
        documentHasFocus: document.hasFocus(),
        documentVisibility: document.visibilityState,
        activeElementKind: terminalActiveElementKind(
          document.activeElement,
          terminalTextarea
        ),
        targetKind: terminalActiveElementKind(
          target instanceof Element ? target : null,
          terminalTextarea
        ),
        terminalTextareaFocused: document.activeElement === terminalTextarea,
        sendFocusMode: terminal.modes.sendFocusMode,
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
        synchronizedOutputMode: terminal.modes.synchronizedOutputMode,
        bufferType: terminal.buffer.active.type,
        cols: terminal.cols,
        rows: terminal.rows,
        viewportY: terminal.buffer.active.viewportY,
        baseY: terminal.buffer.active.baseY,
        lastWriteAt: diagnostics?.lastWriteAt ?? null,
        lastWriteSequence: diagnostics?.lastWriteSequence ?? null,
        lastParsedAt: diagnostics?.lastParsedAt ?? null,
        lastParsedSequence: diagnostics?.lastParsedSequence ?? null,
        lastOnRenderAt: diagnostics?.lastOnRenderAt ?? null,
        lastOnRenderSequence: diagnostics?.lastOnRenderSequence ?? null,
        lastInputAt: diagnostics?.lastInputAt ?? null,
        lastInputKind: diagnostics?.lastInputKind ?? null,
        ...extraDetails
      });
    };

    const handleWindowFocus = (event: FocusEvent): void =>
      recordLifecycle("window-focus", event.target);
    const handleWindowBlur = (event: FocusEvent): void =>
      recordLifecycle("window-blur", event.target);
    const handleVisibilityChange = (): void =>
      recordLifecycle(`document-${document.visibilityState}`, document);
    const handleTerminalFocus = (event: FocusEvent): void =>
      recordLifecycle("terminal-focus", event.target);
    const handleTerminalBlur = (event: FocusEvent): void =>
      recordLifecycle("terminal-blur", event.target);
    let lastModes = {
      sendFocusMode: terminal.modes.sendFocusMode,
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
      synchronizedOutputMode: terminal.modes.synchronizedOutputMode
    };
    const modeListener = terminal.onWriteParsed(() => {
      const modes = {
        sendFocusMode: terminal.modes.sendFocusMode,
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
        synchronizedOutputMode: terminal.modes.synchronizedOutputMode
      };
      if (
        lastModes.sendFocusMode === modes.sendFocusMode &&
        lastModes.mouseTrackingMode === modes.mouseTrackingMode &&
        lastModes.synchronizedOutputMode === modes.synchronizedOutputMode
      ) {
        return;
      }
      const previousModes = lastModes;
      lastModes = modes;
      recordLifecycle("terminal-modes-changed", terminalTextarea, {
        previousModes,
        modes
      });
    });

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    terminalTextarea.addEventListener("focus", handleTerminalFocus);
    terminalTextarea.addEventListener("blur", handleTerminalBlur);
    recordLifecycle("diagnostics-snapshot");

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      terminalTextarea.removeEventListener("focus", handleTerminalFocus);
      terminalTextarea.removeEventListener("blur", handleTerminalBlur);
      modeListener.dispose();
    };
  }, [
    activeSurface.id,
    activeSurface.sessionId,
    props.focused,
    props.paneId,
    terminalDiagnosticsEnabled,
    terminalGeneration,
    terminalInstanceKey
  ]);

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
        surfaceId: activeSurface.id,
        triggers: ["surface-host-moved"]
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
    // Keep the last authoritative frame visible until the new epoch's
    // checkpoint has parsed in an offscreen xterm and commits atomically.
    terminalCheckpointControllerRef.current?.cancelPending(
      "terminal session changed during checkpoint hydration"
    );
    pendingTerminalResizeRef.current.delete(activeSurface.id);
    terminalInstanceStore.detachAttachment(activeSurface.id);
    terminalInstanceStore.invalidateHydration(terminalInstanceKey);
    updateTerminalDiagnostics(activeSurface.id, terminal, {
      hydratedSequence: null,
      renderedSequence: null,
      lastOnRenderSequence: null,
      lastWriteAt: null,
      lastWriteSequence: null,
      lastParsedAt: null,
      lastParsedSequence: null,
      lastInputAt: null,
      lastInputKind: null,
      lastInputBytes: null,
      lastFocusEventAt: null,
      lastFocusEvent: null
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
            surfaceId: current?.surfaceId ?? initialSurfaceId,
            force: true,
            triggers: ["terminal-render-sink"]
          }
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
    const imeInputController = terminalImeInputControllerRef.current;
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
      if (
        shouldDeferTerminalShortcutToIme(
          event,
          imeInputController.getPhase() === "composing"
        )
      ) {
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
    const imeSettlementTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const replayDeferredImeNavigation = (
      navigationKeys: readonly TerminalImeNavigationKey[]
    ): void => {
      for (const key of navigationKeys) {
        terminal.input(
          resolveTerminalImeNavigationSequence(
            key,
            terminal.modes.applicationCursorKeysMode
          ),
          true
        );
      }
    };
    const handleCompositionStart = (): void => {
      imeInputController.compositionStart(xtermTextarea?.value ?? "");
    };
    const handleCompositionUpdate = (event: CompositionEvent): void => {
      imeInputController.compositionUpdate(event.data);
    };
    const handleCompositionEnd = (event: CompositionEvent): void => {
      const { commitText, settlementId } = imeInputController.compositionEnd(
        xtermTextarea?.value ?? "",
        event.data
      );
      const currentSurface = activeSurfaceRef.current;
      if (props.keyboardPlatform === "linux" && commitText && currentSurface) {
        sendTerminalText(currentSurface.id, commitText);
      }
      // An empty ibus compositionend may still be followed by xterm's one real
      // commit. Leave the textarea intact until the settlement callback in
      // that case; filterData allows that first commit and rejects repeats.
      if (props.keyboardPlatform === "linux" && xtermTextarea && commitText) {
        xtermTextarea.value = "";
      }
      // xterm defers its own compositionend send with setTimeout(0). Run after
      // that callback so macOS can still read Chromium's propagated commit.
      // Once every composition has settled, clear the hidden textarea residue;
      // otherwise a moved textarea caret can make xterm slice the previous
      // Korean character as the next commit.
      const settlementTimeout = setTimeout(() => {
        imeSettlementTimeouts.delete(settlementTimeout);
        const navigationKeys =
          imeInputController.finishComposition(settlementId);
        if (
          xtermTextarea &&
          imeInputController.getPhase() === "idle"
        ) {
          xtermTextarea.value = "";
        }
        replayDeferredImeNavigation(navigationKeys);
      }, 0);
      imeSettlementTimeouts.add(settlementTimeout);
    };
    // Reset stale composition state if focus leaves the textarea (e.g. surface
    // switch, OS-level shortcut) without a matching compositionend.
    const handleTextareaBlur = (): void => {
      for (const timeout of imeSettlementTimeouts) {
        clearTimeout(timeout);
      }
      imeSettlementTimeouts.clear();
      imeInputController.reset();
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
    terminal.attachCustomKeyEventHandler((event) => {
      const action = resolveTerminalImeKeyAction(
        event,
        imeInputController.getPhase(),
        props.keyboardPlatform
      );
      if (action.type === "defer-navigation") {
        imeInputController.deferNavigation(action.key);
      }
      return action.type === "process";
    });
    syncTerminalViewportBackground();
    requestAnimationFrame(() => {
      syncTerminalViewportBackground();
    });
    void fitAndSyncTerminal(terminal, { triggers: ["terminal-mounted"] });
    let pendingThrottledFitTriggers: Set<string> | null = null;
    let dividerFitThrottle: ReturnType<typeof createTerminalDividerFitThrottle>;
    const requestThrottledFit = (trigger?: string): void => {
      if (trigger && isRendererSmoothnessProfileEnabled()) {
        pendingThrottledFitTriggers ??= new Set<string>();
        pendingThrottledFitTriggers.add(trigger);
      }
      dividerFitThrottle.requestFit();
    };
    dividerFitThrottle = createTerminalDividerFitThrottle({
      runFit: () => {
        const triggers = pendingThrottledFitTriggers
          ? Array.from(pendingThrottledFitTriggers)
          : undefined;
        pendingThrottledFitTriggers = null;
        void fitAndSyncTerminal(terminal, {
          force: true,
          triggers: triggers && triggers.length > 0 ? triggers : undefined
        }).catch(() => {
          // ignore resize errors during unmount
        });
      }
    });
    const foregroundFit = installTerminalForegroundFit({
      isActive: () =>
        terminalRef.current === terminal && Boolean(activeSurfaceRef.current),
      shouldCollectTriggers: isRendererSmoothnessProfileEnabled,
      getFitElement: () => containerRef.current,
      fitAndSync: (triggers) => {
        if (!isRendererSmoothnessProfileEnabled()) {
          dividerFitThrottle.requestFit();
          return;
        }
        for (const trigger of triggers) {
          pendingThrottledFitTriggers ??= new Set<string>();
          pendingThrottledFitTriggers.add(`foreground:${trigger}`);
        }
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
        requestThrottledFit("terminal-resize-observer");
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
      requestThrottledFit("pane-divider-drag-ended");
    });

    const disposeData = terminal.onData((data) => {
      const currentSurface = activeSurfaceRef.current;
      if (!currentSurface) {
        return;
      }
      let dataToSend = data;
      if (props.keyboardPlatform === "linux" && !isPastingRef.current) {
        const filteredData = imeInputController.filterData(data);
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
      sendTerminalText(currentSurface.id, rewrite.data);
    });
    const disposeBinary = terminal.onBinary((data) => {
      const currentSurface = activeSurfaceRef.current;
      if (currentSurface) {
        sendTerminalBinary(currentSurface.id, data);
      }
    });
    const disposeWriteParsed = terminal.onWriteParsed(() => {
      syncTerminalMetrics(terminal);
    });
    const disposeScroll = terminal.onScroll(() => {
      syncTerminalMetrics(terminal);
    });
    const inputReadyWrapper = surfaceWrapperRefs.current.get(
      activeSurfaceRef.current?.id ?? ""
    ) as TerminalHostElement | undefined;
    if (inputReadyWrapper?.__kmuxTerminal === terminal) {
      inputReadyWrapper.dataset.terminalInputReady = "true";
    }

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
      disposeBinary.dispose();
      disposeWriteParsed.dispose();
      disposeScroll.dispose();
      if (inputReadyWrapper?.__kmuxTerminal === terminal) {
        delete inputReadyWrapper.dataset.terminalInputReady;
      }
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
      for (const timeout of imeSettlementTimeouts) {
        clearTimeout(timeout);
      }
      imeSettlementTimeouts.clear();
      imeInputController.reset();
      clearPendingEnterRewrite();
    };
  }, [
    props.keyboardPlatform,
    props.paneId,
    terminalGeneration,
    terminalInstanceKey
  ]);

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
    void fitAndSyncTerminal(terminal, {
      triggers: ["terminal-options-changed"]
    });
  }, [
    props.terminalTypography.resolvedFontFamily,
    props.settings.terminalTypography.fontSize,
    props.settings.terminalTypography.lineHeight,
    props.terminalTheme.minimumContrastRatio,
    terminalTheme,
    terminalGeneration,
    terminalInstanceKey
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const checkpointController = terminalCheckpointControllerRef.current;
    if (
      !terminal ||
      !activeSurface ||
      !terminalStreamEligible ||
      !checkpointController
    ) {
      return;
    }
    const surfaceId = activeSurface.id;
    const sessionId = activeSurface.sessionId;
    const instanceKey = terminalInstanceKey;
    let mounted = true;
    let rearmAttempt = 0;
    const attachAbortController = new AbortController();
    let rearmTimer: ReturnType<typeof setTimeout> | null = null;
    let stream: AttachedTerminalStream | null = null;
    let preservePendingInputForReattach = false;
    let attachmentToken: terminalInstanceStore.TerminalAttachmentToken | null =
      null;

    const writeToCurrentTerminal = (
      bundle: TerminalBundle,
      data: string,
      onParsed: () => void
    ): boolean => {
      const sink = terminalInstanceStore.getRenderSink(instanceKey);
      if (sink) {
        return sink.write(data, onParsed, surfaceId);
      }
      if (
        !terminalInstanceStore.isCurrentTerminal(instanceKey, bundle.terminal)
      ) {
        return false;
      }
      bundle.terminal.write(data, onParsed);
      return true;
    };

    const checkpointSink: TerminalStreamSink = {
      beginCheckpoint(metadata, totalBytes) {
        const hydration = checkpointController.beginCheckpoint(
          metadata,
          totalBytes
        );
        return {
          writeChunk: (data) => hydration.writeChunk(data),
          cancel: (reason) => hydration.cancel(reason),
          async commit(digest) {
            const result = await hydration.commit(digest);
            const currentTerminal = checkpointController.currentBundle.terminal;
            surfaceResizeDimensionsRef.current.set(surfaceId, {
              cols: metadata.cols,
              rows: metadata.rows
            });
            updateTerminalDiagnostics(surfaceId, currentTerminal, {
              attachAvailableSequence: metadata.sequence
            });
            return result;
          }
        };
      },
      applyResume(resume) {
        const bundle = checkpointController.currentBundle;
        const currentTerminal = bundle.terminal;
        if (
          currentTerminal.cols !== resume.cols ||
          currentTerminal.rows !== resume.rows
        ) {
          const resized = applyTerminalResize(currentTerminal, {
            cols: resume.cols,
            rows: resume.rows,
            surfaceId,
            generation: ++resizeGenerationRef.current,
            previousCols: currentTerminal.cols,
            previousRows: currentTerminal.rows,
            trigger: "terminal-stream-resume"
          });
          if (!resized) {
            throw new Error("failed to restore terminal resume geometry");
          }
        }
        surfaceResizeDimensionsRef.current.set(surfaceId, {
          cols: resume.cols,
          rows: resume.rows
        });
        syncSurfaceTerminalMetrics(surfaceId, currentTerminal);
        terminalInstanceStore.markSurfaceHydrated(
          instanceKey,
          surfaceId,
          resume.resumedFromSequence
        );
        updateTerminalDiagnostics(surfaceId, bundle.terminal, {
          hydratedSequence: resume.resumedFromSequence,
          renderedSequence: resume.resumedFromSequence,
          attachAvailableSequence: resume.availableSequence
        });
      },
      outputReceived(delta, receivedAt) {
        if (terminalDiagnosticsEnabledRef.current && receivedAt !== null) {
          const screenAffecting = delta.segments.some(
            (segment) =>
              segment.telemetry?.outputKind === "screen" ||
              segment.telemetry?.outputKind === "mixed"
          );
          updateTerminalDiagnostics(
            surfaceId,
            checkpointController.currentBundle.terminal,
            {
              lastReceiveAt: receivedAt,
              lastReceiveSequence: delta.sequence,
              ...(screenAffecting
                ? {
                    lastScreenReceiveAt: receivedAt,
                    lastScreenReceiveSequence: delta.sequence
                  }
                : {})
            }
          );
        }
      },
      write(data, onParsed, context) {
        const bundle = checkpointController.currentBundle;
        const currentTerminal = bundle.terminal;
        const lineCwds = bundle.lineCwds;
        const cwd = cwdAtDataOffset(context.delta, context.dataOffset);
        const screenAffecting = outputRangeAffectsScreen(
          context.delta,
          context.dataOffset,
          data.length
        );
        if (terminalDiagnosticsEnabledRef.current) {
          const writeAt = terminalDataPlaneNowMs(performance);
          updateTerminalDiagnostics(surfaceId, currentTerminal, {
            lastWriteAt: writeAt,
            lastWriteSequence: context.delta.sequence,
            ...(screenAffecting
              ? {
                  lastScreenWriteAt: writeAt,
                  lastScreenWriteSequence: context.delta.sequence
                }
              : {})
          });
        }
        let cwdCursor = cwdWriteCursorsRef.current.get(currentTerminal);
        if (!cwdCursor) {
          cwdCursor = {
            pendingWrites: 0,
            nextStartLine:
              currentTerminal.buffer.active.baseY +
              currentTerminal.buffer.active.cursorY,
            trimmedLineCount: lineCwds.getTrimmedLineCount()
          };
          cwdWriteCursorsRef.current.set(currentTerminal, cwdCursor);
        }
        cwdCursor.pendingWrites += 1;
        const didWrite = writeToCurrentTerminal(bundle, data, () => {
          try {
            const trimmedLineCount = lineCwds.getTrimmedLineCount();
            const trimDuringWrite =
              trimmedLineCount - cwdCursor.trimmedLineCount;
            const startLine = cwdCursor.nextStartLine - trimDuringWrite;
            const endLine =
              currentTerminal.buffer.active.baseY +
              currentTerminal.buffer.active.cursorY;
            cwdCursor.nextStartLine = endLine;
            cwdCursor.trimmedLineCount = trimmedLineCount;
            if (cwd) {
              lineCwds.recordWrite({
                startLine,
                endLine,
                cwd
              });
            }
            if (context.finalPart) {
              terminalInstanceStore.markSurfaceRendered(
                instanceKey,
                surfaceId,
                context.delta.sequence
              );
              const parsedAt = terminalDiagnosticsEnabledRef.current
                ? terminalDataPlaneNowMs(performance)
                : null;
              updateTerminalDiagnostics(surfaceId, currentTerminal, {
                renderedSequence: context.delta.sequence,
                ...(parsedAt !== null
                  ? {
                      lastParsedAt: parsedAt,
                      lastParsedSequence: context.delta.sequence,
                      ...(screenAffecting
                        ? {
                            lastScreenParsedAt: parsedAt,
                            lastScreenParsedSequence: context.delta.sequence
                          }
                        : {})
                    }
                  : {})
              });
            }
          } catch (error) {
            console.warn("Failed to update parsed terminal metadata", error);
          } finally {
            cwdCursor.pendingWrites = Math.max(0, cwdCursor.pendingWrites - 1);
            if (cwdCursor.pendingWrites === 0) {
              cwdWriteCursorsRef.current.delete(currentTerminal);
            }
            onParsed();
          }
        });
        if (!didWrite) {
          cwdCursor.pendingWrites = Math.max(0, cwdCursor.pendingWrites - 1);
          if (cwdCursor.pendingWrites === 0) {
            cwdWriteCursorsRef.current.delete(currentTerminal);
          }
          throw new Error("terminal output target is no longer current");
        }
      },
      resize(delta) {
        const bundle = checkpointController.currentBundle;
        const currentTerminal = bundle.terminal;
        const generation = ++resizeGenerationRef.current;
        const resized = applyTerminalResize(currentTerminal, {
          cols: delta.cols,
          rows: delta.rows,
          surfaceId,
          generation,
          previousCols: currentTerminal.cols,
          previousRows: currentTerminal.rows,
          trigger: "pty-authoritative-resize"
        });
        if (!resized) {
          throw new Error("failed to apply authoritative terminal resize");
        }
        surfaceResizeDimensionsRef.current.set(surfaceId, {
          cols: delta.cols,
          rows: delta.rows
        });
        terminalInstanceStore.markSurfaceRendered(
          instanceKey,
          surfaceId,
          delta.sequence
        );
        updateTerminalDiagnostics(surfaceId, currentTerminal, {
          renderedSequence: delta.sequence
        });
        syncSurfaceTerminalMetrics(surfaceId, currentTerminal);
      },
      resizeAcknowledged(event) {
        const pending = pendingDirectResizeAcksRef.current.get(event.requestId);
        if (!pending || pending.attachId !== event.attachId) {
          return;
        }
        pendingDirectResizeAcksRef.current.delete(event.requestId);
        clearTimeout(pending.timeout);
        pending.resolve();
      },
      exit(event) {
        const bundle = checkpointController.currentBundle;
        return new Promise<void>((resolve) => {
          const message = `\r\n\u001b[31mSession exited${
            typeof event.exitCode === "number" ? ` (${event.exitCode})` : ""
          }\u001b[0m\r\n`;
          if (!writeToCurrentTerminal(bundle, message, resolve)) {
            resolve();
          }
        });
      },
      detached(reason) {
        rejectPendingDirectResizeAcknowledgements(
          stream?.grant.attachId ?? null,
          `terminal stream detached before resize acknowledgement (${reason})`
        );
        checkpointController.cancelPending(
          `terminal stream detached during checkpoint hydration (${reason})`
        );
        const wrapper = surfaceWrapperRefs.current.get(surfaceId);
        delete wrapper?.dataset.terminalStreamReady;
        if (mounted && reason === "replaced") {
          preservePendingInputForReattach = true;
          if (attachmentToken) {
            terminalInstanceStore.clearAttachmentReady(
              surfaceId,
              sessionId,
              attachmentToken
            );
          }
          queueMicrotask(() => {
            if (mounted) {
              setTerminalAttachmentGeneration((generation) => generation + 1);
            }
          });
        }
      },
      reportError(error) {
        console.warn("Terminal data stream failed", {
          surfaceId,
          sessionId,
          error
        });
        void window.kmux
          .reportTerminalStreamError({ surfaceId, sessionId, error })
          .catch((reportingError) => {
            console.warn("Terminal stream diagnostics report failed", {
              surfaceId,
              sessionId,
              error: reportingError
            });
          });
        if (mounted) {
          showAttachmentStatus("Terminal stream interrupted");
        }
      }
    };

    const cleanupAttachment = (): void => {
      if (rearmTimer) {
        clearTimeout(rearmTimer);
        rearmTimer = null;
      }
      attachAbortController.abort();
      if (!mounted) {
        return;
      }
      const currentStream = stream;
      mounted = false;
      rejectPendingDirectResizeAcknowledgements(
        currentStream?.grant.attachId ?? null,
        "terminal stream closed before resize acknowledgement"
      );
      terminalInstanceStore.clearAttachment(surfaceId, cleanupAttachment);
      if (terminalStreamRef.current === currentStream) {
        terminalStreamRef.current = null;
      }
      if (currentStream) {
        const settlementPin =
          terminalInstanceStore.acquireSettlementPin(instanceKey);
        void terminalStreamClient
          .detach(currentStream, "hidden")
          .finally(() => {
            if (settlementPin) {
              terminalInstanceStore.releaseVisibilityPin(
                instanceKey,
                settlementPin
              );
            }
          });
      }
      const currentSurface = activeSurfaceRef.current;
      if (
        !preservePendingInputForReattach ||
        currentSurface?.id !== surfaceId ||
        currentSurface.sessionId !== sessionId
      ) {
        pendingTerminalStreamInputRef.current.discard();
      }
      const wrapper = surfaceWrapperRefs.current.get(surfaceId);
      if (
        wrapper &&
        wrapper.dataset.terminalStreamReady === currentStream?.grant.attachId
      ) {
        delete wrapper.dataset.terminalStreamReady;
      }
    };

    const scheduleAttachRearm = (retry: () => void): void => {
      if (!mounted || attachAbortController.signal.aborted || rearmTimer) {
        return;
      }
      const delay = Math.min(
        TERMINAL_ATTACH_REARM_INITIAL_DELAY_MS * 2 ** Math.min(rearmAttempt, 5),
        TERMINAL_ATTACH_REARM_MAX_DELAY_MS
      );
      rearmAttempt += 1;
      rearmTimer = setTimeout(() => {
        rearmTimer = null;
        if (mounted && !attachAbortController.signal.aborted) {
          retry();
        }
      }, delay);
    };

    const existingSessionId =
      terminalInstanceStore.getAttachmentSessionId(surfaceId);
    if (existingSessionId) {
      // A pane move can briefly mount the new owner before React unmounts the
      // old one. Transfer the surface-scoped claim now; TerminalStreamClient
      // defers the final close to a microtask, so the new claim reuses the
      // same direct port without dropping output.
      terminalInstanceStore.detachAttachment(surfaceId);
    }
    attachmentToken = terminalInstanceStore.registerAttachment(
      surfaceId,
      sessionId,
      cleanupAttachment
    );
    if (!attachmentToken) {
      return;
    }
    updateTerminalDiagnostics(surfaceId, terminal, {
      attachAvailableSequence: null
    });

    const attachStream = (): void => {
      void terminalStreamClient
        .attachWithRetryOutcome({
          surfaceId,
          expectedSessionId: sessionId,
          sink: checkpointSink,
          signal: attachAbortController.signal,
          resumeFromSequence: () =>
            terminalInstanceStore.getLastHydratedSurfaceId(instanceKey) ===
            surfaceId
              ? (terminalInstanceStore.getLastHydratedSurfaceSequence(
                  instanceKey
                ) ?? undefined)
              : undefined,
          shouldWriteImmediately: () => {
            const currentTerminal = checkpointController.currentBundle.terminal;
            return (
              currentTerminal.buffer.active.type === "alternate" ||
              currentTerminal.buffer.active.viewportY <
                currentTerminal.buffer.active.baseY ||
              currentTerminal.modes.mouseTrackingMode !== "none" ||
              currentTerminal.modes.synchronizedOutputMode
            );
          },
          invalidateResume: () =>
            terminalInstanceStore.invalidateHydration(instanceKey)
        })
        .then((outcome) => {
          if (outcome.status !== "attached") {
            if (
              outcome.status === "retryable-not-ready" &&
              mounted &&
              !attachAbortController.signal.aborted &&
              activeSurfaceRef.current?.id === surfaceId &&
              activeSurfaceRef.current.sessionId === sessionId &&
              activeSurfaceRef.current.sessionState === "running"
            ) {
              scheduleAttachRearm(attachStream);
            } else {
              pendingTerminalStreamInputRef.current.discard();
              if (outcome.status === "denied" && mounted) {
                showAttachmentStatus("Terminal stream unavailable");
                terminalInstanceStore.detachAttachment(surfaceId);
              }
            }
            return;
          }
          const attachedStream = outcome.stream;
          if (!mounted) {
            pendingTerminalStreamInputRef.current.discard();
            terminalStreamClient.detach(attachedStream, "hidden");
            return;
          }
          rearmAttempt = 0;
          stream = attachedStream;
          terminalStreamRef.current = attachedStream;
          const wrapper = surfaceWrapperRefs.current.get(surfaceId);
          if (wrapper) {
            wrapper.dataset.terminalStreamReady = attachedStream.grant.attachId;
          }
          pendingTerminalStreamInputRef.current.flush(attachedStream);
          let attachmentReady = false;
          if (attachmentToken) {
            attachmentReady = terminalInstanceStore.markAttachmentReady(
              surfaceId,
              sessionId,
              attachedStream.grant.attachId,
              attachmentToken
            );
          }
          if (!attachmentReady) {
            throw new Error("terminal attachment became stale before ready");
          }
          const pendingResize = pendingTerminalResizeRef.current.get(surfaceId);
          if (pendingResize?.sessionId === sessionId) {
            pendingTerminalResizeRef.current.delete(surfaceId);
            void resizeSyncRef.current?.request({
              surfaceId,
              attachId: attachedStream.grant.attachId,
              generation: ++resizeGenerationRef.current,
              cols: pendingResize.cols,
              rows: pendingResize.rows,
              gestureActive: pendingResize.gestureActive,
              trigger: pendingResize.trigger
            });
          } else {
            pendingTerminalResizeRef.current.delete(surfaceId);
            surfaceResizeDimensionsRef.current.delete(surfaceId);
            const currentBundle = checkpointController.currentBundle;
            void fitAndSyncTerminalRef.current(currentBundle.terminal, {
              fit: currentBundle.fit,
              surfaceId,
              force: true,
              triggers: ["terminal-stream-attached"]
            });
          }
          if (shouldFocusActiveTerminal(surfaceId)) {
            focusTerminalInput(surfaceId);
          }
        })
        .catch((error) => {
          pendingTerminalStreamInputRef.current.discard();
          console.warn("Failed to attach terminal data stream", error);
          if (mounted) {
            terminalInstanceStore.detachAttachment(surfaceId);
          }
        });
    };
    attachStream();

    return cleanupAttachment;
  }, [
    activeSurface?.id,
    activeSurface?.sessionId,
    terminalStreamEligible,
    terminalAttachmentGeneration,
    terminalInstanceKey
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
  }, [props.showSearch, query, terminalSearchDecorations, terminalGeneration]);

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

  useLayoutEffect(() => {
    if (!shouldFocusActiveTerminal(activeSurface.id)) {
      return;
    }
    focusTerminalInput();
  }, [
    activeSurface.id,
    props.focused,
    props.showSearch,
    props.focusRequest,
    terminalGeneration
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
    try {
      const context = await surfaceMenuContextFor(surface);
      await window.kmux.showSurfaceContextMenu(surfaceId, x, y, context);
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
        {storageStatusMessage ? (
          <div
            className={styles.storageStatus}
            data-storage-state={activeSurface.storageStatus?.state}
            role="status"
            aria-live="polite"
          >
            {storageStatusMessage}
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
    </div>
  );
}

function remoteStorageStatusMessage(
  status: SurfaceVm["storageStatus"]
): string | null {
  if (!status || status.state === "normal") {
    return null;
  }
  if (status.state === "backpressured") {
    return "Remote storage is unavailable or too slow. Terminal output is paused until durable journaling recovers.";
  }
  const bufferedMiB = (status.emergencyBytes / (1024 * 1024)).toFixed(2);
  return `Remote storage is degraded. ${bufferedMiB} MiB of the 4 MiB emergency buffer is awaiting durable journal admission.`;
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
  return filesFromItems.length
    ? filesFromItems
    : Array.from(dataTransfer.files);
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
