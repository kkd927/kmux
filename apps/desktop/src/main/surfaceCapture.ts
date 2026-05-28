import type { BrowserWindow } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import type { AppState } from "@kmux/core";
import type {
  Id,
  SurfaceCaptureOptions,
  SurfaceCapturePayload,
  SurfaceCaptureRendererPayload,
  SurfaceCaptureSnapshotAttempt,
  SurfaceCaptureSnapshotAttemptKind,
  SurfaceCaptureSnapshotDiagnostics,
  SurfaceSnapshotPayload
} from "@kmux/proto";
import { isoNow } from "@kmux/proto";

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

    const screenshotPath = renderer.dom
      ? await captureScreenshot(window, renderer.dom.rootRect, outDir)
      : undefined;
    const textPath = join(outDir, "terminal.txt");
    const jsonPath = join(outDir, "capture.json");
    const rawOutputTailPath =
      snapshot?.rawOutputTail === undefined
        ? undefined
        : join(outDir, "pty-raw-tail.txt");
    const rawOutputHistory = copyRawOutputHistory(snapshot, outDir);

    const payload: SurfaceCapturePayload = {
      surfaceId,
      sessionId: surface.sessionId,
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
        rawOutputIndex: rawOutputHistory.rawOutputIndexPath
      },
      snapshot,
      snapshotDiagnostics,
      rawOutputCopyErrors: rawOutputHistory.errors,
      renderer
    };

    if (rawOutputTailPath !== undefined) {
      writeFileSync(rawOutputTailPath, snapshot?.rawOutputTail ?? "", "utf8");
    }
    writeFileSync(textPath, formatCaptureText(payload), "utf8");
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

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

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, value);
}

