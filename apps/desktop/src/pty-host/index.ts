import type {
  ITerminalInitOnlyOptions as HeadlessTerminalInitOptions,
  ITerminalOptions as HeadlessTerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";
import * as Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  Id,
  SurfaceSnapshotPayload,
  TerminalCheckpoint,
  TerminalDelta,
  TerminalSessionRef
} from "@kmux/proto";
import { TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES } from "@kmux/proto";
import type { PtyEvent, PtyRequest } from "../shared/ptyProtocol";
import type * as PtyModule from "node-pty";
import { loadNodePty } from "./nodePtyLoader";
import { encodeTerminalKeyInput } from "./terminalInput";
import {
  buildOsc9Notification,
  buildOsc777Notification,
  parseOsc99Notification,
  type Osc99NotificationState
} from "./terminalNotifications";
import { isTerminalMetadataWithinProtocolLimit, resolveOsc7Cwd } from "./osc7";
import { SHELL_READY_OSC } from "./shellIntegration";
import {
  armShellReadyFallback,
  disposeShellReadyFallback,
  isShellReadyOscPayload,
  markShellInputReady
} from "./shellInputReady";
import { resolvePtySpawnLaunch } from "./ptySpawnLaunch";
import { PTY_STDOUT_LOGS_ENV, logDiagnostics } from "../shared/diagnostics";
import {
  TERMINAL_LIVE_SCROLLBACK_LINES,
  TERMINAL_RESTORE_SCROLLBACK_LINES
} from "../shared/terminalConfig";
import {
  createNodeSmoothnessProfileRecorder,
  profileNowMs
} from "../shared/nodeSmoothnessProfile";
import { createSmoothnessProfileBucket } from "../shared/smoothnessProfileBucket";
import { terminalDataPlaneNowMs } from "../shared/terminalDataPlaneMetrics";
import { createRawTerminalEventStdoutLogger } from "./rawTerminalStdoutLog";
import { resolveRawOutputHistoryDir } from "./rawOutputHistoryPath";
import {
  createPtyResizeCoalescer,
  type PtyResizeCoalescer
} from "./ptyResizeCoalescer";
import { prepareTerminalResize } from "./resizeRuntime";
import { FairSessionScheduler } from "./fairSessionScheduler";
import { SessionMutationQueue } from "./sessionMutationQueue";
import { SnapshotCache } from "./snapshotCache";
import { TerminalDeltaStore } from "./terminalDeltaStore";
import { createTerminalDataPlaneSupervisorMetrics } from "./terminalDataPlaneSupervisorMetrics";
import {
  TerminalSessionStream,
  type TerminalDataPortLike
} from "./terminalSessionStream";
import {
  createTerminalCwdRangeSnapshotWindow,
  createTerminalCwdRangeTracker
} from "./terminalCwdRanges";
import {
  flushTerminalOutputSegmenterState,
  splitTerminalOutputByOsc7,
  type TerminalOutputSegmenterState
} from "./terminalOutputSegments";
import { createUtilityProcessControlTransport } from "./utilityProcessTransport";
import {
  coalesceTerminalOutputForWire,
  splitTerminalOutputText,
  terminalDeltaRetainedBytes,
  TERMINAL_OUTPUT_SEGMENT_MAX_BYTES
} from "./terminalWireCoalescing";
import { createTerminalQueryReplyHandler } from "./terminalQueryReply";

let cachedPty: typeof PtyModule | null = null;

function resolvePtyModule(): typeof PtyModule {
  if (!cachedPty) {
    cachedPty = loadNodePty();
  }
  return cachedPty;
}

const HeadlessTerminalCtor = (
  Headless as unknown as {
    Terminal: new (
      options?: HeadlessTerminalOptions & HeadlessTerminalInitOptions
    ) => HeadlessTerminal;
  }
).Terminal;

interface SessionRuntime {
  sessionId: Id;
  surfaceId: Id;
  runtimeEpoch: Id;
  cwd?: string;
  title: string;
  pty: PtyModule.IPty;
  ptyResize: PtyResizeCoalescer;
  terminal: HeadlessTerminal;
  queryReplyListener: DisposableLike;
  serialize: SerializeAddon;
  snapshotCache: SnapshotCache;
  cwdRanges: ReturnType<typeof createTerminalCwdRangeTracker>;
  trimListener: DisposableLike;
  mutationQueue: SessionMutationQueue<QueuedOutputSegment>;
  stream: TerminalSessionStream;
  pendingDirectInputs: Array<string | Buffer>;
  pendingDirectInputBytes: number;
  inputTelemetrySequence: number;
  pendingInputTelemetry?: {
    inputAcceptedAt: number;
    inputSequence: number;
  };
  outputSegmenterState: TerminalOutputSegmenterState;
  rawOutputTail: string;
  rawOutputTailTruncated: boolean;
  rawOutputLogPath?: string;
  rawOutputIndexPath?: string;
  rawOutputLogBytes: number;
  rawOutputLogChars: number;
  rawOutputLogChunks: number;
  inFlightOutputRuns: number;
  disposeTerminalWhenIdle: boolean;
  sequence: number;
  parsedSequence: number;
  cols: number;
  rows: number;
  osc99State: Osc99NotificationState;
  shellInputReady: boolean;
  pendingInitialInput?: string;
  shellReadyFallbackTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  pendingSettledSnapshots: Array<{
    requestId: Id;
    settleForMs: number;
    includeRawOutputTail: boolean;
  }>;
  settledSnapshotTimer: NodeJS.Timeout | null;
  closing: boolean;
  exited: boolean;
  exitCode?: number;
}

