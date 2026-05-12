import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { resolveGitRepository } from "@kmux/metadata";

import type { AppAction, AppState } from "@kmux/core";
import type {
  Id,
  WorktreeBulkRemoveResult,
  WorktreeConversionPreview,
  WorktreeRemoveResult,
  WorkspaceDetectedWorktreeMetadata,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";

const execFileAsync = promisify(execFile);
const MAX_DIRTY_ENTRIES = 8;

export interface WorktreeRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  env?: NodeJS.ProcessEnv;
  homeDir: string;
  managedRoot?: string;
  now?: () => Date;
}

export interface WorktreeRuntime {
  prepareConversion(workspaceId: Id): Promise<WorktreeConversionPreview | null>;
  createWorkspace(
    workspaceId: Id,
    name: string
  ): Promise<WorkspaceWorktreeMetadata>;
  convertDetected(workspaceId: Id): Promise<WorkspaceWorktreeMetadata>;
  remove(workspaceId: Id, force?: boolean): Promise<WorktreeRemoveResult>;
  removeMany(
    workspaceIds: Id[],
    force?: boolean
  ): Promise<WorktreeBulkRemoveResult>;
}

export function createWorktreeRuntime(
  options: WorktreeRuntimeOptions
): WorktreeRuntime {
  const now = options.now ?? (() => new Date());
  const managedRoot =
    options.managedRoot ?? join(options.homeDir, ".kmux", "worktrees");

  async function prepareConversion(
    workspaceId: Id
  ): Promise<WorktreeConversionPreview | null> {
    const context = activeWorkspaceSurfaceContext(
      options.getState(),
      workspaceId
    );
    if (!context?.surface.cwd) {
      return null;
    }
    const repository = await resolveGitRepository(
      context.surface.cwd,
      options.env
    );
    if (!repository) {
      return null;
    }

    const repoBasename = basename(repository.root) || "repo";
    const defaultNamePrefix = sanitizeWorktreeNameComponent(repoBasename);
    const baseRef = await resolveBaseRef(context.surface.cwd, options.env);
    const name = await buildUniqueWorktreeName({
      namePrefix: defaultNamePrefix,
      repoRoot: repository.root,
      parentPath: join(managedRoot, repoBasename),
      env: options.env,
      now: now()
    });
    return buildPreview({
      workspaceId,
      name,
      repoBasename,
      repoRoot: repository.root,
      commonGitDir: repository.commonGitDir,
      baseRef,
      managedRoot
    });
  }

  async function createWorkspace(
    workspaceId: Id,
    name: string
  ): Promise<WorkspaceWorktreeMetadata> {
    const context = activeWorkspaceSurfaceContext(
      options.getState(),
      workspaceId
    );
    if (!context?.surface.cwd) {
      throw new Error("Workspace has no active terminal cwd.");
    }
    const repository = await resolveGitRepository(
      context.surface.cwd,
      options.env
    );
    if (!repository) {
      throw new Error("Active terminal cwd is not inside a git repository.");
    }
    const repoBasename = basename(repository.root) || "repo";
    const normalizedName = normalizeWorktreeName(name);
    const validationError = validateWorktreeName(normalizedName);
    if (validationError) {
      throw new Error(validationError);
    }
    const baseRef = await resolveBaseRef(context.surface.cwd, options.env);
    const preview = buildPreview({
      workspaceId,
      name: normalizedName,
      repoBasename,
      repoRoot: repository.root,
      commonGitDir: repository.commonGitDir,
      baseRef,
      managedRoot
    });
    if (existsSync(preview.path)) {
      throw new Error(`Worktree path already exists: ${preview.path}`);
    }
    if (await branchExists(repository.root, preview.branch, options.env)) {
      throw new Error(`Branch already exists: ${preview.branch}`);
    }

    mkdirSync(dirname(preview.path), { recursive: true });
    await runGit(
      context.surface.cwd,
      ["worktree", "add", "-b", preview.branch, preview.path, preview.baseRef],
      options.env
    );

    const worktree: WorkspaceWorktreeMetadata = {
      name: preview.name,
      path: preview.path,
      repoRoot: preview.repoRoot,
      commonGitDir: preview.commonGitDir,
      baseRef: preview.baseRef,
      branch: preview.branch,
      createdByKmux: true
    };
    options.dispatchAppAction({
      type: "workspace.worktree.convert",
      workspaceId,
      worktree,
      createSurface: true,
      focus: true
    });
    return worktree;
  }

  async function convertDetected(
    workspaceId: Id
  ): Promise<WorkspaceWorktreeMetadata> {
    const detected = await resolveDetectedWorktree(workspaceId);
    const worktree: WorkspaceWorktreeMetadata = {
      name: basename(detected.path) || detected.branch || "worktree",
      path: detected.path,
      repoRoot: detected.repoRoot,
      commonGitDir: detected.commonGitDir,
      baseRef: detected.baseRef,
      branch: detected.branch,
      createdByKmux: false
    };
    options.dispatchAppAction({
      type: "workspace.worktree.convert",
      workspaceId,
      worktree,
      createSurface: false,
      focus: true
    });
    return worktree;
  }

  async function resolveDetectedWorktree(
    workspaceId: Id
  ): Promise<WorkspaceDetectedWorktreeMetadata> {
    const context = activeWorkspaceSurfaceContext(
      options.getState(),
      workspaceId
    );
    if (!context?.surface.cwd) {
      throw new Error("Workspace has no active terminal cwd.");
    }
    const repository = await resolveGitRepository(
      context.surface.cwd,
      options.env
    );
    if (!repository || repository.gitDir === repository.commonGitDir) {
      throw new Error("Active terminal cwd is not a linked git worktree.");
    }
    const branch = await resolveBaseRef(context.surface.cwd, options.env);
    return {
      path: repository.root,
      repoRoot: deriveRepoRootFromCommonGitDir(repository.commonGitDir),
      commonGitDir: repository.commonGitDir,
      baseRef: branch,
      branch,
      detectedAt: new Date().toISOString()
    };
  }

  async function remove(
    workspaceId: Id,
    force = false
  ): Promise<WorktreeRemoveResult> {
    const workspace = options.getState().workspaces[workspaceId];
    const worktree = workspace?.worktree;
    if (!worktree) {
      throw new Error("Workspace is not a Worktree Workspace.");
    }
    const dirtyEntries = await resolveDirtyEntries(worktree.path, options.env);
    if (dirtyEntries.length > 0 && !force) {
      return {
        status: "dirty",
        dirtyEntries: dirtyEntries.slice(0, MAX_DIRTY_ENTRIES)
      };
    }
    const cwd = resolveExistingGitCommandCwd(worktree);
    await runGit(
      cwd,
      ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path],
      options.env
    );
    return { status: "removed" };
  }

  async function removeMany(
    workspaceIds: Id[],
    force = false
  ): Promise<WorktreeBulkRemoveResult> {
    const worktrees = workspaceIds
      .map((workspaceId) => {
        const worktree = options.getState().workspaces[workspaceId]?.worktree;
        return worktree ? { workspaceId, worktree } : null;
      })
      .filter(
        (
          entry
        ): entry is { workspaceId: Id; worktree: WorkspaceWorktreeMetadata } =>
          entry !== null
      );

    if (!worktrees.length) {
      return { status: "removed" };
    }

    if (!force) {
      const dirtyWorktrees = [];
      for (const { workspaceId, worktree } of worktrees) {
        const dirtyEntries = await resolveDirtyEntries(
          worktree.path,
          options.env
        );
        if (dirtyEntries.length > 0) {
          dirtyWorktrees.push({
            workspaceId,
            path: worktree.path,
            branch: worktree.branch,
            dirtyEntries: dirtyEntries.slice(0, MAX_DIRTY_ENTRIES)
          });
        }
      }
      if (dirtyWorktrees.length > 0) {
        return {
          status: "dirty",
          dirtyWorktrees
        };
      }
    }

    for (const { worktree } of worktrees) {
      const cwd = resolveExistingGitCommandCwd(worktree);
      await runGit(
        cwd,
        ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path],
        options.env
      );
    }
    return { status: "removed" };
  }

  return {
    prepareConversion,
    createWorkspace,
    convertDetected,
    remove,
    removeMany
  };
}

