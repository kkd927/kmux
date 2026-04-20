import { expect, test } from "@playwright/test";

import {
  closeKmuxApp,
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

    const seeded = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows.length >= 4 &&
        view.workspaceRows[0]?.name === "hq" &&
        view.workspaceRows[1]?.name === "alpha" &&
        view.workspaceRows[2]?.name === "beta" &&
        view.workspaceRows[3]?.name === "gamma",
      "workspace list should contain the draggable test fixtures"
    );

    const betaId = seeded.workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    if (!betaId) {
      throw new Error("beta workspace should exist before pinning");
    }
    await dispatch(firstLaunch.page, {
      type: "workspace.pin.toggle",
      workspaceId: betaId
    });

    const pinned = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "hq" &&
        view.workspaceRows[1]?.name === "beta" &&
        view.workspaceRows[2]?.name === "alpha" &&
        view.workspaceRows[3]?.name === "gamma",
      "pinning beta should promote it into the pinned section"
    );

    const source = firstLaunch.page.locator(
      '[data-workspace-id="' + pinned.workspaceRows[3].workspaceId + '"]'
    );
    const target = firstLaunch.page.locator(
      '[data-workspace-id="' + pinned.workspaceRows[2].workspaceId + '"]'
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
        y: Math.max(12, Math.min(targetBox.height - 12, targetBox.height * 0.25))
      }
    });

    const reorderedUnpinned = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "hq" &&
        view.workspaceRows[1]?.name === "beta" &&
        view.workspaceRows[2]?.name === "gamma" &&
        view.workspaceRows[3]?.name === "alpha",
      "workspace order should update inside the unpinned section"
    );

    expect(
      reorderedUnpinned.workspaceRows.map((row) => row.name).slice(0, 4)
    ).toEqual(["hq", "beta", "gamma", "alpha"]);

    const pinnedSource = firstLaunch.page.locator(
      '[data-workspace-id="' + reorderedUnpinned.workspaceRows[1].workspaceId + '"]'
    );
    const pinnedTarget = firstLaunch.page.locator(
      '[data-workspace-id="' + reorderedUnpinned.workspaceRows[0].workspaceId + '"]'
    );
    const pinnedTargetBox = await pinnedTarget.boundingBox();
    if (!pinnedTargetBox) {
      throw new Error(
        "pinned workspace reorder target should have a measurable bounding box"
      );
    }
    await pinnedSource.dragTo(pinnedTarget, {
      targetPosition: {
        x: Math.max(
          12,
          Math.min(pinnedTargetBox.width - 12, pinnedTargetBox.width / 2)
        ),
        y: Math.max(
          12,
          Math.min(pinnedTargetBox.height - 12, pinnedTargetBox.height * 0.25)
        )
      }
    });

    const reordered = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "beta" &&
        view.workspaceRows[1]?.name === "hq" &&
        view.workspaceRows[2]?.name === "gamma" &&
        view.workspaceRows[3]?.name === "alpha",
      "workspace order should update inside the pinned section"
    );

    expect(reordered.workspaceRows.map((row) => row.name).slice(0, 4)).toEqual([
      "beta",
      "hq",
      "gamma",
      "alpha"
    ]);

    await closeKmuxApp(firstLaunch);

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows[0]?.name === "beta" &&
        view.workspaceRows[1]?.name === "hq" &&
        view.workspaceRows[2]?.name === "gamma" &&
        view.workspaceRows[3]?.name === "alpha",
      "workspace order should persist after relaunch"
    );

    expect(restored.workspaceRows.map((row) => row.name).slice(0, 4)).toEqual([
      "beta",
      "hq",
      "gamma",
      "alpha"
    ]);
  } finally {
    await closeKmuxApp(firstLaunch).catch(() => {});
    if (relaunch) {
      await closeKmuxApp(relaunch).catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
