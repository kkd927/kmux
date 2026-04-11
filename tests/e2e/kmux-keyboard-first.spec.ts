import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  waitForView
} from "./helpers";

test("command palette supports a keyboard-only flow", async () => {
  const launched = await launchKmux("kmux-e2e-keyboard-palette-");

  try {
    const page = launched.page;

    await dispatch(page, {
      type: "workspace.create",
      name: "alpha"
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "beta"
    });

    await page.keyboard.press("Meta+Shift+P");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();

    const commandQuery = page.getByLabel("Command palette query");
    await commandQuery.fill("split right");
    await page.keyboard.press("Enter");

    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "command palette should run the selected split action"
    );

    await page.keyboard.press("Meta+Shift+P");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

test("workspace and surface shortcuts plus notification jump work like a keyboard-first app", async () => {
  const launched = await launchKmux("kmux-e2e-keyboard-shortcuts-");

  try {
    const page = launched.page;
    const initial = await getView(page);

    await dispatch(page, {
      type: "workspace.create",
      name: "alpha"
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "alerts"
    });

    const workspaces = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === initial.workspaceRows.length + 2 &&
        view.activeWorkspace.name === "alerts",
      "keyboard shortcut test fixtures should be ready"
    );

    const alertsWorkspaceId = workspaces.activeWorkspace.id;
    const alertsPaneId = workspaces.activeWorkspace.activePaneId;
    const alertsSurfaceId =
      workspaces.activeWorkspace.panes[alertsPaneId].activeSurfaceId;
    const originalAlertSurfaceId = alertsSurfaceId;

    await page.keyboard.press("Meta+1");
    await waitForView(
      page,
      (view) => view.activeWorkspace.name === "hq",
      "Meta+1 should select the first workspace"
    );

    await page.keyboard.press("Meta+3");
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === alertsWorkspaceId,
      "Meta+3 should select the third workspace"
    );

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+T");
    const withSecondSurface = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[alertsPaneId].surfaceIds.length === 2,
      "Meta+T should create a second surface"
    );
    const secondSurfaceId =
      withSecondSurface.activeWorkspace.panes[alertsPaneId].activeSurfaceId;
    expect(secondSurfaceId).not.toBe(originalAlertSurfaceId);

    await page.keyboard.press("Control+1");
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[alertsPaneId].activeSurfaceId ===
        originalAlertSurfaceId,
      "Control+1 should focus the first surface"
    );

    await page.keyboard.press("Control+2");
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[alertsPaneId].activeSurfaceId ===
        secondSurfaceId,
      "Control+2 should focus the second surface"
    );

    await page.keyboard.press("Meta+1");
    await waitForView(
      page,
      (view) => view.activeWorkspace.name === "hq",
      "should return to the first workspace before notification jump"
    );

    await dispatch(page, {
      type: "notification.create",
      workspaceId: alertsWorkspaceId,
      paneId: alertsPaneId,
      surfaceId: secondSurfaceId,
      title: "alerts jump",
      message: "jump to keyboard target"
    });

    await page.keyboard.press("Meta+I");
    const notifications = page.getByRole("dialog", { name: "Notifications" });
    await expect(notifications).toBeVisible();
    await page.getByRole("button", { name: "Jump latest unread" }).click();

    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.id === alertsWorkspaceId &&
        view.activeWorkspace.panes[alertsPaneId].activeSurfaceId ===
          secondSurfaceId,
      "notification jump should focus the latest unread target"
    );
    await expect(notifications).toHaveCount(0);

    const afterJump = await getView(page);
    expect(
      afterJump.notifications.some(
        (notification) =>
          notification.title === "alerts jump" && !notification.read
      )
    ).toBeFalsy();
  } finally {
    await closeKmux(launched);
  }
});

test("rename and close shortcuts keep workspace, pane, and surface management keyboard-first", async () => {
  const launched = await launchKmux("kmux-e2e-keyboard-rename-close-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const workspaceId = initial.activeWorkspace.id;
    const initialPaneId = initial.activeWorkspace.activePaneId;

    await page.keyboard.press("Meta+Shift+R");
    const workspaceRenameInput = page.locator(
      `[data-workspace-id="${workspaceId}"] input`
    );
    await expect(workspaceRenameInput).toBeFocused();
    await workspaceRenameInput.fill("ops");
    await workspaceRenameInput.press("Enter");

    await waitForView(
      page,
      (view) => view.activeWorkspace.name === "ops",
      "workspace rename shortcut should update the active workspace name"
    );

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+T");

    const withTwoSurfaces = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[initialPaneId].surfaceIds.length === 2,
      "surface create shortcut should create another tab"
    );
    const renamedSurfaceId =
      withTwoSurfaces.activeWorkspace.panes[initialPaneId].activeSurfaceId;
    const surfaceRenameShortcut = withTwoSurfaces.settings.shortcuts[
      "surface.rename"
    ].replace("Ctrl", "Control");

    await expect(page.locator("textarea.xterm-helper-textarea")).toBeFocused();
    const surfaceRenameInput = page.locator(
      `[data-pane-id="${initialPaneId}"] input[aria-label^="Rename surface"]`
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.keyboard.press(surfaceRenameShortcut);
      if ((await surfaceRenameInput.count()) > 0) {
        break;
      }
      await page.waitForTimeout(100);
    }
    await expect(surfaceRenameInput).toHaveCount(1);
    await expect(surfaceRenameInput).toBeFocused();
    await surfaceRenameInput.fill("logs");
    await surfaceRenameInput.press("Enter");
    await expect(surfaceRenameInput).toHaveCount(0);

    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.surfaces[renamedSurfaceId].title === "logs",
      "surface rename shortcut should update the active tab title"
    );

    await page.keyboard.press("Control+Meta+W");
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[initialPaneId].surfaceIds.length === 1 &&
        view.activeWorkspace.panes[initialPaneId].activeSurfaceId ===
          renamedSurfaceId,
      "close others shortcut should keep only the renamed active tab"
    );

    await page.keyboard.press("Meta+D");
    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split shortcut should create a second pane before pane close"
    );

    await page.keyboard.press("Meta+Alt+K");
    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 1,
      "pane close shortcut should remove the active pane"
    );
  } finally {
    await closeKmux(launched);
  }
});
