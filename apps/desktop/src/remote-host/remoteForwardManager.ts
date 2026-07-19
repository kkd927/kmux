import { connect, createServer, isIP } from "node:net";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";

import type { Id, RemoteBridgeResponseBody } from "@kmux/proto";

import { spawnMuxOnlyChannel } from "./muxOnlyOpenSshChannel";
import type { AssignedSshMaster, SshTransportPool } from "./sshTransportPool";

const MAX_ACTIVE_FORWARDS = 64;
const FORWARD_READY_TIMEOUT_MS = 5_000;
const FORWARD_CLOSE_TIMEOUT_MS = 2_000;
const FORWARD_KILL_WAIT_MS = 250;
const COLLISION_RETRIES = 8;

export type RemoteDesiredForward = Extract<
  RemoteBridgeResponseBody,
  { type: "forwards.observed" }
>["forwards"][number];

export interface ActiveRemoteForward {
  forwardId: Id;
  workspaceId: Id;
  remoteHost: string;
  remotePort: number;
  localBindHost: "127.0.0.1" | "::1";
  requestedLocalPort?: number;
  localPort: number;
  status: "active";
}

export interface RemoteForwardManagerOptions {
  pool: SshTransportPool;
  assigned: AssignedSshMaster;
  spawnChannel?: typeof spawnMuxOnlyChannel;
  reservePort?: (host: "127.0.0.1" | "::1") => Promise<number>;
  isPortAvailable?: (
    host: "127.0.0.1" | "::1",
    port: number
  ) => Promise<boolean>;
  waitUntilListening?: (
    child: ChildProcess,
    host: "127.0.0.1" | "::1",
    port: number
  ) => Promise<void>;
}

interface ForwardEntry {
  descriptor: RemoteDesiredForward;
  mapping: ActiveRemoteForward;
  child: ChildProcess;
}

export class MuxOnlyRemoteForwardManager {
  private readonly entries = new Map<Id, ForwardEntry>();
  private readonly spawnChannel: typeof spawnMuxOnlyChannel;
  private readonly reservePort: NonNullable<
    RemoteForwardManagerOptions["reservePort"]
  >;
  private readonly waitUntilListening: NonNullable<
    RemoteForwardManagerOptions["waitUntilListening"]
  >;
  private readonly isPortAvailable: NonNullable<
    RemoteForwardManagerOptions["isPortAvailable"]
  >;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: RemoteForwardManagerOptions) {
    this.spawnChannel = options.spawnChannel ?? spawnMuxOnlyChannel;
    this.reservePort = options.reservePort ?? reserveLoopbackPort;
    this.isPortAvailable = options.isPortAvailable ?? loopbackPortIsAvailable;
    this.waitUntilListening = options.waitUntilListening ?? waitForLoopbackPort;
  }

  async reconcile(
    desired: RemoteDesiredForward[]
  ): Promise<ActiveRemoteForward[]> {
    if (this.closed) throw new Error("remote forward manager is closed");
    const requested = structuredClone(desired);
    validateDesiredForwards(requested, this.options.assigned.targetId);
    if (requested.length > MAX_ACTIVE_FORWARDS) {
      throw new Error("remote forward limit exceeds 64");
    }
    return await this.enqueue(async () => {
      const desiredIds = new Set(requested.map((forward) => forward.forwardId));
      for (const descriptor of requested) await this.ensure(descriptor);
      await Promise.all(
        [...this.entries]
          .filter(([forwardId]) => !desiredIds.has(forwardId))
          .map(([forwardId]) => this.remove(forwardId))
      );
      return this.list();
    });
  }

  list(): ActiveRemoteForward[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.mapping))
      .sort((left, right) => left.forwardId.localeCompare(right.forwardId));
  }

  async closeWorkspace(workspaceId: Id): Promise<void> {
    if (this.closed) {
      await this.closePromise;
      return;
    }
    await this.enqueue(async () => {
      await Promise.all(
        [...this.entries.values()]
          .filter((entry) => entry.mapping.workspaceId === workspaceId)
          .map((entry) => this.remove(entry.mapping.forwardId))
      );
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    this.closed = true;
    this.closePromise = this.enqueue(async () => {
      await Promise.allSettled(
        [...this.entries.keys()].map((forwardId) => this.remove(forwardId))
      );
    });
    await this.closePromise;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }

  private async ensure(descriptor: RemoteDesiredForward): Promise<void> {
    const existing = this.entries.get(descriptor.forwardId);
    if (existing && canReuseForward(existing, descriptor)) {
      existing.descriptor = structuredClone(descriptor);
      const mapping = { ...existing.mapping };
      if (descriptor.localPort === undefined) {
        delete mapping.requestedLocalPort;
      } else {
        mapping.requestedLocalPort = descriptor.localPort;
      }
      existing.mapping = mapping;
      return;
    }
    if (existing) await this.remove(descriptor.forwardId);

    const requestedPort = descriptor.localPort ?? descriptor.remotePort;
    const attempted = new Set<number>();
    let lastError: unknown;
    for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
      const localPort =
        attempt === 0
          ? requestedPort
          : await this.reservePort(descriptor.localBindHost);
      if (attempted.has(localPort)) continue;
      attempted.add(localPort);
      if (!(await this.isPortAvailable(descriptor.localBindHost, localPort))) {
        lastError = new Error("requested loopback port is already occupied");
        continue;
      }
      let child: ChildProcess | undefined;
      try {
        child = await this.spawn(descriptor, localPort);
        await this.waitUntilListening(
          child,
          descriptor.localBindHost,
          localPort
        );
        const mapping: ActiveRemoteForward = {
          forwardId: descriptor.forwardId,
          workspaceId: descriptor.resourceKey.workspaceId,
          remoteHost: descriptor.remoteHost,
          remotePort: descriptor.remotePort,
          localBindHost: descriptor.localBindHost,
          ...(descriptor.localPort === undefined
            ? {}
            : { requestedLocalPort: descriptor.localPort }),
          localPort,
          status: "active"
        };
        const entry = {
          descriptor: structuredClone(descriptor),
          mapping,
          child
        };
        this.entries.set(descriptor.forwardId, entry);
        child.once("close", () => {
          if (this.entries.get(descriptor.forwardId) === entry) {
            this.entries.delete(descriptor.forwardId);
          }
        });
        return;
      } catch (error) {
        lastError = error;
        if (child) await terminateForward(child);
      }
    }
    throw new Error(
      `failed to bind a loopback SSH forward after ${COLLISION_RETRIES} attempts`,
      { cause: lastError }
    );
  }

  private async spawn(
    descriptor: RemoteDesiredForward,
    localPort: number
  ): Promise<ChildProcess> {
    const assigned = this.options.assigned;
    const master = assigned.master;
    return await this.spawnChannel(
      {
        kind: "local-forward",
        sshPath: master.sshPath,
        configPath: master.configPath,
        controlPath: master.controlPath,
        host: master.host,
        masterGeneration: assigned.generation,
        localBindHost: descriptor.localBindHost,
        localPort,
        remoteHost: descriptor.remoteHost,
        remotePort: descriptor.remotePort
      },
      {
        isCurrentGeneration: (generation) =>
          this.options.pool.isCurrentGeneration(assigned.targetId, generation)
      }
    );
  }

  private async remove(forwardId: Id): Promise<void> {
    const entry = this.entries.get(forwardId);
    if (!entry) return;
    this.entries.delete(forwardId);
    await terminateForward(entry.child);
  }
}

