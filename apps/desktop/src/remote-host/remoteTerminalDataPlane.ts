import { createHash } from "node:crypto";

import type { RemoteResourceKey } from "@kmux/core";
import {
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_MAX_DELTA_BYTES,
  TERMINAL_DATA_PLANE_MAX_INPUT_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  UINT64_MAX,
  incrementUint64,
  makeId,
  parseUint64Decimal,
  uint64,
  validateTerminalDataPlaneClientMessage,
  type Id,
  type TerminalCheckpointPurpose,
  type TerminalDataPlaneClientMessage,
  type TerminalDataPlaneErrorCode,
  type TerminalDataPlaneHostMessage,
  type TerminalSessionRef,
  type Uint64
} from "@kmux/proto";

import { encodeTerminalKeyInput } from "../pty-host/terminalInput";
import type {
  RemoteTerminalAttachReady,
  RemoteTerminalCheckpointTransfer,
  RemoteTerminalMutation
} from "./linuxX64RemoteRuntime";

export interface RemoteTerminalDataPortLike {
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
  on(event: "close" | "messageerror", listener: () => void): unknown;
  off?(event: "message", listener: (event: unknown) => void): unknown;
  off?(event: "close" | "messageerror", listener: () => void): unknown;
}

export interface RemoteTerminalAttachmentLike {
  readonly ready: Promise<RemoteTerminalAttachReady>;
  readonly checkpoint: Promise<RemoteTerminalCheckpointTransfer | null>;
  nextMutation(): Promise<RemoteTerminalMutation | null>;
  sendInput(inputSequence: Uint64, data: Uint8Array): Promise<unknown>;
  resize(
    cols: number,
    rows: number
  ): Promise<{
    mutationSequence: string;
    cols: number;
    rows: number;
  }>;
  detach(): Promise<void>;
}

export interface RemoteTerminalRuntimeLike {
  attach(options: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
    expectedKeeperGeneration?: Id;
    access: "read" | "write";
    lastReceivedSequence?: Uint64;
    attachmentId?: Id;
  }): Promise<RemoteTerminalAttachmentLike>;
}

export interface RemoteTerminalDataPlaneOptions {
  runtime: RemoteTerminalRuntimeLike;
  resourceKey: RemoteResourceKey & { sessionId: Id };
  expectedKeeperGeneration: Id;
  attachId: Id;
  session: TerminalSessionRef;
  port: RemoteTerminalDataPortLike;
  onCursorAdvanced?: (sequence: Uint64) => void;
  onClosed?: () => void;
  onRuntimeLost?: (error: unknown) => void;
}

interface OutstandingOutput {
  sequence: Uint64;
  bytes: number;
}

interface CheckpointChunkCursor {
  chunks: Uint8Array[];
  chunkIndex: number;
  chunkOffset: number;
}

interface CheckpointSendState {
  checkpointId: Id;
  cursor: CheckpointChunkCursor;
  sentOffset: number;
  acknowledgedOffset: number;
  totalBytes: number;
  digest: string;
  outstanding: Array<{ endOffset: number; bytes: number }>;
  outstandingHead: number;
  endSent: boolean;
}

interface DeferredResizeAck {
  requestId: Id;
  sequence: Uint64;
  cols: number;
  rows: number;
}

const MAX_MUTATIONS_PER_TURN = 64;
const MAX_MUTATION_BYTES_PER_TURN = 256 * 1024;
const MAX_OUTSTANDING_OUTPUT_MUTATIONS = 4_096;
const MAX_PENDING_WRITES = 1_024;
const MAX_PENDING_RESIZE_ACKNOWLEDGEMENTS = 1_024;
const REMOTE_CHECKPOINT_PARSER_VERSION = "vt100/0.16";

/**
 * Owns one direct renderer attachment. Remote wire and writer-lease details
 * stop here; the renderer sees only the common TerminalDataPlane protocol.
 */
