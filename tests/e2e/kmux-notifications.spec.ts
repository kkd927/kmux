import { expect, test } from "@playwright/test";

import { closeKmux, getView, launchKmux, waitForView } from "./helpers";

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
