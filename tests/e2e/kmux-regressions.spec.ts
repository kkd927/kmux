import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import {
  createDefaultSettings,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY
} from "@kmux/core";

import {
  closeKmuxApp,
  closeKmux,
  createSandbox,
  dispatch,
  destroySandbox,
  getSurfaceSnapshot,
  getView,
  launchKmux,
  launchKmuxWithSandbox,
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

test("settings modal updates terminal typography preferences and preview", async () => {
  const launched = await launchKmux("kmux-e2e-settings-typography-");

  try {
    const page = launched.page;

    await page.getByRole("button", { name: "Open settings" }).click();

    const fontFamilyInput = page.getByLabel("Text font");
    const fontSizeInput = page.getByRole("spinbutton", { name: "Font size" });
    const lineHeightInput = page.getByRole("spinbutton", {
      name: "Line height"
    });
    const preview = page.getByTestId("terminal-typography-preview");

    await expect(fontFamilyInput).toBeVisible();
    await expect(preview).toBeVisible();
    await expect(page.getByLabel("Symbol fallback fonts")).toHaveCount(0);
    await fontFamilyInput.fill('"Fira Code", monospace');
    await fontSizeInput.fill("15");
    await lineHeightInput.fill("1.15");

    await expect(preview).toContainText("Glyph support ready");
    await expect(preview).toContainText("Using built-in kmux glyph font.");

    await page.getByRole("button", { name: "Save" }).click();

    const updated = await waitForView(
      page,
      (view) =>
        view.settings.terminalTypography.preferredTextFontFamily ===
          '"Fira Code", monospace' &&
        view.settings.terminalTypography.fontSize === 15 &&
        view.settings.terminalTypography.lineHeight === 1.15,
      "font settings should update after saving settings"
    );

    expect(updated.settings.terminalTypography.preferredTextFontFamily).toBe(
      '"Fira Code", monospace'
    );
    expect(updated.settings.terminalTypography.fontSize).toBe(15);
    expect(updated.settings.terminalTypography.lineHeight).toBe(1.15);
    expect(updated.terminalTypography.resolvedFontFamily).toContain(
      '"Fira Code", monospace'
    );
    expect(updated.terminalTypography.resolvedFontFamily).toContain(
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    );

    await page.waitForFunction(() => {
      const root = document.documentElement;
      return (
        root.style
          .getPropertyValue("--kmux-terminal-font-family")
          .includes('"Fira Code", monospace') &&
        root.style
          .getPropertyValue("--kmux-terminal-font-family")
          .includes("kmux Symbols Nerd Font Mono") &&
        root.style.getPropertyValue("--kmux-terminal-font-size") === "15px" &&
        root.style.getPropertyValue("--kmux-terminal-line-height") === "1.15"
      );
    });

    const typographyVars = await page.evaluate(() => ({
      fontFamily: document.documentElement.style.getPropertyValue(
        "--kmux-terminal-font-family"
      ),
      fontSize: document.documentElement.style.getPropertyValue(
        "--kmux-terminal-font-size"
      ),
      lineHeight: document.documentElement.style.getPropertyValue(
        "--kmux-terminal-line-height"
      )
    }));

    expect(typographyVars.fontFamily).toContain('"Fira Code", monospace');
    expect(typographyVars.fontFamily).toContain("kmux Symbols Nerd Font Mono");
    expect(typographyVars.fontSize).toBe("15px");
    expect(typographyVars.lineHeight).toBe("1.15");
  } finally {
    await closeKmux(launched);
  }
});

test("settings modal toggles the terminal WebGL renderer for comparison", async () => {
  const launched = await launchKmux("kmux-e2e-settings-terminal-renderer-", {
    env: {
      KMUX_E2E_WINDOW_MODE: "visible"
    }
  });

  try {
    const page = launched.page;

    await page.waitForFunction(() => {
      const xterm = document.querySelector(".xterm");
      return Boolean(xterm && xterm.querySelectorAll("canvas").length > 0);
    });

    await page.getByRole("button", { name: "Open settings" }).click();
    const rendererToggle = page.getByLabel("Use WebGL terminal renderer");
    await expect(rendererToggle).toBeVisible();
    await expect(rendererToggle).toBeChecked();

    await rendererToggle.uncheck();
    await page.getByRole("button", { name: "Save" }).click();

    const disabled = await waitForView(
      page,
      (view) => view.settings.terminalUseWebgl === false,
      "terminal WebGL renderer should disable after saving settings"
    );
    expect(disabled.settings.terminalUseWebgl).toBe(false);

    await page.waitForFunction(() => {
      const xterm = document.querySelector(".xterm");
      return Boolean(
        xterm &&
        xterm.querySelectorAll("canvas").length === 0 &&
        xterm.querySelectorAll(".xterm-rows > div").length > 0
      );
    });

    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(
      page.getByLabel("Use WebGL terminal renderer")
    ).not.toBeChecked();
    await page.getByLabel("Use WebGL terminal renderer").check();
    await page.getByRole("button", { name: "Save" }).click();

    const enabled = await waitForView(
      page,
      (view) => view.settings.terminalUseWebgl === true,
      "terminal WebGL renderer should re-enable after saving settings"
    );
    expect(enabled.settings.terminalUseWebgl).toBe(true);

    await page.waitForFunction(() => {
      const xterm = document.querySelector(".xterm");
      return Boolean(xterm && xterm.querySelectorAll("canvas").length > 0);
    });
  } finally {
    await closeKmux(launched);
  }
});

test("settings preview stays ready with the built-in glyph font when no compatible font is installed", async () => {
  const launched = await launchKmux("kmux-e2e-settings-typography-degraded-", {
    env: {
      KMUX_TEST_FONT_FAMILIES: JSON.stringify(["JetBrains Mono", "Menlo"])
    }
  });

  try {
    const page = launched.page;
    await page.getByRole("button", { name: "Open settings" }).click();

    const preview = page.getByTestId("terminal-typography-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Glyph support ready");
    await expect(preview).toContainText("Using built-in kmux glyph font.");
    await expect(preview).not.toContainText(
      "Compatible installed font detected:"
    );
  } finally {
    await closeKmux(launched);
  }
});

test("settings preview reports a detected installed compatible font", async () => {
  const launched = await launchKmux("kmux-e2e-settings-typography-installed-", {
    env: {
      KMUX_TEST_FONT_FAMILIES: JSON.stringify([
        "JetBrains Mono",
        "JetBrainsMono Nerd Font Mono"
      ])
    }
  });

  try {
    const page = launched.page;
    await page.getByRole("button", { name: "Open settings" }).click();

    const preview = page.getByTestId("terminal-typography-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Glyph support ready");
    await expect(preview).toContainText("Using built-in kmux glyph font.");
    await expect(preview).toContainText(
      "Compatible installed font detected: JetBrainsMono Nerd Font Mono"
    );
  } finally {
    await closeKmux(launched);
  }
});

test("legacy preferred symbol fallback settings still load without breaking typography", async () => {
  const sandbox = createSandbox("kmux-e2e-settings-typography-legacy-");
  const settingsPath = join(sandbox.configDir, "settings.json");
  const legacySettings = createDefaultSettings();
  legacySettings.terminalTypography.preferredSymbolFallbackFamilies = [
    "Legacy Nerd Font Mono"
  ];
  writeFileSync(settingsPath, JSON.stringify(legacySettings, null, 2));

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_TEST_FONT_FAMILIES: JSON.stringify(["JetBrains Mono", "Menlo"])
    }
  });

  try {
    const page = launched.page;
    const view = await getView(page);

    expect(
      view.settings.terminalTypography.preferredSymbolFallbackFamilies
    ).toEqual(["Legacy Nerd Font Mono"]);
    expect(view.terminalTypography.symbolFallbackFamilies).toEqual([
      "Legacy Nerd Font Mono",
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    ]);

    await page.getByRole("button", { name: "Open settings" }).click();
    const preview = page.getByTestId("terminal-typography-preview");
    await expect(preview).toContainText("Glyph support ready");
    await expect(preview).toContainText("Using built-in kmux glyph font.");
  } finally {
    await closeKmux(launched);
  }
});