export class RemoteTerminalDataPlaneAdapter {
  private readonly onMessage = (event: unknown): void => {
    try {
      this.receive(messageData(event));
    } catch (error) {
      this.fail(error);
    }
  };
  private readonly onPortClosed = (): void => {
    void this.close(false);
  };
  private attachment: RemoteTerminalAttachmentLike | null = null;
  private initialization: Promise<void> | null = null;
  private started = false;
  private readyForMutations = false;
  private closed = false;
  private creditBytes = 0;
  private sentSequence = uint64(0n);
  private acknowledgedSequence = uint64(0n);
  private readonly outstandingOutput: OutstandingOutput[] = [];
  private outstandingOutputHead = 0;
  private checkpoint: CheckpointSendState | null = null;
  private pendingMutation: RemoteTerminalMutation | null | undefined;
  private mutationPumpRunning = false;
  private inputSequence = uint64(0n);
  private pendingInputBytes = 0;
  private pendingWrites = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly resizeAcks: DeferredResizeAck[] = [];
  private pendingResizeAcknowledgements = 0;
  private closedNotified = false;

  constructor(private readonly options: RemoteTerminalDataPlaneOptions) {
    if (options.session.epoch !== options.expectedKeeperGeneration) {
      throw new TypeError(
        "remote terminal session epoch must be the expected keeper generation"
      );
    }
    options.port.on("message", this.onMessage);
    options.port.on("close", this.onPortClosed);
    options.port.on("messageerror", this.onPortClosed);
    options.port.start?.();
  }

  dispose(): Promise<void> {
    return this.close(true);
  }

  private receive(rawMessage: unknown): void {
    if (this.closed) return;
    const validation = validateTerminalDataPlaneClientMessage(rawMessage, {
      attachId: this.options.attachId,
      session: this.options.session
    });
    if (!validation.ok) {
      this.sendError("invalid-message", validation.error, true);
      return;
    }
    const message = validation.value;
    if (message.type === "attach") {
      if (this.started) {
        this.sendError(
          "stale-attach",
          "terminal attachment was already started",
          false
        );
        return;
      }
      this.started = true;
      this.creditBytes = message.creditBytes;
      this.initialization = this.initialize(message);
      void this.initialization.catch((error: unknown) => this.fail(error));
      return;
    }
    if (!this.started) {
      this.sendError(
        "stale-attach",
        "attach must be the first terminal data-plane message",
        false
      );
      return;
    }

    switch (message.type) {
      case "credit":
        this.acceptOutputCredit(message);
        return;
      case "checkpoint:credit":
        this.acceptCheckpointCredit(message);
        return;
      case "input:text":
      case "input:binary":
      case "input:key":
        this.queueInput(message);
        return;
      case "resize":
        this.queueResize(message);
        return;
      case "detach":
        void this.close(true);
        return;
      default:
        return;
    }
  }

  private async initialize(
    message: Extract<TerminalDataPlaneClientMessage, { type: "attach" }>
  ): Promise<void> {
    let attachment = await this.options.runtime.attach({
      resourceKey: structuredClone(this.options.resourceKey),
      expectedKeeperGeneration: this.options.expectedKeeperGeneration,
      access: "write",
      ...(message.resumeFromSequence === undefined
        ? {}
        : { lastReceivedSequence: message.resumeFromSequence })
    });
    if (this.closed) {
      await attachment.detach().catch(() => undefined);
      return;
    }
    this.attachment = attachment;
    let ready = await attachment.ready;
    if (
      ready.keeperGeneration !== this.options.expectedKeeperGeneration ||
      ready.keeperGeneration !== this.options.session.epoch
    ) {
      throw new Error("remote keeper generation changed during attachment");
    }
    let checkpoint = await attachment.checkpoint;
    if (this.closed) return;

    if (
      checkpoint &&
      (checkpoint.metadata.format !== "xterm-vt/1" ||
        checkpoint.metadata.parserVersion !== REMOTE_CHECKPOINT_PARSER_VERSION)
    ) {
      await attachment.detach();
      if (this.attachment === attachment) this.attachment = null;
      if (this.closed) return;
      if (ready.earliestAvailableSequence === 0n) {
        throw new Error(
          "remote keeper advertised an invalid retained replay boundary"
        );
      }
      const replayCursor = uint64(ready.earliestAvailableSequence - 1n);
      attachment = await this.options.runtime.attach({
        resourceKey: structuredClone(this.options.resourceKey),
        expectedKeeperGeneration: this.options.expectedKeeperGeneration,
        access: "write",
        lastReceivedSequence: replayCursor
      });
      if (this.closed) {
        await attachment.detach().catch(() => undefined);
        return;
      }
      this.attachment = attachment;
      ready = await attachment.ready;
      if (
        ready.keeperGeneration !== this.options.expectedKeeperGeneration ||
        ready.keeperGeneration !== this.options.session.epoch
      ) {
        throw new Error(
          "remote keeper generation changed during replay fallback"
        );
      }
      checkpoint = await attachment.checkpoint;
      if (this.closed) return;
      if (
        checkpoint ||
        ready.replayFromSequence !== saturatingIncrement(replayCursor)
      ) {
        throw new Error(
          "remote keeper did not provide retained replay after an incompatible checkpoint"
        );
      }
      this.beginSyntheticCheckpoint(
        ready,
        checkpointPurpose(message.resumeFromSequence, ready)
      );
      return;
    }

    if (checkpoint?.metadata.format === "xterm-vt/1") {
      this.beginCheckpoint(
        ready,
        checkpoint,
        checkpointPurpose(message.resumeFromSequence, ready)
      );
      return;
    }
    if (message.resumeFromSequence === undefined) {
      this.beginSyntheticCheckpoint(ready, { kind: "attach" });
      return;
    }

    const expectedReplay = saturatingIncrement(message.resumeFromSequence);
    if (ready.replayFromSequence !== expectedReplay) {
      throw new Error(
        "remote keeper did not provide a checkpoint for a replay gap"
      );
    }
    this.sentSequence = message.resumeFromSequence;
    this.acknowledgedSequence = message.resumeFromSequence;
    this.post({
      ...this.envelope(),
      type: "attached",
      mode: "resume",
      resumedFromSequence: message.resumeFromSequence,
      sequence: ready.liveStartsAfterSequence,
      cols: ready.cols,
      rows: ready.rows
    });
    this.readyForMutations = true;
    this.scheduleMutationPump();
  }

