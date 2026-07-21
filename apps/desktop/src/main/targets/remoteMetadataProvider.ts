import {
  terminalRuntimeMetadataForSurface,
  terminalSessionForSurface,
  type AppAction,
  type AppState,
  type RemotePath
} from "@kmux/core";
import { isoNow, type Id } from "@kmux/proto";

import type { GitProvider, MetadataProvider, PortProvider } from "./contracts";
import type { RemotePathResolver } from "./targetServiceRegistry";

export function createRemoteMetadataProvider(options: {
  targetId: Id;
  git: GitProvider<RemotePath>;
  ports: PortProvider;
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  resolveRemotePath: RemotePathResolver;
  reportError?: (error: Error) => void;
}): MetadataProvider<RemotePath> {
  const provider: MetadataProvider<RemotePath> = {
    refresh(request) {
      void refreshRemoteMetadata(options, request).catch((error: unknown) =>
        options.reportError?.(
          error instanceof Error ? error : new Error(String(error))
        )
      );
    }
  };
  return Object.freeze(provider);
}

async function refreshRemoteMetadata(
  options: {
    targetId: Id;
    git: GitProvider<RemotePath>;
    ports: PortProvider;
    getState: () => AppState;
    dispatchAppAction: (action: AppAction) => void;
    resolveRemotePath: RemotePathResolver;
  },
  request: { surfaceId: Id; cwd?: RemotePath; pid?: number }
): Promise<void> {
  const initial = requireRemoteSurface(
    options.getState(),
    options.targetId,
    request.surfaceId
  );
  const cwd = request.cwd;
  if (!cwd) return;
  const rawCwd = options.resolveRemotePath(cwd);
  if (surfaceRawCwd(options, initial.metadata) !== rawCwd) return;

  const [inspection, ports] = await Promise.all([
    options.git.inspect(cwd, { dirtyLimit: 0 }),
    options.ports.list(initial.session.id)
  ]);
  const current = requireRemoteSurface(
    options.getState(),
    options.targetId,
    request.surfaceId
  );
  if (
    current.session.id !== initial.session.id ||
    surfaceRawCwd(options, current.metadata) !== rawCwd
  ) {
    return;
  }

  const repository = inspection.repository;
  options.dispatchAppAction({
    type: "surface.metadata",
    surfaceId: request.surfaceId,
    branch: inspection.branch ?? null,
    ports: ports.slice(0, 3),
    gitRepository: repository
      ? {
          root: options.resolveRemotePath(repository.root),
          gitDir: options.resolveRemotePath(repository.gitDir),
          commonGitDir: options.resolveRemotePath(repository.commonGitDir),
          linkedWorktree: repository.linkedWorktree
        }
      : null
  });
  updateRemoteWorktreeDetection(options, current, inspection);
}

function updateRemoteWorktreeDetection(
  options: {
    targetId: Id;
    dispatchAppAction: (action: AppAction) => void;
    resolveRemotePath: RemotePathResolver;
  },
  scope: ReturnType<typeof requireRemoteSurface>,
  inspection: Awaited<ReturnType<GitProvider<RemotePath>["inspect"]>>
): void {
  if (scope.pane.activeSurfaceId !== scope.surface.id) return;
  const repository = inspection.repository;
  if (!repository || !repository.linkedWorktree) {
    if (scope.workspace.detectedWorktree) {
      options.dispatchAppAction({
        type: "workspace.worktree.clearDetected",
        workspaceId: scope.workspace.id
      });
    }
    return;
  }
  if (scope.workspace.worktree) return;

  const commonGitDir = options.resolveRemotePath(repository.commonGitDir);
  const branch =
    inspection.branch && inspection.branch !== "HEAD"
      ? inspection.branch
      : "HEAD";
  options.dispatchAppAction({
    type: "workspace.worktree.detected",
    workspaceId: scope.workspace.id,
    detectedWorktree: {
      path: options.resolveRemotePath(repository.root),
      repoRoot: deriveRemoteRepoRoot(commonGitDir),
      commonGitDir,
      baseRef: branch,
      branch,
      detectedAt: isoNow()
    }
  });
}

function requireRemoteSurface(
  state: AppState,
  targetId: Id,
  surfaceId: Id
): {
  surface: AppState["surfaces"][string];
  pane: AppState["panes"][string];
  workspace: AppState["workspaces"][string];
  session: AppState["sessions"][string];
  metadata: AppState["sessions"][string]["runtimeMetadata"];
} {
  const surface = state.surfaces[surfaceId];
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  const session = terminalSessionForSurface(state, surfaceId);
  const metadata = terminalRuntimeMetadataForSurface(state, surfaceId);
  if (
    !surface ||
    !pane ||
    !workspace ||
    !session ||
    !metadata ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== targetId
  ) {
    throw new Error("remote metadata surface is outside its provider target");
  }
  return { surface, pane, workspace, session, metadata };
}

function surfaceRawCwd(
  options: { targetId: Id; resolveRemotePath: RemotePathResolver },
  metadata: AppState["sessions"][string]["runtimeMetadata"]
): string | null {
  if (
    metadata.cwd.kind !== "ssh" ||
    metadata.cwd.targetId !== options.targetId
  ) {
    return null;
  }
  return options.resolveRemotePath(metadata.cwd.path);
}

function deriveRemoteRepoRoot(commonGitDir: string): string {
  if (commonGitDir === "/.git") return "/";
  return commonGitDir.endsWith("/.git")
    ? commonGitDir.slice(0, -5) || "/"
    : commonGitDir;
}
