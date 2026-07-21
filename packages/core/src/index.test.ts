import {
  BUILTIN_TERMINAL_THEME_PROFILE_ID,
  BUILTIN_TERMINAL_THEME_PROFILES,
  INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE_ID,
  LINUX_DEFAULT_SHORTCUTS
} from "@kmux/ui";
import { uint64 } from "@kmux/proto";

import {
  applyAction,
  applyActionWithSummary,
  buildActiveWorkspacePaneTreeVm,
  buildViewModel,
  cloneState,
  createDefaultSettings,
  createInitialState,
  decodeAppStateDto,
  encodeLocatedPathDto,
  encodeAppStateDto,
  CURRENT_SETTINGS_VERSION,
  DEFAULT_TERMINAL_TEXT_FONT_FAMILY,
  JETBRAINS_MONO_NERD_FONT_MONO_FAMILY,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY,
  listPaneIds,
  locatedPathForTarget,
  MAX_SIDEBAR_WIDTH,
  mergeSettings,
  MIN_SIDEBAR_WIDTH,
  migrateShortcutDefaultsForPlatform,
  resolveSurfaceDiagnosticCaptureEnabled,
  sanitizeSettings
} from "./index";
import type { SettingsPatch } from "./index";

function expectedHomeDirectory(): string {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE;
  return homeDirectory?.trim() || "~";
}

function localPath(value: string) {
  return locatedPathForTarget({ kind: "local" }, value);
}

function rawPath(value: ReturnType<typeof localPath>): string {
  return encodeLocatedPathDto(value).path;
}

