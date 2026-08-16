import process from "node:process";

import { terminalSurfaceVmContent } from "@kmux/proto";
import { expect, test } from "@playwright/test";

import {
  createSandbox,
  descendantProcessIds,
  destroySandbox,
  dispatch,
  forceKillKmuxApp,
  launchKmuxWithSandbox,
  sendRpc,
  waitForProcessIdsExit,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test.skip(
  process.platform !== "linux",
  "quit confirmation close behavior is Linux-specific"
);

test("canceling Linux closes preserves and recovers the live session before Quit exits cleanly", async () => {
  const sandbox = createSandbox("kmux-e2e-linux-quit-confirm-");
  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_E2E_DISABLE_QUIT_CONFIRM: "0",
      KMUX_E2E_WINDOW_MODE: "visible"
    }
  });
  const appProcess = launched.app.process();
  let exitedCleanly = false;

  try {
    if (!appProcess?.pid) {
      throw new Error("kmux app process is unavailable");
    }

    const initial = await waitForView(
      launched.page,
      (view) => view.workspaceRows.length > 0,
      "workspace state should be available before closing the window"
    );
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;
    const sessionId = terminalSurfaceVmContent(
      initial.activeWorkspace.surfaces[surfaceId]
    )?.sessionId;

    await dispatch(launched.page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll",
        warnBeforeQuit: true
      }
    });
    await waitForView(
      launched.page,
      (view) =>
        view.settings.socketMode === "allowAll" &&
        view.settings.warnBeforeQuit === true,
      "quit warning and socket access should be enabled"
    );

    const beforeCancelMarker = `kmux-before-cancel-${Date.now()}`;
    await launched.page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf '${beforeCancelMarker}\\n'\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      launched.page,
      surfaceId,
      beforeCancelMarker
    );
    expect(
      (await sendRpc<{ pong: boolean }>(sandbox.socketPath, "system.ping")).pong
    ).toBe(true);

    const firstDialogPromise = launched.app.waitForEvent("window");
    await launched.page.getByRole("button", { name: "Close window" }).click();
    const firstDialog = await firstDialogPromise;

    await expect(
      firstDialog.getByRole("heading", {
        name: "Are you sure you want to quit kmux?"
      })
    ).toBeVisible();
    expect(launched.page.isClosed()).toBe(false);
    expect(firstDialog.isClosed()).toBe(false);
    await expect.poll(() => launched.app.windows().length).toBe(2);

    const firstDialogClosed = firstDialog.waitForEvent("close");
    await firstDialog.getByRole("button", { name: "Cancel" }).click();
    await firstDialogClosed;

    expect(launched.page.isClosed()).toBe(false);
    await expect.poll(() => launched.app.windows().length).toBe(1);
    const afterCancel = await waitForView(
      launched.page,
      (view) =>
        view.activeWorkspace.id === workspaceId &&
        view.activeWorkspace.activePaneId === paneId &&
        view.activeWorkspace.panes[paneId]?.activeSurfaceId === surfaceId,
      "cancel should preserve the original page and active session"
    );
    expect(afterCancel.activeWorkspace.id).toBe(workspaceId);

    const afterCancelMarker = `kmux-after-cancel-${Date.now()}`;
    await launched.page.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf '${afterCancelMarker}\\n'\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      launched.page,
      surfaceId,
      afterCancelMarker
    );
    expect(
      (await sendRpc<{ pong: boolean }>(sandbox.socketPath, "system.ping")).pong
    ).toBe(true);
    expect(isProcessAlive(appProcess.pid)).toBe(true);

    const secondDialogPromise = launched.app.waitForEvent("window");
    await launched.page.getByRole("button", { name: "Close window" }).click();
    const secondDialog = await secondDialogPromise;
    await expect(
      secondDialog.getByRole("button", { name: "Cancel" })
    ).toBeVisible();

    const crashedPage = launched.page;
    const recoveredPagePromise = launched.app.waitForEvent("window");
    const rendererCrashed = crashedPage.waitForEvent("crash");
    void crashedPage
      .evaluate(() => {
        const testApi = window.kmuxTest;
        if (!testApi) throw new Error("kmuxTest bridge unavailable");
        testApi.crashRenderer();
      })
      .catch(() => undefined);
    await rendererCrashed;

    expect(secondDialog.isClosed()).toBe(false);
    await expect.poll(() => launched.app.windows().length).toBe(2);

    const secondDialogClosed = secondDialog.waitForEvent("close");
    await secondDialog.getByRole("button", { name: "Cancel" }).click();
    await secondDialogClosed;

    const recoveredPage = await recoveredPagePromise;
    await recoveredPage.waitForLoadState("domcontentloaded");
    launched.page = recoveredPage;
    expect(crashedPage.isClosed()).toBe(true);
    expect(launched.app.process().pid).toBe(appProcess.pid);
    await expect.poll(() => launched.app.windows().length).toBe(1);

    const recovered = await waitForView(
      recoveredPage,
      (view) =>
        view.activeWorkspace.id === workspaceId &&
        view.activeWorkspace.activePaneId === paneId &&
        view.activeWorkspace.panes[paneId]?.activeSurfaceId === surfaceId,
      "cancel after a renderer crash should recover the active session"
    );
    expect(
      terminalSurfaceVmContent(recovered.activeWorkspace.surfaces[surfaceId])
        ?.sessionId
    ).toBe(sessionId);

    const afterRecoveryMarker = `kmux-after-recovery-${Date.now()}`;
    await recoveredPage.evaluate(
      ({ targetSurfaceId, text }) =>
        window.kmux.sendText(targetSurfaceId, text),
      {
        targetSurfaceId: surfaceId,
        text: `printf '${afterRecoveryMarker}\\n'\r`
      }
    );
    await waitForSurfaceSnapshotContains(
      recoveredPage,
      surfaceId,
      afterRecoveryMarker
    );
    expect(
      (await sendRpc<{ pong: boolean }>(sandbox.socketPath, "system.ping")).pong
    ).toBe(true);

    const thirdDialogPromise = launched.app.waitForEvent("window");
    await recoveredPage.getByRole("button", { name: "Close window" }).click();
    const thirdDialog = await thirdDialogPromise;
    await expect(
      thirdDialog.getByRole("button", { name: "Quit" })
    ).toBeVisible();

    const descendantPids = descendantProcessIds(appProcess.pid);
    expect(descendantPids.length).toBeGreaterThan(0);
    const appClosed = launched.app.waitForEvent("close");
    await thirdDialog.getByRole("button", { name: "Quit" }).click();
    await appClosed;

    expect(appProcess.signalCode).toBeNull();
    expect(appProcess.exitCode).toBe(0);
    await waitForProcessIdsExit(descendantPids, 10_000);
    await expect
      .poll(async () => {
        try {
          await sendRpc(sandbox.socketPath, "system.ping");
          return "reachable";
        } catch {
          return "closed";
        }
      })
      .toBe("closed");
    exitedCleanly = true;
  } finally {
    if (!exitedCleanly) {
      await forceKillKmuxApp(launched).catch(() => undefined);
    }
    destroySandbox(sandbox);
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
