import { expect, test, type Page } from "@playwright/test";
import type { SurfaceSnapshotPayload } from "@kmux/proto";

import {
  closeKmux,
  dispatch,
  getTerminalCellMetrics,
  getSurfaceSnapshot,
  getView,
  launchKmux,
  type TerminalCellMetrics,
  runCliJson,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isUsableCellMetrics(metrics: TerminalCellMetrics): boolean {
  return (
    (metrics.fontStatus === "loaded" || metrics.fontStatus === "unsupported") &&
    metrics.terminalCols !== null &&
    metrics.terminalRows !== null &&
    metrics.terminalCols > 20 &&
    metrics.terminalRows > 5 &&
    metrics.visibleRowCount === metrics.terminalRows &&
    metrics.cellWidth !== null &&
    metrics.cellWidth > 4 &&
    metrics.cellHeight !== null &&
    metrics.cellHeight > 8 &&
    metrics.screenWidth > 0 &&
    metrics.screenHeight > 0
  );
}

async function waitForCellMetricsSnapshotSync(
  page: Page,
  surfaceId: string,
  message: string,
  predicate: (metrics: TerminalCellMetrics) => boolean = () => true,
  timeoutMs = 5000
): Promise<{
  metrics: TerminalCellMetrics;
  snapshot: SurfaceSnapshotPayload;
}> {
  const startTime = Date.now();
  let lastState: {
    metrics: TerminalCellMetrics | null;
    snapshot: SurfaceSnapshotPayload | null;
    error: string | null;
  } | null = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const metrics = await getTerminalCellMetrics(page, surfaceId);
      const snapshot = await getSurfaceSnapshot(page, surfaceId, {
        settleForMs: 200,
        timeoutMs: 3000
      });
      lastState = { metrics, snapshot, error: null };
      if (
        snapshot &&
        isUsableCellMetrics(metrics) &&
        predicate(metrics) &&
        metrics.terminalCols === snapshot.cols &&
        metrics.terminalRows === snapshot.rows &&
        metrics.visibleRowCount === snapshot.rows
      ) {
        return { metrics, snapshot };
      }
    } catch (error) {
      lastState = {
        metrics: null,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `${message}; timeout=${timeoutMs}ms; lastState=${JSON.stringify(lastState)}`
  );
}

function expectCellMetricsToMatchSnapshot(
  metrics: TerminalCellMetrics,
  snapshot: SurfaceSnapshotPayload | null
): void {
  if (
    metrics.terminalCols === null ||
    metrics.terminalRows === null ||
    metrics.cellWidth === null ||
    metrics.cellHeight === null ||
    metrics.averageRowHeight === null
  ) {
    throw new Error(
      `terminal cell metrics incomplete: ${JSON.stringify(metrics)}`
    );
  }

  expect(snapshot).not.toBeNull();
  expect(metrics.terminalCols).toBe(snapshot?.cols);
  expect(metrics.terminalRows).toBe(snapshot?.rows);
  expect(metrics.visibleRowCount).toBe(snapshot?.rows);
  expect(metrics.cellWidth).toBeLessThan(40);
  expect(metrics.cellHeight).toBeLessThan(50);
  expect(
    Math.abs(metrics.averageRowHeight - metrics.cellHeight)
  ).toBeLessThanOrEqual(2);
  expect(metrics.maxRowHeightDelta).toBeLessThanOrEqual(2);
}

test("walking skeleton verifies platform descriptor, socket identity, and pty hook env", async () => {
  const launched = await launchKmux("kmux-e2e-walking-skeleton-env-");

  try {
    const { page, sandbox, cliPath, workspaceRoot } = launched;
    const platform = await page.evaluate(() => window.kmux.getPlatform());

    expect(platform.keyboard.shortcuts).toBeTruthy();
    if (process.platform === "darwin") {
      expect(platform.windowChrome).toBe("native");
      expect(platform.shortcutStyle).toBe("mac-symbols");
      expect(platform.desktop.supportsDock).toBe(true);
      expect(platform.desktop.keepProcessAliveWhenLastWindowCloses).toBe(true);
    } else if (process.platform === "linux") {
      expect(platform.windowChrome).toBe("custom");
      expect(platform.shortcutStyle).toBe("text");
      expect(platform.desktop.supportsDock).toBe(false);
      expect(platform.desktop.keepProcessAliveWhenLastWindowCloses).toBe(false);
    }

    const initial = await waitForView(
      page,
      (view) =>
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "initial pty session should reach running state",
      10_000
    );
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;

    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...initial.settings,
        socketMode: "allowAll"
      }
    });

    const identify = runCliJson<{
      socketPath: string;
      socketMode: string;
      activeSurfaceId: string;
      capabilities: string[];
    }>(cliPath, workspaceRoot, sandbox.socketPath, ["system", "identify"]);
    expect(identify.socketPath).toBe(sandbox.socketPath);
    expect(identify.socketMode).toBe("allowAll");
    expect(identify.activeSurfaceId).toBe(surfaceId);
    expect(identify.capabilities).toContain("surface.send_text");

    const envProbe =
      "printf '__KMUX_SOCKET_PATH:%s__\\n' \"$KMUX_SOCKET_PATH\"; " +
      "test -n \"$KMUX_AGENT_BIN_DIR\" && printf '__KMUX_AGENT_BIN_PRESENT__\\n'; " +
      "test -n \"$KMUX_NODE_PATH\" && printf '__KMUX_NODE_PRESENT__\\n'; " +
      `test "$KMUX_SOCKET_PATH" = ${shellQuote(sandbox.socketPath)} ` +
      "&& printf '__KMUX_WALKING_ENV_OK__\\n' " +
      "|| printf '__KMUX_WALKING_ENV_MISSING__\\n'";

    await page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `${envProbe}\r`
      }
    );

    const snapshotText = await waitForSurfaceSnapshotContains(
      page,
      surfaceId,
      "__KMUX_WALKING_ENV_OK__",
      10_000
    );
    expect(snapshotText).toContain(
      `__KMUX_SOCKET_PATH:${sandbox.socketPath}__`
    );
    expect(snapshotText).toContain("__KMUX_AGENT_BIN_PRESENT__");
    expect(snapshotText).toContain("__KMUX_NODE_PRESENT__");
  } finally {
    await closeKmux(launched);
  }
});

