import { expect, test } from "@playwright/test";

import { closeKmux, dispatch, getView, launchKmux } from "./helpers";

async function expectWorkspaceRowsNotOverlapping(
  page: Parameters<typeof dispatch>[0]
): Promise<void> {
  const layout = await page.locator("[data-workspace-id]").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent ?? "",
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height
      };
    })
  );

  expect(layout.length).toBeGreaterThan(1);

  for (let index = 1; index < layout.length; index += 1) {
    const gap = layout[index].top - layout[index - 1].bottom;
    expect(gap).toBeGreaterThanOrEqual(-1);
    expect(gap).toBeLessThanOrEqual(2);
  }
}

async function readWorkspaceRowHeights(
  page: Parameters<typeof dispatch>[0]
): Promise<Array<{ workspaceId: string; active: boolean; height: number }>> {
  return page.locator("[data-workspace-id]").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        workspaceId: element.getAttribute("data-workspace-id") ?? "",
        active: element.getAttribute("data-active") === "true",
        height: Math.round(rect.height)
      };
    })
  );
}

test("single-pane layout fills the main shell area without a large dead zone", async () => {
  const launched = await launchKmux("kmux-e2e-layout-fill-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    const main = page.locator("main").first();
    const pane = page.locator("[data-pane-id]").first();

    const mainBox = await main.boundingBox();
    const paneBox = await pane.boundingBox();

    expect(mainBox).not.toBeNull();
    expect(paneBox).not.toBeNull();

    expect(paneBox!.height).toBeGreaterThan(mainBox!.height * 0.9);
    expect(paneBox!.width).toBeGreaterThan(mainBox!.width * 0.98);
  } finally {
    await closeKmux(launched);
  }
});

test("workspace sidebar rows do not overlap when many workspaces are visible", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-density-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    for (const name of [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta"
    ]) {
      await dispatch(page, {
        type: "workspace.create",
        name
      });
    }

    await page.waitForTimeout(250);

    await expectWorkspaceRowsNotOverlapping(page);
  } finally {
    await closeKmux(launched);
  }
});

test("workspace sidebar rows stay separated while active workspace details expand and shortcut hints toggle", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-variable-heights-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
      await dispatch(page, {
        type: "workspace.create",
        name
      });
    }

    const view = await getView(page);
    const betaId = view.workspaceRows.find((row) => row.name === "beta")?.workspaceId;
    const gammaId = view.workspaceRows.find((row) => row.name === "gamma")?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();

    await dispatch(page, {
      type: "sidebar.setStatus",
      workspaceId: betaId!,
      text: "Codex waiting for input"
    });
    await dispatch(page, {
      type: "sidebar.setProgress",
      workspaceId: betaId!,
      progress: {
        value: 0.45,
        label: "Planning"
      }
    });
    await dispatch(page, {
      type: "sidebar.log",
      workspaceId: betaId!,
      level: "info",
      message: "Ready for review"
    });
    await dispatch(page, { type: "workspace.select", workspaceId: betaId! });
    await page.waitForTimeout(150);

    await expectWorkspaceRowsNotOverlapping(page);

    await page.keyboard.down("Meta");
    await expectWorkspaceRowsNotOverlapping(page);
    await page.keyboard.up("Meta");

    await dispatch(page, { type: "workspace.select", workspaceId: gammaId! });
    await page.waitForTimeout(150);

    await expectWorkspaceRowsNotOverlapping(page);

    await page.keyboard.down("Meta");
    await expectWorkspaceRowsNotOverlapping(page);
    await page.keyboard.up("Meta");
  } finally {
    await closeKmux(launched);
  }
});

