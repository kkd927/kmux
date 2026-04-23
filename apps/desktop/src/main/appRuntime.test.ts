import { applyAction, createInitialState } from "@kmux/core";
import { vi } from "vitest";

import type { AppState } from "@kmux/core";
import type { KmuxSettings, ShellPatch } from "@kmux/proto";

const { beep, browserWindows, showNotification } = vi.hoisted(() => ({
  beep: vi.fn(),
  browserWindows: [] as Array<{
    webContents: { send: ReturnType<typeof vi.fn> };
    setTitle: ReturnType<typeof vi.fn>;
  }>,
  showNotification: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => browserWindows
  },
  Notification: class {
    constructor(private readonly options: { title: string; body: string }) {}

    show(): void {
      showNotification(this.options);
    }
  },
  shell: {
    beep
  }
}));

import { AppStore } from "./store";
import { createAppRuntime, type AppRuntimeOptions } from "./appRuntime";

function createRuntime(
  notificationSound: boolean,
  options: {
    snapshotRecord?: { snapshot: AppState; cleanShutdown: boolean } | null;
    settings?: KmuxSettings | null;
  } & Partial<AppRuntimeOptions> = {}
) {
  const initialState = createInitialState("/bin/zsh");
  initialState.settings.notificationSound = notificationSound;
  const snapshotSave = vi.fn();
  const runtime = createAppRuntime({
    paths: {
      socketPath: "/tmp/kmux.sock",
      nodePath: "/Applications/kmux.app/Contents/MacOS/kmux"
    },
    snapshotStore: {
      path: "/tmp/kmux-snapshot.json",
      load: () => options.snapshotRecord?.snapshot ?? null,
      loadRecord: () => options.snapshotRecord ?? null,
      save: snapshotSave
    },
    windowStateStore: {
      path: "/tmp/kmux-window.json",
      load: () => null,
      save: vi.fn()
    },
    settingsStore: {
      path: "/tmp/kmux-settings.json",
      load: () => options.settings ?? null,
      save: vi.fn()
    },
    defaultShellPath: "/bin/zsh",
    refreshMetadata: vi.fn(),
    persistWindowState: vi.fn(),
    profileRecorder: options.profileRecorder
  });

  runtime.setStore(new AppStore(initialState));

  return Object.assign(runtime, {
    __test__: {
      snapshotSave
    }
  });
}

function createMockWindow(): (typeof browserWindows)[number] {
  return {
    webContents: {
      send: vi.fn()
    },
    setTitle: vi.fn()
  };
}

function getLastShellPatch(
  window: (typeof browserWindows)[number]
): ShellPatch | null {
  const lastShellPatchCall = window.webContents.send.mock.calls
    .slice()
    .reverse()
    .find(([channel]) => channel === "kmux:shell-patch");
  return (lastShellPatchCall?.[1] as ShellPatch | undefined) ?? null;
}

beforeEach(() => {
  beep.mockClear();
  browserWindows.length = 0;
  showNotification.mockClear();
});

