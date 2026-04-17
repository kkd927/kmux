import { expect, test } from "@playwright/test";
import type { ShellViewModel } from "@kmux/proto";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  waitForView
} from "./helpers";

function listPaneIdsInTreeOrder(
  workspace: ShellViewModel["activeWorkspace"]
): string[] {
  const paneIds: string[] = [];

  function walk(nodeId: string): void {
    const node = workspace.nodes[nodeId];
    if (!node) {
      return;
    }
    if (node.kind === "leaf") {
      if (workspace.panes[node.paneId]) {
        paneIds.push(node.paneId);
      }
      return;
    }
    walk(node.first);
    walk(node.second);
  }

  walk(workspace.rootNodeId);
  return paneIds;
}

function listSurfaceShortcutTargets(workspace: ShellViewModel["activeWorkspace"]): {
  paneId: string;
  surfaceId: string;
}[] {
  return listPaneIdsInTreeOrder(workspace).flatMap((paneId) =>
    (workspace.panes[paneId]?.surfaceIds ?? []).map((surfaceId) => ({
      paneId,
      surfaceId
    }))
  );
}

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
    const alphaWorkspaceId = workspaces.workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;
    const alertsPaneId = workspaces.activeWorkspace.activePaneId;
    const alertsSurfaceId =
      workspaces.activeWorkspace.panes[alertsPaneId].activeSurfaceId;
    const originalAlertSurfaceId = alertsSurfaceId;
    expect(alphaWorkspaceId).toBeTruthy();

    await dispatch(page, {
      type: "workspace.pin.toggle",
      workspaceId: alertsWorkspaceId
    });
    await waitForView(
      page,
      (view) =>
        view.workspaceRows[0]?.workspaceId === initial.activeWorkspace.id &&
        view.workspaceRows[1]?.workspaceId === alertsWorkspaceId &&
        view.workspaceRows[2]?.workspaceId === alphaWorkspaceId,
      "pinning alerts should change the visible workspace shortcut order"
    );

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+1");
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === initial.activeWorkspace.id,
      "Meta+1 should select the first workspace"
    );

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+2");
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === alertsWorkspaceId,
      "Meta+2 should select the second visible workspace"
    );

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+3");
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === alphaWorkspaceId,
      "Meta+3 should select the third visible workspace"
    );

    await dispatch(page, {
      type: "workspace.select",
      workspaceId: alertsWorkspaceId
    });
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === alertsWorkspaceId,
      "surface shortcut flow should start in the alerts workspace"
    );

    const alertsTerminal = page.locator(
      `[data-pane-id="${alertsPaneId}"] textarea.xterm-helper-textarea`
    );
    await alertsTerminal.focus();
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

    await alertsTerminal.focus();
    await page.keyboard.press("Control+1");
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.id === alertsWorkspaceId &&
        view.activeWorkspace.panes[alertsPaneId]?.activeSurfaceId ===
        originalAlertSurfaceId,
      "Control+1 should focus the first surface"
    );
    await expect(alertsTerminal).toBeFocused();

    await alertsTerminal.focus();
    await page.keyboard.press("Control+2");
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.id === alertsWorkspaceId &&
        view.activeWorkspace.panes[alertsPaneId]?.activeSurfaceId ===
        secondSurfaceId,
      "Control+2 should focus the second surface"
    );
    await expect(alertsTerminal).toBeFocused();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await alertsTerminal.focus();
      await page.keyboard.press("Control+1");
      await alertsTerminal.focus();
      await page.keyboard.press("Control+2");
    }
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.id === alertsWorkspaceId &&
        view.activeWorkspace.panes[alertsPaneId]?.activeSurfaceId ===
        secondSurfaceId,
      "Control+number shortcuts should not leave the pane on the wrong tab"
    );
    const afterShortcutMash = await getView(page);
    expect(
      Object.values(afterShortcutMash.activeWorkspace.surfaces).some(
        (surface) => surface.attention || surface.unreadCount > 0
      )
    ).toBeFalsy();

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+1");
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === initial.activeWorkspace.id,
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
        (notification) => notification.title === "alerts jump"
      )
    ).toBeFalsy();
  } finally {
    await closeKmux(launched);
  }
});

