import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAction,
  cloneState,
  createDefaultSettings,
  createInitialState,
  encodeLocatedPathDto,
  locatedPathForTarget
} from "@kmux/core";
import { LINUX_DEFAULT_SHORTCUTS } from "@kmux/ui";
import { vi } from "vitest";

import type { AppState } from "@kmux/core";
import type {
  ExternalAgentSessionsSnapshot,
  KmuxSettings,
  ShellPatch
} from "@kmux/proto";
import { uint64 } from "@kmux/proto";
import type { PersistedWindowState } from "@kmux/persistence";

const { beep, browserWindows, showNotification, showNotificationFailure } =
  vi.hoisted(() => ({
    beep: vi.fn(),
    browserWindows: [] as Array<{
      webContents: { send: ReturnType<typeof vi.fn> };
      setTitle: ReturnType<typeof vi.fn>;
    }>,
    showNotification: vi.fn(),
    showNotificationFailure: {
      current: null as unknown | null
    }
  }));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => browserWindows
  },
  Notification: class {
    constructor(
      private readonly options: { title: string; body: string; icon?: string }
    ) {}

    show(): void {
      if (showNotificationFailure.current) {
        throw showNotificationFailure.current;
      }
      showNotification(this.options);
    }
  },
  shell: {
    beep
  }
}));

import { AppStore } from "./store";

function localPath(value: string) {
  return locatedPathForTarget({ kind: "local" }, value);
}

function rawPath(value: ReturnType<typeof localPath>): string {
  return encodeLocatedPathDto(value).path;
}
import {
  createAppRuntime,
  shouldUseNativeShellBeep,
  type AppRuntimeOptions
} from "./appRuntime";
import { DIAGNOSTICS_LOG_PATH_ENV } from "../shared/diagnostics";

function createRuntime(
  notificationSound: boolean,
  options: {
    initialState?: AppState;
    snapshotRecord?: {
      snapshot: AppState;
      cleanShutdown: boolean;
      restoreOnLaunch?: boolean;
    } | null;
    settings?: KmuxSettings | null;
    windowState?: PersistedWindowState | null;
  } & Partial<AppRuntimeOptions> = {}
) {
  const initialState = options.initialState ?? createInitialState("/bin/zsh");
  initialState.settings.notificationSound = notificationSound;
  const snapshotSave = vi.fn();
  const runtime = createAppRuntime({
    paths: {
      socketPath: "/tmp/kmux.sock",
      nodePath: "/Applications/kmux.app/Contents/MacOS/kmux"
    },
    createShellLaunchPolicy: (launch) => ({
      defaultShellPath: launch.shell ?? "/bin/zsh",
      defaultShellArgs: ["-l"],
      stripManagedEnv: true,
      integration: {
        enabled: true,
        mode: "posix-wrapper"
      },
      agentPath: {
        helperBinDir: "/tmp/kmux-agent-hooks",
        wrapperBinDir: "/tmp/kmux-agent-wrappers",
        prependWrapperToPath: true
      },
      hookEnv: {
        KMUX_SOCKET_PATH: "/tmp/kmux.sock",
        KMUX_AGENT_BIN_DIR: "/tmp/kmux-agent-hooks",
        KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux"
      }
    }),
    snapshotStore: {
      path: "/tmp/kmux-snapshot.json",
      load: () => options.snapshotRecord?.snapshot ?? null,
      loadRecord: () =>
        options.snapshotRecord
          ? {
              status: "ok" as const,
              record: {
                ...options.snapshotRecord,
                restoreOnLaunch: options.snapshotRecord.restoreOnLaunch === true
              }
            }
          : { status: "missing" as const },
      save: snapshotSave,
      saveDurable: snapshotSave
    },
    windowStateStore: {
      path: "/tmp/kmux-window.json",
      load: () => options.windowState ?? null,
      save: vi.fn()
    },
    settingsStore: {
      path: "/tmp/kmux-settings.json",
      load: () => options.settings ?? null,
      save: vi.fn()
    },
    defaultShellPath: "/bin/zsh",
    shortcutDefaultsPlatform: options.shortcutDefaultsPlatform,
    refreshMetadata: options.refreshMetadata ?? vi.fn(),
    persistWindowState: vi.fn(),
    profileRecorder: options.profileRecorder,
    externalSessionIndexer: options.externalSessionIndexer,
    nativeNotificationIdentity: options.nativeNotificationIdentity,
    playBellSound: options.playBellSound,
    resolveLocalPath:
      options.resolveLocalPath ??
      ((path) => {
        if (path.kind !== "local") {
          throw new Error("test local provider rejected an SSH path");
        }
        return encodeLocatedPathDto(path).path;
      })
  });

  runtime.setStore(new AppStore(initialState));

  return Object.assign(runtime, {
    __test__: {
      snapshotSave
    }
  });
}

