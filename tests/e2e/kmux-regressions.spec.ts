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

test("global workspace create shortcut is ignored when a settings input is focused", async () => {
  const launched = await launchKmux("kmux-e2e-settings-shortcut-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const beforeWorkspaceCount = initial.workspaceRows.length;

    await page.keyboard.press("Meta+,");
    const terminalFontInput = page.getByRole("spinbutton", {
      name: "Font size"
    });
    await expect(terminalFontInput).toBeVisible();
    await terminalFontInput.focus();

    await page.keyboard.press("Meta+N");

    const after = await waitForView(
      page,
      (view) => view.workspaceRows.length === beforeWorkspaceCount,
      "focused settings input should prevent workspace.create shortcut"
    );

    expect(after.workspaceRows.length).toBe(beforeWorkspaceCount);
  } finally {
    await closeKmux(launched);
  }
});

test("settings modal updates shared typography for ui and terminal", async () => {
  const launched = await launchKmux("kmux-e2e-settings-typography-");

  try {
    const page = launched.page;

    await page.getByRole("button", { name: "Open settings" }).click();

    const fontFamilyInput = page.getByLabel("Font family");
    const fontSizeInput = page.getByRole("spinbutton", { name: "Font size" });
    const lineHeightInput = page.getByRole("spinbutton", {
      name: "Line height"
    });

    await expect(fontFamilyInput).toBeVisible();
    await fontFamilyInput.fill('"Fira Code", monospace');
    await fontSizeInput.fill("15");
    await lineHeightInput.fill("1.15");
    await page.getByRole("button", { name: "Save" }).click();

    const updated = await waitForView(
      page,
      (view) =>
        view.settings.terminalFontFamily === '"Fira Code", monospace' &&
        view.settings.terminalFontSize === 15 &&
        view.settings.terminalLineHeight === 1.15,
      "font settings should update after saving settings"
    );

    expect(updated.settings.terminalFontFamily).toBe('"Fira Code", monospace');
    expect(updated.settings.terminalFontSize).toBe(15);
    expect(updated.settings.terminalLineHeight).toBe(1.15);

    await page.waitForFunction(() => {
      const root = document.documentElement;
      return (
        root.style.getPropertyValue("--kmux-font-family") ===
          '"Fira Code", monospace' &&
        root.style.getPropertyValue("--kmux-font-size") === "15px" &&
        root.style.getPropertyValue("--kmux-line-height") === "1.15"
      );
    });

    const typographyVars = await page.evaluate(() => ({
      fontFamily: document.documentElement.style.getPropertyValue(
        "--kmux-font-family"
      ),
      fontSize: document.documentElement.style.getPropertyValue(
        "--kmux-font-size"
      ),
      lineHeight: document.documentElement.style.getPropertyValue(
        "--kmux-line-height"
      )
    }));

    expect(typographyVars.fontFamily).toBe('"Fira Code", monospace');
    expect(typographyVars.fontSize).toBe("15px");
    expect(typographyVars.lineHeight).toBe("1.15");
  } finally {
    await closeKmux(launched);
  }
});

test("terminal fit target stays separate from the padded shell frame", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-fit-geometry-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;

    const geometry = await page.evaluate((surfaceId) => {
      const fitTarget = document.querySelector(
        `[data-testid="terminal-${surfaceId}"]`
      );
      const frame = fitTarget?.parentElement;
      if (!(fitTarget instanceof HTMLElement) || !(frame instanceof HTMLElement)) {
        return null;
      }
      const fitStyle = getComputedStyle(fitTarget);
      const frameStyle = getComputedStyle(frame);
      return {
        fitPaddingTop: fitStyle.paddingTop,
        fitPaddingBottom: fitStyle.paddingBottom,
        framePaddingTop: frameStyle.paddingTop,
        framePaddingBottom: frameStyle.paddingBottom,
        fitHeight: fitTarget.clientHeight,
        frameHeight: frame.clientHeight
      };
    }, activeSurfaceId);

    expect(geometry).toBeTruthy();
    expect(geometry?.fitPaddingTop).toBe("0px");
    expect(geometry?.fitPaddingBottom).toBe("0px");
    expect(geometry?.framePaddingTop).toBe("8px");
    expect(geometry?.framePaddingBottom).toBe("8px");
    expect(geometry?.fitHeight).toBeGreaterThan(0);
    expect(geometry?.frameHeight).toBeGreaterThan(geometry?.fitHeight ?? 0);
  } finally {
    await closeKmux(launched);
  }
});

