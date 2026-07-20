import type {
  AppState,
  RemotePath,
  RemoteWorktreeProductMetadata
} from "@kmux/core";
import { uint64, type Id, type Uint64 } from "@kmux/proto";

import type { RemoteLifecycleRuntime } from "../remote/remoteLifecycleRuntime";
import type { RemoteHostManager } from "../remoteHost";
import type { GitProvider, TargetMutationResult } from "./contracts";
import type {
  RemotePathDecoder,
  RemotePathResolver
} from "./targetServiceRegistry";

export function createRemoteGitProvider(options: {
  desktopInstallationId: Id;
  targetId: Id;
  host: RemoteHostManager;
  lifecycle: RemoteLifecycleRuntime;
  getState: () => AppState;
  resolveRemotePath: RemotePathResolver;
  decodeRemotePath: RemotePathDecoder;
  managedRoot: string;
}): GitProvider<RemotePath> {
  const raw = options.resolveRemotePath;
  const provider: GitProvider<RemotePath> = {
    managedWorktreeRoot: () => options.decodeRemotePath(options.managedRoot),
    async inspect(cwd, inspectionOptions = {}) {
      const inspected = await options.host.inspectGit({
        targetId: options.targetId,
        desktopInstallationId: options.desktopInstallationId,
        cwd: raw(cwd),
        dirtyLimit: inspectionOptions.dirtyLimit ?? 8,
        ...(inspectionOptions.branch === undefined
          ? {}
          : { branch: inspectionOptions.branch })
      });
      return {
        ...(inspected.repository === undefined
          ? {}
          : {
              repository: {
                root: options.decodeRemotePath(inspected.repository.root),
                gitDir: options.decodeRemotePath(inspected.repository.gitDir),
                commonGitDir: options.decodeRemotePath(
                  inspected.repository.commonGitDir
                ),
                linkedWorktree: inspected.repository.linkedWorktree
              }
            }),
        ...(inspected.branch === undefined ? {} : { branch: inspected.branch }),
        dirtyEntries: [...inspected.dirtyEntries],
        dirtyEntriesTruncated: inspected.dirtyEntriesTruncated,
        ...(inspected.branchExists === undefined
          ? {}
          : { branchExists: inspected.branchExists })
      };
    },
    async createWorktree(request) {
      return executeWorkspaceMutation(
        options,
        request.workspaceId,
        {
          kind: "worktree.create",
          workspaceId: request.workspaceId,
          cwd: raw(request.cwd),
          path: raw(request.path),
          baseRef: request.baseRef,
          branch: request.branch
        },
        { kind: "worktree.create", worktree: request.product }
      );
    },
    async removeWorktree(request) {
      return executeWorkspaceMutation(
        options,
        request.workspaceId,
        {
          kind: "worktree.remove",
          workspaceId: request.workspaceId,
          cwd: raw(request.cwd),
          path: raw(request.path),
          force: request.force,
          expectedBranch: request.expectedWorktree.branch,
          expectedCommonGitDir: request.expectedWorktree.commonGitDir
        },
        {
          kind: "worktree.remove",
          expectedWorktree: request.expectedWorktree
        }
      );
    }
  };
  return Object.freeze(provider);
}

async function executeWorkspaceMutation(
  options: {
    targetId: Id;
    lifecycle: RemoteLifecycleRuntime;
    getState: () => AppState;
  },
  workspaceId: Id,
  payload:
    | {
        kind: "worktree.create";
        workspaceId: Id;
        cwd: string;
        path: string;
        baseRef: string;
        branch: string;
      }
    | {
        kind: "worktree.remove";
        workspaceId: Id;
        cwd: string;
        path: string;
        force: boolean;
        expectedBranch: string;
        expectedCommonGitDir: string;
      },
  worktree: RemoteWorktreeProductMetadata
): Promise<TargetMutationResult> {
  const expectedRemoteResourceRevision = currentWorkspaceRemoteRevision(
    options.getState(),
    options.targetId,
    workspaceId
  );
  const result = await options.lifecycle.executeCommand(
    {
      type: "remote-operation.command",
      workspaceId,
      payload,
      expectedRemoteResourceRevision
    },
    { worktree }
  );
  if (result.outcome.status === "succeeded") {
    return { status: "succeeded" };
  }
  if (result.outcome.status === "pending") {
    return { status: "pending", reason: result.outcome.reason };
  }
  return {
    status: "failed",
    code: result.outcome.code,
    message: result.outcome.message
  };
}

export function currentWorkspaceRemoteRevision(
  state: AppState,
  targetId: Id,
  workspaceId: Id
): Uint64 {
  const workspace = state.workspaces[workspaceId];
  let revision =
    workspace?.location.target.kind === "ssh" &&
    workspace.location.target.targetId === targetId
      ? (workspace.remoteResourceRevision ?? uint64(0n))
      : uint64(0n);
  for (const operation of Object.values(state.remoteOperations)) {
    if (
      operation.resourceKey.targetId !== targetId ||
      operation.resourceKey.workspaceId !== workspaceId ||
      operation.resourceKey.sessionId !== undefined ||
      operation.state === "failed"
    ) {
      continue;
    }
    if (operation.nextRemoteResourceRevision > revision) {
      revision = operation.nextRemoteResourceRevision;
    }
  }
  return revision;
}