describe("core reducer", () => {
  const legacyRendererSettingKey = ["terminalUse", "Web", "gl"].join("");
  const legacyTerminalTextFontFamily =
    'ui-monospace, Menlo, Monaco, Consolas, "SFMono-Regular", monospace';
  const previousBundledTerminalTextFontFamily = `"kmux JetBrainsMono Nerd Font Mono", ${JETBRAINS_MONO_NERD_FONT_MONO_FAMILY}, ${legacyTerminalTextFontFamily}`;

  it("migrates a missing legacy location as local but fails closed on a corrupt SSH location", () => {
    const legacy = encodeAppStateDto(createInitialState());
    const legacyWorkspace = Object.values(
      legacy.workspaces as Record<string, Record<string, unknown>>
    )[0]!;
    delete legacyWorkspace.location;
    expect(
      Object.values(decodeAppStateDto(legacy).workspaces)[0]?.location.target
    ).toEqual({ kind: "local" });

    const remote = createInitialState();
    const existing = new Set(Object.keys(remote.workspaces));
    applyAction(remote, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app"
    });
    const remoteWorkspaceId = Object.keys(remote.workspaces).find(
      (id) => !existing.has(id)
    )!;
    remote.workspaces[remoteWorkspaceId].remoteResourceRevision = uint64(7n);
    const encoded = encodeAppStateDto(remote);
    const encodedWorkspace = (
      encoded.workspaces as Record<string, Record<string, unknown>>
    )[remoteWorkspaceId]!;
    expect(encodedWorkspace.remoteResourceRevision).toBe("7");
    expect(
      decodeAppStateDto(encoded).workspaces[remoteWorkspaceId]
        .remoteResourceRevision
    ).toBe(7n);
    encodedWorkspace.location = {
      target: { kind: "ssh", targetId: "" },
      defaultCwd: "/srv/app"
    };

    expect(() => decodeAppStateDto(encoded)).toThrow(/id must be a non-empty/);
  });

  it("reports sidebar mutations as workspace row and active workspace activity only", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const result = applyActionWithSummary(state, {
      type: "sidebar.setStatus",
      workspaceId,
      text: "Busy"
    });

    expect(result.mutation).toEqual({
      workspaceRows: true,
      activeWorkspaceActivity: true
    });
  });

  it("reports surface metadata mutations as terminal tree-affecting", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const result = applyActionWithSummary(state, {
      type: "surface.metadata",
      surfaceId,
      title: "Codex"
    });

    expect(result.mutation).toMatchObject({
      workspaceRows: true,
      activeWorkspacePaneTree: true
    });
  });

  it("reports shell chrome and settings mutations on their owned slices", () => {
    const state = createInitialState();

    expect(
      applyActionWithSummary(state, { type: "workspace.sidebar.toggle" })
        .mutation
    ).toEqual({ window: true });
    expect(
      applyActionWithSummary(state, {
        type: "settings.update",
        patch: { warnBeforeQuit: false }
      }).mutation
    ).toEqual({ settings: true });
  });

  it("projects remote storage durability status into the active surface VM", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0]!;
    const session =
      state.sessions[state.surfaces[surfaceId]!.content.sessionId]!;
    session.remoteRuntime = {
      keeperGeneration: "keeper_1",
      remoteResourceRevision: uint64(7n),
      storageStatus: {
        state: "backpressured",
        journalAdmitted: uint64(42n),
        journalSynced: uint64(41n),
        emergencyBytes: 4 * 1024 * 1024,
        lastSyncDurationMs: 2000
      }
    };

    expect(
      buildViewModel(state).activeWorkspace.surfaces[surfaceId]
    ).toMatchObject({
      content: {
        storageStatus: {
          state: "backpressured",
          journalAdmitted: "42",
          journalSynced: "41",
          emergencyBytes: 4 * 1024 * 1024,
          lastSyncDurationMs: 2000
        }
      }
    });
  });

  it("creates and selects a new workspace", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "new" });
    const vm = buildViewModel(state);

    expect(vm.workspaceRows).toHaveLength(2);
    expect(vm.activeWorkspace.name).toBe("new");
  });

  it("keeps worktree workspace sidebar identity stable when surfaces change", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "workspace.worktree.convert",
      workspaceId,
      worktree: {
        name: "kmux-20260512-1430",
        path: "/Users/test/.kmux/worktrees/kmux/kmux-20260512-1430",
        repoRoot: "/Users/test/kmux",
        commonGitDir: "/Users/test/kmux/.git",
        baseRef: "main",
        branch: "kmux/kmux-20260512-1430",
        createdByKmux: true
      },
      createSurface: true
    });

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: originalSurfaceId,
      title: "agent changed title",
      cwd: "/tmp/not-the-worktree"
    });

    const row = buildViewModel(state).workspaceRows.find(
      (entry) => entry.workspaceId === workspaceId
    );
    const activeSurfaceId = state.panes[paneId].activeSurfaceId;

    expect(row).toMatchObject({
      name: "kmux-20260512-1430",
      nameLocked: true,
      summary: "worktree · kmux/kmux-20260512-1430",
      cwd: "/Users/test/.kmux/worktrees/kmux/kmux-20260512-1430",
      branch: "kmux/kmux-20260512-1430"
    });
    expect(activeSurfaceId).not.toBe(originalSurfaceId);
    expect(
      rawPath(
        state.sessions[state.surfaces[activeSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe("/Users/test/.kmux/worktrees/kmux/kmux-20260512-1430");
  });

  it("starts new surfaces in the worktree path even when an old repo surface is focused", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;
    const repoPath = "/Users/test/kmux";
    const worktreePath = "/Users/test/.kmux/worktrees/kmux/kmux-20260512-1430";

    state.sessions[
      state.surfaces[originalSurfaceId].content.sessionId
    ].runtimeMetadata.cwd = localPath(repoPath);
    applyAction(state, {
      type: "workspace.worktree.convert",
      workspaceId,
      worktree: {
        name: "kmux-20260512-1430",
        path: worktreePath,
        repoRoot: repoPath,
        commonGitDir: `${repoPath}/.git`,
        baseRef: "main",
        branch: "kmux/kmux-20260512-1430",
        createdByKmux: true
      },
      createSurface: true
    });

    applyAction(state, { type: "surface.focus", surfaceId: originalSurfaceId });
    applyAction(state, { type: "surface.create", paneId, title: "agent" });

    const createdSurfaceId = state.panes[paneId].activeSurfaceId;
    const createdSession =
      state.sessions[state.surfaces[createdSurfaceId].content.sessionId];
    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe(worktreePath);
    expect(rawPath(createdSession.launch.cwd)).toBe(worktreePath);

    applyAction(state, { type: "surface.focus", surfaceId: originalSurfaceId });
    applyAction(state, { type: "pane.split", paneId, direction: "right" });

    const splitPaneId = state.workspaces[workspaceId].activePaneId;
    const splitSurfaceId = state.panes[splitPaneId].activeSurfaceId;
    const splitSession =
      state.sessions[state.surfaces[splitSurfaceId].content.sessionId];
    expect(
      rawPath(
        state.sessions[state.surfaces[splitSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe(worktreePath);
    expect(rawPath(splitSession.launch.cwd)).toBe(worktreePath);
  });

  it("persists the launch-surface marker only for the exact worktree path", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const worktree = {
      name: "kmux-remote",
      path: "/tmp/kmux-remote",
      repoRoot: "/tmp/kmux",
      commonGitDir: "/tmp/kmux/.git",
      baseRef: "main",
      branch: "kmux/remote",
      createdByKmux: true
    };
    applyAction(state, {
      type: "workspace.worktree.convert",
      workspaceId,
      worktree,
      createSurface: false
    });

    applyAction(state, {
      type: "workspace.worktree.launchSurfaceCreated",
      workspaceId,
      path: "/tmp/another-worktree"
    });
    expect(
      state.workspaces[workspaceId].worktree?.launchSurfaceCreated
    ).toBeUndefined();

    applyAction(state, {
      type: "workspace.worktree.launchSurfaceCreated",
      workspaceId,
      path: worktree.path
    });
    applyAction(state, {
      type: "workspace.worktree.convert",
      workspaceId,
      worktree,
      createSurface: false
    });

    expect(
      cloneState(state).workspaces[workspaceId].worktree?.launchSurfaceCreated
    ).toBe(true);

    applyAction(state, {
      type: "workspace.worktree.convert",
      workspaceId,
      worktree: { ...worktree, path: "/tmp/kmux-new" },
      createSurface: false
    });
    expect(
      state.workspaces[workspaceId].worktree?.launchSurfaceCreated
    ).toBeUndefined();
  });

  it("shows inactive linked worktree detection as an attention status", () => {
    const state = createInitialState("/bin/zsh");
    const originalWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    applyAction(state, { type: "workspace.create", name: "other" });
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;

    applyAction(state, {
      type: "workspace.worktree.detected",
      workspaceId: originalWorkspaceId,
      detectedWorktree: {
        path: "/tmp/repo-wt",
        repoRoot: "/tmp/repo",
        commonGitDir: "/tmp/repo/.git",
        baseRef: "feature/wt",
        branch: "feature/wt",
        detectedAt: "2026-05-12T05:30:00.000Z"
      }
    });

    const originalRow = buildViewModel(state).workspaceRows.find(
      (row) => row.workspaceId === originalWorkspaceId
    );
    const activeRow = buildViewModel(state).workspaceRows.find(
      (row) => row.workspaceId === activeWorkspaceId
    );

    expect(originalRow?.detectedWorktree?.path).toBe("/tmp/repo-wt");
    expect(originalRow?.statusEntries[0]).toMatchObject({
      key: "worktree-detected",
      text: "worktree detected",
      variant: "attention"
    });
    expect(activeRow?.statusEntries).toEqual([]);
  });

  it("starts a new workspace in the home directory without an explicit folder", () => {
    const state = createInitialState();
    const originalWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const originalPaneId = state.workspaces[originalWorkspaceId].activePaneId;
    const originalSurfaceId = state.panes[originalPaneId].activeSurfaceId;
    const homeDirectory = expectedHomeDirectory();

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: originalSurfaceId,
      cwd: "/tmp/kmux-moved"
    });

    applyAction(state, { type: "workspace.create", name: "new" });

    const createdWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const createdPaneId = state.workspaces[createdWorkspaceId].activePaneId;
    const createdSurfaceId = state.panes[createdPaneId].activeSurfaceId;

    expect(state.workspaces[createdWorkspaceId].cwdSummary).toBe(homeDirectory);
    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe(homeDirectory);
    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .launch.cwd
      )
    ).toBe(homeDirectory);
  });

  it("starts a workspace launch in the home directory when launch cwd is undefined", () => {
    const state = createInitialState("/bin/zsh");
    const originalWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const originalPaneId = state.workspaces[originalWorkspaceId].activePaneId;
    const originalSurfaceId = state.panes[originalPaneId].activeSurfaceId;
    const homeDirectory = expectedHomeDirectory();

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: originalSurfaceId,
      cwd: "/tmp/kmux-moved"
    });

    applyAction(state, {
      type: "workspace.create",
      name: "Resume Codex session",
      launch: {
        cwd: undefined,
        shell: "codex",
        args: ["resume", "session-123"],
        title: "Resume Codex session"
      }
    });

    const createdWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const createdPaneId = state.workspaces[createdWorkspaceId].activePaneId;
    const createdSurfaceId = state.panes[createdPaneId].activeSurfaceId;
    const createdSession =
      state.sessions[state.surfaces[createdSurfaceId].content.sessionId];

    expect(state.workspaces[createdWorkspaceId].cwdSummary).toBe(homeDirectory);
    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe(homeDirectory);
    expect(rawPath(createdSession.launch.cwd)).toBe(homeDirectory);
    expect(createdSession.launch.shell).toBe("codex");
  });

  it("creates a workspace with an explicit initial session launch", () => {
    const state = createInitialState("/bin/zsh");
    const effects = applyAction(state, {
      type: "workspace.create",
      name: "Resume Codex session",
      cwd: "/Users/test/project",
      launch: {
        cwd: "/Users/test/project",
        shell: "codex",
        args: ["resume", "session-123"],
        title: "Resume Codex session"
      }
    });

    const workspace = Object.values(state.workspaces).find(
      (entry) => entry.name === "Resume Codex session"
    );
    expect(workspace).toBeTruthy();
    const pane = state.panes[workspace!.activePaneId];
    const surface = state.surfaces[pane.activeSurfaceId];
    const session = state.sessions[surface.content.sessionId];

    expect(surface.title).toBe("Resume Codex session");
    expect(session.launch).toMatchObject({
      shell: "codex",
      args: ["resume", "session-123"],
      title: "Resume Codex session"
    });
    expect(rawPath(session.launch.cwd)).toBe("/Users/test/project");
    expect(effects).toContainEqual(
      expect.objectContaining({
        type: "session.spawn",
        sessionId: session.id,
        surfaceId: surface.id,
        workspaceId: workspace!.id,
        launch: expect.objectContaining({
          shell: "codex",
          args: ["resume", "session-123"]
        }),
        initialSize: {
          cols: 120,
          rows: 30
        },
        sessionEnv: expect.objectContaining({
          KMUX_WORKSPACE_ID: workspace!.id,
          KMUX_SURFACE_ID: surface.id,
          KMUX_SESSION_ID: session.id,
          TERM_PROGRAM: "kmux"
        })
      })
    );
  });

  it("uses an explicit launch cwd as the new workspace cwd", () => {
    const state = createInitialState("/bin/zsh");

    applyAction(state, {
      type: "workspace.create",
      name: "Resume Codex session",
      launch: {
        cwd: "/Users/test/project",
        shell: "codex",
        args: ["resume", "session-123"],
        title: "Resume Codex session"
      }
    });

    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const session = state.sessions[state.surfaces[surfaceId].content.sessionId];

    expect(state.workspaces[workspaceId].cwdSummary).toBe(
      "/Users/test/project"
    );
    expect(
      rawPath(
        state.sessions[state.surfaces[surfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe("/Users/test/project");
    expect(rawPath(session.launch.cwd)).toBe("/Users/test/project");
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

  it("inherits the active surface cwd when creating a surface in the same workspace", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: originalSurfaceId,
      cwd: "/tmp/kmux-moved"
    });
    applyAction(state, { type: "surface.create", paneId, title: "runner" });

    const createdSurfaceId = state.panes[paneId].activeSurfaceId;
    const session =
      state.sessions[state.surfaces[createdSurfaceId].content.sessionId];

    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe("/tmp/kmux-moved");
    expect(rawPath(session.launch.cwd)).toBe("/tmp/kmux-moved");
  });

  it("inherits the active surface cwd when splitting within the same workspace", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: originalSurfaceId,
      cwd: "/tmp/kmux-moved"
    });
    applyAction(state, {
      type: "pane.split",
      paneId,
      direction: "right"
    });

    const createdPaneId = state.workspaces[workspaceId].activePaneId;
    const createdSurfaceId = state.panes[createdPaneId].activeSurfaceId;
    const session =
      state.sessions[state.surfaces[createdSurfaceId].content.sessionId];

    expect(
      rawPath(
        state.sessions[state.surfaces[createdSurfaceId].content.sessionId]
          .runtimeMetadata.cwd
      )
    ).toBe("/tmp/kmux-moved");
    expect(rawPath(session.launch.cwd)).toBe("/tmp/kmux-moved");
  });

  it("moves a surface into a right split without recreating its session", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId, title: "runner" });
    const movedSurfaceId = state.panes[paneId].activeSurfaceId;
    const movedSessionId = state.surfaces[movedSurfaceId].content.sessionId;

    const effects = applyAction(state, {
      type: "surface.moveToSplit",
      surfaceId: movedSurfaceId,
      targetPaneId: paneId,
      direction: "right"
    });

    const movedPaneId = state.surfaces[movedSurfaceId].paneId;
    const paneIds = listPaneIds(state.workspaces[workspaceId]);

    expect(effects).toEqual([{ type: "persist" }]);
    expect(effects).not.toContainEqual(
      expect.objectContaining({ type: "session.spawn" })
    );
    expect(effects).not.toContainEqual(
      expect.objectContaining({ type: "session.close" })
    );
    expect(paneIds).toHaveLength(2);
    expect(movedPaneId).not.toBe(paneId);
    expect(state.panes[paneId].surfaceIds).toEqual([originalSurfaceId]);
    expect(state.panes[movedPaneId].surfaceIds).toEqual([movedSurfaceId]);
    expect(state.surfaces[movedSurfaceId].content.sessionId).toBe(
      movedSessionId
    );
    expect(state.sessions[movedSessionId].surfaceId).toBe(movedSurfaceId);
    expect(state.workspaces[workspaceId].activePaneId).toBe(movedPaneId);
  });

  it("collapses the source pane when moving its only surface to another split", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const targetPaneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, {
      type: "pane.split",
      paneId: targetPaneId,
      direction: "right"
    });
    const sourcePaneId = state.workspaces[workspaceId].activePaneId;
    const movedSurfaceId = state.panes[sourcePaneId].activeSurfaceId;
    const movedSessionId = state.surfaces[movedSurfaceId].content.sessionId;

    const effects = applyAction(state, {
      type: "surface.moveToSplit",
      surfaceId: movedSurfaceId,
      targetPaneId,
      direction: "down"
    });

    const movedPaneId = state.surfaces[movedSurfaceId].paneId;
    const paneIds = listPaneIds(state.workspaces[workspaceId]);

    expect(effects).toEqual([{ type: "persist" }]);
    expect(effects).not.toContainEqual(
      expect.objectContaining({ type: "session.spawn" })
    );
    expect(effects).not.toContainEqual(
      expect.objectContaining({ type: "session.close" })
    );
    expect(state.panes[sourcePaneId]).toBeUndefined();
    expect(paneIds).toHaveLength(2);
    expect(paneIds).toContain(targetPaneId);
    expect(paneIds).toContain(movedPaneId);
    expect(movedPaneId).not.toBe(sourcePaneId);
    expect(state.panes[movedPaneId].activeSurfaceId).toBe(movedSurfaceId);
    expect(state.surfaces[movedSurfaceId].content.sessionId).toBe(
      movedSessionId
    );
    expect(state.sessions[movedSessionId].surfaceId).toBe(movedSurfaceId);
    expect(state.workspaces[workspaceId].activePaneId).toBe(movedPaneId);
  });

  it("clears moved surface unread notifications when the split move focuses it", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, { type: "surface.create", paneId, title: "alerts" });
    const movedSurfaceId = state.panes[paneId].activeSurfaceId;
    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId: movedSurfaceId,
      title: "hidden alert",
      message: "move should focus and clear this"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.surfaces[movedSurfaceId].unreadCount).toBe(1);

    applyAction(state, {
      type: "surface.moveToSplit",
      surfaceId: movedSurfaceId,
      targetPaneId: paneId,
      direction: "right"
    });

    expect(state.notifications).toHaveLength(0);
    expect(state.surfaces[movedSurfaceId].unreadCount).toBe(0);
    expect(state.surfaces[movedSurfaceId].attention).toBe(false);
  });

  it("ignores a self split move for a pane with only one surface", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const before = structuredClone(state);

    const effects = applyAction(state, {
      type: "surface.moveToSplit",
      surfaceId,
      targetPaneId: paneId,
      direction: "right"
    });

    expect(effects).toEqual([]);
    expect(state).toEqual(before);
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
    expect(state.notifications).toHaveLength(0);
  });

  it("clears active-surface unread notifications when selecting a workspace", () => {
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
      title: "Need attention",
      message: "workspace row click should clear this"
    });

    expect(state.surfaces[alertsSurfaceId].unreadCount).toBe(1);
    expect(state.notifications).toHaveLength(1);

    applyAction(state, {
      type: "workspace.select",
      workspaceId: alertsWorkspaceId
    });

    expect(state.surfaces[alertsSurfaceId].unreadCount).toBe(0);
    expect(state.surfaces[alertsSurfaceId].attention).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  it("records agent needs-input events as a status entry and notification", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: state.surfaces[surfaceId].content.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?"
    });

    const vm = buildViewModel(state);
    const row = vm.workspaceRows.find(
      (item) => item.workspaceId === workspaceId
    );

    expect(row?.statusEntries).toEqual([
      expect.objectContaining({
        key: `agent:claude:${surfaceId}`,
        label: "Claude",
        text: "needs input",
        variant: "attention",
        surfaceId
      })
    ]);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        workspaceId,
        paneId,
        surfaceId,
        source: "agent",
        title: "Claude needs input",
        message: "Approve tool use?"
      })
    );
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
  });

  it("clears stale generic agent reminders when a structured needs_input event arrives", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Claude",
      message: "Claude Code needs your attention",
      source: "agent",
      agent: "claude"
    });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].kind).toBeUndefined();

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: state.surfaces[surfaceId].content.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        kind: "needs_input",
        agent: "claude",
        surfaceId
      })
    );
  });

  it("clears stale generic agent reminders when the agent transitions to idle", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Claude",
      message: "Claude Code needs your attention",
      source: "agent",
      agent: "claude"
    });
    expect(state.notifications).toHaveLength(1);

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "idle"
    });

    expect(state.notifications).toHaveLength(0);
  });

  it("does not clear generic reminders belonging to a different agent when idle fires", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Antigravity",
      message: "Antigravity needs your attention",
      source: "agent",
      agent: "antigravity"
    });
    expect(state.notifications).toHaveLength(1);

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "idle"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].agent).toBe("antigravity");
  });

  it("clears only the matching agent needs-input entry when the agent becomes idle", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "idle"
    });

    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.notifications).toHaveLength(0);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
  });

  it("clears needs-input attention for the submitted surface only", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "surface.create",
      paneId
    });

    const secondSurfaceId = state.panes[paneId].activeSurfaceId;
    expect(secondSurfaceId).not.toBe(firstSurfaceId);

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId: firstSurfaceId,
      sessionId: state.surfaces[firstSurfaceId].content.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "First prompt"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId: secondSurfaceId,
      sessionId: state.surfaces[secondSurfaceId].content.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Second prompt"
    });
    applyAction(state, {
      type: "agent.attention.clear",
      surfaceId: firstSurfaceId
    });

    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([
      expect.objectContaining({
        key: `agent:codex:${secondSurfaceId}`,
        label: "Codex",
        text: "needs input",
        variant: "attention",
        surfaceId: secondSurfaceId
      })
    ]);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        surfaceId: secondSurfaceId,
        kind: "needs_input",
        agent: "codex"
      })
    );
  });

  it("creates a notification when an agent turn completes", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "turn_complete"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        workspaceId,
        surfaceId,
        source: "agent",
        title: "Claude finished",
        message: "Finished"
      })
    );
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
  });

  it("clears stale agent needs-input notifications when attention is handled", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth"
    });
    applyAction(state, {
      type: "agent.attention.clear",
      surfaceId
    });

    expect(state.notifications).toHaveLength(0);
    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
  });

  it("replaces stale agent needs-input notifications with completion notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "turn_complete",
      message: "Finished"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        workspaceId,
        surfaceId,
        source: "agent",
        title: "Codex finished",
        message: "Finished"
      })
    );
    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
  });

  it("replaces stale completion notifications when the same agent immediately needs input again", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "turn_complete",
      message: "Finished"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Implement this plan?"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        workspaceId,
        surfaceId,
        source: "agent",
        kind: "needs_input",
        title: "Codex needs input",
        message: "Plan mode prompt: Implement this plan?"
      })
    );
    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([
      expect.objectContaining({
        key: `agent:codex:${surfaceId}`,
        text: "needs input",
        variant: "attention"
      })
    ]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
  });

  it("clears stale Antigravity needs-input notifications when attention is handled", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "antigravity",
      event: "needs_input",
      message: "Tool permission requested: WriteFile"
    });
    applyAction(state, {
      type: "agent.attention.clear",
      surfaceId
    });

    expect(state.notifications).toHaveLength(0);
    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
  });

  it("keeps visible agent needs-input state in the sidebar without creating notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?",
      details: {
        visibleToUser: true
      }
    });

    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([
      expect.objectContaining({
        key: `agent:claude:${surfaceId}`,
        text: "needs input",
        variant: "attention"
      })
    ]);
    expect(state.notifications).toHaveLength(0);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
    expect(state.surfaces[surfaceId].attention).toBe(false);
  });

  it("adds a bell effect for hidden agent needs-input when bell sounds are enabled", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    state.settings.notificationSound = true;

    const effects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Implement this plan?"
    });

    expect(effects).toEqual([
      { type: "bell.sound" },
      expect.objectContaining({ type: "notify.desktop" }),
      { type: "persist" }
    ]);
  });

  it("keeps visible agent needs-input silent even when bell sounds are enabled", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    state.settings.notificationSound = true;

    const effects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?",
      details: {
        visibleToUser: true
      }
    });

    expect(effects).toEqual([{ type: "persist" }]);
  });

  it("clears visible agent attention state without creating a completion notification", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?",
      details: {
        visibleToUser: true
      }
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "turn_complete",
      message: "Finished",
      details: {
        visibleToUser: true
      }
    });

    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.notifications).toHaveLength(0);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
    expect(state.surfaces[surfaceId].attention).toBe(false);
  });

  it("does not create a notification when an agent session ends", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "session_end"
    });

    expect(state.notifications).toHaveLength(0);
    expect(buildViewModel(state).workspaceRows[0]?.statusEntries).toEqual([]);
    expect(state.surfaces[surfaceId].unreadCount).toBe(0);
  });

  it("deduplicates overlapping agent completion notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "turn_complete"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "turn_complete"
    });

    expect(state.notifications).toHaveLength(1);
  });

  it("ignores agent session-start events for sidebar state", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    const firstEffects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "session_start",
      message: "Started"
    });

    const secondEffects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "session_start",
      message: "Started"
    });

    expect(firstEffects).toEqual([]);
    expect(secondEffects).toEqual([]);
    expect(state.workspaces[workspaceId].statusEntries).toEqual({});
  });

  it("backfills trusted agent session refs from explicit vendor session events", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const kmuxSessionId = state.surfaces[surfaceId].content.sessionId;

    const effects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      sessionId: "codex-vendor-session",
      agent: "codex",
      event: "session_start"
    });

    expect(effects).toEqual([{ type: "persist" }]);
    expect(state.sessions[kmuxSessionId].agentSessionRef).toEqual({
      vendor: "codex",
      externalKey: "codex:codex-vendor-session",
      id: "codex-vendor-session",
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    });
    expect(state.workspaces[workspaceId].statusEntries).toEqual({});
  });

  it("backfills Antigravity session refs from conversation metadata while preserving routing session ids", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const kmuxSessionId = state.surfaces[surfaceId].content.sessionId;
    const conversationId = "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890";

    const effects = applyAction(state, {
      type: "agent.event",
      workspaceId,
      sessionId: kmuxSessionId,
      agent: "antigravity",
      event: "session_start",
      details: {
        conversationId
      }
    });

    expect(effects).toEqual([{ type: "persist" }]);
    expect(state.sessions[kmuxSessionId].agentSessionRef).toEqual({
      vendor: "antigravity",
      externalKey: `antigravity:${conversationId}`,
      id: conversationId,
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    });
  });

  it("does not backfill agent session refs from surface-id hook fallbacks", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const kmuxSessionId = state.surfaces[surfaceId].content.sessionId;

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      sessionId: surfaceId,
      agent: "codex",
      event: "session_start"
    });

    expect(state.sessions[kmuxSessionId].agentSessionRef).toBeUndefined();
  });

  it("does not overwrite agent session refs from completion or session-end events", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const kmuxSessionId = state.surfaces[surfaceId].content.sessionId;
    state.sessions[kmuxSessionId].agentSessionRef = {
      vendor: "codex",
      externalKey: "codex:trusted-session",
      id: "trusted-session",
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      sessionId: "completion-session",
      agent: "codex",
      event: "turn_complete"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      sessionId: "ended-session",
      agent: "codex",
      event: "session_end"
    });

    expect(state.sessions[kmuxSessionId].agentSessionRef).toEqual({
      vendor: "codex",
      externalKey: "codex:trusted-session",
      id: "trusted-session",
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    });
  });

  it("does not overwrite agent session refs from ui-only needs-input events", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const kmuxSessionId = state.surfaces[surfaceId].content.sessionId;
    state.sessions[kmuxSessionId].agentSessionRef = {
      vendor: "codex",
      externalKey: "codex:trusted-session",
      id: "trusted-session",
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      sessionId: "synthetic-session",
      agent: "codex",
      event: "needs_input",
      details: {
        uiOnly: true
      }
    });

    expect(state.sessions[kmuxSessionId].agentSessionRef).toEqual({
      vendor: "codex",
      externalKey: "codex:trusted-session",
      id: "trusted-session",
      targetId: "local",
      cwd: state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.cwd
    });
  });

  it("uses the resolved surface id for agent status keys", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].content.sessionId;
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?"
    });
    expect(
      state.workspaces[workspaceId].statusEntries[`agent:claude:${surfaceId}`]
    ).toBeDefined();

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "idle"
    });
    expect(state.workspaces[workspaceId].statusEntries).toEqual({});

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Approve tool use?"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      sessionId,
      agent: "claude",
      event: "idle"
    });

    expect(state.workspaces[workspaceId].statusEntries).toEqual({});
  });

  it("bounds sidebar status entries and exposes only visible entries", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const workspace = state.workspaces[workspaceId];

    workspace.statusText = "Manual status";
    workspace.statusEntries = {
      manual: {
        key: "manual",
        text: "Manual status",
        variant: "info",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      alert: {
        key: "alert",
        text: "Needs attention",
        variant: "attention",
        updatedAt: "2020-01-01T00:00:00.000Z"
      }
    };
    for (let index = 0; index < 17; index += 1) {
      workspace.statusEntries[`info:${index}`] = {
        key: `info:${index}`,
        text: `Info ${index}`,
        variant: "info",
        updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
      };
    }

    applyAction(state, {
      type: "sidebar.setStatus",
      workspaceId,
      key: "info:17",
      text: "Info 17"
    });

    expect(Object.keys(workspace.statusEntries)).toHaveLength(16);
    expect(workspace.statusEntries.manual).toBeDefined();
    expect(workspace.statusEntries.alert).toBeDefined();
    expect(workspace.statusEntries["info:0"]).toBeUndefined();

    const view = buildViewModel(state);
    expect(view.activeWorkspace.statusEntries).toHaveLength(3);
    expect(view.workspaceRows[0]?.statusEntries).toHaveLength(3);
    expect(
      view.activeWorkspace.statusEntries.map((entry) => entry.key)
    ).toEqual(["manual", "alert", "info:17"]);
  });

  it("deduplicates overlapping terminal and agent needs-input notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];

    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Claude",
      message: "Needs input",
      source: "terminal"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Needs input"
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({
        source: "agent",
        title: "Claude needs input",
        message: "Needs input"
      })
    );
    expect(state.surfaces[surfaceId].unreadCount).toBe(1);
  });

  it("drops transient agent sidebar status during restore", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const workspaceId = Object.keys(state.workspaces)[0];

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      surfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Needs input"
    });

    const restored = cloneState(state);

    expect(restored.workspaces[workspaceId].statusEntries).toEqual({});
    expect(restored.notifications).toHaveLength(1);
  });

  it("prunes restored sidebar status entries", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const workspace = state.workspaces[workspaceId];

    workspace.statusEntries = {};
    for (let index = 0; index < 20; index += 1) {
      workspace.statusEntries[`status:${index}`] = {
        key: `status:${index}`,
        text: `Status ${index}`,
        variant: "info",
        updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
      };
    }

    const restored = cloneState(state);

    expect(
      Object.keys(restored.workspaces[workspaceId].statusEntries)
    ).toHaveLength(16);
    expect(
      restored.workspaces[workspaceId].statusEntries["status:19"]
    ).toBeDefined();
    expect(
      restored.workspaces[workspaceId].statusEntries["status:0"]
    ).toBeUndefined();
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
      JETBRAINS_MONO_NERD_FONT_MONO_FAMILY
    );
    expect(state.settings.terminalTypography.fontSize).toBe(13);
    expect(state.settings.terminalTypography.lineHeight).toBe(1);
  });

  it("does not include legacy terminal renderer settings in defaults or updates", () => {
    const state = createInitialState();

    expect(
      legacyRendererSettingKey in
        (state.settings as unknown as Record<string, unknown>)
    ).toBe(false);

    applyAction(state, {
      type: "settings.update",
      patch: {
        [legacyRendererSettingKey]: false
      } as unknown as SettingsPatch
    });
    expect(
      legacyRendererSettingKey in
        (state.settings as unknown as Record<string, unknown>)
    ).toBe(false);
  });

  it("defaults quit preferences to enabled and preserves explicit updates", () => {
    const state = createInitialState();

    expect(state.settings.warnBeforeQuit).toBe(true);
    expect(state.settings.restoreWorkspacesAfterQuit).toBe(true);

    applyAction(state, {
      type: "settings.update",
      patch: {
        warnBeforeQuit: false,
        restoreWorkspacesAfterQuit: false
      }
    });

    expect(state.settings.warnBeforeQuit).toBe(false);
    expect(state.settings.restoreWorkspacesAfterQuit).toBe(false);

    applyAction(state, {
      type: "settings.update",
      patch: {
        warnBeforeQuit: undefined,
        restoreWorkspacesAfterQuit: undefined
      }
    });

    expect(state.settings.warnBeforeQuit).toBe(false);
    expect(state.settings.restoreWorkspacesAfterQuit).toBe(false);
  });

  it("defaults bell sounds to enabled for new settings", () => {
    const settings = createDefaultSettings();

    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(settings.notificationSound).toBe(true);
    expect(settings.shortcutDefaultsPlatform).toBe("darwin");
    expect(settings.surfaceDiagnosticCaptureMode).toBe("default");
    expect(settings.diagnosticLoggingEnabled).toBe(false);
  });

  it("stores explicit diagnostic logging preferences", () => {
    const current = createDefaultSettings();

    expect(
      mergeSettings(current, { diagnosticLoggingEnabled: true })
        .diagnosticLoggingEnabled
    ).toBe(true);
    expect(
      mergeSettings(current, { diagnosticLoggingEnabled: false })
        .diagnosticLoggingEnabled
    ).toBe(false);
    expect(
      sanitizeSettings({
        ...current,
        diagnosticLoggingEnabled: "yes"
      } as unknown as ReturnType<typeof createDefaultSettings>)
        .diagnosticLoggingEnabled
    ).toBe(false);
  });

  it("stores explicit surface diagnostic capture preferences", () => {
    const current = createDefaultSettings();

    expect(
      mergeSettings(current, {
        surfaceDiagnosticCaptureMode: "enabled"
      }).surfaceDiagnosticCaptureMode
    ).toBe("enabled");
    expect(
      mergeSettings(current, {
        surfaceDiagnosticCaptureMode: "disabled"
      }).surfaceDiagnosticCaptureMode
    ).toBe("disabled");
  });

  it("sanitizes missing or invalid surface diagnostic capture preferences to default", () => {
    const missing = {
      ...createDefaultSettings()
    } as Partial<ReturnType<typeof createDefaultSettings>>;
    delete missing.surfaceDiagnosticCaptureMode;

    expect(sanitizeSettings(missing).surfaceDiagnosticCaptureMode).toBe(
      "default"
    );
    expect(
      sanitizeSettings({
        ...createDefaultSettings(),
        surfaceDiagnosticCaptureMode: "sometimes"
      } as unknown as ReturnType<typeof createDefaultSettings>)
        .surfaceDiagnosticCaptureMode
    ).toBe("default");
  });

  it("resolves surface diagnostic capture using defaults unless explicitly overridden", () => {
    expect(resolveSurfaceDiagnosticCaptureEnabled("default", true)).toBe(true);
    expect(resolveSurfaceDiagnosticCaptureEnabled("default", false)).toBe(
      false
    );
    expect(resolveSurfaceDiagnosticCaptureEnabled("enabled", false)).toBe(true);
    expect(resolveSurfaceDiagnosticCaptureEnabled("disabled", true)).toBe(
      false
    );
  });

  it("creates Linux default settings with Linux shortcut defaults", () => {
    const settings = createDefaultSettings("kmuxOnly", "/bin/bash", {
      shortcutDefaultsPlatform: "linux"
    });

    expect(settings.shortcutDefaultsPlatform).toBe("linux");
    expect(settings.shortcuts).toEqual(LINUX_DEFAULT_SHORTCUTS);
  });

  it("migrates generated shortcut defaults without overwriting user-edited bindings", () => {
    const settings = createDefaultSettings();
    settings.shortcuts["pane.close"] = "Ctrl+Alt+K";

    const migrated = migrateShortcutDefaultsForPlatform(settings, "linux");

    expect(migrated.shortcutDefaultsPlatform).toBe("linux");
    expect(migrated.shortcuts["workspace.create"]).toBe(
      LINUX_DEFAULT_SHORTCUTS["workspace.create"]
    );
    expect(migrated.shortcuts["pane.close"]).toBe("Ctrl+Alt+K");
  });

  it("migrates pre-versioned bell sound settings to enabled once", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: undefined,
      notificationSound: false
    });

    expect(restored.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(restored.notificationSound).toBe(true);
  });

  it("preserves explicit bell sound updates after the settings migration", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: CURRENT_SETTINGS_VERSION,
      notificationSound: false
    });

    expect(restored.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(restored.notificationSound).toBe(false);
  });

  it("does not rerun the bell sound migration for v2 settings", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: 2,
      notificationSound: false
    });

    expect(restored.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(restored.notificationSound).toBe(false);
  });

  it("migrates the previous default terminal text font to bundled JetBrainsMono Nerd Font Mono", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: 2,
      terminalTypography: {
        ...createDefaultSettings().terminalTypography,
        preferredTextFontFamily: legacyTerminalTextFontFamily
      }
    });

    expect(restored.terminalTypography.preferredTextFontFamily).toBe(
      DEFAULT_TERMINAL_TEXT_FONT_FAMILY
    );
  });

  it("migrates the previous kmux-prefixed bundled font alias out of settings", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: CURRENT_SETTINGS_VERSION,
      terminalTypography: {
        ...createDefaultSettings().terminalTypography,
        preferredTextFontFamily: previousBundledTerminalTextFontFamily
      }
    });

    expect(restored.terminalTypography.preferredTextFontFamily).toBe(
      DEFAULT_TERMINAL_TEXT_FONT_FAMILY
    );
    expect(restored.terminalTypography.preferredTextFontFamily).not.toContain(
      "kmux JetBrainsMono"
    );
  });

  it("resets custom terminal typography once when migrating from v3 settings", () => {
    const defaultTypography = createDefaultSettings().terminalTypography;
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: 3,
      terminalTypography: {
        ...defaultTypography,
        preferredTextFontFamily: '"Fira Code", monospace',
        preferredSymbolFallbackFamilies: ['"Custom Symbols"'],
        fontSize: 17,
        lineHeight: 1.35
      }
    });

    expect(restored.terminalTypography).toEqual({
      ...defaultTypography,
      preferredSymbolFallbackFamilies: ['"Custom Symbols"']
    });
  });

  it("preserves custom terminal typography after the v4 settings migration", () => {
    const defaultTypography = createDefaultSettings().terminalTypography;
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      settingsVersion: 4,
      terminalTypography: {
        ...defaultTypography,
        preferredTextFontFamily: '"Fira Code", monospace',
        preferredSymbolFallbackFamilies: ['"Custom Symbols"'],
        fontSize: 17,
        lineHeight: 1.35
      }
    });

    expect(restored.terminalTypography.preferredTextFontFamily).toBe(
      '"Fira Code", monospace'
    );
    expect(restored.terminalTypography.preferredSymbolFallbackFamilies).toEqual(
      ['"Custom Symbols"']
    );
    expect(restored.terminalTypography.fontSize).toBe(17);
    expect(restored.terminalTypography.lineHeight).toBe(1.35);
  });

  it("normalizes restored shortcut bindings to the matcher modifier order", () => {
    const restored = sanitizeSettings({
      ...createDefaultSettings(),
      shortcuts: {
        ...createDefaultSettings().shortcuts,
        "pane.focus.left": "Alt+Meta+ArrowLeft",
        "pane.resize.left": "Alt+Shift+Meta+ArrowLeft"
      }
    });

    expect(restored.shortcuts["pane.focus.left"]).toBe("Meta+Alt+ArrowLeft");
    expect(restored.shortcuts["pane.resize.left"]).toBe(
      "Meta+Alt+Shift+ArrowLeft"
    );
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
    const legacyState = cloneState(state) as typeof state & {
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

  it("drops legacy terminal renderer settings during restore", () => {
    const state = createInitialState();
    const legacyState = cloneState(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    legacyState.settings[legacyRendererSettingKey] = false;

    const restored = cloneState(legacyState as typeof state);

    expect(
      legacyRendererSettingKey in
        (restored.settings as unknown as Record<string, unknown>)
    ).toBe(false);
  });

  it("migrates missing quit preference settings to the defaults", () => {
    const state = createInitialState();
    const legacyState = cloneState(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    delete (legacyState.settings as { warnBeforeQuit?: boolean })
      .warnBeforeQuit;
    delete (legacyState.settings as { restoreWorkspacesAfterQuit?: boolean })
      .restoreWorkspacesAfterQuit;

    const restored = cloneState(legacyState as typeof state);

    expect(restored.settings.warnBeforeQuit).toBe(true);
    expect(restored.settings.restoreWorkspacesAfterQuit).toBe(true);
  });

  it("drops legacy startup restore settings during state restore", () => {
    const state = createInitialState();
    const legacyState = cloneState(state) as typeof state & {
      settings: Record<string, unknown>;
    };

    legacyState.settings.startupRestore = false;

    const restored = cloneState(legacyState as typeof state);

    expect(
      "startupRestore" in
        (restored.settings as unknown as Record<string, unknown>)
    ).toBe(false);
  });

  it("normalizes legacy empty shell args during restore", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];
    state.sessions[sessionId].launch.args = [];

    const restored = cloneState(state);

    expect(restored.sessions[sessionId].launch.args).toBeUndefined();
    expect(restored.sessions[sessionId].launch.shell).toBe("/bin/zsh");
  });

  it("drops legacy Gemini session refs and agent attention during restore", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = Object.keys(state.workspaces)[0];
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].content.sessionId;
    const legacyState = cloneState(state);

    (
      legacyState.sessions[sessionId] as { agentSessionRef?: unknown }
    ).agentSessionRef = {
      vendor: "gemini",
      externalKey: "gemini:legacy-session",
      sessionId: "legacy-session"
    };
    legacyState.notifications = [
      {
        id: "notification_legacy_gemini",
        workspaceId,
        surfaceId,
        title: "Gemini needs input",
        message: "Legacy notification",
        source: "agent",
        kind: "needs_input",
        agent: "gemini",
        createdAt: "2026-05-01T00:00:00.000Z"
      }
    ];
    legacyState.workspaces[workspaceId].statusEntries = {
      [`agent:gemini:${surfaceId}`]: {
        key: `agent:gemini:${surfaceId}`,
        text: "needs input",
        variant: "attention",
        updatedAt: "2026-05-01T00:00:00.000Z",
        surfaceId
      }
    };

    const restored = cloneState(legacyState);

    expect(restored.sessions[sessionId].agentSessionRef).toBeUndefined();
    expect(restored.notifications).toEqual([]);
    expect(restored.workspaces[workspaceId].statusEntries).toEqual({});
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
    const legacyState = cloneState(state) as typeof state & {
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

  it("restarts a surface by replacing only its session", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const oldSessionId = state.surfaces[surfaceId].content.sessionId;
    state.sessions[oldSessionId].runtimeMetadata = {
      cwd: localPath("/tmp/last-known"),
      branch: "feature/restart",
      ports: [3000]
    };

    applyAction(state, {
      type: "session.started",
      sessionId: oldSessionId,
      pid: 1234,
      shellInputReady: true
    });

    const effects = applyAction(state, {
      type: "surface.restartSession",
      surfaceId
    });
    const nextSessionId = state.surfaces[surfaceId].content.sessionId;

    expect(nextSessionId).not.toBe(oldSessionId);
    expect(state.surfaces[surfaceId]).toMatchObject({
      id: surfaceId,
      paneId,
      title: "new workspace"
    });
    expect(state.panes[paneId].activeSurfaceId).toBe(surfaceId);
    expect(state.sessions[oldSessionId]).toBeUndefined();
    expect(state.sessions[nextSessionId]).toMatchObject({
      id: nextSessionId,
      surfaceId,
      runtimeStatus: {
        processState: "pending",
        observationState: "unknown",
        attachmentState: "detached"
      },
      shellInputReady: false,
      runtimeMetadata: {
        branch: "feature/restart",
        ports: [3000]
      }
    });
    expect(rawPath(state.sessions[nextSessionId].runtimeMetadata.cwd)).toBe(
      "/tmp/last-known"
    );
    expect(effects).toEqual([
      { type: "session.close", sessionId: oldSessionId },
      expect.objectContaining({
        type: "session.spawn",
        sessionId: nextSessionId,
        surfaceId,
        workspaceId
      }),
      { type: "persist" }
    ]);

    applyAction(state, {
      type: "session.exited",
      sessionId: oldSessionId,
      exitCode: 0
    });
    expect(state.sessions[nextSessionId].runtimeStatus.processState).toBe(
      "pending"
    );
  });

  it("does not restart pending sessions", () => {
    const state = createInitialState("/bin/zsh");
    const paneId = Object.keys(state.panes)[0];
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const sessionId = state.surfaces[surfaceId].content.sessionId;

    const effects = applyAction(state, {
      type: "surface.restartSession",
      surfaceId
    });

    expect(effects).toEqual([]);
    expect(state.surfaces[surfaceId].content.sessionId).toBe(sessionId);
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

  it("purges agent attention when closing a surface", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });
    const secondSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId: firstSurfaceId,
      agent: "claude",
      event: "needs_input",
      message: "First"
    });
    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId: secondSurfaceId,
      agent: "claude",
      event: "needs_input",
      message: "Second"
    });

    applyAction(state, { type: "surface.close", surfaceId: firstSurfaceId });

    expect(state.surfaces[firstSurfaceId]).toBeUndefined();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toEqual(
      expect.objectContaining({ surfaceId: secondSurfaceId })
    );
    expect(
      state.workspaces[workspaceId].statusEntries[
        `agent:claude:${firstSurfaceId}`
      ]
    ).toBeUndefined();
    expect(
      state.workspaces[workspaceId].statusEntries[
        `agent:claude:${secondSurfaceId}`
      ]
    ).toBeDefined();
  });

  it("purges agent attention when closing other surfaces", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const paneId = Object.keys(state.panes)[0];
    const keptSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });
    const closedSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId: closedSurfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Closed"
    });

    applyAction(state, {
      type: "surface.closeOthers",
      surfaceId: keptSurfaceId
    });

    expect(state.panes[paneId].surfaceIds).toEqual([keptSurfaceId]);
    expect(state.notifications).toHaveLength(0);
    expect(state.workspaces[workspaceId].statusEntries).toEqual({});
  });

  it("purges agent attention when closing a pane", () => {
    const state = createInitialState();
    const workspaceId = Object.keys(state.workspaces)[0];
    const originalPaneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, {
      type: "pane.split",
      paneId: originalPaneId,
      direction: "right"
    });
    const closingPaneId = state.workspaces[workspaceId].activePaneId;
    const closingSurfaceId = state.panes[closingPaneId].activeSurfaceId;

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId: closingPaneId,
      surfaceId: closingSurfaceId,
      agent: "codex",
      event: "needs_input",
      message: "Closed pane"
    });

    applyAction(state, { type: "pane.close", paneId: closingPaneId });

    expect(state.panes[closingPaneId]).toBeUndefined();
    expect(state.surfaces[closingSurfaceId]).toBeUndefined();
    expect(state.notifications).toHaveLength(0);
    expect(state.workspaces[workspaceId].statusEntries).toEqual({});
  });

  it("purges agent attention when closing a workspace", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "stale" });

    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      agent: "antigravity",
      event: "needs_input",
      message: "Closed workspace"
    });

    applyAction(state, { type: "workspace.close", workspaceId });

    expect(state.workspaces[workspaceId]).toBeUndefined();
    expect(state.notifications).toHaveLength(0);
    expect(
      Object.values(state.workspaces).some(
        (workspace) => Object.keys(workspace.statusEntries).length > 0
      )
    ).toBe(false);
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
          cwd: localPath("/tmp/kmux")
        })
      ])
    );

    const duplicateCwdEffects = applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      cwd: "/tmp/kmux"
    });
    expect(
      duplicateCwdEffects.some((effect) => effect.type === "metadata.refresh")
    ).toBe(false);

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
    const metadata =
      state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata;
    expect(metadata.branch).toBe("main");
    expect(metadata.ports).toEqual([3000, 3001]);
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

    expect(
      state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.branch
    ).toBe("main");
    expect(
      buildViewModel(state).workspaceRows.find(
        (row) => row.workspaceId === workspaceId
      )?.branch
    ).toBe("main");

    applyAction(state, {
      type: "surface.metadata",
      surfaceId,
      branch: null
    });

    expect(
      state.sessions[state.surfaces[surfaceId].content.sessionId]
        .runtimeMetadata.branch
    ).toBeUndefined();
    expect(
      buildViewModel(state).workspaceRows.find(
        (row) => row.workspaceId === workspaceId
      )?.branch
    ).toBeUndefined();
  });

  it("keeps the workspace name independent while deriving representative metadata and aggregated ports", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const representativeSurfaceId = state.panes[paneId].activeSurfaceId;
    const workspaceName = state.workspaces[workspaceId].name;

    applyAction(state, { type: "surface.create", paneId });
    const backgroundSurfaceId = state.panes[paneId].activeSurfaceId;
    applyAction(state, {
      type: "surface.focus",
      surfaceId: representativeSurfaceId
    });

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: representativeSurfaceId,
      title: "repo / shell",
      cwd: "/repo/front",
      branch: "main",
      ports: [3000, 3001]
    });
    applyAction(state, {
      type: "surface.metadata",
      surfaceId: backgroundSurfaceId,
      title: "background / logs",
      cwd: "/repo/background",
      branch: "feature/background",
      ports: [5173, 3000, 8080]
    });

    const vm = buildViewModel(state);
    const row = vm.workspaceRows.find(
      (workspaceRow) => workspaceRow.workspaceId === workspaceId
    );

    expect(vm.activeWorkspace.name).toBe(workspaceName);
    expect(vm.title).toBe(`${workspaceName} cli/unix socket`);
    expect(row).toEqual(
      expect.objectContaining({
        name: workspaceName,
        summary: "repo / shell",
        cwd: "/repo/front",
        branch: "main",
        ports: [3000, 3001, 5173]
      })
    );
  });

  it("derives workspace row metadata from the active surface of the active pane before falling back to tree order", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });
    const secondSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, {
      type: "surface.metadata",
      surfaceId: firstSurfaceId,
      title: "repo / shell",
      cwd: "/repo/front",
      branch: "main"
    });
    applyAction(state, {
      type: "surface.metadata",
      surfaceId: secondSurfaceId,
      title: "agent / review",
      cwd: "/repo/review",
      branch: "feature/review"
    });

    let row = buildViewModel(state).workspaceRows.find(
      (workspaceRow) => workspaceRow.workspaceId === workspaceId
    );

    expect(row).toEqual(
      expect.objectContaining({
        summary: "agent / review",
        cwd: "/repo/review",
        branch: "feature/review"
      })
    );

    applyAction(state, {
      type: "surface.focus",
      surfaceId: firstSurfaceId
    });

    row = buildViewModel(state).workspaceRows.find(
      (workspaceRow) => workspaceRow.workspaceId === workspaceId
    );

    expect(row).toEqual(
      expect.objectContaining({
        summary: "repo / shell",
        cwd: "/repo/front",
        branch: "main"
      })
    );
  });

  it("refreshes derived metadata when a session starts running", () => {
    const state = createInitialState();
    const sessionId = Object.keys(state.sessions)[0];
    const surfaceId = state.sessions[sessionId].surfaceId;

    const effects = applyAction(state, {
      type: "session.started",
      sessionId,
      pid: 4242,
      shellInputReady: true
    });

    expect(state.sessions[sessionId].runtimeStatus.processState).toBe(
      "running"
    );
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

  it("keeps shell input readiness separate from runtime state", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];
    const surfaceId = state.sessions[sessionId].surfaceId;

    applyAction(state, {
      type: "session.started",
      sessionId,
      pid: 1234,
      shellInputReady: false
    });

    expect(state.sessions[sessionId].runtimeStatus.processState).toBe(
      "running"
    );
    expect(state.sessions[sessionId].shellInputReady).toBe(false);

    let paneTree = buildActiveWorkspacePaneTreeVm(state);
    expect(paneTree.surfaces[surfaceId].content.runtimeStatus).toBe("running");
    expect(paneTree.surfaces[surfaceId].content.shellInputReady).toBe(false);

    applyAction(state, {
      type: "session.shellReady",
      sessionId
    });

    expect(state.sessions[sessionId].shellInputReady).toBe(true);
    paneTree = buildActiveWorkspacePaneTreeVm(state);
    expect(paneTree.surfaces[surfaceId].content.shellInputReady).toBe(true);
  });

  it("marks custom or unsupported launches input-ready on session start", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];
    const surfaceId = state.sessions[sessionId].surfaceId;

    applyAction(state, {
      type: "session.started",
      sessionId,
      pid: 1234,
      shellInputReady: true
    });

    expect(state.sessions[sessionId].shellInputReady).toBe(true);
    expect(
      buildActiveWorkspacePaneTreeVm(state).surfaces[surfaceId].content
        .shellInputReady
    ).toBe(true);
  });

  it("resets restored running sessions to not shell-input-ready", () => {
    const state = createInitialState("/bin/zsh");
    const sessionId = Object.keys(state.sessions)[0];
    const surfaceId = state.sessions[sessionId].surfaceId;
    const snapshot = cloneState(state);
    snapshot.sessions[sessionId].runtimeStatus.processState = "running";
    snapshot.sessions[sessionId].shellInputReady = true;
    snapshot.sessions[sessionId].pid = 4242;

    applyAction(state, {
      type: "state.restore",
      snapshot
    });

    expect(state.sessions[sessionId].runtimeStatus.processState).toBe(
      "running"
    );
    expect(state.sessions[sessionId].shellInputReady).toBe(false);
    expect(
      buildActiveWorkspacePaneTreeVm(state).surfaces[surfaceId].content
        .shellInputReady
    ).toBe(false);
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
    expect(state.notifications).toHaveLength(0);
  });

  it("clears stale unread notifications when the target surface is missing", () => {
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
      title: "stale alert",
      message: "jump target disappeared"
    });

    delete state.surfaces[alertsSurfaceId];

    const effects = applyAction(state, {
      type: "notification.jumpLatestUnread"
    });

    expect(effects).toEqual([{ type: "persist" }]);
    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(
      alertsWorkspaceId
    );
    expect(state.notifications).toHaveLength(0);
  });

  it("drops legacy read notifications during restore", () => {
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
      message: "read entry"
    });
    applyAction(state, {
      type: "notification.create",
      workspaceId,
      paneId,
      surfaceId,
      title: "Second",
      message: "unread entry"
    });

    (
      state.notifications[1] as (typeof state.notifications)[number] & {
        read?: boolean;
      }
    ).read = true;

    const restored = cloneState(state);

    expect(restored.notifications).toHaveLength(1);
    expect(restored.notifications[0]).toEqual(
      expect.objectContaining({
        title: "Second",
        message: "unread entry"
      })
    );
    expect("read" in restored.notifications[0]!).toBe(false);
    expect(restored.surfaces[surfaceId]?.unreadCount).toBe(1);
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
      "new workspace",
      "beta",
      "alpha",
      "gamma"
    ]);

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: gammaId! });
    expect(buildViewModel(state).workspaceRows.map((row) => row.name)).toEqual([
      "new workspace",
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

    const defaultWorkspaceId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "new workspace"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;
    const alphaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;

    expect(defaultWorkspaceId).toBeTruthy();
    expect(gammaId).toBeTruthy();
    expect(alphaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: gammaId! });
    applyAction(state, {
      type: "workspace.select",
      workspaceId: defaultWorkspaceId!
    });
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
      "new workspace",
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
      "new workspace",
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
      "new workspace",
      "alpha",
      "gamma"
    ]);
  });
});

