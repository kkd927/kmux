import {
    applyAction,
    buildViewModel,
    cloneState,
    createInitialState,
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
        terminalFontFamily: "   ",
        terminalFontSize: Number.NaN,
        terminalLineHeight: Number.POSITIVE_INFINITY
      }
    });

    expect(state.settings.terminalFontFamily).toContain("JetBrains Mono");
    expect(state.settings.terminalFontSize).toBe(13);
    expect(state.settings.terminalLineHeight).toBe(1);
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
});
