import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64,
  validateTerminalDataPlaneHostMessage,
  type TerminalDataPlaneClientMessage,
  type TerminalDataPlaneHostMessage,
  type TerminalSessionRef
} from "@kmux/proto";
import { describe, expect, it } from "vitest";

import {
  RemoteTerminalDataPlaneAdapter,
  type RemoteTerminalAttachmentLike,
  type RemoteTerminalDataPortLike,
  type RemoteTerminalRuntimeLike
} from "./remoteTerminalDataPlane";
import type {
  RemoteTerminalAttachReady,
  RemoteTerminalCheckpointTransfer,
  RemoteTerminalMutation
} from "./linuxX64RemoteRuntime";

const session: TerminalSessionRef = {
  surfaceId: "surface_1",
  sessionId: "session_1",
  epoch: "keeper_1"
};

describe("remote terminal data-plane adapter", () => {
  it("streams a cold checkpoint before ordered output and PTY-boundary writes", async () => {
    const checkpointBytes = new TextEncoder().encode("prompt");
    const attachment = new FakeAttachment({
      ready: attachReady({
        checkpointAvailable: true,
        replayFromSequence: uint64(3n),
        liveStartsAfterSequence: uint64(2n)
      }),
      checkpoint: checkpointTransfer(checkpointBytes, 2n)
    });
    const runtime = new FakeRuntime(attachment);
    const port = new FakePort();
    const cursors: bigint[] = [];
    const adapter = createAdapter(runtime, port, (sequence) =>
      cursors.push(sequence)
    );

    port.receive(attachMessage({ creditBytes: checkpointBytes.byteLength }));
    await eventually(() =>
      port.sent.some((message) => message.type === "checkpoint:end")
    );
    expect(runtime.attachOptions).toMatchObject({
      expectedKeeperGeneration: "keeper_1",
      access: "write"
    });
    expect(runtime.attachOptions).not.toHaveProperty("lastReceivedSequence");
    expect(port.sent.map((message) => message.type)).toEqual([
      "checkpoint:begin",
      "checkpoint:chunk",
      "checkpoint:end"
    ]);
    expect(port.sent[0]).toMatchObject({
      type: "checkpoint:begin",
      metadata: { sequence: 2n, cols: 80, rows: 24 },
      totalBytes: checkpointBytes.byteLength
    });

    const checkpointId = requireCheckpointId(port.sent[0]);
    port.receive(
      clientMessage({
        type: "checkpoint:credit",
        checkpointId,
        acknowledgedOffset: checkpointBytes.byteLength,
        bytes: checkpointBytes.byteLength
      })
    );
    attachment.pushMutation({
      kind: "output",
      sequence: uint64(3n),
      data: new TextEncoder().encode("ok")
    });
    await eventually(() =>
      port.sent.some(
        (message) => message.type === "delta" && message.delta.type === "output"
      )
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: {
        type: "output",
        fromSequence: 2n,
        sequence: 3n,
        byteLength: 2,
        segments: [{ sequence: 3n, data: "ok", byteLength: 2 }]
      }
    });

    port.receive(
      clientMessage({
        type: "credit",
        acknowledgedSequence: uint64(3n),
        bytes: 2
      })
    );
    port.receive(clientMessage({ type: "input:text", text: "echo hi\n" }));
    await eventually(() => attachment.inputs.length === 1);
    expect(new TextDecoder().decode(attachment.inputs[0]?.data)).toBe(
      "echo hi\n"
    );
    expect(attachment.inputs[0]?.sequence).toBe(1n);
    expect(cursors).toEqual([3n]);

    port.receive(
      clientMessage({
        type: "resize",
        cols: 100,
        rows: 30,
        requestId: "resize_1"
      })
    );
    await eventually(() => attachment.resizeRequests.length === 1);
    expect(port.sent.some((message) => message.type === "resize:ack")).toBe(
      false
    );
    attachment.pushMutation({
      kind: "resize",
      sequence: uint64(4n),
      cols: 100,
      rows: 30
    });
    await eventually(() =>
      port.sent.some((message) => message.type === "resize:ack")
    );
    expect(port.sent.slice(-2)).toMatchObject([
      { type: "delta", delta: { type: "resize", sequence: 4n } },
      { type: "resize:ack", requestId: "resize_1", sequence: 4n }
    ]);

    attachment.pushMutation({
      kind: "exit",
      sequence: uint64(5n),
      exitCode: 0
    });
    await eventually(() => port.closed);
    expect(port.sent.at(-1)).toMatchObject({
      type: "exit",
      sequence: 5n,
      exitCode: 0
    });
    expect(attachment.detached).toBe(true);
    await adapter.dispose();
    assertValidHostMessages(port.sent);
  });

  it("resumes from the renderer cursor and does not read past output credit", async () => {
    const attachment = new FakeAttachment({
      ready: attachReady({
        replayFromSequence: uint64(5n),
        liveStartsAfterSequence: uint64(6n)
      }),
      checkpoint: null
    });
    const runtime = new FakeRuntime(attachment);
    const port = new FakePort();
    const adapter = createAdapter(runtime, port);

    port.receive(
      attachMessage({ resumeFromSequence: uint64(4n), creditBytes: 4 })
    );
    await eventually(() => port.sent[0]?.type === "attached");
    expect(runtime.attachOptions).toMatchObject({
      lastReceivedSequence: 4n
    });
    expect(port.sent[0]).toMatchObject({
      type: "attached",
      resumedFromSequence: 4n,
      sequence: 6n,
      cols: 80,
      rows: 24
    });

    attachment.pushMutation({
      kind: "output",
      sequence: uint64(5n),
      data: new TextEncoder().encode("1234")
    });
    attachment.pushMutation({
      kind: "output",
      sequence: uint64(6n),
      data: new TextEncoder().encode("5678")
    });
    await eventually(
      () => port.sent.filter((message) => message.type === "delta").length === 1
    );
    await flushTurns(3);
    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(1);

    port.receive(
      clientMessage({
        type: "credit",
        acknowledgedSequence: uint64(5n),
        bytes: 4
      })
    );
    await eventually(
      () => port.sent.filter((message) => message.type === "delta").length === 2
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: { fromSequence: 5n, sequence: 6n }
    });

    await adapter.dispose();
    expect(attachment.detached).toBe(true);
    assertValidHostMessages(port.sent);
  });

  it("bounds tiny output mutations awaiting renderer acknowledgement", async () => {
    const attachment = new FakeAttachment({
      ready: attachReady(),
      checkpoint: null
    });
    const runtime = new FakeRuntime(attachment);
    const port = new FakePort();
    const adapter = createAdapter(runtime, port);

    port.receive(attachMessage());
    await eventually(() => port.sent[1]?.type === "checkpoint:end");
    for (let sequence = 1; sequence <= 4_097; sequence += 1) {
      attachment.pushMutation({
        kind: "output",
        sequence: uint64(BigInt(sequence)),
        data: new Uint8Array([0x78])
      });
    }
    await eventually(
      () =>
        port.sent.filter((message) => message.type === "delta").length === 4_096
    );
    await flushTurns(3);
    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(4_096);

    port.receive(
      clientMessage({
        type: "credit",
        acknowledgedSequence: uint64(4_096n),
        bytes: 4_096
      })
    );
    await eventually(
      () =>
        port.sent.filter((message) => message.type === "delta").length === 4_097
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: { sequence: 4_097n }
    });

    await adapter.dispose();
    assertValidHostMessages(port.sent);
  });

  it("uses a bounded empty checkpoint when the headless checkpoint is unavailable", async () => {
    const attachment = new FakeAttachment({
      ready: attachReady({
        earliestAvailableSequence: uint64(7n),
        replayFromSequence: uint64(7n),
        liveStartsAfterSequence: uint64(7n)
      }),
      checkpoint: null
    });
    const runtime = new FakeRuntime(attachment);
    const port = new FakePort();
    const adapter = createAdapter(runtime, port);

    port.receive(attachMessage());
    await eventually(() => port.sent.length >= 2);
    expect(port.sent).toMatchObject([
      {
        type: "checkpoint:begin",
        totalBytes: 0,
        metadata: { sequence: 6n, cols: 80, rows: 24 }
      },
      {
        type: "checkpoint:end",
        digest: createHash("sha256").digest("hex")
      }
    ]);

    await adapter.dispose();
    assertValidHostMessages(port.sent);
  });

  it("bounds resize acknowledgements while output credit blocks mutations", async () => {
    const attachment = new FakeAttachment({
      ready: attachReady(),
      checkpoint: null
    });
    const runtime = new FakeRuntime(attachment);
    const port = new FakePort();
    const adapter = createAdapter(runtime, port);

    port.receive(attachMessage());
    await eventually(() => port.sent[1]?.type === "checkpoint:end");

    for (let index = 0; index < 1_025; index += 1) {
      port.receive(
        clientMessage({
          type: "resize",
          cols: 100,
          rows: 30,
          requestId: `resize_${index}`
        })
      );
    }

    await eventually(() => attachment.resizeRequests.length === 1_024);
    expect(attachment.resizeRequests).toHaveLength(1_024);
    expect(port.sent.at(-1)).toMatchObject({
      type: "error",
      code: "invalid-message",
      message:
        "pending remote terminal resize acknowledgements exceed their limit",
      recoverable: true
    });

    await adapter.dispose();
    assertValidHostMessages(port.sent);
  });

  it("falls back from an incompatible checkpoint to the retained mutation range", async () => {
    const incompatible = new FakeAttachment({
      ready: attachReady({
        checkpointAvailable: true,
        earliestAvailableSequence: uint64(7n),
        replayFromSequence: uint64(10n),
        liveStartsAfterSequence: uint64(9n),
        truncatedBeforeSequence: uint64(7n)
      }),
      checkpoint: checkpointTransfer(
        new TextEncoder().encode("incompatible"),
        9n,
        "vt100/99",
        "future-vt/2"
      )
    });
    const replay = new FakeAttachment({
      ready: attachReady({
        earliestAvailableSequence: uint64(7n),
        replayFromSequence: uint64(7n),
        liveStartsAfterSequence: uint64(9n),
        truncatedBeforeSequence: uint64(7n)
      }),
      checkpoint: null
    });
    const runtime = new FakeRuntime(incompatible, replay);
    const port = new FakePort();
    const adapter = createAdapter(runtime, port);

    port.receive(attachMessage({ resumeFromSequence: uint64(2n) }));
    await eventually(() => port.sent.length >= 2);

    expect(incompatible.detached).toBe(true);
    expect(runtime.attachCalls).toHaveLength(2);
    expect(runtime.attachCalls[0]).toMatchObject({ lastReceivedSequence: 2n });
    expect(runtime.attachCalls[1]).toMatchObject({ lastReceivedSequence: 6n });
    expect(port.sent).toMatchObject([
      {
        type: "checkpoint:begin",
        purpose: {
          kind: "resync",
          missingFromSequence: 3n,
          retainedFromSequence: 7n
        },
        totalBytes: 0,
        metadata: { sequence: 6n }
      },
      {
        type: "checkpoint:end",
        digest: createHash("sha256").digest("hex")
      }
    ]);
    expect(
      port.sent.some(
        (message) =>
          message.type === "checkpoint:chunk" ||
          (message.type === "checkpoint:begin" && message.totalBytes > 0)
      )
    ).toBe(false);

    replay.pushMutation({
      kind: "output",
      sequence: uint64(7n),
      data: new TextEncoder().encode("retained")
    });
    await eventually(() =>
      port.sent.some((message) => message.type === "delta")
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: { fromSequence: 6n, sequence: 7n }
    });

    await adapter.dispose();
    assertValidHostMessages(port.sent);
  });
});