test("sidebar status/progress/log updates from cli are reflected and cleared in UI state", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-automation-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    await dispatch(page, {
      type: "workspace.create",
      name: "sidebar-automation"
    });

    const workspace = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === initial.workspaceRows.length + 1 &&
        view.activeWorkspace.name === "sidebar-automation",
      "workspace should be created for sidebar automation"
    );
    const workspaceId = workspace.activeWorkspace.id;
    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...workspace.settings,
        socketMode: "allowAll"
      }
    });

    const statusText = "build in progress";
    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "sidebar",
        "set-status",
        "--workspace",
        workspaceId,
        "--text",
        statusText
      ]
    );
    const afterStatus = await waitForView(
      page,
      (view) => view.activeWorkspace.sidebarStatus === statusText,
      "sidebar status should be reflected in renderer state"
    );
    expect(afterStatus.activeWorkspace.sidebarStatus).toBe(statusText);

    const progressValue = 0.45;
    const progressLabel = "Build progress";
    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "sidebar",
        "set-progress",
        "--workspace",
        workspaceId,
        "--value",
        String(progressValue),
        "--label",
        progressLabel
      ]
    );
    const afterProgress = await waitForView(
      page,
      (view) =>
        !!view.activeWorkspace.progress &&
        view.activeWorkspace.progress.value === progressValue &&
        view.activeWorkspace.progress.label === progressLabel,
      "sidebar progress should be reflected in renderer state"
    );
    expect(afterProgress.activeWorkspace.progress?.value).toBe(progressValue);
    expect(afterProgress.activeWorkspace.progress?.label).toBe(progressLabel);

    const logMessage = "Build step complete";
    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "sidebar",
        "log",
        "--workspace",
        workspaceId,
        "--level",
        "info",
        "--message",
        logMessage
      ]
    );
    const afterLog = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.logs.some((entry) => entry.message === logMessage),
      "sidebar log should be reflected in renderer state"
    );
    expect(
      afterLog.activeWorkspace.logs.some(
        (entry) => entry.message === logMessage
      )
    ).toBeTruthy();

    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      ["sidebar", "clear-status", "--workspace", workspaceId]
    );
    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      ["sidebar", "clear-progress", "--workspace", workspaceId]
    );
    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      ["sidebar", "clear-log", "--workspace", workspaceId]
    );

    const cleared = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.sidebarStatus === undefined &&
        view.activeWorkspace.progress === undefined &&
        view.activeWorkspace.logs.length === 0,
      "sidebar status/progress/log should be cleared from renderer state"
    );
    expect(cleared.activeWorkspace.sidebarStatus).toBeUndefined();
    expect(cleared.activeWorkspace.progress).toBeUndefined();
    expect(cleared.activeWorkspace.logs).toHaveLength(0);
  } finally {
    await closeKmux(launched);
  }
});

test("terminal output survives surface switches through attach snapshots", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-snapshot-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const paneId = initial.activeWorkspace.activePaneId;
    const originalSurfaceId =
      initial.activeWorkspace.panes[paneId].activeSurfaceId;

    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...initial.settings,
        socketMode: "allowAll"
      }
    });

    await runCliJson(
      launched.cliPath,
      launched.workspaceRoot,
      launched.sandbox.socketPath,
      [
        "surface",
        "send-text",
        "--surface",
        originalSurfaceId,
        "--text",
        "printf 'kmux-attach-check\\n'\r"
      ]
    );

    let snapshotVt = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = await page.evaluate(
        (surfaceId) => window.kmux.attachSurface(surfaceId),
        originalSurfaceId
      );
      snapshotVt = snapshot?.vt ?? "";
      if (snapshotVt.includes("kmux-attach-check")) {
        break;
      }
      await page.waitForTimeout(200);
    }
    expect(snapshotVt).toContain("kmux-attach-check");

    await dispatch(page, {
      type: "surface.create",
      paneId
    });
    const withSecondSurface = await waitForView(
      page,
      (view) => view.activeWorkspace.panes[paneId].surfaceIds.length === 2,
      "second surface should be created in the same pane"
    );
    expect(
      withSecondSurface.activeWorkspace.panes[paneId].activeSurfaceId
    ).not.toBe(originalSurfaceId);

    await dispatch(page, {
      type: "surface.focus",
      surfaceId: originalSurfaceId
    });
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[paneId].activeSurfaceId ===
        originalSurfaceId,
      "original surface should become active again"
    );

    const restoredSnapshot = await page.evaluate(
      (surfaceId) => window.kmux.attachSurface(surfaceId),
      originalSurfaceId
    );
    expect(restoredSnapshot?.vt).toContain("kmux-attach-check");
  } finally {
    await closeKmux(launched);
  }
});

test("repeated workspace switches preserve terminal snapshots", async () => {
  const launched = await launchKmux("kmux-e2e-workspace-switch-snapshot-");

  try {
    const page = launched.page;
    const initial = await getView(page);

    await dispatch(page, {
      type: "workspace.create",
      name: "alpha"
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "beta"
    });

    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === initial.workspaceRows.length + 2 &&
        view.activeWorkspace.name === "beta",
      "workspace fixtures should be created before switching"
    );

    const fallbackWorkspaceId = seeded.workspaceRows[0]?.workspaceId;
    const targetWorkspaceId = seeded.activeWorkspace.id;
    const targetPaneId = seeded.activeWorkspace.activePaneId;
    const targetSurfaceId =
      seeded.activeWorkspace.panes[targetPaneId].activeSurfaceId;

    expect(fallbackWorkspaceId).toBeTruthy();
    expect(targetSurfaceId).toBeTruthy();

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: targetSurfaceId,
        text: "export PS1='kmux> '\r"
      }
    );

    await waitForSurfaceSnapshotContains(page, targetSurfaceId, "kmux> ");
    const baselineSnapshot = await page.evaluate(
      (surfaceId) => window.kmux.attachSurface(surfaceId),
      targetSurfaceId
    );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await dispatch(page, {
        type: "workspace.select",
        workspaceId: fallbackWorkspaceId!
      });
      await waitForView(
        page,
        (view) => view.activeWorkspace.id === fallbackWorkspaceId,
        "fallback workspace should become active during switch loop"
      );

      await dispatch(page, {
        type: "workspace.select",
        workspaceId: targetWorkspaceId
      });
      await waitForView(
        page,
        (view) => view.activeWorkspace.id === targetWorkspaceId,
        "target workspace should become active during switch loop"
      );
    }

    const restoredSnapshot = await page.evaluate(
      (surfaceId) => window.kmux.attachSurface(surfaceId),
      targetSurfaceId
    );

    expect(restoredSnapshot?.vt).toBe(baselineSnapshot?.vt);
  } finally {
    await closeKmux(launched);
  }
});
