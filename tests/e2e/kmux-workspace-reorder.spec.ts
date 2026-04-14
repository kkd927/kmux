import { expect, test } from "@playwright/test";

import {
  createSandbox,
  destroySandbox,
  dispatch,
  launchKmuxWithSandbox,
  waitForView
} from "./helpers";

test("sidebar workspace drag reorder updates order and survives relaunch", async () => {
  const sandbox = createSandbox("kmux-e2e-workspace-reorder-");
  let firstLaunch = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;

  try {
    await dispatch(firstLaunch.page, {
      type: "workspace.create",
      name: "alpha"
    });
    await dispatch(firstLaunch.page, {
      type: "workspace.create",
      name: "beta"
    });
    await dispatch(firstLaunch.page, {
      type: "workspace.create",
      name: "gamma"
    });

    const beforeDrag = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows.length >= 4 &&
        view.workspaceRows[0]?.name === "hq" &&
        view.workspaceRows[1]?.name === "alpha" &&
        view.workspaceRows[2]?.name === "beta" &&
        view.workspaceRows[3]?.name === "gamma",
      "workspace list should contain the draggable test fixtures"
    );

    const source = firstLaunch.page.locator(
      '[data-workspace-id="' + beforeDrag.workspaceRows[0].workspaceId + '"]'
    );
    const target = firstLaunch.page.locator(
      '[data-workspace-id="' + beforeDrag.workspaceRows[3].workspaceId + '"]'
    );
    const targetBox = await target.boundingBox();
    if (!targetBox) {
      throw new Error(
        "workspace reorder target should have a measurable bounding box"
      );
    }
    await source.dragTo(target, {
      targetPosition: {
        x: Math.max(12, Math.min(targetBox.width - 12, targetBox.width / 2)),
        y: Math.max(
          12,
          Math.min(targetBox.height - 12, targetBox.height * 0.75)
        )
      }
    });

    const reordered = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "alpha" &&
        view.workspaceRows[1]?.name === "beta" &&
        view.workspaceRows[2]?.name === "gamma" &&
        view.workspaceRows[3]?.name === "hq",
      "workspace order should update after drag reorder"
    );

    expect(reordered.workspaceRows.map((row) => row.name).slice(0, 4)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "hq"
    ]);

    await firstLaunch.app.close();

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "alpha" &&
        view.workspaceRows[1]?.name === "beta" &&
        view.workspaceRows[2]?.name === "gamma" &&
        view.workspaceRows[3]?.name === "hq",
      "workspace order should persist after relaunch"
    );

    expect(restored.workspaceRows.map((row) => row.name).slice(0, 4)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "hq"
    ]);
  } finally {
    await firstLaunch.app.close().catch(() => {});
    if (relaunch) {
      await relaunch.app.close().catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
