import { EventEmitter } from "node:events";
import type { MessagePortMain, UtilityProcess } from "electron";

import { parseUint64Decimal } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import {
  RemoteHostManager,
  resolveRemoteHostLaunchOptions
} from "./remoteHost";

describe("RemoteHostManager", () => {
  it("resolves the sibling utility entry from the bundled Main directory", () => {
    expect(resolveRemoteHostLaunchOptions("/app/out/main")).toEqual({
      entry: "/app/out/main/remoteHost.js",
      cwd: "/app/out/main"
    });
  });

  it("round-trips and strictly validates utility-owned OpenSSH config resolution", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    manager.on("error", vi.fn());
    manager.start();

    const resolving = manager.resolveSshConfig({
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias"
    });
    const request = child.messages[0]?.message as { requestId: string };
    expect(child.messages[0]?.message).toMatchObject({
      type: "ssh-config.resolve",
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias"
    });
    child.emit("message", {
      type: "response",
      requestId: request.requestId,
      status: "ok",
      body: {
        type: "ssh-config.resolved",
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias",
        effective: {
          hostName: "target.internal",
          user: "kmux",
          port: 2222,
          identityFiles: ["/tmp/id_ed25519"],
          canonicalLines: ["hostname target.internal", "user kmux"],
          policyHash: "a".repeat(64)
        }
      }
    });
    await expect(resolving).resolves.toEqual({
      hostName: "target.internal",
      user: "kmux",
      port: 2222,
      identityFiles: ["/tmp/id_ed25519"],
      canonicalLines: ["hostname target.internal", "user kmux"],
      policyHash: "a".repeat(64)
    });

    const malformed = manager.resolveSshConfig({
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias"
    });
    const malformedRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: malformedRequest.requestId,
      status: "ok",
      body: {
        type: "ssh-config.resolved",
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "other-alias",
        effective: {}
      }
    });
    await expect(malformed).rejects.toThrow(/another OpenSSH configuration/u);
  });

  it("re-decodes nested bridge results at the UtilityProcess boundary", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    manager.on("error", vi.fn());
    manager.start();

    const inspection = manager.inspectGit({
      targetId: "target_1",
      desktopInstallationId: "desktop_1",
      cwd: "/srv/app",
      dirtyLimit: 8
    });
    const request = child.messages.at(-1)?.message as { requestId: string };
    child.emit("message", {
      type: "response",
      requestId: request.requestId,
      status: "ok",
      body: {
        type: "git.inspected",
        targetId: "target_1",
        inspection: {
          type: "git.inspected",
          cwd: "/srv/app",
          dirtyEntries: [42],
          dirtyEntriesTruncated: false
        }
      }
    });

    await expect(inspection).rejects.toThrow(/dirty entry/u);
  });

  it("transfers terminal ports without relaying bytes through Main", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    const errors: Error[] = [];
    const cursors: unknown[] = [];
    const targetLosses: unknown[] = [];
    manager.on("error", (error: Error) => errors.push(error));
    manager.on("cursor", (cursor) => cursors.push(cursor));
    manager.on("target-lost", (event) => targetLosses.push(event));
    manager.start({ PATH: "/usr/bin" });

    const rendererPort = new EventEmitter() as unknown as MessagePortMain;
    expect(
      manager.bindTerminalStream(
        {
          targetId: "target_1",
          attachId: "attach_1",
          session: {
            surfaceId: "surface_1",
            sessionId: "session_1",
            epoch: "keeper_1"
          },
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId: "workspace_1",
            sessionId: "session_1"
          },
          expectedKeeperGeneration: "keeper_1"
        },
        rendererPort
      )
    ).toBe(true);
    expect(child.messages.at(-1)).toMatchObject({
      message: { type: "terminal.bind", attachId: "attach_1" },
      ports: [rendererPort]
    });

    rendererPort.emit("message", {
      data: {
        type: "delta",
        data: "must stay between renderer and remote-host"
      }
    });
    expect(cursors).toEqual([]);
    expect(child.messages).toHaveLength(1);

    child.emit("message", {
      type: "terminal.cursor",
      targetId: "target_1",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1",
        sessionId: "session_1"
      },
      keeperGeneration: "keeper_1",
      sequence: 9n
    });
    expect(cursors).toEqual([
      expect.objectContaining({ type: "terminal.cursor", sequence: 9n })
    ]);
    child.emit("message", {
      type: "target.lost",
      targetId: "target_1",
      masterGeneration: "master_1",
      code: "master-closed",
      message: "assigned OpenSSH master exited"
    });
    expect(targetLosses).toEqual([
      expect.objectContaining({
        type: "target.lost",
        targetId: "target_1",
        masterGeneration: "master_1"
      })
    ]);
    expect(errors).toEqual([]);

    const stopped = manager.stop();
    const shutdown = child.messages.at(-1)?.message as { requestId: string };
    child.emit("message", {
      type: "response",
      requestId: shutdown.requestId,
      status: "ok",
      body: { type: "shutdown.complete" }
    });
    await stopped;
    child.emit("exit", 0);
    expect(errors).toEqual([]);
  });

  it("validates provisional authority evidence before promoting an immutable target", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess,
      {
        runtimeArtifactRoot: "/opt/kmux/remote-runtime",
        transferRoot: "/tmp/kmux-remote-transfers"
      }
    );
    manager.on("error", vi.fn());
    manager.start();
    const roots = {
      installRoot: "/home/kmux/.kmux",
      authorityRoot: "/home/kmux/.kmux/state/authority",
      stateRoot: "/home/kmux/.kmux/state",
      runtimeRoot: "/tmp/kmux-runtime-1000"
    };
    const generation = `1+${"c".repeat(64)}`;
    const verifying = manager.verifyTarget({
      verificationId: "verification_1",
      connectionAttemptId: "attempt_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias",
      rootOverrides: roots
    });
    const verifyRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    expect(child.messages.at(-1)?.message).toMatchObject({
      type: "target.verify",
      runtimeArtifactRoot: "/opt/kmux/remote-runtime",
      transferRoot: "/tmp/kmux-remote-transfers"
    });
    child.emit("message", {
      type: "response",
      requestId: verifyRequest.requestId,
      status: "ok",
      body: {
        type: "target.verified",
        verificationId: "verification_1",
        effectiveConnectionPolicyHash: "a".repeat(64),
        generation,
        runtimePath: `${roots.installRoot}/bin/${generation}/kmuxd`,
        remoteHome: "/home/kmux",
        roots,
        doctor: {
          remoteInstallationId: "11111111-1111-4111-8111-111111111111",
          executionNodeId: "22222222-2222-4222-8222-222222222222",
          authenticatedPrincipal: { uid: 1000, accountName: "kmux" },
          platform: "linux",
          arch: "x86_64",
          abi: "musl",
          ...roots
        }
      }
    });
    await expect(verifying).resolves.toMatchObject({
      verificationId: "verification_1",
      generation,
      doctor: {
        remoteInstallationId: "11111111-1111-4111-8111-111111111111"
      }
    });

    const promoting = manager.promoteVerifiedTarget({
      verificationId: "verification_1",
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      token: "b".repeat(64)
    });
    const promoteRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: promoteRequest.requestId,
      status: "ok",
      body: {
        type: "target.ready",
        targetId: "target_1",
        hello: hello()
      }
    });
    await expect(promoting).resolves.toMatchObject({
      type: "hello",
      bridgeGeneration: "bridge_1"
    });
  });

  it("rejects pending requests when the utility process is lost", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    manager.on("error", vi.fn());
    const lost = vi.fn();
    manager.on("runtime-lost", lost);
    manager.start();
    const observation = manager.observe("target_1", "desktop_1");

    child.emit("exit", 1);

    await expect(observation).rejects.toThrow(/exited/u);
    expect(lost).toHaveBeenCalledOnce();
    expect(manager.isRunning()).toBe(false);
  });

  it("retires the utility generation when a request times out", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      const manager = new RemoteHostManager(
        () => child as unknown as UtilityProcess
      );
      manager.on("error", vi.fn());
      manager.start();

      const observation = manager.observe("target_1", "desktop_1");
      const rejection = expect(observation).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(child.killed).toBe(true);
      await vi.runAllTimersAsync();
      expect(manager.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates input, capture, and event results across the utility boundary", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    manager.on("error", vi.fn());
    manager.start();
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    } as const;

    const injection = manager.injectTerminal("target_1", {
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      operationId: "operation_1",
      payloadHash: "a".repeat(64),
      input: "hello"
    });
    const injectionRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    expect(child.messages.at(-1)?.message).toMatchObject({
      type: "terminal.inject",
      targetId: "target_1",
      injection: { operationId: "operation_1", input: "hello" }
    });
    child.emit("message", {
      type: "response",
      requestId: injectionRequest.requestId,
      status: "ok",
      body: {
        type: "terminal.input-ack",
        targetId: "target_1",
        acknowledgement: {
          resourceKey,
          keeperGeneration: "keeper_1",
          operationId: "operation_1",
          writerLeaseId: "lease_1",
          byteLength: 5,
          boundary: "pty-write"
        }
      }
    });
    await expect(injection).resolves.toMatchObject({
      operationId: "operation_1",
      boundary: "pty-write"
    });

    const capture = manager.captureSurface("target_1", {
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      captureId: "capture_1",
      lineLimit: 20,
      maxBytes: 4096
    });
    const captureRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: captureRequest.requestId,
      status: "ok",
      body: {
        type: "surface.captured",
        targetId: "target_1",
        capture: {
          captureId: "capture_1",
          resourceKey,
          keeperGeneration: "keeper_1",
          mutationSequence: 9n,
          cols: 120,
          rows: 40,
          text: "line 1\nline 2",
          lineCount: 2,
          byteLength: 13,
          linesTruncated: false,
          bytesTruncated: false,
          retainedRangeTruncated: false
        }
      }
    });
    await expect(capture).resolves.toMatchObject({
      captureId: "capture_1",
      mutationSequence: 9n,
      lineCount: 2,
      byteLength: 13
    });

    const replay = manager.replayEvents(
      "target_1",
      "desktop_1",
      parseUint64Decimal("0")
    );
    const replayRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: replayRequest.requestId,
      status: "ok",
      body: {
        type: "events.replayed",
        targetId: "target_1",
        replay: {
          targetId: "target_1",
          events: [
            {
              version: 1,
              sequence: "1",
              eventId: "event_1",
              kind: "agent-hook",
              name: "codex.Stop",
              resourceKey,
              surfaceId: "surface_1",
              keeperGeneration: "keeper_1",
              createdAtUnixMs: "1",
              payload: { message: "done" }
            }
          ],
          acknowledgedThrough: 0n,
          hasMore: false,
          admittedCount: 1n,
          droppedLowValueCount: 0n
        }
      }
    });
    await expect(replay).resolves.toMatchObject({
      targetId: "target_1",
      acknowledgedThrough: 0n,
      events: [{ eventId: "event_1", sequence: "1" }]
    });

    const acknowledgement = manager.acknowledgeEvents(
      "target_1",
      "desktop_1",
      parseUint64Decimal("1")
    );
    const acknowledgementRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: acknowledgementRequest.requestId,
      status: "ok",
      body: {
        type: "events.acknowledged",
        targetId: "target_1",
        acknowledgedThrough: 1n
      }
    });
    await expect(acknowledgement).resolves.toBe(1n);

    const invalidCapture = manager.captureSurface("target_1", {
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      captureId: "capture_bad",
      lineLimit: 1,
      maxBytes: 16
    });
    const invalidCaptureRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: invalidCaptureRequest.requestId,
      status: "ok",
      body: {
        type: "surface.captured",
        targetId: "target_1",
        capture: {
          captureId: "capture_bad",
          resourceKey,
          keeperGeneration: "keeper_1",
          mutationSequence: 10n,
          cols: 80,
          rows: 24,
          text: "too long",
          lineCount: 1,
          byteLength: 1,
          linesTruncated: false,
          bytesTruncated: false,
          retainedRangeTruncated: false
        }
      }
    });
    await expect(invalidCapture).rejects.toThrow(/invalid surface capture/u);
  });

  it("strictly validates bounded runtime clean and reset reports", async () => {
    const child = new FakeUtilityProcess();
    const manager = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    manager.on("error", vi.fn());
    manager.start();
    const generation = `1+${"c".repeat(64)}`;

    const cleaning = manager.cleanTargetRuntime("target_1");
    const cleanRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: cleanRequest.requestId,
      status: "ok",
      body: {
        type: "target.runtime-cleaned",
        targetId: "target_1",
        report: {
          inspected: 1,
          removed: [],
          live: [generation],
          incompleteOrCorrupt: []
        }
      }
    });
    await expect(cleaning).resolves.toEqual({
      inspected: 1,
      removed: [],
      live: [generation],
      incompleteOrCorrupt: []
    });

    const resetting = manager.resetTargetRuntime("target_1");
    const resetRequest = child.messages.at(-1)?.message as {
      requestId: string;
    };
    child.emit("message", {
      type: "response",
      requestId: resetRequest.requestId,
      status: "ok",
      body: {
        type: "target.runtime-reset",
        targetId: "target_1",
        report: {
          generation,
          status: "reset",
          installRoot: "/"
        }
      }
    });
    await expect(resetting).rejects.toThrow(/unexpected field installRoot/u);
  });
});

class FakeUtilityProcess extends EventEmitter {
  readonly messages: Array<{ message: unknown; ports: unknown[] }> = [];
  killed = false;

  postMessage(message: unknown, ports: unknown[] = []): void {
    this.messages.push({ message, ports });
  }

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
}

function hello() {
  return {
    type: "hello",
    protocolVersion: 1,
    runtimeVersion: "0.1.0",
    bridgeGeneration: "bridge_1",
    capabilities: ["terminal-v1"],
    authority: {
      remoteInstallationId: "installation_1",
      executionNodeId: "node_1",
      authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
    },
    platform: "linux",
    arch: "x86_64",
    abi: "musl",
    persistenceLevel: "ssh-disconnect"
  } as const;
}