async function captureRenderer(
  window: BrowserWindow | null,
  surfaceId: Id,
  targetSequence: number | null,
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
  targetSequence: number | null,
  timeoutMs: number | undefined
): string {
  return `(async () => {
    const surfaceId = ${JSON.stringify(surfaceId)};
    const targetSequence = ${JSON.stringify(targetSequence)};
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
    const readSequence = (value, attr) => {
      if (typeof value === 'number') {
        return value;
      }
      const parsed = Number(attr);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const findTerminalHost = (root) =>
      Array.from(root.children).find((child) => child.__kmuxTerminal);
    const readDiagnostics = (root) => {
      const terminalHost = findTerminalHost(root);
      const diagnostics =
        root.__kmuxTerminalDiagnostics ||
        (terminalHost ? terminalHost.__kmuxTerminalDiagnostics : undefined) ||
        {};
      return {
        hydratedSequence: readSequence(
          diagnostics.hydratedSequence,
          root.getAttribute('data-terminal-hydrated-sequence')
        ),
        renderedSequence: readSequence(
          diagnostics.renderedSequence,
          root.getAttribute('data-terminal-rendered-sequence')
        )
      };
    };
    if (!root) {
      return {
        ok: false,
        error: 'Terminal root not found for surface ' + surfaceId
      };
    }
    const deadline = performance.now() + Math.max(0, timeoutMs);
    let waitTimedOut = false;
    if (typeof targetSequence === 'number') {
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
    await nextPaint();
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
    const terminalDiagnostics = {
      ...readDiagnostics(root),
      targetSequence,
      waitTimedOut
    };
    let bufferRows = [];
    let bufferState = null;
    if (terminal && terminal.buffer && terminal.buffer.active) {
      const buffer = terminal.buffer.active;
      bufferRows = Array.from({ length: terminal.rows }, (_, index) => {
        const absoluteY = buffer.viewportY + index;
        const line = buffer.getLine(absoluteY);
        return {
          index,
          absoluteY,
          text: line ? line.translateToString(true) : '',
          isWrapped: Boolean(line && line.isWrapped)
        };
      });
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
    return {
      ok: true,
      dom: {
        surfaceId,
        documentHasFocus: document.hasFocus(),
        fontStatus: 'fonts' in document ? document.fonts.status : 'unsupported',
        devicePixelRatio: window.devicePixelRatio,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        terminalDiagnostics,
        rootRect: rectToJson(root.getBoundingClientRect()),
        xtermRect: xterm ? rectToJson(xterm.getBoundingClientRect()) : null,
        screenRect: screen ? rectToJson(screen.getBoundingClientRect()) : null,
        rows,
        text: rows.map((row) => row.text).join('\\n'),
        bufferRows,
        bufferText: bufferRows.map((row) => row.text).join('\\n'),
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
      : escapeForDiagnostics(tail(rawOutputTail, RAW_OUTPUT_TAIL_PREVIEW_CHARS));
  const domBufferMismatchCount = countDomBufferMismatches(payload);
  const lines = [
    `capturedAt=${payload.capturedAt}`,
    `surfaceId=${payload.surfaceId}`,
    `sessionId=${payload.sessionId ?? ""}`,
    `workspaceId=${payload.workspaceId ?? ""}`,
    `paneId=${payload.paneId ?? ""}`,
    `renderer.ok=${payload.renderer.ok}`,
    `renderer.error=${payload.renderer.error ?? ""}`,
    `renderer.targetSequence=${
      payload.renderer.dom?.terminalDiagnostics.targetSequence ?? ""
    }`,
    `renderer.hydratedSequence=${
      payload.renderer.dom?.terminalDiagnostics.hydratedSequence ?? ""
    }`,
    `renderer.renderedSequence=${
      payload.renderer.dom?.terminalDiagnostics.renderedSequence ?? ""
    }`,
    `renderer.waitTimedOut=${
      payload.renderer.dom?.terminalDiagnostics.waitTimedOut ?? ""
    }`,
    `snapshot.selected=${payload.snapshotDiagnostics.selected}`,
    `snapshot.attempts=${formatSnapshotAttempts(
      payload.snapshotDiagnostics.attempts
    )}`,
    `snapshot.available=${payload.snapshot ? "true" : "false"}`,
    `snapshot.sequence=${payload.snapshot?.sequence ?? ""}`,
    `rawOutputTail.available=${
      rawOutputTail === undefined ? "false" : "true"
    }`,
    `rawOutputTail.truncated=${payload.snapshot?.rawOutputTailTruncated ?? ""}`,
    `rawOutputTail.path=${payload.files.rawOutputTail ?? ""}`,
    `rawOutputLog.available=${
      payload.files.rawOutputLog ? "true" : "false"
    }`,
    `rawOutputLog.path=${payload.files.rawOutputLog ?? ""}`,
    `rawOutputIndex.path=${payload.files.rawOutputIndex ?? ""}`,
    `rawOutputLog.bytes=${payload.snapshot?.rawOutputLogBytes ?? ""}`,
    `rawOutputLog.chunks=${payload.snapshot?.rawOutputLogChunks ?? ""}`,
    `rawOutputCopyErrors=${payload.rawOutputCopyErrors?.join(" | ") ?? ""}`,
    `renderer.domBufferMismatchRows=${domBufferMismatchCount ?? ""}`,
    `renderer.domMatchesXtermBuffer=${
      domBufferMismatchCount === null ? "" : domBufferMismatchCount === 0
    }`,
    "",
    "[analysis]",
    "Compare the same missing text across these layers:",
    "1. Codex JSONL/source transcript",
    "2. pty-raw-stream.ansi + pty-raw-index.jsonl",
    "3. [pty.snapshot]",
    "4. [renderer.xterm.buffer.rows]",
    "5. [renderer.dom.rows] and terminal.png",
    "If raw PTY stream does not contain the missing text or contains later erase/overwrite sequences before the snapshot sequence, inspect the agent CLI terminal output. If raw PTY stream contains stable text but pty.snapshot does not, inspect pty-host headless ingestion/serialization. If pty.snapshot has it but renderer buffer does not, inspect bridge attach/replay/live delivery. If renderer buffer has it but DOM/screenshot do not, inspect xterm render/paint.",
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
    "[pty.rawOutputTail.preview.escaped]",
    rawOutputTailPreview,
    "",
    "[pty.snapshot]",
    payload.snapshot?.vt ?? "<unavailable>"
  ];

  return `${lines.join("\n")}\n`;
}

function countDomBufferMismatches(
  payload: SurfaceCapturePayload
): number | null {
  const dom = payload.renderer.dom;
  if (!dom) {
    return null;
  }

  const maxRows = Math.max(dom.rows.length, dom.bufferRows.length);
  let mismatchCount = 0;
  for (let index = 0; index < maxRows; index += 1) {
    if (dom.rows[index]?.text !== dom.bufferRows[index]?.text) {
      mismatchCount += 1;
    }
  }
  return mismatchCount;
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
