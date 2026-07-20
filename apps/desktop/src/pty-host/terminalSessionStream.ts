import { createHash } from "node:crypto";

import type {
  TerminalCheckpoint,
  TerminalCheckpointMetadata,
  TerminalCheckpointPurpose,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneHostMessage,
  TerminalDelta,
  TerminalKeyInput,
  TerminalSessionRef,
  Uint64
} from "@kmux/proto";
import {
  incrementUint64,
  makeId,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_DATA_PLANE_MAX_DELTA_BYTES,
  TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64,
  validateTerminalDataPlaneClientMessage
} from "@kmux/proto";

import type { TerminalDeltaStore } from "./terminalDeltaStore";
import { isTerminalCheckpointTooLargeError } from "./snapshotCache";
import {
  coalesceTerminalDeltasForWire,
  TERMINAL_WIRE_OUTPUT_MAX_BYTES
} from "./terminalWireCoalescing";

export interface TerminalDataPortLike {
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
  on(event: "close" | "messageerror", listener: () => void): unknown;
  off?(event: "message", listener: (event: unknown) => void): unknown;
  off?(event: "close" | "messageerror", listener: () => void): unknown;
}

export interface TerminalSessionStreamOptions {
  session: TerminalSessionRef;
  deltaStore: TerminalDeltaStore<TerminalDelta>;
  createCheckpoint: () => Promise<TerminalCheckpoint>;
  getDimensions: () => { cols: number; rows: number };
  writeText: (text: string) => void;
  writeBinary: (data: string) => void;
  writeKey: (input: TerminalKeyInput) => void;
  resize: (
    request: Extract<TerminalDataPlaneClientMessage, { type: "resize" }>
  ) => Promise<{ sequence: Uint64; cols: number; rows: number }>;
  onInputObserved?: (
    message: Extract<
      TerminalDataPlaneClientMessage,
      { type: "input:text" | "input:binary" | "input:key" }
    >
  ) => void;
  onClosed?: () => void;
  telemetryNow?: () => number;
}

export interface TerminalSessionStreamStats {
  maxCreditBytes: number;
  maxOutstandingOutputEvents: number;
  maxOutstandingOutputBytes: number;
  attachments: number;
  startedAttachments: number;
  resyncingAttachments: number;
  creditBytes: number;
  maxAttachmentCreditBytes: number;
  peakAttachmentCreditBytes: number;
  outstandingOutputEvents: number;
  maxAttachmentOutstandingOutputEvents: number;
  peakAttachmentOutstandingOutputEvents: number;
  outstandingOutputBytes: number;
  maxAttachmentOutstandingOutputBytes: number;
  peakAttachmentOutstandingOutputBytes: number;
  creditBoundViolationCount: number;
}

interface OutstandingOutputEntry {
  sequence: Uint64;
  bytes: number;
}

interface CheckpointSendState {
  checkpointId: string;
  data: string;
  charOffset: number;
  pendingEncodedBytes: Uint8Array | null;
  pendingEncodedOffset: number;
  sentOffset: number;
  acknowledgedOffset: number;
  totalBytes: number;
  digest: string;
  outstanding: Array<{ endOffset: number; bytes: number }>;
  outstandingHead: number;
  endSent: boolean;
  purpose: TerminalCheckpointPurpose;
  metadata: TerminalCheckpointMetadata;
}

interface Attachment {
  attachId: string;
  port: TerminalDataPortLike;
  started: boolean;
  ready: boolean;
  closed: boolean;
  sentSequence: Uint64;
  acknowledgedSequence: Uint64;
  creditBytes: number;
  outstandingOutput: OutstandingOutputEntry[];
  outstandingOutputHead: number;
  outstandingOutputBytes: number;
  drainBlockedUntilCredit: boolean;
  resyncing: boolean;
  checkpoint: CheckpointSendState | null;
  onMessage: (event: unknown) => void;
  onClose: () => void;
}

const MAX_OUTSTANDING_OUTPUT_EVENTS = 2_048;
export const TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES = 64 * 1024;