  private beginCheckpoint(
    ready: RemoteTerminalAttachReady,
    transfer: RemoteTerminalCheckpointTransfer,
    purpose: TerminalCheckpointPurpose
  ): void {
    const sequence = parseUint64Decimal(transfer.metadata.lastMutationSequence);
    const totalBytes = boundedCheckpointLength(transfer.metadata.byteLength);
    const actualBytes = transfer.chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0
    );
    if (actualBytes !== totalBytes) {
      throw new Error("remote checkpoint chunks do not match their total");
    }
    if (ready.replayFromSequence < saturatingIncrement(sequence)) {
      throw new Error("remote checkpoint overlaps its replay suffix");
    }
    this.sentSequence = sequence;
    this.acknowledgedSequence = sequence;
    const checkpointId = makeId("checkpoint");
    this.checkpoint = {
      checkpointId,
      cursor: {
        chunks: transfer.chunks,
        chunkIndex: 0,
        chunkOffset: 0
      },
      sentOffset: 0,
      acknowledgedOffset: 0,
      totalBytes,
      digest: transfer.sha256,
      outstanding: [],
      outstandingHead: 0,
      endSent: false
    };
    this.post({
      ...this.envelope(),
      type: "checkpoint:begin",
      checkpointId,
      purpose,
      metadata: {
        format: "xterm-vt/1",
        session: this.options.session,
        sequence,
        cols: transfer.metadata.cols,
        rows: transfer.metadata.rows
      },
      totalBytes
    });
    this.drainCheckpoint();
  }

  private beginSyntheticCheckpoint(
    ready: RemoteTerminalAttachReady,
    purpose: TerminalCheckpointPurpose
  ): void {
    const sequence =
      ready.replayFromSequence === 0n
        ? uint64(0n)
        : uint64(ready.replayFromSequence - 1n);
    const checkpointId = makeId("checkpoint");
    this.sentSequence = sequence;
    this.acknowledgedSequence = sequence;
    this.post({
      ...this.envelope(),
      type: "checkpoint:begin",
      checkpointId,
      purpose,
      metadata: {
        format: "xterm-vt/1",
        session: this.options.session,
        sequence,
        cols: ready.cols,
        rows: ready.rows
      },
      totalBytes: 0
    });
    this.post({
      ...this.envelope(),
      type: "checkpoint:end",
      checkpointId,
      digest: createHash("sha256").digest("hex")
    });
    this.readyForMutations = true;
    this.scheduleMutationPump();
  }

  private drainCheckpoint(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint || this.closed) return;
    while (
      this.creditBytes > 0 &&
      checkpoint.sentOffset < checkpoint.totalBytes
    ) {
      const maxBytes = Math.min(
        this.creditBytes,
        TERMINAL_DATA_PLANE_MAX_CHECKPOINT_CHUNK_BYTES
      );
      const data = takeCheckpointBytes(checkpoint.cursor, maxBytes);
      if (!data || data.byteLength === 0) {
        throw new Error("remote checkpoint ended before its declared total");
      }
      const offset = checkpoint.sentOffset;
      checkpoint.sentOffset += data.byteLength;
      this.creditBytes -= data.byteLength;
      checkpoint.outstanding.push({
        endOffset: checkpoint.sentOffset,
        bytes: data.byteLength
      });
      const transferable = exactArrayBuffer(data);
      this.post({
        ...this.envelope(),
        type: "checkpoint:chunk",
        checkpointId: checkpoint.checkpointId,
        offset,
        data: transferable
      });
    }
    if (
      checkpoint.sentOffset === checkpoint.totalBytes &&
      !checkpoint.endSent
    ) {
      checkpoint.endSent = true;
      this.post({
        ...this.envelope(),
        type: "checkpoint:end",
        checkpointId: checkpoint.checkpointId,
        digest: checkpoint.digest
      });
      if (checkpoint.totalBytes === 0) {
        this.checkpoint = null;
        this.readyForMutations = true;
        this.scheduleMutationPump();
      }
    }
  }

  private acceptCheckpointCredit(
    message: Extract<
      TerminalDataPlaneClientMessage,
      { type: "checkpoint:credit" }
    >
  ): void {
    const checkpoint = this.checkpoint;
    if (
      !checkpoint ||
      checkpoint.checkpointId !== message.checkpointId ||
      message.acknowledgedOffset <= checkpoint.acknowledgedOffset ||
      message.acknowledgedOffset > checkpoint.sentOffset
    ) {
      this.sendError(
        "invalid-message",
        "checkpoint credit does not match the active transfer",
        true
      );
      return;
    }
    const acknowledged = findCheckpointAcknowledgement(
      checkpoint,
      message.acknowledgedOffset
    );
    if (!acknowledged || acknowledged.bytes !== message.bytes) {
      this.sendError(
        "invalid-message",
        "checkpoint credit bytes do not match sent chunks",
        true
      );
      return;
    }
    checkpoint.outstandingHead = acknowledged.end;
    checkpoint.acknowledgedOffset = message.acknowledgedOffset;
    this.replenishCredit(message.bytes);
    if (
      checkpoint.endSent &&
      checkpoint.acknowledgedOffset === checkpoint.totalBytes
    ) {
      this.checkpoint = null;
      this.readyForMutations = true;
      this.scheduleMutationPump();
      return;
    }
    this.drainCheckpoint();
  }

  private acceptOutputCredit(
    message: Extract<TerminalDataPlaneClientMessage, { type: "credit" }>
  ): void {
    if (
      message.acknowledgedSequence <= this.acknowledgedSequence ||
      message.acknowledgedSequence > this.sentSequence
    ) {
      this.sendError(
        "invalid-message",
        "credit must advance through output that was sent",
        true
      );
      return;
    }
    const acknowledged = this.findOutputAcknowledgement(
      message.acknowledgedSequence
    );
    if (!acknowledged || acknowledged.bytes !== message.bytes) {
      this.sendError(
        "invalid-message",
        "credit bytes do not match acknowledged output",
        true
      );
      return;
    }
    this.outstandingOutputHead = acknowledged.end;
    this.acknowledgedSequence = message.acknowledgedSequence;
    this.compactOutstandingOutput();
    this.replenishCredit(message.bytes);
    this.options.onCursorAdvanced?.(message.acknowledgedSequence);
    this.scheduleMutationPump();
  }

  private replenishCredit(bytes: number): void {
    this.creditBytes = Math.min(
      TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
      this.creditBytes + bytes
    );
  }

  private scheduleMutationPump(): void {
    if (this.mutationPumpRunning || !this.readyForMutations || this.closed) {
      return;
    }
    this.mutationPumpRunning = true;
    setImmediate(() => {
      void this.pumpMutations().catch((error: unknown) => this.fail(error));
    });
  }

  private async pumpMutations(): Promise<void> {
    let mutations = 0;
    let bytes = 0;
    try {
      while (
        !this.closed &&
        this.readyForMutations &&
        mutations < MAX_MUTATIONS_PER_TURN &&
        bytes < MAX_MUTATION_BYTES_PER_TURN
      ) {
        const attachment = this.attachment;
        if (!attachment) return;
        if (this.pendingMutation === undefined) {
          this.pendingMutation = await attachment.nextMutation();
        }
        const mutation = this.pendingMutation;
        if (mutation === null) {
          throw new Error("remote terminal attachment closed before exit");
        }
        const consumed = this.sendMutation(mutation);
        if (consumed === null) return;
        this.pendingMutation = undefined;
        mutations += 1;
        bytes += consumed;
      }
    } finally {
      this.mutationPumpRunning = false;
    }
    if (!this.closed && this.readyForMutations) {
      this.scheduleMutationPump();
    }
  }

  /** Returns null when output credit must advance before this mutation. */
  private sendMutation(mutation: RemoteTerminalMutation): number | null {
    const expected = incrementSequence(this.sentSequence);
    if (mutation.sequence !== expected) {
      throw new Error("remote terminal mutation is not contiguous");
    }
    switch (mutation.kind) {
      case "output": {
        if (!mutation.data || mutation.data.byteLength === 0) {
          throw new Error("remote output mutation is empty");
        }
        let data: string;
        try {
          data = new TextDecoder("utf-8", { fatal: true }).decode(
            mutation.data
          );
        } catch {
          throw new Error(
            "remote output mutation is not independently valid UTF-8"
          );
        }
        const byteLength = mutation.data.byteLength;
        if (
          data.length === 0 ||
          byteLength === 0 ||
          byteLength > TERMINAL_DATA_PLANE_MAX_DELTA_BYTES
        ) {
          throw new Error("remote output mutation exceeds the common delta");
        }
        if (
          this.outstandingOutput.length - this.outstandingOutputHead >=
          MAX_OUTSTANDING_OUTPUT_MUTATIONS
        ) {
          return null;
        }
        if (byteLength > this.creditBytes) return null;
        const fromSequence = this.sentSequence;
        this.post({
          ...this.envelope(),
          type: "delta",
          delta: {
            type: "output",
            fromSequence,
            sequence: mutation.sequence,
            byteLength,
            segments: [{ sequence: mutation.sequence, data, byteLength }]
          }
        });
        this.creditBytes -= byteLength;
        this.sentSequence = mutation.sequence;
        this.outstandingOutput.push({
          sequence: mutation.sequence,
          bytes: byteLength
        });
        this.flushResizeAcks();
        return byteLength;
      }
      case "resize": {
        if (mutation.cols === undefined || mutation.rows === undefined) {
          throw new Error("remote resize mutation has no dimensions");
        }
        this.post({
          ...this.envelope(),
          type: "delta",
          delta: {
            type: "resize",
            sequence: mutation.sequence,
            cols: mutation.cols,
            rows: mutation.rows
          }
        });
        this.sentSequence = mutation.sequence;
        this.flushResizeAcks();
        return 0;
      }
      case "exit":
        this.sentSequence = mutation.sequence;
        this.post({
          ...this.envelope(),
          type: "exit",
          sequence: mutation.sequence,
          ...(mutation.exitCode === undefined
            ? {}
            : { exitCode: mutation.exitCode })
        });
        void this.close(true);
        return 0;
    }
  }

  private queueInput(
    message: Extract<
      TerminalDataPlaneClientMessage,
      { type: "input:text" | "input:binary" | "input:key" }
    >
  ): void {
    const data = encodeInput(message);
    if (
      this.pendingInputBytes + data.byteLength >
      TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
    ) {
      this.sendError(
        "invalid-message",
        "pending remote terminal input exceeds 64 KiB",
        true
      );
      return;
    }
    this.pendingInputBytes += data.byteLength;
    const inputSequence = incrementUint64(this.inputSequence);
    this.inputSequence = inputSequence;
    this.enqueueWrite(async (attachment) => {
      await attachment.sendInput(inputSequence, data);
    }, data.byteLength);
  }

  private queueResize(
    message: Extract<TerminalDataPlaneClientMessage, { type: "resize" }>
  ): void {
    const expectsAcknowledgement = message.requestId !== undefined;
    if (
      expectsAcknowledgement &&
      this.pendingResizeAcknowledgements >= MAX_PENDING_RESIZE_ACKNOWLEDGEMENTS
    ) {
      this.sendError(
        "invalid-message",
        "pending remote terminal resize acknowledgements exceed their limit",
        true
      );
      return;
    }
    if (expectsAcknowledgement) this.pendingResizeAcknowledgements += 1;
    const accepted = this.enqueueWrite(async (attachment) => {
      let deferred = false;
      try {
        const acknowledgement = await attachment.resize(
          message.cols,
          message.rows
        );
        if (!message.requestId || this.closed) return;
        const sequence = parseUint64Decimal(acknowledgement.mutationSequence);
        this.resizeAcks.push({
          requestId: message.requestId,
          sequence,
          cols: acknowledgement.cols,
          rows: acknowledgement.rows
        });
        deferred = true;
        this.flushResizeAcks();
      } finally {
        if (expectsAcknowledgement && !deferred) {
          this.pendingResizeAcknowledgements -= 1;
        }
      }
    });
    if (!accepted && expectsAcknowledgement) {
      this.pendingResizeAcknowledgements -= 1;
    }
  }

  private enqueueWrite(
    task: (attachment: RemoteTerminalAttachmentLike) => Promise<void>,
    inputBytes = 0
  ): boolean {
    if (this.pendingWrites >= MAX_PENDING_WRITES) {
      if (inputBytes > 0) this.pendingInputBytes -= inputBytes;
      this.sendError(
        "invalid-message",
        "remote terminal write queue is full",
        true
      );
      return false;
    }
    this.pendingWrites += 1;
    const queued = this.writeTail.then(async () => {
      await this.initialization;
      const attachment = this.attachment;
      if (!attachment || this.closed) return;
      await task(attachment);
    });
    this.writeTail = queued.catch(() => undefined);
    void queued
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.pendingWrites -= 1;
        if (inputBytes > 0) this.pendingInputBytes -= inputBytes;
      });
    return true;
  }

  private flushResizeAcks(): void {
    for (let index = 0; index < this.resizeAcks.length; ) {
      const acknowledgement = this.resizeAcks[index];
      if (!acknowledgement || acknowledgement.sequence > this.sentSequence) {
        index += 1;
        continue;
      }
      this.resizeAcks.splice(index, 1);
      this.pendingResizeAcknowledgements -= 1;
      this.post({
        ...this.envelope(),
        type: "resize:ack",
        requestId: acknowledgement.requestId,
        sequence: acknowledgement.sequence,
        cols: acknowledgement.cols,
        rows: acknowledgement.rows
      });
    }
  }

  private findOutputAcknowledgement(
    sequence: Uint64
  ): { end: number; bytes: number } | null {
    let bytes = 0;
    for (
      let index = this.outstandingOutputHead;
      index < this.outstandingOutput.length;
      index += 1
    ) {
      const entry = this.outstandingOutput[index];
      if (!entry || entry.sequence > sequence) return null;
      bytes += entry.bytes;
      if (entry.sequence === sequence) return { end: index + 1, bytes };
    }
    return null;
  }

  private compactOutstandingOutput(): void {
    if (this.outstandingOutputHead === this.outstandingOutput.length) {
      this.outstandingOutput.length = 0;
      this.outstandingOutputHead = 0;
    } else if (
      this.outstandingOutputHead >= 1_024 &&
      this.outstandingOutputHead * 2 >= this.outstandingOutput.length
    ) {
      this.outstandingOutput.splice(0, this.outstandingOutputHead);
      this.outstandingOutputHead = 0;
    }
  }

  private sendError(
    code: TerminalDataPlaneErrorCode,
    message: string,
    recoverable: boolean
  ): void {
    this.post({
      ...this.envelope(),
      type: "error",
      code,
      message,
      recoverable
    });
    if (!recoverable) void this.close(true);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    try {
      this.options.onRuntimeLost?.(error);
    } catch {
      // Transport cleanup must not be blocked by a lifecycle observer.
    }
    const message = error instanceof Error ? error.message : String(error);
    this.post({
      ...this.envelope(),
      type: "error",
      code: "runtime-lost",
      message,
      recoverable: true
    });
    void this.close(true);
  }

  private post(message: TerminalDataPlaneHostMessage): boolean {
    if (this.closed) return false;
    try {
      // Electron MessagePortMain transfers port capabilities only. Checkpoint
      // ArrayBuffers are bounded and structured-cloned into the renderer.
      this.options.port.postMessage(message);
      return true;
    } catch {
      void this.close(false);
      return false;
    }
  }

  private envelope() {
    return {
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      attachId: this.options.attachId,
      session: this.options.session
    } as const;
  }

  private async close(closePort: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.readyForMutations = false;
    this.resizeAcks.length = 0;
    this.pendingResizeAcknowledgements = 0;
    this.options.port.off?.("message", this.onMessage);
    this.options.port.off?.("close", this.onPortClosed);
    this.options.port.off?.("messageerror", this.onPortClosed);
    const attachment = this.attachment;
    this.attachment = null;
    if (closePort) {
      try {
        this.options.port.close();
      } catch {
        // The renderer may already have closed the transferred capability.
      }
    }
    await attachment?.detach().catch(() => undefined);
    if (!this.closedNotified) {
      this.closedNotified = true;
      this.options.onClosed?.();
    }
  }
}

