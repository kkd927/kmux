import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmux,
  createSandbox,
  launchKmuxWithSandbox,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test("surface capture writes PTY snapshot, renderer rows, and screenshot diagnostics", async () => {
  const sandbox = createSandbox("kmux-e2e-surface-capture-");
  const launched = await launchKmuxWithSandbox(sandbox);

  try {
    const page = launched.page;
    const seeded = await waitForView(
      page,
      (view) => view.workspaceRows.length > 0,
      "workspace state should be available before capture"
    );
    const paneId = seeded.activeWorkspace.activePaneId;
    const surfaceId = seeded.activeWorkspace.panes[paneId].activeSurfaceId;
    const marker = `KMUX_CAPTURE_MARKER_${Date.now()}`;

    await page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf '${marker}\\n'\r`
      }
    );
    await waitForSurfaceSnapshotContains(page, surfaceId, marker, 8000);

    const capture = await page.evaluate(
      (targetSurfaceId) =>
        window.kmux.captureSurfaceDiagnostics(targetSurfaceId),
      surfaceId
    );
    const outDir = capture.outDir;

    expect(capture.surfaceId).toBe(surfaceId);
    expect(capture.snapshot?.vt).toContain(marker);
    expect(capture.snapshot?.rawOutputTail).toContain(marker);
    expect(capture.snapshot?.rawOutputLogBytes ?? 0).toBeGreaterThan(0);
    expect(capture.snapshot?.rawOutputLogChunks ?? 0).toBeGreaterThan(0);
    expect(capture.snapshotDiagnostics.selected).not.toBe("unavailable");
    expect(capture.snapshotDiagnostics.attempts.length).toBeGreaterThan(0);
    expect(capture.renderer.ok).toBe(true);
    expect(capture.renderer.dom?.terminalDiagnostics.waitTimedOut).toBe(false);
    expect(capture.rendererTrusted).toBe(true);
    expect(capture.contentConsistency.verdict).not.toBe("behind");
    expect(capture.timings.snapshotCompletedAt).toBeTruthy();
    expect(capture.timings.rendererCompletedAt).toBeTruthy();
    expect(capture.renderer.dom?.scroll?.isAtBottom).toBe(true);
    expect(
      capture.renderer.dom?.terminalDiagnostics.renderedSequence ?? -1
    ).toBeGreaterThanOrEqual(
      capture.renderer.dom?.terminalDiagnostics.targetSequence ?? 0
    );
    expect(capture.renderer.dom?.bufferText).toContain(marker);
    expect(capture.files.json).toBe(join(outDir, "capture.json"));
    expect(capture.files.text).toBe(join(outDir, "terminal.txt"));
    expect(capture.files.screenshot).toBe(join(outDir, "terminal.png"));
    expect(capture.files.rawOutputTail).toBe(join(outDir, "pty-raw-tail.txt"));
    expect(capture.files.rawOutputLog).toBe(
      join(outDir, "pty-raw-stream.ansi")
    );
    expect(capture.files.rawOutputIndex).toBe(
      join(outDir, "pty-raw-index.jsonl")
    );

    expect(existsSync(capture.files.json)).toBe(true);
    expect(existsSync(capture.files.text)).toBe(true);
    expect(existsSync(capture.files.screenshot!)).toBe(true);
    expect(existsSync(capture.files.rawOutputTail!)).toBe(true);
    expect(existsSync(capture.files.rawOutputLog!)).toBe(true);
    expect(existsSync(capture.files.rawOutputIndex!)).toBe(true);
    expect(readFileSync(capture.files.text, "utf8")).toContain(marker);
    expect(readFileSync(capture.files.json, "utf8")).toContain(marker);
    expect(readFileSync(capture.files.rawOutputTail!, "utf8")).toContain(
      marker
    );
    expect(readFileSync(capture.files.rawOutputLog!, "utf8")).toContain(
      marker
    );
    expect(readFileSync(capture.files.rawOutputIndex!, "utf8")).toContain(
      "sequence"
    );
    expect(
      readFileSync(capture.files.screenshot!).subarray(0, 8).toString("hex")
    ).toBe("89504e470d0a1a0a");
  } finally {
    await closeKmux(launched);
  }
});
