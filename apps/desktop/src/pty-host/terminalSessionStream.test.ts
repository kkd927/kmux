import { EventEmitter } from "node:events";

import type {
  TerminalCheckpoint,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneHostMessage,
  TerminalDelta,
  TerminalSessionRef
} from "@kmux/proto";
import {
  TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_MAX_DELTA_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION
} from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import { TerminalDeltaStore } from "./terminalDeltaStore";
import {
  type TerminalDataPortLike,
  TerminalSessionStream,
  TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES
} from "./terminalSessionStream";
import {
  sliceTerminalOutputAfterSequence,
  terminalDeltaRetainedBytes
} from "./terminalWireCoalescing";
import { TerminalCheckpointTooLargeError } from "./snapshotCache";

const session: TerminalSessionRef = {
  surfaceId: "surface_1",
  sessionId: "session_1",
  epoch: "epoch_1"
};

class FakePort extends EventEmitter implements TerminalDataPortLike {
  readonly sent: TerminalDataPlaneHostMessage[] = [];
  readonly close = vi.fn();
  readonly start = vi.fn();

  postMessage(message: unknown): void {
    this.sent.push(message as TerminalDataPlaneHostMessage);
  }

  receive(message: TerminalDataPlaneClientMessage): void {
    this.emit("message", { data: message });
  }
}

function createDeltaStore(
  maxSessionBytes = 1024,
  maxSessionEvents = 32
): TerminalDeltaStore<TerminalDelta> {
  return new TerminalDeltaStore({
    maxSessionBytes,
    maxSessionEvents,
    maxTotalBytes: Math.max(4096, maxSessionBytes * 2),
    maxTotalEvents: Math.max(4096, maxSessionEvents * 2),
    rangeOf: (delta) => ({
      fromSequence:
        delta.type === "output" ? delta.fromSequence : delta.sequence - 1,
      sequence: delta.sequence
    }),
    sizeOf: terminalDeltaRetainedBytes,
    replaySizeOf: (delta) => (delta.type === "output" ? delta.byteLength : 0),
    sliceAfterInternalCursor: sliceTerminalOutputAfterSequence
  });
}

function checkpoint(sequence = 0): TerminalCheckpoint {
  return {
    format: "xterm-vt/1",
    session,
    sequence,
    data: "snapshot",
    cols: 80,
    rows: 24
  };
}

function outputDelta(
  sequence: number,
  data = "hello",
  cwd?: string
): TerminalDelta {
  return {
    type: "output",
    fromSequence: sequence - 1,
    sequence,
    byteLength: Buffer.byteLength(data, "utf8"),
    segments: [
      {
        sequence,
        data,
        byteLength: Buffer.byteLength(data, "utf8"),
        ...(cwd === undefined ? {} : { cwd })
      }
    ]
  };
}

function clientEnvelope(attachId = "attach_1") {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId,
    session
  } as const;
}

function createHarness(
  options: {
    maxSessionBytes?: number;
    maxSessionEvents?: number;
    telemetryNow?: () => number;
  } = {}
) {
  const deltaStore = createDeltaStore(
    options.maxSessionBytes,
    options.maxSessionEvents
  );
  const writeText = vi.fn();
  const writeBinary = vi.fn();
  const writeKey = vi.fn();
  const resize = vi.fn(async ({ cols, rows }) => ({
    sequence: 1,
    cols,
    rows
  }));
  const createCheckpoint = vi.fn(async () =>
    checkpoint(deltaStore.latestSequence(session.sessionId))
  );
  const onClosed = vi.fn();
  const stream = new TerminalSessionStream({
    session,
    deltaStore,
    createCheckpoint,
    getDimensions: () => ({ cols: 80, rows: 24 }),
    writeText,
    writeBinary,
    writeKey,
    resize,
    onClosed,
    telemetryNow: options.telemetryNow
  });
  return {
    stream,
    deltaStore,
    writeText,
    writeBinary,
    writeKey,
    resize,
    createCheckpoint,
    onClosed
  };
}

