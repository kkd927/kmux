import {
  applyAction,
  buildViewModel,
  cloneState,
  createInitialState,
  listPaneIds
} from "./index";

describe("core reducer", () => {
  it("creates and selects a new workspace", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "new" });
    const vm = buildViewModel(state);

    expect(vm.workspaceRows).toHaveLength(2);
    expect(vm.activeWorkspace.name).toBe("new");
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
      state.workspaces[workspaceId] as typeof state.workspaces[string] & {
        zoomedPaneId?: string;
      }
    ).zoomedPaneId = "pane_missing";
    state.settings.shortcuts["pane.zoom"] = "Meta+Enter";

    const restored = cloneState(state);
    const vm = buildViewModel(restored);

    expect(
      "zoomedPaneId" in
        ((restored.workspaces[workspaceId] as Record<string, unknown>) ?? {})
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
