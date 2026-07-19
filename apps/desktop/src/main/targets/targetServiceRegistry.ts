import type {
  LocatedPath,
  LocalPath,
  RemotePath,
  WorkspaceTarget
} from "@kmux/core";
import {
  localLocatedPath,
  locatedPathForTarget,
  remoteLocatedPath
} from "@kmux/core";
import { createPathAccess } from "@kmux/core/main/path-access";
import type { Id } from "@kmux/proto";

import type {
  ResolvedTargetServices,
  LocatedTargetServiceSet,
  TargetServiceRegistry,
  TargetServiceSet
} from "./contracts";

export type LocalPathResolver = (path: LocatedPath) => string;
export type RemotePathResolver = (path: RemotePath) => string;
export type RemotePathDecoder = (path: string) => RemotePath;

export interface CreateTargetServiceRegistryOptions {
  local: TargetServiceSet<LocalPath>;
  remote: (
    targetId: Id,
    resolveRemotePath: RemotePathResolver,
    decodeRemotePath: RemotePathDecoder
  ) => TargetServiceSet<RemotePath> | undefined;
}

export function createTargetServiceRegistry(
  options: CreateTargetServiceRegistryOptions
): TargetServiceRegistry {
  const { unwrapRemote } = createPathAccess();
  const resolve = (target: WorkspaceTarget): ResolvedTargetServices => {
    if (target.kind === "local") {
      return { target: { kind: "local" }, services: options.local };
    }
    const resolveRemotePath = (path: RemotePath): string =>
      unwrapRemote(target.targetId, path);
    const decodeRemotePath = (path: string): RemotePath => {
      const located = locatedPathForTarget(target, path);
      if (located.kind !== "ssh" || located.targetId !== target.targetId) {
        throw new Error("remote path codec returned another target");
      }
      return located.path;
    };
    const services = options.remote(
      target.targetId,
      resolveRemotePath,
      decodeRemotePath
    );
    if (!services) {
      throw new Error(`target services are unavailable for ${target.targetId}`);
    }
    return {
      target: { kind: "ssh", targetId: target.targetId },
      services
    };
  };
  return Object.freeze({
    resolve(target: WorkspaceTarget): ResolvedTargetServices {
      return resolve(target);
    },
    resolveLocated(target: WorkspaceTarget): LocatedTargetServiceSet {
      return bindLocatedTargetServices(resolve(target));
    }
  });
}

/**
 * Compatibility injection for local providers migrated in later slices. It is
 * created only by the composition root and rejects SSH paths before unwrapping.
 */
export function createLocalPathResolver(): LocalPathResolver {
  const { unwrapLocal } = createPathAccess();
  return (path) => {
    if (path.kind !== "local") {
      throw new Error("an SSH path cannot enter a local target provider");
    }
    return unwrapLocal(path.path);
  };
}

type TargetPathFor<TResolved extends ResolvedTargetServices> =
  TResolved extends Extract<
    ResolvedTargetServices,
    { target: { kind: "local" } }
  >
    ? LocalPath
    : RemotePath;

export function selectTargetPath<TResolved extends ResolvedTargetServices>(
  resolved: TResolved,
  located: LocatedPath
): TargetPathFor<TResolved> {
  if (resolved.target.kind === "local") {
    if (located.kind !== "local") {
      throw new Error("an SSH path cannot enter a local target provider");
    }
    return located.path as TargetPathFor<TResolved>;
  }
  if (located.kind !== "ssh" || located.targetId !== resolved.target.targetId) {
    throw new Error("remote path does not belong to the bound SSH target");
  }
  return located.path as TargetPathFor<TResolved>;
}

function bindLocatedTargetServices(
  resolved: ResolvedTargetServices
): LocatedTargetServiceSet {
  if (isLocalResolvedTargetServices(resolved)) {
    const services = resolved.services;
    const path = (located: LocatedPath): LocalPath =>
      selectTargetPath(resolved, located);
    const wrap = (value: LocalPath): LocatedPath => localLocatedPath(value);
    return {
      terminal: bindLocatedTerminal(services.terminal, path),
      git: {
        inspect: async (cwd, options) =>
          wrapGitInspection(
            await services.git.inspect(path(cwd), options),
            wrap
          ),
        managedWorktreeRoot: () => wrap(services.git.managedWorktreeRoot()),
        createWorktree: (request) =>
          services.git.createWorktree({
            ...request,
            cwd: path(request.cwd),
            path: path(request.path)
          }),
        removeWorktree: (request) =>
          services.git.removeWorktree({
            ...request,
            cwd: path(request.cwd),
            path: path(request.path)
          })
      },
      files: bindLocatedFiles(services.files, path, wrap),
      metadata: bindLocatedMetadata(services.metadata, path),
      history: bindLocatedHistory(services.history, wrap),
      usage: bindLocatedUsage(services.usage, wrap),
      ports: services.ports,
      attachments: {
        store: async (request) => {
          const stored = await services.attachments.store({
            ...request,
            cwd: path(request.cwd)
          });
          return { ...stored, path: wrap(stored.path) };
        }
      }
    };
  }

  const remote = resolved;
  const services = remote.services;
  const path = (located: LocatedPath): RemotePath =>
    selectTargetPath(remote, located);
  const wrap = (value: RemotePath): LocatedPath =>
    remoteLocatedPath(remote.target.targetId, value);
  return {
    terminal: bindLocatedTerminal(services.terminal, path),
    git: {
      inspect: async (cwd, options) =>
        wrapGitInspection(await services.git.inspect(path(cwd), options), wrap),
      managedWorktreeRoot: () => wrap(services.git.managedWorktreeRoot()),
      createWorktree: (request) =>
        services.git.createWorktree({
          ...request,
          cwd: path(request.cwd),
          path: path(request.path)
        }),
      removeWorktree: (request) =>
        services.git.removeWorktree({
          ...request,
          cwd: path(request.cwd),
          path: path(request.path)
        })
    },
    files: bindLocatedFiles(services.files, path, wrap),
    metadata: bindLocatedMetadata(services.metadata, path),
    history: bindLocatedHistory(services.history, wrap),
    usage: bindLocatedUsage(services.usage, wrap),
    ports: services.ports,
    attachments: {
      store: async (request) => {
        const stored = await services.attachments.store({
          ...request,
          cwd: path(request.cwd)
        });
        return { ...stored, path: wrap(stored.path) };
      }
    }
  };
}