describe("app runtime Main fact projection", () => {
  it("persists and broadcasts authority-bearing remote facts", () => {
    vi.useFakeTimers();
    const targetId = "target-main-fact";
    const initialState = createInitialState("/bin/zsh");
    applyAction(initialState, {
      type: "workspace.create",
      name: "remote",
      target: { kind: "ssh", targetId }
    });
    const workspaceId =
      initialState.windows[initialState.activeWindowId].activeWorkspaceId;
    const workspace = initialState.workspaces[workspaceId];
    const pane = initialState.panes[workspace.activePaneId];
    const surface = initialState.surfaces[pane.activeSurfaceId];
    const session = initialState.sessions[surface.content.sessionId];
    const runtime = createRuntime(false, { initialState });
    const window = createMockWindow();
    browserWindows.push(window);
    runtime.__test__.snapshotSave.mockClear();

    try {
      runtime.dispatchMainFact({
        type: "remote-session.observed",
        resourceKey: {
          desktopInstallationId: "desktop-main-fact",
          targetId,
          workspaceId,
          sessionId: session.id
        },
        processState: "running",
        observedAt: "2026-07-17T00:00:00.000Z",
        keeperGeneration: "keeper-main-fact",
        remoteResourceRevision: uint64(1n),
        storageStatus: {
          state: "normal",
          journalAdmitted: uint64(1n),
          journalSynced: uint64(1n),
          emergencyBytes: 0
        }
      });

      expect(runtime.getState().sessions[session.id].remoteRuntime).toEqual({
        keeperGeneration: "keeper-main-fact",
        remoteResourceRevision: 1n,
        storageStatus: {
          state: "normal",
          journalAdmitted: 1n,
          journalSynced: 1n,
          emergencyBytes: 0
        }
      });
      expect(getLastShellPatch(window)).toMatchObject({
        activeWorkspacePaneTree: expect.any(Object)
      });
      vi.advanceTimersByTime(300);
      expect(runtime.__test__.snapshotSave).toHaveBeenCalledWith(
        runtime.getState(),
        { cleanShutdown: false }
      );
    } finally {
      runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("installs a live durable conversion snapshot without startup readiness reset", () => {
    const targetId = "target-live-install";
    const initialState = createInitialState("/bin/zsh");
    applyAction(initialState, {
      type: "workspace.create",
      name: "remote",
      target: { kind: "ssh", targetId }
    });
    const workspaceId =
      initialState.windows[initialState.activeWindowId].activeWorkspaceId;
    const workspace = initialState.workspaces[workspaceId];
    const pane = initialState.panes[workspace.activePaneId];
    const sessionId =
      initialState.surfaces[pane.activeSurfaceId].content.sessionId;
    const runtime = createRuntime(false, { initialState });
    const window = createMockWindow();
    browserWindows.push(window);
    const decided = cloneState(runtime.getState());
    decided.sessions[sessionId].runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "detached"
    };
    decided.sessions[sessionId].shellInputReady = true;

    try {
      runtime.installDurableState(decided);

      expect(runtime.getState().sessions[sessionId]).toMatchObject({
        runtimeStatus: {
          processState: "running",
          observationState: "observed",
          attachmentState: "detached"
        },
        shellInputReady: true
      });
      expect(getLastShellPatch(window)).toMatchObject({
        activeWorkspacePaneTree: expect.any(Object)
      });
    } finally {
      runtime.shutdown();
    }
  });
});

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
  showNotificationFailure.current = null;
});

describe("app runtime shortcut default migration", () => {
  it("uses Linux shortcut defaults for first-run Linux settings", () => {
    const runtime = createRuntime(false, {
      shortcutDefaultsPlatform: "linux"
    });

    try {
      const state = runtime.restoreInitialState();

      expect(state.settings.shortcutDefaultsPlatform).toBe("linux");
      expect(state.settings.shortcuts).toEqual(LINUX_DEFAULT_SHORTCUTS);
    } finally {
      runtime.shutdown();
    }
  });

  it("migrates generated macOS shortcuts to Linux while preserving user edits", () => {
    const settings = createDefaultSettings();
    settings.shortcuts["pane.close"] = "Ctrl+Alt+K";
    const runtime = createRuntime(false, {
      shortcutDefaultsPlatform: "linux",
      settings
    });

    try {
      const state = runtime.restoreInitialState();

      expect(state.settings.shortcutDefaultsPlatform).toBe("linux");
      expect(state.settings.shortcuts["workspace.create"]).toBe(
        LINUX_DEFAULT_SHORTCUTS["workspace.create"]
      );
      expect(state.settings.shortcuts["pane.close"]).toBe("Ctrl+Alt+K");
    } finally {
      runtime.shutdown();
    }
  });
});