async function attach(
  port: FakePort,
  resumeFromSequence?: number
): Promise<void> {
  port.receive({
    ...clientEnvelope(),
    type: "attach",
    creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
    ...(resumeFromSequence === undefined ? {} : { resumeFromSequence })
  });
  await vi.waitFor(() => {
    expect(port.sent.some((message) => message.type === "attached")).toBe(true);
  });
}

describe("TerminalSessionStream", () => {
  it("starts from a checkpoint and pushes committed deltas directly", async () => {
    const { stream } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    stream.publish(outputDelta(1));

    expect(port.sent.map((message) => message.type)).toEqual([
      "attached",
      "delta"
    ]);
  });

  it("keeps committed state current without any renderer subscriber", () => {
    const { stream, deltaStore } = createHarness();

    stream.publish(outputDelta(1, "headless"));

    expect(stream.attachmentCount).toBe(0);
    expect(deltaStore.latestSequence(session.sessionId)).toBe(1);
    expect(deltaStore.stats()).toMatchObject({ events: 1 });
  });

  it("does not recreate a removed ring from a publish after disposal", () => {
    const { stream, deltaStore } = createHarness();
    stream.dispose();
    deltaStore.removeSession(session.sessionId);

    stream.publish(outputDelta(1, "late output"));

    expect(deltaStore.latestSequence(session.sessionId)).toBe(0);
    expect(deltaStore.stats()).toMatchObject({ sessions: 0, events: 0 });
  });

  it("serves a final checkpoint and exit to a subscriber attached after exit", async () => {
    const { stream } = createHarness();
    stream.publish(outputDelta(1, "final output"));
    stream.exit(7);

    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    expect(port.sent.map((message) => message.type)).toEqual([
      "attached",
      "exit"
    ]);
    expect(port.sent[0]).toMatchObject({
      type: "attached",
      mode: "checkpoint",
      checkpoint: { sequence: 1 }
    });
    expect(port.sent[1]).toMatchObject({
      type: "exit",
      afterSequence: 1,
      exitCode: 7
    });
  });

  it("rejects a delta that can never fit the fixed initial credit window", () => {
    const { stream, deltaStore } = createHarness({
      maxSessionBytes: TERMINAL_DATA_PLANE_MAX_DELTA_BYTES * 2
    });
    const oversized = outputDelta(
      1,
      "x".repeat(TERMINAL_DATA_PLANE_MAX_DELTA_BYTES + 1)
    );

    expect(() => stream.publish(oversized)).toThrow(
      `terminal output delta exceeds ${TERMINAL_DATA_PLANE_MAX_DELTA_BYTES} bytes`
    );
    expect(deltaStore.latestSequence(session.sessionId)).toBe(0);
  });

  it("holds live deltas until the initial checkpoint attach is atomic", async () => {
    const deltaStore = createDeltaStore();
    let resolveCheckpoint!: (value: TerminalCheckpoint) => void;
    const stream = new TerminalSessionStream({
      session,
      deltaStore,
      createCheckpoint: () =>
        new Promise((resolve) => {
          resolveCheckpoint = resolve;
        }),
      getDimensions: () => ({ cols: 80, rows: 24 }),
      writeText: vi.fn(),
      writeBinary: vi.fn(),
      writeKey: vi.fn(),
      resize: vi.fn(async () => ({ sequence: 0, cols: 80, rows: 24 }))
    });
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES
    });
    await vi.waitFor(() => expect(resolveCheckpoint).toBeTypeOf("function"));

    stream.publish(outputDelta(1, "after snapshot barrier"));
    expect(port.sent).toEqual([]);

    resolveCheckpoint(checkpoint(0));
    await vi.waitFor(() =>
      expect(port.sent.map((message) => message.type)).toEqual([
        "attached",
        "delta"
      ])
    );
  });

  it("closes one attachment with a fatal code when screen-only checkpoint is oversized", async () => {
    const deltaStore = createDeltaStore();
    const stream = new TerminalSessionStream({
      session,
      deltaStore,
      createCheckpoint: async () => {
        throw new TerminalCheckpointTooLargeError(101, 100);
      },
      getDimensions: () => ({ cols: 80, rows: 24 }),
      writeText: vi.fn(),
      writeBinary: vi.fn(),
      writeKey: vi.fn(),
      resize: vi.fn(async () => ({ sequence: 0, cols: 80, rows: 24 }))
    });
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES
    });

    await vi.waitFor(() =>
      expect(port.sent).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "checkpoint-too-large",
          recoverable: false
        })
      )
    );
    expect(port.close).toHaveBeenCalledOnce();
    expect(stream.attachmentCount).toBe(0);

    stream.publish(outputDelta(1, "later"));
    expect(
      port.sent.filter((message) => message.type === "error")
    ).toHaveLength(1);
  });

  it("holds output after consuming credit and resumes after a parse acknowledgement", async () => {
    const { stream } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: 5
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    stream.publish(outputDelta(1, "hello"));
    stream.publish(outputDelta(2, "world"));
    expect(port.sent).toHaveLength(2);
    expect(stream.stats()).toEqual({
      maxCreditBytes: TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
      maxOutstandingOutputEvents: 32,
      maxOutstandingOutputBytes:
        TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES,
      attachments: 1,
      startedAttachments: 1,
      resyncingAttachments: 0,
      creditBytes: 0,
      maxAttachmentCreditBytes: 0,
      peakAttachmentCreditBytes: 5,
      outstandingOutputEvents: 1,
      maxAttachmentOutstandingOutputEvents: 1,
      peakAttachmentOutstandingOutputEvents: 1,
      outstandingOutputBytes: 5,
      maxAttachmentOutstandingOutputBytes: 5,
      peakAttachmentOutstandingOutputBytes: 5,
      creditBoundViolationCount: 0
    });

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 5
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toMatchObject({
      type: "delta",
      delta: { sequence: 2 }
    });
    expect(stream.stats()).toMatchObject({
      creditBytes: 0,
      maxAttachmentCreditBytes: 0,
      peakAttachmentCreditBytes: 5,
      outstandingOutputEvents: 1,
      outstandingOutputBytes: 5,
      maxAttachmentOutstandingOutputBytes: 5,
      peakAttachmentOutstandingOutputBytes: 5,
      creditBoundViolationCount: 0
    });
  });

  it("replays the retained suffix after wire coalescing exposes an internal cursor", async () => {
    const { stream, createCheckpoint } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: 3
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    stream.publish({
      type: "output",
      fromSequence: 0,
      sequence: 2,
      byteLength: 6,
      segments: [
        { sequence: 1, data: "one", byteLength: 3 },
        { sequence: 2, data: "two", byteLength: 3 }
      ]
    });
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: { fromSequence: 0, sequence: 1, byteLength: 3 }
    });

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 3
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));

    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: {
        fromSequence: 1,
        sequence: 2,
        byteLength: 3,
        segments: [{ sequence: 2, data: "two" }]
      }
    });
    expect(
      port.sent.filter((message) => message.type === "resync-required")
    ).toHaveLength(0);
    expect(createCheckpoint).toHaveBeenCalledOnce();
  });

  it("does not rebuild the unsent replay while waiting for renderer credit", async () => {
    const { stream, deltaStore } = createHarness();
    const replayAfter = vi.spyOn(deltaStore, "replayAfter");
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: 5
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    stream.publish(outputDelta(1, "hello"));
    stream.publish(outputDelta(2, "world"));
    const replayCallsWhenBlocked = replayAfter.mock.calls.length;

    for (let sequence = 3; sequence <= 20; sequence += 1) {
      stream.publish(outputDelta(sequence, "later"));
    }

    expect(replayAfter).toHaveBeenCalledTimes(replayCallsWhenBlocked);
    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(1);

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 5
    });
    await vi.waitFor(() =>
      expect(
        port.sent.filter((message) => message.type === "delta")
      ).toHaveLength(2)
    );
    expect(replayAfter.mock.calls.length).toBeGreaterThan(
      replayCallsWhenBlocked
    );
  });

  it("keeps the unacknowledged renderer backlog within one parser slice", async () => {
    const { stream } = createHarness({
      maxSessionBytes: 128 * 1024,
      maxSessionEvents: 128
    });
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    const data = "x".repeat(1024);
    for (let sequence = 1; sequence <= 65; sequence += 1) {
      stream.publish(outputDelta(sequence, data));
    }

    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(64);
    expect(stream.stats()).toMatchObject({
      maxOutstandingOutputBytes: 64 * 1024,
      outstandingOutputBytes: 64 * 1024,
      peakAttachmentOutstandingOutputBytes: 64 * 1024,
      creditBoundViolationCount: 0
    });

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 1024
    });
    await vi.waitFor(() =>
      expect(
        port.sent.filter((message) => message.type === "delta")
      ).toHaveLength(65)
    );
    expect(stream.stats().outstandingOutputBytes).toBe(64 * 1024);
  });

  it("accepts interactive input without blocking the bounded output cursor", async () => {
    const { stream, writeText } = createHarness({
      maxSessionBytes: 128 * 1024,
      maxSessionEvents: 128
    });
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    const data = "x".repeat(1024);
    for (let sequence = 1; sequence <= 65; sequence += 1) {
      stream.publish(outputDelta(sequence, data));
    }
    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(64);

    port.receive({ ...clientEnvelope(), type: "input:text", text: "a" });
    expect(writeText).toHaveBeenCalledWith("a");
    expect(stream.stats().outstandingOutputBytes).toBe(64 * 1024);
    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 1024
    });
    await vi.waitFor(() =>
      expect(
        port.sent.filter((message) => message.type === "delta")
      ).toHaveLength(65)
    );
    expect(stream.stats().outstandingOutputBytes).toBe(64 * 1024);
  });

  it("replays a full parser window in wire messages no larger than 16 KiB", async () => {
    const { stream } = createHarness({
      maxSessionBytes: 128 * 1024,
      maxSessionEvents: 128
    });
    const data = "x".repeat(1024);
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      stream.publish(outputDelta(sequence, data));
    }

    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port, 0);
    await vi.waitFor(() =>
      expect(
        port.sent.filter((message) => message.type === "delta")
      ).toHaveLength(2)
    );

    expect(
      port.sent
        .filter(
          (
            message
          ): message is Extract<
            TerminalDataPlaneHostMessage,
            { type: "delta" }
          > => message.type === "delta"
        )
        .map((message) => message.delta)
    ).toMatchObject([
      { type: "output", sequence: 16, byteLength: 16 * 1024 },
      { type: "output", sequence: 20, byteLength: 4 * 1024 }
    ]);
  });

  it("charges unique cwd metadata to retention without consuming output credit", async () => {
    const { stream, deltaStore } = createHarness({
      maxSessionBytes: 256 * 1024,
      maxSessionEvents: 32
    });
    const cwdPrefix = `/${"a".repeat(64 * 1024 - 2)}`;
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      stream.publish(outputDelta(sequence, "x", `${cwdPrefix}${sequence}`));
    }

    expect(deltaStore.stats()).toMatchObject({
      events: 3,
      bytes: 3 * (64 * 1024 + 1)
    });

    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port, 0);

    const replayed = port.sent.filter(
      (
        message
      ): message is Extract<TerminalDataPlaneHostMessage, { type: "delta" }> =>
        message.type === "delta"
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.delta).toMatchObject({
      type: "output",
      fromSequence: 0,
      sequence: 3,
      byteLength: 3
    });
    expect(stream.stats()).toMatchObject({
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES - 3,
      outstandingOutputBytes: 3
    });
  });

  it("timestamps direct output transfer only when telemetry is enabled", async () => {
    const { stream } = createHarness({ telemetryNow: () => 1_234.5 });
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    stream.publish(outputDelta(1));

    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      telemetry: { portSentAt: 1_234.5 }
    });
  });

  it("toggles transfer telemetry without changing sequence or credit", async () => {
    const { stream } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    stream.publish(outputDelta(1, "one"));
    const first = port.sent.at(-1);
    expect(first).toMatchObject({ type: "delta", delta: { sequence: 1 } });
    expect(first).not.toHaveProperty("telemetry");
    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 3
    });

    stream.configureTelemetryNow(() => 2_000);
    stream.publish(outputDelta(2, "two"));
    expect(port.sent.at(-1)).toMatchObject({
      type: "delta",
      delta: { sequence: 2 },
      telemetry: { portSentAt: 2_000 }
    });
    expect(stream.stats()).toMatchObject({
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES - 3,
      outstandingOutputBytes: 3
    });
  });

  it("does not let a renderer mint credit by acknowledging the same output twice", async () => {
    const { stream } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);
    stream.publish(outputDelta(1, "hello"));

    const credit: TerminalDataPlaneClientMessage = {
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 5
    };
    port.receive(credit);
    port.receive(credit);

    await vi.waitFor(() =>
      expect(
        port.sent.some(
          (message) =>
            message.type === "error" && message.code === "invalid-message"
        )
      ).toBe(true)
    );
  });

  it("caps a tiny-delta ledger and drains 3,000 events through bounded replay windows", async () => {
    const { stream, deltaStore } = createHarness({
      maxSessionBytes: 4_096,
      maxSessionEvents: 4_096
    });
    const replayAfter = vi.spyOn(deltaStore, "replayAfter");
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    for (let sequence = 1; sequence <= 3_000; sequence += 1) {
      stream.publish(outputDelta(sequence, "x"));
    }

    expect(
      port.sent.filter((message) => message.type === "delta")
    ).toHaveLength(2_048);
    expect(stream.stats()).toMatchObject({
      maxOutstandingOutputEvents: 2_048,
      outstandingOutputEvents: 2_048,
      maxAttachmentOutstandingOutputEvents: 2_048,
      peakAttachmentOutstandingOutputEvents: 2_048,
      outstandingOutputBytes: 2_048,
      maxAttachmentOutstandingOutputBytes: 2_048,
      peakAttachmentOutstandingOutputBytes: 2_048,
      creditBoundViolationCount: 0
    });

    const initialDeltas = port.sent.filter(
      (
        message
      ): message is Extract<TerminalDataPlaneHostMessage, { type: "delta" }> =>
        message.type === "delta"
    );
    for (const message of initialDeltas) {
      if (message.delta.type !== "output") {
        throw new Error("expected output deltas to acknowledge");
      }
      port.receive({
        ...clientEnvelope(),
        type: "credit",
        acknowledgedSequence: message.delta.sequence,
        bytes: message.delta.byteLength
      });
    }

    const catchUp = port.sent.at(-1);
    if (catchUp?.type !== "delta" || catchUp.delta.type !== "output") {
      throw new Error("expected one coalesced catch-up output delta");
    }
    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: catchUp.delta.sequence,
      bytes: catchUp.delta.byteLength
    });

    const sentDeltas = port.sent.filter((message) => message.type === "delta");
    expect(sentDeltas).toHaveLength(2_049);
    expect(sentDeltas.at(-1)).toMatchObject({
      delta: { fromSequence: 2_048, sequence: 3_000, byteLength: 952 }
    });
    expect(
      port.sent.filter((message) => message.type === "error")
    ).toHaveLength(0);
    expect(stream.stats()).toMatchObject({
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
      outstandingOutputEvents: 0,
      maxAttachmentOutstandingOutputEvents: 0,
      peakAttachmentOutstandingOutputEvents: 2_048,
      outstandingOutputBytes: 0,
      maxAttachmentOutstandingOutputBytes: 0,
      peakAttachmentOutstandingOutputBytes: 2_999,
      creditBoundViolationCount: 0
    });
    expect(
      replayAfter.mock.calls.every((call) => {
        const window = call[2];
        return (
          typeof window?.maxBytes === "number" &&
          window.maxBytes <=
            TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES &&
          window.maxEvents === 4_096
        );
      })
    ).toBe(true);
  }, 15_000);

  it("rejects forged acknowledgement sequences and byte totals", async () => {
    const { stream } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);
    stream.publish({
      type: "output",
      fromSequence: 0,
      sequence: 2,
      byteLength: 2,
      segments: [
        { sequence: 1, data: "a", byteLength: 1 },
        { sequence: 2, data: "b", byteLength: 1 }
      ]
    });

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 1
    });
    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 2,
      bytes: 1
    });

    expect(
      port.sent.filter((message) => message.type === "error")
    ).toHaveLength(2);
    expect(stream.stats()).toMatchObject({
      outstandingOutputEvents: 1,
      outstandingOutputBytes: 2
    });

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 2,
      bytes: 2
    });
    expect(stream.stats()).toMatchObject({
      outstandingOutputEvents: 0,
      outstandingOutputBytes: 0
    });
  });

  it("rejects stale attach capabilities before handling input", async () => {
    const { stream, writeText } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.emit("message", {
      data: {
        ...clientEnvelope("attach_stale"),
        type: "input:text",
        text: "unsafe"
      }
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    expect(port.sent[0]).toMatchObject({
      type: "error",
      code: "invalid-message"
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("sends one explicit resync checkpoint when resume history has a gap", async () => {
    const { stream, deltaStore, createCheckpoint } = createHarness({
      maxSessionBytes: 5
    });
    deltaStore.append(session.sessionId, outputDelta(1, "12345"));
    deltaStore.append(session.sessionId, outputDelta(2, "67890"));
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
      resumeFromSequence: 0
    });
    await vi.waitFor(() =>
      expect(
        port.sent.some((message) => message.type === "resync-required")
      ).toBe(true)
    );

    expect(createCheckpoint).toHaveBeenCalledOnce();
    expect(port.sent[0]).toMatchObject({
      type: "resync-required",
      missingFromSequence: 1,
      retainedFromSequence: 2,
      checkpoint: { sequence: 2 }
    });
  });

  it("routes input immediately and returns an ordered resize acknowledgement", async () => {
    const { stream, writeText, resize } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    port.receive({
      ...clientEnvelope(),
      type: "input:text",
      text: "a"
    });
    port.receive({
      ...clientEnvelope(),
      type: "resize",
      requestId: "resize_1",
      cols: 120,
      rows: 40
    });

    await vi.waitFor(() =>
      expect(port.sent.some((message) => message.type === "resize:ack")).toBe(
        true
      )
    );
    expect(writeText).toHaveBeenCalledWith("a");
    expect(resize).toHaveBeenCalledWith({
      protocol: 2,
      attachId: "attach_1",
      session,
      type: "resize",
      requestId: "resize_1",
      cols: 120,
      rows: 40
    });
  });

  it("preserves text and binary input order at the PTY boundary", async () => {
    const { stream, writeText, writeBinary } = createHarness();
    const order: string[] = [];
    writeText.mockImplementation((text) => order.push(`text:${text}`));
    writeBinary.mockImplementation((data) => order.push(`binary:${data}`));
    const port = new FakePort();
    stream.bind("attach_1", port);
    await attach(port);

    port.receive({ ...clientEnvelope(), type: "input:text", text: "A" });
    port.receive({ ...clientEnvelope(), type: "input:binary", data: "\u0001" });
    port.receive({ ...clientEnvelope(), type: "input:text", text: "B" });

    expect(order).toEqual(["text:A", "binary:\u0001", "text:B"]);
  });

  it("delays exit until credit allows every committed delta to be sent", async () => {
    const { stream, onClosed } = createHarness();
    const port = new FakePort();
    stream.bind("attach_1", port);
    port.receive({
      ...clientEnvelope(),
      type: "attach",
      creditBytes: 5
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    stream.publish(outputDelta(1, "hello"));
    stream.publish(outputDelta(2, "world"));
    stream.exit(0);

    expect(port.sent.map((message) => message.type)).toEqual([
      "attached",
      "delta"
    ]);
    expect(onClosed).not.toHaveBeenCalled();

    port.receive({
      ...clientEnvelope(),
      type: "credit",
      acknowledgedSequence: 1,
      bytes: 5
    });

    await vi.waitFor(() =>
      expect(port.sent.map((message) => message.type)).toEqual([
        "attached",
        "delta",
        "delta",
        "exit"
      ])
    );
    expect(port.sent.at(-1)).toMatchObject({
      type: "exit",
      afterSequence: 2,
      exitCode: 0
    });
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
