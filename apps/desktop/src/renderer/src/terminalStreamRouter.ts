import type {
  TerminalCheckpointMetadata,
  TerminalCheckpointPurpose,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneDetachReason,
  TerminalDataPlaneHostMessage,
  TerminalDelta,
  TerminalInputDiagnosticKind,
  TerminalKeyInput,
  TerminalOutputDiagnosticKind,
  TerminalSessionRef,
  Uint64
} from "@kmux/proto";
import {
  TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
  TERMINAL_DATA_PLANE_MAX_INPUT_BYTES,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  formatUint64Decimal,
  incrementUint64,
  uint64,
  validateTerminalDataPlaneClientMessage,
  validateTerminalDataPlaneHostMessage
} from "@kmux/proto";

import {
  createVisibleTerminalWriteScheduler,
  type VisibleTerminalWriteScheduler,
  type VisibleTerminalWriteSchedulerOptions
} from "./visibleTerminalWriteScheduler";
import { nonNegativeDurationMs } from "../../shared/terminalDataPlaneMetrics";
import {
  RendererTerminalWriteArbiter,
  type RendererTerminalWriteArbiterOptions
} from "./rendererTerminalWriteArbiter";
import type { TerminalStreamError } from "../../shared/terminalStreamDiagnostics";

type MaybePromise<T> = T | Promise<T>;
const MAX_PENDING_RENDER_METRICS = 2_048;
// Keep each renderer parse quantum small enough that one visible surface cannot
// monopolize the shared JS thread. Credit is still returned only after xterm's
// callback has parsed every quantum belonging to a delta.
const MAX_COALESCED_SINK_WRITE_CHARS = 16 * 1024;

export interface TerminalStreamPort {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  addEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
}

export interface TerminalStreamResume {
  resumedFromSequence: Uint64;
  availableSequence: Uint64;
  cols: number;
  rows: number;
}

export interface TerminalResumeCursor {
  session: TerminalSessionRef;
  sequence: Uint64;
}

export type TerminalDetachOutcome =
  | { kind: "resumable"; cursor: TerminalResumeCursor }
  | { kind: "discarded" };

export interface TerminalStreamWriteContext {
  delta: Extract<TerminalDelta, { type: "output" }>;
  presentation: "plain" | "immediate";
  dataOffset: number;
  finalPart: boolean;
}

export interface TerminalCheckpointApplyResult {
  swapGeneration?: number;
}

export interface TerminalCheckpointHydration {
  writeChunk(data: ArrayBuffer): Promise<void>;
  commit(digest: string): Promise<void | TerminalCheckpointApplyResult>;
  cancel(reason?: Error): void;
}

export type TerminalStreamRouterError = TerminalStreamError;

/**
 * The sink owns the xterm widget. Completion callbacks must run only after
 * xterm has parsed the supplied data; the router uses that boundary to return
 * byte credit to the PTY supervisor.
 */
export interface TerminalStreamSink {
  beginCheckpoint(
    metadata: TerminalCheckpointMetadata,
    totalBytes: number
  ): MaybePromise<TerminalCheckpointHydration>;
  applyResume(resume: TerminalStreamResume): MaybePromise<void>;
  outputReceived?(
    delta: Extract<TerminalDelta, { type: "output" }>,
    receivedAt: number | null
  ): void;
  write(
    data: string,
    onParsed: () => void,
    context: TerminalStreamWriteContext
  ): void;
  resize(delta: Extract<TerminalDelta, { type: "resize" }>): MaybePromise<void>;
  exit(
    event: Extract<TerminalDataPlaneHostMessage, { type: "exit" }>
  ): MaybePromise<void>;
  resizeAcknowledged?(
    event: Extract<TerminalDataPlaneHostMessage, { type: "resize:ack" }>
  ): MaybePromise<void>;
  detached?(reason: TerminalDataPlaneDetachReason): void;
  reportError?(error: TerminalStreamRouterError): void;
}

export type TerminalStreamWriteSchedulerOptions = Omit<
  VisibleTerminalWriteSchedulerOptions,
  "write" | "onWriteError"
>;

export type TerminalStreamMetricName =
  | "terminal.data-plane.receive"
  | "terminal.data-plane.parsed"
  | "terminal.data-plane.render"
  | "terminal.data-plane.paint"
  | "terminal.data-plane.resync";

export interface TerminalStreamMetricsRecorder {
  now(): number;
  record(
    name: TerminalStreamMetricName,
    details: Record<string, unknown>
  ): void;
}

export interface RegisterTerminalStreamOptions {
  port: TerminalStreamPort;
  attachId: string;
  session: TerminalSessionRef;
  sink: TerminalStreamSink;
  resumeFromSequence?: Uint64;
  initialCreditBytes?: number;
  /** Supplying this object enables adaptive visible-output pacing. */
  writeScheduler?: TerminalStreamWriteSchedulerOptions;
  /**
   * Scrollback, alternate-screen, mouse-tracking, and synchronized-output
   * states can force presentation to stay immediate.
   */
  shouldWriteImmediately?: () => boolean;
  metrics?: TerminalStreamMetricsRecorder;
  /** Profile hot paths without making the profiler itself the bottleneck. */
  metricsSampleEvery?: number;
}

export interface TerminalStreamRouterOptions {
  writeArbiterOptions?: RendererTerminalWriteArbiterOptions;
}

export interface CooperativeTerminalWriteTask {
  readonly completion: Promise<void>;
  cancel(reason?: Error): void;
}

export interface TerminalStreamRegistration {
  readonly attachId: string;
  readonly session: TerminalSessionRef;
  readonly sequence: Uint64 | null;
  readonly closed: boolean;
  /**
   * False while received output is queued, scheduled, or still being parsed by
   * xterm. A detached terminal may resume from `sequence` only when this is
   * true; otherwise its buffer can be ahead of the acknowledged sequence.
   */
  readonly resumeSafe: boolean;
  sendText(text: string): void;
  sendBinary(data: string): void;
  sendKey(input: TerminalKeyInput): void;
  resize(
    cols: number,
    rows: number,
    options?: { requestId?: string; gestureActive?: boolean }
  ): void;
  notifyInput(): void;
  setPresentationImmediate(immediate: boolean): void;
  notifyRendered(): void;
  replaceSink(
    sink: TerminalStreamSink,
    shouldWriteImmediately?: () => boolean
  ): void;
  detach(
    reason?: TerminalDataPlaneDetachReason
  ): Promise<TerminalDetachOutcome>;
}

interface Attachment {
  readonly port: TerminalStreamPort;
  readonly attachId: string;
  readonly session: TerminalSessionRef;
  sink: TerminalStreamSink;
  readonly requestedResumeSequence: Uint64 | undefined;
  shouldWriteImmediately: (() => boolean) | undefined;
  readonly classifier: ConservativeTerminalOutputClassifier;
  readonly messages: TerminalDataPlaneHostMessage[];
  readonly onMessage: (event: MessageEvent<unknown>) => void;
  readonly onMessageError: (event: MessageEvent<unknown>) => void;
  scheduler: VisibleTerminalWriteScheduler | null;
  /** Output accepted from the wire but not necessarily parsed by xterm yet. */
  readonly pendingOutputs: ScheduledOutput[];
  /** The subset of pendingOutputs whose bytes have not all reached the sink. */
  readonly schedulerContexts: ScheduledOutput[];
  readonly sinkWriteQueue: PendingSinkWrite[];
  readonly sinkWriteCompletions: SinkWriteCompletion[];
  sinkWriteInFlight: boolean;
  sinkPriorityPending: boolean;
  readonly outputBarrierWaiters: OutputBarrierWaiter[];
  attached: boolean;
  /** The capability port is closed, while admitted renderer work may settle. */
  sealed: boolean;
  closed: boolean;
  draining: boolean;
  presentationImmediate: boolean;
  /** Last wire mutation validated and admitted to the presentation pipeline. */
  acceptedSequence: Uint64 | null;
  /** Last mutation whose xterm callback (or ordered sink barrier) completed. */
  sequence: Uint64 | null;
  /** Mutations at or below this sequence predate the current live attach. */
  preAttachSequence: Uint64 | null;
  checkpoint: ActiveCheckpointHydration | null;
  /** True only after the renderer has parsed the attach-time replay cursor. */
  liveCaughtUp: boolean;
  metrics: TerminalStreamMetricsRecorder | undefined;
  metricsSampleEvery: number;
  outputMetricOrdinal: number;
  readonly outputMetrics: Map<Uint64, TerminalOutputMetricTrace>;
  readonly pendingRenderMetrics: TerminalOutputMetricTrace[];
  renderMetricOverflowCount: number;
  lastOnRenderAt: number | null;
  paintPendingSinceAt: number | null;
  readonly paintIntervalsMs: number[];
  detachReason: TerminalDataPlaneDetachReason | null;
  detachSettlement: {
    promise: Promise<TerminalDetachOutcome>;
    resolve: (outcome: TerminalDetachOutcome) => void;
  } | null;
}

