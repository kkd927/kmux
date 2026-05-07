import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import {
  resolveGitBranch,
  resolveGitRepository,
  resolveListeningPorts,
  type GitRepositoryMetadata
} from "@kmux/metadata";

import type { AppAction, AppState } from "@kmux/core";
import type { Id } from "@kmux/proto";

interface MetadataRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  env?: NodeJS.ProcessEnv;
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

      const session = currentState.sessions[surface.sessionId];
      if (cwd !== undefined && surface.cwd !== cwd) {
        return;
      }
      if (pid !== undefined && session?.pid !== pid) {
        return;
      }
      trackSurfaceRepository(surfaceId, cwd, repository);

      options.dispatchAppAction({
        type: "surface.metadata",
        surfaceId,
        branch,
        ports
      });
    })();
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
          join(repository.gitDir, "HEAD"),
          { persistent: false },
          () => scheduleGitHeadRefresh(repository.gitDir)
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
          Boolean(currentState.surfaces[surfaceId]?.cwd)
      );
      const cwd = currentState.surfaces[liveSurfaceIds[0]]?.cwd;
      if (!cwd) {
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
        options.dispatchAppAction({
          type: "surface.metadata",
          surfaceId,
          branch
        });
      }
    })();
  }

  function reconcileTrackedSurfaces(): void {
    const state = options.getState();
    for (const surfaceId of [...surfaceGitDirs.keys()]) {
      const surface = state.surfaces[surfaceId];
      if (!surface || surface.cwd !== surfaceGitCwds.get(surfaceId)) {
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
