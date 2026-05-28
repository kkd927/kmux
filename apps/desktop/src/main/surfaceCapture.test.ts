import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppState } from "@kmux/core";
import type { SurfaceCaptureOptions, SurfaceSnapshotPayload } from "@kmux/proto";
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
