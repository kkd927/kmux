import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import {
  resolveGitBranch,
  resolveGitRepository,
  resolveListeningPorts,
  type GitRepositoryMetadata
} from "@kmux/metadata";

import {
  terminalRuntimeMetadataForSurface,
  terminalSessionForSurface,
  type AppAction,
  type AppState
} from "@kmux/core";
import { isoNow, type Id } from "@kmux/proto";
import type { LocalPathResolver } from "./targets/targetServiceRegistry";

interface MetadataRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  env?: NodeJS.ProcessEnv;
  resolveLocalPath: LocalPathResolver;
}

export const GIT_HEAD_METADATA_REFRESH_DEBOUNCE_MS = 100;

export interface MetadataRuntime {
  refreshMetadata(surfaceId: Id, cwd?: string, pid?: number): void;
  handleAppAction(action: AppAction): void;
  dispose(): void;
}

export function createMetadataRuntime(
  options: MetadataRuntimeOptions
): MetadataRuntime {
  const resolveLocalPath = options.resolveLocalPath;
  const surfaceGitDirs = new Map<Id, string>();
  const surfaceGitCwds = new Map<Id, string>();
  const gitHeadWatchers = new Map<
    string,
    {
      watcher: FSWatcher;
      surfaceIds: Set<Id>;
      refreshTimer: ReturnType<typeof setTimeout> | null;
    }
  >();

  function refreshResolvedMetadata(
    surfaceId: Id,
    cwd: string | undefined,
    pid: number | undefined
  ): void {
    void (async () => {
      const [branch, ports, repository] = await Promise.all([
        resolveGitBranch(cwd, options.env),
        resolveListeningPorts(pid, options.env),
        resolveGitRepository(cwd, options.env)
      ]);

      const currentState = options.getState();
      const surface = currentState.surfaces[surfaceId];
      if (!surface) {
        return;
      }

      const session = terminalSessionForSurface(currentState, surfaceId);
      const metadata = terminalRuntimeMetadataForSurface(
        currentState,
        surfaceId
      );
      if (!session || !metadata) {
        return;
      }
      if (cwd !== undefined) {
        try {
          if (resolveLocalPath(metadata.cwd) !== cwd) {
            return;
          }
        } catch {
          return;
        }
      }
      if (pid !== undefined && session?.pid !== pid) {
        return;
      }
      trackSurfaceRepository(surfaceId, cwd, repository);

      options.dispatchAppAction({
        type: "surface.metadata",
        surfaceId,
        branch,
        ports,
        gitRepository: repository
          ? {
              root: repository.root,
              gitDir: repository.gitDir,
              commonGitDir: repository.commonGitDir,
              linkedWorktree: repository.gitDir !== repository.commonGitDir
            }
          : null
      });
      updateWorkspaceWorktreeDetection(surfaceId, repository, branch);
    })();
  }

  function updateWorkspaceWorktreeDetection(
    surfaceId: Id,
    repository: GitRepositoryMetadata | null,
    branch: string | null
  ): void {
    const state = options.getState();
    const surface = state.surfaces[surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (!surface || !pane || !workspace || pane.activeSurfaceId !== surfaceId) {
      return;
    }

    if (!repository || repository.gitDir === repository.commonGitDir) {
      if (workspace.detectedWorktree) {
        options.dispatchAppAction({
          type: "workspace.worktree.clearDetected",
          workspaceId: workspace.id
        });
      }
      return;
    }

    if (workspace.worktree) {
      return;
    }

    const detectedBranch = branch && branch !== "HEAD" ? branch : "HEAD";
    options.dispatchAppAction({
      type: "workspace.worktree.detected",
      workspaceId: workspace.id,
      detectedWorktree: {
        path: repository.root,
        repoRoot: deriveRepoRootFromCommonGitDir(repository.commonGitDir),
        commonGitDir: repository.commonGitDir,
        baseRef: detectedBranch,
        branch: detectedBranch,
        detectedAt: isoNow()
      }
    });
  }

  function trackSurfaceRepository(
    surfaceId: Id,
    cwd: string | undefined,
    repository: GitRepositoryMetadata | null
  ): void {
    if (!cwd || !repository) {
      untrackSurfaceRepository(surfaceId);
      return;
    }

    const previousGitDir = surfaceGitDirs.get(surfaceId);
    if (previousGitDir === repository.gitDir) {
      gitHeadWatchers.get(repository.gitDir)?.surfaceIds.add(surfaceId);
      surfaceGitCwds.set(surfaceId, cwd);
      return;
    }
    if (previousGitDir) {
      untrackSurfaceRepository(surfaceId);
    }

    let entry = gitHeadWatchers.get(repository.gitDir);
    if (!entry) {
      let watcher: FSWatcher;
      try {
        watcher = watch(
          repository.gitDir,
          { persistent: false },
          (_eventType, filename) => {
            if ((filename?.toString() ?? "HEAD") === "HEAD") {
              scheduleGitHeadRefresh(repository.gitDir);
            }
          }
        );
      } catch {
        return;
      }
      entry = {
        watcher,
        surfaceIds: new Set<Id>(),
        refreshTimer: null
      };
      watcher.on("error", () => {
        closeGitHeadWatcher(repository.gitDir);
      });
      gitHeadWatchers.set(repository.gitDir, entry);
    }

    entry.surfaceIds.add(surfaceId);
    surfaceGitDirs.set(surfaceId, repository.gitDir);
    surfaceGitCwds.set(surfaceId, cwd);
  }

  function untrackSurfaceRepository(surfaceId: Id): void {
    const gitDir = surfaceGitDirs.get(surfaceId);
    if (!gitDir) {
      return;
    }
    surfaceGitDirs.delete(surfaceId);
    surfaceGitCwds.delete(surfaceId);
    const entry = gitHeadWatchers.get(gitDir);
    entry?.surfaceIds.delete(surfaceId);
    if (entry && entry.surfaceIds.size === 0) {
      closeGitHeadWatcher(gitDir);
    }
  }

  function closeGitHeadWatcher(gitDir: string): void {
    const entry = gitHeadWatchers.get(gitDir);
    if (!entry) {
      return;
    }
    if (entry.refreshTimer) {
      clearTimeout(entry.refreshTimer);
    }
    entry.watcher.close();
    gitHeadWatchers.delete(gitDir);
    for (const surfaceId of entry.surfaceIds) {
      surfaceGitDirs.delete(surfaceId);
      surfaceGitCwds.delete(surfaceId);
    }
  }

  function scheduleGitHeadRefresh(gitDir: string): void {
    const entry = gitHeadWatchers.get(gitDir);
    if (!entry) {
      return;
    }
    if (entry.refreshTimer) {
      clearTimeout(entry.refreshTimer);
    }
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null;
      refreshGitHeadSurfaces(gitDir);
    }, GIT_HEAD_METADATA_REFRESH_DEBOUNCE_MS);
  }

  function refreshGitHeadSurfaces(gitDir: string): void {
    const entry = gitHeadWatchers.get(gitDir);
    if (!entry) {
      return;
    }
    void (async () => {
      const currentState = options.getState();
      const liveSurfaceIds = [...entry.surfaceIds].filter(
        (surfaceId) =>
          surfaceGitDirs.get(surfaceId) === gitDir &&
          Boolean(terminalRuntimeMetadataForSurface(currentState, surfaceId))
      );
      const locatedCwd = terminalRuntimeMetadataForSurface(
        currentState,
        liveSurfaceIds[0]
      )?.cwd;
      if (!locatedCwd) {
        return;
      }
      let cwd: string;
      try {
        cwd = resolveLocalPath(locatedCwd);
      } catch {
        return;
      }
      const branch = await resolveGitBranch(cwd, options.env, {
        bypassCache: true
      });
      const nextState = options.getState();
      for (const surfaceId of liveSurfaceIds) {
        const surface = nextState.surfaces[surfaceId];
        if (!surface || surfaceGitDirs.get(surfaceId) !== gitDir) {
          continue;
        }
        const metadata = terminalRuntimeMetadataForSurface(
          nextState,
          surfaceId
        );
        const repository = metadata?.gitRepository
          ? {
              root: resolveLocalPath(metadata.gitRepository.root),
              gitDir: resolveLocalPath(metadata.gitRepository.gitDir),
              commonGitDir: resolveLocalPath(
                metadata.gitRepository.commonGitDir
              )
            }
          : null;
        options.dispatchAppAction({
          type: "surface.metadata",
          surfaceId,
          branch
        });
        updateWorkspaceWorktreeDetection(surfaceId, repository, branch);
      }
    })();
  }

  function reconcileTrackedSurfaces(): void {
    const state = options.getState();
    for (const surfaceId of [...surfaceGitDirs.keys()]) {
      const surface = state.surfaces[surfaceId];
      let cwd: string | undefined;
      try {
        const metadata = surface
          ? terminalRuntimeMetadataForSurface(state, surfaceId)
          : undefined;
        cwd = metadata ? resolveLocalPath(metadata.cwd) : undefined;
      } catch {
        cwd = undefined;
      }
      if (!surface || cwd !== surfaceGitCwds.get(surfaceId)) {
        untrackSurfaceRepository(surfaceId);
      }
    }
  }

  return {
    refreshMetadata(surfaceId, cwd, pid): void {
      refreshResolvedMetadata(surfaceId, cwd, pid);
    },
    handleAppAction(): void {
      reconcileTrackedSurfaces();
    },
    dispose(): void {
      for (const entry of gitHeadWatchers.values()) {
        if (entry.refreshTimer) {
          clearTimeout(entry.refreshTimer);
        }
        entry.watcher.close();
      }
      gitHeadWatchers.clear();
      surfaceGitDirs.clear();
      surfaceGitCwds.clear();
    }
  };
}

function deriveRepoRootFromCommonGitDir(commonGitDir: string): string {
  return basename(commonGitDir) === ".git"
    ? dirname(commonGitDir)
    : commonGitDir;
}