function checkpointPurpose(
  resumeFromSequence: Uint64 | undefined,
  ready: RemoteTerminalAttachReady
): TerminalCheckpointPurpose {
  if (resumeFromSequence === undefined) return { kind: "attach" };
  const missingFromSequence = saturatingIncrement(resumeFromSequence);
  if (missingFromSequence >= ready.earliestAvailableSequence) {
    throw new Error("remote checkpoint was unnecessary for a retained cursor");
  }
  return {
    kind: "resync",
    missingFromSequence,
    retainedFromSequence: ready.earliestAvailableSequence
  };
}

function boundedCheckpointLength(value: string): number {
  const parsed = parseUint64Decimal(value);
  const length = Number(parsed);
  if (
    !Number.isSafeInteger(length) ||
    length > TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES
  ) {
    throw new RangeError("remote checkpoint length exceeds the common limit");
  }
  return length;
}

function takeCheckpointBytes(
  cursor: CheckpointChunkCursor,
  maxBytes: number
): Uint8Array | null {
  while (cursor.chunkIndex < cursor.chunks.length) {
    const chunk = cursor.chunks[cursor.chunkIndex];
    if (!chunk) return null;
    if (cursor.chunkOffset >= chunk.byteLength) {
      cursor.chunkIndex += 1;
      cursor.chunkOffset = 0;
      continue;
    }
    const end = Math.min(chunk.byteLength, cursor.chunkOffset + maxBytes);
    const result = chunk.slice(cursor.chunkOffset, end);
    cursor.chunkOffset = end;
    return result;
  }
  return null;
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}

