import type { BrowserWindow } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { terminalSessionForSurface, type AppState } from "@kmux/core";
import type {
  Id,
  SurfaceCaptureDiagnosticsWriterHealth,
  SurfaceCaptureOptions,
  SurfaceCapturePayload,
  SurfaceCaptureRendererPayload,
  SurfaceCaptureSnapshotAttempt,
  SurfaceCaptureSnapshotAttemptKind,
  SurfaceCaptureSnapshotDiagnostics,
  SurfaceSnapshotPayload,
  Uint64
} from "@kmux/proto";
import { formatUint64Decimal, isoNow } from "@kmux/proto";

import { assessContentConsistency } from "./surfaceCaptureConsistency";
import { stringifyJson } from "../shared/json";

const DEFAULT_CAPTURE_TIMEOUT_MS = 3000;
const IMMEDIATE_SNAPSHOT_TIMEOUT_MS = 1000;
const RAW_OUTPUT_TAIL_PREVIEW_CHARS = 4000;

interface SurfaceCaptureServiceOptions {
  captureRoot: string;
  getState: () => AppState;
  getWindow: () => BrowserWindow | null;
  snapshotSurface: (
    surfaceId: Id,
    options?: SurfaceCaptureOptions
  ) => Promise<SurfaceSnapshotPayload | null>;
  flushDiagnostics?: () => Promise<void>;
  getDiagnosticsWriterHealth?: () => SurfaceCaptureDiagnosticsWriterHealth | null;
  getDiagnosticsLogPath?: () => string | undefined;
}

export interface SurfaceCaptureService {
  captureSurface(
    surfaceId: Id,
    options?: SurfaceCaptureOptions
  ): Promise<SurfaceCapturePayload>;
}

export function createSurfaceCaptureService(
  options: SurfaceCaptureServiceOptions
): SurfaceCaptureService {
  async function captureSurface(
    surfaceId: Id,
    captureOptions: SurfaceCaptureOptions = {}
  ): Promise<SurfaceCapturePayload> {
    const state = options.getState();
    const surface = state.surfaces[surfaceId];
    if (!surface) {
      throw new Error(`Unknown surface: ${surfaceId}`);
    }

    const capturedAt = isoNow();
    mkdirSync(options.captureRoot, { recursive: true, mode: 0o700 });
    const outDir = mkdtempSync(
      join(
        options.captureRoot,
        `${capturedAt.replace(/[:.]/g, "-")}-${safePathSegment(surfaceId)}-`
      )
    );

    const { snapshot, diagnostics: snapshotDiagnostics } =
      await captureSnapshotWithFallback(
        options.snapshotSurface,
        surfaceId,
        captureOptions
      );
    const snapshotCompletedAt = isoNow();
    await options.flushDiagnostics?.();
    const diagnosticsErrors: string[] = [];
    const diagnosticsLogPath = copyOptionalFile({
      sourcePath: options.getDiagnosticsLogPath?.(),
      targetPath: join(outDir, "kmux-debug.log"),
      label: "diagnostics log",
      errors: diagnosticsErrors
    });
    const diagnosticsHealth = {
      mainWriter: options.getDiagnosticsWriterHealth?.() ?? null,
      ptyHost: snapshot?.diagnosticsHealth ?? null,
      ...(diagnosticsErrors.length > 0
        ? { diagnosticsLogCopyError: diagnosticsErrors.join(" | ") }
        : {})
    };
    const window = options.getWindow();
    const rendererTimeoutMs = normalizeDuration(
      captureOptions.timeoutMs,
      DEFAULT_CAPTURE_TIMEOUT_MS
    );
    const renderer = await captureRenderer(
      window,
      surfaceId,
      snapshot?.sequence ?? null,
      rendererTimeoutMs
    );
    const rendererCompletedAt = isoNow();

    const screenshotSkipReason = renderer.dom
      ? !renderer.dom.surfaceActive
        ? "inactive-surface"
        : !renderer.dom.surfaceVisible
          ? "surface-not-visible"
          : null
      : "renderer-unavailable";
    const screenshotPath =
      screenshotSkipReason === null && renderer.dom
        ? await captureScreenshot(window, renderer.dom.rootRect, outDir)
        : undefined;
    const screenshotDiagnostics = {
      sourceSurfaceId: screenshotPath ? surfaceId : null,
      trusted: screenshotPath ? true : null,
      skippedReason:
        screenshotSkipReason ??
        (screenshotPath === undefined ? "capture-unavailable" : null)
    } as const;
    const screenshotCompletedAt =
      screenshotPath === undefined ? undefined : isoNow();
    const contentConsistency = assessContentConsistency({
      snapshotVt: snapshot?.vt,
      snapshotScreenRows: snapshot?.rows,
      rendererRecentText: renderer.dom?.recentText
    });
    const rendererBufferTrusted = renderer.dom
      ? renderer.dom.bufferSource === "active-live" &&
        (!renderer.dom.terminalDiagnostics.waitTimedOut ||
          contentConsistency.verdict === "consistent")
      : null;
    const textPath = join(outDir, "terminal.txt");
    const jsonPath = join(outDir, "capture.json");
    const rawOutputTailPath =
      snapshot?.rawOutputTail === undefined
        ? undefined
        : join(outDir, "pty-raw-tail.txt");
    const rawOutputHistory = copyRawOutputHistory(snapshot, outDir);
    const session = terminalSessionForSurface(state, surfaceId);
    if (!session) {
      throw new Error("surface capture requires a Terminal Surface");
    }

    const payload: SurfaceCapturePayload = {
      surfaceId,
      sessionId: session.id,
      workspaceId: resolveWorkspaceId(state, surface.paneId),
      paneId: surface.paneId,
      capturedAt,
      outDir,
      files: {
        json: jsonPath,
        text: textPath,
        screenshot: screenshotPath,
        rawOutputTail: rawOutputTailPath,
        rawOutputLog: rawOutputHistory.rawOutputLogPath,
        rawOutputIndex: rawOutputHistory.rawOutputIndexPath,
        diagnosticsLog: diagnosticsLogPath
      },
      snapshot,
      snapshotDiagnostics,
      rawOutputCopyErrors: rawOutputHistory.errors,
      diagnosticsHealth,
      renderer,
      timings: {
        snapshotCompletedAt,
        rendererCompletedAt,
        ...(screenshotCompletedAt !== undefined
          ? { screenshotCompletedAt }
          : {})
      },
      screenshotDiagnostics,
      contentConsistency,
      rendererBufferTrusted,
      rendererTrusted: rendererBufferTrusted
    };

    if (rawOutputTailPath !== undefined) {
      writeFileSync(rawOutputTailPath, snapshot?.rawOutputTail ?? "", "utf8");
    }
    writeFileSync(textPath, formatCaptureText(payload), "utf8");
    writeFileSync(jsonPath, stringifyJson(payload, 2), "utf8");

    return payload;
  }

  return { captureSurface };
}