describe("remote event product receipt", () => {
  it("applies a product action and its sequence receipt atomically and once", () => {
    const state = createInitialState();
    const window = state.windows[state.activeWindowId];
    const workspace = state.workspaces[window.activeWorkspaceId];
    const pane = state.panes[workspace.activePaneId];
    const surface = state.surfaces[pane.activeSurfaceId];
    const action = {
      type: "remote.event.apply" as const,
      targetId: "target_1",
      sequence: uint64(1n),
      eventId: "event_1",
      productAction: {
        type: "notification.create" as const,
        workspaceId: workspace.id,
        paneId: pane.id,
        surfaceId: surface.id,
        title: "Done",
        message: "Ready",
        source: "agent" as const
      }
    };

    expect(applyAction(state, action).map((effect) => effect.type)).toEqual([
      "notify.desktop",
      "persist"
    ]);
    expect(state.notifications).toHaveLength(1);
    expect(state.remoteEventReceipts.target_1).toEqual({
      throughSequence: 1n,
      recentEventIds: ["event_1"]
    });

    expect(applyAction(state, action)).toEqual([]);
    expect(state.notifications).toHaveLength(1);
    const restored = cloneState(state);
    expect(applyAction(restored, action)).toEqual([]);
    expect(restored.notifications).toHaveLength(1);
  });

  it("records intentionally discarded stale and duplicate-ID events without reapplying them", () => {
    const state = createInitialState();
    applyAction(state, {
      type: "remote.event.apply",
      targetId: "target_1",
      sequence: uint64(1n),
      eventId: "event_1"
    });
    expect(state.remoteEventReceipts.target_1?.throughSequence).toBe(1n);
    expect(
      applyAction(state, {
        type: "remote.event.apply",
        targetId: "target_1",
        sequence: uint64(2n),
        eventId: "event_1",
        productAction: {
          type: "notification.create",
          workspaceId: Object.keys(state.workspaces)[0]!,
          title: "duplicate",
          message: "must not apply"
        }
      })
    ).toEqual([{ type: "persist" }]);
    expect(state.remoteEventReceipts.target_1?.throughSequence).toBe(2n);
    expect(state.notifications).toHaveLength(0);
  });
});
