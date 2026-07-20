import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import {
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64,
  type TerminalDataPlaneClientMessage,
  type TerminalDataPlaneHostMessage
} from "@kmux/proto";
import { describe, expect, it } from "vitest";

import type { RemoteTerminalMutation } from "./linuxX64RemoteRuntime";
import {
  RemoteHostService,
  type RemoteHostControlTransport
} from "./remoteHostService";
import type {
  RemoteTerminalAttachmentLike,
  RemoteTerminalDataPortLike
} from "./remoteTerminalDataPlane";
import type { SshTransportPool } from "./sshTransportPool";
import type { PreparedRemoteRuntime } from "./remoteRuntimeBootstrap";
import type { RemoteHostResponse } from "../shared/remoteHostProtocol";

describe("RemoteHostService", () => {
  it("owns bounded OpenSSH effective-config resolution in the utility process", async () => {
    const transport = new FakeControlTransport();
    const pool = new FakePool();
    const resolved: unknown[] = [];
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      resolveSshConfig: async (request) => {
        resolved.push(structuredClone(request));
        return {
          hostName: "target.internal",
          user: "kmux",
          port: 2222,
          identityFiles: ["/tmp/id_ed25519"],
          canonicalLines: ["hostname target.internal", "user kmux"],
          policyHash: "a".repeat(64)
        };
      },
      createRuntime: () => new FakeRuntime(new FakeAttachment()) as never
    });
    service.start();

    transport.receive({
      type: "ssh-config.resolve",
      requestId: "resolve_config_1",
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias"
    });

    await eventually(() => transport.sent.length === 1);
    expect(resolved).toEqual([
      {
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias"
      }
    ]);
    expect(transport.sent[0]).toMatchObject({
      type: "response",
      requestId: "resolve_config_1",
      status: "ok",
      body: {
        type: "ssh-config.resolved",
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias",
        effective: {
          hostName: "target.internal",
          policyHash: "a".repeat(64)
        }
      }
    });
    await service.close();
  });

  it("reserves the verification limit before asynchronous bootstrap completes", async () => {
    const transport = new FakeControlTransport();
    const pool = new FakePool();
    const pendingPreparations: Array<
      (prepared: PreparedRemoteRuntime) => void
    > = [];
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime: () =>
        new Promise<PreparedRemoteRuntime>((resolve) => {
          pendingPreparations.push(resolve);
        }),
      createRuntime: () => new FakeRuntime(new FakeAttachment()) as never
    });
    service.start();

    for (let index = 0; index < 65; index += 1) {
      transport.receive({
        type: "target.verify",
        requestId: `verify_limit_${index}`,
        verificationId: `verification_limit_${index}`,
        connectionAttemptId: `attempt_limit_${index}`,
        effectiveConnectionPolicyHash: "a".repeat(64),
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias",
        runtimeArtifactRoot: "/opt/kmux/remote-runtime",
        transferRoot: "/tmp/kmux-remote-transfers",
        rootOverrides: runtimeRoots()
      });
    }

    await eventually(
      () =>
        pendingPreparations.length === 64 &&
        transport.sent.some(
          (response) =>
            response.type === "response" &&
            response.requestId === "verify_limit_64" &&
            response.status === "error"
        )
    );
    expect(
      transport.sent.find(
        (response) =>
          response.type === "response" &&
          response.requestId === "verify_limit_64"
      )
    ).toMatchObject({
      status: "error",
      error: { code: "verification-limit", retryable: false }
    });

    for (const resolve of pendingPreparations) {
      resolve(makePreparedRuntime());
    }
    await eventually(() => transport.sent.length === 65);
    await service.close();
  });

  it("rejects promotion past the bounded connected-target limit", async () => {
    const transport = new FakeControlTransport();
    const pool = new FakePool();
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      maximumConnectedTargets: 1,
      prepareRuntime,
      createRuntime: () => new FakeRuntime(new FakeAttachment()) as never
    });
    service.start();

    await connectTarget(transport, "connect_first", "target_1");
    const responseCount = await beginTargetConnection(
      transport,
      "connect_over_limit",
      "target_2"
    );
    await eventually(() => transport.sent.length === responseCount + 2);

    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "connect_over_limit",
      status: "error",
      error: { code: "target-limit", retryable: false }
    });
    expect(pool.assignedTargetIds).toEqual(["target_1"]);
    await service.close();
  });

  it("bootstraps under a verification identity and publishes the target only after authority promotion", async () => {
    const transport = new FakeControlTransport();
    const runtime = new FakeRuntime(new FakeAttachment());
    const pool = new FakePool();
    const rotations: unknown[] = [];
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime: async () =>
        makePreparedRuntime((rotation) =>
          rotations.push(structuredClone(rotation))
        ),
      createRuntime: () => runtime as never
    });
    service.start();

    transport.receive({
      type: "target.verify",
      requestId: "verify_1",
      verificationId: "verification_1",
      connectionAttemptId: "attempt_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias",
      runtimeArtifactRoot: "/opt/kmux/remote-runtime",
      transferRoot: "/tmp/kmux-remote-transfers",
      rootOverrides: runtimeRoots()
    });
    await eventually(() => transport.sent.length === 1);

    expect(pool.assignedTargetIds).toEqual([]);
    expect(transport.sent[0]).toMatchObject({
      type: "response",
      requestId: "verify_1",
      status: "ok",
      body: {
        type: "target.verified",
        verificationId: "verification_1",
        doctor: {
          authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
        }
      }
    });

    transport.receive({
      type: "target.promote",
      requestId: "promote_1",
      verificationId: "verification_1",
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      retentionPolicy: {
        sessionQuotaMiB: 256,
        targetQuotaMiB: 2 * 1024
      },
      token: "b".repeat(64)
    });
    await eventually(() => transport.sent.length === 2);

    expect(pool.assignedTargetIds).toEqual(["target_1"]);
    expect(rotations).toEqual([
      {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        token: "b".repeat(64)
      }
    ]);
    expect(transport.sent[1]).toMatchObject({
      type: "response",
      requestId: "promote_1",
      status: "ok",
      body: { type: "target.ready", targetId: "target_1" }
    });
    await service.close();
  });

  it("keeps every attachment byte on the transferred port and emits only cursor metadata to Main", async () => {
    const transport = new FakeControlTransport();
    const attachment = new FakeAttachment();
    const runtime = new FakeRuntime(attachment);
    const pool = new FakePool();
    const rotations: unknown[] = [];
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime: async () =>
        makePreparedRuntime((rotation) =>
          rotations.push(structuredClone(rotation))
        ),
      createRuntime: () => runtime as never
    });
    service.start();

    await connectTarget(transport, "connect_1");
    expect(transport.sent[1]).toMatchObject({
      type: "response",
      requestId: "connect_1",
      status: "ok",
      body: { type: "target.ready", targetId: "target_1" }
    });
    expect(rotations).toEqual([
      {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        token: "b".repeat(64)
      }
    ]);

    const port = new FakeTerminalPort();
    transport.receive(
      {
        type: "terminal.bind",
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
      [port]
    );
    port.receive({
      ...envelope(),
      type: "attach",
      resumeFromSequence: uint64(0n),
      creditBytes: 128 * 1024
    });
    await eventually(() => port.sent[0]?.type === "attached");

    attachment.pushMutation({
      kind: "output",
      sequence: uint64(1n),
      data: new TextEncoder().encode("agent output\n")
    });
    await eventually(() =>
      port.sent.some((message) => message.type === "delta")
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: {
        type: "output",
        sequence: 1n,
        segments: [{ data: "agent output\n" }]
      }
    });
    expect(transport.sent).toHaveLength(2);

    port.receive({
      ...envelope(),
      type: "credit",
      acknowledgedSequence: uint64(1n),
      bytes: 13
    });
    port.receive({
      ...envelope(),
      type: "input:text",
      text: "echo input\n"
    });
    await eventually(() => attachment.inputs.length === 1);
    expect(new TextDecoder().decode(attachment.inputs[0])).toBe("echo input\n");
    expect(transport.sent).toHaveLength(2);

    port.receive({ ...envelope(), type: "detach", reason: "hidden" });
    await eventually(() =>
      transport.sent.some((message) => message.type === "terminal.cursor")
    );
    expect(transport.sent).toEqual([
      expect.objectContaining({
        type: "response",
        requestId: "connect_1_verify"
      }),
      expect.objectContaining({ type: "response", requestId: "connect_1" }),
      expect.objectContaining({
        type: "terminal.cursor",
        targetId: "target_1",
        keeperGeneration: "keeper_1",
        sequence: 1n
      })
    ]);
    expect(
      transport.sent.some((message) =>
        [
          "delta",
          "checkpoint:begin",
          "checkpoint:chunk",
          "checkpoint:end",
          "input:text",
          "resize",
          "credit"
        ].includes(message.type)
      )
    ).toBe(false);
    expect(attachment.detached).toBe(true);

    await service.close();
    expect(pool.closed).toBe(true);
  });

  it("waits for accepted target queues before closing runtimes and the shared pool", async () => {
    const transport = new FakeControlTransport();
    const events: string[] = [];
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const runtime = {
      async connect() {
        await connectGate;
        events.push("runtime.connected");
        return hello();
      },
      executeOperation: () => Promise.reject(new Error("not used")),
      observe: () => Promise.reject(new Error("not used")),
      attach: () => Promise.reject(new Error("not used")),
      async close() {
        events.push("runtime.closed");
      }
    };
    const pool = new FakePool();
    pool.onClose = () => events.push("pool.closed");
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await beginTargetConnection(transport, "connect_race");

    const closing = service.close();
    let duplicateCloseSettled = false;
    const duplicateClosing = service.close().then(() => {
      duplicateCloseSettled = true;
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(duplicateCloseSettled).toBe(false);
    releaseConnect();
    await Promise.all([closing, duplicateClosing]);

    expect(events).toEqual([
      "runtime.connected",
      "runtime.closed",
      "pool.closed"
    ]);
  });

  it("bounds active terminal attachments and reports an explicit bind failure", async () => {
    const transport = new FakeControlTransport();
    const runtime = new FakeRuntime(new FakeAttachment());
    const pool = new FakePool();
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_limit");

    for (let index = 0; index < 1_024; index += 1) {
      transport.receive(terminalBindRequest(`attach_${index}`), [
        new FakeTerminalPort()
      ]);
    }
    const rejectedPort = new FakeTerminalPort();
    transport.receive(terminalBindRequest("attach_over_limit"), [rejectedPort]);

    expect(rejectedPort.closed).toBe(true);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "terminal.bind-failed",
      attachId: "attach_over_limit",
      code: "attachment-limit"
    });

    await service.close();
  });

  it("does not retain an attachment whose port closes during adapter startup", async () => {
    const transport = new FakeControlTransport();
    const attachment = new FakeAttachment();
    const runtime = new FakeRuntime(attachment);
    const pool = new FakePool();
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_closed_port");

    transport.receive(terminalBindRequest("attach_reused"), [
      new FakeTerminalPort(true)
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacementPort = new FakeTerminalPort();
    transport.receive(terminalBindRequest("attach_reused"), [replacementPort]);
    replacementPort.receive({
      ...envelope("attach_reused"),
      type: "attach",
      resumeFromSequence: uint64(0n),
      creditBytes: 128 * 1024
    });
    await eventually(() => replacementPort.sent[0]?.type === "attached");

    expect(
      transport.sent.some(
        (message) =>
          message.type === "terminal.bind-failed" &&
          message.attachId === "attach_reused"
      )
    ).toBe(false);

    await service.close();
  });

  it("removes a target and reports its assigned master loss to Main", async () => {
    const transport = new FakeControlTransport();
    const runtime = new FakeRuntime(new FakeAttachment());
    const pool = new FakePool();
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_lost");

    pool.emitTargetLost("target_1");
    await eventually(() =>
      transport.sent.some((message) => message.type === "target.lost")
    );

    expect(runtime.closed).toBe(true);
    expect(transport.sent.at(-1)).toEqual({
      type: "target.lost",
      targetId: "target_1",
      masterGeneration: "master_1",
      code: "master-closed",
      message: "injected assigned master loss"
    });

    await service.close();
  });

  it("cleans in place but closes attachments and the bridge before resetting a generation", async () => {
    const transport = new FakeControlTransport();
    const events: string[] = [];
    const attachment = new FakeAttachment();
    const runtime = new FakeRuntime(attachment, () =>
      events.push("runtime.closed")
    );
    const pool = new FakePool();
    const service = new RemoteHostService(transport, {
      pool: pool as unknown as SshTransportPool,
      prepareRuntime: async () =>
        makePreparedRuntime(() => undefined, {
          onGc: () => events.push("runtime.gc"),
          onReset: () => events.push("runtime.reset")
        }),
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_maintenance");
    expect(events).toEqual(["runtime.gc"]);
    events.length = 0;

    transport.receive({
      type: "target.runtime-clean",
      requestId: "clean_1",
      targetId: "target_1"
    });
    await eventually(() => transport.sent.length === 3);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "clean_1",
      status: "ok",
      body: {
        type: "target.runtime-cleaned",
        targetId: "target_1",
        report: { inspected: 1 }
      }
    });
    expect(events).toEqual(["runtime.gc"]);
    expect(runtime.closed).toBe(false);

    const port = new FakeTerminalPort();
    transport.receive(terminalBindRequest("attach_reset"), [port]);
    port.receive({
      ...envelope("attach_reset"),
      type: "attach",
      resumeFromSequence: uint64(0n),
      creditBytes: 128 * 1024
    });
    await eventually(() => port.sent[0]?.type === "attached");

    transport.receive({
      type: "target.runtime-reset",
      requestId: "reset_1",
      targetId: "target_1"
    });
    await eventually(() => transport.sent.length === 4);
    expect(events).toEqual(["runtime.gc", "runtime.closed", "runtime.reset"]);
    expect(attachment.detached).toBe(true);
    expect(pool.disconnectedTargetIds).toEqual(["target_1"]);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "reset_1",
      status: "ok",
      body: {
        type: "target.runtime-reset",
        targetId: "target_1",
        report: {
          generation: `1+${"c".repeat(64)}`,
          status: "reset"
        }
      }
    });

    await service.close();
  });

  it("serializes target-scoped injection, capture, replay, and acknowledgement", async () => {
    const transport = new FakeControlTransport();
    const runtime = new FakeRuntime(new FakeAttachment());
    const service = new RemoteHostService(transport, {
      pool: new FakePool() as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_control");

    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    };
    transport.receive({
      type: "terminal.inject",
      requestId: "inject_1",
      targetId: "target_1",
      injection: {
        resourceKey,
        expectedKeeperGeneration: "keeper_1",
        operationId: "operation_1",
        payloadHash: createHash("sha256").update("hello").digest("hex"),
        input: "hello"
      }
    });
    transport.receive({
      type: "surface.capture",
      requestId: "capture_1",
      targetId: "target_1",
      capture: {
        resourceKey,
        expectedKeeperGeneration: "keeper_1",
        captureId: "capture_1",
        lineLimit: 10,
        maxBytes: 4096
      }
    });
    transport.receive({
      type: "events.replay",
      requestId: "replay_1",
      targetId: "target_1",
      desktopInstallationId: "desktop_1",
      afterSequence: "0"
    });
    transport.receive({
      type: "events.ack",
      requestId: "ack_1",
      targetId: "target_1",
      desktopInstallationId: "desktop_1",
      throughSequence: "1"
    });
    await eventually(() => transport.sent.length === 6);

    expect(
      transport.sent
        .slice(2)
        .map((message) =>
          message.type === "response" && message.status === "ok"
            ? (message.body as { type: string }).type
            : "error"
        )
    ).toEqual([
      "terminal.input-ack",
      "surface.captured",
      "events.replayed",
      "events.acknowledged"
    ]);
    expect(runtime.controlCalls).toEqual([
      "inject:operation_1",
      "capture:capture_1",
      "replay:0",
      "ack:1"
    ]);

    transport.receive({
      type: "surface.capture",
      requestId: "capture_cross_target",
      targetId: "target_1",
      capture: {
        resourceKey: { ...resourceKey, targetId: "target_2" },
        expectedKeeperGeneration: "keeper_1",
        captureId: "capture_2",
        lineLimit: 10,
        maxBytes: 4096
      }
    });
    await eventually(() => transport.sent.length === 7);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "capture_cross_target",
      status: "error",
      error: { retryable: false }
    });
    await service.close();
  });

  it("keeps bounded SFTP work outside the target control queue", async () => {
    const transport = new FakeControlTransport();
    let releaseGit!: () => void;
    const gitGate = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });
    const runtime = {
      connect: async () => hello(),
      async inspectGit(options: { cwd: string }) {
        await gitGate;
        return {
          type: "git.inspected" as const,
          cwd: options.cwd,
          dirtyEntries: [],
          dirtyEntriesTruncated: false
        };
      },
      fileExists: async () => true,
      close: async () => undefined
    };
    const service = new RemoteHostService(transport, {
      pool: new FakePool() as unknown as SshTransportPool,
      prepareRuntime,
      createRuntime: () => runtime as never
    });
    service.start();
    await connectTarget(transport, "connect_files");

    transport.receive({
      type: "git.inspect",
      requestId: "git_blocked",
      targetId: "target_1",
      desktopInstallationId: "desktop_1",
      cwd: "/home/kmux/repo",
      dirtyLimit: 8
    });
    transport.receive({
      type: "file.exists",
      requestId: "file_independent",
      targetId: "target_1",
      remotePath: "/home/kmux/file"
    });
    await eventually(() => transport.sent.length === 3);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "file_independent",
      status: "ok",
      body: {
        type: "file.exists-result",
        targetId: "target_1",
        exists: true
      }
    });

    releaseGit();
    await eventually(() => transport.sent.length === 4);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "git_blocked",
      status: "ok"
    });
    await service.close();
  });
});

