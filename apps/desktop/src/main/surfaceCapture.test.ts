import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow } from "electron";

import type { AppState } from "@kmux/core";
import type {
  SurfaceCaptureOptions,
  SurfaceCaptureRendererDom,
  SurfaceSnapshotPayload
} from "@kmux/proto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSurfaceCaptureService } from "./surfaceCapture";

const surfaceId = "surface_test";
const sessionId = "session_test";
const paneId = "pane_test";
const workspaceId = "workspace_test";

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths = [];
});

describe("surface capture diagnostics", () => {
  it("keeps capture artifacts under the configured capture root", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    const callerDir = mkdtempSync(join(tmpdir(), "kmux-surface-caller-"));
    cleanupPaths.push(captureRoot);
    cleanupPaths.push(callerDir);
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => null,
      snapshotSurface: vi.fn(async () => null)
    });

    const capture = await service.captureSurface(surfaceId, {
      outDir: callerDir,
      settleForMs: 0,
      timeoutMs: 1
    } as SurfaceCaptureOptions & { outDir: string });

    expect(capture.outDir.startsWith(`${captureRoot}/`)).toBe(true);
    expect(capture.outDir).not.toBe(callerDir);
    expect(existsSync(join(callerDir, "capture.json"))).toBe(false);
    expect(existsSync(capture.files.json)).toBe(true);
    expect(existsSync(capture.files.text)).toBe(true);
  });

  it("falls back to an immediate raw PTY snapshot when the settled snapshot is unavailable", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    const rawRoot = mkdtempSync(join(tmpdir(), "kmux-surface-raw-"));
    cleanupPaths.push(captureRoot);
    cleanupPaths.push(rawRoot);
    const rawOutputLogPath = join(rawRoot, "stream.ansi");
    const rawOutputIndexPath = join(rawRoot, "chunks.jsonl");
    writeFileSync(rawOutputLogPath, "raw pty marker", "utf8");
    writeFileSync(
      rawOutputIndexPath,
      `${JSON.stringify({ sequence: 42, byteStart: 0, byteEnd: 14 })}\n`,
      "utf8"
    );
    const snapshot: SurfaceSnapshotPayload = {
      surfaceId,
      sessionId,
      sequence: 42,
      vt: "headless snapshot marker",
      cols: 80,
      rows: 24,
      title: "test",
      ports: [],
      unreadCount: 0,
      attention: false,
      rawOutputTail: "raw pty marker",
      rawOutputTailTruncated: false,
      rawOutputLogPath,
      rawOutputIndexPath,
      rawOutputLogBytes: 14,
      rawOutputLogChunks: 1
    };
    const snapshotSurface = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshot);
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => null,
      snapshotSurface
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 250,
      timeoutMs: 3000
    });

    expect(snapshotSurface).toHaveBeenNthCalledWith(1, surfaceId, {
      settleForMs: 250,
      timeoutMs: 3000,
      includeRawOutputTail: true
    });
    expect(snapshotSurface).toHaveBeenNthCalledWith(2, surfaceId, {
      settleForMs: 0,
      timeoutMs: 1000,
      includeRawOutputTail: true
    });
    expect(capture.snapshotDiagnostics.selected).toBe("immediate");
    expect(capture.snapshotDiagnostics.attempts).toMatchObject([
      { kind: "settled", status: "unavailable" },
      { kind: "immediate", status: "ok", sequence: 42 }
    ]);
    expect(capture.files.rawOutputTail).toBe(
      join(capture.outDir, "pty-raw-tail.txt")
    );
    expect(existsSync(capture.files.rawOutputTail!)).toBe(true);
    expect(readFileSync(capture.files.rawOutputTail!, "utf8")).toBe(
      "raw pty marker"
    );
    expect(capture.files.rawOutputLog).toBe(
      join(capture.outDir, "pty-raw-stream.ansi")
    );
    expect(capture.files.rawOutputIndex).toBe(
      join(capture.outDir, "pty-raw-index.jsonl")
    );
    expect(readFileSync(capture.files.rawOutputLog!, "utf8")).toBe(
      "raw pty marker"
    );
    expect(readFileSync(capture.files.rawOutputIndex!, "utf8")).toContain(
      '"sequence":42'
    );
    expect(readFileSync(capture.files.text, "utf8")).toContain(
      "snapshot.selected=immediate"
    );
    expect(readFileSync(capture.files.text, "utf8")).toContain(
      "rawOutputLog.available=true"
    );
  });
});

