import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  encodeRemoteControlJson,
  encodeRemoteFrame,
  encodeRemoteTerminalWireMessage,
  RemoteFrameDecoder,
  uint64,
  type RemoteKeeperAttachRequest
} from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import {
  BridgeConnection,
  RemoteTerminalAttachment,
  resolveTerminalProxyCommand
} from "./linuxX64RemoteRuntime";

describe("Linux x64 remote terminal attachment", () => {
  it("uses the current proxy directly and a pinned cohort endpoint for incompatible keepers", () => {
    expect(
      resolveTerminalProxyCommand({ kind: "direct" }, "/opt/kmux/current/kmuxd")
    ).toEqual({
      runtimePath: "/opt/kmux/current/kmuxd",
      args: ["keeper", "proxy"]
    });
    expect(
      resolveTerminalProxyCommand(
        {
          kind: "cohort",
          executablePath: "/opt/kmux/pinned generation/kmuxd",
          socketPath: "/run/user/1000/kmux/cohort's.sock",
          keeperLocalProtocolMajor: 2
        },
        "/opt/kmux/current/kmuxd"
      )
    ).toEqual({
      runtimePath: "/opt/kmux/pinned generation/kmuxd",
      args: [
        "bridge",
        "cohort-proxy",
        "attach",
        "--socket-path",
        "/run/user/1000/kmux/cohort's.sock"
      ]
    });
  });

  it("enforces the attach replay sequence from the first mutation", async () => {
    const child = new FakeChildProcess();
    const attachment = new RemoteTerminalAttachment(
      child as unknown as ChildProcess,
      attachRequest()
    );
    child.sendControl(
      attachReady({
        replayFromSequence: "5",
        liveStartsAfterSequence: "4"
      })
    );
    await expect(attachment.ready).resolves.toMatchObject({
      replayFromSequence: 5n
    });
    child.sendMutation({
      kind: "output",
      sequence: uint64(5n),
      data: new TextEncoder().encode("ok")
    });
    await expect(attachment.nextMutation()).resolves.toMatchObject({
      sequence: 5n,
      kind: "output"
    });

    child.sendMutation({
      kind: "resize",
      sequence: uint64(7n),
      cols: 100,
      rows: 30
    });
    await expect(attachment.nextMutation()).rejects.toMatchObject({
      code: "mutation-gap"
    });
    expect(child.killed).toBe(true);
  });

  it("correlates a retry ack by lease and an advanced highest sequence", async () => {
    const child = new FakeChildProcess();
    const attachment = new RemoteTerminalAttachment(
      child as unknown as ChildProcess,
      attachRequest()
    );
    child.sendControl(attachReady({ writerLeaseId: "lease_1" }));
    await attachment.ready;
    const pending = attachment.sendInput(
      uint64(1n),
      new TextEncoder().encode("a")
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.sendControl({
      type: "input.ack",
      writerLeaseId: "lease_1",
      attachmentId: "attachment_1",
      highestAppliedInputSequence: "2",
      boundary: "pty-write"
    });
    await expect(pending).resolves.toMatchObject({
      highestAppliedInputSequence: "2",
      boundary: "pty-write"
    });
    child.close();
  });

  it("retires an attachment when an input acknowledgement times out", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const attachment = new RemoteTerminalAttachment(
        child as unknown as ChildProcess,
        attachRequest()
      );
      child.sendControl(attachReady({ writerLeaseId: "lease_1" }));
      await attachment.ready;
      const pending = attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode("a")
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timed-out"
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;

      expect(child.killed).toBe(true);
      expect(attachment.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects terminal mutations until the advertised checkpoint completes", async () => {
    const child = new FakeChildProcess();
    const attachment = new RemoteTerminalAttachment(
      child as unknown as ChildProcess,
      attachRequest()
    );
    child.sendControl(
      attachReady({ checkpointAvailable: true, liveStartsAfterSequence: "1" })
    );
    await attachment.ready;
    child.sendMutation({
      kind: "output",
      sequence: uint64(1n),
      data: new Uint8Array([1])
    });
    await expect(attachment.nextMutation()).rejects.toMatchObject({
      code: "protocol-error"
    });
    expect(child.killed).toBe(true);
    await attachment.checkpoint.catch(() => undefined);
  });

  it("closes instead of growing beyond the 4 MiB mutation queue", async () => {
    const child = new FakeChildProcess();
    const attachment = new RemoteTerminalAttachment(
      child as unknown as ChildProcess,
      attachRequest()
    );
    child.sendControl(attachReady());
    await attachment.ready;
    const data = new Uint8Array(256 * 1024 - 9);
    for (let sequence = 1n; sequence <= 16n && !child.killed; sequence += 1n) {
      child.sendMutation({ kind: "output", sequence: uint64(sequence), data });
    }
    expect(child.killed).toBe(true);
  });

  it("assembles bounded capture chunks and validates their final digest", async () => {
    const child = new FakeChildProcess();
    const bridge = new BridgeConnection(
      child as unknown as ChildProcess,
      bridgeOptions()
    );
    const pending = bridge.requestCapture(captureRequest());
    await eventually(() => child.controlRequests.length === 1);
    const requestId = child.controlRequests[0].requestId as string;
    child.sendControl(
      response(requestId, {
        type: "surface.capture-chunk",
        captureId: "capture_1",
        index: 0,
        text: "hello\n"
      })
    );
    child.sendControl(
      response(requestId, {
        type: "surface.capture-chunk",
        captureId: "capture_1",
        index: 1,
        text: "world"
      })
    );
    child.sendControl(
      response(requestId, {
        type: "surface.capture-completed",
        captureId: "capture_1",
        resourceKey: attachRequest().resourceKey,
        keeperGeneration: "keeper_1",
        mutationSequence: "9",
        cols: 80,
        rows: 24,
        lineCount: 2,
        byteLength: 11,
        chunkCount: 2,
        sha256: createHash("sha256").update("hello\nworld").digest("hex"),
        linesTruncated: false,
        bytesTruncated: false,
        retainedRangeTruncated: false
      })
    );

    await expect(pending).resolves.toMatchObject({
      captureId: "capture_1",
      mutationSequence: 9n,
      text: "hello\nworld",
      lineCount: 2,
      byteLength: 11
    });
    child.close();
  });

  it("kills the bridge channel on out-of-order or over-bound capture chunks", async () => {
    const child = new FakeChildProcess();
    const bridge = new BridgeConnection(
      child as unknown as ChildProcess,
      bridgeOptions()
    );
    const pending = bridge.requestCapture({
      ...captureRequest(),
      maxBytes: 4
    });
    await eventually(() => child.controlRequests.length === 1);
    const requestId = child.controlRequests[0].requestId as string;
    child.sendControl(
      response(requestId, {
        type: "surface.capture-chunk",
        captureId: "capture_1",
        index: 0,
        text: "oversized"
      })
    );

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    expect(child.killed).toBe(true);
  });

  it("retires the bridge generation when a request times out", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const bridge = new BridgeConnection(
        child as unknown as ChildProcess,
        bridgeOptions()
      );
      const pending = bridge.requestCapture(captureRequest());
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timed-out"
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;

      expect(child.killed).toBe(true);
      expect(bridge.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates bridge shutdown when the SSH channel ignores SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess({ ignoreTerm: true });
      const bridge = new BridgeConnection(
        child as unknown as ChildProcess,
        bridgeOptions()
      );

      const closing = bridge.close();
      await vi.advanceTimersByTimeAsync(7_000);
      await closing;

      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  closed = false;
  readonly killSignals: NodeJS.Signals[] = [];
  readonly controlRequests: Array<Record<string, unknown>> = [];
  private readonly inputDecoder = new RemoteFrameDecoder();

  constructor(private readonly options: { ignoreTerm?: boolean } = {}) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const frame of this.inputDecoder.push(chunk)) {
        if (frame.kind === 1) {
          this.controlRequests.push(
            JSON.parse(Buffer.from(frame.payload).toString("utf8")) as Record<
              string,
              unknown
            >
          );
        }
      }
    });
  }

  sendControl(value: unknown): void {
    this.stdout.write(encodeRemoteFrame(1, encodeRemoteControlJson(value)));
  }

  sendMutation(
    message: Parameters<typeof encodeRemoteTerminalWireMessage>[0]
  ): void {
    this.stdout.write(
      encodeRemoteFrame(2, encodeRemoteTerminalWireMessage(message))
    );
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return true;
    this.killSignals.push(signal);
    if (signal === "SIGTERM" && this.options.ignoreTerm) return true;
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.closed = true;
      this.emit("close", null, signal);
    });
    return true;
  }

  close(): void {
    this.kill("SIGTERM");
  }
}