function findCheckpointAcknowledgement(
  checkpoint: CheckpointSendState,
  acknowledgedOffset: number
): { end: number; bytes: number } | null {
  let bytes = 0;
  for (
    let index = checkpoint.outstandingHead;
    index < checkpoint.outstanding.length;
    index += 1
  ) {
    const entry = checkpoint.outstanding[index];
    if (!entry || entry.endOffset > acknowledgedOffset) return null;
    bytes += entry.bytes;
    if (entry.endOffset === acknowledgedOffset) {
      return { end: index + 1, bytes };
    }
  }
  return null;
}

function encodeInput(
  message: Extract<
    TerminalDataPlaneClientMessage,
    { type: "input:text" | "input:binary" | "input:key" }
  >
): Uint8Array {
  if (message.type === "input:text") {
    return new TextEncoder().encode(message.text);
  }
  if (message.type === "input:binary") {
    return Uint8Array.from(message.data, (character) =>
      character.charCodeAt(0)
    );
  }
  return new TextEncoder().encode(encodeTerminalKeyInput(message.input));
}

function incrementSequence(sequence: Uint64): Uint64 {
  if (sequence === UINT64_MAX) {
    throw new RangeError("terminal mutation sequence is exhausted");
  }
  return uint64(sequence + 1n);
}

function saturatingIncrement(sequence: Uint64): Uint64 {
  return sequence === UINT64_MAX ? sequence : uint64(sequence + 1n);
}

function messageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}
