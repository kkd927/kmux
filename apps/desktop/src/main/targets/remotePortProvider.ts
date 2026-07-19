import type { AppState } from "@kmux/core";
import { makeId, type Id, type Uint64 } from "@kmux/proto";

import type { RemoteLifecycleRuntime } from "../remote/remoteLifecycleRuntime";
import type { RemoteHostManager } from "../remoteHost";
import type { ForwardMapping, PortProvider } from "./contracts";
import { currentWorkspaceRemoteRevision } from "./remoteGitProvider";

export interface RemoteForwardQueue {
  enqueue<T>(targetId: Id, workspaceId: Id, task: () => Promise<T>): Promise<T>;
}

export function createRemoteForwardQueue(): RemoteForwardQueue {
  const queues = new Map<string, Promise<unknown>>();
  return Object.freeze({
    enqueue<T>(
      targetId: Id,
      workspaceId: Id,
      task: () => Promise<T>
    ): Promise<T> {
      const key = JSON.stringify([targetId, workspaceId]);
      const previous = queues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(task);
      queues.set(key, current);
      void current
        .finally(() => {
          if (queues.get(key) === current) queues.delete(key);
        })
        .catch(() => undefined);
      return current;
    }
  });
}

export function createRemotePortProvider(options: {
  desktopInstallationId: Id;
  targetId: Id;
  host: Pick<
    RemoteHostManager,
    | "inspectPorts"
    | "observeForwards"
    | "reconcileForwards"
    | "closeWorkspaceForwards"
  >;
  lifecycle: RemoteLifecycleRuntime;
  getState: () => AppState;
  queue: RemoteForwardQueue;
  makeForwardId?: () => Id;
}): PortProvider {
  const makeForwardId = options.makeForwardId ?? (() => makeId("forward"));
  const provider: PortProvider = {
    async list(sessionId) {
      const scope = requireRemoteSession(
        options.getState(),
        options.targetId,
        sessionId
      );
      const inspected = await options.host.inspectPorts({
        targetId: options.targetId,
        resourceKey: {
          desktopInstallationId: options.desktopInstallationId,
          targetId: options.targetId,
          workspaceId: scope.workspace.id,
          sessionId
        }
      });
      return inspected.ports.slice(0, 3);
    },
    remapBrowserUrl(request) {
      return options.queue.enqueue(
        options.targetId,
        request.workspaceId,
        async () => remapBrowserUrl(options, request, makeForwardId)
      );
    },
    closeWorkspace(workspaceId) {
      return options.queue.enqueue(options.targetId, workspaceId, async () =>
        closeWorkspaceForwards(options, workspaceId)
      );
    }
  };
  return Object.freeze(provider);
}

async function remapBrowserUrl(
  options: {
    desktopInstallationId: Id;
    targetId: Id;
    host: Pick<RemoteHostManager, "observeForwards" | "reconcileForwards">;
    lifecycle: RemoteLifecycleRuntime;
    getState: () => AppState;
  },
  request: { workspaceId: Id; url: URL },
  makeForwardId: () => Id
): Promise<{ url: URL; mapping?: ForwardMapping }> {
  requireRemoteWorkspace(
    options.getState(),
    options.targetId,
    request.workspaceId
  );
  const endpoint = remoteLoopbackEndpoint(request.url);
  if (!endpoint) return { url: new URL(request.url.toString()) };

  let observed = await options.host.observeForwards({
    targetId: options.targetId,
    desktopInstallationId: options.desktopInstallationId
  });
  let descriptor = observed.forwards.find(
    (forward) =>
      forward.resourceKey.workspaceId === request.workspaceId &&
      normalizeRemoteLoopbackHost(forward.remoteHost) === endpoint.host &&
      forward.remotePort === endpoint.port
  );
  if (!descriptor) {
    const forwardId = makeForwardId();
    const outcome = await executeForwardEnsure(options, {
      workspaceId: request.workspaceId,
      expectedRemoteResourceRevision: currentWorkspaceRemoteRevision(
        options.getState(),
        options.targetId,
        request.workspaceId
      ),
      forwardId,
      remoteHost: endpoint.host,
      remotePort: endpoint.port,
      localBindHost: "127.0.0.1"
    });
    if (outcome !== "succeeded") {
      return {
        url: new URL(request.url.toString()),
        mapping: pendingMapping(
          forwardId,
          request.workspaceId,
          endpoint.host,
          endpoint.port,
          "127.0.0.1",
          endpoint.port
        )
      };
    }
    observed = await options.host.observeForwards({
      targetId: options.targetId,
      desktopInstallationId: options.desktopInstallationId
    });
    descriptor = observed.forwards.find(
      (forward) => forward.forwardId === forwardId
    );
    if (!descriptor) {
      throw new Error("durable forward did not appear in target observation");
    }
  }

  let mappings = await options.host.reconcileForwards({
    targetId: options.targetId,
    desktopInstallationId: options.desktopInstallationId
  });
  let active = mappings.find(
    (mapping) => mapping.forwardId === descriptor!.forwardId
  );
  if (!active)
    throw new Error("SSH forward reconciliation produced no mapping");

  if (descriptor.localPort !== active.localPort) {
    const durableLocalPort = active.localPort;
    const outcome = await executeForwardEnsure(options, {
      workspaceId: request.workspaceId,
      expectedRemoteResourceRevision: currentWorkspaceRemoteRevision(
        options.getState(),
        options.targetId,
        request.workspaceId
      ),
      forwardId: descriptor.forwardId,
      remoteHost: descriptor.remoteHost,
      remotePort: descriptor.remotePort,
      localBindHost: descriptor.localBindHost,
      localPort: durableLocalPort
    });
    if (outcome !== "succeeded") {
      return {
        url: new URL(request.url.toString()),
        mapping: {
          ...toForwardMapping(active),
          status: "pending"
        }
      };
    }
    mappings = await options.host.reconcileForwards({
      targetId: options.targetId,
      desktopInstallationId: options.desktopInstallationId
    });
    active = mappings.find(
      (mapping) => mapping.forwardId === descriptor!.forwardId
    );
    if (!active || active.localPort !== durableLocalPort) {
      throw new Error("durable forward remap did not converge");
    }
  }

  const mapping = toForwardMapping(active);
  return { url: rewriteLoopbackUrl(request.url, mapping), mapping };
}