interface QueuedOutputSegment {
  chunk: string;
  recordCwd: boolean;
  telemetry?: {
    ptyReadAt: number;
    visibleAtPtyRead: boolean;
    inputAcceptedAt?: number;
    inputSequence?: number;
  };
}

interface DisposableLike {
  dispose(): void;
}

const sessions = new Map<Id, SessionRuntime>();
const logRawTerminalEvent = createRawTerminalEventStdoutLogger();
const smoothnessProfile = createNodeSmoothnessProfileRecorder(process.env);
const controlTransport = createUtilityProcessControlTransport();
let ipcChannelClosed = false;
let shutdownRequested = false;
const PROFILE_PTY_BUCKET_MIN_CHUNKS = 100;
const PROFILE_PTY_BUCKET_MAX_DURATION_MS = 1000;
const SESSION_OUTPUT_SLICE_BYTES = TERMINAL_OUTPUT_SEGMENT_MAX_BYTES;
const SESSION_OUTPUT_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;
const SESSION_OUTPUT_LOW_WATERMARK_BYTES = 1 * 1024 * 1024;
const SESSION_DELTA_RING_BYTES = 2 * 1024 * 1024;
const SESSION_DELTA_RING_EVENTS = 2_048;
const SUPERVISOR_DELTA_RING_BYTES = 64 * 1024 * 1024;
const SUPERVISOR_DELTA_RING_EVENTS = 65_536;
const PENDING_DIRECT_INPUT_MAX_BYTES = 1 * 1024 * 1024;
const RAW_OUTPUT_TAIL_MAX_CHARS = 128 * 1024;
const RAW_OUTPUT_HISTORY_ENABLED = process.env[PTY_STDOUT_LOGS_ENV] === "1";
const deltaStore = new TerminalDeltaStore<TerminalDelta>({
  maxSessionBytes: SESSION_DELTA_RING_BYTES,
  maxSessionEvents: SESSION_DELTA_RING_EVENTS,
  maxTotalBytes: SUPERVISOR_DELTA_RING_BYTES,
  maxTotalEvents: SUPERVISOR_DELTA_RING_EVENTS,
  rangeOf: (delta) => ({
    fromSequence:
      delta.type === "output" ? delta.fromSequence : delta.sequence - 1,
    sequence: delta.sequence
  }),
  sizeOf: terminalDeltaRetainedBytes,
  replaySizeOf: (delta) => (delta.type === "output" ? delta.byteLength : 0)
});
const dataPlaneSupervisorMetrics = createTerminalDataPlaneSupervisorMetrics({
  recorder: smoothnessProfile,
  now: profileNowMs,
  readSessions: () =>
    [...sessions.values()].map((record) => ({
      queue: record.mutationQueue.stats(),
      ring: deltaStore.sessionStats(record.sessionId),
      stream: record.stream.stats()
    })),
  readRing: () => deltaStore.stats()
});
const sessionScheduler = new FairSessionScheduler({
  schedule: (callback) => setImmediate(callback),
  onDrainError: (sessionId, error) => {
    const record = sessions.get(sessionId);
    logDiagnostics("pty-host.session.mutation.failed", {
      sessionId,
      surfaceId: record?.surfaceId,
      error: error instanceof Error ? error.message : String(error)
    });
    send({
      type: "error",
      sessionId,
      message: `terminal mutation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
    try {
      record?.pty.kill();
    } catch {
      // The PTY may already have exited after the failed mutation.
    }
  }
});
const ptyBucket = createSmoothnessProfileBucket<{
  surfaceId: Id;
  sessionId: Id;
  startedAt: number;
  chunks: number;
  bytes: number;
  maxChunkBytes: number;
}>({
  minEvents: PROFILE_PTY_BUCKET_MIN_CHUNKS,
  maxDurationMs: PROFILE_PTY_BUCKET_MAX_DURATION_MS,
  now: profileNowMs,
  createDetails: (key, startedAt) => {
    const [surfaceId, sessionId] = key.split("\u0000") as [Id, Id];
    return {
      surfaceId,
      sessionId,
      startedAt,
      chunks: 0,
      bytes: 0,
      maxChunkBytes: 0
    };
  },
  onFlush: (details, durationMs, at) => {
    smoothnessProfile.record({
      source: "pty-host",
      name: "terminal.pty.bucket",
      at,
      details: {
        ...details,
        durationMs
      }
    });
  }
});

logDiagnostics("pty-host.bootstrap", {
  pid: process.pid,
  cwd: process.cwd(),
  controlTransportAvailable: controlTransport.available
});

function send(message: PtyEvent): void {
  if (!controlTransport.available || ipcChannelClosed) {
    return;
  }

  try {
    controlTransport.postMessage(message);
  } catch (error) {
    handleIpcSendError(error);
  }
}

function registerTerminalBufferTrimHandler(
  terminal: HeadlessTerminal,
  onTrim: (amount: number) => void
): DisposableLike {
  const lines = (
    terminal as unknown as {
      _core?: {
        _bufferService?: {
          buffer?: {
            lines?: {
              onTrim?: (listener: (amount: number) => void) => DisposableLike;
            };
          };
        };
      };
    }
  )._core?._bufferService?.buffer?.lines;
  return lines?.onTrim?.(onTrim) ?? { dispose() {} };
}

function handleIpcSendError(error: unknown): void {
  if (isIpcChannelClosedError(error)) {
    handleIpcChannelClosed(error);
    return;
  }

  logDiagnostics("pty-host.ipc.send.failed", {
    error: error instanceof Error ? error.message : String(error)
  });
}

function isIpcChannelClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return (
    code === "ERR_IPC_CHANNEL_CLOSED" ||
    code === "ERR_IPC_CHANNEL_DISCONNECTED" ||
    code === "EPIPE"
  );
}

function handleIpcChannelClosed(error?: unknown): void {
  if (ipcChannelClosed) {
    return;
  }

  ipcChannelClosed = true;
  dataPlaneSupervisorMetrics.stop();
  if (error) {
    logDiagnostics("pty-host.ipc.closed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  disposeAllSessions();
}

function recordPtyChunk(record: SessionRuntime, chunk: string): void {
  if (!smoothnessProfile.enabled) {
    return;
  }
  const bytes = Buffer.byteLength(chunk, "utf8");
  ptyBucket.record(
    `${record.surfaceId}\u0000${record.sessionId}`,
    (details) => {
      details.chunks += 1;
      details.bytes += bytes;
      details.maxChunkBytes = Math.max(details.maxChunkBytes, bytes);
    }
  );
}

function appendRawOutputTail(record: SessionRuntime, chunk: string): void {
  record.rawOutputTail += chunk;
  if (record.rawOutputTail.length <= RAW_OUTPUT_TAIL_MAX_CHARS) {
    return;
  }

  record.rawOutputTail = record.rawOutputTail.slice(-RAW_OUTPUT_TAIL_MAX_CHARS);
  record.rawOutputTailTruncated = true;
}

function createRawOutputHistory(
  sessionId: Id,
  surfaceId: Id
):
  | {
      rawOutputLogPath: string;
      rawOutputIndexPath: string;
    }
  | undefined {
  if (!RAW_OUTPUT_HISTORY_ENABLED) {
    return undefined;
  }

  try {
    const dir = resolveRawOutputHistoryDir(sessionId, surfaceId);
    mkdirSync(dir, { recursive: true });
    const rawOutputLogPath = join(dir, "stream.ansi");
    const rawOutputIndexPath = join(dir, "chunks.jsonl");
    writeFileSync(rawOutputLogPath, "", "utf8");
    writeFileSync(rawOutputIndexPath, "", "utf8");
    return { rawOutputLogPath, rawOutputIndexPath };
  } catch (error) {
    logDiagnostics("pty-host.raw-output-history.create.failed", {
      sessionId,
      surfaceId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function appendRawOutputHistory(
  record: SessionRuntime,
  chunk: string,
  chunkSequence: number
): void {
  if (!record.rawOutputLogPath || !record.rawOutputIndexPath) {
    return;
  }

  const byteLength = Buffer.byteLength(chunk, "utf8");
  const byteStart = record.rawOutputLogBytes;
  const charStart = record.rawOutputLogChars;
  try {
    appendFileSync(record.rawOutputLogPath, chunk, "utf8");
    record.rawOutputLogBytes += byteLength;
    record.rawOutputLogChars += chunk.length;
    record.rawOutputLogChunks += 1;
    appendFileSync(
      record.rawOutputIndexPath,
      `${JSON.stringify({
        sequence: chunkSequence,
        byteStart,
        byteEnd: record.rawOutputLogBytes,
        charStart,
        charEnd: record.rawOutputLogChars,
        utf8Bytes: byteLength,
        chars: chunk.length,
        at: new Date(record.lastActivityAt).toISOString()
      })}\n`,
      "utf8"
    );
  } catch (error) {
    logDiagnostics("pty-host.raw-output-history.append.failed", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      sequence: chunkSequence,
      error: error instanceof Error ? error.message : String(error)
    });
    record.rawOutputLogPath = undefined;
    record.rawOutputIndexPath = undefined;
  }
}

function enqueueTerminalOutputSegment(
  record: SessionRuntime,
  segment: QueuedOutputSegment
): void {
  if (!segment.chunk) {
    return;
  }
  for (const chunk of splitTerminalOutputText(segment.chunk)) {
    record.mutationQueue.enqueueOutput({
      value: { ...segment, chunk },
      bytes: Buffer.byteLength(chunk, "utf8")
    });
  }
  sessionScheduler.wake(record.sessionId);
}

async function writeTerminalOutputRun(
  record: SessionRuntime,
  segments: QueuedOutputSegment[]
): Promise<void> {
  if (segments.length === 0 || sessions.get(record.sessionId) !== record) {
    return;
  }
  record.inFlightOutputRuns += 1;
  // A parser failure can occur after xterm committed an earlier segment in the
  // run, so release the stale materialization before the first write.
  record.snapshotCache.invalidate();
  try {
    let trimCountBefore = record.cwdRanges.getTrimmedLineCount();
    let startLine =
      record.terminal.buffer.active.baseY +
      record.terminal.buffer.active.cursorY;
    const committedSegments: Extract<
      TerminalDelta,
      { type: "output" }
    >["segments"] = [];

    await new Promise<void>((resolve, reject) => {
      let remaining = segments.length;
      let settled = false;
      const finishOne = (): void => {
        remaining -= 1;
        if (remaining === 0 && !settled) {
          settled = true;
          resolve();
        }
      };

      for (const segment of segments) {
        record.sequence += 1;
        const chunkSequence = record.sequence;
        const byteLength = Buffer.byteLength(segment.chunk, "utf8");
        appendRawOutputHistory(record, segment.chunk, chunkSequence);
        try {
          record.terminal.write(segment.chunk, () => {
            try {
              if (sessions.get(record.sessionId) !== record) {
                finishOne();
                return;
              }
              const trimDuringWrite =
                record.cwdRanges.getTrimmedLineCount() - trimCountBefore;
              const endLine =
                record.terminal.buffer.active.baseY +
                record.terminal.buffer.active.cursorY;
              const chunkCwd = segment.recordCwd ? record.cwd : undefined;
              if (segment.recordCwd) {
                record.cwdRanges.recordWrite({
                  startLine: startLine - trimDuringWrite,
                  endLine,
                  cwd: chunkCwd
                });
              }
              record.parsedSequence = Math.max(
                record.parsedSequence,
                chunkSequence
              );
              committedSegments.push({
                sequence: chunkSequence,
                data: segment.chunk,
                byteLength,
                cwd: chunkCwd,
                ...(segment.telemetry
                  ? {
                      telemetry: {
                        ptyReadAt: segment.telemetry.ptyReadAt,
                        headlessCommitAt: terminalDataPlaneNowMs(performance),
                        visibleAtPtyRead: segment.telemetry.visibleAtPtyRead,
                        ...(segment.telemetry.inputAcceptedAt === undefined
                          ? {}
                          : {
                              inputAcceptedAt:
                                segment.telemetry.inputAcceptedAt,
                              inputSequence: segment.telemetry.inputSequence
                            })
                      }
                    }
                  : {})
              });
              startLine = endLine;
              trimCountBefore = record.cwdRanges.getTrimmedLineCount();
              finishOne();
            } catch (error) {
              if (!settled) {
                settled = true;
                reject(error);
              }
            }
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      }
    });
    if (
      committedSegments.length > 0 &&
      sessions.get(record.sessionId) === record
    ) {
      for (const delta of coalesceTerminalOutputForWire(committedSegments)) {
        record.stream.publish(delta);
      }
    }
  } finally {
    record.inFlightOutputRuns = Math.max(0, record.inFlightOutputRuns - 1);
    disposeHeadlessTerminalIfIdle(record);
  }
}

function enqueueTerminalBarrier<T>(
  record: SessionRuntime,
  operation: () => Promise<T> | T
): Promise<T> {
  const result = new Promise<T>((resolve, reject) => {
    record.mutationQueue.enqueueBarrier(async () => {
      try {
        resolve(await operation());
      } catch (error) {
        reject(error);
      }
    });
  });
  sessionScheduler.wake(record.sessionId);
  return result;
}

function flushPtyProfileBucket(record: SessionRuntime): void {
  if (smoothnessProfile.enabled) {
    ptyBucket.flush(`${record.surfaceId}\u0000${record.sessionId}`);
  }
}

function snapshot(
  record: SessionRuntime,
  options: { includeRawOutputTail?: boolean } = {}
): SurfaceSnapshotPayload {
  const snapshotSequence = record.parsedSequence;
  const materialization = record.snapshotCache.get({
    sequence: snapshotSequence,
    cols: record.cols,
    rows: record.rows,
    requestedScrollbackLines: TERMINAL_RESTORE_SCROLLBACK_LINES,
    maxBytes: TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
    serialize: (scrollbackLines) =>
      record.serialize.serialize({ scrollback: scrollbackLines })
  });
  const cwdRangeWindow = createTerminalCwdRangeSnapshotWindow({
    baseY: record.terminal.buffer.active.baseY,
    bufferLength: record.terminal.buffer.active.length,
    restoreScrollbackLines: materialization.scrollbackLines
  });
  return {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    sequence: snapshotSequence,
    vt: materialization.vt,
    cols: record.cols,
    rows: record.rows,
    title: record.title,
    cwd: record.cwd,
    branch: undefined,
    ports: [],
    unreadCount: 0,
    attention: false,
    cwdRanges: record.cwdRanges.snapshotRanges(cwdRangeWindow),
    ...(options.includeRawOutputTail
      ? {
          rawOutputTail: record.rawOutputTail,
          rawOutputTailTruncated: record.rawOutputTailTruncated,
          rawOutputLogPath: record.rawOutputLogPath,
          rawOutputIndexPath: record.rawOutputIndexPath,
          rawOutputLogBytes: record.rawOutputLogBytes,
          rawOutputLogChunks: record.rawOutputLogChunks
        }
      : {})
  };
}

function terminalCheckpoint(record: SessionRuntime): TerminalCheckpoint {
  const payload = snapshot(record);
  return {
    format: "xterm-vt/1",
    session: sessionRef(record),
    sequence: payload.sequence,
    data: payload.vt,
    cols: payload.cols,
    rows: payload.rows,
    cwd: payload.cwd,
    title: payload.title,
    cwdRanges: payload.cwdRanges
  };
}

function requestTerminalCheckpoint(
  record: SessionRuntime
): Promise<TerminalCheckpoint> {
  return enqueueTerminalBarrier(record, () => terminalCheckpoint(record));
}

function sendSnapshotAfterMutationQueue(
  record: SessionRuntime,
  requestId: Id,
  options: { includeRawOutputTail?: boolean } = {}
): void {
  void enqueueTerminalBarrier(record, () => {
    if (sessions.get(record.sessionId) === record) {
      send({
        type: "snapshot",
        requestId,
        payload: snapshot(record, options)
      });
    }
  }).catch((error) => {
    logDiagnostics("pty-host.snapshot.failed", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    send({ type: "snapshot", requestId, payload: null });
  });
}

function sessionRef(record: SessionRuntime): TerminalSessionRef {
  return {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    epoch: record.runtimeEpoch
  };
}

function writeOrQueueDirectInput(
  record: SessionRuntime,
  input: string | Buffer
): void {
  if (record.shellInputReady) {
    record.pty.write(input);
    return;
  }
  const bytes =
    typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.length;
  if (record.pendingDirectInputBytes + bytes > PENDING_DIRECT_INPUT_MAX_BYTES) {
    throw new Error("pending terminal input exceeds the session limit");
  }
  record.pendingDirectInputs.push(input);
  record.pendingDirectInputBytes += bytes;
}

function flushPendingDirectInput(record: SessionRuntime): void {
  if (!record.shellInputReady || record.pendingDirectInputs.length === 0) {
    return;
  }
  const pending = record.pendingDirectInputs.splice(0);
  record.pendingDirectInputBytes = 0;
  for (const input of pending) {
    record.pty.write(input);
  }
}

function requestDirectResize(
  record: SessionRuntime,
  request: {
    cols: number;
    rows: number;
    gestureActive?: boolean;
  }
): Promise<{ sequence: number; cols: number; rows: number }> {
  return enqueueTerminalBarrier(record, () =>
    applyTerminalResizeMutation(record, request)
  );
}

function applyTerminalResizeMutation(
  record: SessionRuntime,
  request: {
    cols: number;
    rows: number;
    gestureActive?: boolean;
  }
): { sequence: number; cols: number; rows: number } {
  if (request.cols <= 0 || request.rows <= 0) {
    return {
      sequence: record.parsedSequence,
      cols: record.cols,
      rows: record.rows
    };
  }
  prepareTerminalResize({
    record,
    cols: request.cols,
    rows: request.rows,
    gestureActive: request.gestureActive
  });
  record.snapshotCache.invalidate();
  record.sequence += 1;
  record.parsedSequence = record.sequence;
  const delta: TerminalDelta = {
    type: "resize",
    sequence: record.sequence,
    cols: record.cols,
    rows: record.rows
  };
  record.stream.publish(delta);
  return {
    sequence: record.sequence,
    cols: record.cols,
    rows: record.rows
  };
}

function sendTerminalNotification(
  record: SessionRuntime,
  protocol: 9 | 99 | 777,
  title?: string,
  message?: string
): void {
  logDiagnostics("pty-host.terminal.notification.sent", {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    protocol,
    hasTitle: Boolean(title),
    hasMessage: Boolean(message)
  });
  logRawTerminalEvent({
    kind: "notification",
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    protocol,
    hasTitle: Boolean(title),
    hasMessage: Boolean(message)
  });
  send({
    type: "terminal.notification",
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    protocol,
    title,
    message
  });
}

function spawnSession(request: Extract<PtyRequest, { type: "spawn" }>): void {
  const previous = sessions.get(request.spec.sessionId);
  if (previous) {
    previous.closing = true;
    disposeSession(previous, true);
  }
  const pty = resolvePtyModule();
  const preparedLaunch = resolvePtySpawnLaunch(request, process.env);
  let ptyProcess: PtyModule.IPty;
  try {
    ptyProcess = pty.spawn(preparedLaunch.shellPath, preparedLaunch.args, {
      name: "xterm-256color",
      cols: request.spec.cols,
      rows: request.spec.rows,
      cwd: preparedLaunch.cwd,
      env: preparedLaunch.env
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    send({
      type: "error",
      sessionId: request.spec.sessionId,
      message: `session spawn failed for ${preparedLaunch.shellPath}: ${errorMessage}`
    });
    send({
      type: "exit",
      payload: {
        surfaceId: request.spec.surfaceId,
        sessionId: request.spec.sessionId
      }
    });
    return;
  }
  const terminal = new HeadlessTerminalCtor({
    cols: request.spec.cols,
    rows: request.spec.rows,
    allowProposedApi: true,
    cursorBlink: true,
    windowOptions: { getWinSizeChars: true },
    scrollback: TERMINAL_LIVE_SCROLLBACK_LINES
  });
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);
  const rawOutputHistory = createRawOutputHistory(
    request.spec.sessionId,
    request.spec.surfaceId
  );
  const cwdRanges = createTerminalCwdRangeTracker({
    getBufferLength: () => terminal.buffer.active.length
  });
  const trimListener = registerTerminalBufferTrimHandler(terminal, (amount) => {
    cwdRanges.handleTrim(amount);
  });

  let record!: SessionRuntime;
  const queryReplyListener = terminal.onData(
    createTerminalQueryReplyHandler({
      isCurrent: () =>
        sessions.get(record.sessionId) === record &&
        !record.closing &&
        !record.exited,
      // Parser-generated replies are protocol traffic, not user input. They
      // bypass shell-ready gating because a child can wait for DA/DSR/CPR
      // during startup, and they never feed usage/input observation.
      write: (reply) => record.pty.write(reply),
      onWriteError: (error, bytes) => {
        logDiagnostics("pty-host.terminal-query-reply.failed", {
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          bytes,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })
  );
  const mutationQueue = new SessionMutationQueue<QueuedOutputSegment>({
    maxOutputRunBytes: SESSION_OUTPUT_SLICE_BYTES,
    highWatermarkBytes: SESSION_OUTPUT_HIGH_WATERMARK_BYTES,
    lowWatermarkBytes: SESSION_OUTPUT_LOW_WATERMARK_BYTES,
    applyOutputRun: (segments) => writeTerminalOutputRun(record, segments),
    onHighWatermark: () => {
      try {
        ptyProcess.pause();
      } catch {
        // The PTY may exit while its parser backlog crosses the watermark.
      }
    },
    onLowWatermark: () => {
      try {
        ptyProcess.resume();
      } catch {
        // The PTY may already be disposed while the queue is being released.
      }
    }
  });
  const stream = new TerminalSessionStream({
    session: {
      surfaceId: request.spec.surfaceId,
      sessionId: request.spec.sessionId,
      epoch: request.spec.runtimeEpoch
    },
    deltaStore,
    createCheckpoint: () => requestTerminalCheckpoint(record),
    getDimensions: () => ({ cols: record.cols, rows: record.rows }),
    writeText: (text) => writeOrQueueDirectInput(record, text),
    writeBinary: (data) =>
      writeOrQueueDirectInput(record, Buffer.from(data, "binary")),
    writeKey: (input) =>
      writeOrQueueDirectInput(record, encodeTerminalKeyInput(input)),
    resize: (resizeRequest) => requestDirectResize(record, resizeRequest),
    onInputObserved: (message) => {
      const inputAcceptedAt = smoothnessProfile.enabled
        ? terminalDataPlaneNowMs(performance)
        : undefined;
      if (inputAcceptedAt !== undefined) {
        record.inputTelemetrySequence += 1;
        record.pendingInputTelemetry = {
          inputAcceptedAt,
          inputSequence: record.inputTelemetrySequence
        };
      }
      const inputBytes =
        message.type === "input:text"
          ? Buffer.byteLength(message.text, "utf8")
          : message.type === "input:binary"
            ? message.data.length
            : Buffer.byteLength(encodeTerminalKeyInput(message.input), "utf8");
      smoothnessProfile.record({
        source: "pty-host",
        name: "terminal.data-plane.input",
        at: profileNowMs(),
        details: {
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          kind: message.type,
          bytes: inputBytes,
          inputAcceptedAt,
          inputSequence: record.inputTelemetrySequence,
          shellInputReady: record.shellInputReady,
          pendingDirectInputBytes: record.pendingDirectInputBytes
        }
      });
      send({
        type: "input.observed",
        session: sessionRef(record),
        input:
          message.type === "input:text"
            ? { type: "text", text: message.text }
            : message.type === "input:binary"
              ? { type: "binary", data: message.data }
              : { type: "key", input: message.input }
      });
    },
    ...(smoothnessProfile.enabled
      ? { telemetryNow: () => terminalDataPlaneNowMs(performance) }
      : {})
  });
  record = {
    sessionId: request.spec.sessionId,
    surfaceId: request.spec.surfaceId,
    runtimeEpoch: request.spec.runtimeEpoch,
    cwd:
      preparedLaunch.cwd &&
      isTerminalMetadataWithinProtocolLimit(preparedLaunch.cwd)
        ? preparedLaunch.cwd
        : undefined,
    title: isTerminalMetadataWithinProtocolLimit(
      request.spec.launch.title || request.spec.surfaceId
    )
      ? request.spec.launch.title || request.spec.surfaceId
      : request.spec.surfaceId,
    pty: ptyProcess,
    ptyResize: createPtyResizeCoalescer({
      initialCols: request.spec.cols,
      initialRows: request.spec.rows,
      commit: (cols, rows) => {
        try {
          ptyProcess.resize(cols, rows);
        } catch (error) {
          logDiagnostics("pty-host.resize.commit.failed", {
            surfaceId: request.spec.surfaceId,
            sessionId: request.spec.sessionId,
            cols,
            rows,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }),
    terminal,
    queryReplyListener,
    serialize,
    snapshotCache: new SnapshotCache(),
    cwdRanges,
    trimListener,
    mutationQueue,
    stream,
    pendingDirectInputs: [],
    pendingDirectInputBytes: 0,
    inputTelemetrySequence: 0,
    outputSegmenterState: { pendingOsc7: false, pendingOsc7Prefix: "" },
    rawOutputTail: "",
    rawOutputTailTruncated: false,
    rawOutputLogPath: rawOutputHistory?.rawOutputLogPath,
    rawOutputIndexPath: rawOutputHistory?.rawOutputIndexPath,
    rawOutputLogBytes: 0,
    rawOutputLogChars: 0,
    rawOutputLogChunks: 0,
    inFlightOutputRuns: 0,
    disposeTerminalWhenIdle: false,
    sequence: 0,
    parsedSequence: 0,
    cols: request.spec.cols,
    rows: request.spec.rows,
    osc99State: {},
    shellInputReady: !preparedLaunch.requiresShellReady,
    pendingInitialInput: preparedLaunch.requiresShellReady
      ? request.spec.launch.initialInput
      : undefined,
    shellReadyFallbackTimer: null,
    lastActivityAt: Date.now(),
    pendingSettledSnapshots: [],
    settledSnapshotTimer: null,
    closing: false,
    exited: false
  };
  sessions.set(record.sessionId, record);
  sessionScheduler.register(record.sessionId, () =>
    record.mutationQueue.drainSlice()
  );

  terminal.parser.registerOscHandler(7, (data: string) => {
    const cwd = resolveOsc7Cwd(record.cwd, data);
    logDiagnostics("pty-host.osc.7", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      resolvedCwd: cwd ? "<redacted>" : null
    });
    logRawTerminalEvent({
      kind: "osc.7",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      resolvedCwd: Boolean(cwd)
    });
    if (cwd) {
      record.cwd = cwd;
      send({
        type: "metadata",
        payload: {
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          cwd
        }
      });
    }
    return true;
  });
  terminal.parser.registerOscHandler(SHELL_READY_OSC, (data: string) => {
    if (!isShellReadyOscPayload(data)) {
      return false;
    }
    logDiagnostics("pty-host.osc.shell-ready", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId
    });
    logRawTerminalEvent({
      kind: "osc.shell-ready",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length
    });
    setTimeout(() => {
      if (sessions.get(record.sessionId) !== record) {
        return;
      }
      markShellInputReady(record, send, () => flushPendingDirectInput(record));
    }, 0);
    return true;
  });
  terminal.onTitleChange((title: string) => {
    if (!isTerminalMetadataWithinProtocolLimit(title)) {
      return;
    }
    record.title = title;
    send({
      type: "metadata",
      payload: {
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        title
      }
    });
  });
  terminal.onBell(() => {
    logDiagnostics("pty-host.bell", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      hasTitle: Boolean(record.title),
      hasCwd: Boolean(record.cwd)
    });
    logRawTerminalEvent({
      kind: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      hasTitle: Boolean(record.title),
      hasCwd: Boolean(record.cwd)
    });
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
  });
  terminal.parser.registerOscHandler(9, (data: string) => {
    const notification = buildOsc9Notification(data, record.title);
    logDiagnostics("pty-host.osc.9", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    logRawTerminalEvent({
      kind: "osc.9",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    if (notification) {
      sendTerminalNotification(
        record,
        notification.protocol,
        notification.title,
        notification.message
      );
    }
    return true;
  });
  terminal.parser.registerOscHandler(99, (data: string) => {
    const { nextState, notification } = parseOsc99Notification(
      data,
      record.osc99State,
      record.title
    );
    logDiagnostics("pty-host.osc.99", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    logRawTerminalEvent({
      kind: "osc.99",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    record.osc99State = nextState;
    if (notification) {
      sendTerminalNotification(
        record,
        notification.protocol,
        notification.title,
        notification.message
      );
    }
    return true;
  });
  terminal.parser.registerOscHandler(777, (data: string) => {
    const notification = buildOsc777Notification(
      data,
      record.title,
      record.cwd
    );
    logDiagnostics("pty-host.osc.777", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    logRawTerminalEvent({
      kind: "osc.777",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      payloadLength: data.length,
      parsed: Boolean(notification)
    });
    if (notification) {
      sendTerminalNotification(
        record,
        notification.protocol,
        notification.title,
        notification.message
      );
    }
    return true;
  });

  ptyProcess.onData((chunk) => {
    const ptyReadAt = smoothnessProfile.enabled
      ? terminalDataPlaneNowMs(performance)
      : undefined;
    const visibleAtPtyRead = record.stream.attachmentCount > 0;
    const pendingInputTelemetry = record.pendingInputTelemetry;
    record.pendingInputTelemetry = undefined;
    recordPtyChunk(record, chunk);
    appendRawOutputTail(record, chunk);
    record.lastActivityAt = Date.now();
    const splitOutput = splitTerminalOutputByOsc7({
      chunk,
      state: record.outputSegmenterState
    });
    record.outputSegmenterState = splitOutput.state;
    for (const segment of splitOutput.segments) {
      enqueueTerminalOutputSegment(
        record,
        ptyReadAt === undefined
          ? segment
          : {
              ...segment,
              telemetry: {
                ptyReadAt,
                visibleAtPtyRead,
                ...pendingInputTelemetry
              }
            }
      );
    }
    scheduleSettledSnapshotCheck(record);
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (sessions.get(record.sessionId) !== record) {
      return;
    }
    const flushedOutput = flushTerminalOutputSegmenterState(
      record.outputSegmenterState
    );
    record.outputSegmenterState = flushedOutput.state;
    for (const segment of flushedOutput.segments) {
      enqueueTerminalOutputSegment(record, segment);
    }
    void enqueueTerminalBarrier(record, () =>
      finalizeSessionExit(record, exitCode)
    );
  });

  if (!preparedLaunch.requiresShellReady && request.spec.launch.initialInput) {
    ptyProcess.write(request.spec.launch.initialInput);
  } else if (preparedLaunch.requiresShellReady) {
    armShellReadyFallback(record, send, undefined, () =>
      flushPendingDirectInput(record)
    );
  }

  send({
    type: "spawned",
    sessionId: record.sessionId,
    pid: ptyProcess.pid,
    shellInputReady: record.shellInputReady
  });
}

function handlePtyRequest(
  request: PtyRequest,
  ports: TerminalDataPortLike[] = []
): void {
  if (request.type === "shutdown") {
    shutdownRequested = true;
    dataPlaneSupervisorMetrics.stop();
    disposeAllSessions();
    send({ type: "shutdown:ack", requestId: request.requestId });
    return;
  }
  if (shutdownRequested) {
    return;
  }

  switch (request.type) {
    case "spawn":
      spawnSession(request);
      break;
    case "stream.bind": {
      const record = sessions.get(request.session.sessionId);
      const port = ports[0];
      if (
        !record ||
        !port ||
        record.surfaceId !== request.session.surfaceId ||
        record.runtimeEpoch !== request.session.epoch
      ) {
        try {
          port?.close();
        } catch {
          // Invalid transferred capabilities are closed without side effects.
        }
        break;
      }
      record.stream.bind(request.attachId, port);
      break;
    }
    case "close":
      {
        const record = sessions.get(request.sessionId);
        if (!record || record.closing) {
          break;
        }
        record.closing = true;
        if (record.exited) {
          disposeSession(record, false);
        } else {
          record.pty.kill();
        }
      }
      break;
    case "input:text":
      sessions.get(request.sessionId)?.pty.write(request.text);
      break;
    case "input:key":
      sessions
        .get(request.sessionId)
        ?.pty.write(encodeTerminalKeyInput(request.input));
      break;
    case "snapshot": {
      const record = sessions.get(request.sessionId);
      if (record) {
        if ((request.settleForMs ?? 0) > 0) {
          record.pendingSettledSnapshots.push({
            requestId: request.requestId,
            settleForMs: request.settleForMs ?? 0,
            includeRawOutputTail: Boolean(request.includeRawOutputTail)
          });
          scheduleSettledSnapshotCheck(record);
        } else {
          sendSnapshotAfterMutationQueue(record, request.requestId, {
            includeRawOutputTail: Boolean(request.includeRawOutputTail)
          });
        }
      }
      break;
    }
    default:
      break;
  }
}

controlTransport.onMessage((message, ports) => {
  handlePtyRequest(message as PtyRequest, ports);
});

send({ type: "ready" });

function scheduleSettledSnapshotCheck(record: SessionRuntime): void {
  if (record.settledSnapshotTimer) {
    clearTimeout(record.settledSnapshotTimer);
    record.settledSnapshotTimer = null;
  }
  if (record.pendingSettledSnapshots.length === 0) {
    return;
  }

  const quietForMs = Date.now() - record.lastActivityAt;
  let nextDelay = Number.POSITIVE_INFINITY;
  const remainingSnapshots: SessionRuntime["pendingSettledSnapshots"] = [];

  for (const pendingSnapshot of record.pendingSettledSnapshots) {
    const remainingQuietMs = pendingSnapshot.settleForMs - quietForMs;
    if (remainingQuietMs <= 0) {
      sendSnapshotAfterMutationQueue(record, pendingSnapshot.requestId, {
        includeRawOutputTail: pendingSnapshot.includeRawOutputTail
      });
      continue;
    }

    remainingSnapshots.push(pendingSnapshot);
    nextDelay = Math.min(nextDelay, remainingQuietMs);
  }

  record.pendingSettledSnapshots = remainingSnapshots;

  if (!Number.isFinite(nextDelay)) {
    return;
  }

  record.settledSnapshotTimer = setTimeout(() => {
    record.settledSnapshotTimer = null;
    if (!sessions.has(record.sessionId)) {
      return;
    }
    scheduleSettledSnapshotCheck(record);
  }, nextDelay);
}

function disposeSettledSnapshotState(record: SessionRuntime): void {
  if (record.settledSnapshotTimer) {
    clearTimeout(record.settledSnapshotTimer);
    record.settledSnapshotTimer = null;
  }
  record.pendingSettledSnapshots = [];
}

function finalizeSessionExit(record: SessionRuntime, exitCode?: number): void {
  if (sessions.get(record.sessionId) !== record || record.exited) {
    return;
  }
  flushPtyProfileBucket(record);
  disposeSettledSnapshotState(record);
  disposeShellReadyFallback(record);
  record.trimListener.dispose();
  record.ptyResize.dispose();
  record.pendingDirectInputs = [];
  record.pendingDirectInputBytes = 0;
  record.exited = true;
  record.exitCode = exitCode;
  record.stream.exit(exitCode);
  send({
    type: "exit",
    payload: {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      exitCode
    }
  });
  if (record.closing) {
    disposeSession(record, false);
  }
}

function disposeSession(record: SessionRuntime, killPty: boolean): void {
  if (sessions.get(record.sessionId) !== record) {
    return;
  }
  // Fence asynchronous headless-write callbacks before releasing the ring or
  // allowing the same logical session id to spawn with a new runtime epoch.
  sessions.delete(record.sessionId);
  disposeSettledSnapshotState(record);
  disposeShellReadyFallback(record);
  record.stream.dispose();
  record.mutationQueue.dispose();
  sessionScheduler.unregister(record.sessionId);
  deltaStore.removeSession(record.sessionId);
  record.trimListener.dispose();
  record.queryReplyListener.dispose();
  record.ptyResize.dispose();
  record.disposeTerminalWhenIdle = true;
  disposeHeadlessTerminalIfIdle(record);
  if (killPty && !record.exited) {
    try {
      record.pty.kill();
    } catch (error) {
      logDiagnostics("pty-host.session.kill.failed", {
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function disposeHeadlessTerminalIfIdle(record: SessionRuntime): void {
  if (!record.disposeTerminalWhenIdle || record.inFlightOutputRuns > 0) {
    return;
  }
  record.disposeTerminalWhenIdle = false;
  record.terminal.dispose();
}

function disposeAllSessions(): void {
  for (const record of [...sessions.values()]) {
    flushPtyProfileBucket(record);
    disposeSession(record, true);
  }
  deltaStore.clear();
}
