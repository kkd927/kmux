import {
  BUILTIN_TERMINAL_THEME_PROFILE_ID,
  BUILTIN_TERMINAL_THEME_PROFILES,
  INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE_ID
} from "@kmux/ui";

import {
  applyAction,
  buildViewModel,
  cloneState,
  createInitialState,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY,
  listPaneIds,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH
} from "./index";

describe("core reducer", () => {
  it("creates and selects a new workspace", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "new" });
    const vm = buildViewModel(state);

    expect(vm.workspaceRows).toHaveLength(2);
    expect(vm.activeWorkspace.name).toBe("new");
  });

  it("inherits a concrete cwd when creating a workspace without an explicit folder", () => {
    const state = createInitialState();
    const originalWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const originalPaneId = state.workspaces[originalWorkspaceId].activePaneId;
    const originalSurfaceId = state.panes[originalPaneId].activeSurfaceId;
    const inheritedCwd = state.surfaces[originalSurfaceId].cwd;

    applyAction(state, { type: "workspace.create", name: "new" });

    const createdWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const createdPaneId = state.workspaces[createdWorkspaceId].activePaneId;
    const createdSurfaceId = state.panes[createdPaneId].activeSurfaceId;

    expect(state.workspaces[createdWorkspaceId].cwdSummary).toBe(inheritedCwd);
    expect(state.surfaces[createdSurfaceId].cwd).toBe(inheritedCwd);
    expect(
      state.sessions[state.surfaces[createdSurfaceId].sessionId].launch.cwd
    ).toBe(inheritedCwd);
  });

  it("uses the configured shell path as the default session shell", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];

    expect(state.sessions[sessionId]?.launch.shell).toBe("/bin/zsh");
    expect(state.sessions[sessionId]?.launch.args).toBeUndefined();
  });

  it("splits panes without recreating the original pane", () => {
    const state = createInitialState();
    const originalPaneId = buildViewModel(state).activeWorkspace.activePaneId;
    applyAction(state, {
      type: "pane.split",
      paneId: originalPaneId,
      direction: "right"
    });

    const paneIds = listPaneIds(
      state.workspaces[state.windows[state.activeWindowId].activeWorkspaceId]
    );
    expect(paneIds).toContain(originalPaneId);
    expect(paneIds).toHaveLength(2);
  });

  it("drops deprecated pane zoom state from restored snapshots", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const originalPaneId = state.workspaces[workspaceId].activePaneId;
    (
      state.workspaces[workspaceId] as (typeof state.workspaces)[string] & {
        zoomedPaneId?: string;
      }
    ).zoomedPaneId = "pane_missing";
    state.settings.shortcuts["pane.zoom"] = "Meta+Enter";

    const restored = cloneState(state);
    const vm = buildViewModel(restored);

    expect(
      "zoomedPaneId" in
        ((restored.workspaces[workspaceId] as unknown as Record<
          string,
          unknown
        >) ?? {})
    ).toBe(false);
    expect(restored.settings.shortcuts["pane.zoom"]).toBeUndefined();
    expect(Object.keys(vm.activeWorkspace.panes)).toEqual([originalPaneId]);
  });

  it("tracks notifications and clears unread when focused", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Need attention",
      message: "hello"
    });
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);

    applyAction(state, { type: "surface.focus", surfaceId });
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
  });

  it("turns terminal bells into a sound effect without creating notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];

    state.settings.notificationSound = true;

    expect(applyAction(state, { type: "terminal.bell" })).toEqual([
      { type: "bell.sound" }
    ]);
    expect(state.notifications).toEqual([]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
    expect(state.surfaces[surfaceId].attention).toBe(false);
  });

  it("keeps terminal bells silent when bell sounds are disabled", () => {
    const state = createInitialState();

    state.settings.notificationSound = false;

    expect(applyAction(state, { type: "terminal.bell" })).toEqual([]);
    expect(state.notifications).toEqual([]);
  });

  it("clears all notifications from the center", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Need attention",
      message: "hello"
    });
    expect(state.notifications).toHaveLength(1);

    applyAction(state, { type: "notification.clear" });

    expect(state.notifications).toHaveLength(0);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
    expect(state.surfaces[surfaceId].attention).toBe(false);
  });

  it("keeps remaining unread counts in sync when clearing one notification", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "First",
      message: "one"
    });
    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Second",
      message: "two"
    });

    const notificationId = state.notifications[0]?.id;
    expect(notificationId).toBeTruthy();
    expect(state.surfaces[surfaceId].unreadCount).toBe(2);

    applyAction(state, { type: "notification.clear", notificationId });

    expect(state.notifications).toHaveLength(1);
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
    expect(state.surfaces[surfaceId].attention).toBe(true);
  });

  it("merges shortcut patches without dropping existing bindings", () => {
    const state = createInitialState();
    const originalShortcut = state.settings.shortcuts["terminal.copy"];

    applyAction(state, {
      type: "settings.update",
      patch: {
        shortcuts: {
          "pane.close": "Meta+Shift+X"
        }
      }
    });

    expect(state.settings.shortcuts["pane.close"]).toBe("Meta+Shift+X");
    expect(state.settings.shortcuts["terminal.copy"]).toBe(originalShortcut);
  });

  it("sanitizes shared typography settings updates", () => {
    const state = createInitialState();

    applyAction(state, {
      type: "settings.update",
      patch: {
        terminalTypography: {
          preferredTextFontFamily: "   ",
          fontSize: Number.NaN,
          lineHeight: Number.POSITIVE_INFINITY
        }
      }
    });

    expect(state.settings.terminalTypography.preferredTextFontFamily).toContain(
      "JetBrains Mono"
    );
    expect(state.settings.terminalTypography.fontSize).toBe(13);
    expect(state.settings.terminalTypography.lineHeight).toBe(1);
  });

  it("defaults the terminal renderer preference to WebGL and sanitizes invalid updates", () => {
    const state = createInitialState();

    expect(state.settings.terminalUseWebgl).toBe(true);

    applyAction(state, {
      type: "settings.update",
      patch: {
        terminalUseWebgl: false
      }
    });
    expect(state.settings.terminalUseWebgl).toBe(false);

    applyAction(state, {
      type: "settings.update",
      patch: {
        terminalUseWebgl: undefined
      }
    });
    expect(state.settings.terminalUseWebgl).toBe(false);
  });

  it("merges terminal typography patches without dropping existing preferences", () => {
    const state = createInitialState();
    const originalTextFontFamily =
      state.settings.terminalTypography.preferredTextFontFamily;

    applyAction(state, {
      type: "settings.update",
      patch: {
        terminalTypography: {
          preferredSymbolFallbackFamilies: ["Symbols Nerd Font Mono"]
        }
      }
    });

    expect(state.settings.terminalTypography.preferredTextFontFamily).toBe(
      originalTextFontFamily
    );
    expect(
      state.settings.terminalTypography.preferredSymbolFallbackFamilies
    ).toEqual(["Symbols Nerd Font Mono"]);
  });

  it("includes the built-in glyph font in pending terminal typography", () => {
    const state = createInitialState();
    const view = buildViewModel(state);

    expect(view.terminalTypography.symbolFallbackFamilies).toContain(
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    );
    expect(view.terminalTypography.resolvedFontFamily).toContain(
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    );
  });

  it("migrates legacy terminal font settings into terminal typography", () => {
    const state = createInitialState();
    const legacyState = structuredClone(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    delete (legacyState.settings as { terminalTypography?: unknown })
      .terminalTypography;
    legacyState.settings.terminalFontFamily = '"Fira Code", monospace';
    legacyState.settings.terminalFontSize = 15;
    legacyState.settings.terminalLineHeight = 1.15;

    const restored = cloneState(legacyState as typeof state);

    expect(restored.settings.terminalTypography.preferredTextFontFamily).toBe(
      '"Fira Code", monospace'
    );
    expect(restored.settings.terminalTypography.fontSize).toBe(15);
    expect(restored.settings.terminalTypography.lineHeight).toBe(1.15);
    expect(
      "terminalFontFamily" in
        (restored.settings as unknown as Record<string, unknown>)
    ).toBe(false);
  });

  it("migrates missing terminal renderer settings to the WebGL default", () => {
    const state = createInitialState();
    const legacyState = structuredClone(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    delete (legacyState.settings as { terminalUseWebgl?: boolean })
      .terminalUseWebgl;

    const restored = cloneState(legacyState as typeof state);

    expect(restored.settings.terminalUseWebgl).toBe(true);
  });

  it("normalizes legacy empty shell args during restore", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];
    state.sessions[sessionId].launch.args = [];

    const restored = cloneState(state);

    expect(restored.sessions[sessionId].launch.args).toBeUndefined();
    expect(restored.sessions[sessionId].launch.shell).toBe("/bin/zsh");
  });

  it("sanitizes theme mode settings updates", () => {
    const state = createInitialState();

    applyAction(state, {
      type: "settings.update",
      patch: {
        themeMode: "system"
      }
    });

    expect(state.settings.themeMode).toBe("system");

    applyAction(state, {
      type: "settings.update",
      patch: {
        themeMode: "light"
      }
    });

    expect(state.settings.themeMode).toBe("light");
  });

  it("creates the built-in terminal theme profile by default", () => {
    const state = createInitialState();

    expect(state.settings.terminalThemes.activeProfileId).toBe(
      BUILTIN_TERMINAL_THEME_PROFILE_ID
    );
    expect(state.settings.terminalThemes.profiles).toHaveLength(
      BUILTIN_TERMINAL_THEME_PROFILES.length
    );
    expect(state.settings.terminalThemes.profiles[0]?.id).toBe(
      BUILTIN_TERMINAL_THEME_PROFILE_ID
    );
    expect(state.settings.terminalThemes.profiles[1]?.id).toBe(
      INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE_ID
    );
    expect(
      state.settings.terminalThemes.profiles[0]?.variants.dark.ansi
    ).toHaveLength(16);
  });

  it("sanitizes terminal theme settings updates and preserves the built-in profile", () => {
    const state = createInitialState();
    const builtinTheme = state.settings.terminalThemes.profiles[0];

    applyAction(state, {
      type: "settings.update",
      patch: {
        terminalThemes: {
          activeProfileId: "night-shift",
          profiles: [
            ...state.settings.terminalThemes.profiles,
            {
              id: "night-shift",
              name: "  Night Shift  ",
              source: "itermcolors",
              minimumContrastRatio: 99,
              variants: {
                dark: {
                  ...builtinTheme.variants.dark,
                  foreground: "   ",
                  ansi: ["#111111"]
                },
                light: {
                  ...builtinTheme.variants.light,
                  background: ""
                }
              }
            }
          ]
        }
      }
    });

    const customTheme = state.settings.terminalThemes.profiles.find(
      (profile) => profile.id === "night-shift"
    );

    expect(
      state.settings.terminalThemes.profiles
        .slice(0, BUILTIN_TERMINAL_THEME_PROFILES.length)
        .map((profile) => profile.id)
    ).toEqual(BUILTIN_TERMINAL_THEME_PROFILES.map((profile) => profile.id));
    expect(state.settings.terminalThemes.activeProfileId).toBe("night-shift");
    expect(customTheme?.name).toBe("Night Shift");
    expect(customTheme?.minimumContrastRatio).toBe(21);
    expect(customTheme?.variants.dark.foreground).toBe(
      builtinTheme.variants.dark.foreground
    );
    expect(customTheme?.variants.dark.ansi[0]).toBe("#111111");
    expect(customTheme?.variants.dark.ansi[1]).toBe(
      builtinTheme.variants.dark.ansi[1]
    );
    expect(customTheme?.variants.light.background).toBe(
      builtinTheme.variants.light.background
    );
  });

  it("migrates missing terminal theme settings into the built-in profile", () => {
    const state = createInitialState();
    const legacyState = structuredClone(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    delete (legacyState.settings as { terminalThemes?: unknown })
      .terminalThemes;

    const restored = cloneState(legacyState as typeof state);

    expect(restored.settings.terminalThemes.activeProfileId).toBe(
      BUILTIN_TERMINAL_THEME_PROFILE_ID
    );
    expect(restored.settings.terminalThemes.profiles).toHaveLength(
      BUILTIN_TERMINAL_THEME_PROFILES.length
    );
    expect(restored.settings.terminalThemes.profiles[0]?.name).toBe(
      "kmux Default"
    );
    expect(restored.settings.terminalThemes.profiles[1]?.name).toBe(
      "IntelliJ Islands"
    );
  });

  it("preserves a user-renamed surface title when metadata updates arrive", () => {
    const state = createInitialState();
    const paneId = Object.keys(state.panes)[0];
    applyAction(state, { type: "surface.create", paneId });

    const activeSurfaceId = state.panes[paneId].activeSurfaceId;
    applyAction(state, {
      type: "surface.rename",
      surfaceId: activeSurfaceId,
      title: "logs"
    });
    applyAction(state, {
      type: "surface.metadata",
      surfaceId: activeSurfaceId,
      title: "shell title"
    });

    expect(state.surfaces[activeSurfaceId].title).toBe("logs");
  });

  it("focuses the previous tab when closing an active surface", () => {
    const state = createInitialState();
    const paneId = Object.keys(state.panes)[0];
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });
    const secondSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });

    applyAction(state, { type: "surface.focus", surfaceId: secondSurfaceId });
    applyAction(state, { type: "surface.close", surfaceId: secondSurfaceId });

    expect(state.panes[paneId].surfaceIds).toEqual([
      firstSurfaceId,
      expect.any(String)
    ]);
    expect(state.panes[paneId].activeSurfaceId).toBe(firstSurfaceId);
    expect(state.surfaces[secondSurfaceId]).toBeUndefined();
  });

  it("focuses the next remaining tab when closing the first active surface", () => {
    const state = createInitialState();
    const paneId = Object.keys(state.panes)[0];
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });
    const secondSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.focus", surfaceId: firstSurfaceId });
    applyAction(state, { type: "surface.close", surfaceId: firstSurfaceId });

    expect(state.panes[paneId].surfaceIds).toEqual([secondSurfaceId]);
    expect(state.panes[paneId].activeSurfaceId).toBe(secondSurfaceId);
    expect(state.surfaces[firstSurfaceId]).toBeUndefined();
  });

  it("refreshes derived metadata only when cwd changes", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];

    const effectsWithCwd = applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      cwd: "/tmp/kmux"
    });
    expect(effectsWithCwd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata.refresh",
          surfaceId,
          cwd: "/tmp/kmux"
        })
      ])
    );

    const effectsWithDerivedValues = applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      branch: "main",
      ports: [3000, 3001]
    });
    expect(
      effectsWithDerivedValues.some(
        (effect) => effect.type === "metadata.refresh"
      )
    ).toBe(false);
    expect(state.surfaces[surfaceId].branch).toBe("main");
    expect(state.surfaces[surfaceId].ports).toEqual([3000, 3001]);
  });

  it("clears branch metadata when metadata explicitly reports no git branch", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId =
      state.panes[state.surfaces[surfaceId].paneId].workspaceId;

    applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      branch: "main"
    });

    expect(state.surfaces[surfaceId].branch).toBe("main");
    expect(state.workspaces[workspaceId].branch).toBe("main");

    applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      branch: null
    });

    expect(state.surfaces[surfaceId].branch).toBeUndefined();
    expect(state.workspaces[workspaceId].branch).toBeUndefined();
  });

  it("refreshes derived metadata when a session starts running", () => {
    const state = createInitialState();
    const sessionId = Object.keys(state.sessions)[0];
    const surfaceId = state.sessions[sessionId].surfaceId;

    const effects = applyAction(state, {
      type: "session.started",
      sessionId,
      pid: 4242
    });

    expect(state.sessions[sessionId].runtimeState).toBe("running");
    expect(state.sessions[sessionId].pid).toBe(4242);
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata.refresh",
          surfaceId,
          pid: 4242
        })
      ])
    );
  });

  it("jumps to the latest unread notification target across workspaces", () => {
    const state = createInitialState();
    const originalWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    applyAction(state, { type: "workspace.create", name: "alerts" });

    const alertsWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const alertsPaneId = state.workspaces[alertsWorkspaceId].activePaneId;
    const alertsSurfaceId = state.panes[alertsPaneId].activeSurfaceId;

    applyAction(state, {
      type: "workspace.select",
      workspaceId: originalWorkspaceId
    });
    applyAction(state, {
      type: "notification.create",
      workspaceId: alertsWorkspaceId,
      paneId: alertsPaneId,
      surfaceId: alertsSurfaceId,
      title: "alerts jump",
      message: "jump to keyboard target"
    });

    applyAction(state, { type: "notification.jumpLatestUnread" });

    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(
      alertsWorkspaceId
    );
    expect(state.workspaces[alertsWorkspaceId].activePaneId).toBe(alertsPaneId);
    expect(state.panes[alertsPaneId].activeSurfaceId).toBe(alertsSurfaceId);
    expect(state.notifications[0]?.read).toBe(true);
  });

  it("preserves terminal notification sources during restore", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Terminal notice",
      message: "done",
      source: "terminal"
    });

    const restored = cloneState(state);

    expect(restored.notifications[0]?.source).toBe("terminal");
  });

  it("uses numbered default workspace labels in the UI while sidebar summaries follow the first tab title", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create" });

    const createdWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const createdPaneId = state.workspaces[createdWorkspaceId].activePaneId;
    const createdSurfaceId = state.panes[createdPaneId].surfaceIds[0];
    const rowBeforeRename = buildViewModel(state).workspaceRows.find(
      (row) => row.workspaceId === createdWorkspaceId
    );

    expect(rowBeforeRename?.name).toBe("new workspace");
    expect(rowBeforeRename?.nameLocked).toBe(false);
    expect(rowBeforeRename?.summary).toBe("new workspace");

    applyAction(state, {
      type: "workspace.rename",
      workspaceId: createdWorkspaceId,
      name: "support"
    });
    applyAction(state, {
      type: "surface.rename",
      surfaceId: createdSurfaceId,
      title: "claude / planning"
    });

    const rowAfterRename = buildViewModel(state).workspaceRows.find(
      (row) => row.workspaceId === createdWorkspaceId
    );
    expect(rowAfterRename?.name).toBe("support");
    expect(rowAfterRename?.nameLocked).toBe(true);
    expect(rowAfterRename?.summary).toBe("claude / planning");
  });

  it("closes other workspaces around a selected target", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    expect(betaId).toBeTruthy();

    applyAction(state, {
      type: "workspace.closeOthers",
      workspaceId: betaId!
    });

    const vm = buildViewModel(state);
    expect(vm.workspaceRows.map((row) => row.name)).toEqual(["beta"]);
    expect(vm.activeWorkspace.name).toBe("beta");
  });

  it("closing the active workspace promotes a remaining workspace without leaving stale ids", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;
    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();

    applyAction(state, { type: "workspace.select", workspaceId: betaId! });
    applyAction(state, { type: "workspace.close", workspaceId: betaId! });

    const vm = buildViewModel(state);
    expect(vm.workspaceRows.every((row) => row.workspaceId !== betaId)).toBe(
      true
    );
    expect(vm.activeWorkspace.id).toBe(gammaId);
  });

  it("clamps sidebar width updates and restores a safe default from stale snapshots", () => {
    const state = createInitialState();

    applyAction(state, {
      type: "workspace.sidebar.setWidth",
      width: MIN_SIDEBAR_WIDTH - 80
    });
    expect(buildViewModel(state).sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);

    applyAction(state, {
      type: "workspace.sidebar.setWidth",
      width: MAX_SIDEBAR_WIDTH + 80
    });
    expect(buildViewModel(state).sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);

    const restoredSnapshot = cloneState({
      ...state,
      windows: {
        ...state.windows,
        [state.activeWindowId]: {
          ...state.windows[state.activeWindowId],
          sidebarWidth: Number.NaN
        }
      }
    });

    expect(buildViewModel(restoredSnapshot).sidebarWidth).toBe(
      MAX_SIDEBAR_WIDTH
    );
  });

  it("toggles pinned state for a workspace", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });

    const alphaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;
    expect(alphaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: alphaId! });
    expect(
      buildViewModel(state).workspaceRows.find((row) => row.name === "alpha")
        ?.pinned
    ).toBe(true);

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: alphaId! });
    expect(
      buildViewModel(state).workspaceRows.find((row) => row.name === "alpha")
        ?.pinned
    ).toBe(false);
  });

  it("keeps workspace rows in pinned-first order while preserving relative order inside each group", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: betaId! });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "hq",
      "beta",
      "alpha",
      "gamma"
    ]);

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: gammaId! });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "hq",
      "beta",
      "gamma",
      "alpha"
    ]);
  });

  it("selects workspaces by the visible pinned-first order", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const hqId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "hq"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;
    const alphaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;

    expect(hqId).toBeTruthy();
    expect(gammaId).toBeTruthy();
    expect(alphaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: gammaId! });
    applyAction(state, { type: "workspace.select", workspaceId: hqId! });
    applyAction(state, { type: "workspace.selectRelative", delta: 1 });

    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(gammaId);

    applyAction(state, { type: "workspace.selectRelative", delta: 1 });
    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(alphaId);

    applyAction(state, { type: "workspace.selectIndex", index: 1 });
    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(gammaId);
  });

  it("moves workspaces within their pinned section without crossing the pinned boundary", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;
    const alphaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();
    expect(alphaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: betaId! });
    applyAction(state, {
      type: "workspace.move",
      workspaceId: gammaId!,
      toIndex: 0
    });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "hq",
      "beta",
      "gamma",
      "alpha"
    ]);

    applyAction(state, {
      type: "workspace.move",
      workspaceId: betaId!,
      toIndex: 0
    });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "beta",
      "hq",
      "gamma",
      "alpha"
    ]);

    applyAction(state, {
      type: "workspace.move",
      workspaceId: alphaId!,
      toIndex: 0
    });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "beta",
      "hq",
      "alpha",
      "gamma"
    ]);
  });
});
