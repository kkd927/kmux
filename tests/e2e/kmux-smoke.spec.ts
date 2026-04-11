import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  runCliJson,
  waitForView
} from "./helpers";

test("kmux electron smoke flow (workspace + pane + surface + notification)", async () => {
  const launched = await launchKmux("kmux-e2e-smoke-");
  const { page: appWindow, sandbox, cliPath, workspaceRoot } = launched;
  try {
    await appWindow.waitForLoadState("domcontentloaded");
    await appWindow.setViewportSize({ width: 1277, height: 1179 });

    const initial = await getView(appWindow);
    expect(initial.workspaceRows.length).toBeGreaterThan(0);

    const workspaceCount = initial.workspaceRows.length;

    await dispatch(appWindow, {
      type: "workspace.create",
      name: "smoke workspace"
    });
    const afterWorkspace = await waitForView(
      appWindow,
      (view) => view.workspaceRows.length === workspaceCount + 1,
      "workspace should be created"
    );
    expect(
      afterWorkspace.workspaceRows.some((row) => row.name === "smoke workspace")
    ).toBeTruthy();
    const paneCountBeforeSplit = Object.keys(
      afterWorkspace.activeWorkspace.panes
    ).length;

    const activePaneId = afterWorkspace.activeWorkspace.activePaneId;
    await dispatch(appWindow, {
      type: "pane.split",
      paneId: activePaneId,
      direction: "right"
    });
    const afterSplit = await waitForView(
      appWindow,
      (view) =>
        Object.keys(view.activeWorkspace.panes).length ===
        paneCountBeforeSplit + 1,
      "pane split should add one new pane"
    );
    expect(Object.keys(afterSplit.activeWorkspace.panes).length).toBe(
      paneCountBeforeSplit + 1
    );
    const surfaceCountBeforeCreate = Object.keys(
      afterSplit.activeWorkspace.surfaces
    ).length;

    await dispatch(appWindow, {
      type: "surface.create",
      paneId: afterSplit.activeWorkspace.activePaneId
    });
    const afterSurface = await waitForView(
      appWindow,
      (view) =>
        Object.keys(view.activeWorkspace.surfaces).length ===
        surfaceCountBeforeCreate + 1,
      "surface create should add one new surface"
    );
    expect(Object.keys(afterSurface.activeWorkspace.surfaces).length).toBe(
      surfaceCountBeforeCreate + 1
    );

    const targetWorkspaceId = afterSurface.activeWorkspace.id;
    const targetPaneId = afterSurface.activeWorkspace.activePaneId;
    const targetSurfaceId =
      afterSurface.activeWorkspace.panes[targetPaneId].activeSurfaceId;

    const beforeNotificationCount = afterSurface.notifications.length;
    await dispatch(appWindow, {
      type: "notification.create",
      workspaceId: targetWorkspaceId,
      paneId: targetPaneId,
      surfaceId: targetSurfaceId,
      title: "smoke notification",
      message: "kmux e2e smoke notification"
    });

    const afterNotification = await waitForView(
      appWindow,
      (view) =>
        view.notifications.length === beforeNotificationCount + 1 &&
        view.unreadNotifications >= 1 &&
        view.notifications.some(
          (notification) => notification.title === "smoke notification"
        ),
      "notification should be created and visible in view model"
    );

    expect(
      afterNotification.notifications.some(
        (notification) => notification.title === "smoke notification"
      )
    ).toBeTruthy();
    expect(afterNotification.unreadNotifications).toBeGreaterThan(0);

    await dispatch(appWindow, {
      type: "settings.update",
      patch: {
        ...afterNotification.settings,
        socketMode: "allowAll"
      }
    });

    const ping = runCliJson<{ pong: boolean }>(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      ["system", "ping"]
    );
    expect(ping.pong).toBeTruthy();

    const identify = runCliJson<{ capabilities: string[]; socketMode: string }>(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      ["system", "identify"]
    );
    expect(identify.socketMode).toBe("allowAll");
    expect(identify.capabilities).toContain("system.ping");
    expect(identify.capabilities).toContain("sidebar_state");
  } finally {
    await closeKmux(launched);
  }
});