/** Owns the direct renderer attachments for one authoritative PTY session. */
export class TerminalSessionStream {
  private readonly attachments = new Map<string, Attachment>();
  private peakAttachmentCreditBytes = 0;
  private peakAttachmentOutstandingOutputEvents = 0;
  private peakAttachmentOutstandingOutputBytes = 0;
  private creditBoundViolationCount = 0;
  private exited = false;
  private exitSequence: Uint64 | null = null;
  private disposed = false;
  private exitCode: number | undefined;
  private closedNotified = false;
  private readonly maxOutstandingOutputEvents: number;
  private readonly maxReplayEvents: number;
  private telemetryNow: (() => number) | undefined;

  constructor(private readonly options: TerminalSessionStreamOptions) {
    this.telemetryNow = options.telemetryNow;
    // The per-attachment ledger is only an acknowledgement cursor over the
    // shared delta ring. Keep it no larger than the ring itself even if a
    // caller configures a larger ring for diagnostics or tests.
    const maxSessionEvents = options.deltaStore.stats().maxSessionEvents;
    this.maxOutstandingOutputEvents = Math.min(
      MAX_OUTSTANDING_OUTPUT_EVENTS,
      maxSessionEvents
    );
    this.maxReplayEvents = maxSessionEvents;
  }

  get attachmentCount(): number {
    return this.attachments.size;
  }

  configureTelemetryNow(telemetryNow: (() => number) | undefined): void {
    this.telemetryNow = telemetryNow;
  }

  stats(): TerminalSessionStreamStats {
    let startedAttachments = 0;
    let resyncingAttachments = 0;
    let creditBytes = 0;
    let maxAttachmentCreditBytes = 0;
    let outstandingOutputEvents = 0;
    let maxAttachmentOutstandingOutputEvents = 0;
    let outstandingOutputBytes = 0;
    let maxAttachmentOutstandingOutputBytes = 0;
    for (const attachment of this.attachments.values()) {
      if (attachment.started) {
        startedAttachments += 1;
      }
      if (attachment.resyncing) {
        resyncingAttachments += 1;
      }
      creditBytes += attachment.creditBytes;
      maxAttachmentCreditBytes = Math.max(
        maxAttachmentCreditBytes,
        attachment.creditBytes
      );
      const attachmentOutstandingEvents =
        this.outstandingOutputCount(attachment);
      outstandingOutputEvents += attachmentOutstandingEvents;
      maxAttachmentOutstandingOutputEvents = Math.max(
        maxAttachmentOutstandingOutputEvents,
        attachmentOutstandingEvents
      );
      outstandingOutputBytes += attachment.outstandingOutputBytes;
      maxAttachmentOutstandingOutputBytes = Math.max(
        maxAttachmentOutstandingOutputBytes,
        attachment.outstandingOutputBytes
      );
    }
    return {
      maxCreditBytes: TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
      maxOutstandingOutputEvents: this.maxOutstandingOutputEvents,
      maxOutstandingOutputBytes:
        TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES,
      attachments: this.attachments.size,
      startedAttachments,
      resyncingAttachments,
      creditBytes,
      maxAttachmentCreditBytes,
      peakAttachmentCreditBytes: this.peakAttachmentCreditBytes,
      outstandingOutputEvents,
      maxAttachmentOutstandingOutputEvents,
      peakAttachmentOutstandingOutputEvents:
        this.peakAttachmentOutstandingOutputEvents,
      outstandingOutputBytes,
      maxAttachmentOutstandingOutputBytes,
      peakAttachmentOutstandingOutputBytes:
        this.peakAttachmentOutstandingOutputBytes,
      creditBoundViolationCount: this.creditBoundViolationCount
    };
  }

  bind(attachId: string, port: TerminalDataPortLike): void {
    if (this.disposed) {
      port.close();
      return;
    }
    this.detach(attachId);
    const attachment: Attachment = {
      attachId,
      port,
      started: false,
      ready: false,
      closed: false,
      sentSequence: uint64(0n),
      acknowledgedSequence: uint64(0n),
      creditBytes: 0,
      outstandingOutput: [],
      outstandingOutputHead: 0,
      outstandingOutputBytes: 0,
      drainBlockedUntilCredit: false,
      resyncing: false,
      checkpoint: null,
      onMessage: () => {},
      onClose: () => {}
    };
    attachment.onMessage = (event) => {
      void this.handleMessage(attachment, messageData(event)).catch((error) => {
        if (this.isCurrent(attachment)) {
          this.handleStreamFailure(attachment, error);
        }
      });
    };
    attachment.onClose = () => this.removeAttachment(attachment, false);
    this.attachments.set(attachId, attachment);
    port.on("message", attachment.onMessage);
    port.on("close", attachment.onClose);
    port.on("messageerror", attachment.onClose);
    port.start?.();
  }

