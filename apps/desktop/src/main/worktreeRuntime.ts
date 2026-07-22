import {
  encodeLocatedPathDto,
  representativeWorkspaceTerminalSurface,
  terminalRuntimeMetadataForSurface,
  terminalSessionForSurface,
  type AppAction,
  type AppState,
  type LocatedPath,
  type LocatedWorkspaceWorktreeMetadata
} from "@kmux/core";
import type {
  Id,
  WorktreeBulkRemoveResult,
  WorktreeConversionPreview,
  WorktreeRemoveResult,
  WorkspaceDetectedWorktreeMetadata,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";

import type {
  LocatedTargetServiceSet,
  TargetMutationResult,
  TargetServiceRegistry
} from "./targets/contracts";

const MAX_DIRTY_ENTRIES = 8;

export interface WorktreeRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  targetServices: TargetServiceRegistry;
  now?: () => Date;
  reportError?: (error: Error) => void;
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
  reconcileManagedSurfaces(): Promise<void>;
}

interface LocatedWorktreePreview {
  dto: WorktreeConversionPreview;
  path: LocatedPath;
  repoRoot: LocatedPath;
  commonGitDir: LocatedPath;
}

export function createWorktreeRuntime(
  options: WorktreeRuntimeOptions
): WorktreeRuntime {
  const now = options.now ?? (() => new Date());
  const launchSurfaceReconciliations = new Map<Id, Promise<void>>();

  async function prepareConversion(
    workspaceId: Id
  ): Promise<WorktreeConversionPreview | null> {
    const context = workspaceTerminalSurfaceContext(
      options.getState(),
      workspaceId
    );
    if (!context) return null;
    const services = options.targetServices.resolveLocated(
      context.workspace.location.target
    );
    const inspection = await services.git.inspect(context.metadata.cwd, {
      dirtyLimit: MAX_DIRTY_ENTRIES
    });
    if (!inspection.repository) return null;

    const repoBasename =
      services.files.basename(inspection.repository.root) || "repo";
    const name = await buildUniqueWorktreeName({
      namePrefix: sanitizeWorktreeNameComponent(repoBasename),
      repoRoot: inspection.repository.root,
      parentPath: services.files.join(
        services.git.managedWorktreeRoot(),
        repoBasename
      ),
      services,
      now: now()
    });
    return buildPreview({
      workspaceId,
      name,
      repoBasename,
      repoRoot: inspection.repository.root,
      commonGitDir: inspection.repository.commonGitDir,
      baseRef: inspection.branch || "HEAD",
      managedRoot: services.git.managedWorktreeRoot(),
      services
    }).dto;
  }

  async function createWorkspace(
    workspaceId: Id,
    name: string
  ): Promise<WorkspaceWorktreeMetadata> {
    const context = requireWorkspaceTerminalSurfaceContext(
      options.getState(),
      workspaceId
    );
    const services = options.targetServices.resolveLocated(
      context.workspace.location.target
    );
    const inspection = await services.git.inspect(context.metadata.cwd, {
      dirtyLimit: MAX_DIRTY_ENTRIES
    });
    if (!inspection.repository) {
      throw new Error("Workspace terminal cwd is not inside a git repository.");
    }
    const normalizedName = normalizeWorktreeName(name);
    const validationError = validateWorktreeName(normalizedName);
    if (validationError) throw new Error(validationError);
    const repoBasename =
      services.files.basename(inspection.repository.root) || "repo";
    const preview = buildPreview({
      workspaceId,
      name: normalizedName,
      repoBasename,
      repoRoot: inspection.repository.root,
      commonGitDir: inspection.repository.commonGitDir,
      baseRef: inspection.branch || "HEAD",
      managedRoot: services.git.managedWorktreeRoot(),
      services
    });
    if (await services.files.exists(preview.path)) {
      throw new Error(`Worktree path already exists: ${preview.dto.path}`);
    }
    const branchInspection = await services.git.inspect(preview.repoRoot, {
      dirtyLimit: 0,
      branch: preview.dto.branch
    });
    if (branchInspection.branchExists) {
      throw new Error(`Branch already exists: ${preview.dto.branch}`);
    }

    const worktree = worktreeDto(preview, true);
    const outcome = await services.git.createWorktree({
      workspaceId,
      cwd: context.metadata.cwd,
      path: preview.path,
      branch: preview.dto.branch,
      baseRef: preview.dto.baseRef,
      product: worktree
    });
    requireMutationSucceeded(outcome, "create worktree");
    options.dispatchAppAction({
      type: "workspace.worktree.convert",
      workspaceId,
      worktree,
      createSurface: false,
      focus: true
    });
    await ensureManagedWorktreeSurface(workspaceId, worktree);
    return worktree;
  }

  async function ensureManagedWorktreeSurface(
    workspaceId: Id,
    expectedWorktree: WorkspaceWorktreeMetadata
  ): Promise<void> {
    const existing = launchSurfaceReconciliations.get(workspaceId);
    if (existing) {
      await existing;
      return await ensureManagedWorktreeSurface(workspaceId, expectedWorktree);
    }
    const reconciliation = (async () => {
      const state = options.getState();
      const workspace = state.workspaces[workspaceId];
      const worktree = workspace?.worktree;
      if (
        !workspace ||
        !worktree ||
        worktree.launchSurfaceCreated === true ||
        encodeLocatedPathDto(worktree.path).path !== expectedWorktree.path
      ) {
        return;
      }
      const services = options.targetServices.resolveLocated(
        workspace.location.target
      );
      let projectedSession = findLaunchSession(
        state,
        workspaceId,
        expectedWorktree.path
      );
      if (!projectedSession) {
        await services.terminal.create({
          workspaceId,
          paneId: workspace.activePaneId,
          launch: {
            cwd: worktree.path,
            title: worktree.name
          }
        });
        const currentState = options.getState();
        const currentWorktree = currentState.workspaces[workspaceId]?.worktree;
        if (
          !currentWorktree ||
          encodeLocatedPathDto(currentWorktree.path).path !==
            expectedWorktree.path
        ) {
          return;
        }
        projectedSession = findLaunchSession(
          currentState,
          workspaceId,
          expectedWorktree.path
        );
        if (!projectedSession) {
          throw new Error("managed worktree launch surface was not projected");
        }
      }
      if (
        workspace.location.target.kind === "ssh" &&
        !projectedSession.remoteRuntime
      ) {
        return;
      }
      const current = options.getState().workspaces[workspaceId]?.worktree;
      if (
        current &&
        encodeLocatedPathDto(current.path).path === expectedWorktree.path
      ) {
        options.dispatchAppAction({
          type: "workspace.worktree.launchSurfaceCreated",
          workspaceId,
          path: expectedWorktree.path
        });
      }
    })().finally(() => {
      launchSurfaceReconciliations.delete(workspaceId);
    });
    launchSurfaceReconciliations.set(workspaceId, reconciliation);
    return await reconciliation;
  }

  async function reconcileManagedSurfaces(): Promise<void> {
    const state = options.getState();
    const candidates = Object.values(state.remoteOperations).flatMap(
      (operation) => {
        if (
          operation.state !== "succeeded" ||
          operation.pendingProduct?.kind !== "worktree.create"
        ) {
          return [];
        }
        const workspace = state.workspaces[operation.resourceKey.workspaceId];
        const worktree = workspace?.worktree;
        if (
          !workspace ||
          workspace.location.target.kind !== "ssh" ||
          workspace.location.target.targetId !==
            operation.resourceKey.targetId ||
          !worktree ||
          worktree.launchSurfaceCreated === true ||
          encodeLocatedPathDto(worktree.path).path !==
            operation.pendingProduct.product.worktree.path
        ) {
          return [];
        }
        return [
          {
            workspaceId: workspace.id,
            worktree: operation.pendingProduct.product.worktree
          }
        ];
      }
    );
    await Promise.all(
      candidates.map(async (candidate) => {
        try {
          await ensureManagedWorktreeSurface(
            candidate.workspaceId,
            candidate.worktree
          );
        } catch (error) {
          options.reportError?.(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      })
    );
  }

  async function convertDetected(
    workspaceId: Id
  ): Promise<WorkspaceWorktreeMetadata> {
    const context = requireWorkspaceTerminalSurfaceContext(
      options.getState(),
      workspaceId
    );
    const services = options.targetServices.resolveLocated(
      context.workspace.location.target
    );
    const inspection = await services.git.inspect(context.metadata.cwd, {
      dirtyLimit: MAX_DIRTY_ENTRIES
    });
    const repository = inspection.repository;
    if (!repository?.linkedWorktree) {
      throw new Error("Workspace terminal cwd is not a linked git worktree.");
    }
    const branch = inspection.branch || "HEAD";
    const detected: WorkspaceDetectedWorktreeMetadata = {
      path: services.files.display(repository.root),
      repoRoot: services.files.display(
        deriveRepoRootFromCommonGitDir(repository.commonGitDir, services)
      ),
      commonGitDir: services.files.display(repository.commonGitDir),
      baseRef: branch,
      branch,
      detectedAt: now().toISOString()
    };
    const worktree: WorkspaceWorktreeMetadata = {
      name: services.files.basename(repository.root) || branch || "worktree",
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

  async function remove(
    workspaceId: Id,
    force = false
  ): Promise<WorktreeRemoveResult> {
    const state = options.getState();
    const workspace = state.workspaces[workspaceId];
    const worktree = workspace?.worktree;
    if (!workspace || !worktree) {
      throw new Error("Workspace is not a Worktree Workspace.");
    }
    const services = options.targetServices.resolveLocated(
      workspace.location.target
    );
    const dirty = await services.git.inspect(worktree.path, {
      dirtyLimit: MAX_DIRTY_ENTRIES
    });
    if (isDirty(dirty) && !force) {
      return { status: "dirty", dirtyEntries: dirty.dirtyEntries };
    }
    const cwd = await resolveExistingGitCommandCwd(worktree, services);
    const outcome = await services.git.removeWorktree({
      workspaceId,
      cwd,
      path: worktree.path,
      force,
      expectedWorktree: worktreeMetadataDto(worktree, services)
    });
    if (outcome.status === "failed" && outcome.code === "worktree-dirty") {
      const refreshed = await services.git.inspect(worktree.path, {
        dirtyLimit: MAX_DIRTY_ENTRIES
      });
      return { status: "dirty", dirtyEntries: refreshed.dirtyEntries };
    }
    requireMutationSucceeded(outcome, "remove worktree");
    return { status: "removed" };
  }

  async function removeMany(
    workspaceIds: Id[],
    force = false
  ): Promise<WorktreeBulkRemoveResult> {
    const state = options.getState();
    const worktrees = workspaceIds.flatMap((workspaceId) => {
      const workspace = state.workspaces[workspaceId];
      return workspace?.worktree
        ? [{ workspaceId, workspace, worktree: workspace.worktree }]
        : [];
    });
    if (worktrees.length === 0) return { status: "removed" };

    if (!force) {
      const dirtyWorktrees = [];
      for (const entry of worktrees) {
        const services = options.targetServices.resolveLocated(
          entry.workspace.location.target
        );
        const dirty = await services.git.inspect(entry.worktree.path, {
          dirtyLimit: MAX_DIRTY_ENTRIES
        });
        if (isDirty(dirty)) {
          dirtyWorktrees.push({
            workspaceId: entry.workspaceId,
            path: services.files.display(entry.worktree.path),
            branch: entry.worktree.branch,
            dirtyEntries: dirty.dirtyEntries
          });
        }
      }
      if (dirtyWorktrees.length > 0) {
        return { status: "dirty", dirtyWorktrees };
      }
    }

    for (const entry of worktrees) {
      const services = options.targetServices.resolveLocated(
        entry.workspace.location.target
      );
      const cwd = await resolveExistingGitCommandCwd(entry.worktree, services);
      const outcome = await services.git.removeWorktree({
        workspaceId: entry.workspaceId,
        cwd,
        path: entry.worktree.path,
        force,
        expectedWorktree: worktreeMetadataDto(entry.worktree, services)
      });
      requireMutationSucceeded(outcome, "remove worktree");
    }
    return { status: "removed" };
  }

  return {
    prepareConversion,
    createWorkspace,
    convertDetected,
    remove,
    removeMany,
    reconcileManagedSurfaces
  };
}

function findLaunchSession(
  state: AppState,
  workspaceId: Id,
  expectedPath: string
) {
  for (const surface of Object.values(state.surfaces)) {
    const pane = state.panes[surface.paneId];
    const session = terminalSessionForSurface(state, surface.id);
    if (
      pane?.workspaceId === workspaceId &&
      session !== undefined &&
      encodeLocatedPathDto(session.launch.cwd).path === expectedPath
    ) {
      return session;
    }
  }
  return undefined;
}

function workspaceTerminalSurfaceContext(state: AppState, workspaceId: Id) {
  const workspace = state.workspaces[workspaceId];
  const surface = workspace
    ? representativeWorkspaceTerminalSurface(state, workspace)
    : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const metadata = surface
    ? terminalRuntimeMetadataForSurface(state, surface.id)
    : undefined;
  return workspace && pane && surface && metadata
    ? { workspace, pane, surface, metadata }
    : null;
}

function requireWorkspaceTerminalSurfaceContext(
  state: AppState,
  workspaceId: Id
) {
  const context = workspaceTerminalSurfaceContext(state, workspaceId);
  if (!context) throw new Error("Workspace has no terminal cwd.");
  return context;
}

function buildPreview(params: {
  workspaceId: Id;
  name: string;
  repoBasename: string;
  repoRoot: LocatedPath;
  commonGitDir: LocatedPath;
  baseRef: string;
  managedRoot: LocatedPath;
  services: LocatedTargetServiceSet;
}): LocatedWorktreePreview {
  const path = params.services.files.join(
    params.managedRoot,
    params.repoBasename,
    params.name
  );
  return {
    path,
    repoRoot: params.repoRoot,
    commonGitDir: params.commonGitDir,
    dto: {
      workspaceId: params.workspaceId,
      name: params.name,
      repoBasename: params.repoBasename,
      from: params.baseRef,
      path: params.services.files.display(path),
      branch: `kmux/${params.name}`,
      repoRoot: params.services.files.display(params.repoRoot),
      commonGitDir: params.services.files.display(params.commonGitDir),
      baseRef: params.baseRef
    }
  };
}

function worktreeDto(
  preview: LocatedWorktreePreview,
  createdByKmux: boolean
): WorkspaceWorktreeMetadata {
  return {
    name: preview.dto.name,
    path: preview.dto.path,
    repoRoot: preview.dto.repoRoot,
    commonGitDir: preview.dto.commonGitDir,
    baseRef: preview.dto.baseRef,
    branch: preview.dto.branch,
    createdByKmux
  };
}

async function buildUniqueWorktreeName(params: {
  namePrefix: string;
  repoRoot: LocatedPath;
  parentPath: LocatedPath;
  services: LocatedTargetServiceSet;
  now: Date;
}): Promise<string> {
  const baseName = `${params.namePrefix}-${formatLocalTimestamp(params.now)}`;
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const worktreePath = params.services.files.join(
      params.parentPath,
      candidate
    );
    const branch = `kmux/${candidate}`;
    const [pathExists, inspection] = await Promise.all([
      params.services.files.exists(worktreePath),
      params.services.git.inspect(params.repoRoot, {
        dirtyLimit: 0,
        branch
      })
    ]);
    if (!pathExists && !inspection.branchExists) return candidate;
  }
  throw new Error("Could not allocate a unique worktree name.");
}

function worktreeMetadataDto(
  worktree: LocatedWorkspaceWorktreeMetadata,
  services: LocatedTargetServiceSet
): WorkspaceWorktreeMetadata {
  return {
    name: worktree.name,
    path: services.files.display(worktree.path),
    repoRoot: services.files.display(worktree.repoRoot),
    commonGitDir: services.files.display(worktree.commonGitDir),
    baseRef: worktree.baseRef,
    branch: worktree.branch,
    createdByKmux: worktree.createdByKmux
  };
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
  if (!name) return "Worktree name is required.";
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

function deriveRepoRootFromCommonGitDir(
  commonGitDir: LocatedPath,
  services: LocatedTargetServiceSet
): LocatedPath {
  return services.files.basename(commonGitDir) === ".git"
    ? services.files.dirname(commonGitDir)
    : commonGitDir;
}

async function resolveExistingGitCommandCwd(
  worktree: LocatedWorkspaceWorktreeMetadata,
  services: LocatedTargetServiceSet
): Promise<LocatedPath> {
  if (await services.files.exists(worktree.repoRoot)) return worktree.repoRoot;
  if (await services.files.exists(worktree.path)) return worktree.path;
  return services.files.dirname(worktree.path);
}

function isDirty(inspection: {
  dirtyEntries: string[];
  dirtyEntriesTruncated: boolean;
}): boolean {
  return inspection.dirtyEntries.length > 0 || inspection.dirtyEntriesTruncated;
}

function requireMutationSucceeded(
  outcome: TargetMutationResult,
  operation: string
): void {
  if (outcome.status === "succeeded") return;
  if (outcome.status === "pending") {
    throw new Error(
      `${operation} is pending remote reconciliation (${outcome.reason}).`
    );
  }
  throw new Error(outcome.message || `${operation} failed (${outcome.code}).`);
}