function resolveWorkspaceId(state: AppState, paneId: Id): Id | undefined {
  return state.panes[paneId]?.workspaceId;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function copyRawOutputHistory(
  snapshot: SurfaceSnapshotPayload | null,
  outDir: string
): {
  rawOutputLogPath?: string;
  rawOutputIndexPath?: string;
  errors?: string[];
} {
  const errors: string[] = [];
  const rawOutputLogPath = copyOptionalFile({
    sourcePath: snapshot?.rawOutputLogPath,
    targetPath: join(outDir, "pty-raw-stream.ansi"),
    label: "raw output log",
    errors
  });
  const rawOutputIndexPath = copyOptionalFile({
    sourcePath: snapshot?.rawOutputIndexPath,
    targetPath: join(outDir, "pty-raw-index.jsonl"),
    label: "raw output index",
    errors
  });

  return {
    rawOutputLogPath,
    rawOutputIndexPath,
    ...(errors.length > 0 ? { errors } : {})
  };
}

function copyOptionalFile({
  sourcePath,
  targetPath,
  label,
  errors
}: {
  sourcePath: string | undefined;
  targetPath: string;
  label: string;
  errors: string[];
}): string | undefined {
  if (!sourcePath) {
    return undefined;
  }
  try {
    if (!existsSync(sourcePath)) {
      errors.push(`${label} source does not exist: ${sourcePath}`);
      return undefined;
    }
    copyFileSync(sourcePath, targetPath);
    return targetPath;
  } catch (error) {
    errors.push(
      `${label} copy failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function captureSnapshotWithFallback(
  snapshotSurface: SurfaceCaptureServiceOptions["snapshotSurface"],
  surfaceId: Id,
  captureOptions: SurfaceCaptureOptions
): Promise<{
  snapshot: SurfaceSnapshotPayload | null;
  diagnostics: SurfaceCaptureSnapshotDiagnostics;
}> {
  const attempts: SurfaceCaptureSnapshotAttempt[] = [];
  const settleForMs = normalizeDuration(captureOptions.settleForMs, 0);
  const timeoutMs = normalizeDuration(
    captureOptions.timeoutMs,
    DEFAULT_CAPTURE_TIMEOUT_MS
  );

  const firstKind: SurfaceCaptureSnapshotAttemptKind =
    settleForMs > 0 ? "settled" : "immediate";
  const firstSnapshot = await attemptSnapshot({
    snapshotSurface,
    surfaceId,
    attempts,
    kind: firstKind,
    settleForMs,
    timeoutMs
  });
  if (firstSnapshot) {
    return {
      snapshot: firstSnapshot,
      diagnostics: {
        selected: firstKind,
        attempts
      }
    };
  }

  if (settleForMs <= 0) {
    return {
      snapshot: null,
      diagnostics: {
        selected: "unavailable",
        attempts
      }
    };
  }

  const immediateTimeoutMs = Math.min(timeoutMs, IMMEDIATE_SNAPSHOT_TIMEOUT_MS);
  const immediateSnapshot = await attemptSnapshot({
    snapshotSurface,
    surfaceId,
    attempts,
    kind: "immediate",
    settleForMs: 0,
    timeoutMs: immediateTimeoutMs
  });

  return {
    snapshot: immediateSnapshot,
    diagnostics: {
      selected: immediateSnapshot ? "immediate" : "unavailable",
      attempts
    }
  };
}

async function attemptSnapshot({
  snapshotSurface,
  surfaceId,
  attempts,
  kind,
  settleForMs,
  timeoutMs
}: {
  snapshotSurface: SurfaceCaptureServiceOptions["snapshotSurface"];
  surfaceId: Id;
  attempts: SurfaceCaptureSnapshotAttempt[];
  kind: SurfaceCaptureSnapshotAttemptKind;
  settleForMs: number;
  timeoutMs: number;
}): Promise<SurfaceSnapshotPayload | null> {
  try {
    const snapshot = await snapshotSurface(surfaceId, {
      settleForMs,
      timeoutMs,
      includeRawOutputTail: true
    });
    attempts.push({
      kind,
      settleForMs,
      timeoutMs,
      status: snapshot ? "ok" : "unavailable",
      ...(snapshot ? { sequence: snapshot.sequence } : {})
    });
    return snapshot;
  } catch (error) {
    attempts.push({
      kind,
      settleForMs,
      timeoutMs,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function normalizeDuration(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, value);
}

async function captureRenderer(
  window: BrowserWindow | null,
  surfaceId: Id,
  targetSequence: Uint64 | null,
  timeoutMs: number | undefined
): Promise<SurfaceCaptureRendererPayload> {
  if (!window || window.isDestroyed()) {
    return { ok: false, error: "No live BrowserWindow is available" };
  }

  try {
    const script = createRendererCaptureScript(
      surfaceId,
      targetSequence,
      timeoutMs
    );
    return (await window.webContents.executeJavaScript(
      script,
      true
    )) as SurfaceCaptureRendererPayload;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function captureScreenshot(
  window: BrowserWindow | null,
  rect: { x: number; y: number; width: number; height: number },
  outDir: string
): Promise<string | undefined> {
  if (!window || window.isDestroyed()) {
    return undefined;
  }

  const bounds = {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height))
  };
  const image = await window.webContents.capturePage(bounds);
  const screenshotPath = join(outDir, "terminal.png");
  writeFileSync(screenshotPath, image.toPNG());
  return screenshotPath;
}

function createRendererCaptureScript(
  surfaceId: Id,
  targetSequence: Uint64 | null,
  timeoutMs: number | undefined
): string {
  const targetSequenceExpression =
    targetSequence === null
      ? "null"
      : `BigInt(${JSON.stringify(formatUint64Decimal(targetSequence))})`;
  return `(async () => {
    const surfaceId = ${JSON.stringify(surfaceId)};
    const targetSequence = ${targetSequenceExpression};
    const timeoutMs = ${JSON.stringify(timeoutMs ?? 1000)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextPaint = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const root = document.querySelector('[data-testid="terminal-' + CSS.escape(surfaceId) + '"]');
    const rectToJson = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    });
    const readSequenceValue = (value) =>
      typeof value === 'bigint' && value >= 0n ? value : null;
    const readFiniteNumberValue = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const readStringValue = (value) =>
      typeof value === 'string' ? value : null;
    const readAttrSequence = (attr) => {
      // Missing attributes must stay null: Number(null) is 0 and would turn
      // "diagnostics never initialized" into a plausible-looking sequence.
      if (attr === null || attr === undefined || attr === '') {
        return null;
      }
      if (!/^(?:0|[1-9][0-9]*)$/.test(attr)) {
        return null;
      }
      try {
        return BigInt(attr);
      } catch {
        return null;
      }
    };
    const findTerminalHost = (root) =>
      Array.from(root.children).find((child) => child.__kmuxTerminal);
    const readPropSequences = (element) => {
      const diagnostics = element ? element.__kmuxTerminalDiagnostics : null;
      if (!diagnostics) {
        return null;
      }
      return {
        hydratedSequence: readSequenceValue(diagnostics.hydratedSequence),
        renderedSequence: readSequenceValue(diagnostics.renderedSequence)
      };
    };
    const readDatasetSequences = (element) => {
      if (!element) {
        return null;
      }
      const hydratedSequence = readAttrSequence(
        element.getAttribute('data-terminal-hydrated-sequence')
      );
      const renderedSequence = readAttrSequence(
        element.getAttribute('data-terminal-rendered-sequence')
      );
      if (hydratedSequence === null && renderedSequence === null) {
        return null;
      }
      return { hydratedSequence, renderedSequence };
    };
    const readStoreSequences = () => {
      try {
        const read = window.__kmuxTerminalStoreDiagnostics;
        return read ? (read(surfaceId) ?? null) : null;
      } catch {
        return null;
      }
    };
    const readDiagnosticSources = (root) => ({
      wrapperProp: readPropSequences(root),
      hostProp: readPropSequences(findTerminalHost(root)),
      wrapperDataset: readDatasetSequences(root),
      store: readStoreSequences()
    });
    const maxSequence = (current, next) => {
      if (next === null) {
        return current;
      }
      return current === null || next > current ? next : current;
    };
    // Sequences are monotonic per session, so the freshest source wins; a
    // stale element copy must not mask progress the store has recorded.
    const readDiagnostics = (root) => {
      const sources = readDiagnosticSources(root);
      let hydratedSequence = null;
      let renderedSequence = null;
      for (const candidate of [
        sources.wrapperProp,
        sources.hostProp,
        sources.wrapperDataset
      ]) {
        if (!candidate) {
          continue;
        }
        hydratedSequence = maxSequence(
          hydratedSequence,
          candidate.hydratedSequence
        );
        renderedSequence = maxSequence(
          renderedSequence,
          candidate.renderedSequence
        );
      }
      if (sources.store && sources.store.lastHydratedSurfaceId === surfaceId) {
        renderedSequence = maxSequence(
          renderedSequence,
          readSequenceValue(sources.store.lastHydratedSurfaceSequence)
        );
      }
      return { hydratedSequence, renderedSequence, sources };
    };
    if (!root) {
      return {
        ok: false,
        error: 'Terminal root not found for surface ' + surfaceId
      };
    }
    const pane = root.closest('[data-pane-id]');
    const activeSurfaceId = pane
      ? readStringValue(pane.getAttribute('data-active-surface-id'))
      : null;
    const surfaceActive =
      root.getAttribute('data-active') === 'true' &&
      activeSurfaceId === surfaceId;
    const initialRootRect = root.getBoundingClientRect();
    const rootStyle = window.getComputedStyle(root);
    const surfaceVisible =
      surfaceActive &&
      rootStyle.visibility !== 'hidden' &&
      rootStyle.display !== 'none' &&
      initialRootRect.width > 0 &&
      initialRootRect.height > 0;
    const waitSkippedReason = surfaceActive
      ? (surfaceVisible ? null : 'surface-not-visible')
      : 'inactive-surface';
    const waitStartedAt = performance.now();
    const deadline = waitStartedAt + Math.max(0, timeoutMs);
    let waitTimedOut = false;
    if (surfaceVisible && typeof targetSequence === 'bigint') {
      while (performance.now() < deadline) {
        const diagnostics = readDiagnostics(root);
        if (
          diagnostics.renderedSequence !== null &&
          diagnostics.renderedSequence >= targetSequence
        ) {
          break;
        }
        await sleep(16);
      }
      const diagnostics = readDiagnostics(root);
      waitTimedOut =
        diagnostics.renderedSequence === null ||
        diagnostics.renderedSequence < targetSequence;
    }
    const waitDurationMs = Math.round(performance.now() - waitStartedAt);
    if (surfaceVisible) {
      await nextPaint();
    }
    const attrs = {};
    for (const attr of Array.from(root.attributes)) {
      if (attr.name.startsWith('data-terminal-')) {
        attrs[attr.name] = attr.value;
      }
    }
    const rows = Array.from(root.querySelectorAll('.xterm-rows > div')).map((row, index) => ({
      index,
      text: row.textContent || '',
      rect: rectToJson(row.getBoundingClientRect())
    }));
    const terminalHost = findTerminalHost(root);
    const terminal = root.__kmuxTerminal || (terminalHost ? terminalHost.__kmuxTerminal : undefined);
    const diagnosticMetadataSources = [
      terminalHost ? terminalHost.__kmuxTerminalDiagnostics : null,
      root.__kmuxTerminalDiagnostics || null
    ].filter(Boolean);
    const latestDiagnosticMetadata = (timestampKey) => {
      let latest = diagnosticMetadataSources[0] || null;
      let latestAt = latest
        ? (readFiniteNumberValue(latest[timestampKey]) ?? -Infinity)
        : -Infinity;
      for (const candidate of diagnosticMetadataSources.slice(1)) {
        const candidateAt =
          readFiniteNumberValue(candidate[timestampKey]) ?? -Infinity;
        if (candidateAt > latestAt) {
          latest = candidate;
          latestAt = candidateAt;
        }
      }
      return latest;
    };
    const focusMetadata = latestDiagnosticMetadata('lastFocusEventAt');
    const inputMetadata = latestDiagnosticMetadata('lastInputAt');
    const receiveMetadata = latestDiagnosticMetadata('lastReceiveAt');
    const screenReceiveMetadata = latestDiagnosticMetadata('lastScreenReceiveAt');
    const writeMetadata = latestDiagnosticMetadata('lastWriteAt');
    const screenWriteMetadata = latestDiagnosticMetadata('lastScreenWriteAt');
    const parsedMetadata = latestDiagnosticMetadata('lastParsedAt');
    const screenParsedMetadata = latestDiagnosticMetadata('lastScreenParsedAt');
    const renderMetadata = latestDiagnosticMetadata('lastOnRenderAt');
    const screenRenderMetadata = latestDiagnosticMetadata('lastScreenOnRenderAt');
    const terminalDiagnostics = {
      ...readDiagnostics(root),
      targetSequence,
      waitTimedOut,
      waitSkippedReason,
      waitDurationMs
    };
    const terminalTextarea = terminal ? terminal.textarea : null;
    const activeElementKind = (() => {
      const element = document.activeElement;
      if (!element) return 'none';
      if (element === terminalTextarea) return 'terminal-textarea';
      if (element === document.body) return 'body';
      if (element instanceof HTMLInputElement) return 'input';
      if (element instanceof HTMLTextAreaElement) return 'textarea';
      if (element instanceof HTMLButtonElement) return 'button';
      if (element instanceof HTMLAnchorElement) return 'link';
      return element instanceof HTMLElement
        ? element.tagName.toLowerCase()
        : 'other';
    })();
    const paneFocusedAttr = pane ? pane.getAttribute('data-focused') : null;
    const interactionDiagnostics = {
      visibilityState: document.visibilityState,
      paneFocused:
        paneFocusedAttr === 'true'
          ? true
          : paneFocusedAttr === 'false'
            ? false
            : null,
      activeElementKind,
      terminalTextareaFocused:
        Boolean(terminalTextarea) && document.activeElement === terminalTextarea,
      sendFocusMode:
        terminal && terminal.modes
          ? Boolean(terminal.modes.sendFocusMode)
          : null,
      mouseTrackingMode:
        terminal && terminal.modes
          ? readStringValue(terminal.modes.mouseTrackingMode)
          : null,
      synchronizedOutputMode:
        terminal && terminal.modes
          ? Boolean(terminal.modes.synchronizedOutputMode)
          : null,
      attachId: root.getAttribute('data-terminal-stream-ready'),
      inputReady: root.getAttribute('data-terminal-input-ready') === 'true',
      lastFocusEvent: readStringValue(focusMetadata?.lastFocusEvent),
      lastFocusEventAt: readFiniteNumberValue(focusMetadata?.lastFocusEventAt),
      lastInputKind: readStringValue(inputMetadata?.lastInputKind),
      lastInputAt: readFiniteNumberValue(inputMetadata?.lastInputAt),
      lastInputBytes: readFiniteNumberValue(inputMetadata?.lastInputBytes),
      lastInputRoute: root.getAttribute('data-terminal-last-input-route'),
      lastReceiveAt: readFiniteNumberValue(receiveMetadata?.lastReceiveAt),
      lastReceiveSequence: readSequenceValue(receiveMetadata?.lastReceiveSequence),
      lastScreenReceiveAt: readFiniteNumberValue(screenReceiveMetadata?.lastScreenReceiveAt),
      lastScreenReceiveSequence: readSequenceValue(screenReceiveMetadata?.lastScreenReceiveSequence),
      lastWriteAt: readFiniteNumberValue(writeMetadata?.lastWriteAt),
      lastWriteSequence: readSequenceValue(writeMetadata?.lastWriteSequence),
      lastScreenWriteAt: readFiniteNumberValue(screenWriteMetadata?.lastScreenWriteAt),
      lastScreenWriteSequence: readSequenceValue(screenWriteMetadata?.lastScreenWriteSequence),
      lastParsedAt: readFiniteNumberValue(parsedMetadata?.lastParsedAt),
      lastParsedSequence: readSequenceValue(parsedMetadata?.lastParsedSequence),
      lastScreenParsedAt: readFiniteNumberValue(screenParsedMetadata?.lastScreenParsedAt),
      lastScreenParsedSequence: readSequenceValue(screenParsedMetadata?.lastScreenParsedSequence),
      lastOnRenderAt: readFiniteNumberValue(renderMetadata?.lastOnRenderAt),
      lastOnRenderSequence: readSequenceValue(renderMetadata?.lastOnRenderSequence),
      lastScreenOnRenderAt: readFiniteNumberValue(screenRenderMetadata?.lastScreenOnRenderAt),
      lastScreenOnRenderSequence: readSequenceValue(screenRenderMetadata?.lastScreenOnRenderSequence)
    };
    let bufferRows = [];
    let bottomRows = [];
    let bufferState = null;
    let scroll = null;
    let recentText = '';
    if (terminal && terminal.buffer && terminal.buffer.active) {
      const buffer = terminal.buffer.active;
      const readBufferWindow = (startY) =>
        Array.from({ length: terminal.rows }, (_, index) => {
          const absoluteY = startY + index;
          const line = buffer.getLine(absoluteY);
          return {
            index,
            absoluteY,
            text: line ? line.translateToString(true) : '',
            isWrapped: Boolean(line && line.isWrapped)
          };
        });
      bufferRows = readBufferWindow(buffer.viewportY);
      const recentStart = Math.max(0, buffer.length - terminal.rows * 3);
      recentText = Array.from(
        { length: buffer.length - recentStart },
        (_, index) => {
          const line = buffer.getLine(recentStart + index);
          return line ? line.translateToString(true) : '';
        }
      ).join('\\n');
      scroll = {
        isAtBottom: buffer.viewportY === buffer.baseY,
        scrollOffsetRows: buffer.baseY - buffer.viewportY
      };
      if (!scroll.isAtBottom) {
        // Bottom-anchored window read straight from the buffer; the user's
        // scroll position is never touched by a diagnostic capture.
        bottomRows = readBufferWindow(buffer.baseY);
      }
      bufferState = {
        type: buffer.type,
        cols: terminal.cols,
        rows: terminal.rows,
        baseY: buffer.baseY,
        viewportY: buffer.viewportY,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        length: buffer.length
      };
    }
    const xterm = root.querySelector('.xterm');
    const screen = root.querySelector('.xterm-screen');
    const bufferSource = surfaceVisible
      ? 'active-live'
      : terminal
        ? 'inactive-cache'
        : 'inactive-unavailable';
    return {
      ok: true,
      dom: {
        surfaceId,
        surfaceActive,
        surfaceVisible,
        activeSurfaceId,
        bufferSource,
        documentHasFocus: document.hasFocus(),
        fontStatus: 'fonts' in document ? document.fonts.status : 'unsupported',
        devicePixelRatio: window.devicePixelRatio,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        terminalDiagnostics,
        interactionDiagnostics,
        scroll,
        rootRect: rectToJson(root.getBoundingClientRect()),
        xtermRect: xterm ? rectToJson(xterm.getBoundingClientRect()) : null,
        screenRect: screen ? rectToJson(screen.getBoundingClientRect()) : null,
        rows,
        text: rows.map((row) => row.text).join('\\n'),
        bufferRows,
        bufferText: bufferRows.map((row) => row.text).join('\\n'),
        bottomRows,
        bottomText: bottomRows.map((row) => row.text).join('\\n'),
        recentText,
        bufferState,
        terminalAttrs: attrs
      }
    };
  })()`;
}

function formatCaptureText(payload: SurfaceCapturePayload): string {
  const rawOutputTail = payload.snapshot?.rawOutputTail;
  const rawOutputTailPreview =
    rawOutputTail === undefined
      ? "<unavailable>"
      : escapeForDiagnostics(
          tail(rawOutputTail, RAW_OUTPUT_TAIL_PREVIEW_CHARS)
        );
  const domBufferComparison = compareDomBufferRows(payload);
  const diagnostics = payload.renderer.dom?.terminalDiagnostics;
  const interaction = payload.renderer.dom?.interactionDiagnostics;
  const lines = [
    `capturedAt=${payload.capturedAt}`,
    `surfaceId=${payload.surfaceId}`,
    `sessionId=${payload.sessionId ?? ""}`,
    `workspaceId=${payload.workspaceId ?? ""}`,
    `paneId=${payload.paneId ?? ""}`,
    `timings.snapshotCompletedAt=${payload.timings.snapshotCompletedAt}`,
    `timings.rendererCompletedAt=${payload.timings.rendererCompletedAt}`,
    `timings.screenshotCompletedAt=${
      payload.timings.screenshotCompletedAt ?? ""
    }`,
    `renderer.ok=${payload.renderer.ok}`,
    `renderer.error=${payload.renderer.error ?? ""}`,
    `renderer.surfaceActive=${payload.renderer.dom?.surfaceActive ?? ""}`,
    `renderer.surfaceVisible=${payload.renderer.dom?.surfaceVisible ?? ""}`,
    `renderer.activeSurfaceId=${payload.renderer.dom?.activeSurfaceId ?? ""}`,
    `renderer.bufferSource=${payload.renderer.dom?.bufferSource ?? ""}`,
    `renderer.targetSequence=${diagnostics?.targetSequence ?? ""}`,
    `renderer.hydratedSequence=${diagnostics?.hydratedSequence ?? "null"}`,
    `renderer.renderedSequence=${diagnostics?.renderedSequence ?? "null"}`,
    `renderer.waitTimedOut=${diagnostics?.waitTimedOut ?? ""}`,
    `renderer.waitTimedOutReason=${formatWaitTimedOutReason(payload)}`,
    `renderer.waitSkippedReason=${diagnostics?.waitSkippedReason ?? ""}`,
    `renderer.waitDurationMs=${diagnostics?.waitDurationMs ?? ""}`,
    `renderer.diagnosticsSources=${
      diagnostics ? stringifyJson(diagnostics.sources) : ""
    }`,
    `renderer.documentHasFocus=${payload.renderer.dom?.documentHasFocus ?? ""}`,
    `renderer.visibilityState=${interaction?.visibilityState ?? ""}`,
    `renderer.paneFocused=${interaction?.paneFocused ?? ""}`,
    `renderer.activeElementKind=${interaction?.activeElementKind ?? ""}`,
    `renderer.terminalTextareaFocused=${
      interaction?.terminalTextareaFocused ?? ""
    }`,
    `renderer.sendFocusMode=${interaction?.sendFocusMode ?? ""}`,
    `renderer.mouseTrackingMode=${interaction?.mouseTrackingMode ?? ""}`,
    `renderer.synchronizedOutputMode=${
      interaction?.synchronizedOutputMode ?? ""
    }`,
    `renderer.attachId=${interaction?.attachId ?? ""}`,
    `renderer.inputReady=${interaction?.inputReady ?? ""}`,
    `renderer.lastFocusEvent=${interaction?.lastFocusEvent ?? ""}`,
    `renderer.lastFocusEventAt=${interaction?.lastFocusEventAt ?? ""}`,
    `renderer.lastInputKind=${interaction?.lastInputKind ?? ""}`,
    `renderer.lastInputAt=${interaction?.lastInputAt ?? ""}`,
    `renderer.lastInputBytes=${interaction?.lastInputBytes ?? ""}`,
    `renderer.lastInputRoute=${interaction?.lastInputRoute ?? ""}`,
    `renderer.lastReceiveAt=${interaction?.lastReceiveAt ?? ""}`,
    `renderer.lastReceiveSequence=${interaction?.lastReceiveSequence ?? ""}`,
    `renderer.lastScreenReceiveAt=${interaction?.lastScreenReceiveAt ?? ""}`,
    `renderer.lastScreenReceiveSequence=${
      interaction?.lastScreenReceiveSequence ?? ""
    }`,
    `renderer.lastWriteAt=${interaction?.lastWriteAt ?? ""}`,
    `renderer.lastWriteSequence=${interaction?.lastWriteSequence ?? ""}`,
    `renderer.lastScreenWriteAt=${interaction?.lastScreenWriteAt ?? ""}`,
    `renderer.lastScreenWriteSequence=${
      interaction?.lastScreenWriteSequence ?? ""
    }`,
    `renderer.lastParsedAt=${interaction?.lastParsedAt ?? ""}`,
    `renderer.lastParsedSequence=${interaction?.lastParsedSequence ?? ""}`,
    `renderer.lastScreenParsedAt=${interaction?.lastScreenParsedAt ?? ""}`,
    `renderer.lastScreenParsedSequence=${
      interaction?.lastScreenParsedSequence ?? ""
    }`,
    `renderer.lastOnRenderAt=${interaction?.lastOnRenderAt ?? ""}`,
    `renderer.lastOnRenderSequence=${interaction?.lastOnRenderSequence ?? ""}`,
    `renderer.lastScreenOnRenderAt=${interaction?.lastScreenOnRenderAt ?? ""}`,
    `renderer.lastScreenOnRenderSequence=${
      interaction?.lastScreenOnRenderSequence ?? ""
    }`,
    `renderer.isAtBottom=${payload.renderer.dom?.scroll?.isAtBottom ?? ""}`,
    `renderer.scrollOffsetRows=${
      payload.renderer.dom?.scroll?.scrollOffsetRows ?? ""
    }`,
    `snapshot.selected=${payload.snapshotDiagnostics.selected}`,
    `snapshot.attempts=${formatSnapshotAttempts(
      payload.snapshotDiagnostics.attempts
    )}`,
    `snapshot.available=${payload.snapshot ? "true" : "false"}`,
    `snapshot.sequence=${payload.snapshot?.sequence ?? ""}`,
    `rawOutputTail.available=${rawOutputTail === undefined ? "false" : "true"}`,
    `rawOutputTail.truncated=${payload.snapshot?.rawOutputTailTruncated ?? ""}`,
    `rawOutputTail.path=${payload.files.rawOutputTail ?? ""}`,
    `rawOutputLog.available=${payload.files.rawOutputLog ? "true" : "false"}`,
    `rawOutputLog.path=${payload.files.rawOutputLog ?? ""}`,
    `rawOutputIndex.path=${payload.files.rawOutputIndex ?? ""}`,
    `rawOutputLog.bytes=${payload.snapshot?.rawOutputLogBytes ?? ""}`,
    `rawOutputLog.chunks=${payload.snapshot?.rawOutputLogChunks ?? ""}`,
    `rawOutputCopyErrors=${payload.rawOutputCopyErrors?.join(" | ") ?? ""}`,
    `rawOutputTimeline.enabled=${
      payload.snapshot?.rawOutputTimeline?.enabled ?? ""
    }`,
    `rawOutputTimeline.sampleEvery=${
      payload.snapshot?.rawOutputTimeline?.sampleEvery ?? ""
    }`,
    `rawOutputTimeline.totalChunks=${
      payload.snapshot?.rawOutputTimeline?.totalChunks ?? ""
    }`,
    `rawOutputTimeline.retainedChunks=${
      payload.snapshot?.rawOutputTimeline?.retainedChunks ?? ""
    }`,
    `rawOutputTimeline.droppedChunks=${
      payload.snapshot?.rawOutputTimeline?.droppedChunks ?? ""
    }`,
    `rawOutputTimeline.unobservedChunks=${
      payload.snapshot?.rawOutputTimeline?.unobservedChunks ?? ""
    }`,
    `pipeline.progress=${
      payload.snapshot?.pipelineProgress
        ? stringifyJson(payload.snapshot.pipelineProgress)
        : ""
    }`,
    `diagnosticsLog.path=${payload.files.diagnosticsLog ?? ""}`,
    `diagnostics.mainWriter=${
      payload.diagnosticsHealth.mainWriter
        ? stringifyJson(payload.diagnosticsHealth.mainWriter)
        : ""
    }`,
    `diagnostics.ptyHost=${
      payload.diagnosticsHealth.ptyHost
        ? stringifyJson(payload.diagnosticsHealth.ptyHost)
        : ""
    }`,
    `diagnostics.logCopyError=${
      payload.diagnosticsHealth.diagnosticsLogCopyError ?? ""
    }`,
    `renderer.domBufferMismatchRows=${
      domBufferComparison?.trimmedMismatches.length ?? ""
    }`,
    `renderer.domBufferMismatchRowsRaw=${
      domBufferComparison?.rawMismatchCount ?? ""
    }`,
    `renderer.domMatchesXtermBuffer=${
      domBufferComparison === null
        ? ""
        : domBufferComparison.trimmedMismatches.length === 0
    }`,
    `screenshot.sourceSurfaceId=${
      payload.screenshotDiagnostics.sourceSurfaceId ?? ""
    }`,
    `screenshot.trusted=${payload.screenshotDiagnostics.trusted ?? ""}`,
    `screenshot.skippedReason=${
      payload.screenshotDiagnostics.skippedReason ?? ""
    }`,
    `verdict.contentConsistency=${payload.contentConsistency.verdict}`,
    `verdict.contentSampledLines=${payload.contentConsistency.sampledLines}`,
    `verdict.contentMatchedLines=${payload.contentConsistency.matchedLines}`,
    `verdict.rendererBufferTrusted=${payload.rendererBufferTrusted ?? ""}`,
    `verdict.rendererTrusted=${payload.rendererTrusted ?? ""}`,
    "",
    "[analysis]",
    "Compare the same missing text across these layers:",
    "1. Codex JSONL/source transcript",
    "2. pty.rawOutputTimeline + pty-raw-tail.txt (or the optional full raw stream/index)",
    "3. [pty.snapshot]",
    "4. [renderer.xterm.buffer.rows]",
    "5. [renderer.dom.rows] and terminal.png when screenshot.trusted=true",
    "If raw PTY stream does not contain the missing text or contains later erase/overwrite sequences before the snapshot sequence, inspect the agent CLI terminal output. If raw PTY stream contains stable text but pty.snapshot does not, inspect pty-host headless ingestion/serialization. If pty.snapshot has it but renderer buffer does not, inspect bridge attach/replay/live delivery. If renderer buffer has it but DOM/screenshot do not, inspect xterm render/paint.",
    "For an interaction stall, compare the unsampled screen-specific clocks from PTY read through renderer receive/write/parse/render. Any dropped, unobserved, truncated, or failed diagnostic count makes that boundary explicitly incomplete.",
    "inactive-cache is intentionally not sequence-waited or screenshotted; its buffer is a labeled historical hint, not a live renderer observation.",
    "osc-title-only means the PTY emitted title activity without a terminal-body mutation; indeterminate means logging began in the middle of an unobserved VT sequence.",
    "",
    "[pty.rawOutputTimeline]",
    ...(payload.snapshot?.rawOutputTimeline?.chunks.map((chunk) =>
      stringifyJson(chunk)
    ) ?? ["<unavailable>"]),
    "",
    "[renderer.dom-buffer.mismatches.trimmed]",
    ...(domBufferComparison === null
      ? ["<unavailable>"]
      : domBufferComparison.trimmedMismatches.length === 0
        ? ["<none>"]
        : domBufferComparison.trimmedMismatches
            .slice(0, 20)
            .flatMap((mismatch) => [
              `row ${mismatch.index}`,
              `  dom=${escapeForDiagnostics(mismatch.domText ?? "<missing>")}`,
              `  buf=${escapeForDiagnostics(mismatch.bufferText ?? "<missing>")}`
            ])),
    "",
    "[renderer.dom.rows]",
    ...(payload.renderer.dom?.rows.map(
      (row) => `${row.index.toString().padStart(3, "0")}: ${row.text}`
    ) ?? ["<unavailable>"]),
    "",
    "[renderer.xterm.buffer.rows]",
    ...(payload.renderer.dom?.bufferRows.map(
      (row) =>
        `${row.index.toString().padStart(3, "0")} @${row.absoluteY}${row.isWrapped ? " wrapped" : ""}: ${row.text}`
    ) ?? ["<unavailable>"]),
    "",
    "[renderer.xterm.buffer.bottomRows]",
    ...(payload.renderer.dom === undefined
      ? ["<unavailable>"]
      : payload.renderer.dom.scroll?.isAtBottom !== false
        ? ["<viewport is at the bottom; see buffer.rows>"]
        : payload.renderer.dom.bottomRows.map(
            (row) =>
              `${row.index.toString().padStart(3, "0")} @${row.absoluteY}${row.isWrapped ? " wrapped" : ""}: ${row.text}`
          )),
    "",
    "[pty.rawOutputTail.preview.escaped]",
    rawOutputTailPreview,
    "",
    "[pty.snapshot]",
    payload.snapshot?.vt ?? "<unavailable>"
  ];

  return `${lines.join("\n")}\n`;
}

function formatWaitTimedOutReason(payload: SurfaceCapturePayload): string {
  const diagnostics = payload.renderer.dom?.terminalDiagnostics;
  if (!diagnostics?.waitTimedOut) {
    return "";
  }
  switch (payload.contentConsistency.verdict) {
    case "consistent":
      return "instrumentation-stale";
    case "behind":
      return "content-behind";
    default:
      return "indeterminate";
  }
}

interface DomBufferMismatch {
  index: number;
  domText: string | undefined;
  bufferText: string | undefined;
}

interface DomBufferComparison {
  // DOM rows pad to the full grid width while buffer rows trim trailing
  // whitespace, so the trimmed comparison is the meaningful one; the raw
  // count is kept for reference only.
  trimmedMismatches: DomBufferMismatch[];
  rawMismatchCount: number;
}

function compareDomBufferRows(
  payload: SurfaceCapturePayload
): DomBufferComparison | null {
  const dom = payload.renderer.dom;
  if (!dom) {
    return null;
  }

  const maxRows = Math.max(dom.rows.length, dom.bufferRows.length);
  const trimmedMismatches: DomBufferMismatch[] = [];
  let rawMismatchCount = 0;
  for (let index = 0; index < maxRows; index += 1) {
    const domText = dom.rows[index]?.text;
    const bufferText = dom.bufferRows[index]?.text;
    if (domText !== bufferText) {
      rawMismatchCount += 1;
    }
    if ((domText ?? "").trimEnd() !== (bufferText ?? "").trimEnd()) {
      trimmedMismatches.push({ index, domText, bufferText });
    }
  }
  return { trimmedMismatches, rawMismatchCount };
}

function formatSnapshotAttempts(
  attempts: SurfaceCaptureSnapshotAttempt[]
): string {
  return attempts
    .map((attempt) => {
      const details = [
        `kind=${attempt.kind}`,
        `settleForMs=${attempt.settleForMs}`,
        `timeoutMs=${attempt.timeoutMs}`,
        `status=${attempt.status}`
      ];
      if (attempt.sequence !== undefined) {
        details.push(`sequence=${attempt.sequence}`);
      }
      if (attempt.error) {
        details.push(`error=${attempt.error}`);
      }
      return `{${details.join(",")}}`;
    })
    .join(" ");
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(-maxChars);
}

function escapeForDiagnostics(value: string): string {
  return JSON.stringify(value);
}
