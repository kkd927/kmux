import type {
  TerminalCheckpoint,
  TerminalCheckpointMetadata,
  TerminalCheckpointPurpose,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneHostMessage,
  TerminalSessionRef,
  Uint64
} from "@kmux/proto";
import {
  IncrementalSha256,
  TERMINAL_DATA_PLANE_MAX_INPUT_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64
} from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import {
  type TerminalCheckpointApplyResult,
  type TerminalStreamPort,
  type TerminalStreamSink,
  TerminalStreamRouter,
  type TerminalStreamRouterError,
  type TerminalStreamWriteContext
} from "./terminalStreamRouter";

const _nativeMessagePortContract: TerminalStreamPort =
  undefined as unknown as MessagePort;

const session: TerminalSessionRef = {
  surfaceId: "surface_1",
  sessionId: "session_1",
  epoch: "epoch_1"
};

class FakePort implements TerminalStreamPort {
  readonly sent: TerminalDataPlaneClientMessage[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  private readonly listeners = new Map<
    "message" | "messageerror",
    Set<(event: MessageEvent<unknown>) => void>
  >();

  postMessage(message: unknown): void {
    this.sent.push(message as TerminalDataPlaneClientMessage);
  }

  addEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(message: TerminalDataPlaneHostMessage): void {
    this.emit("message", message);
  }

  receiveRaw(message: unknown): void {
    this.emit("message", message);
  }

  private emit(type: "message" | "messageerror", data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

function createSink(options: { autoCheckpoint?: boolean } = {}) {
  const writes: Array<{
    data: string;
    complete: () => void;
    context: TerminalStreamWriteContext;
  }> = [];
  const checkpoints: Array<{
    checkpoint: TerminalCheckpointMetadata;
    chunks: ArrayBuffer[];
    complete: (result?: TerminalCheckpointApplyResult) => void;
  }> = [];
  const errors: TerminalStreamRouterError[] = [];
  const events: string[] = [];
  const sink: TerminalStreamSink = {
    beginCheckpoint(value) {
      events.push(`checkpoint:${value.sequence}`);
      let resolveCommit!: (result?: TerminalCheckpointApplyResult) => void;
      const completion = new Promise<void | TerminalCheckpointApplyResult>(
        (resolve) => {
          resolveCommit = resolve;
        }
      );
      const entry = {
        checkpoint: value,
        chunks: [] as ArrayBuffer[],
        complete: resolveCommit
      };
      checkpoints.push(entry);
      if (options.autoCheckpoint !== false) {
        resolveCommit(undefined);
      }
      return {
        async writeChunk(data) {
          entry.chunks.push(data);
        },
        commit() {
          return completion;
        },
        cancel() {
          if (options.autoCheckpoint === false) {
            resolveCommit(undefined);
          }
        }
      };
    },
    applyResume: vi.fn((resume) => {
      events.push(`resume:${resume.resumedFromSequence}`);
    }),
    write(data, complete, context) {
      events.push(`write:${context.delta.sequence}`);
      writes.push({ data, complete, context });
    },
    resize: vi.fn((delta) => {
      events.push(`resize:${delta.sequence}`);
    }),
    exit: vi.fn((event) => {
      events.push(`exit:${event.sequence}`);
    }),
    resizeAcknowledged: vi.fn(),
    reportError(error) {
      errors.push(error);
    }
  };
  return { sink, writes, checkpoints, errors, events };
}

function envelope(
  overrides: {
    attachId?: string;
    session?: TerminalSessionRef;
  } = {}
) {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: overrides.attachId ?? "attach_1",
    session: overrides.session ?? session
  } as const;
}

function checkpoint(
  sequence: number,
  overrides: Partial<TerminalCheckpoint> = {}
): TerminalCheckpoint {
  return {
    format: "xterm-vt/1",
    session,
    sequence: u(sequence),
    data: `checkpoint-${sequence}`,
    cols: 80,
    rows: 24,
    ...overrides
  };
}

function sendCheckpoint(
  port: FakePort,
  sequence: number,
  overrides: {
    attachId?: string;
    session?: TerminalSessionRef;
  } = {},
  purpose: TerminalCheckpointPurpose = { kind: "attach" }
): void {
  const materialized = checkpoint(sequence, {
    session: overrides.session ?? session
  });
  const { data, ...metadata } = materialized;
  const bytes = new TextEncoder().encode(data);
  const checkpointId = `checkpoint-${sequence}`;
  port.receive({
    ...envelope(overrides),
    type: "checkpoint:begin",
    checkpointId,
    purpose,
    metadata,
    totalBytes: bytes.byteLength
  });
  if (bytes.byteLength > 0) {
    port.receive({
      ...envelope(overrides),
      type: "checkpoint:chunk",
      checkpointId,
      offset: 0,
      data: bytes.buffer
    });
  }
  port.receive({
    ...envelope(overrides),
    type: "checkpoint:end",
    checkpointId,
    digest: new IncrementalSha256().update(bytes).digestHex()
  });
}

function u(value: number): Uint64 {
  return uint64(BigInt(value));
}

function output(
  fromSequence: number,
  data: string,
  overrides: {
    attachId?: string;
    session?: TerminalSessionRef;
    cwd?: string;
  } = {}
): TerminalDataPlaneHostMessage {
  const sequence = fromSequence + 1;
  return {
    ...envelope(overrides),
    type: "delta",
    delta: {
      type: "output",
      fromSequence: u(fromSequence),
      sequence: u(sequence),
      byteLength: new TextEncoder().encode(data).byteLength,
      segments: [
        {
          sequence: u(sequence),
          data,
          byteLength: new TextEncoder().encode(data).byteLength,
          ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd })
        }
      ]
    }
  };
}