class FakePort extends EventEmitter implements RemoteTerminalDataPortLike {
  readonly sent: TerminalDataPlaneHostMessage[] = [];
  closed = false;

  postMessage(message: unknown): void {
    this.sent.push(message as TerminalDataPlaneHostMessage);
  }

  start(): void {}

  receive(message: TerminalDataPlaneClientMessage): void {
    this.emit("message", { data: message });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeRuntime implements RemoteTerminalRuntimeLike {
  attachOptions: Parameters<RemoteTerminalRuntimeLike["attach"]>[0] | null =
    null;
  readonly attachCalls: Parameters<RemoteTerminalRuntimeLike["attach"]>[0][] =
    [];

  private nextAttachment = 0;
  private readonly attachments: FakeAttachment[];

  constructor(...attachments: FakeAttachment[]) {
    this.attachments = attachments;
  }

  async attach(
    options: Parameters<RemoteTerminalRuntimeLike["attach"]>[0]
  ): Promise<RemoteTerminalAttachmentLike> {
    this.attachOptions = options;
    this.attachCalls.push(options);
    const attachment = this.attachments[this.nextAttachment];
    if (!attachment) throw new Error("fake runtime has no attachment");
    this.nextAttachment += 1;
    return attachment;
  }
}

class FakeAttachment implements RemoteTerminalAttachmentLike {
  readonly ready: Promise<RemoteTerminalAttachReady>;
  readonly checkpoint: Promise<RemoteTerminalCheckpointTransfer | null>;
  readonly inputs: Array<{ sequence: bigint; data: Uint8Array }> = [];
  readonly resizeRequests: Array<{ cols: number; rows: number }> = [];
  private readonly mutations: RemoteTerminalMutation[] = [];
  private mutationWaiter:
    | ((mutation: RemoteTerminalMutation | null) => void)
    | null = null;
  detached = false;

  constructor(options: {
    ready: RemoteTerminalAttachReady;
    checkpoint: RemoteTerminalCheckpointTransfer | null;
  }) {
    this.ready = Promise.resolve(options.ready);
    this.checkpoint = Promise.resolve(options.checkpoint);
  }

  nextMutation(): Promise<RemoteTerminalMutation | null> {
    const mutation = this.mutations.shift();
    if (mutation) return Promise.resolve(mutation);
    return new Promise((resolve) => {
      this.mutationWaiter = resolve;
    });
  }

  pushMutation(mutation: RemoteTerminalMutation): void {
    const waiter = this.mutationWaiter;
    if (waiter) {
      this.mutationWaiter = null;
      waiter(mutation);
    } else {
      this.mutations.push(mutation);
    }
  }

  sendInput(sequence: bigint, data: Uint8Array): Promise<unknown> {
    this.inputs.push({ sequence, data });
    return Promise.resolve({ boundary: "pty-write" });
  }

  resize(
    cols: number,
    rows: number
  ): Promise<{ mutationSequence: string; cols: number; rows: number }> {
    this.resizeRequests.push({ cols, rows });
    return Promise.resolve({ mutationSequence: "4", cols, rows });
  }

  detach(): Promise<void> {
    this.detached = true;
    const waiter = this.mutationWaiter;
    this.mutationWaiter = null;
    waiter?.(null);
    return Promise.resolve();
  }
}

function createAdapter(
  runtime: FakeRuntime,
  port: FakePort,
  onCursorAdvanced?: (sequence: bigint) => void
): RemoteTerminalDataPlaneAdapter {
  return new RemoteTerminalDataPlaneAdapter({
    runtime,
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: session.sessionId
    },
    expectedKeeperGeneration: session.epoch,
    attachId: "attach_1",
    session,
    port,
    ...(onCursorAdvanced ? { onCursorAdvanced } : {})
  });
}

function attachReady(
  overrides: Partial<RemoteTerminalAttachReady> = {}
): RemoteTerminalAttachReady {
  return {
    keeperGeneration: "keeper_1",
    attachmentId: "remote_attachment_1",
    writerLeaseId: "lease_1",
    checkpointAvailable: false,
    cols: 80,
    rows: 24,
    earliestAvailableSequence: uint64(1n),
    replayFromSequence: uint64(1n),
    liveStartsAfterSequence: uint64(0n),
    ...overrides
  };
}

function checkpointTransfer(
  bytes: Uint8Array,
  sequence: bigint,
  parserVersion = "vt100/0.16",
  format = "xterm-vt/1"
): RemoteTerminalCheckpointTransfer {
  return {
    metadata: {
      type: "checkpoint.begin",
      checkpointId: "remote_checkpoint_1",
      format,
      parserVersion,
      lastMutationSequence: sequence.toString(10),
      cols: 80,
      rows: 24,
      byteLength: bytes.byteLength.toString(10)
    },
    chunks: [bytes],
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function attachMessage(
  overrides: Partial<
    Extract<TerminalDataPlaneClientMessage, { type: "attach" }>
  > = {}
): Extract<TerminalDataPlaneClientMessage, { type: "attach" }> {
  return {
    ...clientEnvelope(),
    type: "attach",
    creditBytes: 128 * 1024,
    ...overrides
  };
}

function clientMessage(
  message:
    | Omit<
        Extract<TerminalDataPlaneClientMessage, { type: "checkpoint:credit" }>,
        "protocol" | "attachId" | "session"
      >
    | Omit<
        Extract<TerminalDataPlaneClientMessage, { type: "credit" }>,
        "protocol" | "attachId" | "session"
      >
    | Omit<
        Extract<TerminalDataPlaneClientMessage, { type: "input:text" }>,
        "protocol" | "attachId" | "session"
      >
    | Omit<
        Extract<TerminalDataPlaneClientMessage, { type: "resize" }>,
        "protocol" | "attachId" | "session"
      >
): TerminalDataPlaneClientMessage {
  return { ...clientEnvelope(), ...message } as TerminalDataPlaneClientMessage;
}

function clientEnvelope() {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: "attach_1",
    session
  } as const;
}

function requireCheckpointId(
  message: TerminalDataPlaneHostMessage | undefined
): string {
  if (message?.type !== "checkpoint:begin") {
    throw new Error("expected checkpoint begin");
  }
  return message.checkpointId;
}

function assertValidHostMessages(
  messages: TerminalDataPlaneHostMessage[]
): void {
  for (const message of messages) {
    expect(
      validateTerminalDataPlaneHostMessage(message, {
        attachId: "attach_1",
        session
      })
    ).toEqual({ ok: true, value: message });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flushTurns(1);
  }
  throw new Error("condition did not become true");
}

async function flushTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