describe("app runtime bell sound effects", () => {
  it("forwards metadata refresh effects", () => {
    const refreshMetadata = vi.fn();
    const runtime = createRuntime(false, { refreshMetadata });

    runtime.runEffects([
      {
        type: "metadata.refresh",
        workspaceId: "workspace-1",
        surfaceId: "surface-1",
        pid: 123,
        cwd: localPath("/tmp/kmux")
      }
    ]);

    expect(refreshMetadata).toHaveBeenCalledWith(
      "surface-1",
      localPath("/tmp/kmux"),
      123
    );
  });

  it("plays a bell sound when enabled", () => {
    createRuntime(true, { playBellSound: beep }).runEffects([
      { type: "bell.sound" }
    ]);

    expect(beep).toHaveBeenCalledTimes(1);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("skips bell sounds when disabled", () => {
    createRuntime(false, { playBellSound: beep }).runEffects([
      { type: "bell.sound" }
    ]);

    expect(beep).not.toHaveBeenCalled();
  });

  it("does not use Electron native shell beep on Linux", () => {
    expect(shouldUseNativeShellBeep("linux")).toBe(false);
    expect(shouldUseNativeShellBeep("darwin")).toBe(true);
    expect(shouldUseNativeShellBeep("win32")).toBe(true);
  });

  it("adds native notification icon identity to desktop notifications", () => {
    const runtime = createRuntime(false, {
      nativeNotificationIdentity: {
        appId: "dev.kmux.desktop",
        appName: "kmux",
        iconPath: "/tmp/kmux/resources/notificationIcon.png"
      }
    });

    runtime.runEffects([
      {
        type: "notify.desktop",
        notification: {
          title: "Codex finished",
          message: "Ready for review"
        }
      } as never
    ]);

    expect(showNotification).toHaveBeenCalledWith({
      title: "Codex finished",
      body: "Ready for review",
      icon: "/tmp/kmux/resources/notificationIcon.png"
    });
  });

  it("keeps in-app notifications when native desktop notification delivery fails", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-runtime-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    const previousLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];
    showNotificationFailure.current = new Error(
      "org.freedesktop.Notifications unavailable"
    );
    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;

    try {
      const runtime = createRuntime(false, {
        nativeNotificationIdentity: {
          appId: "dev.kmux.desktop",
          appName: "kmux",
          startupWmClass: "kmux",
          iconPath: "/tmp/kmux/resources/notificationIcon.png"
        }
      });
      const state = runtime.getState();
      const workspaceId = Object.keys(state.workspaces)[0];
      const paneId = Object.keys(state.panes)[0];
      const surfaceId = Object.keys(state.surfaces)[0];

      expect(() =>
        runtime.dispatchAppAction({
          type: "notification.create",
          workspaceId,
          paneId,
          surfaceId,
          title: "Codex finished",
          message: "Ready for review",
          source: "agent",
          kind: "turn_complete",
          agent: "codex"
        })
      ).not.toThrow();

      expect(showNotification).not.toHaveBeenCalled();
      expect(runtime.getState().notifications[0]).toEqual(
        expect.objectContaining({
          workspaceId,
          paneId,
          surfaceId,
          title: "Codex finished",
          message: "Ready for review",
          source: "agent",
          kind: "turn_complete",
          agent: "codex"
        })
      );
      expect(runtime.getState().surfaces[surfaceId]).toEqual(
        expect.objectContaining({
          attention: true,
          unreadCount: 1
        })
      );

      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"main.effect.notify.desktop.failed"');
      expect(contents).toContain(`"workspaceId":"${workspaceId}"`);
      expect(contents).toContain(`"surfaceId":"${surfaceId}"`);
      expect(contents).toContain('"source":"agent"');
      expect(contents).toContain('"agent":"codex"');
      expect(contents).toContain('"appId":"dev.kmux.desktop"');
      expect(contents).toContain('"appName":"kmux"');
      expect(contents).toContain('"startupWmClass":"kmux"');
      expect(contents).toContain('"hasIcon":true');
      expect(contents).toContain(
        '"iconPath":"/tmp/kmux/resources/notificationIcon.png"'
      );
      expect(contents).toContain("org.freedesktop.Notifications unavailable");
    } finally {
      showNotificationFailure.current = null;
      if (typeof previousLogPath === "string") {
        process.env[DIAGNOSTICS_LOG_PATH_ENV] = previousLogPath;
      } else {
        delete process.env[DIAGNOSTICS_LOG_PATH_ENV];
      }
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe("app runtime external sessions", () => {
  it("lists and resumes an external agent session in a new workspace", async () => {
    const externalSnapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-04-26T12:00:00.000Z",
      sessions: [
        {
          key: "codex:codex-session",
          target: { kind: "local" },
          vendor: "codex",
          vendorLabel: "CODEX",
          title: "Fix terminal focus",
          cwd: "/tmp/project",
          updatedAt: "2026-04-26T11:00:00.000Z",
          relativeTimeLabel: "1h",
          canResume: true,
          resumeCommandPreview: "codex resume codex-session"
        }
      ]
    };
    const runtime = createRuntime(false, {
      externalSessionIndexer: {
        listExternalAgentSessions: () => externalSnapshot,
        resolveExternalAgentSession: (key: string) =>
          key === "codex:codex-session"
            ? {
                key,
                target: { kind: "local" },
                vendor: "codex",
                agentSessionRef: {
                  vendor: "codex",
                  externalKey: key,
                  sessionId: "codex-session"
                },
                title: "Fix terminal focus",
                cwd: "/tmp/project",
                launch: {
                  cwd: "/tmp/project",
                  initialInput: "codex resume codex-session\r",
                  title: "Fix terminal focus"
                }
              }
            : null
      }
    });

    await expect(runtime.getExternalAgentSessions()).resolves.toBe(
      externalSnapshot
    );
    const result = runtime.resumeExternalAgentSession("codex:codex-session");
    const state = runtime.getState();
    const workspace = state.workspaces[result.workspaceId];
    const pane = state.panes[workspace.activePaneId];
    const surface = state.surfaces[result.surfaceId];
    const session = state.sessions[surface.content.sessionId];

    expect(workspace.name).toBe("Fix terminal focus");
    expect(pane.activeSurfaceId).toBe(result.surfaceId);
    expect(session.launch).toMatchObject({
      shell: "/bin/zsh",
      initialInput: "codex resume codex-session\r",
      title: "Fix terminal focus"
    });
    expect(rawPath(session.launch.cwd)).toBe("/tmp/project");
    expect(session.launch.args).toBeUndefined();
    expect(session.agentSessionRef).toEqual({
      vendor: "codex",
      externalKey: "codex:codex-session",
      id: "codex-session",
      targetId: "local",
      cwd: session.launch.cwd
    });
  });

  it("focuses an already open external session instead of opening it again", () => {
    const runtime = createRuntime(false, {
      externalSessionIndexer: {
        listExternalAgentSessions: () => ({
          updatedAt: "2026-04-26T12:00:00.000Z",
          sessions: []
        }),
        resolveExternalAgentSession: (key: string) =>
          key === "antigravity:agy-session"
            ? {
                key,
                target: { kind: "local" },
                vendor: "antigravity",
                agentSessionRef: {
                  vendor: "antigravity",
                  externalKey: key,
                  sessionId: "agy-session"
                },
                title: "Read image plan",
                cwd: "/tmp/project",
                launch: {
                  cwd: "/tmp/project",
                  initialInput: "agy --conversation agy-session\r",
                  title: "Read image plan"
                }
              }
            : null
      }
    });

    const firstResult = runtime.resumeExternalAgentSession(
      "antigravity:agy-session"
    );
    const workspaceCountAfterOpen = Object.keys(
      runtime.getState().workspaces
    ).length;

    runtime.dispatchAppAction({
      type: "workspace.create",
      name: "other workspace",
      cwd: "/tmp/other"
    });
    expect(
      runtime.getState().windows[runtime.getState().activeWindowId]
        .activeWorkspaceId
    ).not.toBe(firstResult.workspaceId);

    const secondResult = runtime.resumeExternalAgentSession(
      "antigravity:agy-session"
    );
    const state = runtime.getState();
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activeWorkspace = state.workspaces[activeWorkspaceId];
    const activeSurfaceId =
      state.panes[activeWorkspace.activePaneId].activeSurfaceId;

    expect(secondResult).toEqual(firstResult);
    expect(Object.keys(state.workspaces)).toHaveLength(
      workspaceCountAfterOpen + 1
    );
    expect(activeWorkspaceId).toBe(firstResult.workspaceId);
    expect(activeSurfaceId).toBe(firstResult.surfaceId);
  });

  it("opens a fresh external session when the previous matching surface exited", () => {
    const runtime = createRuntime(false, {
      externalSessionIndexer: {
        listExternalAgentSessions: () => ({
          updatedAt: "2026-04-26T12:00:00.000Z",
          sessions: []
        }),
        resolveExternalAgentSession: (key: string) =>
          key === "claude:claude-session"
            ? {
                key,
                target: { kind: "local" },
                vendor: "claude",
                agentSessionRef: {
                  vendor: "claude",
                  externalKey: key,
                  sessionId: "claude-session"
                },
                title: "Investigate exit",
                cwd: "/tmp/project",
                launch: {
                  cwd: "/tmp/project",
                  initialInput: "claude --resume claude-session\r",
                  title: "Investigate exit"
                }
              }
            : null
      }
    });

    const firstResult = runtime.resumeExternalAgentSession(
      "claude:claude-session"
    );
    const firstState = runtime.getState();
    const firstSurface = firstState.surfaces[firstResult.surfaceId];
    runtime.dispatchAppAction({
      type: "session.exited",
      sessionId: firstSurface.content.sessionId,
      exitCode: 0
    });
    const workspaceCountAfterExit = Object.keys(
      runtime.getState().workspaces
    ).length;

    const secondResult = runtime.resumeExternalAgentSession(
      "claude:claude-session"
    );
    const state = runtime.getState();

    expect(secondResult.surfaceId).not.toBe(firstResult.surfaceId);
    expect(Object.keys(state.workspaces)).toHaveLength(
      workspaceCountAfterExit + 1
    );
    expect(state.surfaces[firstResult.surfaceId]).toBeTruthy();
    expect(
      state.sessions[state.surfaces[firstResult.surfaceId].content.sessionId]
        .runtimeStatus.processState
    ).toBe("exited");
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

  it("starts fresh instead of restoring a clean-shutdown snapshot without restore-on-launch", () => {
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

  it("restores a clean-shutdown snapshot when restore-on-launch is set", () => {
    const snapshot = createInitialState("/bin/zsh");
    const exitedSessionId = Object.keys(snapshot.sessions)[0]!;
    snapshot.sessions[exitedSessionId].runtimeStatus.processState = "exited";
    snapshot.sessions[exitedSessionId].exitCode = 137;

    applyAction(snapshot, {
      type: "workspace.create",
      name: "project"
    });

    const restoredWorkspaceId =
      snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;

    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true,
        restoreOnLaunch: true
      }
    });

    const restored = runtime.restoreInitialState();

    expect(restored.workspaces[restoredWorkspaceId]?.name).toBe("project");
    for (const session of Object.values(restored.sessions)) {
      expect(session.runtimeStatus.processState).toBe("pending");
      expect(session.shellInputReady).toBe(false);
      expect("pid" in session).toBe(false);
      expect("exitCode" in session).toBe(false);
    }
  });

  it("respawns persisted exited surfaces with fresh runtime epochs on the next launch", () => {
    const snapshot = createInitialState("/bin/zsh");
    applyAction(snapshot, {
      type: "workspace.create",
      name: "restored project"
    });
    for (const session of Object.values(snapshot.sessions)) {
      session.runtimeStatus.processState = "exited";
      session.shellInputReady = false;
      session.pid = 42;
      session.exitCode = 1;
    }
    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true,
        restoreOnLaunch: true
      }
    });

    const restored = runtime.restoreInitialState();
    const restoredSessionIds = new Set(
      Object.values(restored.surfaces).map(
        (surface) => surface.content.sessionId
      )
    );
    for (const sessionId of restoredSessionIds) {
      expect(restored.sessions[sessionId]).toMatchObject({
        runtimeStatus: {
          processState: "pending",
          observationState: "unknown",
          attachmentState: "detached"
        },
        shellInputReady: false
      });
      expect(restored.sessions[sessionId]).not.toHaveProperty("pid");
      expect(restored.sessions[sessionId]).not.toHaveProperty("exitCode");
    }

    const ptyHost = { send: vi.fn() };
    runtime.setStore(new AppStore(restored));
    runtime.setPtyHost(ptyHost as never);
    runtime.respawnRestoredSessions();

    const spawnMessages = ptyHost.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "spawn");
    expect(spawnMessages).toHaveLength(restoredSessionIds.size);
    expect(
      new Set(spawnMessages.map((message) => message.spec.sessionId))
    ).toEqual(restoredSessionIds);
    for (const message of spawnMessages) {
      expect(message.spec.runtimeEpoch).toMatch(/^epoch_/);
    }
  });

  it("restores remote liveness as unknown and never replacement-spawns it locally", () => {
    const snapshot = createInitialState("/bin/zsh");
    const existing = new Set(Object.keys(snapshot.workspaces));
    applyAction(snapshot, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app"
    });
    const remoteWorkspaceId = Object.keys(snapshot.workspaces).find(
      (id) => !existing.has(id)
    )!;
    const remotePane =
      snapshot.panes[snapshot.workspaces[remoteWorkspaceId].activePaneId];
    const remoteSessionId =
      snapshot.surfaces[remotePane.activeSurfaceId].content.sessionId;
    snapshot.sessions[remoteSessionId].runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "attached"
    };
    snapshot.sessions[remoteSessionId].shellInputReady = true;
    snapshot.sessions[remoteSessionId].pid = 4242;
    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true,
        restoreOnLaunch: true
      }
    });

    const restored = runtime.restoreInitialState();
    expect(restored.sessions[remoteSessionId]).toMatchObject({
      runtimeStatus: {
        processState: "running",
        observationState: "unknown",
        attachmentState: "detached"
      },
      shellInputReady: false
    });
    expect(restored.sessions[remoteSessionId]).not.toHaveProperty("pid");

    const ptyHost = { send: vi.fn() };
    runtime.setStore(new AppStore(restored));
    runtime.setPtyHost(ptyHost as never);
    runtime.respawnRestoredSessions();

    const spawnedSessionIds = ptyHost.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "spawn")
      .map((message) => message.spec.sessionId);
    expect(spawnedSessionIds).not.toContain(remoteSessionId);
  });

  it("restores window chrome state separately from clean-shutdown workspace snapshots", () => {
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
      },
      windowState: {
        width: 1200,
        height: 900,
        maximized: false,
        sidebarVisible: false,
        sidebarWidth: 360
      }
    });

    const restored = runtime.restoreInitialState();
    const restoredWindow = restored.windows[restored.activeWindowId];

    expect(restored.workspaces[restoredWorkspaceId]).toBeUndefined();
    expect(restoredWindow?.sidebarVisible).toBe(false);
    expect(restoredWindow?.sidebarWidth).toBe(360);
  });

  it("sanitizes restored session runtime state from unclean snapshots", () => {
    const snapshot = createInitialState("/bin/zsh");

    applyAction(snapshot, {
      type: "workspace.create",
      name: "project"
    });

    const activeWorkspaceId =
      snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;
    const activePaneId = snapshot.workspaces[activeWorkspaceId]!.activePaneId;

    applyAction(snapshot, {
      type: "pane.split",
      paneId: activePaneId,
      direction: "right"
    });
    applyAction(snapshot, {
      type: "surface.create",
      paneId: activePaneId,
      title: "logs"
    });

    for (const [index, session] of Object.values(snapshot.sessions).entries()) {
      session.runtimeStatus.processState = "running";
      session.shellInputReady = true;
      session.pid = 10_000 + index;
      session.exitCode = 99;
    }

    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: false
      }
    });

    const restored = runtime.restoreInitialState();

    expect(Object.keys(restored.panes)).toHaveLength(3);
    expect(Object.keys(restored.surfaces)).toHaveLength(4);
    for (const session of Object.values(restored.sessions)) {
      expect(session.runtimeStatus.processState).toBe("pending");
      expect(session.shellInputReady).toBe(false);
      expect("pid" in session).toBe(false);
      expect("exitCode" in session).toBe(false);
    }
  });

  it("replaces restored agent session launches with resume launches before respawn", () => {
    const snapshot = createInitialState("/bin/zsh");
    const sessionId = Object.keys(snapshot.sessions)[0]!;
    snapshot.sessions[sessionId].runtimeStatus.processState = "exited";
    snapshot.sessions[sessionId].exitCode = 137;
    snapshot.sessions[sessionId].agentSessionRef = {
      vendor: "codex",
      externalKey: "codex:codex-session",
      id: "codex-session",
      targetId: "local",
      cwd: snapshot.sessions[sessionId].launch.cwd
    };
    const resolveExternalAgentSession = vi.fn((key: string) =>
      key === "codex:codex-session"
        ? {
            key,
            target: { kind: "local" as const },
            vendor: "codex" as const,
            agentSessionRef: {
              vendor: "codex" as const,
              externalKey: key,
              sessionId: "codex-session"
            },
            title: "Resume Codex",
            cwd: "/tmp/project",
            launch: {
              cwd: "/tmp/project",
              initialInput: "codex resume codex-session\r",
              title: "Resume Codex"
            }
          }
        : null
    );
    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true,
        restoreOnLaunch: true
      },
      externalSessionIndexer: {
        listExternalAgentSessions: () => ({
          updatedAt: "2026-04-26T12:00:00.000Z",
          sessions: []
        }),
        resolveExternalAgentSession
      }
    });
    const restored = runtime.restoreInitialState();
    const ptyHost = { send: vi.fn() };
    runtime.setStore(new AppStore(restored));
    runtime.setPtyHost(ptyHost as never);
    runtime.__test__.snapshotSave.mockClear();

    runtime.respawnRestoredSessions();

    const spawnMessage = ptyHost.send.mock.calls[0]?.[0];
    expect(resolveExternalAgentSession).toHaveBeenCalledWith(
      "codex:codex-session"
    );
    expect(snapshot.sessions[sessionId]).not.toHaveProperty("runtimeEpoch");
    expect(snapshot.sessions[sessionId]).not.toHaveProperty("sequence");
    expect(spawnMessage.spec.runtimeEpoch).toMatch(/^epoch_/);
    expect(spawnMessage.spec.launch).toMatchObject({
      cwd: "/tmp/project",
      initialInput: "codex resume codex-session\r",
      title: "Resume Codex"
    });
    expect(runtime.getState().sessions[sessionId].launch).toMatchObject({
      initialInput: "codex resume codex-session\r"
    });
    expect(runtime.__test__.snapshotSave).toHaveBeenCalledWith(
      runtime.getState(),
      { cleanShutdown: false }
    );
  });

  it("keeps restored agent session launches when resume resolution fails", () => {
    const snapshot = createInitialState("/bin/zsh");
    const sessionId = Object.keys(snapshot.sessions)[0]!;
    snapshot.sessions[sessionId].runtimeStatus.processState = "running";
    snapshot.sessions[sessionId].launch = {
      cwd: localPath("/tmp/original"),
      shell: "/bin/zsh"
    };
    snapshot.sessions[sessionId].agentSessionRef = {
      vendor: "codex",
      externalKey: "codex:missing",
      id: "missing",
      targetId: "local",
      cwd: snapshot.sessions[sessionId].launch.cwd
    };
    const runtime = createRuntime(false, {
      snapshotRecord: {
        snapshot,
        cleanShutdown: true,
        restoreOnLaunch: true
      },
      externalSessionIndexer: {
        listExternalAgentSessions: () => ({
          updatedAt: "2026-04-26T12:00:00.000Z",
          sessions: []
        }),
        resolveExternalAgentSession: () => null
      }
    });
    const restored = runtime.restoreInitialState();
    const ptyHost = { send: vi.fn() };
    runtime.setStore(new AppStore(restored));
    runtime.setPtyHost(ptyHost as never);
    runtime.__test__.snapshotSave.mockClear();

    runtime.respawnRestoredSessions();

    const spawnMessage = ptyHost.send.mock.calls[0]?.[0];
    expect(spawnMessage.spec.launch).toMatchObject({
      cwd: "/tmp/original",
      shell: "/bin/zsh"
    });
    expect(runtime.__test__.snapshotSave).not.toHaveBeenCalled();
  });

  it("clears notifications from the persisted snapshot when clean shutdown restore is disabled", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();
    state.settings.restoreWorkspacesAfterQuit = false;
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
      cleanShutdown: true,
      restoreOnLaunch: false
    });
    expect(savedSnapshot.notifications).toEqual([]);
    expect(savedSurface).toEqual(
      expect.objectContaining({
        unreadCount: 0,
        attention: false
      })
    );
  });

  it("resets workspaces and tabs to a fresh session when clean shutdown restore is disabled", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();
    state.settings.restoreWorkspacesAfterQuit = false;
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

    expect(saveOptions).toEqual({
      cleanShutdown: true,
      restoreOnLaunch: false
    });
    expect(Object.keys(savedSnapshot.workspaces)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.panes)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.surfaces)).toHaveLength(1);
    expect(Object.keys(savedSnapshot.sessions)).toHaveLength(1);
    expect(
      savedSnapshot.windows[savedSnapshot.activeWindowId]?.workspaceOrder
    ).toHaveLength(1);
    expect(savedSnapshot.workspaces[initialWorkspaceId]).toBeUndefined();
  });

  it("preserves the current layout for one restart when remote retention evidence is incomplete", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();
    state.settings.restoreWorkspacesAfterQuit = false;
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app",
      name: "remote"
    });
    const workspaceIds = Object.keys(state.workspaces).sort();

    runtime.shutdown({ preserveWorkspaceLayout: true });

    const [savedSnapshot, saveOptions] =
      runtime.__test__.snapshotSave.mock.lastCall ?? [];
    expect(saveOptions).toEqual({
      cleanShutdown: true,
      restoreOnLaunch: true
    });
    expect(Object.keys(savedSnapshot.workspaces).sort()).toEqual(workspaceIds);
    expect(savedSnapshot.settings.restoreWorkspacesAfterQuit).toBe(false);
  });

  it("saves the current workspace snapshot on clean shutdown when restore is enabled", () => {
    const runtime = createRuntime(false);
    const state = runtime.getState();

    applyAction(state, {
      type: "workspace.create",
      name: "project"
    });

    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    runtime.shutdown();

    const [savedSnapshot, saveOptions] =
      runtime.__test__.snapshotSave.mock.lastCall ?? [];

    expect(saveOptions).toEqual({
      cleanShutdown: true,
      restoreOnLaunch: true
    });
    expect(savedSnapshot.workspaces[activeWorkspaceId]?.name).toBe("project");
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
      expect(getLastShellPatch(window)).not.toHaveProperty(
        "terminalTypography"
      );
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

  it("emits removal tombstones and the current surface inventory", () => {
    const runtime = createRuntime(false);
    const window = createMockWindow();
    browserWindows.push(window);

    try {
      const state = runtime.getState();
      const originalWorkspaceId =
        state.windows[state.activeWindowId].activeWorkspaceId;
      runtime.dispatchAppAction({ type: "workspace.create", name: "hidden" });
      const hiddenWorkspaceId =
        state.windows[state.activeWindowId].activeWorkspaceId;
      const hiddenSurfaceIds = Object.values(state.surfaces)
        .filter(
          (surface) =>
            state.panes[surface.paneId]?.workspaceId === hiddenWorkspaceId
        )
        .map((surface) => surface.id);

      runtime.dispatchAppAction({
        type: "workspace.select",
        workspaceId: originalWorkspaceId
      });
      window.webContents.send.mockClear();

      runtime.dispatchAppAction({
        type: "workspace.close",
        workspaceId: hiddenWorkspaceId
      });

      const remainingSurfaceIds = Object.keys(runtime.getState().surfaces);

      expect(getLastShellPatch(window)).toEqual(
        expect.objectContaining({
          removedSurfaceIds: hiddenSurfaceIds,
          surfaceIds: remainingSurfaceIds,
          workspaceRowsPatch: expect.objectContaining({
            remove: [hiddenWorkspaceId]
          })
        })
      );
      expect(runtime.getShellState().surfaceIds).toEqual(remainingSurfaceIds);
      expect(getLastShellPatch(window)).not.toHaveProperty(
        "workspacePaneTreesPatch"
      );
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
      expect(snapshot.surfaceIds).toEqual(
        Object.keys(runtime.getState().surfaces)
      );
      expect(snapshot).not.toHaveProperty("workspacePaneTrees");
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
      const alertsPaneId =
        runtime.getState().workspaces[alertsWorkspaceId].activePaneId;
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

  it("does not emit redundant patches for repeated agent session-start events", () => {
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
        event: "session_start",
        message: "Started"
      });

      expect(
        runtime.getState().workspaces[workspaceId].statusEntries[
          `agent:claude:${surfaceId}`
        ]
      ).toBeUndefined();

      window.webContents.send.mockClear();
      window.setTitle.mockClear();

      runtime.dispatchAppAction({
        type: "agent.event",
        workspaceId,
        surfaceId,
        agent: "claude",
        event: "session_start",
        message: "Started"
      });

      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(window.setTitle).not.toHaveBeenCalled();
      expect(
        runtime.getState().workspaces[workspaceId].statusEntries[
          `agent:claude:${surfaceId}`
        ]
      ).toBeUndefined();
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
        sessionId: "session_1",
        surfaceId: "surface_1",
        workspaceId: "workspace_1",
        launch: { cwd: localPath("/tmp") },
        initialSize: {
          cols: 120,
          rows: 30
        },
        sessionEnv: {}
      }
    ]);

    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(window.setTitle).not.toHaveBeenCalled();
  });

  it("sends hook runtime env through the shell launch policy before pty spawn", () => {
    const runtime = createRuntime(false);
    const send = vi.fn();
    runtime.setPtyHost({ send } as never);

    runtime.runEffects([
      {
        type: "session.spawn",
        sessionId: "session_1",
        surfaceId: "surface_1",
        workspaceId: "workspace_1",
        launch: {
          cwd: localPath("/tmp"),
          shell: "/bin/zsh"
        },
        initialSize: {
          cols: 120,
          rows: 30
        },
        sessionEnv: {
          KMUX_WORKSPACE_ID: "workspace_1",
          KMUX_SURFACE_ID: "surface_1",
          KMUX_SESSION_ID: "session_1",
          TERM_PROGRAM: "kmux"
        }
      }
    ]);

    expect(send).toHaveBeenCalledWith({
      type: "spawn",
      spec: expect.objectContaining({
        sessionId: "session_1",
        env: expect.not.objectContaining({
          KMUX_SOCKET_PATH: expect.any(String),
          KMUX_NODE_PATH: expect.any(String)
        })
      }),
      shellLaunchPolicy: expect.objectContaining({
        hookEnv: {
          KMUX_SOCKET_PATH: "/tmp/kmux.sock",
          KMUX_AGENT_BIN_DIR: "/tmp/kmux-agent-hooks",
          KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux"
        },
        agentPath: {
          helperBinDir: "/tmp/kmux-agent-hooks",
          wrapperBinDir: "/tmp/kmux-agent-wrappers",
          prependWrapperToPath: true
        }
      })
    });
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
            actionType: "workspace.sidebar.toggle",
            effectTypes: expect.arrayContaining(["persist"]),
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

  it("records shell patch source metadata fields for surface metadata actions", () => {
    const record = vi.fn();
    const runtime = createRuntime(false, {
      profileRecorder: {
        enabled: true,
        record
      }
    });
    const window = createMockWindow();
    browserWindows.push(window);
    const surfaceId = Object.keys(runtime.getState().surfaces)[0];

    try {
      runtime.dispatchAppAction({
        type: "surface.metadata",
        surfaceId,
        title: "active task"
      });

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "main",
          name: "shell.patch.emit",
          details: expect.objectContaining({
            actionType: "surface.metadata",
            actionSurfaceId: surfaceId,
            effectTypes: expect.arrayContaining(["persist"]),
            surfaceMetadataFields: ["title"],
            requestedGroups: ["activeWorkspacePaneTree", "workspaceRows"]
          })
        })
      );
    } finally {
      runtime.shutdown();
    }
  });
});
