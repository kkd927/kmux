import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  MuxOnlyRemoteForwardManager,
  type RemoteDesiredForward
} from "./remoteForwardManager";

describe("MuxOnlyRemoteForwardManager", () => {
  it("retries a colliding requested port and reports the actual loopback mapping", async () => {
    const children: FakeForwardChild[] = [];
    const spawnChannel = vi.fn(async () => {
      const child = new FakeForwardChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const waitUntilListening = vi.fn().mockResolvedValue(undefined);
    const manager = new MuxOnlyRemoteForwardManager({
      pool: { isCurrentGeneration: () => true } as never,
      assigned: assigned() as never,
      spawnChannel,
      reservePort: async () => 45_321,
      isPortAvailable: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      waitUntilListening
    });

    await expect(
      manager.reconcile([desired({ localPort: 3_000 })])
    ).resolves.toEqual([
      {
        forwardId: "forward_1",
        workspaceId: "workspace_1",
        remoteHost: "127.0.0.1",
        remotePort: 3_000,
        localBindHost: "127.0.0.1",
        requestedLocalPort: 3_000,
        localPort: 45_321,
        status: "active"
      }
    ]);
    expect(
      (
        spawnChannel.mock.calls as unknown as Array<[{ localPort: number }]>
      ).map(([request]) => request.localPort)
    ).toEqual([45_321]);

    await manager.reconcile([]);
    expect(children[0].killCount).toBe(1);
    expect(manager.list()).toEqual([]);
    await manager.close();
  });

  it("rejects a desired descriptor from another target before spawning", async () => {
    const spawnChannel = vi.fn();
    const manager = new MuxOnlyRemoteForwardManager({
      pool: { isCurrentGeneration: () => true } as never,
      assigned: assigned() as never,
      spawnChannel
    });

    await expect(
      manager.reconcile([
        desired({
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_2",
            workspaceId: "workspace_1"
          }
        })
      ])
    ).rejects.toThrow(/outside/u);
    expect(spawnChannel).not.toHaveBeenCalled();
    await manager.close();
  });

  it("escalates and waits for close when an SSH forward ignores SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeForwardChild({ ignoreTerm: true });
      const manager = new MuxOnlyRemoteForwardManager({
        pool: { isCurrentGeneration: () => true } as never,
        assigned: assigned() as never,
        spawnChannel: vi.fn(async () => child as unknown as ChildProcess),
        isPortAvailable: async () => true,
        waitUntilListening: async () => undefined
      });
      await manager.reconcile([desired()]);

      const removing = manager.reconcile([]);
      await vi.advanceTimersByTimeAsync(2_000);
      await removing;

      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a forward whose reconcile was already opening", async () => {
    let resolveSpawn: ((child: ChildProcess) => void) | undefined;
    const spawning = new Promise<ChildProcess>((resolve) => {
      resolveSpawn = resolve;
    });
    const child = new FakeForwardChild();
    const manager = new MuxOnlyRemoteForwardManager({
      pool: { isCurrentGeneration: () => true } as never,
      assigned: assigned() as never,
      spawnChannel: vi.fn(async () => await spawning),
      isPortAvailable: async () => true,
      waitUntilListening: async () => undefined
    });

    const reconciling = manager.reconcile([desired()]);
    const closing = manager.close();
    resolveSpawn?.(child as unknown as ChildProcess);

    await expect(reconciling).resolves.toHaveLength(1);
    await closing;
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(manager.list()).toEqual([]);
    await expect(manager.reconcile([desired()])).rejects.toThrow(/closed/u);
  });
});

class FakeForwardChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCount = 0;
  killSignals: NodeJS.Signals[] = [];
  closed = false;

  constructor(private readonly options: { ignoreTerm?: boolean } = {}) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killCount += 1;
    this.killSignals.push(signal);
    if (signal === "SIGTERM" && this.options.ignoreTerm) return true;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.closed = true;
      this.emit("close", null, signal);
    });
    return true;
  }
}

function assigned() {
  return {
    targetId: "target_1",
    generation: "master_1",
    effectiveConnectionPolicyHash: "a".repeat(64),
    master: {
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh-config",
      controlPath: "/tmp/control.sock",
      host: "target-alias",
      generation: "master_1"
    }
  };
}

function desired(
  patch: Partial<RemoteDesiredForward> = {}
): RemoteDesiredForward {
  return {
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1"
    },
    forwardId: "forward_1",
    remoteHost: "127.0.0.1",
    remotePort: 3_000,
    localBindHost: "127.0.0.1",
    operationId: "operation_1",
    remoteResourceRevision: "1",
    ...patch
  };
}
