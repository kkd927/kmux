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

import { applyAction, createInitialState } from "@kmux/core";

import { createWorktreeRuntime, validateWorktreeName } from "./worktreeRuntime";

const GIT_WORKTREE_TEST_TIMEOUT_MS = 15_000;

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
  state.surfaces[surfaceId].cwd = cwd;
  return { state, workspaceId, paneId };
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
        expect(state.workspaces[workspaceId].worktree).toMatchObject(worktree);
        expect(state.surfaces[activeSurfaceId].cwd).toBe(worktree.path);
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
        path: worktreePath,
        repoRoot: repoDir,
        commonGitDir: join(repoDir, ".git"),
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