test("workspace rename and tab close shortcuts stay keyboard-first while tab rename stays disabled", async () => {
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

    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[initialPaneId].surfaceIds.length === 2,
      "surface create shortcut should create another tab"
    );
    await expect(page.locator("textarea.xterm-helper-textarea")).toBeFocused();
    const surfaceRenameInput = page.locator(
      `[data-pane-id="${initialPaneId}"] input[aria-label^="Rename surface"]`
    );
    const activeTab = page.locator(
      `[data-pane-id="${initialPaneId}"] [role="tab"][aria-selected="true"]`
    );
    await activeTab.dblclick();
    await page.waitForTimeout(100);
    await expect(surfaceRenameInput).toHaveCount(0);
    await page.keyboard.press("Meta+Control+R");
    await page.waitForTimeout(100);
    await expect(surfaceRenameInput).toHaveCount(0);

    await page.keyboard.press("Control+Meta+W");
    await waitForView(
      page,
      (view) => view.activeWorkspace.panes[initialPaneId].surfaceIds.length === 1,
      "close others shortcut should keep only one tab"
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

test("Meta+W on the last tab opens the workspace close confirmation", async () => {
  const launched = await launchKmux("kmux-e2e-keyboard-last-tab-close-");

  try {
    const page = launched.page;

    await dispatch(page, {
      type: "workspace.create",
      name: "alpha"
    });
    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 2 && view.activeWorkspace.name === "alpha",
      "workspace fixture should be ready before keyboard last-tab close"
    );
    const workspaceId = seeded.activeWorkspace.id;

    const terminal = page.locator("textarea.xterm-helper-textarea");
    const dialog = page.getByTestId("workspace-close-confirm-dialog");

    await terminal.focus();
    await page.keyboard.press("Meta+W");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "This workspace only has one tab left. Closing it will close the workspace."
    );

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await getView(page)).activeWorkspace.id).toBe(workspaceId);

    await terminal.focus();
    await page.keyboard.press("Meta+W");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close Workspace" }).click();

    const afterConfirm = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 1 &&
        view.workspaceRows.every((row) => row.workspaceId !== workspaceId),
      "keyboard confirmation should close the workspace after Meta+W"
    );

    expect(afterConfirm.activeWorkspace.id).not.toBe(workspaceId);
  } finally {
    await closeKmux(launched);
  }
});

test("surface index shortcuts traverse workspace tabs across split panes without creating attention", async () => {
  const launched = await launchKmux("kmux-e2e-keyboard-split-surface-index-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const firstPaneId = initial.activeWorkspace.activePaneId;

    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+T");
    await waitForView(
      page,
      (view) => view.activeWorkspace.panes[firstPaneId].surfaceIds.length === 2,
      "first pane should gain a second tab"
    );
    await page.keyboard.press("Meta+T");
    await waitForView(
      page,
      (view) => view.activeWorkspace.panes[firstPaneId].surfaceIds.length === 3,
      "first pane should gain a third tab"
    );

    await page.keyboard.press("Meta+D");

    const splitView = await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split shortcut should create a second pane before pane shortcut checks"
    );
    const secondPaneId = splitView.activeWorkspace.activePaneId;

    await page
      .locator(`[data-pane-id="${secondPaneId}"] textarea.xterm-helper-textarea`)
      .focus();
    await page.keyboard.press("Meta+T");

    await waitForView(
      page,
      (view) => view.activeWorkspace.panes[secondPaneId].surfaceIds.length === 2,
      "second pane should gain a second tab"
    );

    await page.keyboard.press("Meta+D");
    const withThreePanes = await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 3,
      "split shortcut should create a third pane"
    );

    const shortcutTargets = listSurfaceShortcutTargets(
      withThreePanes.activeWorkspace
    );
    expect(shortcutTargets).toHaveLength(6);

    const activeIndicators = page.locator('[role="tablist"] [data-active="true"]');

    for (const [index, target] of shortcutTargets.entries()) {
      await page.keyboard.press(`Control+${index + 1}`);
      await waitForView(
        page,
        (view) =>
          view.activeWorkspace.activePaneId === target.paneId &&
          view.activeWorkspace.panes[target.paneId].activeSurfaceId ===
            target.surfaceId,
        `Control+${index + 1} should focus surface ${index + 1} across split panes`
      );
      await expect(
        page.locator(
          `[data-pane-id="${target.paneId}"] textarea.xterm-helper-textarea`
        )
      ).toBeFocused();
      await expect(activeIndicators).toHaveCount(1);
    }

    for (let index = shortcutTargets.length - 1; index >= 0; index -= 1) {
      const target = shortcutTargets[index];
      await page.keyboard.press(`Control+${index + 1}`);
      await waitForView(
        page,
        (view) =>
          view.activeWorkspace.activePaneId === target.paneId &&
          view.activeWorkspace.panes[target.paneId].activeSurfaceId ===
            target.surfaceId,
        `Control+${index + 1} should still focus the same surface when traversing backward`
      );
      await expect(
        page.locator(
          `[data-pane-id="${target.paneId}"] textarea.xterm-helper-textarea`
        )
      ).toBeFocused();
    }

    const afterShortcutTraversal = await getView(page);
    expect(
      Object.values(afterShortcutTraversal.activeWorkspace.surfaces).some(
        (surface) => surface.attention || surface.unreadCount > 0
      )
    ).toBeFalsy();
  } finally {
    await closeKmux(launched);
  }
});