describe("app runtime bell sound effects", () => {
  it("plays a bell sound when enabled", () => {
    createRuntime(true).runEffects([{ type: "bell.sound" }]);

    expect(beep).toHaveBeenCalledTimes(1);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("skips bell sounds when disabled", () => {
    createRuntime(false).runEffects([{ type: "bell.sound" }]);

    expect(beep).not.toHaveBeenCalled();
  });
});

describe("app runtime restore", () => {
  it("clears restored notifications after an unclean shutdown", () => {
    const snapshot = createInitialState("/bin/zsh");
    const workspaceId = Object.keys(snapshot.workspaces)[0];
    const paneId = Object.keys(snapshot.panes)[0];
    const surfaceId = Object.keys(snapshot.surfaces)[0];

    applyAction(snapshot, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Codex needs input",
      message: "Waiting for input",
      source: "agent",
      kind: "needs_input",
      agent: "codex"
    });

    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: false
      }
    });

    const restored = runtime.restoreInitialState();

    expect(restored.notifications).toEqual([]);
    expect(restored.surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        unreadCount: 0,
        attention: false
      })
    );
  });

  it("restores an unclean snapshot even when legacy settings disable startupRestore", () => {
    const snapshot = createInitialState("/bin/zsh");

    applyAction(snapshot, {
      type: "workspace.create",
      name: "project"
    });

    const restoredWorkspaceId =
      snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;
    const legacySettings = {
      ...snapshot.settings,
      startupRestore: false
    } as KmuxSettings & { startupRestore: boolean };

    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: false
      },
      settings: legacySettings as unknown as KmuxSettings
    });

    const restored = runtime.restoreInitialState();

    expect(restored.workspaces[restoredWorkspaceId]?.name).toBe("project");
    expect(
      "startupRestore" in
        (restored.settings as unknown as Record<string, unknown>)
    ).toBe(false);
  });

  it("starts fresh instead of restoring a clean-shutdown snapshot", () => {
    const snapshot = createInitialState("/bin/zsh");

    applyAction(snapshot, {
      type: "workspace.create",
      name: "project"
    });

    const restoredWorkspaceId =
      snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;

    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true
      }
    });

    const restored = runtime.restoreInitialState();

    expect(Object.keys(restored.workspaces)).toHaveLength(1);
    expect(Object.keys(restored.panes)).toHaveLength(1);
    expect(Object.keys(restored.surfaces)).toHaveLength(1);
    expect(restored.workspaces[restoredWorkspaceId]).toBeUndefined();
    expect(
      restored.windows[restored.activeWindowId]?.workspaceOrder
    ).toHaveLength(1);
  });

  it("clears notifications from the persisted snapshot on clean shutdown", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];
    const surfaceId = Object.keys(state.surfaces)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Codex needs input",
      message: "Waiting for input",
      source: "agent",
      kind: "needs_input",
      agent: "codex"
    });

    runtime.shutdown();

    const [savedSnapshot, saveOptions] =
      runtime.__test__.snapshotSave.mock.lastCall ?? [];
    const savedSurface = Object.values(savedSnapshot.surfaces)[0];

    expect(saveOptions).toEqual({
      cleanShutdown: true
    });
    expect(savedSnapshot.notifications).toEqual([]);
    expect(savedSurface).toEqual(
      expect.objectContaining({
        unreadCount: 0,
        attention: false
      })
    );
  });

  it("resets workspaces and tabs to a fresh session on clean shutdown", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();
    const initialWorkspaceId = Object.keys(state.workspaces)[0]!;

    applyAction(state, {
      type: "workspace.create",
      name: "project"
    });

    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activePaneId = state.workspaces[activeWorkspaceId]!.activePaneId;

    applyAction(state, {
      type: "surface.create",
      paneId: activePaneId,
      title: "logs"
    });

    runtime.shutdown();

    const [savedSnapshot, saveOptions] =
      runtime.__test__.snapshotSave.mock.lastCall ?? [];

    expect(saveOptions).toEqual({ cleanShutdown: true });
    expect(Object.keys(savedSnapshot.workspaces)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.panes)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.surfaces)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.sessions)).toHaveLength(1);
    expect(
      savedSnapshot.windows[savedSnapshot.activeWindowId]?.workspaceOrder
    ).toHaveLength(1);
    expect(savedSnapshot.workspaces[initialWorkspaceId]).toBeUndefined();
  });
});

