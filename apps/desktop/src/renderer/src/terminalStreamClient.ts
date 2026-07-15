import type { TerminalSessionRef } from "@kmux/proto";

import {
  KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
  type TerminalStreamAttachResult,
  type TerminalPortWindowMessage,
  type TerminalStreamGrant
} from "../../shared/terminalPort";
import { terminalDataPlaneNowMs } from "../../shared/terminalDataPlaneMetrics";
import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent,
  subscribeRendererDiagnosticsLogging
} from "./smoothnessProfile";
import {
  type CooperativeTerminalWriteTask,
  TerminalStreamRouter,
  type RegisterTerminalStreamOptions,
  type TerminalDetachOutcome,
  type TerminalStreamPort,
  type TerminalStreamRegistration,
  type TerminalStreamSink
} from "./terminalStreamRouter";

const PORT_TRANSFER_TIMEOUT_MS = 2_000;
const ATTACH_RETRY_DELAYS_MS = [50, 150, 400, 1_000] as const;
const FORGOTTEN_SURFACE_TOMBSTONE_LIMIT = 4_096;
const TERMINAL_OUTPUT_PROFILE_SAMPLE_EVERY = 8;
export const TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES = 1024 * 1024;

interface PendingTerminalInput {
  kind: "text" | "binary";
  data: string;
}

/**
 * Keeps input on the v2 capability path while a renderer waits for its port.
 * The component owns one instance and discards it on unmount/attach failure.
 */
export class TerminalStreamPendingInputBuffer {
  private surfaceId: string | null = null;
  private sessionId: string | null = null;
  private pendingBytes = 0;
  private readonly entries: PendingTerminalInput[] = [];

  get byteLength(): number {
    return this.pendingBytes;
  }

  enqueueText(surfaceId: string, sessionId: string, text: string): boolean {
    return this.enqueue(surfaceId, sessionId, "text", text, utf8Bytes(text));
  }

  enqueueBinary(surfaceId: string, sessionId: string, data: string): boolean {
    return this.enqueue(surfaceId, sessionId, "binary", data, data.length);
  }

  flush(stream: AttachedTerminalStream): void {
    const { surfaceId, sessionId } = stream.grant.session;
    if (this.surfaceId !== surfaceId || this.sessionId !== sessionId) {
      this.discard();
      return;
    }
    const entries = this.entries.splice(0);
    this.pendingBytes = 0;
    for (const entry of entries) {
      if (entry.kind === "text") {
        stream.registration.sendText(entry.data);
      } else {
        stream.registration.sendBinary(entry.data);
      }
    }
  }

  discard(): void {
    this.surfaceId = null;
    this.sessionId = null;
    this.pendingBytes = 0;
    this.entries.length = 0;
  }

  private enqueue(
    surfaceId: string,
    sessionId: string,
    kind: PendingTerminalInput["kind"],
    data: string,
    byteLength: number
  ): boolean {
    if (!data) {
      return true;
    }
    if (this.surfaceId !== surfaceId || this.sessionId !== sessionId) {
      this.discard();
      this.surfaceId = surfaceId;
      this.sessionId = sessionId;
    }
    if (
      byteLength > TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES ||
      this.pendingBytes + byteLength > TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES
    ) {
      return false;
    }
    this.entries.push({ kind, data });
    this.pendingBytes += byteLength;
    return true;
  }
}

const inputEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return inputEncoder.encode(value).byteLength;
}

interface PendingPort {
  grant: TerminalStreamGrant;
  port: TerminalStreamPort;
  timeout: ReturnType<typeof setTimeout>;
}