test("settings modal switches between light and system themes and keeps terminal colors in sync", async () => {
  const launched = await launchKmux("kmux-e2e-settings-theme-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;
    const terminal = page.getByTestId(`terminal-${activeSurfaceId}`);

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
        "printf 'kmux-theme-keepalive\\n'; for i in $(seq 1 160); do echo kmux-theme-$i; done\r"
      ]
    );
    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "kmux-theme-keepalive",
      6000
    );
    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-base-y")) ?? "0")
      )
      .toBeGreaterThan(0);

    await page.emulateMedia({ colorScheme: "light" });

    await page.getByRole("button", { name: "Open settings" }).click();
    const themeModeSelect = page.getByLabel("Theme mode");
    await expect(themeModeSelect).toBeVisible();
    await themeModeSelect.selectOption("light");
    await page.getByRole("button", { name: "Save" }).click();

    const lightUpdated = await waitForView(
      page,
      (view) => view.settings.themeMode === "light",
      "theme mode should persist the light appearance selection"
    );

    expect(lightUpdated.settings.themeMode).toBe("light");

    await page.waitForFunction(() => {
      const root = document.documentElement;
      return (
        root.dataset.colorTheme === "light" &&
        root.dataset.themeMode === "light" &&
        root.style.colorScheme === "light"
      );
    });

    const lightAppearance = await page.evaluate(() => {
      const root = document.documentElement;
      const viewport = document.querySelector(".xterm-viewport");
      return {
        windowBg: root.style.getPropertyValue("--window-bg").trim(),
        sidebarBg: root.style.getPropertyValue("--sidebar-bg").trim(),
        viewportBg:
          viewport instanceof HTMLElement
            ? getComputedStyle(viewport).backgroundColor
            : null
      };
    });

    expect(lightAppearance.windowBg).toBe("#f7f7f5");
    expect(lightAppearance.sidebarBg).toBe("#e8f1f6");
    expect(lightAppearance.viewportBg).toBe("rgb(255, 255, 255)");
    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-base-y")) ?? "0")
      )
      .toBeGreaterThan(0);

    await page.getByRole("button", { name: "Open settings" }).click();
    await themeModeSelect.selectOption("system");
    await page.getByRole("button", { name: "Save" }).click();

    const systemUpdated = await waitForView(
      page,
      (view) => view.settings.themeMode === "system",
      "theme mode should persist the system appearance selection"
    );

    expect(systemUpdated.settings.themeMode).toBe("system");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => {
      const root = document.documentElement;
      return (
        root.dataset.colorTheme === "dark" &&
        root.dataset.themeMode === "system" &&
        root.style.colorScheme === "dark"
      );
    });

    const systemAppearance = await page.evaluate(() => {
      const root = document.documentElement;
      const viewport = document.querySelector(".xterm-viewport");
      return {
        windowBg: root.style.getPropertyValue("--window-bg").trim(),
        viewportBg:
          viewport instanceof HTMLElement
            ? getComputedStyle(viewport).backgroundColor
            : null
      };
    });

    expect(systemAppearance.windowBg).toBe("#181818");
    expect(systemAppearance.viewportBg).toBe("rgb(31, 31, 31)");
    await expect
      .poll(async () =>
        Number((await terminal.getAttribute("data-terminal-base-y")) ?? "0")
      )
      .toBeGreaterThan(0);
  } finally {
    await closeKmux(launched);
  }
});

