import process from "node:process";

import { expect, test } from "@playwright/test";

import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  dispatch,
  launchKmuxWithSandbox,
  sendRpc,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

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

test("closing the last window keeps kmux alive and live-reopens the same session state", async () => {
  const sandbox = createSandbox("kmux-e2e-live-reopen-");
  let launched = await launchKmuxWithSandbox(sandbox);

  try {
    const seededView = await waitForView(
      launched.page,
      (view) => view.workspaceRows.length > 0,
      "workspace state should be available before closing the window"
    );
    const activePaneId = seededView.activeWorkspace.activePaneId;
    const activeSurfaceId =
      seededView.activeWorkspace.panes[activePaneId].activeSurfaceId;
    const marker = `kmux-live-reopen-${Date.now()}`;
    const appPid = launched.app.process().pid;

    await launched.page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: `printf '${marker}\\n'\r`
      }
    );
    await waitForSurfaceSnapshotContains(launched.page, activeSurfaceId, marker);

    await dispatch(launched.page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll"
      }
    });
    await waitForView(
      launched.page,
      (view) => view.settings.socketMode === "allowAll",
      "socket mode should allow direct RPC before closing the window"
    );

    const pingBeforeClose = await sendRpc<{ pong: boolean }>(
      sandbox.socketPath,
      "system.ping"
    );
    expect(pingBeforeClose.pong).toBe(true);

    const pageClose = launched.page.waitForEvent("close");
    await launched.page.evaluate(() => window.kmux.windowControl("close"));
    await pageClose;

    if (typeof appPid === "number") {
      await expect
        .poll(() => (isProcessAlive(appPid) ? "alive" : "exited"))
        .toBe("alive");
    }

    await expect
      .poll(async () => {
        try {
          const response = await sendRpc<{ pong: boolean }>(
            sandbox.socketPath,
            "system.ping"
          );
          return response.pong ? "reachable" : "closed";
        } catch {
          return "closed";
        }
      })
      .toBe("reachable");

    const reopenedWindow = launched.app.waitForEvent("window");
    await launched.app.evaluate(({ app }) => {
      app.emit("activate");
    });
    const reopenedPage = await reopenedWindow;
    await reopenedPage.waitForLoadState("domcontentloaded");
    launched = {
      ...launched,
      page: reopenedPage
    };

    const reopenedView = await waitForView(
      reopenedPage,
      (view) =>
        view.settings.socketMode === "allowAll" &&
        view.activeWorkspace.id === seededView.activeWorkspace.id &&
        view.activeWorkspace.panes[view.activeWorkspace.activePaneId]
          ?.activeSurfaceId === activeSurfaceId,
      "activate should recreate a window on top of the live in-memory state"
    );
    expect(reopenedView.activeWorkspace.id).toBe(seededView.activeWorkspace.id);
    expect(reopenedView.settings.socketMode).toBe("allowAll");

    await waitForSurfaceSnapshotContains(reopenedPage, activeSurfaceId, marker);
  } finally {
    await closeKmuxApp(launched).catch(() => {});
    destroySandbox(sandbox);
  }
});

test("explicit quit tears down background services and preserves cold restore when warn-before-quit is disabled", async () => {
  const sandbox = createSandbox("kmux-e2e-explicit-quit-");
  let launched = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;

  try {
    const initial = await waitForView(
      launched.page,
      (view) => view.workspaceRows.length > 0,
      "initial workspace state should load before explicit quit"
    );
    const restoreWorkspaceName = "quit restore workspace";
    const appPid = launched.app.process().pid;

    await dispatch(launched.page, {
      type: "workspace.create",
      name: restoreWorkspaceName
    });
    await dispatch(launched.page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll",
        warnBeforeQuit: false,
        startupRestore: true
      }
    });
    await waitForView(
      launched.page,
      (view) =>
        view.settings.socketMode === "allowAll" &&
        view.settings.warnBeforeQuit === false &&
        view.workspaceRows.some((row) => row.name === restoreWorkspaceName),
      "settings and workspace state should be saved before explicit quit"
    );

    const pingBeforeQuit = await sendRpc<{ pong: boolean }>(
      sandbox.socketPath,
      "system.ping"
    );
    expect(pingBeforeQuit.pong).toBe(true);

    await closeKmuxApp(launched);

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

    if (typeof appPid === "number") {
      await expect
        .poll(() => (isProcessAlive(appPid) ? "alive" : "exited"))
        .toBe("exited");
    }

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.settings.socketMode === "allowAll" &&
        view.settings.warnBeforeQuit === false &&
        view.workspaceRows.some((row) => row.name === restoreWorkspaceName) &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "cold restore should still work after an explicit quit"
    );

    expect(restored.workspaceRows.some((row) => row.name === restoreWorkspaceName)).toBe(
      true
    );
    expect(restored.settings.warnBeforeQuit).toBe(false);
    expect(initial.workspaceRows.length).toBeGreaterThan(0);
  } finally {
    if (relaunch) {
      await closeKmuxApp(relaunch).catch(() => {});
    }
    destroySandbox(sandbox);
  }
});

test("explicit quit clears persisted notifications before the next relaunch", async () => {
  const sandbox = createSandbox("kmux-e2e-quit-clears-notifications-");
  let launched = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;

  try {
    const initial = await waitForView(
      launched.page,
      (view) => view.workspaceRows.length > 0,
      "initial workspace state should load before creating a notification"
    );
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId =
      initial.activeWorkspace.panes[paneId]?.activeSurfaceId ?? "";

    await dispatch(launched.page, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Codex needs input",
      message: "Waiting for input",
      source: "agent",
      kind: "needs_input",
      agent: "codex"
    });
    await dispatch(launched.page, {
      type: "settings.update",
      patch: {
        warnBeforeQuit: false,
        startupRestore: true
      }
    });

    await waitForView(
      launched.page,
      (view) =>
        view.settings.warnBeforeQuit === false &&
        view.notifications.length === 1,
      "notification state should exist before explicit quit"
    );

    await closeKmuxApp(launched);

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.notifications.length === 0 &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "explicit quit should relaunch without stale notifications"
    );

    expect(restored.notifications).toEqual([]);
  } finally {
    if (relaunch) {
      await closeKmuxApp(relaunch).catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