function createRendererDom(
  overrides: Partial<SurfaceCaptureRendererDom> = {}
): SurfaceCaptureRendererDom {
  const rect = { x: 0, y: 0, width: 800, height: 600 };
  return {
    surfaceId,
    documentHasFocus: true,
    fontStatus: "loaded",
    devicePixelRatio: 1,
    viewport: { width: 800, height: 600 },
    terminalDiagnostics: {
      hydratedSequence: null,
      renderedSequence: null,
      targetSequence: null,
      waitTimedOut: false,
      waitDurationMs: 0,
      sources: {
        wrapperProp: null,
        hostProp: null,
        wrapperDataset: null,
        store: null
      }
    },
    scroll: { isAtBottom: true, scrollOffsetRows: 0 },
    rootRect: rect,
    xtermRect: rect,
    screenRect: rect,
    rows: [],
    text: "",
    bufferRows: [],
    bufferText: "",
    bottomRows: [],
    bottomText: "",
    recentText: "",
    bufferState: null,
    terminalAttrs: {},
    ...overrides
  };
}

function createFakeWindow(dom: SurfaceCaptureRendererDom): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: vi.fn(async () => ({ ok: true, dom })),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(4) }))
    }
  } as unknown as BrowserWindow;
}

function domRow(index: number, text: string) {
  return { index, text, rect: { x: 0, y: index * 10, width: 800, height: 10 } };
}

function createSnapshot(
  overrides: Partial<SurfaceSnapshotPayload> = {}
): SurfaceSnapshotPayload {
  return {
    surfaceId,
    sessionId,
    sequence: 42,
    vt: "",
    cols: 80,
    rows: 24,
    title: "test",
    ports: [],
    unreadCount: 0,
    attention: false,
    ...overrides
  };
}

function bufferRow(index: number, text: string, absoluteY = index) {
  return { index, absoluteY, text, isWrapped: false };
}