test("settings modal exposes built-in terminal presets and keeps them undeletable", async () => {
  const launched = await launchKmux("kmux-e2e-settings-terminal-presets-");

  try {
    const page = launched.page;
    await page.getByRole("button", { name: "Open settings" }).click();

    const themeSelect = page.getByLabel("Active terminal theme");
    const deleteButton = page.getByRole("button", {
      name: "Delete terminal theme"
    });
    const preview = page.getByTestId("terminal-theme-preview");

    await expect(themeSelect).toBeVisible();
    const optionLabels = await themeSelect.evaluate((element) =>
      Array.from((element as HTMLSelectElement).options).map(
        (option) => option.label
      )
    );
    expect(optionLabels).toEqual(["kmux Default", "IntelliJ Islands"]);
    await expect(deleteButton).toBeDisabled();
    await expect(preview).toBeVisible();

    const kmuxDefaultPreviewColor = await preview.evaluate(
      (element) => getComputedStyle(element).color
    );
    expect(kmuxDefaultPreviewColor).toBe("rgb(227, 232, 239)");

    await themeSelect.selectOption({ label: "IntelliJ Islands" });
    await expect(deleteButton).toBeDisabled();
    await expect(preview).toContainText("IntelliJ Islands");
    await expect
      .poll(() =>
        preview.evaluate((element) => getComputedStyle(element).color)
      )
      .toBe("rgb(204, 204, 204)");

    await page.getByRole("button", { name: "Save" }).click();

    const updated = await waitForView(
      page,
      (view) =>
        view.settings.terminalThemes.activeProfileId ===
        "terminal_theme_intellij_islands",
      "built-in IntelliJ Islands preset should save as the active profile"
    );

    expect(updated.settings.terminalThemes.profiles).toHaveLength(2);
  } finally {
    await closeKmux(launched);
  }
});

