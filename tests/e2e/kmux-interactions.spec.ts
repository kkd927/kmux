import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  runCliJson,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test("mouse resize controls update pane layout like a real user interaction", async () => {
  const launched = await launchKmux("kmux-e2e-pane-interactions-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const initialPaneId = initial.activeWorkspace.activePaneId;

    await page.getByLabel("Split active pane right").click();

    const splitView = await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split should create a second pane"
    );
    const paneIds = Object.keys(splitView.activeWorkspace.panes);
    const secondPaneId = paneIds.find((paneId) => paneId !== initialPaneId);
    expect(secondPaneId).toBeTruthy();

    const firstPane = page.locator(`[data-pane-id="${initialPaneId}"]`);
    const secondPane = page.locator(`[data-pane-id="${secondPaneId}"]`);
    const divider = page.locator('[data-split-axis="vertical"]').first();

    await expect(firstPane).toBeVisible();
    await expect(secondPane).toBeVisible();
    await expect(divider).toBeVisible();

    const firstBefore = await firstPane.boundingBox();
    const secondBefore = await secondPane.boundingBox();
    const dividerBox = await divider.boundingBox();

    expect(firstBefore).not.toBeNull();
    expect(secondBefore).not.toBeNull();
    expect(dividerBox).not.toBeNull();

    await page.mouse.move(
      dividerBox!.x + dividerBox!.width / 2,
      dividerBox!.y + dividerBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      dividerBox!.x + dividerBox!.width / 2 + 140,
      dividerBox!.y + dividerBox!.height / 2,
      { steps: 8 }
    );
    await page.mouse.up();

    await expect
      .poll(async () => {
        const firstAfter = await firstPane.boundingBox();
        return firstAfter ? Math.round(firstAfter.width) : 0;
      })
      .not.toBe(Math.round(firstBefore!.width));

    const firstAfterDrag = await firstPane.boundingBox();
    const secondAfterDrag = await secondPane.boundingBox();
    const firstDelta = firstAfterDrag!.width - firstBefore!.width;
    const secondDelta = secondAfterDrag!.width - secondBefore!.width;
    expect(Math.abs(firstDelta)).toBeGreaterThan(60);
    expect(Math.abs(secondDelta)).toBeGreaterThan(60);
    expect(Math.sign(firstDelta)).toBe(-Math.sign(secondDelta));
    await expect(page.getByLabel("Zoom active pane")).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

test("terminal supports real keyboard typing and in-pane search controls", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-input-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;
    const probeText = "kmux-real-typing-check";

    const terminal = page
      .locator(`[data-pane-id="${activePaneId}"] .xterm-screen`)
      .first();
    await terminal.click({ position: { x: 40, y: 40 } });
    await page.keyboard.type(`printf '${probeText}\\n'`);
    await page.keyboard.press("Enter");

    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      probeText,
      6000
    );

    const activePane = page.locator(`[data-pane-id="${activePaneId}"]`);
    await page.keyboard.press("Meta+F");
    const searchInput = activePane.getByLabel("Find in terminal");
    await expect(searchInput).toBeVisible();
    await searchInput.fill(probeText);
    await activePane.getByLabel("Find next result").click();
    await activePane.getByLabel("Find previous result").click();
    await activePane.getByLabel("Close terminal search").click();
    await expect(searchInput).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

test("tab close button closes only the targeted tab while pane close still closes the pane", async () => {
  const launched = await launchKmux("kmux-e2e-tab-close-button-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const paneId = initial.activeWorkspace.activePaneId;
    const firstSurfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;

    await page.getByLabel("Create new tab").click();

    const withTwoTabs = await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "new tab button should add a second tab to the current pane"
    );
    const secondSurfaceId = withTwoTabs.activeWorkspace.panes[paneId].activeSurfaceId;
    expect(secondSurfaceId).not.toBe(firstSurfaceId);

    await page
      .locator(`[data-pane-id="${paneId}"] button[title^="Close tab"]`)
      .first()
      .click();

    const afterTabClose = await waitForView(
      page,
      (view) =>
        Object.keys(view.activeWorkspace.panes).length === 1 &&
        view.activeWorkspace.panes[paneId].surfaceIds.length === 1,
      "tab close button should close only the selected tab"
    );

    expect(afterTabClose.activeWorkspace.panes[paneId].surfaceIds).toHaveLength(1);

    await page.locator(`[data-pane-id="${paneId}"]`).getByLabel("Split active pane right").click();

    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split button should add a second pane before pane close"
    );

    await page.locator(`[data-pane-id="${paneId}"]`).getByLabel("Close active pane").click();

    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 1,
      "pane close button should still remove the whole pane"
    );
  } finally {
    await closeKmux(launched);
  }
});

