import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAction,
  createInitialState,
  decodeLocalPath,
  encodeLocatedPathDto,
  locatedPathForTarget,
  type LocalPath,
  type RemoteOperationProjection
} from "@kmux/core";
import { uint64, type WorkspaceWorktreeMetadata } from "@kmux/proto";

import {
  createWorktreeRuntime as createWorktreeRuntimeImpl,
  validateWorktreeName
} from "./worktreeRuntime";
import type {
  LocatedTargetServiceSet,
  TargetServiceRegistry,
  TargetServiceSet
} from "./targets/contracts";
import {
  createLocalFileProvider,
  createLocalGitProvider
} from "./targets/localTargetProviders";
import {
  createLocalPathResolver,
  createTargetServiceRegistry
} from "./targets/targetServiceRegistry";

const GIT_WORKTREE_TEST_TIMEOUT_MS = 15_000;

function localPath(value: string) {
  return locatedPathForTarget({ kind: "local" }, value);
}

function rawPath(value: ReturnType<typeof localPath>): string {
  return encodeLocatedPathDto(value).path;
}

type WorktreeRuntimeOptions = Parameters<typeof createWorktreeRuntimeImpl>[0];
type TestWorktreeRuntimeOptions = Omit<
  WorktreeRuntimeOptions,
  "targetServices"
> & {
  homeDir: string;
  managedRoot?: string;
  env?: NodeJS.ProcessEnv;
};

function createWorktreeRuntime(options: TestWorktreeRuntimeOptions) {
  const resolveLocalPath = createLocalPathResolver();
  const local: TargetServiceSet<LocalPath> = {
    terminal: {
      create: vi.fn(async (request) => {
        const cwd = resolveLocalPath({
          kind: "local",
          path: request.launch.cwd
        });
        options.dispatchAppAction({
          type: "surface.create",
          paneId: request.paneId,
          cwd,
          launch: { ...request.launch, cwd }
        });
      }),
      terminate: vi.fn(),
      sendText: vi.fn(),
      sendKey: vi.fn()
    },
    git: createLocalGitProvider({
      resolveLocalPath,
      managedRoot:
        options.managedRoot ?? join(options.homeDir, ".kmux", "worktrees"),
      env: options.env
    }),
    files: createLocalFileProvider({
      resolveLocalPath,
      homeDir: options.homeDir
    }),
    metadata: { refresh: vi.fn() },
    history: { refresh: vi.fn() },
    usage: {
      refresh: vi.fn(async () => ({ records: [], truncated: false }))
    },
    ports: {
      list: vi.fn(async () => []),
      remapBrowserUrl: vi.fn(async ({ url }) => ({ url })),
      closeWorkspace: vi.fn()
    },
    attachments: {
      store: vi.fn(async () => ({
        path: decodeLocalPath("/tmp/test-attachment"),
        terminalReference: "/tmp/test-attachment"
      }))
    }
  };
  return createWorktreeRuntimeImpl({
    getState: options.getState,
    dispatchAppAction: options.dispatchAppAction,
    ...(options.now === undefined ? {} : { now: options.now }),
    targetServices: createTargetServiceRegistry({
      local,
      remote: () => undefined
    })
  });
}

function createCommittedRepo(rootDir: string, repoName = "repo"): string {
  const repoDir = join(rootDir, repoName);
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], {
    cwd: repoDir,
    stdio: "ignore"
  });
  writeFileSync(join(repoDir, "README.md"), "kmux\n", "utf8");
  execFileSync("git", ["add", "README.md"], {
    cwd: repoDir,
    stdio: "ignore"
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=kmux",
      "-c",
      "user.email=kmux@example.invalid",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: repoDir, stdio: "ignore" }
  );
  return repoDir;
}

function createStateAtCwd(cwd: string) {
  const state = createInitialState("/bin/zsh");
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const paneId = state.workspaces[workspaceId].activePaneId;
  const surfaceId = state.panes[paneId].activeSurfaceId;
  state.surfaces[surfaceId].cwd = localPath(cwd);
  return { state, workspaceId, paneId };
}