function register(
  router: TerminalStreamRouter,
  options: {
    port?: FakePort;
    sink?: ReturnType<typeof createSink>;
    session?: TerminalSessionRef;
    attachId?: string;
    resumeFromSequence?: number | Uint64;
    writeScheduler?: Parameters<
      TerminalStreamRouter["register"]
    >[0]["writeScheduler"];
    metrics?: Parameters<TerminalStreamRouter["register"]>[0]["metrics"];
  } = {}
) {
  const port = options.port ?? new FakePort();
  const sinkHarness = options.sink ?? createSink();
  const registration = router.register({
    port,
    attachId: options.attachId ?? "attach_1",
    session: options.session ?? session,
    sink: sinkHarness.sink,
    ...(options.resumeFromSequence === undefined
      ? {}
      : {
          resumeFromSequence:
            typeof options.resumeFromSequence === "number"
              ? u(options.resumeFromSequence)
              : options.resumeFromSequence
        }),
    ...(options.writeScheduler === undefined
      ? {}
      : { writeScheduler: options.writeScheduler }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics })
  });
  return { port, ...sinkHarness, registration };
}

async function waitForCheckpoint(
  harness: ReturnType<typeof register>,
  sequence: number
): Promise<void> {
  sendCheckpoint(harness.port, sequence);
  await vi.waitFor(() =>
    expect(harness.registration.sequence).toBe(u(sequence))
  );
}

