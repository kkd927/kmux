import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test("renderer crash reconnects to the existing shell and terminal streams", async () => {
  const launched = await launchKmux("kmux-e2e-renderer-recovery-");

  try {
    const initialPage = launched.page;
    await initialPage.setViewportSize({ width: 1400, height: 900 });
    await dispatch(initialPage, {
      type: "settings.update",
      patch: { diagnosticLoggingEnabled: true }
    });

    const initial = await getView(initialPage);
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;
    const sessionId =
      initial.activeWorkspace.surfaces[surfaceId].content.sessionId;
    const mainPid = launched.app.process().pid;
    const diagnosticLogPath = join(
      launched.sandbox.stateDir,
      "diagnostics",
      "kmux-debug.log"
    );

    await expect
      .poll(() =>
        existsSync(diagnosticLogPath)
          ? readFileSync(diagnosticLogPath, "utf8").includes(
              "main.diagnostics.configuration.changed"
            )
          : false
      )
      .toBe(true);

    await initialPage.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: "printf 'KMUX_RECOVERY_BEFORE\\n'; sleep 0.8; printf 'KMUX_RECOVERY_DURING\\n'\r"
      }
    );
    await waitForSurfaceSnapshotContains(
      initialPage,
      surfaceId,
      "KMUX_RECOVERY_BEFORE"
    );

    const replacementPagePromise = launched.app.waitForEvent("window");
    await initialPage
      .evaluate(() => {
        const testApi = window.kmuxTest;
        if (!testApi) throw new Error("kmuxTest bridge unavailable");
        testApi.crashRenderer();
      })
      .catch(() => undefined);
    const recoveredPage = await replacementPagePromise;
    await recoveredPage.waitForLoadState("domcontentloaded");
    await recoveredPage.setViewportSize({ width: 1400, height: 900 });

    expect(launched.app.process().pid).toBe(mainPid);
    const recovered = await waitForView(
      recoveredPage,
      (view) =>
        view.activeWorkspace.id === workspaceId &&
        view.activeWorkspace.activePaneId === paneId &&
        view.activeWorkspace.panes[paneId]?.activeSurfaceId === surfaceId,
      "recovered renderer should restore the active workspace, pane, and surface"
    );
    expect(
      recovered.activeWorkspace.surfaces[surfaceId].content.sessionId
    ).toBe(sessionId);
    await waitForSurfaceSnapshotContains(
      recoveredPage,
      surfaceId,
      "KMUX_RECOVERY_DURING",
      8_000
    );

    await recoveredPage.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: "printf 'KMUX_RECOVERY_AFTER\\n'\r"
      }
    );
    await waitForSurfaceSnapshotContains(
      recoveredPage,
      surfaceId,
      "KMUX_RECOVERY_AFTER"
    );

    await dispatch(recoveredPage, {
      type: "surface.create",
      paneId
    });
    const withNewSurface = await waitForView(
      recoveredPage,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "surface creation should keep working after renderer recovery"
    );
    await dispatch(recoveredPage, {
      type: "pane.split",
      paneId: withNewSurface.activeWorkspace.activePaneId,
      direction: "right"
    });
    await waitForView(
      recoveredPage,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "pane split should keep working after renderer recovery"
    );

    await expect
      .poll(() => {
        const log = existsSync(diagnosticLogPath)
          ? readFileSync(diagnosticLogPath, "utf8")
          : "";
        return (
          log.includes("main.renderer.render-process-gone") &&
          log.includes("main.renderer.recovery.started") &&
          log.includes("main.renderer.recovery.completed")
        );
      })
      .toBe(true);
  } finally {
    await closeKmux(launched);
  }
});