async function closeWorkspaceForwards(
  options: {
    desktopInstallationId: Id;
    targetId: Id;
    host: Pick<
      RemoteHostManager,
      "observeForwards" | "reconcileForwards" | "closeWorkspaceForwards"
    >;
    lifecycle: RemoteLifecycleRuntime;
    getState: () => AppState;
  },
  workspaceId: Id
): Promise<void> {
  requireRemoteWorkspace(options.getState(), options.targetId, workspaceId);
  const observed = await options.host.observeForwards({
    targetId: options.targetId,
    desktopInstallationId: options.desktopInstallationId
  });
  for (const descriptor of observed.forwards.filter(
    (forward) => forward.resourceKey.workspaceId === workspaceId
  )) {
    const result = await options.lifecycle.executeCommand({
      type: "remote-operation.command",
      workspaceId,
      expectedRemoteResourceRevision: currentWorkspaceRemoteRevision(
        options.getState(),
        options.targetId,
        workspaceId
      ),
      payload: { kind: "forward.remove", forwardId: descriptor.forwardId }
    });
    if (result.outcome.status === "failed") {
      throw new Error(result.outcome.message);
    }
  }
  await options.host.closeWorkspaceForwards(options.targetId, workspaceId);
  if (options.lifecycle.isTargetConnected(options.targetId)) {
    await options.host.reconcileForwards({
      targetId: options.targetId,
      desktopInstallationId: options.desktopInstallationId
    });
  }
}

async function executeForwardEnsure(
  options: {
    lifecycle: RemoteLifecycleRuntime;
  },
  request: {
    workspaceId: Id;
    expectedRemoteResourceRevision: Uint64;
    forwardId: Id;
    remoteHost: string;
    remotePort: number;
    localBindHost: "127.0.0.1" | "::1";
    localPort?: number;
  }
): Promise<"succeeded" | "pending"> {
  const result = await options.lifecycle.executeCommand({
    type: "remote-operation.command",
    workspaceId: request.workspaceId,
    expectedRemoteResourceRevision: request.expectedRemoteResourceRevision,
    payload: {
      kind: "forward.ensure",
      forwardId: request.forwardId,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      localBindHost: request.localBindHost,
      ...(request.localPort === undefined
        ? {}
        : { localPort: request.localPort })
    }
  });
  if (result.outcome.status === "failed") {
    throw new Error(result.outcome.message);
  }
  return result.outcome.status;
}

function remoteLoopbackEndpoint(
  url: URL
): { host: "127.0.0.1" | "::1"; port: number } | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalizeRemoteLoopbackHost(url.hostname);
  if (!host) return null;
  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? { host, port }
    : null;
}

function normalizeRemoteLoopbackHost(
  value: string
): "127.0.0.1" | "::1" | null {
  const normalized = value.toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return "127.0.0.1";
  }
  return normalized === "::1" || normalized === "[::1]" ? "::1" : null;
}

function rewriteLoopbackUrl(url: URL, mapping: ForwardMapping): URL {
  const rewritten = new URL(url.toString());
  rewritten.hostname =
    mapping.localBindHost === "::1" ? "[::1]" : mapping.localBindHost;
  rewritten.port = String(mapping.localPort);
  return rewritten;
}

function pendingMapping(
  forwardId: Id,
  workspaceId: Id,
  remoteHost: string,
  remotePort: number,
  localBindHost: "127.0.0.1" | "::1",
  localPort: number
): ForwardMapping {
  return {
    forwardId,
    workspaceId,
    remoteHost,
    remotePort,
    localBindHost,
    localPort,
    status: "pending"
  };
}

function toForwardMapping(
  mapping: Awaited<ReturnType<RemoteHostManager["reconcileForwards"]>>[number]
): ForwardMapping {
  return {
    forwardId: mapping.forwardId,
    workspaceId: mapping.workspaceId,
    remoteHost: mapping.remoteHost,
    remotePort: mapping.remotePort,
    localBindHost: mapping.localBindHost,
    localPort: mapping.localPort,
    status: mapping.status
  };
}

function requireRemoteWorkspace(
  state: AppState,
  targetId: Id,
  workspaceId: Id
): void {
  const workspace = state.workspaces[workspaceId];
  if (
    !workspace ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== targetId
  ) {
    throw new Error("remote forward workspace is outside its provider target");
  }
}

function requireRemoteSession(
  state: AppState,
  targetId: Id,
  sessionId: Id
): {
  surface: AppState["surfaces"][string];
  workspace: AppState["workspaces"][string];
} {
  const session = state.sessions[sessionId];
  const surface = session ? state.surfaces[session.surfaceId] : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  if (
    !surface ||
    !workspace ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== targetId
  ) {
    throw new Error("remote port session is outside its provider target");
  }
  return { surface, workspace };
}