function bindLocatedTerminal<TPath extends LocalPath | RemotePath>(
  terminal: TargetServiceSet<TPath>["terminal"],
  path: (located: LocatedPath) => TPath
): LocatedTargetServiceSet["terminal"] {
  return {
    create: (request) =>
      terminal.create({
        ...request,
        launch: { ...request.launch, cwd: path(request.launch.cwd) }
      }),
    terminate: (request) => terminal.terminate(request),
    sendText: (sessionId, value) => terminal.sendText(sessionId, value),
    sendKey: (sessionId, input) => terminal.sendKey(sessionId, input)
  };
}

function isLocalResolvedTargetServices(
  resolved: ResolvedTargetServices
): resolved is Extract<ResolvedTargetServices, { target: { kind: "local" } }> {
  return resolved.target.kind === "local";
}

function bindLocatedFiles<TPath extends LocalPath | RemotePath>(
  files: TargetServiceSet<TPath>["files"],
  path: (located: LocatedPath) => TPath,
  wrap: (value: TPath) => LocatedPath
): LocatedTargetServiceSet["files"] {
  return {
    exists: (value) => files.exists(path(value)),
    read: (value, options) => files.read(path(value), options),
    join: (base, ...segments) => wrap(files.join(path(base), ...segments)),
    dirname: (value) => wrap(files.dirname(path(value))),
    basename: (value) => files.basename(path(value)),
    display: (value) => files.display(path(value)),
    resolveTerminalPath: async (request) => {
      const resolved = await files.resolveTerminalPath({
        ...(request.cwd === undefined ? {} : { cwd: path(request.cwd) }),
        rawPath: request.rawPath
      });
      return resolved ? { ...resolved, path: wrap(resolved.path) } : null;
    },
    stageForLocalOpen: (value, options) =>
      files.stageForLocalOpen(path(value), options)
  };
}

function bindLocatedMetadata<TPath extends LocalPath | RemotePath>(
  metadata: TargetServiceSet<TPath>["metadata"],
  path: (located: LocatedPath) => TPath
): LocatedTargetServiceSet["metadata"] {
  return {
    refresh: (request) =>
      metadata.refresh({
        surfaceId: request.surfaceId,
        ...(request.cwd === undefined ? {} : { cwd: path(request.cwd) }),
        ...(request.pid === undefined ? {} : { pid: request.pid })
      })
  };
}

function bindLocatedHistory<TPath extends LocalPath | RemotePath>(
  history: TargetServiceSet<TPath>["history"],
  wrap: (value: TPath) => LocatedPath
): LocatedTargetServiceSet["history"] {
  return {
    refresh: async (request) =>
      (await history.refresh(request)).map(({ cwd, ...record }) => ({
        ...record,
        ...(cwd === undefined ? {} : { cwd: wrap(cwd) })
      }))
  };
}

function bindLocatedUsage<TPath extends LocalPath | RemotePath>(
  usage: TargetServiceSet<TPath>["usage"],
  wrap: (value: TPath) => LocatedPath
): LocatedTargetServiceSet["usage"] {
  return {
    refresh: async (request) => {
      const scan = await usage.refresh(request);
      return {
        ...scan,
        records: scan.records.map(({ cwd, projectPath, ...record }) => ({
          ...record,
          ...(cwd === undefined ? {} : { cwd: wrap(cwd) }),
          ...(projectPath === undefined
            ? {}
            : { projectPath: wrap(projectPath) })
        }))
      };
    },
    ...(usage.watch === undefined
      ? {}
      : { watch: (onChange) => usage.watch!(onChange) }),
    ...(usage.markDirty === undefined
      ? {}
      : {
          markDirty: (vendor, options) => usage.markDirty!(vendor, options)
        }),
    ...(usage.close === undefined ? {} : { close: () => usage.close!() })
  };
}

function wrapGitInspection<TPath extends LocalPath | RemotePath>(
  inspection: Awaited<ReturnType<TargetServiceSet<TPath>["git"]["inspect"]>>,
  wrap: (value: TPath) => LocatedPath
) {
  return {
    ...(inspection.repository === undefined
      ? {}
      : {
          repository: {
            root: wrap(inspection.repository.root),
            gitDir: wrap(inspection.repository.gitDir),
            commonGitDir: wrap(inspection.repository.commonGitDir),
            linkedWorktree: inspection.repository.linkedWorktree
          }
        }),
    ...(inspection.branch === undefined ? {} : { branch: inspection.branch }),
    dirtyEntries: [...inspection.dirtyEntries],
    dirtyEntriesTruncated: inspection.dirtyEntriesTruncated,
    ...(inspection.branchExists === undefined
      ? {}
      : { branchExists: inspection.branchExists })
  };
}