describe("app runtime shell patches", () => {
  it("does not emit a patch for no-op reducer dispatches", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    runtime.dispatchAppAction({
      type: "workspace.select",
      workspaceId: "workspace_missing"
    });

    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(window.setTitle).not.toHaveBeenCalled();
  });

  it("emits versioned patches with only the changed shell slices", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      const workspaceId =
        runtime.getState().windows[runtime.getState().activeWindowId]
          .activeWorkspaceId;

      runtime.dispatchAppAction({
        type: "sidebar.setStatus",
        workspaceId,
        text: "Busy"
      });

      expect(window.webContents.send).toHaveBeenCalledWith(
        "kmux:shell-patch",
        expect.objectContaining({
          version: 1,
          workspaceRowsPatch: expect.objectContaining({
            upsert: expect.any(Array)
          }),
          activeWorkspace: expect.any(Object)
        })
      );
      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          version: 1,
          workspaceRowsPatch: expect.objectContaining({
            upsert: expect.any(Array)
          }),
          activeWorkspace: expect.any(Object)
        })
      );
      expect(getLastShellPatch(window)).not.toHaveProperty("settings");
      expect(getLastShellPatch(window)).not.toHaveProperty("notifications");
      expect(getLastShellPatch(window)).not.toHaveProperty("terminalTypography");
      expect(getLastShellPatch(window)).not.toHaveProperty("workspaceRows");
      expect(getLastShellPatch(window)).not.toHaveProperty(
        "activeWorkspacePaneTree"
      );
      expect(window.setTitle).not.toHaveBeenCalled();
    } finally {
      runtime.shutdown();
    }
  });

  it("increments shell patch versions when the active window slice changes", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      runtime.dispatchAppAction({
        type: "workspace.sidebar.toggle"
      });

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          version: 1,
          sidebarVisible: false
        })
      );
      expect(window.setTitle).not.toHaveBeenCalled();

      window.webContents.send.mockClear();
      window.setTitle.mockClear();

      const workspaceId =
        runtime.getState().windows[runtime.getState().activeWindowId]
          .activeWorkspaceId;

      runtime.dispatchAppAction({
        type: "workspace.rename",
        workspaceId,
        name: "agent workspace"
      });

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          version: 2,
          title: "agent workspace cli/unix socket"
        })
      );
      expect(window.setTitle).toHaveBeenCalledWith(
        "agent workspace cli/unix socket"
      );
    } finally {
      runtime.shutdown();
    }
  });

  it("emits terminal tree patches for surface metadata changes", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      const surfaceId = Object.keys(runtime.getState().surfaces)[0];

      runtime.dispatchAppAction({
        type: "surface.metadata",
        surfaceId,
        title: "codex",
        cwd: "/tmp/kmux"
      });

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          version: 1,
          workspaceRowsPatch: expect.objectContaining({
            upsert: expect.any(Array)
          }),
          activeWorkspacePaneTree: expect.any(Object)
        })
      );
      expect(getLastShellPatch(window)).not.toHaveProperty("activeWorkspace");
    } finally {
      runtime.shutdown();
    }
  });

  it("builds shell snapshots with an activity-only active workspace slice", () => {
    const runtime = createRuntime(false);

    try {
      const snapshot = runtime.getShellState();

      expect(snapshot.activeWorkspace).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          statusEntries: expect.any(Array),
          logs: expect.any(Array)
        })
      );
      expect(snapshot.activeWorkspace).not.toHaveProperty("rootNodeId");
      expect(snapshot.activeWorkspace).not.toHaveProperty("nodes");
      expect(snapshot.activeWorkspace).not.toHaveProperty("panes");
      expect(snapshot.activeWorkspace).not.toHaveProperty("surfaces");
      expect(snapshot.activeWorkspace).not.toHaveProperty("activePaneId");
      expect(snapshot.activeWorkspacePaneTree).toEqual(
        expect.objectContaining({
          rootNodeId: expect.any(String),
          nodes: expect.any(Object),
          panes: expect.any(Object),
          surfaces: expect.any(Object),
          activePaneId: expect.any(String)
        })
      );
    } finally {
      runtime.shutdown();
    }
  });

  it("emits notification patches when selecting a workspace clears unread state", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      const originalWorkspaceId =
        runtime.getState().windows[runtime.getState().activeWindowId]
          .activeWorkspaceId;

      runtime.dispatchAppAction({
        type: "workspace.create",
        name: "alerts"
      });
      const alertsWorkspaceId =
        runtime.getState().windows[runtime.getState().activeWindowId]
          .activeWorkspaceId;
      const alertsPaneId = runtime.getState().workspaces[alertsWorkspaceId].activePaneId;
      const alertsSurfaceId =
        runtime.getState().panes[alertsPaneId].activeSurfaceId;

      runtime.dispatchAppAction({
        type: "workspace.select",
        workspaceId: originalWorkspaceId
      });
      runtime.dispatchAppAction({
        type: "notification.create",
        workspaceId: alertsWorkspaceId,
        paneId: alertsPaneId,
        surfaceId: alertsSurfaceId,
        title: "workspace row clears unread",
        message: "selecting the workspace should mark this read"
      });

      window.webContents.send.mockClear();

      runtime.dispatchAppAction({
        type: "workspace.select",
        workspaceId: alertsWorkspaceId
      });

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          notifications: [],
          unreadNotifications: 0,
          workspaceRowsPatch: expect.objectContaining({
            upsert: expect.any(Array)
          }),
          activeWorkspacePaneTree: expect.any(Object)
        })
      );
    } finally {
      runtime.shutdown();
    }
  });

  it("emits settings-only patches unless terminal typography settings change", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      runtime.dispatchAppAction({
        type: "settings.update",
        patch: {
          warnBeforeQuit: false
        }
      });

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          version: 1,
          settings: expect.objectContaining({
            warnBeforeQuit: false
          })
        })
      );
      expect(getLastShellPatch(window)).not.toHaveProperty(
        "terminalTypography"
      );
    } finally {
      runtime.shutdown();
    }
  });

  it("does not emit redundant patches for repeated agent running events", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      const state = runtime.getState();
      const surfaceId = Object.keys(state.surfaces)[0];
      const workspaceId = Object.keys(state.workspaces)[0];

      runtime.dispatchAppAction({
        type: "agent.event",
        workspaceId,
        surfaceId,
        agent: "claude",
        event: "running",
        message: "Running"
      });
      const firstUpdatedAt =
        runtime.getState().workspaces[workspaceId].statusEntries[
          `agent:claude:${surfaceId}`
        ]?.updatedAt;

      window.webContents.send.mockClear();
      window.setTitle.mockClear();

      runtime.dispatchAppAction({
        type: "agent.event",
        workspaceId,
        surfaceId,
        agent: "claude",
        event: "running",
        message: "Running"
      });

      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(window.setTitle).not.toHaveBeenCalled();
      expect(
        runtime.getState().workspaces[workspaceId].statusEntries[
          `agent:claude:${surfaceId}`
        ]?.updatedAt
      ).toBe(firstUpdatedAt);
    } finally {
      runtime.shutdown();
    }
  });

  it("does not emit shell patches for non-UI effect batches", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    runtime.runEffects([
      {
        type: "session.spawn",
        spec: {
          sessionId: "session_1",
          surfaceId: "surface_1",
          workspaceId: "workspace_1",
          launch: {},
          cols: 120,
          rows: 30,
          env: {}
        }
      }
    ]);

    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(window.setTitle).not.toHaveBeenCalled();
  });

  it("records shell patch profiling metrics when a recorder is provided", () => {
    const record = vi.fn();
    const runtime = createRuntime(false, {
      profileRecorder: {
        enabled: true,
        record
      }
    });
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      runtime.dispatchAppAction({
        type: "workspace.sidebar.toggle"
      });

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "main",
          name: "shell.patch.emit",
          details: expect.objectContaining({
            requestedGroups: ["window"],
            changedKeys: expect.arrayContaining(["sidebarVisible"]),
            payloadBytes: expect.any(Number),
            durationMs: expect.any(Number)
          })
        })
      );
    } finally {
      runtime.shutdown();
    }
  });
});