interface PortWaiter {
  grant: TerminalStreamGrant;
  resolve: (port: TerminalStreamPort | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface ActiveStream {
  stream: AttachedTerminalStream;
  expectedSessionId: string;
  claims: number;
  releaseVersion: number;
  invalidateResume: (() => void) | undefined;
}

interface PendingAttach {
  expectedSessionId: string;
  generation: number;
  promise: Promise<TerminalStreamAttachOutcome>;
}

interface PendingResumeSettle {
  expectedSessionId: string;
  generation: number;
  promise: Promise<void>;
  invalidateResume: (() => void) | undefined;
  cancelled: boolean;
}

interface ResumableCursor {
  session: TerminalSessionRef;
  sequence: number;
}

export interface AttachTerminalStreamOptions {
  surfaceId: string;
  expectedSessionId: string;
  sink: TerminalStreamSink;
  /** Read lazily after an in-flight hidden detach has reached its parser barrier. */
  resumeFromSequence?: number | (() => number | undefined);
  shouldWriteImmediately?: () => boolean;
  writeScheduler?: RegisterTerminalStreamOptions["writeScheduler"];
  invalidateResume?: () => void;
  signal?: AbortSignal;
}

export interface AttachedTerminalStream {
  grant: TerminalStreamGrant;
  registration: TerminalStreamRegistration;
}

export type TerminalStreamAttachOutcome =
  | { status: "attached"; stream: AttachedTerminalStream }
  | { status: "retryable-not-ready" }
  | { status: "denied" }
  | { status: "cancelled" };

export interface TerminalStreamClientOptions {
  portTransferTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

function sameSession(
  left: TerminalSessionRef,
  right: TerminalSessionRef
): boolean {
  return (
    left.surfaceId === right.surfaceId &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch
  );
}

function isGrant(value: unknown): value is TerminalStreamGrant {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TerminalStreamGrant>;
  return (
    typeof candidate.attachId === "string" &&
    typeof candidate.session?.surfaceId === "string" &&
    typeof candidate.session.sessionId === "string" &&
    typeof candidate.session.epoch === "string"
  );
}

function isAttachResult(value: unknown): value is TerminalStreamAttachResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TerminalStreamAttachResult>;
  if (candidate.status === "granted") {
    return isGrant(candidate.grant);
  }
  return (
    (candidate.status === "retryable-not-ready" ||
      candidate.status === "denied") &&
    typeof candidate.reason === "string"
  );
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (delayMs <= 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Owns the one renderer-wide port transfer listener and terminal router. */
export class TerminalStreamClient {
  private readonly pendingPorts = new Map<string, PendingPort>();
  private readonly waiters = new Map<string, PortWaiter>();
  private readonly resumableCursors = new Map<string, ResumableCursor>();
  private readonly activeStreams = new Map<string, ActiveStream>();
  private readonly pendingAttaches = new Map<string, PendingAttach>();
  private readonly pendingResumeSettles = new Map<
    string,
    PendingResumeSettle
  >();
  private nextAttachGeneration = 0;
  private nextResumeSettleGeneration = 0;
  private readonly forgottenSurfaces = new Set<string>();
  private listening = false;
  private disposed = false;
  private readonly portTransferTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly unsubscribeDiagnosticsLogging: () => void;

  constructor(
    private readonly router = new TerminalStreamRouter(),
    private readonly targetWindow: Window = window,
    options: TerminalStreamClientOptions = {}
  ) {
    this.portTransferTimeoutMs = Math.max(
      1,
      options.portTransferTimeoutMs ?? PORT_TRANSFER_TIMEOUT_MS
    );
    this.retryDelaysMs = options.retryDelaysMs ?? ATTACH_RETRY_DELAYS_MS;
    this.unsubscribeDiagnosticsLogging = subscribeRendererDiagnosticsLogging(
      () => {
        const metricsEnabled = isRendererSmoothnessProfileEnabled();
        this.router.configureMetrics(
          metricsEnabled
            ? {
                now: () => terminalDataPlaneNowMs(performance),
                record: recordRendererSmoothnessProfileEvent
              }
            : undefined,
          TERMINAL_OUTPUT_PROFILE_SAMPLE_EVERY
        );
      }
    );
  }

  beginCooperativeWrite(
    laneId: string,
    data: string,
    write: (chunk: string, onParsed: () => void) => void
  ): CooperativeTerminalWriteTask {
    return this.router.beginCooperativeWrite(laneId, data, write);
  }

  async attach(
    options: AttachTerminalStreamOptions
  ): Promise<AttachedTerminalStream | null> {
    const result = await this.attachAttempt(options);
    return result.status === "attached" ? result.stream : null;
  }

  async attachWithRetry(
    options: AttachTerminalStreamOptions
  ): Promise<AttachedTerminalStream | null> {
    const result = await this.attachWithRetryOutcome(options);
    return result.status === "attached" ? result.stream : null;
  }

  async attachWithRetryOutcome(
    options: AttachTerminalStreamOptions
  ): Promise<TerminalStreamAttachOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.attachAttempt(options);
      if (result.status === "attached") {
        return result;
      }
      if (
        result.status !== "retryable-not-ready" ||
        attempt >= this.retryDelaysMs.length
      ) {
        return result;
      }
      if (!(await waitForRetry(this.retryDelaysMs[attempt]!, options.signal))) {
        return { status: "cancelled" };
      }
    }
  }

  private async attachAttempt(
    options: AttachTerminalStreamOptions
  ): Promise<TerminalStreamAttachOutcome> {
    if (
      options.signal?.aborted ||
      this.disposed ||
      this.forgottenSurfaces.has(options.surfaceId)
    ) {
      return { status: "cancelled" };
    }
    const pendingResumeSettle = this.pendingResumeSettles.get(
      options.surfaceId
    );
    if (pendingResumeSettle) {
      if (pendingResumeSettle.expectedSessionId !== options.expectedSessionId) {
        pendingResumeSettle.cancelled = true;
        this.invalidateResume(
          options.surfaceId,
          pendingResumeSettle.invalidateResume
        );
        await pendingResumeSettle.promise;
        // Old parser callbacks precede the settle barrier. Clear hydration a
        // second time so they cannot seed the next runtime epoch.
        this.invalidateResume(
          options.surfaceId,
          pendingResumeSettle.invalidateResume
        );
      } else {
        await pendingResumeSettle.promise;
      }
      if (
        options.signal?.aborted ||
        this.disposed ||
        this.forgottenSurfaces.has(options.surfaceId)
      ) {
        return { status: "cancelled" };
      }
    }
    const active = this.activeStreams.get(options.surfaceId);
    if (
      active?.expectedSessionId === options.expectedSessionId &&
      !active.stream.registration.closed
    ) {
      active.stream.registration.replaceSink(
        options.sink,
        options.shouldWriteImmediately
      );
      active.stream.registration.setPresentationImmediate(false);
      active.claims += 1;
      active.releaseVersion += 1;
      active.invalidateResume = options.invalidateResume;
      return { status: "attached", stream: active.stream };
    }
    if (active) {
      void this.closeActive(active, "replaced");
    }
    let pending = this.pendingAttaches.get(options.surfaceId);
    if (!pending || pending.expectedSessionId !== options.expectedSessionId) {
      const generation = ++this.nextAttachGeneration;
      const attachPromise = this.open(options, generation);
      pending = {
        expectedSessionId: options.expectedSessionId,
        generation,
        promise: attachPromise
      };
      this.pendingAttaches.set(options.surfaceId, pending);
      const clearPending = (): void => {
        const current = this.pendingAttaches.get(options.surfaceId);
        if (current?.generation === generation) {
          this.pendingAttaches.delete(options.surfaceId);
        }
      };
      void attachPromise.then(clearPending, clearPending);
    }

    const result = await pending.promise;
    if (result.status !== "attached") {
      // A shared pending request is opened by its first pane owner. If that
      // owner unmounts during a same-session handoff, only its caller should
      // observe cancellation; a still-live claimant must retry with its own
      // signal instead of becoming permanently blank.
      if (
        result.status === "cancelled" &&
        !options.signal?.aborted &&
        !this.disposed &&
        !this.forgottenSurfaces.has(options.surfaceId)
      ) {
        const currentPending = this.pendingAttaches.get(options.surfaceId);
        if (currentPending?.generation === pending.generation) {
          this.pendingAttaches.delete(options.surfaceId);
        }
        return { status: "retryable-not-ready" };
      }
      return result;
    }
    const stream = result.stream;
    if (
      options.signal?.aborted ||
      this.disposed ||
      this.forgottenSurfaces.has(options.surfaceId)
    ) {
      if (!stream.registration.closed) {
        stream.registration.detach("renderer-reload");
      }
      return { status: "cancelled" };
    }
    if (stream.registration.closed) {
      const currentPending = this.pendingAttaches.get(options.surfaceId);
      if (currentPending?.generation === pending.generation) {
        this.pendingAttaches.delete(options.surfaceId);
      }
      return { status: "retryable-not-ready" };
    }
    const current = this.activeStreams.get(options.surfaceId);
    if (current?.stream === stream) {
      current.stream.registration.replaceSink(
        options.sink,
        options.shouldWriteImmediately
      );
      current.stream.registration.setPresentationImmediate(false);
      current.claims += 1;
      current.releaseVersion += 1;
      current.invalidateResume = options.invalidateResume;
      return { status: "attached", stream };
    }
    if (current) {
      void this.closeActive(current, "replaced");
    }
    this.activeStreams.set(options.surfaceId, {
      stream,
      expectedSessionId: options.expectedSessionId,
      claims: 1,
      releaseVersion: 0,
      invalidateResume: options.invalidateResume
    });
    return { status: "attached", stream };
  }

  private async open(
    options: AttachTerminalStreamOptions,
    generation: number
  ): Promise<TerminalStreamAttachOutcome> {
    const request = this.targetWindow.kmux.attachTerminalStream;
    if (!request) {
      return { status: "denied" };
    }
    this.ensureListening();
    let requestResult: TerminalStreamAttachResult | null;
    try {
      requestResult = await request(
        options.surfaceId,
        options.expectedSessionId
      );
    } catch {
      requestResult = null;
    }
    if (options.signal?.aborted) {
      return { status: "cancelled" };
    }
    // A transient IPC failure is bounded by attachWithRetry.
    if (requestResult === null) {
      return { status: "retryable-not-ready" };
    }
    if (!isAttachResult(requestResult)) {
      return { status: "denied" };
    }
    if (requestResult.status !== "granted") {
      return { status: requestResult.status };
    }
    const grant = requestResult.grant;
    const port = await this.takeOrWaitForPort(grant, options.signal);
    if (!port) {
      return options.signal?.aborted
        ? { status: "cancelled" }
        : { status: "retryable-not-ready" };
    }
    const currentPending = this.pendingAttaches.get(options.surfaceId);
    if (
      this.disposed ||
      options.signal?.aborted ||
      currentPending?.generation !== generation ||
      currentPending.expectedSessionId !== options.expectedSessionId ||
      grant.session.surfaceId !== options.surfaceId ||
      grant.session.sessionId !== options.expectedSessionId
    ) {
      port.close();
      return { status: "cancelled" };
    }

    const priorCursor = this.resumableCursors.get(options.surfaceId);
    const resumeFromSequence =
      typeof options.resumeFromSequence === "function"
        ? options.resumeFromSequence()
        : options.resumeFromSequence;
    const canResume =
      resumeFromSequence !== undefined &&
      priorCursor !== undefined &&
      resumeFromSequence === priorCursor.sequence &&
      sameSession(priorCursor.session, grant.session);
    const registration = this.router.register({
      port,
      attachId: grant.attachId,
      session: grant.session,
      sink: options.sink,
      ...(canResume ? { resumeFromSequence } : {}),
      writeScheduler: options.writeScheduler ?? {},
      shouldWriteImmediately: options.shouldWriteImmediately,
      ...(isRendererSmoothnessProfileEnabled()
        ? {
            metrics: {
              now: () => terminalDataPlaneNowMs(performance),
              record: recordRendererSmoothnessProfileEvent
            },
            metricsSampleEvery: TERMINAL_OUTPUT_PROFILE_SAMPLE_EVERY
          }
        : {})
    });
    recordRendererSmoothnessProfileEvent("terminal.data-plane.attach", {
      surfaceId: options.surfaceId,
      sessionId: grant.session.sessionId,
      epoch: grant.session.epoch,
      attachId: grant.attachId,
      mode: canResume ? "resume" : "checkpoint",
      resumeFromSequence: canResume ? resumeFromSequence : null,
      candidateSequence: resumeFromSequence ?? null,
      cursorSequence: priorCursor?.sequence ?? null,
      hadPriorSession: priorCursor !== undefined,
      sameEpoch: priorCursor
        ? sameSession(priorCursor.session, grant.session)
        : false
    });
    if (!canResume) {
      this.resumableCursors.delete(options.surfaceId);
    }
    return { status: "attached", stream: { grant, registration } };
  }

  detach(
    stream: AttachedTerminalStream,
    reason: Parameters<TerminalStreamRegistration["detach"]>[0] = "hidden"
  ): Promise<void> {
    const active = this.activeStreams.get(stream.grant.session.surfaceId);
    if (active?.stream !== stream) {
      return Promise.resolve();
    }
    active.claims = Math.max(0, active.claims - 1);
    active.releaseVersion += 1;
    const releaseVersion = active.releaseVersion;
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const current = this.activeStreams.get(stream.grant.session.surfaceId);
        if (
          current !== active ||
          current.claims !== 0 ||
          current.releaseVersion !== releaseVersion
        ) {
          resolve();
          return;
        }
        void this.closeActive(current, reason).then(resolve);
      });
    });
  }

  private closeActive(
    active: ActiveStream,
    reason: Parameters<TerminalStreamRegistration["detach"]>[0]
  ): Promise<void> {
    const surfaceId = active.stream.grant.session.surfaceId;
    const outcome = active.stream.registration.detach(reason);
    let settled: Promise<void>;
    if (reason === "hidden" || reason === "workspace-inactive") {
      settled = this.beginPendingResumeSettle(active, outcome);
    } else {
      this.invalidateResume(surfaceId, active.invalidateResume);
      settled = outcome.then(() => undefined);
    }
    if (
      this.activeStreams.get(active.stream.grant.session.surfaceId) === active
    ) {
      this.activeStreams.delete(active.stream.grant.session.surfaceId);
    }
    return settled;
  }

  private beginPendingResumeSettle(
    active: ActiveStream,
    resumeSettled: Promise<TerminalDetachOutcome>
  ): Promise<void> {
    const surfaceId = active.stream.grant.session.surfaceId;
    this.cancelPendingResumeSettle(surfaceId, true);
    const generation = ++this.nextResumeSettleGeneration;
    const startedAt = performance.now();
    const promise = resumeSettled
      .catch(() => ({ kind: "discarded" }) as TerminalDetachOutcome)
      .then((result) => {
        const pending = this.pendingResumeSettles.get(surfaceId);
        if (pending?.generation !== generation) {
          recordRendererSmoothnessProfileEvent(
            "terminal.data-plane.resume-settle",
            {
              surfaceId,
              sessionId: active.stream.grant.session.sessionId,
              epoch: active.stream.grant.session.epoch,
              outcome: "superseded",
              durationMs: performance.now() - startedAt
            }
          );
          return;
        }
        this.pendingResumeSettles.delete(surfaceId);
        if (pending.cancelled) {
          recordRendererSmoothnessProfileEvent(
            "terminal.data-plane.resume-settle",
            {
              surfaceId,
              sessionId: active.stream.grant.session.sessionId,
              epoch: active.stream.grant.session.epoch,
              outcome: "cancelled",
              durationMs: performance.now() - startedAt
            }
          );
          return;
        }
        recordRendererSmoothnessProfileEvent(
          "terminal.data-plane.resume-settle",
          {
            surfaceId,
            sessionId: active.stream.grant.session.sessionId,
            epoch: active.stream.grant.session.epoch,
            outcome: result.kind,
            sequence:
              result.kind === "resumable" ? result.cursor.sequence : null,
            durationMs: performance.now() - startedAt
          }
        );
        if (result.kind !== "resumable" || this.disposed) {
          this.invalidateResume(surfaceId, pending.invalidateResume);
          return;
        }
        this.resumableCursors.set(surfaceId, {
          session: result.cursor.session,
          sequence: result.cursor.sequence
        });
      });
    this.pendingResumeSettles.set(surfaceId, {
      expectedSessionId: active.expectedSessionId,
      generation,
      promise,
      invalidateResume: active.invalidateResume,
      cancelled: false
    });
    return promise;
  }

  private cancelPendingResumeSettle(
    surfaceId: string,
    invalidate: boolean
  ): void {
    const pending = this.pendingResumeSettles.get(surfaceId);
    if (!pending) {
      return;
    }
    this.pendingResumeSettles.delete(surfaceId);
    if (invalidate) {
      this.invalidateResume(surfaceId, pending.invalidateResume);
    }
  }

  private invalidateResume(
    surfaceId: string,
    invalidateResume: (() => void) | undefined
  ): void {
    this.resumableCursors.delete(surfaceId);
    try {
      invalidateResume?.();
    } catch {
      // Cache invalidation is advisory cleanup and must not block detach.
    }
  }

  /** Permanently drops every live, pending, and resumable capability. */
  forgetSurface(surfaceId: string): void {
    this.forgottenSurfaces.add(surfaceId);
    while (this.forgottenSurfaces.size > FORGOTTEN_SURFACE_TOMBSTONE_LIMIT) {
      const oldest = this.forgottenSurfaces.values().next().value as
        | string
        | undefined;
      if (!oldest) {
        break;
      }
      this.forgottenSurfaces.delete(oldest);
    }
    this.cancelPendingResumeSettle(surfaceId, true);
    const active = this.activeStreams.get(surfaceId);
    if (active) {
      void this.closeActive(active, "surface-closed");
    }
    this.resumableCursors.delete(surfaceId);
    this.pendingAttaches.delete(surfaceId);
    for (const [attachId, pending] of this.pendingPorts) {
      if (pending.grant.session.surfaceId !== surfaceId) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.port.close();
      this.pendingPorts.delete(attachId);
    }
    for (const [attachId, waiter] of this.waiters) {
      if (waiter.grant.session.surfaceId !== surfaceId) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.removeAbortListener?.();
      waiter.resolve(null);
      this.waiters.delete(attachId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeDiagnosticsLogging();
    this.pendingAttaches.clear();
    for (const surfaceId of [...this.pendingResumeSettles.keys()]) {
      this.cancelPendingResumeSettle(surfaceId, true);
    }
    for (const active of [...this.activeStreams.values()]) {
      void this.closeActive(active, "renderer-reload");
    }
    this.router.dispose();
    for (const pending of this.pendingPorts.values()) {
      clearTimeout(pending.timeout);
      pending.port.close();
    }
    this.pendingPorts.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.removeAbortListener?.();
      waiter.resolve(null);
    }
    this.waiters.clear();
    if (this.listening) {
      this.targetWindow.removeEventListener("message", this.onWindowMessage);
      this.listening = false;
    }
  }

  private ensureListening(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.targetWindow.addEventListener("message", this.onWindowMessage);
  }

  private readonly onWindowMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.targetWindow) {
      return;
    }
    const payload = event.data as Partial<TerminalPortWindowMessage> | null;
    if (
      !payload ||
      payload.type !== KMUX_TERMINAL_PORT_WINDOW_MESSAGE ||
      !isGrant(payload.grant)
    ) {
      return;
    }
    const port = event.ports[0] as TerminalStreamPort | undefined;
    if (!port) {
      return;
    }
    const grant = payload.grant;
    const waiter = this.waiters.get(grant.attachId);
    if (waiter) {
      this.waiters.delete(grant.attachId);
      clearTimeout(waiter.timeout);
      waiter.removeAbortListener?.();
      if (sameSession(waiter.grant.session, grant.session)) {
        waiter.resolve(port);
      } else {
        port.close();
        waiter.resolve(null);
      }
      return;
    }

    const previous = this.pendingPorts.get(grant.attachId);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.port.close();
    }
    const timeout = setTimeout(() => {
      const pending = this.pendingPorts.get(grant.attachId);
      if (pending?.port !== port) {
        return;
      }
      this.pendingPorts.delete(grant.attachId);
      port.close();
    }, this.portTransferTimeoutMs);
    this.pendingPorts.set(grant.attachId, { grant, port, timeout });
  };

  private takeOrWaitForPort(
    grant: TerminalStreamGrant,
    signal?: AbortSignal
  ): Promise<TerminalStreamPort | null> {
    if (signal?.aborted) {
      return Promise.resolve(null);
    }
    const pending = this.pendingPorts.get(grant.attachId);
    if (pending) {
      this.pendingPorts.delete(grant.attachId);
      clearTimeout(pending.timeout);
      if (sameSession(pending.grant.session, grant.session)) {
        return Promise.resolve(pending.port);
      }
      pending.port.close();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const previous = this.waiters.get(grant.attachId);
      if (previous) {
        clearTimeout(previous.timeout);
        previous.removeAbortListener?.();
        previous.resolve(null);
      }
      const timeout = setTimeout(() => {
        const waiter = this.waiters.get(grant.attachId);
        if (waiter?.resolve === resolve) {
          this.waiters.delete(grant.attachId);
          waiter.removeAbortListener?.();
          resolve(null);
        }
      }, this.portTransferTimeoutMs);
      const waiter: PortWaiter = { grant, resolve, timeout };
      this.waiters.set(grant.attachId, waiter);
      if (signal) {
        const onAbort = (): void => {
          const current = this.waiters.get(grant.attachId);
          if (current?.resolve !== resolve) {
            return;
          }
          this.waiters.delete(grant.attachId);
          clearTimeout(current.timeout);
          current.removeAbortListener?.();
          resolve(null);
        };
        waiter.removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }
    });
  }
}

export const terminalStreamClient = new TerminalStreamClient();