test("settings modal keeps save and cancel visible in short windows", async () => {
  const launched = await launchKmux("kmux-e2e-settings-short-window-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 920, height: 560 });

    await page.getByRole("button", { name: "Open settings" }).click();

    const dialog = page.getByTestId("settings-dialog");
    const body = page.getByTestId("settings-body");
    const saveButton = page.getByRole("button", { name: "Save" });
    const cancelButton = page.getByRole("button", { name: "Cancel" });

    await expect(dialog).toBeVisible();
    await expect(body).toBeVisible();
    await expect(saveButton).toBeVisible();
    await expect(cancelButton).toBeVisible();

    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>(
        '[data-testid="settings-dialog"]'
      );
      const body = document.querySelector<HTMLElement>(
        '[data-testid="settings-body"]'
      );
      const buttons = Array.from(document.querySelectorAll("button"));
      const saveButton = buttons.find(
        (button) => button.textContent?.trim() === "Save"
      );
      const cancelButton = buttons.find(
        (button) => button.textContent?.trim() === "Cancel"
      );
      if (
        !dialog ||
        !body ||
        !(saveButton instanceof HTMLElement) ||
        !(cancelButton instanceof HTMLElement)
      ) {
        return null;
      }

      const dialogRect = dialog.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const saveRect = saveButton.getBoundingClientRect();
      const cancelRect = cancelButton.getBoundingClientRect();

      return {
        viewportHeight: window.innerHeight,
        dialogBottom: dialogRect.bottom,
        bodyTop: bodyRect.top,
        bodyBottom: bodyRect.bottom,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        saveBottom: saveRect.bottom,
        cancelBottom: cancelRect.bottom
      };
    });

    expect(geometry).toBeTruthy();
    expect(geometry?.bodyScrollHeight).toBeGreaterThan(
      geometry?.bodyClientHeight ?? 0
    );
    expect(geometry?.saveBottom).toBeLessThanOrEqual(
      geometry?.viewportHeight ?? 0
    );
    expect(geometry?.cancelBottom).toBeLessThanOrEqual(
      geometry?.viewportHeight ?? 0
    );
    expect(geometry?.bodyBottom).toBeLessThan(
      geometry?.saveBottom ?? Number.POSITIVE_INFINITY
    );
    expect(geometry?.dialogBottom).toBeLessThanOrEqual(
      geometry?.viewportHeight ?? 0
    );

    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(saveButton).toBeVisible();

    await page.getByLabel("Theme mode").selectOption("light");
    await saveButton.click();

    const updated = await waitForView(
      page,
      (view) => view.settings.themeMode === "light",
      "save button should remain clickable in a short settings window"
    );

    expect(updated.settings.themeMode).toBe("light");
  } finally {
    await closeKmux(launched);
  }
});

test("pty title updates are reflected immediately without switching workspaces", async () => {
  const launched = await launchKmux("kmux-e2e-pty-title-updates-");

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
        "printf '\\033]0;osc-title-1\\007'; sleep 2\r"
      ]
    );

    const updated = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.surfaces[activeSurfaceId]?.title === "osc-title-1",
      "pty title updates should reach the renderer without a workspace switch"
    );

    expect(updated.activeWorkspace.surfaces[activeSurfaceId]?.title).toBe(
      "osc-title-1"
    );
    await expect(
      page.locator(`[data-surface-id="${activeSurfaceId}"]`)
    ).toContainText("osc-title-1");
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
      if (
        !(fitTarget instanceof HTMLElement) ||
        !(frame instanceof HTMLElement)
      ) {
        return null;
      }
      const fitStyle = getComputedStyle(fitTarget);
      const frameStyle = getComputedStyle(frame);
      return {
        fitPaddingTop: fitStyle.paddingTop,
        fitPaddingBottom: fitStyle.paddingBottom,
        fitPaddingLeft: fitStyle.paddingLeft,
        fitPaddingRight: fitStyle.paddingRight,
        framePaddingTop: frameStyle.paddingTop,
        framePaddingBottom: frameStyle.paddingBottom,
        framePaddingLeft: frameStyle.paddingLeft,
        framePaddingRight: frameStyle.paddingRight,
        fitHeight: fitTarget.clientHeight,
        frameHeight: frame.clientHeight
      };
    }, activeSurfaceId);

    expect(geometry).toBeTruthy();
    expect(geometry?.fitPaddingTop).toBe("0px");
    expect(geometry?.fitPaddingBottom).toBe("0px");
    expect(geometry?.fitPaddingLeft).toBe("0px");
    expect(geometry?.fitPaddingRight).toBe("0px");
    expect(geometry?.framePaddingTop).toBe("8px");
    expect(geometry?.framePaddingBottom).toBe("8px");
    expect(geometry?.framePaddingLeft).toBe("10px");
    expect(geometry?.framePaddingRight).toBe("0px");
    expect(geometry?.fitHeight).toBeGreaterThan(0);
    expect(geometry?.frameHeight).toBeGreaterThan(geometry?.fitHeight ?? 0);
  } finally {
    await closeKmux(launched);
  }
});

