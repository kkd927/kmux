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
import type { TestShellView } from "./helpers";
import { SURFACE_TAB_DROP_PROMPT } from "../../apps/desktop/src/renderer/src/surfaceTabDrag";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function paneIdForSurface(
  view: TestShellView,
  surfaceId: string
): string | undefined {
  return Object.entries(view.activeWorkspace.panes).find(([, pane]) =>
    pane.surfaceIds.includes(surfaceId)
  )?.[0];
}

async function expectDropOverlayHalfSize(
  page: Awaited<ReturnType<typeof launchKmux>>["page"],
  surfaceId: string,
  direction: "left" | "right" | "down"
): Promise<void> {
  const ratio = await page.evaluate(
    ({ targetSurfaceId, dropDirection }) => {
      const viewport = document.querySelector(
        `[data-testid="terminal-${targetSurfaceId}"]`
      );
      const terminal = viewport?.parentElement;
      if (!(terminal instanceof HTMLElement)) {
        throw new Error("terminal drop target should exist");
      }
      terminal.setAttribute("data-surface-drop-direction", dropDirection);
      const style = getComputedStyle(terminal, "::before");
      const rect = terminal.getBoundingClientRect();
      const size =
        dropDirection === "down"
          ? Number.parseFloat(style.height)
          : Number.parseFloat(style.width);
      terminal.removeAttribute("data-surface-drop-direction");
      return size / (dropDirection === "down" ? rect.height : rect.width);
    },
    { targetSurfaceId: surfaceId, dropDirection: direction }
  );

  expect(ratio).toBeGreaterThan(0.48);
  expect(ratio).toBeLessThan(0.52);
}

async function expectPanePairSplitEvenly(
  page: Awaited<ReturnType<typeof launchKmux>>["page"],
  firstPaneId: string,
  secondPaneId: string,
  axis: "horizontal" | "vertical"
): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([
    page.locator(`[data-pane-id="${firstPaneId}"]`).boundingBox(),
    page.locator(`[data-pane-id="${secondPaneId}"]`).boundingBox()
  ]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const firstSize = axis === "horizontal" ? firstBox!.width : firstBox!.height;
  const secondSize =
    axis === "horizontal" ? secondBox!.width : secondBox!.height;
  const ratio = firstSize / (firstSize + secondSize);
  expect(ratio).toBeGreaterThan(0.48);
  expect(ratio).toBeLessThan(0.52);
}

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

test("surface tabs drag into pane edges to split existing terminals", async () => {
  const launched = await launchKmux("kmux-e2e-surface-tab-drag-split-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const originalPaneId = initial.activeWorkspace.activePaneId;
    const originalSurfaceId =
      initial.activeWorkspace.panes[originalPaneId].activeSurfaceId;

    await dispatch(page, {
      type: "surface.create",
      paneId: originalPaneId,
      title: "drag-right"
    });
    const withSecondSurface = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[originalPaneId].surfaceIds.length === 2,
      "second surface should be ready for tab drag"
    );
    const rightSurfaceId =
      withSecondSurface.activeWorkspace.panes[originalPaneId].activeSurfaceId;
    expect(rightSurfaceId).not.toBe(originalSurfaceId);
    await expectDropOverlayHalfSize(page, rightSurfaceId, "left");
    await expectDropOverlayHalfSize(page, rightSurfaceId, "right");
    await expectDropOverlayHalfSize(page, rightSurfaceId, "down");

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: rightSurfaceId,
        text: "printf 'kmux-drag-split-kept\\n'\r"
      }
    );
    await waitForSurfaceSnapshotContains(
      page,
      rightSurfaceId,
      "kmux-drag-split-kept",
      6000
    );

    const rightTab = page.locator(
      `[data-pane-id="${originalPaneId}"] [data-surface-id="${rightSurfaceId}"] [role="tab"]`
    );
    const rightTarget = page.getByTestId(`terminal-${rightSurfaceId}`);
    const rightTargetBox = await rightTarget.boundingBox();
    expect(rightTargetBox).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await rightTab.dispatchEvent("dragstart", { dataTransfer });
    await expect(page.getByText(SURFACE_TAB_DROP_PROMPT)).toBeVisible();
    await rightTab.dispatchEvent("dragend", { dataTransfer });
    await expect(page.getByText(SURFACE_TAB_DROP_PROMPT)).toHaveCount(0);
    await rightTab.dragTo(rightTarget, {
      targetPosition: {
        x: Math.max(20, rightTargetBox!.width - 24),
        y: Math.max(24, rightTargetBox!.height * 0.25)
      }
    });

    const afterRightDrop = await waitForView(
      page,
      (view) =>
        Object.keys(view.activeWorkspace.panes).length === 2 &&
        paneIdForSurface(view, rightSurfaceId) !== originalPaneId,
      "dragging a tab to the right edge should move it into a split pane"
    );
    const rightPaneId = paneIdForSurface(afterRightDrop, rightSurfaceId);
    expect(rightPaneId).toBeTruthy();
    expect(
      afterRightDrop.activeWorkspace.panes[originalPaneId].surfaceIds
    ).toEqual([originalSurfaceId]);
    await expectPanePairSplitEvenly(
      page,
      originalPaneId,
      rightPaneId!,
      "horizontal"
    );
    await waitForSurfaceSnapshotContains(
      page,
      rightSurfaceId,
      "kmux-drag-split-kept",
      6000
    );

    await dispatch(page, {
      type: "surface.create",
      paneId: rightPaneId,
      title: "drag-down"
    });
    const withBottomSurface = await waitForView(
      page,
      (view) =>
        rightPaneId !== undefined &&
        view.activeWorkspace.panes[rightPaneId]?.surfaceIds.length === 2,
      "third surface should be ready for bottom tab drag"
    );
    const bottomSurfaceId =
      withBottomSurface.activeWorkspace.panes[rightPaneId!].activeSurfaceId;

    const bottomTab = page.locator(
      `[data-pane-id="${rightPaneId}"] [data-surface-id="${bottomSurfaceId}"] [role="tab"]`
    );
    const bottomTarget = page.getByTestId(`terminal-${bottomSurfaceId}`);
    const bottomTargetBox = await bottomTarget.boundingBox();
    expect(bottomTargetBox).not.toBeNull();
    await bottomTab.dragTo(bottomTarget, {
      targetPosition: {
        x: Math.max(24, bottomTargetBox!.width * 0.5),
        y: Math.max(24, bottomTargetBox!.height - 24)
      }
    });

    const afterBottomDrop = await waitForView(
      page,
      (view) =>
        Object.keys(view.activeWorkspace.panes).length === 3 &&
        paneIdForSurface(view, bottomSurfaceId) !== rightPaneId,
      "dragging a tab to the bottom edge should move it into a split pane"
    );
    const bottomPaneId = paneIdForSurface(afterBottomDrop, bottomSurfaceId);
    expect(bottomPaneId).toBeTruthy();
    expect(bottomPaneId).not.toBe(rightPaneId);
    await expectPanePairSplitEvenly(
      page,
      rightPaneId!,
      bottomPaneId!,
      "vertical"
    );
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
    await expect(page.getByTestId("workspace-close-confirm-dialog")).toHaveCount(
      0
    );

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