describe("TerminalStreamRouter", () => {
  it("closes an oversized checkpoint as surface-fatal instead of replacement-rearm", async () => {
    const router = new TerminalStreamRouter();
    const sinkHarness = createSink();
    const detached = vi.fn();
    sinkHarness.sink.detached = detached;
    const harness = register(router, { sink: sinkHarness });

    harness.port.receive({
      ...envelope(),
      type: "error",
      code: "checkpoint-too-large",
      message: "screen-only checkpoint exceeds the bound",
      recoverable: false
    });

    await vi.waitFor(() => expect(harness.registration.closed).toBe(true));
    expect(detached).toHaveBeenCalledWith("surface-closed");
    expect(detached).not.toHaveBeenCalledWith("replaced");
    expect(harness.errors).toContainEqual({
      kind: "host-error",
      code: "checkpoint-too-large",
      message: "screen-only checkpoint exceeds the bound",
      recoverable: false
    });

    const restarted = register(router, {
      attachId: "attach_2",
      session: {
        surfaceId: session.surfaceId,
        sessionId: "session_2",
        epoch: "epoch_2"
      }
    });
    expect(restarted.registration.closed).toBe(false);
    expect(restarted.port.sent[0]).toMatchObject({
      type: "attach",
      attachId: "attach_2",
      session: { sessionId: "session_2", epoch: "epoch_2" }
    });
  });

  it("seals a hidden capability immediately and settles only admitted output without post-seal credit", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    sendCheckpoint(harness.port, 0);
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(0)));
    harness.port.receive(output(0, "admitted"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));

    let settled = false;
    const outcomePromise = harness.registration
      .detach("hidden")
      .then((value) => {
        settled = true;
        return value;
      });
    expect(harness.registration.closed).toBe(true);
    expect(harness.port.close).toHaveBeenCalledOnce();
    expect(harness.port.sent.at(-1)).toMatchObject({
      type: "detach",
      reason: "hidden"
    });

    harness.port.receive(output(1, "too-late"));
    await Promise.resolve();
    expect(harness.writes).toHaveLength(1);
    expect(settled).toBe(false);

    harness.writes[0]?.complete();
    await expect(outcomePromise).resolves.toEqual({
      kind: "resumable",
      cursor: { session, sequence: u(1) }
    });
    expect(
      harness.port.sent.filter((message) => message.type === "credit")
    ).toHaveLength(0);
    expect(router.size).toBe(0);
  });

  it("discards a hidden attachment whose checkpoint has not committed", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);

    await expect(harness.registration.detach("hidden")).resolves.toEqual({
      kind: "discarded"
    });
    expect(harness.port.close).toHaveBeenCalledOnce();
    expect(router.size).toBe(0);
  });

  it("serializes hydration, output, resize, and exit and returns exact credit only after parsing", async () => {
    const router = new TerminalStreamRouter();
    const sinkHarness = createSink({ autoCheckpoint: false });
    const harness = register(router, { sink: sinkHarness });

    expect(harness.port.start).toHaveBeenCalledOnce();
    expect(harness.port.sent[0]).toMatchObject({
      type: "attach",
      attachId: "attach_1",
      session
    });

    sendCheckpoint(harness.port, 4);
    harness.port.receive(output(4, "한"));
    harness.port.receive({
      ...envelope(),
      type: "delta",
      delta: { type: "resize", sequence: u(6), cols: 120, rows: 40 }
    });
    harness.port.receive({
      ...envelope(),
      type: "exit",
      sequence: u(7),
      exitCode: 0
    });

    await vi.waitFor(() => expect(harness.checkpoints).toHaveLength(1));
    expect(harness.writes).toHaveLength(0);
    harness.checkpoints[0]?.complete();

    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.events).toEqual(["checkpoint:4", "write:5"]);
    expect(harness.port.sent).toHaveLength(2);

    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.port.close).toHaveBeenCalledOnce());

    expect(harness.port.sent[2]).toMatchObject({
      type: "credit",
      acknowledgedSequence: u(5),
      bytes: 3
    });
    expect(harness.events).toEqual([
      "checkpoint:4",
      "write:5",
      "resize:6",
      "exit:7"
    ]);
    expect(router.size).toBe(0);
  });

  it("returns checkpoint credit only after the staged parser boundary and commits the cursor at end", async () => {
    const router = new TerminalStreamRouter();
    const sinkHarness = createSink();
    let releaseChunk!: () => void;
    let releaseCommit!: () => void;
    let chunkStarted = false;
    let commitStarted = false;
    sinkHarness.sink.beginCheckpoint = vi.fn(() => ({
      writeChunk: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            chunkStarted = true;
            releaseChunk = resolve;
          })
      ),
      commit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            commitStarted = true;
            releaseCommit = resolve;
          })
      ),
      cancel: vi.fn()
    }));
    const harness = register(router, { sink: sinkHarness });

    sendCheckpoint(harness.port, 4);
    await vi.waitFor(() => expect(chunkStarted).toBe(true));

    expect(harness.registration.sequence).toBeNull();
    expect(
      harness.port.sent.filter(
        (message) => message.type === "checkpoint:credit"
      )
    ).toHaveLength(0);

    releaseChunk();
    await vi.waitFor(() => expect(commitStarted).toBe(true));
    expect(harness.port.sent[1]).toMatchObject({
      type: "checkpoint:credit",
      checkpointId: "checkpoint-4",
      acknowledgedOffset: 12,
      bytes: 12
    });
    expect(harness.registration.sequence).toBeNull();

    releaseCommit();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(4)));
    router.dispose();
  });

  it("preserves source segment boundaries with one xterm parse in flight per surface", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);
    harness.port.receive({
      ...envelope(),
      type: "delta",
      delta: {
        type: "output",
        fromSequence: u(0),
        sequence: u(3),
        byteLength: 4,
        segments: [
          {
            sequence: u(1),
            data: "a",
            byteLength: 1,
            cwd: "/repo/a"
          },
          {
            sequence: u(2),
            data: "b\n",
            byteLength: 2,
            cwd: "/repo/a"
          },
          { sequence: u(3), data: "c", byteLength: 1, cwd: "/repo/b" }
        ]
      }
    });

    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]).toMatchObject({
      data: "ab\n",
      context: { dataOffset: 0, finalPart: false }
    });
    expect(harness.registration.sequence).toBe(u(0));
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(harness.writes[1]).toMatchObject({
      data: "c",
      context: { dataOffset: 3, finalPart: true }
    });
    expect(harness.registration.sequence).toBe(u(0));
    harness.writes[1]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(3)));
    router.dispose();
  });

  it("coalesces compatible deltas within one parse quantum and credits each delta", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "first"));
    harness.port.receive(output(1, "second"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]?.data).toBe("firstsecond");
    expect(harness.registration.sequence).toBe(u(0));
    expect(
      harness.port.sent.filter((message) => message.type === "credit")
    ).toHaveLength(0);
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(2)));
    expect(
      harness.port.sent
        .filter((message) => message.type === "credit")
        .map((message) =>
          message.type === "credit" ? message.acknowledgedSequence : -1
        )
    ).toEqual([u(1), u(2)]);
    router.dispose();
  });

  it("limits every xterm parse quantum to 16 KiB without splitting Unicode", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);

    const data = `${"a".repeat(16 * 1024 - 1)}😀${"b".repeat(20 * 1024)}`;
    harness.port.receive(output(0, data));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]?.data).toHaveLength(16 * 1024 - 1);
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(harness.writes[1]?.data).toHaveLength(16 * 1024);
    harness.writes[1]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3));
    expect(harness.writes[2]?.data.length).toBeLessThanOrEqual(16 * 1024);
    expect(harness.writes.map((write) => write.data).join("")).toBe(data);
    expect(
      harness.writes.every((write) => write.data.length <= 16 * 1024)
    ).toBe(true);
    harness.writes[2]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(1)));
    router.dispose();
  });

  it("round-robins simultaneous checkpoint hydration through the same arbiter", async () => {
    const turns: Array<() => void> = [];
    const router = new TerminalStreamRouter({
      writeArbiterOptions: {
        scheduleTurn: (callback) => turns.push(callback),
        now: () => 0
      }
    });
    const writes: Array<{
      lane: "a" | "b";
      data: string;
      complete(): void;
    }> = [];
    const begin = (lane: "a" | "b", character: string) =>
      router.beginCooperativeWrite(
        lane,
        character.repeat(20 * 1024),
        (data, complete) => writes.push({ lane, data, complete })
      );

    const a = begin("a", "a");
    const b = begin("b", "b");
    expect(turns).toHaveLength(1);
    turns.shift()?.();

    expect(writes.map((write) => [write.lane, write.data.length])).toEqual([
      ["a", 16 * 1024],
      ["b", 16 * 1024]
    ]);
    writes[0]?.complete();
    writes[1]?.complete();
    expect(turns).toHaveLength(1);
    turns.shift()?.();

    expect(writes.map((write) => [write.lane, write.data.length])).toEqual([
      ["a", 16 * 1024],
      ["b", 16 * 1024],
      ["a", 4 * 1024],
      ["b", 4 * 1024]
    ]);
    writes[2]?.complete();
    writes[3]?.complete();
    await expect(Promise.all([a.completion, b.completion])).resolves.toEqual([
      undefined,
      undefined
    ]);
    router.dispose();
  });

  it("applies input priority to checkpoint hydration for the same surface", async () => {
    const turns: Array<() => void> = [];
    const order: string[] = [];
    const router = new TerminalStreamRouter({
      writeArbiterOptions: {
        scheduleTurn: (callback) => turns.push(callback),
        now: () => 0
      }
    });
    const callbacks: Array<() => void> = [];
    const b = router.beginCooperativeWrite("surface-b", "b", (_data, done) => {
      order.push("b");
      callbacks.push(done);
    });
    const a = router.beginCooperativeWrite("surface-a", "a", (_data, done) => {
      order.push("a");
      callbacks.push(done);
    });
    const target = register(router, {
      attachId: "attach-a",
      session: {
        surfaceId: "surface-a",
        sessionId: "session-a",
        epoch: "epoch-a"
      }
    });

    target.registration.notifyInput();
    turns.shift()?.();

    expect(order).toEqual(["a", "b"]);
    for (const complete of callbacks) complete();
    await Promise.all([a.completion, b.completion]);
    router.dispose();
  });

  it("carries input priority from a final checkpoint parse to the next surface quantum", async () => {
    const turns: Array<() => void> = [];
    const writes: Array<{ name: string; complete(): void }> = [];
    const router = new TerminalStreamRouter({
      writeArbiterOptions: {
        scheduleTurn: (callback) => turns.push(callback),
        now: () => 0
      }
    });
    const first = router.beginCooperativeWrite(
      "surface-a",
      "checkpoint",
      (_data, complete) => writes.push({ name: "checkpoint", complete })
    );
    turns.shift()?.();
    expect(writes.map((write) => write.name)).toEqual(["checkpoint"]);

    const target = register(router, {
      attachId: "attach-a",
      session: {
        surfaceId: "surface-a",
        sessionId: "session-a",
        epoch: "epoch-a"
      }
    });
    const peer = router.beginCooperativeWrite(
      "surface-b",
      "peer",
      (_data, complete) => writes.push({ name: "peer", complete })
    );
    target.registration.notifyInput();
    writes[0]?.complete();
    await first.completion;
    const next = router.beginCooperativeWrite(
      "surface-a",
      "echo",
      (_data, complete) => writes.push({ name: "echo", complete })
    );

    turns.shift()?.();

    expect(writes.map((write) => write.name)).toEqual([
      "checkpoint",
      "echo",
      "peer"
    ]);
    writes[1]?.complete();
    writes[2]?.complete();
    await Promise.all([next.completion, peer.completion]);
    router.dispose();
  });

  it("does not coalesce queued writes across CWD or presentation boundaries", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      writeScheduler: {
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => 0,
        catchUpPendingChars: 64 * 1024
      }
    });
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "seed"));
    harness.port.receive(output(1, "plain-a\n", { cwd: "/repo/a" }));
    harness.port.receive(output(2, "plain-b\n", { cwd: "/repo/b" }));
    harness.port.receive(output(3, "plain-c\n", { cwd: "/repo/b" }));
    harness.port.receive(output(4, "\u001b[31mred", { cwd: "/repo/b" }));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]?.data).toBe("seed");
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(harness.writes[1]?.data).toBe("plain-a\n");
    harness.writes[1]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3));
    expect(harness.writes[2]?.data).toBe("plain-b\nplain-c\n");
    harness.writes[2]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(4));
    expect(harness.writes[3]?.data).toBe("\u001b[31mred");
    harness.writes[3]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(5)));
    router.dispose();
  });

  it("records receive, parsed, and first render stages without terminal content", async () => {
    const records: Array<{
      name: string;
      details: Record<string, unknown>;
    }> = [];
    // Checkpoint begin/chunk/end consume the first three entry timestamps;
    // output receive, release, parse, and render use the remaining values.
    const timestamps = [900, 901, 902, 1_004, 1_005, 1_006, 1_008, 1_010];
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      metrics: {
        now: () => timestamps.shift() ?? 1_010,
        record: (name, details) => records.push({ name, details })
      }
    });
    await waitForCheckpoint(harness, 0);
    harness.port.receive({
      ...envelope(),
      telemetry: { portSentAt: 1_003 },
      type: "delta",
      delta: {
        type: "output",
        fromSequence: u(0),
        sequence: u(1),
        byteLength: 5,
        segments: [
          {
            sequence: u(1),
            data: "hello",
            byteLength: 5,
            telemetry: {
              ptyReadAt: 1_000,
              headlessCommitAt: 1_002,
              outputKind: "screen",
              visibleAtPtyRead: true,
              inputAcceptedAt: 999,
              inputSequence: u(7),
              inputKind: "mouse"
            }
          }
        ]
      }
    });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(records).toHaveLength(2));
    harness.registration.notifyRendered();

    expect(records.map((record) => record.name)).toEqual([
      "terminal.data-plane.receive",
      "terminal.data-plane.parsed",
      "terminal.data-plane.render"
    ]);
    expect(records[1]?.details).toMatchObject({
      surfaceId: "surface_1",
      sessionId: "session_1",
      sequence: "1",
      byteLength: 5,
      visibleAtPtyRead: true,
      inputAcceptedAt: 999,
      inputSequence: "7",
      inputKind: "mouse",
      outputKinds: ["screen"],
      ptyReadToHeadlessCommitMs: 2,
      portTransferMs: 1,
      portReceiveToParsedMs: 4,
      ptyReadToParsedMs: 8,
      schedulerDelayMs: 2,
      presentationPacingMs: 1,
      arbiterWaitMs: 1
    });
    expect(records[2]?.details).toMatchObject({
      onRenderAt: 1_010,
      parsedToRenderMs: 2,
      ptyReadToRenderMs: 10,
      inputToRenderMs: 11
    });
    expect(records[2]?.details).not.toHaveProperty("data");
  });

  it("toggles metrics for an existing attachment without changing output or credit", async () => {
    const records: string[] = [];
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "before"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(1)));

    router.configureMetrics(
      {
        now: () => 1_000,
        record: (name) => records.push(name)
      },
      1
    );
    harness.port.receive(output(1, "during"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    harness.writes[1]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(2)));

    router.configureMetrics(undefined);
    const recordCountAfterDisable = records.length;
    harness.port.receive(output(2, "after"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3));
    harness.writes[2]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(3)));

    expect(records).toContain("terminal.data-plane.receive");
    expect(records).toContain("terminal.data-plane.parsed");
    expect(records).toHaveLength(recordCountAfterDisable);
    expect(
      harness.port.sent
        .filter((message) => message.type === "credit")
        .map((message) => ({
          sequence:
            message.type === "credit" ? message.acknowledgedSequence : -1,
          bytes: message.type === "credit" ? message.bytes : -1
        }))
    ).toEqual([
      { sequence: u(1), bytes: 6 },
      { sequence: u(2), bytes: 6 },
      { sequence: u(3), bytes: 5 }
    ]);
    router.dispose();
  });

  it("closes only the failed surface when parsed bookkeeping throws", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      metrics: {
        now: () => 1,
        record(name) {
          if (name === "terminal.data-plane.parsed") {
            throw new Error("metrics failed");
          }
        }
      }
    });
    await waitForCheckpoint(harness, 0);
    harness.port.receive(output(0, "parsed"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));

    expect(() => harness.writes[0]?.complete()).not.toThrow();
    await vi.waitFor(() => expect(harness.registration.closed).toBe(true));
    expect(harness.errors).toContainEqual({
      kind: "sink-error",
      message: "metrics failed"
    });
    expect(
      harness.port.sent.filter((message) => message.type === "credit")
    ).toHaveLength(0);
  });

  it("excludes resume backlog from continuously-visible latency metrics", async () => {
    const records: Array<{
      name: string;
      details: Record<string, unknown>;
    }> = [];
    let now = 1_000;
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      resumeFromSequence: u(7),
      writeScheduler: {
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => now
      },
      metrics: {
        now: () => ++now,
        record: (name, details) => records.push({ name, details })
      }
    });
    harness.port.receive({
      ...envelope(),
      type: "attached",
      mode: "resume",
      resumedFromSequence: u(7),
      sequence: u(9),
      cols: 80,
      rows: 24
    });
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(7)));

    const sendOutput = (fromSequence: number): void => {
      const message = output(fromSequence, `output-${fromSequence}`);
      if (message.type !== "delta" || message.delta.type !== "output") {
        throw new Error("test output helper returned a non-output message");
      }
      const segment = message.delta.segments[0]!;
      segment.telemetry = {
        ptyReadAt: 900 + fromSequence,
        headlessCommitAt: 901 + fromSequence,
        visibleAtPtyRead: true
      };
      harness.port.receive(message);
    };
    for (const fromSequence of [7, 8]) {
      sendOutput(fromSequence);
    }
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(9)));
    sendOutput(9);
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    harness.writes[1]?.complete();
    await vi.waitFor(() =>
      expect(
        records.filter((record) => record.name === "terminal.data-plane.parsed")
      ).toHaveLength(3)
    );

    expect(
      records
        .filter((record) => record.name === "terminal.data-plane.parsed")
        .map((record) => record.details.visibleAtPtyRead)
    ).toEqual([false, false, true]);
    expect(harness.writes.map((write) => write.context)).toMatchObject([
      { presentation: "immediate" },
      { presentation: "plain" }
    ]);
  });

  it("attributes every parsed delta to a coalesced xterm render", async () => {
    const records: Array<{
      name: string;
      details: Record<string, unknown>;
    }> = [];
    let now = 1_000;
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      metrics: {
        now: () => ++now,
        record: (name, details) => records.push({ name, details })
      }
    });
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "one"));
    harness.port.receive(output(1, "two"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    await vi.waitFor(() =>
      expect(
        records.filter((record) => record.name.endsWith(".parsed"))
      ).toHaveLength(2)
    );

    harness.registration.notifyRendered();

    const renderRecords = records.filter(
      (record) => record.name === "terminal.data-plane.render"
    );
    expect(renderRecords.map((record) => record.details.sequence)).toEqual([
      "1",
      "2"
    ]);
    expect(renderRecords[0]?.details.onRenderAt).toBe(
      renderRecords[1]?.details.onRenderAt
    );
    expect(renderRecords[0]?.details.coalescedRenderSamples).toBe(2);
  });

  it("drops complete duplicate deltas but closes a stream on a sequence gap", async () => {
    const router = new TerminalStreamRouter();
    const duplicateHarness = register(router);
    await waitForCheckpoint(duplicateHarness, 4);

    const delta = output(4, "hello");
    duplicateHarness.port.receive(delta);
    await vi.waitFor(() => expect(duplicateHarness.writes).toHaveLength(1));
    duplicateHarness.writes[0]?.complete();
    await vi.waitFor(() => expect(duplicateHarness.port.sent).toHaveLength(3));
    duplicateHarness.port.receive(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(duplicateHarness.writes).toHaveLength(1);
    expect(duplicateHarness.port.sent).toHaveLength(3);

    duplicateHarness.port.receive(output(6, "gap"));
    await vi.waitFor(() =>
      expect(duplicateHarness.port.close).toHaveBeenCalledOnce()
    );
    expect(duplicateHarness.errors).toEqual([
      expect.objectContaining({
        kind: "sequence-gap",
        expectedSequence: u(6),
        receivedSequence: u(7)
      })
    ]);
  });

  it("ignores stale attach and epoch messages and replaces the old surface capability", async () => {
    const router = new TerminalStreamRouter();
    const oldHarness = register(router);

    sendCheckpoint(oldHarness.port, 0, { attachId: "attach_stale" });
    sendCheckpoint(oldHarness.port, 0, {
      session: { ...session, epoch: "epoch_stale" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldHarness.checkpoints).toHaveLength(0);
    expect(oldHarness.errors).toHaveLength(0);
    expect(oldHarness.port.close).not.toHaveBeenCalled();

    const nextSession = {
      ...session,
      sessionId: "session_2",
      epoch: "epoch_2"
    };
    const nextPort = new FakePort();
    const nextHarness = register(router, {
      port: nextPort,
      session: nextSession,
      attachId: "attach_2"
    });

    expect(oldHarness.port.sent.at(-1)).toMatchObject({
      type: "detach",
      reason: "replaced"
    });
    expect(oldHarness.port.close).toHaveBeenCalledOnce();
    sendCheckpoint(oldHarness.port, 1);
    expect(oldHarness.checkpoints).toHaveLength(0);

    sendCheckpoint(nextPort, 3, {
      attachId: "attach_2",
      session: nextSession
    });
    await vi.waitFor(() =>
      expect(nextHarness.registration.sequence).toBe(u(3))
    );
    expect(router.size).toBe(1);
  });

  it("resumes from the renderer sequence and applies resync checkpoints atomically", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router, { resumeFromSequence: u(7) });
    expect(harness.port.sent[0]).toMatchObject({
      type: "attach",
      resumeFromSequence: u(7)
    });

    harness.port.receive({
      ...envelope(),
      type: "attached",
      mode: "resume",
      resumedFromSequence: u(7),
      sequence: u(9),
      cols: 100,
      rows: 30
    });
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(7)));
    expect(harness.sink.applyResume).toHaveBeenCalledWith({
      resumedFromSequence: u(7),
      availableSequence: u(9),
      cols: 100,
      rows: 30
    });

    sendCheckpoint(
      harness.port,
      12,
      {},
      {
        kind: "resync",
        missingFromSequence: u(8),
        retainedFromSequence: u(9)
      }
    );
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(12)));
    expect(harness.events).toEqual(["resume:7", "checkpoint:12"]);

    sendCheckpoint(
      harness.port,
      11,
      {},
      {
        kind: "resync",
        missingFromSequence: u(8),
        retainedFromSequence: u(9)
      }
    );
    await vi.waitFor(() => expect(harness.port.close).toHaveBeenCalledOnce());
    expect(harness.errors.at(-1)).toMatchObject({
      kind: "sequence-gap",
      expectedSequence: u(12),
      receivedSequence: u(11)
    });
  });

  it("holds later mutations behind the resync swap and records its committed generation", async () => {
    const records: Array<{
      name: string;
      details: Record<string, unknown>;
    }> = [];
    let now = 1_000;
    const router = new TerminalStreamRouter();
    const sinkHarness = createSink({ autoCheckpoint: false });
    const harness = register(router, {
      sink: sinkHarness,
      metrics: {
        now: () => (now += 5),
        record: (name, details) => records.push({ name, details })
      }
    });
    sendCheckpoint(harness.port, 7);
    await vi.waitFor(() => expect(harness.checkpoints).toHaveLength(1));
    harness.checkpoints[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(7)));

    sendCheckpoint(
      harness.port,
      12,
      {},
      {
        kind: "resync",
        missingFromSequence: u(8),
        retainedFromSequence: u(9)
      }
    );
    harness.port.receive(output(12, "after-swap"));

    await vi.waitFor(() => expect(harness.checkpoints).toHaveLength(2));
    expect(harness.writes).toHaveLength(0);
    expect(harness.registration.sequence).toBe(u(7));
    harness.checkpoints[1]?.complete({ swapGeneration: 4 });

    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.events).toEqual([
      "checkpoint:7",
      "checkpoint:12",
      "write:13"
    ]);
    const resync = records.find(
      (record) => record.name === "terminal.data-plane.resync"
    );
    expect(resync?.details).toMatchObject({
      checkpointSequence: "12",
      missingFromSequence: "8",
      retainedFromSequence: "9",
      swapGeneration: 4
    });
    expect(resync?.details.durationMs).toEqual(expect.any(Number));
  });

  it("paces only conservative plain appends and bypasses pacing for split ANSI control", async () => {
    let frame: (() => void) | null = null;
    const runFrame = (): void => {
      const pendingFrame = frame;
      if (!pendingFrame) {
        throw new Error("no animation frame queued");
      }
      pendingFrame();
    };
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      writeScheduler: {
        requestAnimationFrame(callback) {
          frame = () => callback(16);
          return 1;
        },
        cancelAnimationFrame() {
          frame = null;
        },
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => 0,
        frameChunkChars: 16,
        catchUpPendingChars: 32,
        maxPresentationLagMs: 32
      }
    });
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "first\r\n"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]?.context.presentation).toBe("plain");
    harness.writes[0]?.complete();

    harness.port.receive(output(1, "second\n"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes).toHaveLength(1);
    expect(frame).not.toBeNull();
    runFrame();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    harness.writes[1]?.complete();

    harness.port.receive(output(2, "progress\r"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3));
    expect(harness.writes[2]?.context.presentation).toBe("immediate");
    harness.writes[2]?.complete();

    harness.port.receive(output(3, "\u001b[31"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(4));
    expect(harness.writes[3]?.context.presentation).toBe("immediate");
    harness.writes[3]?.complete();

    // This payload contains no ESC byte itself, but completes the CSI begun by
    // the prior delta, so it must remain immediate rather than being paced.
    harness.port.receive(output(4, "mred"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(5));
    expect(harness.writes[4]?.context.presentation).toBe("immediate");
  });

  it("coalesces presentation catch-up while retaining per-delta credit", async () => {
    let frame: (() => void) | null = null;
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      writeScheduler: {
        requestAnimationFrame(callback) {
          frame = () => callback(16);
          return 1;
        },
        cancelAnimationFrame() {
          frame = null;
        },
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => 0,
        frameChunkChars: 4,
        catchUpPendingChars: 5,
        maxPresentationLagMs: 32
      }
    });
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "aa"));
    harness.port.receive(output(1, "bbb"));
    harness.port.receive(output(2, "ccc"));

    // The latter two deltas exceed the presentation catch-up threshold before
    // the arbiter starts. All three still fit within one parser quantum, while
    // the credit ledger keeps their individual mutation boundaries.
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(frame).toBeNull();
    expect(harness.writes.map((write) => write.data)).toEqual(["aabbbccc"]);
    expect(
      harness.writes.map((write) => ({
        sequence: write.context.delta.sequence,
        dataOffset: write.context.dataOffset,
        finalPart: write.context.finalPart
      }))
    ).toEqual([{ sequence: u(3), dataOffset: 0, finalPart: true }]);
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.sequence).toBe(u(3)));
    expect(
      harness.port.sent
        .filter((message) => message.type === "credit")
        .map((message) =>
          message.type === "credit" ? message.acknowledgedSequence : -1
        )
    ).toEqual([u(1), u(2), u(3)]);
  });

  it("holds resize and later output behind every preceding parse callback", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);

    harness.port.receive(output(0, "one"));
    harness.port.receive(output(1, "two"));
    harness.port.receive({
      ...envelope(),
      type: "delta",
      delta: { type: "resize", sequence: u(3), cols: 100, rows: 30 }
    });
    harness.port.receive(output(3, "after"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.events).toEqual(["checkpoint:0", "write:2"]);
    expect(harness.events).not.toContain("resize:3");
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(harness.events).toEqual([
      "checkpoint:0",
      "write:2",
      "resize:3",
      "write:4"
    ]);
  });

  it("separates presentation pacing from global arbiter wait", async () => {
    let metricNow = 0;
    let frame: (() => void) | null = null;
    let arbiterTurn: (() => void) | null = null;
    const records: Array<{
      name: string;
      details: Record<string, unknown>;
    }> = [];
    const router = new TerminalStreamRouter({
      writeArbiterOptions: {
        now: () => metricNow,
        scheduleTurn(callback) {
          arbiterTurn = callback;
        }
      }
    });
    const harness = register(router, {
      metrics: {
        now: () => metricNow,
        record: (name, details) => records.push({ name, details })
      },
      writeScheduler: {
        requestAnimationFrame(callback) {
          frame = () => callback(metricNow);
          return 1;
        },
        cancelAnimationFrame() {
          frame = null;
        },
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => metricNow
      }
    });
    await waitForCheckpoint(harness, 0);
    harness.port.receive(output(0, "first"));
    await vi.waitFor(() => expect(arbiterTurn).not.toBeNull());
    const firstTurn = arbiterTurn;
    arbiterTurn = null;
    (firstTurn as (() => void) | null)?.();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();

    metricNow = 10;
    harness.port.receive(output(1, "paced"));
    await vi.waitFor(() => expect(frame).not.toBeNull());
    metricNow = 42;
    (frame as (() => void) | null)?.();
    await vi.waitFor(() => expect(arbiterTurn).not.toBeNull());
    metricNow = 50;
    const secondTurn = arbiterTurn;
    arbiterTurn = null;
    (secondTurn as (() => void) | null)?.();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    harness.writes[1]?.complete();
    await vi.waitFor(() =>
      expect(
        records.find(
          (record) =>
            record.name === "terminal.data-plane.parsed" &&
            record.details.sequence === "2"
        )?.details
      ).toMatchObject({
        schedulerDelayMs: 40,
        schedulerAddedDelayMs: 32,
        presentationPacingMs: 32,
        arbiterWaitMs: 8
      })
    );
  });

  it("exposes whether detach can safely resume a warm terminal", async () => {
    let frame: (() => void) | null = null;
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      writeScheduler: {
        requestAnimationFrame(callback) {
          frame = () => callback(16);
          return 1;
        },
        cancelAnimationFrame() {
          frame = null;
        },
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => 0,
        frameChunkChars: 2,
        catchUpPendingChars: 100
      }
    });
    await waitForCheckpoint(harness, 0);
    expect(harness.registration.resumeSafe).toBe(true);

    harness.port.receive(output(0, "x"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    await vi.waitFor(() => expect(harness.registration.resumeSafe).toBe(true));

    harness.port.receive(output(1, "abcd"));
    await vi.waitFor(() => expect(frame).not.toBeNull());
    expect(harness.registration.resumeSafe).toBe(false);
    (frame as (() => void) | null)?.();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(harness.writes[1]?.context).toMatchObject({
      dataOffset: 0,
      finalPart: false
    });
    expect(harness.registration.resumeSafe).toBe(false);
  });

  it("sends input immediately while prioritizing released presentation work", async () => {
    let frame: (() => void) | null = null;
    const router = new TerminalStreamRouter();
    const harness = register(router, {
      writeScheduler: {
        requestAnimationFrame(callback) {
          frame = () => callback(16);
          return 1;
        },
        cancelAnimationFrame() {
          frame = null;
        },
        setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeoutFn() {},
        now: () => 0
      }
    });
    await waitForCheckpoint(harness, 0);
    harness.port.receive(output(0, "first"));
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    harness.writes[0]?.complete();
    harness.port.receive(output(1, "paced"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes).toHaveLength(1);

    harness.registration.sendText("x");

    expect(harness.port.sent.at(-1)).toMatchObject({
      type: "input:text",
      text: "x"
    });
    expect(frame).toBeNull();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
  });

  it("flushes the interactive attachment without starving visible peers", async () => {
    const router = new TerminalStreamRouter();
    const dispatchOrder: string[] = [];
    const targetSink = createSink();
    const targetWrite = targetSink.sink.write.bind(targetSink.sink);
    targetSink.sink.write = (data, complete, context) => {
      dispatchOrder.push("target");
      targetWrite(data, complete, context);
    };
    const target = register(router, { sink: targetSink });
    const peerSession: TerminalSessionRef = {
      surfaceId: "surface_2",
      sessionId: "session_2",
      epoch: "epoch_2"
    };
    const peerSink = createSink();
    const peerWrite = peerSink.sink.write.bind(peerSink.sink);
    peerSink.sink.write = (data, complete, context) => {
      dispatchOrder.push("peer");
      peerWrite(data, complete, context);
    };
    const peer = register(router, {
      session: peerSession,
      attachId: "attach_2",
      sink: peerSink
    });
    await waitForCheckpoint(target, 0);
    sendCheckpoint(peer.port, 0, {
      attachId: "attach_2",
      session: peerSession
    });
    await vi.waitFor(() => expect(peer.registration.sequence).toBe(u(0)));

    target.registration.sendText("probe");
    peer.port.receive(
      output(0, "peer-one", {
        attachId: "attach_2",
        session: peerSession
      })
    );
    peer.port.receive(
      output(1, "peer-two", {
        attachId: "attach_2",
        session: peerSession
      })
    );
    target.port.receive(output(0, "target-echo"));
    await vi.waitFor(() => expect(target.writes).toHaveLength(1));
    await vi.waitFor(() => expect(peer.writes).toHaveLength(1));

    expect(dispatchOrder).toEqual(["target", "peer"]);
    expect(target.writes.map((write) => write.data)).toEqual(["target-echo"]);
    expect(peer.writes.map((write) => write.data)).toEqual([
      "peer-onepeer-two"
    ]);
    expect(peer.events).toEqual(["checkpoint:0", "write:2"]);

    target.writes[0]?.complete();
    expect(target.registration.sequence).toBe(u(1));
    peer.writes[0]?.complete();
    expect(peer.registration.sequence).toBe(u(2));
    expect(
      peer.port.sent
        .filter((message) => message.type === "credit")
        .map((message) =>
          message.type === "credit" ? message.acknowledgedSequence : -1
        )
    ).toEqual([u(1), u(2)]);
    router.dispose();
  });

  it("chunks large text and binary input without splitting Unicode code points", async () => {
    const router = new TerminalStreamRouter();
    const harness = register(router);
    await waitForCheckpoint(harness, 0);
    const text = `${"a".repeat(TERMINAL_DATA_PLANE_MAX_INPUT_BYTES - 1)}😀b`;
    const binary = "x".repeat(TERMINAL_DATA_PLANE_MAX_INPUT_BYTES + 1);

    harness.registration.sendText(text);
    harness.registration.sendBinary(binary);

    const textMessages = harness.port.sent.filter(
      (message) => message.type === "input:text"
    );
    const binaryMessages = harness.port.sent.filter(
      (message) => message.type === "input:binary"
    );
    expect(textMessages.map((message) => message.text).join("")).toBe(text);
    expect(textMessages).toHaveLength(2);
    expect(
      textMessages.every(
        (message) =>
          new TextEncoder().encode(message.text).byteLength <=
          TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
      )
    ).toBe(true);
    expect(binaryMessages.map((message) => message.data).join("")).toBe(binary);
    expect(binaryMessages).toHaveLength(2);
  });
});