test("narrow windows clamp the rendered sidebar width without mutating the saved sidebar size", async () => {
  const launched = await launchKmux("kmux-e2e-sidebar-width-clamp-");

  try {
    const page = launched.page;
    await page.setViewportSize({ width: 1280, height: 820 });

    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;

    expect(initial.sidebarWidth).toBe(320);

    await page.setViewportSize({ width: 780, height: 820 });
    await page.waitForFunction((surfaceId) => {
      const sidebar = document.querySelector(
        '[data-testid="workspace-tool-window"]'
      );
      const fitTarget = document.querySelector(
        `[data-testid="terminal-${surfaceId}"]`
      );
      const frame = fitTarget?.parentElement;

      return (
        sidebar instanceof HTMLElement &&
        frame instanceof HTMLElement &&
        sidebar.clientWidth === 272 &&
        frame.clientWidth >= 500
      );
    }, activeSurfaceId);

    const geometry = await page.evaluate((surfaceId) => {
      const sidebar = document.querySelector(
        '[data-testid="workspace-tool-window"]'
      );
      const fitTarget = document.querySelector(
        `[data-testid="terminal-${surfaceId}"]`
      );
      const frame = fitTarget?.parentElement;

      if (
        !(sidebar instanceof HTMLElement) ||
        !(frame instanceof HTMLElement)
      ) {
        return null;
      }

      return {
        sidebarWidth: sidebar.clientWidth,
        terminalFrameWidth: frame.clientWidth
      };
    }, activeSurfaceId);

    expect(geometry).toBeTruthy();
    expect(geometry?.sidebarWidth).toBe(272);
    expect(geometry?.terminalFrameWidth).toBeGreaterThanOrEqual(500);

    const resized = await getView(page);
    expect(resized.sidebarWidth).toBe(320);
  } finally {
    await closeKmux(launched);
  }
});

