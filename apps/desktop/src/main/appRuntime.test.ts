import { applyAction, createInitialState } from "@kmux/core";
import { vi } from "vitest";

import type { AppState } from "@kmux/core";

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
  snapshotRecord?: { snapshot: AppState; cleanShutdown: boolean } | null
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
      load: () => snapshotRecord?.snapshot ?? null,
      loadRecord: () => snapshotRecord ?? null,
      save: snapshotSave
    },
    windowStateStore: {
      path: "/tmp/kmux-window.json",
      load: () => null,
      save: vi.fn()
    },
    settingsStore: {
      path: "/tmp/kmux-settings.json",
      load: () => null,
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
      snapshot,
      cleanShutdown: false
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

    expect(runtime.__test__.snapshotSave).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: [],
        surfaces: expect.objectContaining({
          [surfaceId]: expect.objectContaining({
            unreadCount: 0,
            attention: false
          })
        })
      }),
      {
        cleanShutdown: true
      }
    );
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