test("walking skeleton verifies terminal cell metrics through foreground resize", async () => {
  const launched = await launchKmux("kmux-e2e-walking-skeleton-metrics-");

  try {
    const { page } = launched;
    await page.setViewportSize({ width: 900, height: 660 });
    const initial = await waitForView(
      page,
      (view) =>
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "initial pty session should reach running state before metric checks",
      10_000
    );
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;
    const initialMarker = `KMUX_WALKING_METRICS_INITIAL_${Date.now()}`;

    await page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf ${shellQuote(`${initialMarker}\\n`)}\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      page,
      surfaceId,
      initialMarker,
      10_000
    );

    const beforeState = await waitForCellMetricsSnapshotSync(
      page,
      surfaceId,
      "terminal cell metrics should settle before foreground resize"
    );
    const beforeMetrics = beforeState.metrics;
    expectCellMetricsToMatchSnapshot(beforeMetrics, beforeState.snapshot);

    await page.setViewportSize({ width: 1280, height: 860 });
    const afterState = await waitForCellMetricsSnapshotSync(
      page,
      surfaceId,
      "terminal cell metrics should settle after foreground resize",
      (metrics) =>
        metrics.screenWidth > beforeMetrics.screenWidth + 100 &&
        (metrics.terminalCols !== beforeMetrics.terminalCols ||
          metrics.terminalRows !== beforeMetrics.terminalRows)
    );
    const afterMetrics = afterState.metrics;
    expectCellMetricsToMatchSnapshot(afterMetrics, afterState.snapshot);
    const resizedMarker = `KMUX_WALKING_METRICS_RESIZED_${Date.now()}`;
    await page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf ${shellQuote(`${resizedMarker}\\n`)}\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      page,
      surfaceId,
      resizedMarker,
      10_000
    );

    await expect(
      page.locator(`[data-active-surface-id="${surfaceId}"] .xterm-rows`)
    ).toContainText(resizedMarker);
  } finally {
    await closeKmux(launched);
  }
});

test("walking skeleton preserves readable output through split and surface switches", async () => {
  const launched = await launchKmux("kmux-e2e-walking-skeleton-output-");

  try {
    const { page } = launched;
    const initial = await getView(page);
    const originalPaneId = initial.activeWorkspace.activePaneId;
    const originalSurfaceId =
      initial.activeWorkspace.panes[originalPaneId].activeSurfaceId;
    const splitMarker = `KMUX_WALKING_SPLIT_${Date.now()}`;
    const hiddenMarker = `KMUX_WALKING_HIDDEN_${Date.now()}`;

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: originalSurfaceId,
        text: `printf ${shellQuote(`${splitMarker}\\n`)}\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      page,
      originalSurfaceId,
      splitMarker,
      10_000
    );

    await dispatch(page, {
      type: "pane.split",
      paneId: originalPaneId,
      direction: "right"
    });
    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split should create a second pane before continuity assertions"
    );
    const originalRows = page.locator(
      `[data-testid="terminal-${originalSurfaceId}"] .xterm-rows`
    );
    await expect(originalRows).toContainText(splitMarker);

    await dispatch(page, {
      type: "surface.create",
      paneId: originalPaneId,
      title: "walking hidden"
    });
    const withHiddenSurface = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[originalPaneId].surfaceIds.length === 2,
      "second surface should be created in the original pane"
    );
    expect(
      withHiddenSurface.activeWorkspace.panes[originalPaneId].activeSurfaceId
    ).not.toBe(originalSurfaceId);

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: originalSurfaceId,
        text: `printf ${shellQuote(`${hiddenMarker}\\n`)}\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      page,
      originalSurfaceId,
      hiddenMarker,
      10_000
    );
    await expect(originalRows).not.toContainText(hiddenMarker);

    await dispatch(page, {
      type: "surface.focus",
      surfaceId: originalSurfaceId
    });
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[originalPaneId].activeSurfaceId ===
        originalSurfaceId,
      "original surface should become active again"
    );

    await expect(originalRows).toContainText(splitMarker);
    await expect(originalRows).toContainText(hiddenMarker);
    const restoredSnapshot = await getSurfaceSnapshot(page, originalSurfaceId);
    expect(restoredSnapshot?.vt).toContain(splitMarker);
    expect(restoredSnapshot?.vt).toContain(hiddenMarker);
  } finally {
    await closeKmux(launched);
  }
});