  publish(delta: TerminalDelta): void {
    if (this.exited || this.disposed) {
      return;
    }
    if (
      delta.type === "output" &&
      delta.byteLength > TERMINAL_DATA_PLANE_MAX_DELTA_BYTES
    ) {
      throw new RangeError(
        `terminal output delta exceeds ${TERMINAL_DATA_PLANE_MAX_DELTA_BYTES} bytes`
      );
    }
    this.options.deltaStore.append(this.options.session.sessionId, delta);
    for (const attachment of this.attachments.values()) {
      this.drain(attachment);
    }
  }

  exit(exitCode?: number): void {
    if (this.exited || this.disposed) {
      return;
    }
    this.exited = true;
    this.exitSequence = incrementUint64(
      this.options.deltaStore.latestSequence(this.options.session.sessionId)
    );
    this.exitCode = exitCode;
    for (const attachment of [...this.attachments.values()]) {
      this.drain(attachment);
    }
    this.notifyClosedIfSettled();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const attachment of [...this.attachments.values()]) {
      this.removeAttachment(attachment, true);
    }
    this.notifyClosedIfSettled();
  }

  private async handleMessage(
    attachment: Attachment,
    rawMessage: unknown
  ): Promise<void> {
    if (!this.isCurrent(attachment)) {
      return;
    }
    const validation = validateTerminalDataPlaneClientMessage(rawMessage, {
      attachId: attachment.attachId,
      session: this.options.session
    });
    if (!validation.ok) {
      this.sendError(attachment, "invalid-message", validation.error, true);
      return;
    }
    const message = validation.value;
    if (message.type === "attach") {
      if (attachment.started) {
        this.sendError(
          attachment,
          "stale-attach",
          "terminal attachment was already started",
          false
        );
        return;
      }
      attachment.started = true;
      attachment.creditBytes = message.creditBytes;
      this.recordAttachmentBounds(attachment);
      await this.startAttachment(attachment, message.resumeFromSequence);
      return;
    }
    if (!attachment.started) {
      this.sendError(
        attachment,
        "stale-attach",
        "attach must be the first terminal data-plane message",
        false
      );
      return;
    }

    switch (message.type) {
      case "credit": {
        if (
          message.acknowledgedSequence <= attachment.acknowledgedSequence ||
          message.acknowledgedSequence > attachment.sentSequence
        ) {
          this.sendError(
            attachment,
            "invalid-message",
            "credit must advance through output that was sent",
            true
          );
          return;
        }
        const acknowledged = this.findAcknowledgedOutput(
          attachment,
          message.acknowledgedSequence
        );
        if (!acknowledged || acknowledged.bytes !== message.bytes) {
          this.sendError(
            attachment,
            "invalid-message",
            "credit bytes do not match acknowledged output",
            true
          );
          return;
        }
        this.consumeAcknowledgedOutput(attachment, acknowledged);
        attachment.acknowledgedSequence = message.acknowledgedSequence;
        const replenishedCredit = attachment.creditBytes + message.bytes;
        if (replenishedCredit > TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES) {
          this.creditBoundViolationCount += 1;
        }
        attachment.creditBytes = Math.min(
          TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
          replenishedCredit
        );
        attachment.drainBlockedUntilCredit = false;
        this.recordAttachmentBounds(attachment);
        this.drain(attachment);
        return;
      }
      case "checkpoint:credit":
        this.acceptCheckpointCredit(attachment, message);
        return;
      case "input:text":
        this.options.writeText(message.text);
        this.options.onInputObserved?.(message);
        return;
      case "input:binary":
        this.options.writeBinary(message.data);
        this.options.onInputObserved?.(message);
        return;
      case "input:key":
        this.options.writeKey(message.input);
        this.options.onInputObserved?.(message);
        return;
      case "resize": {
        const result = await this.options.resize(message);
        if (
          message.requestId &&
          this.isCurrent(attachment) &&
          attachment.started
        ) {
          this.post(attachment, {
            ...this.envelope(attachment.attachId),
            type: "resize:ack",
            requestId: message.requestId,
            sequence: result.sequence,
            cols: result.cols,
            rows: result.rows
          });
        }
        return;
      }
      case "detach":
        this.removeAttachment(attachment, true);
        return;
      default:
        return;
    }
  }

  private async startAttachment(
    attachment: Attachment,
    resumeFromSequence: Uint64 | undefined
  ): Promise<void> {
    if (!this.isCurrent(attachment)) {
      return;
    }
    if (resumeFromSequence !== undefined) {
      const replay = this.options.deltaStore.replayAfter(
        this.options.session.sessionId,
        resumeFromSequence
      );
      if (replay.status === "ok") {
        const dimensions = this.options.getDimensions();
        attachment.sentSequence = resumeFromSequence;
        attachment.acknowledgedSequence = resumeFromSequence;
        this.clearOutstandingOutput(attachment);
        this.post(attachment, {
          ...this.envelope(attachment.attachId),
          type: "attached",
          mode: "resume",
          resumedFromSequence: resumeFromSequence,
          sequence: replay.latestSequence,
          cols: dimensions.cols,
          rows: dimensions.rows
        });
        attachment.ready = true;
        this.drain(attachment);
        return;
      }
      attachment.sentSequence = resumeFromSequence;
      attachment.acknowledgedSequence = resumeFromSequence;
      this.clearOutstandingOutput(attachment);
      await this.resync(attachment, replay.retainedFromSequence);
      return;
    }

    const checkpoint = await this.options.createCheckpoint();
    if (!this.isCurrent(attachment)) {
      return;
    }
    this.beginCheckpoint(attachment, checkpoint, { kind: "attach" });
  }

  private drain(attachment: Attachment): void {
    if (
      !this.isCurrent(attachment) ||
      !attachment.started ||
      !attachment.ready ||
      attachment.resyncing ||
      attachment.checkpoint !== null ||
      attachment.drainBlockedUntilCredit
    ) {
      return;
    }
    if (
      this.outstandingOutputCount(attachment) >= this.maxOutstandingOutputEvents
    ) {
      attachment.drainBlockedUntilCredit = true;
      return;
    }
    if (
      attachment.outstandingOutputBytes >=
      TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES
    ) {
      attachment.drainBlockedUntilCredit = true;
      return;
    }
    const outstandingOutputByteLimit =
      TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES;
    while (this.isCurrent(attachment)) {
      const replayByteBudget = Math.min(
        attachment.creditBytes,
        Math.max(
          0,
          outstandingOutputByteLimit - attachment.outstandingOutputBytes
        )
      );
      const replay = this.options.deltaStore.replayAfter(
        this.options.session.sessionId,
        attachment.sentSequence,
        {
          maxBytes: replayByteBudget,
          maxEvents: this.maxReplayEvents
        }
      );
      if (replay.status === "gap") {
        // Do not supersede output the renderer is already parsing. Its exact
        // credit acknowledgement must arrive before a checkpoint can replace
        // the remaining ring cursor without creating stale-credit ambiguity.
        if (this.outstandingOutputCount(attachment) > 0) {
          attachment.drainBlockedUntilCredit = true;
          return;
        }
        void this.resync(attachment, replay.retainedFromSequence).catch(
          (error) => {
            if (this.isCurrent(attachment)) {
              this.handleStreamFailure(attachment, error);
            }
          }
        );
        return;
      }

      const wireCoalescingBytes = Math.min(
        TERMINAL_WIRE_OUTPUT_MAX_BYTES,
        Math.max(1, replayByteBudget)
      );
      let advanced = false;
      for (const delta of coalesceTerminalDeltasForWire(
        replay.deltas,
        wireCoalescingBytes
      )) {
        const bytes = delta.type === "output" ? delta.byteLength : 0;
        if (bytes > attachment.creditBytes) {
          attachment.drainBlockedUntilCredit = true;
          return;
        }
        if (
          bytes > 0 &&
          attachment.outstandingOutputBytes > 0 &&
          attachment.outstandingOutputBytes + bytes > outstandingOutputByteLimit
        ) {
          attachment.drainBlockedUntilCredit = true;
          return;
        }
        if (
          bytes > 0 &&
          this.outstandingOutputCount(attachment) >=
            this.maxOutstandingOutputEvents
        ) {
          attachment.drainBlockedUntilCredit = true;
          return;
        }
        if (
          !this.post(attachment, {
            ...this.envelope(attachment.attachId),
            type: "delta",
            delta
          })
        ) {
          return;
        }
        attachment.creditBytes -= bytes;
        attachment.sentSequence = delta.sequence;
        advanced = true;
        if (bytes > 0) {
          attachment.outstandingOutput.push({
            sequence: delta.sequence,
            bytes
          });
          attachment.outstandingOutputBytes += bytes;
        }
        this.recordAttachmentBounds(attachment);
      }

      if (attachment.sentSequence === replay.latestSequence) {
        this.sendExitIfCaughtUp(attachment);
        return;
      }
      if (!advanced) {
        // A non-empty exact suffix always advances or trips one of the credit
        // guards above. Keep this defensive fence against an accidental
        // zero-sized replay window becoming a hot loop.
        attachment.drainBlockedUntilCredit = true;
        return;
      }
    }
  }

  private sendExitIfCaughtUp(attachment: Attachment): void {
    if (!this.exited || !this.isCurrent(attachment)) {
      return;
    }
    const latestDeltaSequence = this.options.deltaStore.latestSequence(
      this.options.session.sessionId
    );
    if (attachment.sentSequence !== latestDeltaSequence || !this.exitSequence) {
      return;
    }
    this.post(attachment, {
      ...this.envelope(attachment.attachId),
      type: "exit",
      sequence: this.exitSequence,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode })
    });
    this.removeAttachment(attachment, true);
  }

  private recordAttachmentBounds(attachment: Attachment): void {
    const outstandingOutputEvents = this.outstandingOutputCount(attachment);
    this.peakAttachmentCreditBytes = Math.max(
      this.peakAttachmentCreditBytes,
      attachment.creditBytes
    );
    this.peakAttachmentOutstandingOutputEvents = Math.max(
      this.peakAttachmentOutstandingOutputEvents,
      outstandingOutputEvents
    );
    this.peakAttachmentOutstandingOutputBytes = Math.max(
      this.peakAttachmentOutstandingOutputBytes,
      attachment.outstandingOutputBytes
    );
    if (
      attachment.creditBytes > TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES ||
      attachment.outstandingOutputBytes >
        TERMINAL_SESSION_STREAM_MAX_OUTSTANDING_OUTPUT_BYTES ||
      outstandingOutputEvents > this.maxOutstandingOutputEvents
    ) {
      this.creditBoundViolationCount += 1;
    }
  }

  private async resync(
    attachment: Attachment,
    retainedFromSequence: Uint64
  ): Promise<void> {
    attachment.resyncing = true;
    const missingFromSequence = uint64(attachment.sentSequence + 1n);
    try {
      const checkpoint = await this.options.createCheckpoint();
      if (!this.isCurrent(attachment)) {
        return;
      }
      attachment.sentSequence = checkpoint.sequence;
      attachment.acknowledgedSequence = checkpoint.sequence;
      this.clearOutstandingOutput(attachment);
      this.beginCheckpoint(attachment, checkpoint, {
        kind: "resync",
        missingFromSequence,
        retainedFromSequence
      });
    } catch (error) {
      attachment.resyncing = false;
      throw error;
    }
  }

  private beginCheckpoint(
    attachment: Attachment,
    checkpoint: TerminalCheckpoint,
    purpose: TerminalCheckpointPurpose
  ): void {
    const totalBytes = Buffer.byteLength(checkpoint.data, "utf8");
    if (totalBytes > TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES) {
      throw new RangeError(
        `terminal checkpoint exceeds ${TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES} bytes`
      );
    }
    const { data, ...metadata } = checkpoint;
    const checkpointId = makeId("checkpoint");
    attachment.sentSequence = checkpoint.sequence;
    attachment.acknowledgedSequence = checkpoint.sequence;
    attachment.ready = false;
    attachment.resyncing = purpose.kind === "resync";
    attachment.drainBlockedUntilCredit = false;
    this.clearOutstandingOutput(attachment);
    attachment.checkpoint = {
      checkpointId,
      data,
      charOffset: 0,
      pendingEncodedBytes: null,
      pendingEncodedOffset: 0,
      sentOffset: 0,
      acknowledgedOffset: 0,
      totalBytes,
      digest: createHash("sha256").update(data, "utf8").digest("hex"),
      outstanding: [],
      outstandingHead: 0,
      endSent: false,
      purpose,
      metadata
    };
    if (
      !this.post(attachment, {
        ...this.envelope(attachment.attachId),
        type: "checkpoint:begin",
        checkpointId,
        purpose,
        metadata,
        totalBytes
      })
    ) {
      return;
    }
    this.drainCheckpoint(attachment);
  }

  private drainCheckpoint(attachment: Attachment): void {
    const checkpoint = attachment.checkpoint;
    if (!checkpoint || !this.isCurrent(attachment) || checkpoint.endSent) {
      return;
    }
    while (
      attachment.creditBytes > 0 &&
      checkpoint.sentOffset < checkpoint.totalBytes
    ) {
      const maxBytes = Math.min(
        attachment.creditBytes,
        TERMINAL_DATA_PLANE_MAX_CHECKPOINT_CHUNK_BYTES
      );
      const encoded = encodeCheckpointChunk(checkpoint, maxBytes);
      if (!encoded) {
        attachment.drainBlockedUntilCredit = true;
        return;
      }
      const offset = checkpoint.sentOffset;
      checkpoint.sentOffset += encoded.byteLength;
      attachment.creditBytes -= encoded.byteLength;
      checkpoint.outstanding.push({
        endOffset: checkpoint.sentOffset,
        bytes: encoded.byteLength
      });
      if (
        !this.post(attachment, {
          ...this.envelope(attachment.attachId),
          type: "checkpoint:chunk",
          checkpointId: checkpoint.checkpointId,
          offset,
          data: encoded
        })
      ) {
        return;
      }
      this.recordAttachmentBounds(attachment);
    }
    if (checkpoint.sentOffset !== checkpoint.totalBytes) {
      attachment.drainBlockedUntilCredit = true;
      return;
    }
    checkpoint.endSent = true;
    if (
      !this.post(attachment, {
        ...this.envelope(attachment.attachId),
        type: "checkpoint:end",
        checkpointId: checkpoint.checkpointId,
        digest: checkpoint.digest
      })
    ) {
      return;
    }
    attachment.ready = true;
    attachment.resyncing = false;
    if (checkpoint.totalBytes === 0) {
      attachment.checkpoint = null;
      this.drain(attachment);
    }
  }

  private acceptCheckpointCredit(
    attachment: Attachment,
    message: Extract<
      TerminalDataPlaneClientMessage,
      { type: "checkpoint:credit" }
    >
  ): void {
    const checkpoint = attachment.checkpoint;
    if (
      !checkpoint ||
      checkpoint.checkpointId !== message.checkpointId ||
      message.acknowledgedOffset <= checkpoint.acknowledgedOffset ||
      message.acknowledgedOffset > checkpoint.sentOffset
    ) {
      this.sendError(
        attachment,
        "invalid-message",
        "checkpoint credit does not match the active transfer",
        true
      );
      return;
    }
    let bytes = 0;
    let end = checkpoint.outstandingHead;
    for (; end < checkpoint.outstanding.length; end += 1) {
      const entry = checkpoint.outstanding[end];
      if (!entry || entry.endOffset > message.acknowledgedOffset) {
        break;
      }
      bytes += entry.bytes;
      if (entry.endOffset === message.acknowledgedOffset) {
        end += 1;
        break;
      }
    }
    if (
      end === checkpoint.outstandingHead ||
      checkpoint.outstanding[end - 1]?.endOffset !==
        message.acknowledgedOffset ||
      bytes !== message.bytes
    ) {
      this.sendError(
        attachment,
        "invalid-message",
        "checkpoint credit bytes do not match sent chunks",
        true
      );
      return;
    }
    checkpoint.outstandingHead = end;
    checkpoint.acknowledgedOffset = message.acknowledgedOffset;
    const replenishedCredit = attachment.creditBytes + message.bytes;
    if (replenishedCredit > TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES) {
      this.creditBoundViolationCount += 1;
    }
    attachment.creditBytes = Math.min(
      TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES,
      replenishedCredit
    );
    attachment.drainBlockedUntilCredit = false;
    if (
      checkpoint.endSent &&
      checkpoint.acknowledgedOffset === checkpoint.totalBytes
    ) {
      attachment.checkpoint = null;
      this.drain(attachment);
      return;
    }
    this.drainCheckpoint(attachment);
  }

  private sendError(
    attachment: Attachment,
    code: Extract<TerminalDataPlaneHostMessage, { type: "error" }>["code"],
    message: string,
    recoverable: boolean
  ): void {
    this.post(attachment, {
      ...this.envelope(attachment.attachId),
      type: "error",
      code,
      message,
      recoverable
    });
  }

  private handleStreamFailure(attachment: Attachment, error: unknown): void {
    const terminalCheckpointTooLarge = isTerminalCheckpointTooLargeError(error);
    this.sendError(
      attachment,
      terminalCheckpointTooLarge ? "checkpoint-too-large" : "internal",
      error instanceof Error ? error.message : String(error),
      !terminalCheckpointTooLarge
    );
    if (terminalCheckpointTooLarge && this.isCurrent(attachment)) {
      this.removeAttachment(attachment, true);
    }
  }

  private outstandingOutputCount(attachment: Attachment): number {
    return (
      attachment.outstandingOutput.length - attachment.outstandingOutputHead
    );
  }

  private findAcknowledgedOutput(
    attachment: Attachment,
    acknowledgedSequence: Uint64
  ): { end: number; bytes: number } | null {
    let bytes = 0;
    for (
      let index = attachment.outstandingOutputHead;
      index < attachment.outstandingOutput.length;
      index += 1
    ) {
      const output = attachment.outstandingOutput[index];
      if (!output || output.sequence > acknowledgedSequence) {
        return null;
      }
      bytes += output.bytes;
      if (output.sequence === acknowledgedSequence) {
        return { end: index + 1, bytes };
      }
    }
    return null;
  }

  private consumeAcknowledgedOutput(
    attachment: Attachment,
    acknowledged: { end: number; bytes: number }
  ): void {
    attachment.outstandingOutputHead = acknowledged.end;
    attachment.outstandingOutputBytes -= acknowledged.bytes;
    this.compactOutstandingOutput(attachment);
  }

  private compactOutstandingOutput(attachment: Attachment): void {
    if (
      attachment.outstandingOutputHead === attachment.outstandingOutput.length
    ) {
      this.clearOutstandingOutput(attachment);
      return;
    }
    if (
      attachment.outstandingOutputHead >= 1_024 &&
      attachment.outstandingOutputHead * 2 >=
        attachment.outstandingOutput.length
    ) {
      attachment.outstandingOutput.splice(0, attachment.outstandingOutputHead);
      attachment.outstandingOutputHead = 0;
    }
  }

  private clearOutstandingOutput(attachment: Attachment): void {
    attachment.outstandingOutput.length = 0;
    attachment.outstandingOutputHead = 0;
    attachment.outstandingOutputBytes = 0;
  }

  private post(
    attachment: Attachment,
    message: TerminalDataPlaneHostMessage
  ): boolean {
    if (!this.isCurrent(attachment)) {
      return false;
    }
    try {
      const outboundMessage: TerminalDataPlaneHostMessage =
        message.type === "delta" && this.telemetryNow
          ? {
              ...message,
              telemetry: { portSentAt: this.telemetryNow() }
            }
          : message;
      // Electron MessagePortMain only accepts MessagePortMain capabilities in
      // its transfer list. Bounded ArrayBuffer payloads use structured clone.
      attachment.port.postMessage(outboundMessage);
      return true;
    } catch {
      this.removeAttachment(attachment, true);
      return false;
    }
  }

  private envelope(attachId: string) {
    return {
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      attachId,
      session: this.options.session
    } as const;
  }

  private detach(attachId: string): void {
    const existing = this.attachments.get(attachId);
    if (existing) {
      this.removeAttachment(existing, true);
    }
  }

  private removeAttachment(attachment: Attachment, closePort: boolean): void {
    if (attachment.closed) {
      return;
    }
    attachment.closed = true;
    if (this.attachments.get(attachment.attachId) === attachment) {
      this.attachments.delete(attachment.attachId);
    }
    attachment.port.off?.("message", attachment.onMessage);
    attachment.port.off?.("close", attachment.onClose);
    attachment.port.off?.("messageerror", attachment.onClose);
    if (closePort) {
      try {
        attachment.port.close();
      } catch {
        // The remote side may already have closed the transferred port.
      }
    }
    this.notifyClosedIfSettled();
  }

  private notifyClosedIfSettled(): void {
    if (!this.exited || this.closedNotified || this.attachments.size > 0) {
      return;
    }
    this.closedNotified = true;
    this.options.onClosed?.();
  }

  private isCurrent(attachment: Attachment): boolean {
    return (
      !attachment.closed &&
      this.attachments.get(attachment.attachId) === attachment
    );
  }
}

function messageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function encodeCheckpointChunk(
  checkpoint: CheckpointSendState,
  maxBytes: number
): ArrayBuffer | null {
  const pending = checkpoint.pendingEncodedBytes;
  if (pending) {
    const end = Math.min(
      pending.byteLength,
      checkpoint.pendingEncodedOffset + maxBytes
    );
    const chunk = pending.slice(checkpoint.pendingEncodedOffset, end);
    checkpoint.pendingEncodedOffset = end;
    if (end === pending.byteLength) {
      checkpoint.pendingEncodedBytes = null;
      checkpoint.pendingEncodedOffset = 0;
    }
    return chunk.buffer;
  }

  const { data } = checkpoint;
  const charOffset = checkpoint.charOffset;
  let nextCharOffset = charOffset;
  let byteLength = 0;
  while (nextCharOffset < data.length) {
    const first = data.charCodeAt(nextCharOffset);
    const codeUnits =
      first >= 0xd800 &&
      first <= 0xdbff &&
      nextCharOffset + 1 < data.length &&
      data.charCodeAt(nextCharOffset + 1) >= 0xdc00 &&
      data.charCodeAt(nextCharOffset + 1) <= 0xdfff
        ? 2
        : 1;
    const characterBytes =
      first < 0x80 ? 1 : first < 0x800 ? 2 : codeUnits === 2 ? 4 : 3;
    if (byteLength + characterBytes > maxBytes) {
      break;
    }
    byteLength += characterBytes;
    nextCharOffset += codeUnits;
  }
  if (nextCharOffset === charOffset) {
    if (charOffset >= data.length || maxBytes <= 0) {
      return null;
    }
    const first = data.charCodeAt(charOffset);
    const codeUnits =
      first >= 0xd800 &&
      first <= 0xdbff &&
      charOffset + 1 < data.length &&
      data.charCodeAt(charOffset + 1) >= 0xdc00 &&
      data.charCodeAt(charOffset + 1) <= 0xdfff
        ? 2
        : 1;
    const encodedCharacter = new Uint8Array(
      Buffer.from(data.slice(charOffset, charOffset + codeUnits), "utf8")
    );
    const chunk = encodedCharacter.slice(0, maxBytes);
    checkpoint.charOffset += codeUnits;
    if (chunk.byteLength < encodedCharacter.byteLength) {
      checkpoint.pendingEncodedBytes = encodedCharacter;
      checkpoint.pendingEncodedOffset = chunk.byteLength;
    }
    return chunk.buffer;
  }
  const encoded = Buffer.from(data.slice(charOffset, nextCharOffset), "utf8");
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  checkpoint.charOffset = nextCharOffset;
  return bytes.buffer;
}
