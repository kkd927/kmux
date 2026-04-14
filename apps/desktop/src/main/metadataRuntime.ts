import {resolveGitBranch, resolveListeningPorts} from "@kmux/metadata";

import type {AppAction, AppState} from "@kmux/core";
import type {Id} from "@kmux/proto";

interface MetadataRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
}

export interface MetadataRuntime {
  refreshMetadata(surfaceId: Id, cwd?: string, pid?: number): void;
}

export function createMetadataRuntime(
  options: MetadataRuntimeOptions
): MetadataRuntime {
  return {
    refreshMetadata(surfaceId, cwd, pid): void {
      void (async () => {
        const [branch, ports] = await Promise.all([
          resolveGitBranch(cwd),
          resolveListeningPorts(pid)
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

        options.dispatchAppAction({
          type: "surface.metadata",
          surfaceId,
          branch: branch ?? undefined,
          ports
        });
      })();
    }
  };
}