function validateDesiredForwards(
  desired: RemoteDesiredForward[],
  targetId: Id
): void {
  const ids = new Set<Id>();
  for (const descriptor of desired) {
    if (
      descriptor.resourceKey.targetId !== targetId ||
      descriptor.resourceKey.sessionId !== undefined ||
      ids.has(descriptor.forwardId) ||
      (descriptor.localBindHost !== "127.0.0.1" &&
        descriptor.localBindHost !== "::1") ||
      !validPort(descriptor.remotePort) ||
      (descriptor.localPort !== undefined &&
        !validPort(descriptor.localPort)) ||
      !validForwardHost(descriptor.remoteHost)
    ) {
      throw new TypeError("desired forward is invalid or outside its target");
    }
    ids.add(descriptor.forwardId);
  }
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function validForwardHost(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value) &&
    (isIP(value) !== 0 || /^[A-Za-z0-9._-]+$/u.test(value))
  );
}

function canReuseForward(
  existing: ForwardEntry,
  desired: RemoteDesiredForward
): boolean {
  const left = existing.descriptor;
  return (
    left.resourceKey.desktopInstallationId ===
      desired.resourceKey.desktopInstallationId &&
    left.resourceKey.targetId === desired.resourceKey.targetId &&
    left.resourceKey.workspaceId === desired.resourceKey.workspaceId &&
    left.forwardId === desired.forwardId &&
    left.remoteHost === desired.remoteHost &&
    left.remotePort === desired.remotePort &&
    left.localBindHost === desired.localBindHost &&
    (left.localPort === desired.localPort ||
      desired.localPort === existing.mapping.localPort)
  );
}

async function reserveLoopbackPort(host: "127.0.0.1" | "::1"): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, host, () => resolveListen());
    });
    const address = server.address() as AddressInfo | null;
    if (!address || !validPort(address.port)) {
      throw new Error("failed to reserve a loopback port");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose())
      );
    }
  }
}

async function waitForLoopbackPort(
  child: ChildProcess,
  host: "127.0.0.1" | "::1",
  port: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < FORWARD_READY_TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("SSH forward exited before its listener became ready");
    }
    if (await canConnect(host, port)) {
      await delay(50);
      if (child.exitCode === null && child.signalCode === null) return;
      throw new Error("SSH forward exited during listener stabilization");
    }
    await delay(20);
  }
  throw new Error("SSH forward listener readiness timed out");
}

async function loopbackPortIsAvailable(
  host: "127.0.0.1" | "::1",
  port: number
): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolveAvailability) => {
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      if (server.listening) {
        server.close(() => resolveAvailability(available));
      } else {
        resolveAvailability(available);
      }
    };
    server.once("error", () => finish(false));
    server.listen(port, host, () => finish(true));
  });
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveConnection) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(value);
    };
    socket.setTimeout(100);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function terminateForward(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let didClose = false;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = (): void => {
    didClose = true;
    resolveClose?.();
  };
  child.once("close", onClose);
  child.kill("SIGTERM");
  await Promise.race([closed, delay(FORWARD_CLOSE_TIMEOUT_MS)]);
  if (!didClose && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (!didClose) {
    await Promise.race([closed, delay(FORWARD_KILL_WAIT_MS)]);
  }
  if (!didClose) child.removeListener("close", onClose);
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, durationMs);
    timer.unref();
  });
}