class FakeControlTransport implements RemoteHostControlTransport {
  readonly sent: RemoteHostResponse[] = [];
  private listener:
    | ((message: unknown, ports: RemoteTerminalDataPortLike[]) => void)
    | null = null;

  postMessage(message: RemoteHostResponse): void {
    this.sent.push(message);
  }

  onMessage(
    listener: (message: unknown, ports: RemoteTerminalDataPortLike[]) => void
  ): { dispose(): void } {
    this.listener = listener;
    return {
      dispose: () => {
        if (this.listener === listener) this.listener = null;
      }
    };
  }

  receive(message: unknown, ports: RemoteTerminalDataPortLike[] = []): void {
    this.listener?.(message, ports);
  }
}

class FakeTerminalPort
  extends EventEmitter
  implements RemoteTerminalDataPortLike
{
  readonly sent: TerminalDataPlaneHostMessage[] = [];
  closed = false;

  constructor(private readonly closeOnStart = false) {
    super();
  }

  postMessage(message: unknown): void {
    this.sent.push(message as TerminalDataPlaneHostMessage);
  }

  start(): void {
    if (this.closeOnStart) this.close();
  }

  receive(message: TerminalDataPlaneClientMessage): void {
    this.emit("message", { data: message });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeAttachment implements RemoteTerminalAttachmentLike {
  readonly ready = Promise.resolve({
    keeperGeneration: "keeper_1",
    attachmentId: "remote_attach_1",
    writerLeaseId: "lease_1",
    checkpointAvailable: false,
    cols: 80,
    rows: 24,
    earliestAvailableSequence: uint64(1n),
    replayFromSequence: uint64(1n),
    liveStartsAfterSequence: uint64(1n)
  });
  readonly checkpoint = Promise.resolve(null);
  readonly inputs: Uint8Array[] = [];
  private waiter: ((mutation: RemoteTerminalMutation | null) => void) | null =
    null;
  private readonly mutations: RemoteTerminalMutation[] = [];
  detached = false;

  nextMutation(): Promise<RemoteTerminalMutation | null> {
    const mutation = this.mutations.shift();
    if (mutation) return Promise.resolve(mutation);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  pushMutation(mutation: RemoteTerminalMutation): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(mutation);
    } else {
      this.mutations.push(mutation);
    }
  }

  sendInput(_sequence: bigint, data: Uint8Array): Promise<unknown> {
    this.inputs.push(data);
    return Promise.resolve({ boundary: "pty-write" });
  }

  resize(
    cols: number,
    rows: number
  ): Promise<{ mutationSequence: string; cols: number; rows: number }> {
    return Promise.resolve({ mutationSequence: "2", cols, rows });
  }

  detach(): Promise<void> {
    this.detached = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
    return Promise.resolve();
  }
}

class FakeRuntime {
  closed = false;
  readonly controlCalls: string[] = [];

  constructor(
    private readonly attachment: FakeAttachment,
    private readonly onClose: () => void = () => undefined
  ) {}

  connect(): Promise<ReturnType<typeof hello>> {
    return Promise.resolve(hello());
  }

  attach(): Promise<FakeAttachment> {
    return Promise.resolve(this.attachment);
  }

  executeOperation(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  observe(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  injectTerminal(request: {
    resourceKey: ReturnType<typeof terminalBindRequest>["resourceKey"];
    expectedKeeperGeneration: string;
    operationId: string;
    input: string;
  }) {
    this.controlCalls.push(`inject:${request.operationId}`);
    return Promise.resolve({
      resourceKey: request.resourceKey,
      keeperGeneration: request.expectedKeeperGeneration,
      operationId: request.operationId,
      writerLeaseId: "lease_1",
      byteLength: Buffer.byteLength(request.input, "utf8"),
      boundary: "pty-write" as const
    });
  }

  captureSurface(request: {
    resourceKey: ReturnType<typeof terminalBindRequest>["resourceKey"];
    expectedKeeperGeneration: string;
    captureId: string;
  }) {
    this.controlCalls.push(`capture:${request.captureId}`);
    return Promise.resolve({
      captureId: request.captureId,
      resourceKey: request.resourceKey,
      keeperGeneration: request.expectedKeeperGeneration,
      mutationSequence: uint64(7n),
      cols: 80,
      rows: 24,
      text: "tail",
      lineCount: 1,
      byteLength: 4,
      linesTruncated: false,
      bytesTruncated: false,
      retainedRangeTruncated: false
    });
  }

  replayEvents(options: { targetId: string; afterSequence: bigint }) {
    this.controlCalls.push(`replay:${options.afterSequence.toString(10)}`);
    return Promise.resolve({
      targetId: options.targetId,
      events: [],
      acknowledgedThrough: uint64(0n),
      hasMore: false,
      admittedCount: uint64(1n),
      droppedLowValueCount: uint64(0n)
    });
  }

  acknowledgeEvents(options: { throughSequence: bigint }) {
    this.controlCalls.push(`ack:${options.throughSequence.toString(10)}`);
    return Promise.resolve(uint64(options.throughSequence));
  }

  close(): Promise<void> {
    this.closed = true;
    this.onClose();
    return Promise.resolve();
  }
}

class FakePool {
  closed = false;
  assignedTargetIds: string[] = [];
  disconnectedTargetIds: string[] = [];
  onClose?: () => void;
  private verifying:
    | {
        targetId: string;
        effectiveConnectionPolicyHash: string;
        generation: string;
        master: object;
      }
    | undefined;
  private assigned:
    | {
        targetId: string;
        effectiveConnectionPolicyHash: string;
        generation: string;
        master: object;
      }
    | undefined;
  private targetLostListener:
    | ((event: {
        targetId: string;
        masterGeneration: string;
        code: "master-closed";
        message: string;
      }) => void)
    | undefined;

  onTargetLost(listener: NonNullable<FakePool["targetLostListener"]>) {
    this.targetLostListener = listener;
    return {
      dispose: () => {
        if (this.targetLostListener === listener) {
          this.targetLostListener = undefined;
        }
      }
    };
  }

  emitTargetLost(targetId: string): void {
    this.targetLostListener?.({
      targetId,
      masterGeneration: "master_1",
      code: "master-closed",
      message: "injected assigned master loss"
    });
  }

  reconcileTargetAfterChannelFailure(): Promise<boolean> {
    return Promise.resolve(false);
  }

  connectProvisional(): Promise<object> {
    return Promise.resolve({});
  }

  promote(options: { targetId: string }): Promise<object> {
    this.assigned = {
      targetId: options.targetId,
      effectiveConnectionPolicyHash: "a".repeat(64),
      generation: "master_1",
      master: {}
    };
    return Promise.resolve(this.assigned);
  }

  beginAuthorityVerification(options: {
    verificationId: string;
  }): Promise<object> {
    this.verifying = {
      targetId: options.verificationId,
      effectiveConnectionPolicyHash: "a".repeat(64),
      generation: "master_verify_1",
      master: {}
    };
    return Promise.resolve(this.verifying);
  }

  promoteAuthorityVerification(options: { targetId: string }): Promise<object> {
    this.assigned = {
      ...(this.verifying ?? {
        effectiveConnectionPolicyHash: "a".repeat(64),
        generation: "master_verify_1",
        master: {}
      }),
      targetId: options.targetId
    };
    this.verifying = undefined;
    this.assignedTargetIds.push(options.targetId);
    return Promise.resolve(this.assigned);
  }

  discardAuthorityVerification(): Promise<void> {
    this.verifying = undefined;
    return Promise.resolve();
  }

  getAssigned(targetId: string): object | undefined {
    return this.assigned?.targetId === targetId ? this.assigned : undefined;
  }

  disconnectTarget(targetId: string): Promise<void> {
    this.disconnectedTargetIds.push(targetId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.onClose?.();
    return Promise.resolve();
  }
}

function runtimeRoots() {
  return {
    installRoot: "/home/kmux/.local/share/kmux",
    authorityRoot: "/home/kmux/.local/state/kmux/authority",
    stateRoot: "/home/kmux/.local/state/kmux",
    runtimeRoot: "/home/kmux/.local/run/kmux"
  };
}

async function beginTargetConnection(
  transport: FakeControlTransport,
  requestId: string,
  targetId = "target_1"
): Promise<number> {
  const responseCount = transport.sent.length;
  transport.receive({
    type: "target.verify",
    requestId: `${requestId}_verify`,
    verificationId: `${requestId}_verification`,
    connectionAttemptId: `${requestId}_attempt`,
    effectiveConnectionPolicyHash: "a".repeat(64),
    sshPath: "/usr/bin/ssh",
    configPath: "/tmp/ssh_config",
    host: "target-alias",
    controlRoot: "/tmp/control",
    runtimeArtifactRoot: "/opt/kmux/remote-runtime",
    transferRoot: "/tmp/kmux-remote-transfers",
    rootOverrides: runtimeRoots()
  });
  await eventually(() => transport.sent.length === responseCount + 1);
  expect(transport.sent.at(-1)).toMatchObject({
    type: "response",
    requestId: `${requestId}_verify`,
    status: "ok",
    body: {
      type: "target.verified",
      verificationId: `${requestId}_verification`
    }
  });
  transport.receive({
    type: "target.promote",
    requestId,
    verificationId: `${requestId}_verification`,
    desktopInstallationId: "desktop_1",
    targetId,
    effectiveConnectionPolicyHash: "a".repeat(64),
    retentionPolicy: {
      sessionQuotaMiB: 256,
      targetQuotaMiB: 2 * 1024
    },
    token: "b".repeat(64)
  });
  return responseCount;
}

async function connectTarget(
  transport: FakeControlTransport,
  requestId: string,
  targetId = "target_1"
): Promise<void> {
  const responseCount = await beginTargetConnection(
    transport,
    requestId,
    targetId
  );
  await eventually(() => transport.sent.length === responseCount + 2);
  expect(transport.sent.at(-1)).toMatchObject({
    type: "response",
    requestId,
    status: "ok",
    body: { type: "target.ready", targetId }
  });
}

async function prepareRuntime(): Promise<PreparedRemoteRuntime> {
  return makePreparedRuntime();
}

function makePreparedRuntime(
  onRotate: (options: {
    desktopInstallationId: string;
    targetId: string;
    token: string;
  }) => void = () => undefined,
  callbacks: {
    onGc?: () => void;
    onReset?: () => void;
  } = {}
): PreparedRemoteRuntime {
  return {
    runtimePath: "/home/kmux/.local/bin/kmuxd",
    generation: `1+${"c".repeat(64)}`,
    remoteHome: "/home/kmux",
    roots: {
      installRoot: "/home/kmux/.local/share/kmux",
      authorityRoot: "/home/kmux/.local/state/kmux/authority",
      stateRoot: "/home/kmux/.local/state/kmux",
      runtimeRoot: "/home/kmux/.local/run/kmux"
    },
    shellPolicy: {
      accountShellPath: "/bin/sh",
      accountShellKind: "bourne",
      bootstrapShellPath: "/bin/sh"
    },
    doctor: {
      remoteInstallationId: "11111111-1111-4111-8111-111111111111",
      executionNodeId: "22222222-2222-4222-8222-222222222222",
      authenticatedPrincipal: {
        uid: 1000,
        accountName: "kmux"
      },
      platform: "linux",
      arch: "x86_64",
      abi: "musl",
      installRoot: "/home/kmux/.local/share/kmux",
      authorityRoot: "/home/kmux/.local/state/kmux/authority",
      stateRoot: "/home/kmux/.local/state/kmux",
      runtimeRoot: "/home/kmux/.local/run/kmux"
    },
    async rotateBridgeToken(options) {
      onRotate(options);
    },
    async runGenerationGc() {
      callbacks.onGc?.();
      return {
        inspected: 1,
        removed: [],
        live: [],
        incompleteOrCorrupt: []
      };
    },
    async resetCurrentGeneration() {
      callbacks.onReset?.();
      return {
        generation: `1+${"c".repeat(64)}`,
        status: "reset"
      };
    }
  };
}

function terminalBindRequest(attachId: string) {
  return {
    type: "terminal.bind",
    targetId: "target_1",
    attachId,
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
  };
}

function envelope(attachId = "attach_1") {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId,
    session: {
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "keeper_1"
    }
  } as const;
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}