function createRemoteReconciliationHarness(options?: {
  existingLaunchSurface?: boolean;
  existingLaunchPending?: boolean;
  failedCreates?: number;
  pendingCreates?: number;
  silentCreates?: number;
}) {
  const state = createInitialState("/bin/zsh");
  const existingWorkspaceIds = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app",
    name: "remote"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !existingWorkspaceIds.has(id)
  )!;
  const paneId = state.workspaces[workspaceId].activePaneId;
  const worktree: WorkspaceWorktreeMetadata = {
    name: "app-remote",
    path: "/srv/worktrees/app-remote",
    repoRoot: "/srv/app",
    commonGitDir: "/srv/app/.git",
    baseRef: "main",
    branch: "kmux/app-remote",
    createdByKmux: true
  };
  const findProjectedSession = () =>
    Object.values(state.sessions).find(
      (session) =>
        encodeLocatedPathDto(session.launch.cwd).path === worktree.path
    );
  const markProjectedLaunchRunning = () => {
    const session = findProjectedSession();
    if (!session) throw new Error("projected launch session is missing");
    session.runtimeStatus.processState = "running";
    session.remoteRuntime = {
      keeperGeneration: "keeper_generation_1",
      remoteResourceRevision: uint64(1n)
    };
  };
  if (options?.existingLaunchSurface) {
    applyAction(state, {
      type: "surface.create",
      paneId,
      cwd: worktree.path,
      launch: { cwd: worktree.path, title: worktree.name }
    });
    if (!options.existingLaunchPending) markProjectedLaunchRunning();
  }
  applyAction(state, {
    type: "workspace.worktree.convert",
    workspaceId,
    worktree,
    createSurface: false
  });
  const projection: RemoteOperationProjection = {
    operationId: "operation_worktree_create",
    kind: "worktree.create",
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId
    },
    expectedWorkspaceRevision: "workspace_revision_before_create",
    expectedRemoteResourceRevision: uint64(0n),
    nextRemoteResourceRevision: uint64(1n),
    canonicalPayloadHash: "1".repeat(64),
    pendingProduct: {
      kind: "worktree.create",
      workspaceId,
      cwd: worktree.repoRoot,
      path: worktree.path,
      baseRef: worktree.baseRef,
      branch: worktree.branch,
      product: { kind: "worktree.create", worktree }
    },
    state: "succeeded",
    createdAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:01.000Z",
    resultDigest: "2".repeat(64)
  };
  state.remoteOperations[projection.operationId] = projection;

  let failedCreates = options?.failedCreates ?? 0;
  let pendingCreates = options?.pendingCreates ?? 0;
  let silentCreates = options?.silentCreates ?? 0;
  const terminalCreate = vi.fn(
    async (
      request: Parameters<LocatedTargetServiceSet["terminal"]["create"]>[0]
    ) => {
      if (failedCreates > 0) {
        failedCreates -= 1;
        throw new Error("remote terminal unavailable");
      }
      if (silentCreates > 0) {
        silentCreates -= 1;
        return;
      }
      const cwd = encodeLocatedPathDto(request.launch.cwd).path;
      applyAction(state, {
        type: "surface.create",
        paneId: request.paneId,
        cwd,
        launch: { cwd, title: request.launch.title }
      });
      if (pendingCreates > 0) {
        pendingCreates -= 1;
      } else {
        markProjectedLaunchRunning();
      }
    }
  );
  const locatedServices = {
    terminal: {
      create: terminalCreate,
      terminate: vi.fn(),
      sendText: vi.fn(),
      sendKey: vi.fn()
    }
  } as unknown as LocatedTargetServiceSet;
  const targetServices: TargetServiceRegistry = {
    resolve() {
      throw new Error("raw target services are not used by this harness");
    },
    resolveLocated(target) {
      if (target.kind !== "ssh" || target.targetId !== "target_1") {
        throw new Error("unexpected reconciliation target");
      }
      return locatedServices;
    }
  };
  const reportError = vi.fn();
  const runtime = createWorktreeRuntimeImpl({
    getState: () => state,
    dispatchAppAction: (action) => applyAction(state, action),
    targetServices,
    reportError
  });
  return {
    state,
    workspaceId,
    worktree,
    runtime,
    terminalCreate,
    reportError,
    markProjectedLaunchRunning
  };
}

