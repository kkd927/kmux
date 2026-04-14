import { expect, test } from "@playwright/test";

import {
  createSandbox,
  destroySandbox,
  dispatch,
  getView,
  launchKmuxWithSandbox,
  waitForView
} from "./helpers";

test("startupRestore governs snapshot reuse across relaunches", async () => {
  const sandbox = createSandbox("kmux-restore-");
  let firstLaunch = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;
  let finalRelaunch:
    | Awaited<ReturnType<typeof launchKmuxWithSandbox>>
    | undefined;

  try {
    const initial = await getView(firstLaunch.page);
    const initialWorkspaceCount = initial.workspaceRows.length;

    await dispatch(firstLaunch.page, {
      type: "workspace.create",
      name: "restore workspace"
    });

    const afterWorkspace = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows.length === initialWorkspaceCount + 1 &&
        view.activeWorkspace.name === "restore workspace",
      "workspace should be created before restore"
    );

    await dispatch(firstLaunch.page, {
      type: "pane.split",
      paneId: afterWorkspace.activeWorkspace.activePaneId,
      direction: "right"
    });
    const afterSplit = await waitForView(
      firstLaunch.page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split should be reflected before relaunch"
    );

    await dispatch(firstLaunch.page, {
      type: "settings.update",
      patch: {
        ...afterSplit.settings,
        startupRestore: true
      }
    });

    await firstLaunch.app.close();

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows.some((row) => row.name === "restore workspace") &&
        Object.keys(view.activeWorkspace.panes).length === 2 &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "restore-enabled relaunch should reuse the saved workspace layout"
    );
    expect(
      restored.workspaceRows.some((row) => row.name === "restore workspace")
    ).toBeTruthy();
    expect(Object.keys(restored.activeWorkspace.panes)).toHaveLength(2);

    await dispatch(relaunch.page, {
      type: "settings.update",
      patch: {
        ...restored.settings,
        startupRestore: false
      }
    });

    await relaunch.app.close();

    finalRelaunch = await launchKmuxWithSandbox(sandbox);
    const reset = await waitForView(
      finalRelaunch.page,
      (view) =>
        view.workspaceRows.every((row) => row.name !== "restore workspace"),
      "restore-disabled relaunch should ignore the saved snapshot"
    );
    expect(
      reset.workspaceRows.some((row) => row.name === "restore workspace")
    ).toBeFalsy();
  } finally {
    await firstLaunch.app.close().catch(() => {});
    if (relaunch) {
      await relaunch.app.close().catch(() => {});
    }
    if (finalRelaunch) {
      await finalRelaunch.app.close().catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