function activeWorkspaceSurfaceContext(
  state: AppState,
  workspaceId: Id
): {
  surface: AppState["surfaces"][Id];
} | null {
  const workspace = state.workspaces[workspaceId];
  const pane = workspace ? state.panes[workspace.activePaneId] : undefined;
  const surface = pane ? state.surfaces[pane.activeSurfaceId] : undefined;
  return surface ? { surface } : null;
}

function buildPreview(params: {
  workspaceId: Id;
  name: string;
  repoBasename: string;
  repoRoot: string;
  commonGitDir: string;
  baseRef: string;
  managedRoot: string;
}): WorktreeConversionPreview {
  return {
    workspaceId: params.workspaceId,
    name: params.name,
    repoBasename: params.repoBasename,
    from: params.baseRef,
    path: join(params.managedRoot, params.repoBasename, params.name),
    branch: `kmux/${params.name}`,
    repoRoot: params.repoRoot,
    commonGitDir: params.commonGitDir,
    baseRef: params.baseRef
  };
}

async function buildUniqueWorktreeName(params: {
  namePrefix: string;
  repoRoot: string;
  parentPath: string;
  env?: NodeJS.ProcessEnv;
  now: Date;
}): Promise<string> {
  const baseName = `${params.namePrefix}-${formatLocalTimestamp(params.now)}`;
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const path = join(params.parentPath, candidate);
    const branch = `kmux/${candidate}`;
    if (
      !existsSync(path) &&
      !(await branchExists(params.repoRoot, branch, params.env))
    ) {
      return candidate;
    }
  }
  throw new Error("Could not allocate a unique worktree name.");
}