describe("worktree runtime", () => {
  it("validates git branch-safe worktree names", () => {
    expect(validateWorktreeName("kmux-20260512-1430")).toBeNull();
    expect(validateWorktreeName("bad name")).toBeTruthy();
    expect(validateWorktreeName("../bad")).toBeTruthy();
    expect(validateWorktreeName("bad.lock")).toBeTruthy();
  });

  it(
    "prepares the default name and skips path and branch collisions",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-preview-"));
      const repoDir = createCommittedRepo(rootDir);
      const managedRoot = join(rootDir, "managed");
      const { state, workspaceId } = createStateAtCwd(repoDir);

      mkdirSync(join(managedRoot, "repo", "repo-20260512-1430"), {
        recursive: true
      });
      execFileSync("git", ["branch", "kmux/repo-20260512-1430-2"], {
        cwd: repoDir,
        stdio: "ignore"
      });

      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir,
        managedRoot,
        now: () => new Date(2026, 4, 12, 14, 30)
      });

      try {
        const preview = await runtime.prepareConversion(workspaceId);

        expect(preview).toMatchObject({
          name: "repo-20260512-1430-3",
          from: "main",
          branch: "kmux/repo-20260512-1430-3",
          path: join(managedRoot, "repo", "repo-20260512-1430-3")
        });
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );

  it(
    "sanitizes repository basenames before building default names",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-preview-"));
      const repoDir = createCommittedRepo(rootDir, "My Repo!");
      const managedRoot = join(rootDir, "managed");
      const { state, workspaceId } = createStateAtCwd(repoDir);
      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir,
        managedRoot,
        now: () => new Date(2026, 4, 12, 14, 30)
      });

      try {
        const preview = await runtime.prepareConversion(workspaceId);

        expect(preview).toMatchObject({
          name: "My-Repo-20260512-1430",
          branch: "kmux/My-Repo-20260512-1430",
          path: join(managedRoot, "My Repo!", "My-Repo-20260512-1430")
        });
        expect(validateWorktreeName(preview?.name ?? "")).toBeNull();
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );

  it(
    "creates a git worktree before converting workspace state",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-create-"));
      const repoDir = createCommittedRepo(rootDir);
      const managedRoot = join(rootDir, "managed");
      const { state, workspaceId, paneId } = createStateAtCwd(repoDir);
      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir,
        managedRoot
      });

      try {
        const worktree = await runtime.createWorkspace(
          workspaceId,
          "repo-20260512-1430"
        );
        const activeSurfaceId = state.panes[paneId].activeSurfaceId;

        expect(worktree.path).toBe(
          join(managedRoot, "repo", "repo-20260512-1430")
        );
        expect(existsSync(join(worktree.path, ".git"))).toBe(true);
        const storedWorktree = state.workspaces[workspaceId].worktree!;
        expect(storedWorktree).toMatchObject({
          name: worktree.name,
          baseRef: worktree.baseRef,
          branch: worktree.branch,
          createdByKmux: true,
          launchSurfaceCreated: true
        });
        expect(rawPath(storedWorktree.path)).toBe(worktree.path);
        expect(rawPath(storedWorktree.repoRoot)).toBe(worktree.repoRoot);
        expect(rawPath(storedWorktree.commonGitDir)).toBe(
          worktree.commonGitDir
        );
        expect(rawPath(state.surfaces[activeSurfaceId].cwd)).toBe(
          worktree.path
        );
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: worktree.path,
            encoding: "utf8"
          }).trim()
        ).toBe("kmux/repo-20260512-1430");
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );

  it("projects one launch surface for a succeeded remote worktree", async () => {
    const harness = createRemoteReconciliationHarness();

    await Promise.all([
      harness.runtime.reconcileManagedSurfaces(),
      harness.runtime.reconcileManagedSurfaces()
    ]);
    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(1);
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBe(true);
    const projectedLaunches = Object.values(harness.state.sessions).filter(
      (session) =>
        encodeLocatedPathDto(session.launch.cwd).path === harness.worktree.path
    );
    expect(projectedLaunches).toHaveLength(1);
  });

  it("recovers the launch marker from an already projected remote session", async () => {
    const harness = createRemoteReconciliationHarness({
      existingLaunchSurface: true
    });

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).not.toHaveBeenCalled();
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBe(true);
  });

  it("leaves remote launch projection retryable after a terminal failure", async () => {
    const harness = createRemoteReconciliationHarness({ failedCreates: 1 });

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(1);
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "remote terminal unavailable" })
    );
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBeUndefined();

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(2);
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBe(true);
  });

  it("waits for an authoritative remote session before marking its launch surface", async () => {
    const harness = createRemoteReconciliationHarness({ pendingCreates: 1 });

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(1);
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBeUndefined();

    harness.markProjectedLaunchRunning();
    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(1);
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBe(true);
  });

  it("reports a missing launch projection without making it durable", async () => {
    const harness = createRemoteReconciliationHarness({ silentCreates: 1 });

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(1);
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "managed worktree launch surface was not projected"
      })
    );
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBeUndefined();

    await harness.runtime.reconcileManagedSurfaces();

    expect(harness.terminalCreate).toHaveBeenCalledTimes(2);
    expect(
      harness.state.workspaces[harness.workspaceId].worktree
        ?.launchSurfaceCreated
    ).toBe(true);
  });

  it(
    "does not remove dirty worktrees until forced",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-remove-"));
      const repoDir = createCommittedRepo(rootDir);
      const managedRoot = join(rootDir, "managed");
      const { state, workspaceId } = createStateAtCwd(repoDir);
      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir,
        managedRoot
      });

      try {
        const worktree = await runtime.createWorkspace(
          workspaceId,
          "repo-20260512-1430"
        );
        writeFileSync(join(worktree.path, "dirty.txt"), "dirty\n", "utf8");

        await expect(runtime.remove(workspaceId, false)).resolves.toMatchObject(
          {
            status: "dirty",
            dirtyEntries: expect.arrayContaining(["?? dirty.txt"])
          }
        );
        expect(existsSync(worktree.path)).toBe(true);

        await expect(runtime.remove(workspaceId, true)).resolves.toEqual({
          status: "removed"
        });
        expect(existsSync(worktree.path)).toBe(false);
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );

  it(
    "does not partially remove bulk worktrees when any worktree is dirty",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-bulk-remove-"));
      const repoDir = createCommittedRepo(rootDir);
      const cleanPath = join(rootDir, "clean");
      const dirtyPath = join(rootDir, "dirty");
      execFileSync(
        "git",
        ["worktree", "add", "-b", "clean", cleanPath, "main"],
        {
          cwd: repoDir,
          stdio: "ignore"
        }
      );
      execFileSync(
        "git",
        ["worktree", "add", "-b", "dirty", dirtyPath, "main"],
        {
          cwd: repoDir,
          stdio: "ignore"
        }
      );
      writeFileSync(join(dirtyPath, "dirty.txt"), "dirty\n", "utf8");
      const { state, workspaceId: cleanWorkspaceId } =
        createStateAtCwd(repoDir);
      applyAction(state, { type: "workspace.create", name: "dirty" });
      const dirtyWorkspaceId =
        state.windows[state.activeWindowId].activeWorkspaceId;
      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir
      });

      applyAction(state, {
        type: "workspace.worktree.convert",
        workspaceId: cleanWorkspaceId,
        worktree: {
          name: "clean",
          path: cleanPath,
          repoRoot: repoDir,
          commonGitDir: join(repoDir, ".git"),
          baseRef: "main",
          branch: "clean",
          createdByKmux: false
        }
      });
      applyAction(state, {
        type: "workspace.worktree.convert",
        workspaceId: dirtyWorkspaceId,
        worktree: {
          name: "dirty",
          path: dirtyPath,
          repoRoot: repoDir,
          commonGitDir: join(repoDir, ".git"),
          baseRef: "main",
          branch: "dirty",
          createdByKmux: false
        }
      });

      try {
        await expect(
          runtime.removeMany([cleanWorkspaceId, dirtyWorkspaceId], false)
        ).resolves.toMatchObject({
          status: "dirty",
          dirtyWorktrees: [
            expect.objectContaining({
              workspaceId: dirtyWorkspaceId,
              dirtyEntries: expect.arrayContaining(["?? dirty.txt"])
            })
          ]
        });
        expect(existsSync(cleanPath)).toBe(true);
        expect(existsSync(dirtyPath)).toBe(true);

        await expect(
          runtime.removeMany([cleanWorkspaceId, dirtyWorkspaceId], true)
        ).resolves.toEqual({ status: "removed" });
        expect(existsSync(cleanPath)).toBe(false);
        expect(existsSync(dirtyPath)).toBe(false);
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );

  it(
    "resolves current linked worktree metadata before converting detected worktrees",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "kmux-worktree-detected-"));
      const repoDir = createCommittedRepo(rootDir);
      const worktreePath = join(rootDir, "linked");
      execFileSync(
        "git",
        ["worktree", "add", "-b", "old", worktreePath, "main"],
        {
          cwd: repoDir,
          stdio: "ignore"
        }
      );
      execFileSync("git", ["checkout", "-b", "new"], {
        cwd: worktreePath,
        stdio: "ignore"
      });
      const realRepoDir = realpathSync(repoDir);
      const realWorktreePath = realpathSync(worktreePath);
      const { state, workspaceId } = createStateAtCwd(worktreePath);
      state.workspaces[workspaceId].detectedWorktree = {
        path: localPath(worktreePath),
        repoRoot: localPath(repoDir),
        commonGitDir: localPath(join(repoDir, ".git")),
        baseRef: "old",
        branch: "old",
        detectedAt: "2026-05-12T00:00:00.000Z"
      };
      const runtime = createWorktreeRuntime({
        getState: () => state,
        dispatchAppAction: (action) => applyAction(state, action),
        homeDir: rootDir
      });

      try {
        const worktree = await runtime.convertDetected(workspaceId);

        expect(worktree).toMatchObject({
          path: realWorktreePath,
          repoRoot: realRepoDir,
          baseRef: "new",
          branch: "new",
          createdByKmux: false
        });
        expect(state.workspaces[workspaceId].worktree).toMatchObject({
          branch: "new",
          baseRef: "new"
        });
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
    GIT_WORKTREE_TEST_TIMEOUT_MS
  );
});
