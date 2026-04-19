import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  runCliJson,
  waitForView
} from "./helpers";

test("BEL stays silent in the notification center while OSC terminal notifications are recorded", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-notifications-");

  try {
    const { page } = launched;
    const initial = await getView(page);
    const activeSurfaceId =
      initial.activeWorkspace.panes[initial.activeWorkspace.activePaneId]
        .activeSurfaceId;

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: "printf '\\a'\r"
      }
    );
    await page.waitForTimeout(300);

    const afterBell = await getView(page);
    expect(afterBell.notifications).toHaveLength(initial.notifications.length);
    expect(afterBell.unreadNotifications).toBe(initial.unreadNotifications);

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: "printf '\\033]9;osc9 body\\a'\r"
      }
    );

    await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.source === "terminal" &&
            notification.message === "osc9 body"
        ),
      "OSC 9 notification should be created"
    );

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text:
          "printf '\\033]99;d=0;osc99 title\\033\\\\'; printf '\\033]99;p=body;osc99 body\\033\\\\'\r"
      }
    );

    await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.source === "terminal" &&
            notification.title === "osc99 title" &&
            notification.message === "osc99 body"
        ),
      "OSC 99 notification should be created"
    );

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: "printf '\\033]777;notify;osc777 title;osc777 body\\a'\r"
      }
    );

    const finalView = await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.source === "terminal" &&
            notification.title === "osc777 title" &&
            notification.message === "osc777 body"
        ),
      "OSC 777 notification should be created"
    );

    expect(
      finalView.notifications.filter(
        (notification) => notification.source === "terminal"
      )
    ).toHaveLength(3);
  } finally {
    await closeKmux(launched);
  }
});

test("active-surface agent and terminal notifications stay in-band while hidden surfaces still notify", async () => {
  const launched = await launchKmux("kmux-e2e-vis-notify-", {
    env: {
      KMUX_E2E_WINDOW_MODE: "visible"
    }
  });

  try {
    const { page, cliPath, workspaceRoot, sandbox } = launched;
    await dispatch(page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll"
      }
    });
    const initial = await getView(page);
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const visibleSurfaceId =
      initial.activeWorkspace.panes[paneId].activeSurfaceId;
    const initialNotificationCount = initial.notifications.length;

    await runCliJson(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      [
        "agent",
        "event",
        "claude",
        "needs_input",
        "--workspace",
        workspaceId,
        "--surface",
        visibleSurfaceId,
        "--message",
        "Approve tool use?"
      ]
    );

    const afterVisibleNeedsInput = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.statusEntries.some(
          (entry) =>
            entry.key === `agent:claude:${visibleSurfaceId}` &&
            entry.text === "needs input"
        ),
      "visible agent needs-input should stay in the sidebar"
    );
    expect(afterVisibleNeedsInput.notifications).toHaveLength(
      initialNotificationCount
    );

    await runCliJson(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      [
        "agent",
        "event",
        "claude",
        "turn_complete",
        "--workspace",
        workspaceId,
        "--surface",
        visibleSurfaceId,
        "--message",
        "Finished"
      ]
    );

    const afterVisibleComplete = await waitForView(
      page,
      (view) =>
        !view.activeWorkspace.statusEntries.some(
          (entry) => entry.key === `agent:claude:${visibleSurfaceId}`
        ),
      "visible completion should clear in-band status"
    );
    expect(afterVisibleComplete.notifications).toHaveLength(
      initialNotificationCount
    );

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: visibleSurfaceId,
        text: "printf '\\033]777;notify;active title;active body\\a'\r"
      }
    );
    await page.waitForTimeout(300);

    const afterVisibleOsc = await getView(page);
    expect(
      afterVisibleOsc.notifications.some(
        (notification) =>
          notification.source === "terminal" &&
          notification.title === "active title" &&
          notification.message === "active body"
      )
    ).toBe(false);

    await dispatch(page, {
      type: "surface.create",
      paneId
    });
    const withHiddenSurface = await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "second surface should be created in the same pane"
    );
    expect(
      withHiddenSurface.activeWorkspace.panes[paneId].activeSurfaceId
    ).not.toBe(visibleSurfaceId);

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: visibleSurfaceId,
        text: "printf '\\033]777;notify;hidden title;hidden body\\a'\r"
      }
    );

    const afterHiddenOsc = await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.source === "terminal" &&
            notification.title === "hidden title" &&
            notification.message === "hidden body"
        ),
      "hidden surface OSC should create a notification"
    );
    expect(afterHiddenOsc.unreadNotifications).toBeGreaterThan(0);

    await runCliJson(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      [
        "agent",
        "event",
        "claude",
        "turn_complete",
        "--workspace",
        workspaceId,
        "--surface",
        visibleSurfaceId,
        "--message",
        "Finished hidden"
      ]
    );

    const afterHiddenComplete = await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.source === "agent" &&
            notification.title === "Claude finished" &&
            notification.message === "Finished hidden"
        ),
      "hidden surface completion should create an agent notification"
    );
    expect(afterHiddenComplete.unreadNotifications).toBeGreaterThan(0);
  } finally {
    await closeKmux(launched);
  }
});