function normalizeWorktreeName(name: string): string {
  return name.trim();
}

function sanitizeWorktreeNameComponent(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
  return sanitized || "repo";
}

export function validateWorktreeName(name: string): string | null {
  if (!name) {
    return "Worktree name is required.";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return "Use letters, numbers, dots, underscores, and hyphens only.";
  }
  if (name.includes("..") || name.endsWith(".") || name.endsWith(".lock")) {
    return "Worktree name is not a valid git branch component.";
  }
  return null;
}

function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}${month}${day}-${hour}${minute}`;
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0");
}

async function resolveBaseRef(
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const branch = await runGit(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    env
  )
    .then((stdout) => stdout.trim())
    .catch(() => "");
  if (branch) {
    return branch;
  }
  const commit = await runGit(cwd, ["rev-parse", "--short", "HEAD"], env)
    .then((stdout) => stdout.trim())
    .catch(() => "");
  return commit || "HEAD";
}

async function branchExists(
  cwd: string,
  branch: string,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  return runGit(
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    env
  )
    .then(() => true)
    .catch(() => false);
}

async function resolveDirtyEntries(
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string[]> {
  const stdout = await runGit(cwd, ["status", "--porcelain"], env);
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env
    });
    return stdout;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const message =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(message);
  }
}

function resolveExistingGitCommandCwd(
  worktree: WorkspaceWorktreeMetadata
): string {
  if (existsSync(worktree.repoRoot)) {
    return worktree.repoRoot;
  }
  if (existsSync(worktree.path)) {
    return worktree.path;
  }
  return dirname(worktree.path);
}

function deriveRepoRootFromCommonGitDir(commonGitDir: string): string {
  return basename(commonGitDir) === ".git"
    ? dirname(commonGitDir)
    : commonGitDir;
}