interface ScheduledOutput {
  readonly delta: Extract<TerminalDelta, { type: "output" }>;
  readonly data: string;
  readonly presentation: "plain" | "immediate";
  scheduledOffset: number;
  outstandingParts: number;
  allScheduled: boolean;
  fullyParsed: boolean;
}

interface SinkWriteBatch {
  remaining: number;
  readonly onWritten: (() => void) | undefined;
}

interface PendingSinkWrite {
  readonly output: ScheduledOutput;
  readonly data: string;
  readonly dataOffset: number;
  readonly finalPart: boolean;
  readonly batch: SinkWriteBatch;
}

interface SinkWriteCompletion {
  completed: boolean;
  readonly writes: PendingSinkWrite[];
}

interface OutputBarrierWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface TerminalOutputMetricTrace {
  sequence: Uint64;
  byteLength: number;
  ptyReadAt?: number;
  headlessCommitAt?: number;
  portSentAt?: number;
  portReceiveAt: number;
  presentationQueuedAt?: number;
  presentationStartedAt?: number;
  presentationReleasedAt?: number;
  xtermParsedAt?: number;
  presentation?: "plain" | "immediate";
  immediateReason?: "control" | "forced" | "terminal-state" | "replay";
  visibleAtPtyRead?: boolean;
  inputAcceptedAt?: number;
  inputSequence?: Uint64;
  inputKind?: TerminalInputDiagnosticKind;
  outputKinds?: TerminalOutputDiagnosticKind[];
}

interface ActiveCheckpointHydration {
  readonly checkpointId: string;
  readonly purpose: TerminalCheckpointPurpose;
  readonly metadata: TerminalCheckpointMetadata;
  readonly totalBytes: number;
  readonly hydration: TerminalCheckpointHydration;
  readonly startedAt: number | undefined;
  nextOffset: number;
}

/** Routes every live surface port without one global IPC listener per pane. */
export class TerminalStreamRouter {
  private readonly attachments = new Map<string, Attachment>();
  private readonly cooperativeWrites = new Map<
    string,
    CooperativeTerminalWriteTask
  >();
  private readonly writeArbiter: RendererTerminalWriteArbiter;