describe("surface capture renderer formatting", () => {
  it("treats trailing-whitespace-only differences as matching rows", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const dom = createRendererDom({
      rows: [domRow(0, "hello        "), domRow(1, "world   ")],
      bufferRows: [bufferRow(0, "hello"), bufferRow(1, "world")]
    });
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => null)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.domBufferMismatchRows=0");
    expect(text).toContain("renderer.domBufferMismatchRowsRaw=2");
    expect(text).toContain("renderer.domMatchesXtermBuffer=true");
    expect(text).toContain("[renderer.dom-buffer.mismatches.trimmed]\n<none>");
  });

  it("reports mismatch details for rows that differ beyond trailing whitespace", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const dom = createRendererDom({
      rows: [domRow(0, "same"), domRow(1, "dom text")],
      bufferRows: [bufferRow(0, "same"), bufferRow(1, "buffer text")]
    });
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => null)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.domBufferMismatchRows=1");
    expect(text).toContain("renderer.domMatchesXtermBuffer=false");
    expect(text).toContain('row 1\n  dom="dom text"\n  buf="buffer text"');
  });

  it("keeps null diagnostics distinguishable from sequence zero", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const dom = createRendererDom();
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => null)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.hydratedSequence=null");
    expect(text).toContain("renderer.renderedSequence=null");
    expect(capture.renderer.dom?.terminalDiagnostics.renderedSequence).toBe(
      null
    );
  });

  it("classifies a sequence-wait timeout as stale instrumentation when content matches", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const stableLines = [
      "first stable transcript line here",
      "second stable transcript line here",
      "third stable transcript line here",
      "fourth stable transcript line here"
    ];
    const snapshot = createSnapshot({
      vt: [...stableLines, "live input box row"].join("\r\n"),
      rows: 1
    });
    const dom = createRendererDom({
      terminalDiagnostics: {
        hydratedSequence: null,
        renderedSequence: null,
        targetSequence: 42,
        waitTimedOut: true,
        waitDurationMs: 3000,
        sources: {
          wrapperProp: null,
          hostProp: null,
          wrapperDataset: null,
          store: null
        }
      },
      recentText: [...stableLines, "different live row"].join("\n")
    });
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => snapshot)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    expect(capture.contentConsistency.verdict).toBe("consistent");
    expect(capture.rendererTrusted).toBe(true);
    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.waitTimedOutReason=instrumentation-stale");
    expect(text).toContain("verdict.contentConsistency=consistent");
    expect(text).toContain("verdict.rendererTrusted=true");
  });

  it("marks the renderer untrusted when a timeout coincides with missing content", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const snapshot = createSnapshot({
      vt: [
        "newest transcript block line one",
        "newest transcript block line two",
        "newest transcript block line three",
        "newest transcript block line four",
        "live row"
      ].join("\r\n"),
      rows: 1
    });
    const dom = createRendererDom({
      terminalDiagnostics: {
        hydratedSequence: 1,
        renderedSequence: 10,
        targetSequence: 42,
        waitTimedOut: true,
        waitDurationMs: 3000,
        sources: {
          wrapperProp: null,
          hostProp: null,
          wrapperDataset: null,
          store: null
        }
      },
      recentText: [
        "minutes-old content line one here",
        "minutes-old content line two here",
        "minutes-old content line three here"
      ].join("\n")
    });
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => snapshot)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    expect(capture.contentConsistency.verdict).toBe("behind");
    expect(capture.rendererTrusted).toBe(false);
    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.waitTimedOutReason=content-behind");
    expect(text).toContain("verdict.rendererTrusted=false");
  });

  it("records scroll state, timings, and the bottom buffer window", async () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "kmux-surface-capture-"));
    cleanupPaths.push(captureRoot);
    const dom = createRendererDom({
      scroll: { isAtBottom: false, scrollOffsetRows: 2338 },
      bufferRows: [bufferRow(0, "old scrollback", 2978)],
      bottomRows: [bufferRow(0, "live bottom line", 5316)],
      bottomText: "live bottom line"
    });
    const service = createSurfaceCaptureService({
      captureRoot,
      getState: createState,
      getWindow: () => createFakeWindow(dom),
      snapshotSurface: vi.fn(async () => null)
    });

    const capture = await service.captureSurface(surfaceId, {
      settleForMs: 0,
      timeoutMs: 1
    });

    expect(capture.timings.snapshotCompletedAt).toBeTruthy();
    expect(capture.timings.rendererCompletedAt).toBeTruthy();
    expect(capture.timings.screenshotCompletedAt).toBeTruthy();
    const text = readFileSync(capture.files.text, "utf8");
    expect(text).toContain("renderer.isAtBottom=false");
    expect(text).toContain("renderer.scrollOffsetRows=2338");
    expect(text).toContain("timings.snapshotCompletedAt=");
    expect(text).toContain("[renderer.xterm.buffer.bottomRows]");
    expect(text).toContain("000 @5316: live bottom line");
    expect(text).toContain("renderer.diagnosticsSources=");
  });
});

function createState(): AppState {
  return {
    windows: {},
    workspaces: {
      [workspaceId]: {
        id: workspaceId,
        windowId: "window_test",
        name: "Test",
        rootNodeId: paneId,
        nodeMap: {
          [paneId]: {
            id: paneId,
            kind: "leaf",
            paneId
          }
        },
        activePaneId: paneId,
        pinned: false,
        ports: [],
        statusEntries: {},
        logs: []
      }
    },
    panes: {
      [paneId]: {
        id: paneId,
        workspaceId,
        surfaceIds: [surfaceId],
        activeSurfaceId: surfaceId
      }
    },
    surfaces: {
      [surfaceId]: {
        id: surfaceId,
        paneId,
        sessionId,
        title: "Test",
        titleLocked: false,
        ports: [],
        unreadCount: 0,
        attention: false
      }
    },
    sessions: {},
    notifications: [],
    settings: {} as never,
    activeWindowId: "window_test"
  };
}
