import {resolveGitBranch, resolveListeningPorts} from "@kmux/metadata";

import type {AppAction, AppState} from "@kmux/core";
import type {Id} from "@kmux/proto";

interface MetadataRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  env?: NodeJS.ProcessEnv;
}

export const BRANCH_ONLY_METADATA_REFRESH_DEBOUNCE_MS = 100;

export interface MetadataRefreshOptions {
  branchOnly?: boolean;
}

export interface MetadataRuntime {
  refreshMetadata(
    surfaceId: Id,
    cwd?: string,
    pid?: number,
    refreshOptions?: MetadataRefreshOptions
  ): void;
}

export function createMetadataRuntime(
  options: MetadataRuntimeOptions
): MetadataRuntime {
  const branchOnlyTimers = new Map<Id, ReturnType<typeof setTimeout>>();

  function refreshResolvedMetadata(
    surfaceId: Id,
    cwd: string | undefined,
    pid: number | undefined,
    refreshOptions: MetadataRefreshOptions
  ): void {
    void (async () => {
      const branchOnly = Boolean(refreshOptions.branchOnly);
      let branch: string | null;
      let ports: number[] | undefined;

      if (branchOnly) {
        branch = await resolveGitBranch(cwd, options.env, {
          bypassCache: true
        });
      } else {
        [branch, ports] = await Promise.all([
          resolveGitBranch(cwd, options.env),
          resolveListeningPorts(pid, options.env)
        ]);
      }

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

      const action: Extract<AppAction, { type: "surface.metadata" }> = {
        type: "surface.metadata",
        surfaceId,
        branch
      };
      if (!branchOnly) {
        action.ports = ports;
      }
      options.dispatchAppAction(action);
    })();
  }

  return {
    refreshMetadata(surfaceId, cwd, pid, refreshOptions = {}): void {
      if (refreshOptions.branchOnly) {
        const existingTimer = branchOnlyTimers.get(surfaceId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        branchOnlyTimers.set(
          surfaceId,
          setTimeout(() => {
            branchOnlyTimers.delete(surfaceId);
            refreshResolvedMetadata(surfaceId, cwd, pid, refreshOptions);
          }, BRANCH_ONLY_METADATA_REFRESH_DEBOUNCE_MS)
        );
        return;
      }

      refreshResolvedMetadata(surfaceId, cwd, pid, refreshOptions);
    }
  };
}
