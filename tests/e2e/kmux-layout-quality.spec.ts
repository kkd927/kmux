import { expect, test } from "@playwright/test";

import { closeKmux, dispatch, launchKmux } from "./helpers";

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

    const layout = await page
      .locator("[data-workspace-id]")
      .evaluateAll((elements) =>
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

    expect(layout.length).toBeGreaterThan(4);

    for (let index = 1; index < layout.length; index += 1) {
      expect(layout[index].top).toBeGreaterThanOrEqual(
        layout[index - 1].bottom - 1
      );
    }
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