test("terminal scrollback responds to wheel scrolling after long output", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-scroll-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;

    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...initial.settings,
        socketMode: "allowAll"
      }
    });

    runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "surface",
        "send-text",
        "--surface",
        activeSurfaceId,
        "--text",
        "for i in $(seq 1 180); do echo kmux-scroll-$i; done\r"
      ]
    );

    const terminal = page.getByTestId(`terminal-${activeSurfaceId}`);
    const terminalScreen = page
      .locator(`[data-pane-id="${activePaneId}"] .xterm-screen`)
      .first();

    await expect
      .poll(async () => {
        const baseY = await terminal.getAttribute("data-terminal-base-y");
        return Number(baseY ?? "0");
      })
      .toBeGreaterThan(0);

    await terminalScreen.hover();

    const initialViewportY = Number(
      (await terminal.getAttribute("data-terminal-viewport-y")) ?? "0"
    );
    await page.mouse.wheel(0, -2200);

    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-viewport-y")) ?? "0")
      )
      .toBeLessThan(initialViewportY);

    const afterScrollUp = Number(
      (await terminal.getAttribute("data-terminal-viewport-y")) ?? "0"
    );

    await page.mouse.wheel(0, 2200);

    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-viewport-y")) ?? "0")
      )
      .toBeGreaterThan(afterScrollUp);
  } finally {
    await closeKmux(launched);
  }
});

test("terminal shortcuts cover paste, search navigation, copy mode, and copy", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-shortcuts-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;

    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...initial.settings,
        socketMode: "allowAll"
      }
    });

    await page.evaluate(() => {
      window.kmux.writeClipboardText("printf 'kmux-paste-shortcut\\n'\r");
    });

    const terminalInput = page.locator("textarea.xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.press("Meta+V");
    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "kmux-paste-shortcut",
      6000
    );

    runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "surface",
        "send-text",
        "--surface",
        activeSurfaceId,
        "--text",
        "for i in $(seq 1 180); do echo kmux-find-hit-$i; done\r"
      ]
    );

    const terminal = page.getByTestId(`terminal-${activeSurfaceId}`);
    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-base-y")) ?? "0")
      )
      .toBeGreaterThan(0);

    await page.keyboard.press("Meta+F");
    const searchInput = page.getByLabel("Find in terminal");
    await expect(searchInput).toBeFocused();
    await searchInput.fill("kmux-find-hit");
    await searchInput.press("Meta+G");

    const searchMatches = page.locator(
      `[data-pane-id="${activePaneId}"] .xterm-find-result-decoration`
    );
    await expect
      .poll(async () => searchMatches.count())
      .toBeGreaterThan(0);

    const readActiveSearchMatchTop = async (): Promise<number | null> =>
      page.evaluate((paneId) => {
        const matches = Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-pane-id="${paneId}"] .xterm-find-result-decoration`
          )
        );
        if (matches.length === 0) {
          return null;
        }

        const outlineCounts = new Map<string, number>();
        for (const match of matches) {
          const outlineColor = getComputedStyle(match).outlineColor;
          outlineCounts.set(
            outlineColor,
            (outlineCounts.get(outlineColor) ?? 0) + 1
          );
        }

        const inactiveOutlineColor =
          [...outlineCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
          null;
        const activeMatch = matches.find(
          (match) => getComputedStyle(match).outlineColor !== inactiveOutlineColor
        );
        return activeMatch?.getBoundingClientRect().top ?? null;
      }, activePaneId);

    await expect.poll(readActiveSearchMatchTop).not.toBeNull();
    const firstTop = await readActiveSearchMatchTop();
    await searchInput.press("Meta+G");
    await expect
      .poll(readActiveSearchMatchTop)
      .not.toBe(firstTop);

    const nextTop = await readActiveSearchMatchTop();
    await searchInput.press("Meta+Shift+G");
    await expect
      .poll(readActiveSearchMatchTop)
      .not.toBe(nextTop);

    await page.keyboard.press("Escape");
    await expect(searchInput).toHaveCount(0);
    await expect(terminalInput).toBeFocused();

    const viewportBeforeCopyMode = Number(
      (await terminal.getAttribute("data-terminal-viewport-y")) ?? "0"
    );
    await page.keyboard.press("Meta+Shift+M");

    const activePane = page.locator(`[data-pane-id="${activePaneId}"]`);
    await expect(activePane).toHaveAttribute("data-copy-mode", "true");

    await page.keyboard.press("End");
    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-viewport-y")) ?? "0")
      )
      .toBeGreaterThan(viewportBeforeCopyMode);

    await page.keyboard.press("Meta+C");
    await expect
      .poll(async () => {
        const clipboardText = await page.evaluate(() =>
          window.kmux.readClipboardText()
        );
        return (
          clipboardText.includes("kmux-find-hit-1") &&
          clipboardText.includes("kmux-paste-shortcut")
        );
      })
      .toBeTruthy();

    await page.keyboard.press("Escape");
    await expect(activePane).toHaveAttribute("data-copy-mode", "false");
  } finally {
    await closeKmux(launched);
  }
});