test("workspace sidebar keeps default names stable, reveals command hints only while meta is held, and syncs the second line to the first tab title", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-info-");

  try {
    const {page, sandbox} = launched;
    await page.setViewportSize({ width: 1277, height: 1179 });

    const created = await dispatch(page, {
      type: "workspace.create",
      cwd: sandbox.profileRoot
    });
    const activeWorkspaceId = created.activeWorkspace.id;
    const activePaneId = created.activeWorkspace.activePaneId;
    const firstSurfaceId = created.activeWorkspace.panes[activePaneId].surfaceIds[0];

    await dispatch(page, {
      type: "sidebar.setStatus",
      workspaceId: activeWorkspaceId,
      text: "Codex waiting for input"
    });
    await dispatch(page, {
      type: "workspace.rename",
      workspaceId: activeWorkspaceId,
      name: "agents"
    });
    await dispatch(page, {
      type: "surface.metadata",
      surfaceId: firstSurfaceId,
      title: "claude / planning"
    });

    const activeRow = page.locator(
      `[data-workspace-id="${activeWorkspaceId}"]`
    );
    const inactiveRow = page.locator('[data-workspace-id][data-active="false"]').first();
    const activeBranchRow = activeRow.locator("[data-workspace-branch-row]");
    const inactiveBranchRow = inactiveRow.locator("[data-workspace-branch-row]");

    await expect(activeRow).toContainText("agents");
    await expect(inactiveRow).toContainText("new workspace");
    await expect(inactiveRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
    await expect(activeRow.locator("[data-workspace-summary]")).toHaveText(
      "claude / planning"
    );
    await expect(activeRow).toContainText("Codex waiting for input");
    await expect(activeRow.locator("[data-workspace-path]")).toHaveCount(1);
    await expect(activeRow.locator("[data-workspace-path]")).toContainText(
      sandbox.profileRoot
    );
    await expect(activeRow.locator("[data-workspace-branch]")).toHaveText("-");
    await expect(activeRow.locator("[data-workspace-branch-icon]")).toHaveCount(0);
    await expect(inactiveRow.locator("[data-workspace-path]")).toHaveCount(1);
    await expect(inactiveRow.locator("[data-workspace-branch]")).toHaveCount(1);
    const inactiveHeightBefore = Math.round(
      (await inactiveRow.boundingBox())?.height ?? 0
    );
    const activeHeightBefore = Math.round(
      (await activeRow.boundingBox())?.height ?? 0
    );

    await page.keyboard.down("Meta");
    await expect(inactiveRow.locator("[data-workspace-shortcut]")).toHaveText("⌘1");
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveText("⌘2");
    await expect(inactiveBranchRow).toContainText("⌘1");
    await expect(activeBranchRow).toContainText("⌘2");
    await expect
      .poll(async () => Math.round((await inactiveRow.boundingBox())?.height ?? 0))
      .toBe(inactiveHeightBefore);
    await expect
      .poll(async () => Math.round((await activeRow.boundingBox())?.height ?? 0))
      .toBe(activeHeightBefore);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await expect(inactiveRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
    await expect
      .poll(async () => Math.round((await inactiveRow.boundingBox())?.height ?? 0))
      .toBe(inactiveHeightBefore);
    await expect
      .poll(async () => Math.round((await activeRow.boundingBox())?.height ?? 0))
      .toBe(activeHeightBefore);
    await page.keyboard.up("Meta");

    await page.keyboard.down("Meta");
    await expect(inactiveRow.locator("[data-workspace-shortcut]")).toHaveText("⌘1");
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveText("⌘2");
    await expect(inactiveBranchRow).toContainText("⌘1");
    await expect(activeBranchRow).toContainText("⌘2");
    await expect
      .poll(async () => Math.round((await inactiveRow.boundingBox())?.height ?? 0))
      .toBe(inactiveHeightBefore);
    await expect
      .poll(async () => Math.round((await activeRow.boundingBox())?.height ?? 0))
      .toBe(activeHeightBefore);
    await page.keyboard.up("Meta");
    await expect(inactiveRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

test("workspace create affordances keep default names while exposing command-number hints on meta hold", async () => {
  const launched = await launchKmux("kmux-e2e-workspace-default-labels-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    await page.getByRole("button", { name: "Create workspace" }).click();
    const activeRow = page.locator('[data-workspace-id][data-active="true"]').first();
    const activeBranchRow = activeRow.locator("[data-workspace-branch-row]");
    await expect(activeRow).toContainText("new workspace");
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveCount(0);

    await page.keyboard.down("Meta");
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveText("⌘2");
    await expect(activeBranchRow).toContainText("⌘2");
    await page.keyboard.up("Meta");
    await expect(activeRow.locator("[data-workspace-shortcut]")).toHaveCount(0);

    await page.keyboard.press("Meta+N");
    const latestActiveRow = page.locator('[data-workspace-id][data-active="true"]').first();
    const latestActiveBranchRow = latestActiveRow.locator(
      "[data-workspace-branch-row]"
    );
    await expect(latestActiveRow).toContainText("new workspace");
    await expect(latestActiveRow.locator("[data-workspace-shortcut]")).toHaveCount(0);

    await page.keyboard.down("Meta");
    await expect(latestActiveRow.locator("[data-workspace-shortcut]")).toHaveText("⌘3");
    await expect(latestActiveBranchRow).toContainText("⌘3");
    await page.keyboard.up("Meta");
  } finally {
    await closeKmux(launched);
  }
});

test("workspace sidebar row heights stay stable when the sidebar is resized and a new workspace is created", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-row-heights-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    for (let count = 0; count < 3; count += 1) {
      await dispatch(page, { type: "workspace.create" });
    }

    await page.waitForTimeout(200);
    await expect(
      page.locator('[data-workspace-id][data-active="true"] [data-workspace-path]')
    ).toHaveCount(1);
    await expectWorkspaceRowsNotOverlapping(page);

    const baseline = await readWorkspaceRowHeights(page);

    const resizer = page.getByRole("separator", {
      name: "Resize sidebar"
    });
    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();

    await page.mouse.move(
      resizerBox!.x + resizerBox!.width / 2,
      resizerBox!.y + resizerBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(resizerBox!.x - 100, resizerBox!.y + 20, {
      steps: 10
    });
    await page.mouse.up();
    await page.waitForTimeout(250);

    await expectWorkspaceRowsNotOverlapping(page);

    const afterResize = await readWorkspaceRowHeights(page);
    const baselineById = new Map(
      baseline.map((row) => [row.workspaceId, row.height] as const)
    );
    for (const row of afterResize) {
      expect(
        Math.abs(row.height - (baselineById.get(row.workspaceId) ?? row.height))
      ).toBeLessThanOrEqual(1);
    }

    await dispatch(page, { type: "workspace.create" });
    await page.waitForTimeout(200);
    await expect(
      page.locator('[data-workspace-id][data-active="true"] [data-workspace-path]')
    ).toHaveCount(1);
    await expectWorkspaceRowsNotOverlapping(page);

    const afterCreate = await readWorkspaceRowHeights(page);
    expect(afterCreate.filter((row) => row.active)).toHaveLength(1);
    expect(afterCreate.length).toBe(baseline.length + 1);
  } finally {
    await closeKmux(launched);
  }
});

test("project chrome keeps active workspace and focused pane visually legible", async () => {
  const launched = await launchKmux("kmux-e2e-intellij-chrome-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    await dispatch(page, {
      type: "workspace.create",
      name: "alpha"
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "beta"
    });

    await expect(page.getByTestId("project-header")).toBeVisible();

    await dispatch(page, {
      type: "pane.split",
      paneId: (await page
        .locator("[data-pane-id]")
        .first()
        .getAttribute("data-pane-id"))!,
      direction: "right"
    });
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);

    const workspaceStyles = await page.evaluate(() => {
      const active = document.querySelector<HTMLElement>(
        '[data-workspace-id][data-active="true"]'
      );
      const inactive = document.querySelector<HTMLElement>(
        '[data-workspace-id][data-active="false"]'
      );

      return {
        activeBackground: active
          ? getComputedStyle(active).backgroundColor
          : "",
        inactiveBackground: inactive
          ? getComputedStyle(inactive).backgroundColor
          : "",
        activeBorder: active ? getComputedStyle(active).borderColor : ""
      };
    });

    expect(workspaceStyles.activeBackground).not.toBe(
      workspaceStyles.inactiveBackground
    );
    expect(workspaceStyles.activeBorder).not.toBe("rgba(0, 0, 0, 0)");

    const paneStyles = await page.evaluate(() => {
      const focused = document.querySelector<HTMLElement>(
        '[data-pane-id][data-focused="true"]'
      );
      const unfocused = document.querySelector<HTMLElement>(
        '[data-pane-id][data-focused="false"]'
      );

      return {
        focusedShadow: focused ? getComputedStyle(focused).boxShadow : "",
        unfocusedShadow: unfocused ? getComputedStyle(unfocused).boxShadow : "",
        focusedBorder: focused ? getComputedStyle(focused).borderColor : "",
        unfocusedBorder: unfocused
          ? getComputedStyle(unfocused).borderColor
          : ""
      };
    });

    expect(paneStyles.focusedShadow).not.toBe(paneStyles.unfocusedShadow);
    expect(paneStyles.focusedBorder).not.toBe(paneStyles.unfocusedBorder);
  } finally {
    await closeKmux(launched);
  }
});

test("narrow pane tabs keep the close button visible for long titles", async () => {
  const launched = await launchKmux("kmux-e2e-narrow-tab-close-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    let view = await dispatch(page, {
      type: "pane.split",
      paneId: (await page
        .locator("[data-pane-id]")
        .first()
        .getAttribute("data-pane-id"))!,
      direction: "right"
    });
    view = await dispatch(page, {
      type: "pane.split",
      paneId: view.activeWorkspace.activePaneId,
      direction: "right"
    });
    view = await dispatch(page, {
      type: "pane.split",
      paneId: view.activeWorkspace.activePaneId,
      direction: "right"
    });

    const panes = Object.values(view.activeWorkspace.panes);
    expect(panes).toHaveLength(4);

    for (const [index, pane] of panes.entries()) {
      view = await dispatch(page, {
        type: "surface.metadata",
        surfaceId: pane.activeSurfaceId,
        title: `kkd927@macmini:~/Projects/kmux/really/long/path/${index}`
      });
    }

    const closeButtonGeometry = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).map(
        (pane) => {
          const tablist = pane.querySelector<HTMLElement>('[role="tablist"]');
          const closeButton = pane.querySelector<HTMLElement>(
            'button[aria-label^="Close tab"]'
          );
          const tablistRect = tablist?.getBoundingClientRect();
          const closeRect = closeButton?.getBoundingClientRect();
          return {
            paneId: pane.getAttribute("data-pane-id"),
            opacity: closeButton ? getComputedStyle(closeButton).opacity : "0",
            withinTablist: Boolean(
              tablistRect &&
                closeRect &&
                closeRect.left >= tablistRect.left &&
                closeRect.right <= tablistRect.right
            )
          };
        }
      )
    );

    expect(closeButtonGeometry).toHaveLength(4);
    for (const geometry of closeButtonGeometry) {
      expect(geometry.opacity).not.toBe("0");
      expect(geometry.withinTablist).toBeTruthy();
    }
  } finally {
    await closeKmux(launched);
  }
});