test("terminal viewport background matches the pane background without a black bottom strip", async () => {
  const launched = await launchKmux("kmux-e2e-terminal-viewport-background-");

  try {
    const page = launched.page;
    const initial = await getView(page);
    const activePaneId = initial.activeWorkspace.activePaneId;
    const activeSurfaceId =
      initial.activeWorkspace.panes[activePaneId].activeSurfaceId;

    const colors = await page.evaluate((surfaceId) => {
      const fitTarget = document.querySelector(
        `[data-testid="terminal-${surfaceId}"]`
      );
      const frame = fitTarget?.parentElement;
      const viewport = fitTarget?.querySelector(".xterm-viewport");
      if (
        !(fitTarget instanceof HTMLElement) ||
        !(frame instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement)
      ) {
        return null;
      }
      return {
        frameBackground: getComputedStyle(frame).backgroundColor,
        viewportBackground: getComputedStyle(viewport).backgroundColor
      };
    }, activeSurfaceId);

    expect(colors).toBeTruthy();
    expect(colors?.viewportBackground).toBe(colors?.frameBackground);
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

test("sidebar width respects the minimum and persists across relaunch", async () => {
  const sandbox = createSandbox("kmux-e2e-sidebar-resize-");
  let launched = await launchKmuxWithSandbox(sandbox);

  try {
    let page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    const resizer = page.getByTestId("sidebar-resizer");
    const sidebar = page.getByTestId("workspace-tool-window");

    await resizer.focus();
    await resizer.press("Home");
    await waitForView(
      page,
      (view) => view.sidebarWidth === 110,
      "sidebar resize handle should clamp to the minimum width"
    );

    await dispatch(page, {
      type: "workspace.sidebar.setWidth",
      width: 320
    });
    await waitForView(
      page,
      (view) => view.sidebarWidth === 320,
      "sidebar width should return to the maximum width"
    );

    await dispatch(page, {
      type: "workspace.sidebar.setWidth",
      width: 272
    });

    const resized = await waitForView(
      page,
      (view) => view.sidebarWidth < 320 && view.sidebarWidth >= 110,
      "sidebar width updates should persist a narrower width"
    );
    const persistedWidth = resized.sidebarWidth;
    expect(persistedWidth).toBeGreaterThanOrEqual(110);
    expect(persistedWidth).toBeLessThan(320);

    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(persistedWidth);

    await closeKmuxApp(launched);
    launched = await launchKmuxWithSandbox(sandbox);
    page = launched.page;
    await page.setViewportSize({ width: 1277, height: 1179 });

    const restored = await waitForView(
      page,
      (view) => view.sidebarWidth === persistedWidth,
      "sidebar width should restore from persisted window state"
    );
    expect(restored.sidebarWidth).toBe(persistedWidth);
    await expect
      .poll(async () =>
        Math.round(
          (await page.getByTestId("workspace-tool-window").boundingBox())
            ?.width ?? 0
        )
      )
      .toBe(persistedWidth);
  } finally {
    if (launched) {
      await closeKmux(launched);
    } else {
      destroySandbox(sandbox);
    }
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
      const snapshot = await getSurfaceSnapshot(page, originalSurfaceId);
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

    const restoredSnapshot = await getSurfaceSnapshot(page, originalSurfaceId);
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
    const baselineSnapshot = await getSurfaceSnapshot(page, targetSurfaceId, {
      settleForMs: 300,
      timeoutMs: 5000
    });

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

    const restoredSnapshot = await getSurfaceSnapshot(page, targetSurfaceId, {
      settleForMs: 300,
      timeoutMs: 5000
    });

    expect(restoredSnapshot?.vt).toBe(baselineSnapshot?.vt);
  } finally {
    await closeKmux(launched);
  }
});

test("closing the active workspace by shortcut keeps the app responsive and selects a remaining workspace", async () => {
  const launched = await launchKmux("kmux-e2e-workspace-close-active-");

  try {
    const page = launched.page;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await dispatch(page, { type: "workspace.create", name: "alpha" });
    await dispatch(page, { type: "workspace.create", name: "beta" });
    await dispatch(page, { type: "workspace.create", name: "gamma" });

    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length >= 4 && view.activeWorkspace.name === "gamma",
      "workspace fixtures should be ready before closing the active workspace"
    );
    const betaId = seeded.workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const gammaId = seeded.workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();

    await dispatch(page, { type: "workspace.select", workspaceId: betaId! });
    await waitForView(
      page,
      (view) => view.activeWorkspace.id === betaId,
      "beta workspace should become active before closing it"
    );

    await page.keyboard.press("Meta+Shift+W");

    const afterClose = await waitForView(
      page,
      (view) =>
        view.activeWorkspace.id === gammaId &&
        view.workspaceRows.every((row) => row.workspaceId !== betaId),
      "closing the active workspace should promote a remaining workspace"
    );

    expect(afterClose.activeWorkspace.id).toBe(gammaId);
    expect(
      afterClose.workspaceRows.every((row) => row.workspaceId !== betaId)
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await closeKmux(launched);
  }
});

test("closing the app's last workspace replaces it with a fresh workspace without runtime errors", async () => {
  const launched = await launchKmux("kmux-e2e-last-workspace-replace-");

  try {
    const page = launched.page;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    const initial = await getView(page);
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const dialog = page.getByTestId("workspace-close-confirm-dialog");

    await page
      .locator(`[data-pane-id="${paneId}"] button[title^="Close tab"]`)
      .first()
      .click();

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "This workspace only has one tab left. Closing it will replace it with a new workspace."
    );
    await dialog.getByRole("button", { name: "Close Workspace" }).click();

    const replaced = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 1 &&
        view.activeWorkspace.id !== workspaceId,
      "confirming the last workspace close should replace it with a fresh workspace"
    );

    expect(replaced.workspaceRows).toHaveLength(1);
    expect(replaced.activeWorkspace.id).not.toBe(workspaceId);
    expect(replaced.activeWorkspace.name).not.toBe("");
    expect(Object.keys(replaced.activeWorkspace.panes)).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await closeKmux(launched);
  }
});