  constructor(options: TerminalStreamRouterOptions = {}) {
    this.writeArbiter = new RendererTerminalWriteArbiter({
      ...options.writeArbiterOptions,
      onError: (laneId, error) => {
        options.writeArbiterOptions?.onError?.(laneId, error);
        const attachment = [...this.attachments.values()].find(
          (candidate) =>
            surfaceWriteLaneId(candidate.session.surfaceId) === laneId
        );
        if (attachment && !attachment.closed) {
          this.failAttachment(attachment, {
            kind: "sink-error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
  }

  get size(): number {
    return this.attachments.size;
  }

  configureMetrics(
    metrics: TerminalStreamMetricsRecorder | undefined,
    metricsSampleEvery = 1
  ): void {
    for (const attachment of this.attachments.values()) {
      attachment.metrics = metrics;
      attachment.metricsSampleEvery = Math.max(
        1,
        Math.floor(metricsSampleEvery)
      );
      if (!metrics) {
        attachment.outputMetrics.clear();
        attachment.pendingRenderMetrics.length = 0;
        attachment.paintIntervalsMs.length = 0;
        attachment.paintPendingSinceAt = null;
      }
    }
  }

  /**
   * Uses the same renderer-wide admission clock for non-live xterm parsing,
   * notably offscreen checkpoint hydration. The caller supplies the surface id
   * and owns cancellation when that staged widget is stale. Live
   * output and checkpoint hydration share that surface's priority lane.
   */
  beginCooperativeWrite(
    laneId: string,
    data: string,
    write: (chunk: string, onParsed: () => void) => void
  ): CooperativeTerminalWriteTask {
    const arbiterLaneId = surfaceWriteLaneId(laneId);
    this.cooperativeWrites
      .get(laneId)
      ?.cancel(new Error("cooperative terminal write was superseded"));

    let offset = 0;
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    let task!: CooperativeTerminalWriteTask;

    const removeCurrent = (): void => {
      if (this.cooperativeWrites.get(laneId) === task) {
        this.cooperativeWrites.delete(laneId);
      }
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeCurrent();
      resolveCompletion();
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.writeArbiter.cancel(arbiterLaneId);
      removeCurrent();
      rejectCompletion(error);
    };

    const requestNext = (): void => {
      if (settled) {
        return;
      }
      if (offset >= data.length) {
        finish();
        return;
      }
      this.writeArbiter.request(arbiterLaneId, () => {
        if (settled) {
          return;
        }
        const requestedLength = Math.min(
          MAX_COALESCED_SINK_WRITE_CHARS,
          data.length - offset
        );
        const chunkLength = avoidSplitSurrogatePair(
          data,
          offset,
          requestedLength
        );
        const chunk = data.slice(offset, offset + chunkLength);
        offset += chunkLength;
        let callbackCompleted = false;
        try {
          write(chunk, () => {
            if (callbackCompleted || settled) {
              return;
            }
            callbackCompleted = true;
            requestNext();
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    task = {
      completion,
      cancel: (
        reason = new Error("cooperative terminal write was cancelled")
      ) => fail(reason)
    };
    this.cooperativeWrites.set(laneId, task);
    requestNext();
    return task;
  }

  register(options: RegisterTerminalStreamOptions): TerminalStreamRegistration {
    const attachMessage: TerminalDataPlaneClientMessage = {
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      attachId: options.attachId,
      session: options.session,
      type: "attach",
      creditBytes:
        options.initialCreditBytes ?? TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES,
      ...(options.resumeFromSequence === undefined
        ? {}
        : { resumeFromSequence: options.resumeFromSequence })
    };
    const attachValidation = validateTerminalDataPlaneClientMessage(
      attachMessage,
      { attachId: options.attachId, session: options.session }
    );
    if (!attachValidation.ok) {
      throw new Error(attachValidation.error);
    }

    let attachment: Attachment;
    const onMessage = (event: MessageEvent<unknown>): void => {
      const portReceiveAt = attachment.metrics?.now();
      this.receive(attachment, event.data, portReceiveAt);
    };
    const onMessageError = (): void => {
      this.failAttachment(attachment, {
        kind: "port-error",
        message: "terminal stream MessagePort could not deserialize a message"
      });
    };
    attachment = {
      port: options.port,
      attachId: options.attachId,
      session: options.session,
      sink: options.sink,
      requestedResumeSequence: options.resumeFromSequence,
      shouldWriteImmediately: options.shouldWriteImmediately,
      classifier: new ConservativeTerminalOutputClassifier(),
      messages: [],
      onMessage,
      onMessageError,
      scheduler: null,
      pendingOutputs: [],
      schedulerContexts: [],
      sinkWriteQueue: [],
      sinkWriteCompletions: [],
      sinkWriteInFlight: false,
      sinkPriorityPending: false,
      outputBarrierWaiters: [],
      attached: false,
      sealed: false,
      closed: false,
      draining: false,
      presentationImmediate: false,
      acceptedSequence: null,
      sequence: null,
      preAttachSequence: null,
      checkpoint: null,
      liveCaughtUp: false,
      metrics: options.metrics,
      metricsSampleEvery: Math.max(
        1,
        Math.floor(options.metricsSampleEvery ?? 1)
      ),
      outputMetricOrdinal: 0,
      outputMetrics: new Map(),
      pendingRenderMetrics: [],
      renderMetricOverflowCount: 0,
      lastOnRenderAt: null,
      paintPendingSinceAt: null,
      paintIntervalsMs: [],
      detachReason: null,
      detachSettlement: null
    };

    if (options.writeScheduler) {
      attachment.scheduler = createVisibleTerminalWriteScheduler({
        ...options.writeScheduler,
        write: (data, onWritten) => {
          this.writeScheduledPart(attachment, data, onWritten);
        },
        onWriteError: (error) => {
          this.rejectOutputBarriers(attachment, error);
          this.failAttachment(attachment, {
            kind: "sink-error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }

    const existing = this.attachments.get(options.session.surfaceId);
    if (existing) {
      this.closeAttachment(existing, "replaced", true);
    }
    this.attachments.set(options.session.surfaceId, attachment);
    options.port.addEventListener("message", onMessage);
    options.port.addEventListener("messageerror", onMessageError);
    options.port.start();
    this.postClientMessage(attachment, attachValidation.value);

    return this.registrationFor(attachment);
  }

  detachSurface(
    surfaceId: string,
    reason: TerminalDataPlaneDetachReason = "hidden"
  ): void {
    const attachment = this.attachments.get(surfaceId);
    if (attachment) {
      void this.detachAttachment(attachment, reason);
    }
  }

  dispose(): void {
    for (const attachment of [...this.attachments.values()]) {
      this.closeAttachment(attachment, "renderer-reload", true);
    }
    for (const task of [...this.cooperativeWrites.values()]) {
      task.cancel(new Error("terminal stream router was disposed"));
    }
    this.writeArbiter.dispose();
  }

  private registrationFor(attachment: Attachment): TerminalStreamRegistration {
    const router = this;
    return {
      attachId: attachment.attachId,
      session: attachment.session,
      get sequence() {
        return attachment.sequence;
      },
      get closed() {
        return attachment.closed || attachment.sealed;
      },
      get resumeSafe() {
        return router.isResumeSafe(attachment);
      },
      sendText(text) {
        router.notifyInput(attachment);
        for (const chunk of splitUtf8Input(text)) {
          router.postClientMessage(attachment, {
            ...router.envelope(attachment),
            type: "input:text",
            text: chunk
          });
        }
      },
      sendBinary(data) {
        router.notifyInput(attachment);
        for (
          let offset = 0;
          offset < data.length;
          offset += TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
        ) {
          router.postClientMessage(attachment, {
            ...router.envelope(attachment),
            type: "input:binary",
            data: data.slice(
              offset,
              offset + TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
            )
          });
        }
      },
      sendKey(input) {
        router.notifyInput(attachment);
        router.postClientMessage(attachment, {
          ...router.envelope(attachment),
          type: "input:key",
          input
        });
      },
      resize(cols, rows, resizeOptions = {}) {
        router.postClientMessage(attachment, {
          ...router.envelope(attachment),
          type: "resize",
          cols,
          rows,
          ...resizeOptions
        });
      },
      notifyInput() {
        router.notifyInput(attachment);
      },
      setPresentationImmediate(immediate) {
        attachment.presentationImmediate = immediate;
        if (immediate) {
          attachment.scheduler?.flush();
        }
      },
      notifyRendered() {
        router.notifyRendered(attachment);
      },
      replaceSink(sink, shouldWriteImmediately) {
        if (!attachment.closed) {
          attachment.sink = sink;
          attachment.shouldWriteImmediately = shouldWriteImmediately;
        }
      },
      detach(reason = "hidden") {
        return router.detachAttachment(attachment, reason);
      }
    };
  }

  private receive(
    attachment: Attachment,
    rawMessage: unknown,
    portReceiveAt?: number
  ): void {
    if (attachment.closed || attachment.sealed || !this.isCurrent(attachment)) {
      return;
    }
    if (isIdentifiablyStale(rawMessage, attachment)) {
      return;
    }
    const validation = validateTerminalDataPlaneHostMessage(rawMessage, {
      attachId: attachment.attachId,
      session: attachment.session
    });
    if (!validation.ok) {
      this.failAttachment(attachment, {
        kind: "invalid-message",
        message: validation.error
      });
      return;
    }
    if (validation.value.type === "attached") {
      attachment.preAttachSequence = validation.value.sequence;
      attachment.liveCaughtUp = false;
    } else if (validation.value.type === "checkpoint:begin") {
      const checkpointSequence = validation.value.metadata.sequence;
      attachment.preAttachSequence =
        attachment.preAttachSequence === null ||
        checkpointSequence > attachment.preAttachSequence
          ? checkpointSequence
          : attachment.preAttachSequence;
      attachment.liveCaughtUp = false;
    }
    if (
      validation.value.type === "delta" &&
      validation.value.delta.type === "output"
    ) {
      const receivedAt = portReceiveAt ?? attachment.metrics?.now() ?? null;
      attachment.sink.outputReceived?.(validation.value.delta, receivedAt);
      this.recordOutputReceived(
        attachment,
        validation.value.delta,
        validation.value.telemetry?.portSentAt,
        receivedAt ?? undefined
      );
    }
    attachment.messages.push(validation.value);
    this.scheduleDrain(attachment);
  }

  private scheduleDrain(attachment: Attachment): void {
    if (attachment.draining || attachment.closed) {
      return;
    }
    attachment.draining = true;
    void this.drain(attachment);
  }

  private async drain(attachment: Attachment): Promise<void> {
    try {
      while (
        !attachment.closed &&
        this.isCurrent(attachment) &&
        attachment.messages.length > 0
      ) {
        const message = attachment.messages.shift();
        if (message) {
          const barrier = this.applyMessage(attachment, message);
          if (barrier) {
            await barrier;
          }
        }
      }
    } catch (error) {
      if (!attachment.closed) {
        this.failAttachment(attachment, {
          kind: "sink-error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      attachment.draining = false;
      if (!attachment.closed && attachment.messages.length > 0) {
        this.scheduleDrain(attachment);
      } else {
        this.tryFinalizeSealedAttachment(attachment);
      }
    }
  }

  private applyMessage(
    attachment: Attachment,
    message: TerminalDataPlaneHostMessage
  ): Promise<void> | void {
    switch (message.type) {
      case "attached":
        return this.applyAttached(attachment, message);
      case "checkpoint:begin":
        return this.applyCheckpointBegin(attachment, message);
      case "checkpoint:chunk":
        return this.applyCheckpointChunk(attachment, message);
      case "checkpoint:end":
        return this.applyCheckpointEnd(attachment, message);
      case "delta":
        return this.applyDelta(attachment, message.delta);
      case "resize:ack":
        return this.applyResizeAcknowledgement(attachment, message);
      case "exit":
        return this.applyExit(attachment, message);
      case "error":
        this.reportError(attachment, {
          kind: "host-error",
          code: message.code,
          message: message.message,
          recoverable: message.recoverable
        });
        if (!message.recoverable) {
          this.closeAttachment(
            attachment,
            message.code === "checkpoint-too-large"
              ? "surface-closed"
              : "replaced",
            false
          );
        }
        return;
    }
  }

  private async applyCheckpointBegin(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "checkpoint:begin" }>
  ): Promise<void> {
    if (attachment.checkpoint) {
      throw new Error("terminal stream received overlapping checkpoints");
    }
    await this.waitForPendingOutputs(attachment);
    if (attachment.closed) {
      return;
    }
    if (
      attachment.sequence !== null &&
      message.metadata.sequence < attachment.sequence
    ) {
      this.failSequenceGap(
        attachment,
        attachment.sequence,
        message.metadata.sequence,
        "resync checkpoint precedes the renderer sequence"
      );
      return;
    }
    attachment.scheduler?.flush();
    attachment.classifier.reset();
    attachment.outputMetrics.clear();
    attachment.pendingRenderMetrics.length = 0;
    const hydration = await attachment.sink.beginCheckpoint(
      message.metadata,
      message.totalBytes
    );
    if (attachment.closed) {
      hydration.cancel(
        new Error("terminal checkpoint attachment closed before hydration")
      );
      return;
    }
    attachment.checkpoint = {
      checkpointId: message.checkpointId,
      purpose: message.purpose,
      metadata: message.metadata,
      totalBytes: message.totalBytes,
      hydration,
      startedAt:
        message.purpose.kind === "resync"
          ? attachment.metrics?.now()
          : undefined,
      nextOffset: 0
    };
  }

  private async applyCheckpointChunk(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "checkpoint:chunk" }>
  ): Promise<void> {
    const checkpoint = attachment.checkpoint;
    if (
      !checkpoint ||
      checkpoint.checkpointId !== message.checkpointId ||
      message.offset !== checkpoint.nextOffset ||
      message.offset + message.data.byteLength > checkpoint.totalBytes
    ) {
      throw new Error(
        "terminal checkpoint chunk is outside the active transfer"
      );
    }
    await checkpoint.hydration.writeChunk(message.data);
    if (attachment.closed || attachment.checkpoint !== checkpoint) {
      return;
    }
    checkpoint.nextOffset += message.data.byteLength;
    this.postClientMessage(attachment, {
      ...this.envelope(attachment),
      type: "checkpoint:credit",
      checkpointId: checkpoint.checkpointId,
      acknowledgedOffset: checkpoint.nextOffset,
      bytes: message.data.byteLength
    });
  }

  private async applyCheckpointEnd(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "checkpoint:end" }>
  ): Promise<void> {
    const checkpoint = attachment.checkpoint;
    if (
      !checkpoint ||
      checkpoint.checkpointId !== message.checkpointId ||
      checkpoint.nextOffset !== checkpoint.totalBytes
    ) {
      throw new Error("terminal checkpoint ended outside the active transfer");
    }
    const result = await checkpoint.hydration.commit(message.digest);
    if (attachment.closed || attachment.checkpoint !== checkpoint) {
      return;
    }
    attachment.checkpoint = null;
    attachment.attached = true;
    attachment.acceptedSequence = checkpoint.metadata.sequence;
    attachment.sequence = checkpoint.metadata.sequence;
    attachment.liveCaughtUp = true;

    const committedAt =
      checkpoint.purpose.kind === "resync"
        ? attachment.metrics?.now()
        : undefined;
    if (
      checkpoint.purpose.kind === "resync" &&
      attachment.metrics &&
      checkpoint.startedAt !== undefined &&
      committedAt !== undefined
    ) {
      attachment.metrics.record("terminal.data-plane.resync", {
        surfaceId: attachment.session.surfaceId,
        sessionId: attachment.session.sessionId,
        epoch: attachment.session.epoch,
        attachId: attachment.attachId,
        checkpointSequence: formatUint64Decimal(checkpoint.metadata.sequence),
        missingFromSequence: formatUint64Decimal(
          checkpoint.purpose.missingFromSequence
        ),
        retainedFromSequence: formatUint64Decimal(
          checkpoint.purpose.retainedFromSequence
        ),
        startedAt: checkpoint.startedAt,
        committedAt,
        durationMs: nonNegativeDurationMs(checkpoint.startedAt, committedAt),
        swapGeneration: result?.swapGeneration
      });
    }
  }

  private async applyResizeAcknowledgement(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "resize:ack" }>
  ): Promise<void> {
    await this.waitForPendingOutputs(attachment);
    if (!attachment.closed) {
      await attachment.sink.resizeAcknowledged?.(message);
    }
  }

  private async applyAttached(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "attached" }>
  ): Promise<void> {
    if (attachment.attached) {
      throw new Error(
        "terminal stream received more than one attached message"
      );
    }
    if (
      attachment.requestedResumeSequence === undefined ||
      message.resumedFromSequence !== attachment.requestedResumeSequence
    ) {
      throw new Error("terminal stream resumed from an unexpected sequence");
    }
    attachment.scheduler?.flush();
    await attachment.sink.applyResume({
      resumedFromSequence: message.resumedFromSequence,
      availableSequence: message.sequence,
      cols: message.cols,
      rows: message.rows
    });
    if (attachment.closed) {
      return;
    }
    attachment.attached = true;
    attachment.acceptedSequence = message.resumedFromSequence;
    attachment.sequence = message.resumedFromSequence;
    attachment.liveCaughtUp = message.resumedFromSequence >= message.sequence;
  }

  private applyDelta(
    attachment: Attachment,
    delta: TerminalDelta
  ): Promise<void> | void {
    const acceptedSequence = attachment.acceptedSequence;
    if (!attachment.attached || acceptedSequence === null) {
      throw new Error("terminal delta arrived before attachment hydration");
    }
    if (delta.sequence <= acceptedSequence) {
      if (
        delta.type === "output" &&
        attachment.sequence !== null &&
        delta.sequence <= attachment.sequence
      ) {
        attachment.outputMetrics.delete(delta.sequence);
      }
      return;
    }
    if (delta.type === "output") {
      if (delta.fromSequence !== acceptedSequence) {
        this.failSequenceGap(
          attachment,
          incrementUint64(acceptedSequence),
          delta.segments[0]?.sequence ?? delta.sequence,
          `output delta starts after sequence ${delta.fromSequence}`
        );
        return;
      }
      let expectedSequence = incrementUint64(acceptedSequence);
      for (const segment of delta.segments) {
        if (segment.sequence !== expectedSequence) {
          this.failSequenceGap(
            attachment,
            expectedSequence,
            segment.sequence,
            "output delta contains a non-contiguous segment"
          );
          return;
        }
        expectedSequence = incrementUint64(expectedSequence);
      }
      // Admit consecutive output without waiting for each xterm callback. This
      // lets the visible scheduler see the actual MessagePort backlog and
      // coalesce/catch up across wire deltas. Credit and the public sequence
      // still advance only from commitParsedOutputs, in parser order.
      attachment.acceptedSequence = delta.sequence;
      this.enqueueOutput(attachment, delta);
      return;
    }

    if (delta.sequence !== incrementUint64(acceptedSequence)) {
      this.failSequenceGap(
        attachment,
        incrementUint64(acceptedSequence),
        delta.sequence,
        "resize delta is not the next terminal mutation"
      );
      return;
    }
    return this.applyResize(attachment, delta);
  }

  private async applyResize(
    attachment: Attachment,
    delta: Extract<TerminalDelta, { type: "resize" }>
  ): Promise<void> {
    await this.waitForPendingOutputs(attachment);
    if (attachment.closed) {
      return;
    }
    await attachment.sink.resize(delta);
    if (!attachment.closed) {
      attachment.acceptedSequence = delta.sequence;
      attachment.sequence = delta.sequence;
      if (
        attachment.preAttachSequence !== null &&
        attachment.sequence >= attachment.preAttachSequence
      ) {
        attachment.liveCaughtUp = true;
      }
    }
  }

  private enqueueOutput(
    attachment: Attachment,
    delta: Extract<TerminalDelta, { type: "output" }>
  ): void {
    const data = delta.segments.map((segment) => segment.data).join("");
    const plain = attachment.classifier.classify(data);
    const terminalStateImmediate =
      attachment.shouldWriteImmediately?.() === true;
    const replayImmediate = !attachment.liveCaughtUp;
    const immediate =
      !plain ||
      attachment.presentationImmediate ||
      terminalStateImmediate ||
      replayImmediate;
    const presentation = immediate ? "immediate" : "plain";
    const outputMetric = attachment.outputMetrics.get(delta.sequence);
    if (outputMetric) {
      outputMetric.presentation = presentation;
      outputMetric.immediateReason = !plain
        ? "control"
        : attachment.presentationImmediate
          ? "forced"
          : terminalStateImmediate
            ? "terminal-state"
            : replayImmediate
              ? "replay"
              : undefined;
    }
    const output: ScheduledOutput = {
      delta,
      data,
      presentation,
      scheduledOffset: 0,
      outstandingParts: 0,
      allScheduled: data.length === 0,
      fullyParsed: data.length === 0
    };
    attachment.pendingOutputs.push(output);
    if (data.length === 0) {
      this.commitParsedOutputs(attachment);
      return;
    }
    attachment.schedulerContexts.push(output);
    try {
      if (!attachment.scheduler) {
        this.writeScheduledPart(attachment, data, undefined);
      } else if (immediate) {
        attachment.scheduler.writeImmediate(data);
      } else {
        attachment.scheduler.writePlain(data);
      }
    } catch (error) {
      this.rejectOutputBarriers(attachment, error);
      throw error;
    }
  }

  private writeScheduledPart(
    attachment: Attachment,
    data: string,
    onWritten: (() => void) | undefined
  ): void {
    const slices: Array<{
      output: ScheduledOutput;
      data: string;
      dataOffset: number;
      finalPart: boolean;
    }> = [];
    let emittedOffset = 0;
    while (emittedOffset < data.length) {
      const output = attachment.schedulerContexts[0];
      if (!output) {
        throw new Error("terminal scheduler emitted more data than was queued");
      }
      const remaining = output.data.length - output.scheduledOffset;
      const dataOffset = output.scheduledOffset;
      const segmentEnd = nextOutputCwdRunEnd(output.delta, dataOffset);
      const sliceLength = Math.min(
        remaining,
        data.length - emittedOffset,
        segmentEnd - dataOffset,
        MAX_COALESCED_SINK_WRITE_CHARS
      );
      const unicodeSafeSliceLength = avoidSplitSurrogatePair(
        data,
        emittedOffset,
        sliceLength
      );
      const slice = data.slice(
        emittedOffset,
        emittedOffset + unicodeSafeSliceLength
      );
      if (
        slice !==
        output.data.slice(dataOffset, dataOffset + unicodeSafeSliceLength)
      ) {
        throw new Error("terminal scheduler changed queued output ordering");
      }
      output.scheduledOffset += unicodeSafeSliceLength;
      emittedOffset += unicodeSafeSliceLength;
      const finalPart = output.scheduledOffset === output.data.length;
      if (finalPart) {
        output.allScheduled = true;
        attachment.schedulerContexts.shift();
      }
      output.outstandingParts += 1;
      slices.push({ output, data: slice, dataOffset, finalPart });
      const outputMetric = attachment.outputMetrics.get(output.delta.sequence);
      if (
        outputMetric &&
        outputMetric.presentationReleasedAt === undefined &&
        attachment.metrics
      ) {
        outputMetric.presentationReleasedAt = attachment.metrics.now();
      }
    }

    if (slices.length === 0) {
      onWritten?.();
      return;
    }
    const batch: SinkWriteBatch = {
      remaining: slices.length,
      onWritten
    };
    for (const slice of slices) {
      attachment.sinkWriteQueue.push({ ...slice, batch });
    }
    this.scheduleSinkWrite(attachment);
  }

  private scheduleSinkWrite(attachment: Attachment): void {
    if (
      attachment.sinkWriteInFlight ||
      attachment.closed ||
      attachment.sinkWriteQueue.length === 0
    ) {
      return;
    }
    const priority = attachment.sinkPriorityPending;
    attachment.sinkPriorityPending = false;
    this.writeArbiter.request(
      surfaceWriteLaneId(attachment.session.surfaceId),
      () => this.dispatchOneSinkWrite(attachment),
      priority
    );
  }

  private dispatchOneSinkWrite(attachment: Attachment): void {
    if (
      attachment.sinkWriteInFlight ||
      attachment.closed ||
      attachment.sinkWriteQueue.length === 0
    ) {
      return;
    }
    const firstWrite = attachment.sinkWriteQueue.shift();
    if (!firstWrite) {
      return;
    }

    // One surface may have only one unparsed xterm write in flight. Compatible
    // slices are coalesced up to 16 KiB; larger source writes were split before
    // entering this queue.
    const writes = [firstWrite];
    const writeCwd = sinkWriteCwd(firstWrite);
    let writeChars = firstWrite.data.length;
    while (attachment.sinkWriteQueue.length > 0) {
      const next = attachment.sinkWriteQueue[0];
      if (
        !next ||
        next.output.presentation !== firstWrite.output.presentation ||
        sinkWriteCwd(next) !== writeCwd ||
        writeChars + next.data.length > MAX_COALESCED_SINK_WRITE_CHARS
      ) {
        break;
      }
      attachment.sinkWriteQueue.shift();
      writes.push(next);
      writeChars += next.data.length;
    }

    const presentationStartedAt = attachment.metrics?.now();
    for (const write of writes) {
      const outputMetric = attachment.outputMetrics.get(
        write.output.delta.sequence
      );
      if (
        outputMetric &&
        outputMetric.presentationStartedAt === undefined &&
        presentationStartedAt !== undefined
      ) {
        outputMetric.presentationStartedAt = presentationStartedAt;
      }
    }

    const contextWrite =
      [...writes].reverse().find((write) => write.finalPart) ?? writes.at(-1)!;
    const completion: SinkWriteCompletion = {
      completed: false,
      writes
    };
    attachment.sinkWriteCompletions.push(completion);
    attachment.sinkWriteInFlight = true;
    let callbackCompleted = false;
    try {
      attachment.sink.write(
        writes.map((write) => write.data).join(""),
        () => {
          if (callbackCompleted) {
            return;
          }
          callbackCompleted = true;
          let completionFailed = false;
          let completionError: unknown;
          try {
            completion.completed = true;
            this.commitCompletedSinkWrites(attachment);
          } catch (error) {
            completionFailed = true;
            completionError = error;
          } finally {
            attachment.sinkWriteInFlight = false;
          }
          if (completionFailed) {
            this.rejectOutputBarriers(attachment, completionError);
            this.failAttachment(attachment, {
              kind: "sink-error",
              message:
                completionError instanceof Error
                  ? completionError.message
                  : String(completionError)
            });
            return;
          }
          this.scheduleSinkWrite(attachment);
        },
        {
          delta: contextWrite.output.delta,
          presentation: contextWrite.output.presentation,
          dataOffset: contextWrite.dataOffset,
          finalPart: contextWrite.finalPart
        }
      );
    } catch (error) {
      attachment.sinkWriteInFlight = false;
      this.rejectOutputBarriers(attachment, error);
      this.failAttachment(attachment, {
        kind: "sink-error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private commitCompletedSinkWrites(attachment: Attachment): void {
    while (attachment.sinkWriteCompletions[0]?.completed) {
      const completion = attachment.sinkWriteCompletions.shift();
      if (!completion) {
        break;
      }
      const completedBatches: SinkWriteBatch[] = [];
      for (const write of completion.writes) {
        this.markOutputPartParsed(attachment, write.output);
        write.batch.remaining -= 1;
        if (write.batch.remaining === 0) {
          completedBatches.push(write.batch);
        }
      }
      for (const batch of completedBatches) {
        batch.onWritten?.();
      }
    }
  }

  private markOutputPartParsed(
    attachment: Attachment,
    output: ScheduledOutput
  ): void {
    if (attachment.closed || output.fullyParsed) {
      return;
    }
    output.outstandingParts = Math.max(0, output.outstandingParts - 1);
    if (output.allScheduled && output.outstandingParts === 0) {
      output.fullyParsed = true;
      this.commitParsedOutputs(attachment);
    }
  }

  private commitParsedOutputs(attachment: Attachment): void {
    while (!attachment.closed && attachment.pendingOutputs[0]?.fullyParsed) {
      const output = attachment.pendingOutputs.shift();
      if (!output) {
        break;
      }
      const currentSequence = attachment.sequence;
      if (
        currentSequence === null ||
        output.delta.fromSequence !== currentSequence
      ) {
        this.failSequenceGap(
          attachment,
          incrementUint64(currentSequence ?? uint64(0n)),
          output.delta.segments[0]?.sequence ?? output.delta.sequence,
          "parsed output completed outside mutation order"
        );
        return;
      }
      this.recordOutputParsed(attachment, output.delta.sequence);
      attachment.sequence = output.delta.sequence;
      if (
        attachment.preAttachSequence !== null &&
        attachment.sequence >= attachment.preAttachSequence
      ) {
        attachment.liveCaughtUp = true;
      }
      this.postClientMessage(attachment, {
        ...this.envelope(attachment),
        type: "credit",
        acknowledgedSequence: output.delta.sequence,
        bytes: output.delta.byteLength
      });
    }
    if (attachment.pendingOutputs.length === 0) {
      const waiters = attachment.outputBarrierWaiters.splice(0);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    }
    this.tryFinalizeSealedAttachment(attachment);
  }

  private waitForPendingOutputs(attachment: Attachment): Promise<void> {
    attachment.scheduler?.flush();
    if (attachment.pendingOutputs.length === 0 || attachment.closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      attachment.outputBarrierWaiters.push({ resolve, reject });
    });
  }

  private async applyExit(
    attachment: Attachment,
    message: Extract<TerminalDataPlaneHostMessage, { type: "exit" }>
  ): Promise<void> {
    await this.waitForPendingOutputs(attachment);
    if (attachment.closed) {
      return;
    }
    const currentSequence = attachment.sequence ?? uint64(0n);
    const expectedSequence = incrementUint64(currentSequence);
    if (message.sequence !== expectedSequence) {
      this.failSequenceGap(
        attachment,
        expectedSequence,
        message.sequence,
        "terminal exited at a sequence the renderer has not applied"
      );
      return;
    }
    attachment.sequence = message.sequence;
    await attachment.sink.exit(message);
    this.closeAttachment(attachment, "surface-closed", false);
  }

  private notifyInput(attachment: Attachment): void {
    if (!attachment.closed) {
      // Input itself still goes straight to the PTY. This flag gives the
      // surface one next parser quantum after its currently in-flight write.
      attachment.sinkPriorityPending = !this.cooperativeWrites.has(
        attachment.session.surfaceId
      );
      this.writeArbiter.prioritize(
        surfaceWriteLaneId(attachment.session.surfaceId)
      );
      attachment.scheduler?.notifyInput();
      this.scheduleSinkWrite(attachment);
    }
  }

  private recordOutputReceived(
    attachment: Attachment,
    delta: Extract<TerminalDelta, { type: "output" }>,
    portSentAt: number | undefined,
    portReceiveAt: number | undefined
  ): void {
    const metrics = attachment.metrics;
    if (!metrics) {
      return;
    }
    const receivedAt = portReceiveAt ?? metrics.now();
    if (attachment.liveCaughtUp && attachment.paintPendingSinceAt === null) {
      attachment.paintPendingSinceAt = receivedAt;
    }
    const telemetry = delta.segments
      .map((segment) => segment.telemetry)
      .filter((value) => value !== undefined);
    const inputTelemetry = telemetry.find(
      (value) =>
        value.inputAcceptedAt !== undefined && value.inputSequence !== undefined
    );
    attachment.outputMetricOrdinal += 1;
    if (
      !inputTelemetry &&
      (attachment.outputMetricOrdinal - 1) % attachment.metricsSampleEvery !== 0
    ) {
      return;
    }
    // A duplicate received while its original is still parsing must not
    // replace that original trace.
    if (attachment.outputMetrics.has(delta.sequence)) {
      return;
    }
    const trace: TerminalOutputMetricTrace = {
      sequence: delta.sequence,
      byteLength: delta.byteLength,
      ...(telemetry.length > 0
        ? {
            ptyReadAt: Math.min(...telemetry.map((value) => value.ptyReadAt)),
            headlessCommitAt: Math.max(
              ...telemetry.map((value) => value.headlessCommitAt)
            ),
            outputKinds: Array.from(
              new Set(
                telemetry.flatMap((value) =>
                  value.outputKind === undefined ? [] : [value.outputKind]
                )
              )
            ),
            visibleAtPtyRead:
              attachment.liveCaughtUp &&
              telemetry.every((value) => value.visibleAtPtyRead === true) &&
              delta.segments.every(
                (segment) =>
                  attachment.preAttachSequence === null ||
                  segment.sequence > attachment.preAttachSequence
              ),
            ...(inputTelemetry
              ? {
                  inputAcceptedAt: inputTelemetry.inputAcceptedAt,
                  inputSequence: inputTelemetry.inputSequence,
                  inputKind: inputTelemetry.inputKind
                }
              : {})
          }
        : {}),
      ...(portSentAt === undefined ? {} : { portSentAt }),
      portReceiveAt: receivedAt,
      presentationQueuedAt: receivedAt
    };
    attachment.outputMetrics.set(trace.sequence, trace);
    metrics.record(
      "terminal.data-plane.receive",
      this.metricDetails(attachment, trace)
    );
  }

  private recordOutputParsed(attachment: Attachment, sequence: Uint64): void {
    const metrics = attachment.metrics;
    const trace = attachment.outputMetrics.get(sequence);
    if (!metrics || !trace) {
      return;
    }
    attachment.outputMetrics.delete(sequence);
    trace.xtermParsedAt = metrics.now();
    if (attachment.pendingRenderMetrics.length >= MAX_PENDING_RENDER_METRICS) {
      const dropped = attachment.pendingRenderMetrics.shift();
      attachment.renderMetricOverflowCount += 1;
      if (dropped) {
        metrics.record("terminal.data-plane.render", {
          ...this.metricDetails(attachment, dropped),
          renderMetricDropped: true,
          renderMetricOverflowCount: attachment.renderMetricOverflowCount
        });
      }
    }
    attachment.pendingRenderMetrics.push(trace);
    metrics.record(
      "terminal.data-plane.parsed",
      this.metricDetails(attachment, trace)
    );
  }

  private notifyRendered(attachment: Attachment): void {
    const metrics = attachment.metrics;
    if (!metrics || attachment.closed) {
      return;
    }
    const onRenderAt = metrics.now();
    if (attachment.paintPendingSinceAt !== null) {
      const pendingIntervalStartedAt = Math.max(
        attachment.paintPendingSinceAt,
        attachment.lastOnRenderAt ?? attachment.paintPendingSinceAt
      );
      attachment.paintIntervalsMs.push(
        nonNegativeDurationMs(pendingIntervalStartedAt, onRenderAt) ?? 0
      );
      attachment.paintPendingSinceAt = null;
      if (attachment.paintIntervalsMs.length >= 16) {
        this.flushPaintIntervals(attachment, onRenderAt);
      }
    }
    attachment.lastOnRenderAt = onRenderAt;
    if (attachment.pendingRenderMetrics.length === 0) {
      return;
    }
    const traces = attachment.pendingRenderMetrics.splice(0);
    for (const trace of traces) {
      metrics.record("terminal.data-plane.render", {
        ...this.metricDetails(attachment, trace),
        onRenderAt,
        parsedToRenderMs: nonNegativeDurationMs(
          trace.xtermParsedAt,
          onRenderAt
        ),
        ptyReadToRenderMs: nonNegativeDurationMs(trace.ptyReadAt, onRenderAt),
        inputToRenderMs: nonNegativeDurationMs(
          trace.inputAcceptedAt,
          onRenderAt
        ),
        coalescedRenderSamples: traces.length,
        renderMetricOverflowCount: attachment.renderMetricOverflowCount
      });
    }
  }

  private flushPaintIntervals(
    attachment: Attachment,
    recordedAt: number | null = attachment.lastOnRenderAt
  ): void {
    if (!attachment.metrics || attachment.paintIntervalsMs.length === 0) {
      return;
    }
    attachment.metrics.record("terminal.data-plane.paint", {
      surfaceId: attachment.session.surfaceId,
      sessionId: attachment.session.sessionId,
      epoch: attachment.session.epoch,
      attachId: attachment.attachId,
      recordedAt,
      intervalsMs: attachment.paintIntervalsMs.splice(0)
    });
  }

  private metricDetails(
    attachment: Attachment,
    trace: TerminalOutputMetricTrace
  ): Record<string, unknown> {
    return {
      surfaceId: attachment.session.surfaceId,
      sessionId: attachment.session.sessionId,
      epoch: attachment.session.epoch,
      attachId: attachment.attachId,
      sequence: formatUint64Decimal(trace.sequence),
      byteLength: trace.byteLength,
      presentation: trace.presentation,
      immediateReason: trace.immediateReason,
      visibleAtPtyRead: trace.visibleAtPtyRead,
      inputAcceptedAt: trace.inputAcceptedAt,
      inputSequence:
        trace.inputSequence === undefined
          ? undefined
          : formatUint64Decimal(trace.inputSequence),
      inputKind: trace.inputKind,
      outputKinds: trace.outputKinds,
      ptyReadAt: trace.ptyReadAt,
      headlessCommitAt: trace.headlessCommitAt,
      portSentAt: trace.portSentAt,
      portReceiveAt: trace.portReceiveAt,
      presentationQueuedAt: trace.presentationQueuedAt,
      presentationReleasedAt: trace.presentationReleasedAt,
      presentationStartedAt: trace.presentationStartedAt,
      xtermParsedAt: trace.xtermParsedAt,
      schedulerDelayMs: nonNegativeDurationMs(
        trace.presentationQueuedAt,
        trace.presentationStartedAt
      ),
      schedulerAddedDelayMs:
        trace.presentation === "plain"
          ? nonNegativeDurationMs(
              trace.presentationQueuedAt,
              trace.presentationReleasedAt
            )
          : 0,
      presentationPacingMs: nonNegativeDurationMs(
        trace.presentationQueuedAt,
        trace.presentationReleasedAt
      ),
      arbiterWaitMs: nonNegativeDurationMs(
        trace.presentationReleasedAt,
        trace.presentationStartedAt
      ),
      ptyReadToHeadlessCommitMs: nonNegativeDurationMs(
        trace.ptyReadAt,
        trace.headlessCommitAt
      ),
      headlessCommitToPortReceiveMs: nonNegativeDurationMs(
        trace.headlessCommitAt,
        trace.portReceiveAt
      ),
      portTransferMs: nonNegativeDurationMs(
        trace.portSentAt,
        trace.portReceiveAt
      ),
      portReceiveToParsedMs: nonNegativeDurationMs(
        trace.portReceiveAt,
        trace.xtermParsedAt
      ),
      ptyReadToParsedMs: nonNegativeDurationMs(
        trace.ptyReadAt,
        trace.xtermParsedAt
      )
    };
  }

  private postClientMessage(
    attachment: Attachment,
    message: TerminalDataPlaneClientMessage
  ): void {
    if (attachment.closed || attachment.sealed || !this.isCurrent(attachment)) {
      return;
    }
    const validation = validateTerminalDataPlaneClientMessage(message, {
      attachId: attachment.attachId,
      session: attachment.session
    });
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    try {
      attachment.port.postMessage(validation.value);
    } catch (error) {
      this.failAttachment(attachment, {
        kind: "port-error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private failSequenceGap(
    attachment: Attachment,
    expectedSequence: Uint64,
    receivedSequence: Uint64,
    message: string
  ): void {
    this.failAttachment(attachment, {
      kind: "sequence-gap",
      expectedSequence,
      receivedSequence,
      message
    });
  }

  private failAttachment(
    attachment: Attachment,
    error: TerminalStreamRouterError
  ): void {
    if (attachment.closed) {
      return;
    }
    this.reportError(attachment, error);
    this.closeAttachment(attachment, "replaced", false);
  }

  private reportError(
    attachment: Attachment,
    error: TerminalStreamRouterError
  ): void {
    try {
      attachment.sink.reportError?.(error);
    } catch {
      // A diagnostics callback must not destabilize terminal stream cleanup.
    }
  }

  private isResumeSafe(attachment: Attachment): boolean {
    return (
      attachment.attached &&
      !attachment.sealed &&
      !attachment.closed &&
      attachment.checkpoint === null &&
      attachment.acceptedSequence === attachment.sequence &&
      attachment.pendingOutputs.length === 0 &&
      attachment.schedulerContexts.length === 0 &&
      !attachment.messages.some(
        (message) => message.type === "delta" && message.delta.type === "output"
      )
    );
  }

  private rejectOutputBarriers(attachment: Attachment, error: unknown): void {
    const waiters = attachment.outputBarrierWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private detachAttachment(
    attachment: Attachment,
    reason: TerminalDataPlaneDetachReason
  ): Promise<TerminalDetachOutcome> {
    if (attachment.detachSettlement) {
      return attachment.detachSettlement.promise;
    }
    if (attachment.closed) {
      return Promise.resolve({ kind: "discarded" });
    }

    let resolveSettlement!: (outcome: TerminalDetachOutcome) => void;
    const promise = new Promise<TerminalDetachOutcome>((resolve) => {
      resolveSettlement = resolve;
    });
    attachment.detachSettlement = {
      promise,
      resolve: resolveSettlement
    };

    const canSettle = reason === "hidden" || reason === "workspace-inactive";
    if (!canSettle) {
      this.closeAttachment(attachment, reason, true);
      return promise;
    }

    if (this.isCurrent(attachment)) {
      try {
        attachment.port.postMessage({
          ...this.envelope(attachment),
          type: "detach",
          reason
        } satisfies TerminalDataPlaneClientMessage);
      } catch {
        // The local parser can still settle even if the peer already closed.
      }
    }
    attachment.sealed = true;
    attachment.detachReason = reason;
    attachment.port.removeEventListener("message", attachment.onMessage);
    attachment.port.removeEventListener(
      "messageerror",
      attachment.onMessageError
    );
    try {
      attachment.port.close();
    } catch {
      // The transferred capability may already be closed by the host.
    }
    // A checkpoint that has not committed does not describe the cached xterm.
    // Cancel it instead of pairing an old widget with the new runtime epoch.
    if (
      attachment.checkpoint !== null ||
      !attachment.attached ||
      attachment.sequence === null
    ) {
      this.closeAttachment(attachment, reason, false);
      return promise;
    }

    attachment.scheduler?.flush();
    if (!attachment.draining && attachment.messages.length > 0) {
      this.scheduleDrain(attachment);
    } else {
      this.tryFinalizeSealedAttachment(attachment);
    }
    return promise;
  }

  private tryFinalizeSealedAttachment(attachment: Attachment): void {
    if (
      !attachment.sealed ||
      attachment.closed ||
      attachment.draining ||
      attachment.messages.length > 0 ||
      attachment.pendingOutputs.length > 0 ||
      attachment.schedulerContexts.length > 0
    ) {
      return;
    }
    if (
      !attachment.attached ||
      attachment.sequence === null ||
      attachment.acceptedSequence !== attachment.sequence
    ) {
      this.closeAttachment(
        attachment,
        attachment.detachReason ?? "hidden",
        false
      );
      return;
    }

    const reason = attachment.detachReason ?? "hidden";
    attachment.closed = true;
    const checkpoint = attachment.checkpoint;
    attachment.checkpoint = null;
    try {
      checkpoint?.hydration.cancel(
        new Error(
          `terminal checkpoint cancelled while stream closed (${reason})`
        )
      );
    } catch {
      // A staged widget cancellation cannot block capability teardown.
    }
    try {
      attachment.sink.detached?.(reason);
    } catch {
      // Settlement remains authoritative even if optional cleanup fails.
    }
    this.flushPaintIntervals(attachment);
    attachment.outputMetrics.clear();
    attachment.pendingRenderMetrics.length = 0;
    attachment.sinkPriorityPending = false;
    this.writeArbiter.cancel(surfaceWriteLaneId(attachment.session.surfaceId));
    attachment.scheduler?.dispose();
    attachment.scheduler = null;
    if (this.isCurrent(attachment)) {
      this.attachments.delete(attachment.session.surfaceId);
    }
    attachment.detachSettlement?.resolve({
      kind: "resumable",
      cursor: {
        session: attachment.session,
        sequence: attachment.sequence
      }
    });
  }

  private closeAttachment(
    attachment: Attachment,
    reason: TerminalDataPlaneDetachReason,
    notifyHost: boolean
  ): void {
    if (attachment.closed) {
      return;
    }
    if (notifyHost && this.isCurrent(attachment)) {
      try {
        attachment.port.postMessage({
          ...this.envelope(attachment),
          type: "detach",
          reason
        } satisfies TerminalDataPlaneClientMessage);
      } catch {
        // The port may already be gone; local cleanup still has to complete.
      }
    }
    attachment.closed = true;
    this.cooperativeWrites
      .get(attachment.session.surfaceId)
      ?.cancel(
        new Error(`terminal stream closed during cooperative write (${reason})`)
      );
    try {
      attachment.sink.detached?.(reason);
    } catch {
      // Cancellation cleanup cannot block capability teardown.
    }
    this.rejectOutputBarriers(
      attachment,
      new Error(`terminal stream detached while output was pending (${reason})`)
    );
    attachment.messages.length = 0;
    attachment.pendingOutputs.length = 0;
    attachment.schedulerContexts.length = 0;
    attachment.sinkWriteQueue.length = 0;
    attachment.sinkWriteCompletions.length = 0;
    attachment.sinkWriteInFlight = false;
    attachment.sinkPriorityPending = false;
    this.writeArbiter.cancel(surfaceWriteLaneId(attachment.session.surfaceId));
    this.flushPaintIntervals(attachment);
    attachment.outputMetrics.clear();
    attachment.pendingRenderMetrics.length = 0;
    attachment.scheduler?.dispose();
    attachment.scheduler = null;
    if (!attachment.sealed) {
      attachment.port.removeEventListener("message", attachment.onMessage);
      attachment.port.removeEventListener(
        "messageerror",
        attachment.onMessageError
      );
      try {
        attachment.port.close();
      } catch {
        // close is idempotent at the router boundary.
      }
    }
    if (this.isCurrent(attachment)) {
      this.attachments.delete(attachment.session.surfaceId);
    }
    attachment.detachSettlement?.resolve({ kind: "discarded" });
  }

  private isCurrent(attachment: Attachment): boolean {
    return this.attachments.get(attachment.session.surfaceId) === attachment;
  }

  private envelope(attachment: Attachment) {
    return {
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      attachId: attachment.attachId,
      session: attachment.session
    } as const;
  }
}

function splitUtf8Input(value: string): string[] {
  if (!value) {
    return [];
  }
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let offset = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (
      chunkBytes > 0 &&
      chunkBytes + characterBytes > TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
    ) {
      chunks.push(value.slice(chunkStart, offset));
      chunkStart = offset;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    offset += character.length;
  }
  chunks.push(value.slice(chunkStart));
  return chunks;
}

class ConservativeTerminalOutputClassifier {
  private state:
    | "ground"
    | "escape"
    | "csi"
    | "osc"
    | "string"
    | "osc-escape"
    | "string-escape" = "ground";

  classify(data: string): boolean {
    let plain = this.state === "ground";
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      switch (this.state) {
        case "ground":
          if (code === 0x1b) {
            this.state = "escape";
            plain = false;
          } else if (code === 0x9b) {
            this.state = "csi";
            plain = false;
          } else if (code === 0x9d) {
            this.state = "osc";
            plain = false;
          } else if (
            code === 0x90 ||
            code === 0x98 ||
            code === 0x9e ||
            code === 0x9f
          ) {
            this.state = "string";
            plain = false;
          } else if (code === 0x0d) {
            // A CRLF is an ordinary append newline. A bare CR can redraw the
            // current line (progress bars, prompts, TUIs), so keep that on the
            // immediate path. If CR/LF is split across deltas the CR remains
            // immediate because the classifier cannot safely predict it.
            if (data.charCodeAt(index + 1) !== 0x0a) {
              plain = false;
            }
          } else if (isUnsafePlainControl(code)) {
            plain = false;
          }
          break;
        case "escape":
          plain = false;
          if (code === 0x1b) {
            this.state = "escape";
          } else if (code === 0x5b) {
            this.state = "csi";
          } else if (code === 0x5d) {
            this.state = "osc";
          } else if (
            code === 0x50 ||
            code === 0x58 ||
            code === 0x5e ||
            code === 0x5f
          ) {
            this.state = "string";
          } else if (code < 0x20 || code > 0x2f) {
            this.state = "ground";
          }
          break;
        case "csi":
          plain = false;
          if (code === 0x1b) {
            this.state = "escape";
          } else if (code >= 0x40 && code <= 0x7e) {
            this.state = "ground";
          }
          break;
        case "osc":
          plain = false;
          if (code === 0x07 || code === 0x9c) {
            this.state = "ground";
          } else if (code === 0x1b) {
            this.state = "osc-escape";
          }
          break;
        case "string":
          plain = false;
          if (code === 0x9c) {
            this.state = "ground";
          } else if (code === 0x1b) {
            this.state = "string-escape";
          }
          break;
        case "osc-escape":
          plain = false;
          this.state =
            code === 0x5c ? "ground" : code === 0x1b ? "osc-escape" : "osc";
          break;
        case "string-escape":
          plain = false;
          this.state =
            code === 0x5c
              ? "ground"
              : code === 0x1b
                ? "string-escape"
                : "string";
          break;
      }
    }
    return plain && this.state === "ground";
  }

  reset(): void {
    this.state = "ground";
  }
}

function isUnsafePlainControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a) {
    return false;
  }
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function nextOutputCwdRunEnd(
  delta: Extract<TerminalDelta, { type: "output" }>,
  dataOffset: number
): number {
  let segmentEnd = 0;
  let runCwd: string | undefined;
  let found = false;
  for (const segment of delta.segments) {
    const segmentStart = segmentEnd;
    segmentEnd += segment.data.length;
    if (segment.data.length === 0) {
      continue;
    }
    if (!found) {
      if (segmentEnd > dataOffset) {
        found = true;
        runCwd = segment.cwd;
      }
      continue;
    }
    if (segment.cwd !== runCwd) {
      return segmentStart;
    }
  }
  if (found) {
    return segmentEnd;
  }
  throw new Error("terminal output offset is outside its source segments");
}

function sinkWriteCwd(write: PendingSinkWrite): string | undefined {
  let offset = 0;
  for (const segment of write.output.delta.segments) {
    const segmentEnd = offset + segment.data.length;
    if (write.dataOffset < segmentEnd) {
      return segment.cwd;
    }
    offset = segmentEnd;
  }
  return write.output.delta.segments.at(-1)?.cwd;
}

function surfaceWriteLaneId(surfaceId: string): string {
  return `surface:${surfaceId}`;
}

function avoidSplitSurrogatePair(
  data: string,
  start: number,
  requestedLength: number
): number {
  const end = start + requestedLength;
  if (
    requestedLength > 1 &&
    end < data.length &&
    isHighSurrogate(data.charCodeAt(end - 1)) &&
    isLowSurrogate(data.charCodeAt(end))
  ) {
    return requestedLength - 1;
  }
  return requestedLength;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isIdentifiablyStale(value: unknown, attachment: Attachment): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.attachId === "string" &&
    value.attachId !== attachment.attachId
  ) {
    return true;
  }
  if (!isRecord(value.session)) {
    return false;
  }
  const session = value.session;
  return (
    (typeof session.surfaceId === "string" &&
      session.surfaceId !== attachment.session.surfaceId) ||
    (typeof session.sessionId === "string" &&
      session.sessionId !== attachment.session.sessionId) ||
    (typeof session.epoch === "string" &&
      session.epoch !== attachment.session.epoch)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