function attachRequest(): RemoteKeeperAttachRequest {
  return {
    type: "keeper.attach",
    protocolVersion: 1,
    roots: {
      installRoot: "/tmp/install",
      authorityRoot: "/tmp/authority",
      stateRoot: "/tmp/state",
      runtimeRoot: "/tmp/run"
    },
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    },
    keeperGeneration: "keeper_1",
    attachCapability: "a".repeat(64),
    attachmentId: "attachment_1",
    access: "write"
  };
}

function bridgeOptions() {
  return {
    pool: {} as never,
    assigned: {} as never,
    runtimePath: "/tmp/kmuxd",
    transferRoot: "/tmp/kmux-remote-transfers",
    roots: attachRequest().roots,
    token: "token_1"
  };
}

function captureRequest() {
  return {
    type: "surface.capture" as const,
    resourceKey: attachRequest().resourceKey,
    expectedKeeperGeneration: "keeper_1",
    captureId: "capture_1",
    lineLimit: 20,
    maxBytes: 4096
  };
}

function response(requestId: string, body: unknown) {
  return {
    protocolVersion: 1,
    requestId,
    status: "ok",
    body
  };
}

function attachReady(
  overrides: Partial<{
    writerLeaseId: string;
    checkpointAvailable: boolean;
    cols: number;
    rows: number;
    earliestAvailableSequence: string;
    replayFromSequence: string;
    liveStartsAfterSequence: string;
  }> = {}
): unknown {
  return {
    type: "attach.ready",
    keeperGeneration: "keeper_1",
    attachmentId: "attachment_1",
    checkpointAvailable: false,
    cols: 80,
    rows: 24,
    earliestAvailableSequence: "1",
    replayFromSequence: "1",
    liveStartsAfterSequence: "0",
    ...overrides
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}