test("pane close button closes a tab first when the split pane has multiple tabs", async () => {
  const launched = await launchKmux("kmux-e2e-split-pane-close-tab-first-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const paneId = initial.activeWorkspace.activePaneId;

    await page.locator(`[data-pane-id="${paneId}"]`).getByLabel("Create new tab").click();
    const withTwoTabs = await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "target pane should have two tabs before splitting"
    );
    const activeSurfaceId =
      withTwoTabs.activeWorkspace.panes[paneId].activeSurfaceId;

    await page
      .locator(`[data-pane-id="${paneId}"]`)
      .getByLabel("Split active pane right")
      .click();
    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "workspace should have two panes before pane close"
    );

    await page
      .locator(`[data-pane-id="${paneId}"]`)
      .getByLabel("Close active pane")
      .click();
    await expect(page.getByTestId("workspace-close-confirm-dialog")).toHaveCount(
      0
    );

    const afterClose = await waitForView(
      page,
      (view) =>
        Object.keys(view.activeWorkspace.panes).length === 2 &&
        view.activeWorkspace.panes[paneId]?.surfaceIds.length === 1,
      "pane close button should close one tab before removing a split pane"
    );

    expect(afterClose.activeWorkspace.panes[paneId].surfaceIds).not.toContain(
      activeSurfaceId
    );
  } finally {
    await closeKmux(launched);
  }
});

test("last tab close button asks before closing the workspace", async () => {
  const launched = await launchKmux("kmux-e2e-last-tab-close-confirm-");

  try {
    const page = launched.page;

    await dispatch(page, { type: "workspace.create", name: "alpha" });
    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 2 && view.activeWorkspace.name === "alpha",
      "workspace fixture should be ready before closing the last tab"
    );
    const workspaceId = seeded.activeWorkspace.id;
    const paneId = seeded.activeWorkspace.activePaneId;
    const dialog = page.getByTestId("workspace-close-confirm-dialog");
    const closeTabButton = page
      .locator(`[data-pane-id="${paneId}"] button[title^="Close tab"]`)
      .first();

    await closeTabButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "This workspace only has one tab left. Closing it will close the workspace."
    );

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    const afterCancel = await getView(page);
    expect(
      afterCancel.workspaceRows.some((row) => row.workspaceId === workspaceId)
    ).toBeTruthy();
    expect(afterCancel.activeWorkspace.id).toBe(workspaceId);

    await closeTabButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close Workspace" }).click();

    const afterConfirm = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 1 &&
        view.workspaceRows.every((row) => row.workspaceId !== workspaceId),
      "confirming the last-tab dialog should close the targeted workspace"
    );

    expect(afterConfirm.activeWorkspace.id).not.toBe(workspaceId);
  } finally {
    await closeKmux(launched);
  }
});

