import { applyAction, createInitialState } from "@kmux/core";
import { vi } from "vitest";

import type { AppState } from "@kmux/core";
import type { KmuxSettings } from "@kmux/proto";

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
import { createAppRuntime } from "./appRuntime";

function createRuntime(
  notificationSound: boolean,
  options: {
    snapshotRecord?: { snapshot: AppState; cleanShutdown: boolean } | null;
    settings?: KmuxSettings | null;
  } = {}
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
    persistWindowState: vi.fn()
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

describe("app runtime view broadcasts", () => {
  it("does not broadcast no-op reducer dispatches", () => {
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

  it("broadcasts when a reducer action changes app state", () => {
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

      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      expect(window.setTitle).toHaveBeenCalledTimes(1);
    } finally {
      runtime.shutdown();
    }
  });

  it("does not broadcast repeated agent running events", () => {
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
});