test("last pane close button asks before closing the workspace", async () => {
  const launched = await launchKmux("kmux-e2e-last-pane-close-confirm-");

  try {
    const page = launched.page;

    await dispatch(page, { type: "workspace.create", name: "alpha" });
    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 2 && view.activeWorkspace.name === "alpha",
      "workspace fixture should be ready before closing the last pane"
    );
    const workspaceId = seeded.activeWorkspace.id;
    const paneId = seeded.activeWorkspace.activePaneId;
    const dialog = page.getByTestId("workspace-close-confirm-dialog");
    const closePaneButton = page
      .locator(`[data-pane-id="${paneId}"]`)
      .getByLabel("Close active pane");

    await closePaneButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "This workspace only has one tab left. Closing it will close the workspace."
    );

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    const afterCancel = await getView(page);
    expect(
      afterCancel.workspaceRows.some((row) => row.workspaceId === workspaceId)
    ).toBeTruthy();
    expect(afterCancel.activeWorkspace.id).toBe(workspaceId);

    await closePaneButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close Workspace" }).click();

    const afterConfirm = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 1 &&
        view.workspaceRows.every((row) => row.workspaceId !== workspaceId),
      "confirming the last-pane dialog should close the targeted workspace"
    );

    expect(afterConfirm.activeWorkspace.id).not.toBe(workspaceId);
  } finally {
    await closeKmux(launched);
  }
});

test("closing the active tab focuses the previous tab in the same pane", async () => {
  const launched = await launchKmux("kmux-e2e-tab-close-focus-previous-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const paneId = initial.activeWorkspace.activePaneId;
    const firstSurfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;

    await page.getByLabel("Create new tab").click();
    await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "first new tab button click should add a second tab"
    );

    await page.getByLabel("Create new tab").click();
    const withThreeTabs = await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 3,
      "second new tab button click should add a third tab"
    );
    const secondSurfaceId =
      withThreeTabs.activeWorkspace.panes[paneId].surfaceIds[1];

    await page
      .locator(
        `[data-pane-id="${paneId}"] [data-surface-id="${secondSurfaceId}"] [role="tab"]`
      )
      .click();

    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[paneId].activeSurfaceId === secondSurfaceId,
      "middle tab should become active before it is closed"
    );

    await page
      .locator(
        `[data-pane-id="${paneId}"] [data-surface-id="${secondSurfaceId}"] button[title^="Close tab"]`
      )
      .click();

    const afterClose = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[paneId].surfaceIds.length === 2 &&
        view.activeWorkspace.panes[paneId].activeSurfaceId === firstSurfaceId,
      "closing the active middle tab should focus the previous tab"
    );

    expect(afterClose.activeWorkspace.panes[paneId].surfaceIds).not.toContain(
      secondSurfaceId
    );
    await expect(
      page.locator(
        `[data-pane-id="${paneId}"] [data-surface-id="${firstSurfaceId}"] [role="tab"]`
      )
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await closeKmux(launched);
  }
});

test("terminal paste shortcut preserves bracketed paste markers", async () => {
  const launched = await launchKmux("kmux-e2e-bracketed-paste-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;
    const probeScript = `
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdout.write("\\x1b[?2004hKMUX_BRACKET_READY\\r\\n");
      let data = "";
      let finished = false;
      function finish(reason) {
        if (finished) {
          return;
        }
        finished = true;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        const encoded = Buffer.from(data, "utf8").toString("base64");
        process.stdout.write(
          "\\x1b[?2004l\\r\\nKMUX_BRACKET_RESULT:" +
            encoded +
            ":" +
            reason +
            "\\r\\n",
          () => process.exit(reason === "end-marker" ? 0 : 1)
        );
      }
      const timeout = setTimeout(() => finish("timeout"), 4000);
      process.stdin.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\\x1b[201~")) {
          clearTimeout(timeout);
          finish("end-marker");
        }
      });
    `;
    const probeCommand = `${shellQuote(
      process.execPath
    )} -e "eval(Buffer.from('${Buffer.from(
      probeScript,
      "utf8"
    ).toString("base64")}','base64').toString('utf8'))"\r`;

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
        probeCommand
      ]
    );

    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "KMUX_BRACKET_READY",
      6000
    );
    const terminal = page.getByTestId(`terminal-${activeSurfaceId}`);
    await expect(terminal).toHaveAttribute(
      "data-terminal-bracketed-paste-mode",
      "true"
    );
    await page.evaluate(() => {
      window.kmux.writeClipboardText("alpha\nbeta");
    });

    const terminalInput = page.locator("textarea.xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.press("Meta+V");

    const snapshot = await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "KMUX_BRACKET_RESULT:",
      8000
    );
    const match = snapshot.match(
      /KMUX_BRACKET_RESULT:([A-Za-z0-9+/=]+):(end-marker|timeout)/
    );
    expect(match).not.toBeNull();

    const received = Buffer.from(match![1], "base64").toString("utf8");
    expect(match![2]).toBe("end-marker");
    expect(received).toBe("\x1b[200~alpha\rbeta\x1b[201~");
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
