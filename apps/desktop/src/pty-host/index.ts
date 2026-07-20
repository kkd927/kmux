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
  TerminalInputDiagnosticKind,
  TerminalOutputDiagnosticKind,
  TerminalSessionRef,
  Uint64
} from "@kmux/proto";
import {
  formatUint64Decimal,
  incrementUint64,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  uint64
} from "@kmux/proto";
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
import {
  applyDiagnosticsLogPath,
  DIAGNOSTICS_LOG_PATH_ENV,
  PTY_STDOUT_LOGS_ENV,
  logDiagnostics,
  logTerminalDiagnostics,
  setDiagnosticsRecordSink,
  resolveDiagnosticsLogPath,
  type DiagnosticsRecord
} from "../shared/diagnostics";
import type {
  SmoothnessProfileEvent,
  SmoothnessProfileRecorder
} from "../shared/smoothnessProfile";
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
import {
  classifyTerminalBinaryInput,
  classifyTerminalTextInput,
  createTerminalOutputDiagnosticClassifier,
  type TerminalOutputDiagnosticClassifier
} from "../shared/terminalInteractionDiagnostics";
import { createRawTerminalEventStdoutLogger } from "./rawTerminalStdoutLog";
import { resolveRawOutputHistoryDir } from "./rawOutputHistoryPath";
import {
  createPtyResizeCoalescer,
  type PtyResizeCoalescer,
  type PtyResizeCommitContext
} from "./ptyResizeCoalescer";
import { prepareTerminalResize } from "./resizeRuntime";
import {
  registerTerminalVtDiagnostics,
  syncTerminalVtDiagnosticsRegistration,
  type TerminalVtDestructiveEvent
} from "./terminalVtDiagnostics";
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
  sliceTerminalOutputAfterSequence,
  splitTerminalOutputText,
  terminalDeltaRetainedBytes,
  TERMINAL_OUTPUT_SEGMENT_MAX_BYTES
} from "./terminalWireCoalescing";
import { createTerminalQueryReplyHandler } from "./terminalQueryReply";
import { createPtyDiagnosticsIpcBatcher } from "./diagnosticsIpcBatcher";
import {
  resolveTerminalOutputGapMs,
  settlePtyProfileBucketsBeforeDiagnosticsDisable
} from "./terminalDiagnostics";

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
  inputTelemetrySequence: Uint64;
  pendingInputTelemetry?: {
    inputAcceptedAt: number;
    inputSequence: Uint64;
    inputKind: TerminalInputDiagnosticKind;
  };
  lastDiagnosticOutputAt?: number;
  outputDiagnosticClassifier?: TerminalOutputDiagnosticClassifier;
  outputDiagnosticClassifierActive: boolean;
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
  sequence: Uint64;
  parsedSequence: Uint64;
  cols: number;
  rows: number;
  lastPtyResizeCommit?: PtyResizeCommitContext & {
    cols: number;
    rows: number;
  };
  vtDiagnosticsListener?: DisposableLike;
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
  pendingCloseAcks: Array<{
    requestId: Id;
    outcome: "terminated" | "already-exited";
  }>;
  exited: boolean;
  exitCode?: number;
}

interface QueuedOutputSegment {
  chunk: string;
  recordCwd: boolean;
  telemetry?: {
    ptyReadAt: number;
    visibleAtPtyRead: boolean;
    outputKind: TerminalOutputDiagnosticKind;
    inputAcceptedAt?: number;
    inputSequence?: Uint64;
    inputKind?: TerminalInputDiagnosticKind;
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
function createDiagnosticsIpc() {
  return createPtyDiagnosticsIpcBatcher({
    enabled: true,
    sendBatch: (records) => {
      if (!controlTransport.available || ipcChannelClosed) {
        return false;
      }
      try {
        controlTransport.postMessage({ type: "diagnostics.batch", records });
        return true;
      } catch {
        return false;
      }
    }
  });
}

let diagnosticsIpc = resolveDiagnosticsLogPath(
  process.env[DIAGNOSTICS_LOG_PATH_ENV]
)
  ? createDiagnosticsIpc()
  : null;
const isTerminalDiagnosticsEnabled = (): boolean =>
  Boolean(diagnosticsIpc?.enabled);
const recordPtyDiagnostics = (record: DiagnosticsRecord): boolean =>
  diagnosticsIpc?.record(record) ?? false;
setDiagnosticsRecordSink(diagnosticsIpc ? recordPtyDiagnostics : null);
const terminalMetricsProfile: SmoothnessProfileRecorder = {
  get enabled() {
    return smoothnessProfile.enabled || Boolean(diagnosticsIpc?.enabled);
  },
  record(event: SmoothnessProfileEvent): void {
    smoothnessProfile.record(event);
    if (diagnosticsIpc?.enabled && event.name.startsWith("terminal.")) {
      logTerminalDiagnostics(event.name, {
        source: event.source,
        eventAt: event.at,
        ...event.details
      });
    }
  }
};
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
      delta.type === "output"
        ? delta.fromSequence
        : uint64(delta.sequence - 1n),
    sequence: delta.sequence
  }),
  sizeOf: terminalDeltaRetainedBytes,
  replaySizeOf: (delta) => (delta.type === "output" ? delta.byteLength : 0),
  sliceAfterInternalCursor: sliceTerminalOutputAfterSequence
});
function createDataPlaneSupervisorMetrics() {
  return createTerminalDataPlaneSupervisorMetrics({
    recorder: terminalMetricsProfile,
    now: profileNowMs,
    readSessions: () =>
      [...sessions.values()].map((record) => ({
        queue: record.mutationQueue.stats(),
        ring: deltaStore.sessionStats(record.sessionId),
        stream: record.stream.stats()
      })),
    readRing: () => deltaStore.stats()
  });
}

let dataPlaneSupervisorMetrics = createDataPlaneSupervisorMetrics();

function refreshTerminalTelemetry(): void {
  dataPlaneSupervisorMetrics.stop();
  dataPlaneSupervisorMetrics = createDataPlaneSupervisorMetrics();
  const telemetryNow = terminalMetricsProfile.enabled
    ? () => terminalDataPlaneNowMs(performance)
    : undefined;
  for (const record of sessions.values()) {
    record.stream.configureTelemetryNow(telemetryNow);
    syncSessionTerminalVtDiagnostics(record);
    if (!diagnosticsIpc?.enabled) {
      record.lastDiagnosticOutputAt = undefined;
    }
    if (!terminalMetricsProfile.enabled) {
      record.outputDiagnosticClassifier = undefined;
      record.outputDiagnosticClassifierActive = false;
    }
  }
}
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
  firstPtyReadAt: number | null;
  lastPtyReadAt: number | null;
  outputKinds: Record<TerminalOutputDiagnosticKind, number>;
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
      maxChunkBytes: 0,
      firstPtyReadAt: null,
      lastPtyReadAt: null,
      outputKinds: {
        "osc-title-only": 0,
        "osc-only": 0,
        screen: 0,
        mixed: 0,
        "control-only": 0,
        indeterminate: 0
      }
    };
  },
  onFlush: (details, durationMs, at) => {
    terminalMetricsProfile.record({
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
  diagnosticsIpc?.close();
  diagnosticsIpc = null;
  applyDiagnosticsLogPath(process.env, undefined);
  setDiagnosticsRecordSink(null);
  disposeAllSessions();
}

function recordPtyChunk(
  record: SessionRuntime,
  chunk: string,
  outputKind: TerminalOutputDiagnosticKind,
  ptyReadAt: number
): void {
  if (!terminalMetricsProfile.enabled) {
    return;
  }
  const bytes = Buffer.byteLength(chunk, "utf8");
  ptyBucket.record(
    `${record.surfaceId}\u0000${record.sessionId}`,
    (details) => {
      details.chunks += 1;
      details.bytes += bytes;
      details.maxChunkBytes = Math.max(details.maxChunkBytes, bytes);
      details.firstPtyReadAt ??= ptyReadAt;
      details.lastPtyReadAt = ptyReadAt;
      details.outputKinds[outputKind] += 1;
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
  chunkSequence: Uint64,
  telemetry: QueuedOutputSegment["telemetry"]
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
        sequence: formatUint64Decimal(chunkSequence),
        byteStart,
        byteEnd: record.rawOutputLogBytes,
        charStart,
        charEnd: record.rawOutputLogChars,
        utf8Bytes: byteLength,
        chars: chunk.length,
        at: new Date(
          telemetry?.ptyReadAt ?? record.lastActivityAt
        ).toISOString(),
        ptyReadAt: telemetry?.ptyReadAt,
        outputKind: telemetry?.outputKind,
        visibleAtPtyRead: telemetry?.visibleAtPtyRead,
        inputSequence:
          telemetry?.inputSequence === undefined
            ? undefined
            : formatUint64Decimal(telemetry.inputSequence),
        inputKind: telemetry?.inputKind
      })}\n`,
      "utf8"
    );
  } catch (error) {
    logDiagnostics("pty-host.raw-output-history.append.failed", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      sequence: formatUint64Decimal(chunkSequence),
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
        record.sequence = incrementUint64(record.sequence);
        const chunkSequence = record.sequence;
        const byteLength = Buffer.byteLength(segment.chunk, "utf8");
        appendRawOutputHistory(
          record,
          segment.chunk,
          chunkSequence,
          segment.telemetry
        );
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
              if (chunkSequence > record.parsedSequence) {
                record.parsedSequence = chunkSequence;
              }
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
                        outputKind: segment.telemetry.outputKind,
                        visibleAtPtyRead: segment.telemetry.visibleAtPtyRead,
                        ...(segment.telemetry.inputAcceptedAt === undefined
                          ? {}
                          : {
                              inputAcceptedAt:
                                segment.telemetry.inputAcceptedAt,
                              inputSequence: segment.telemetry.inputSequence,
                              inputKind: segment.telemetry.inputKind
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
  if (terminalMetricsProfile.enabled) {
    ptyBucket.flush(`${record.surfaceId}\u0000${record.sessionId}`);
  }
}

function recordTerminalVtDiagnostic(
  record: SessionRuntime,
  event: TerminalVtDestructiveEvent
): void {
  if (!isTerminalDiagnosticsEnabled()) {
    return;
  }
  const now = Date.now();
  const lastResize = record.lastPtyResizeCommit;
  const msSincePtyResizeCommit = lastResize
    ? now - lastResize.committedAt
    : null;
  const buffer = record.terminal.buffer.active;
  logTerminalDiagnostics(`terminal.vt.${event.kind}`, {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    ...event,
    cols: record.cols,
    rows: record.rows,
    bufferType: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    bufferLength: buffer.length,
    sequence: record.sequence,
    parsedSequence: record.parsedSequence,
    rawOutputLogBytes: record.rawOutputLogBytes,
    rawOutputLogChars: record.rawOutputLogChars,
    lastPtyResizeCommit: lastResize ?? null,
    msSincePtyResizeCommit,
    resizeAdjacent:
      msSincePtyResizeCommit !== null &&
      msSincePtyResizeCommit >= 0 &&
      msSincePtyResizeCommit <= 5_000
  });
}

function syncSessionTerminalVtDiagnostics(record: SessionRuntime): void {
  const diagnosticsEnabled = isTerminalDiagnosticsEnabled();
  const listenerEnabled = diagnosticsEnabled && !record.exited;
  if (!listenerEnabled) {
    record.vtDiagnosticsListener = syncTerminalVtDiagnosticsRegistration({
      enabled: false,
      current: record.vtDiagnosticsListener
    });
    if (!diagnosticsEnabled) {
      record.lastPtyResizeCommit = undefined;
    }
    return;
  }
  record.vtDiagnosticsListener = syncTerminalVtDiagnosticsRegistration({
    enabled: true,
    current: record.vtDiagnosticsListener,
    register: () =>
      registerTerminalVtDiagnostics(record.terminal, (event) =>
        recordTerminalVtDiagnostic(record, event)
      )
  });
}

function logPtyResizeState(
  record: SessionRuntime,
  reason: "diagnostics-enabled" | "diagnostic-snapshot",
  details: Record<string, unknown> = {}
): void {
  if (!isTerminalDiagnosticsEnabled()) {
    return;
  }
  logTerminalDiagnostics("terminal.pty-resize.state", {
    reason,
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    exited: record.exited,
    closing: record.closing,
    headlessCols: record.cols,
    headlessRows: record.rows,
    ptyReportedCols: record.pty.cols,
    ptyReportedRows: record.pty.rows,
    coalescer: record.ptyResize.getState(),
    lastPtyResizeCommit: record.lastPtyResizeCommit ?? null,
    attachmentCount: record.stream.attachmentCount,
    ...details
  });
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
      if (options.includeRawOutputTail) {
        ptyBucket.flushAll();
        for (const sessionRecord of sessions.values()) {
          logPtyResizeState(sessionRecord, "diagnostic-snapshot", {
            requestedSurfaceId: record.surfaceId
          });
        }
      }
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
    requestId?: string;
  }
): Promise<{ sequence: Uint64; cols: number; rows: number }> {
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
    requestId?: string;
  }
): { sequence: Uint64; cols: number; rows: number } {
  if (request.cols <= 0 || request.rows <= 0) {
    return {
      sequence: record.parsedSequence,
      cols: record.cols,
      rows: record.rows
    };
  }
  const diagnosticsEnabled = isTerminalDiagnosticsEnabled();
  const previousCols = diagnosticsEnabled ? record.cols : 0;
  const previousRows = diagnosticsEnabled ? record.rows : 0;
  const headlessGridChanged = prepareTerminalResize({
    record,
    cols: request.cols,
    rows: request.rows,
    gestureActive: request.gestureActive,
    requestId: diagnosticsEnabled ? request.requestId : undefined
  });
  record.snapshotCache.invalidate();
  record.sequence = incrementUint64(record.sequence);
  record.parsedSequence = record.sequence;
  if (diagnosticsEnabled) {
    logTerminalDiagnostics("terminal.resize.supervisor-request", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      requestId: request.requestId ?? null,
      sequence: record.sequence,
      previousCols,
      previousRows,
      requestedCols: request.cols,
      requestedRows: request.rows,
      appliedCols: record.cols,
      appliedRows: record.rows,
      headlessGridChanged,
      gestureActive: request.gestureActive === true,
      attachmentCount: record.stream.attachmentCount
    });
  }
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
      const inputAcceptedAt = terminalMetricsProfile.enabled
        ? terminalDataPlaneNowMs(performance)
        : undefined;
      const inputKind =
        inputAcceptedAt === undefined
          ? undefined
          : message.type === "input:text"
            ? classifyTerminalTextInput(message.text)
            : message.type === "input:binary"
              ? classifyTerminalBinaryInput(message.data)
              : "key";
      if (inputAcceptedAt !== undefined && inputKind !== undefined) {
        record.inputTelemetrySequence = incrementUint64(
          record.inputTelemetrySequence
        );
        record.pendingInputTelemetry = {
          inputAcceptedAt,
          inputSequence: record.inputTelemetrySequence,
          inputKind
        };
      }
      const inputBytes =
        message.type === "input:text"
          ? Buffer.byteLength(message.text, "utf8")
          : message.type === "input:binary"
            ? message.data.length
            : Buffer.byteLength(encodeTerminalKeyInput(message.input), "utf8");
      terminalMetricsProfile.record({
        source: "pty-host",
        name: "terminal.data-plane.input",
        at: profileNowMs(),
        details: {
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          kind: message.type,
          inputKind,
          bytes: inputBytes,
          inputAcceptedAt,
          inputSequence: formatUint64Decimal(record.inputTelemetrySequence),
          shellInputReady: record.shellInputReady,
          pendingDirectInputBytes: record.pendingDirectInputBytes,
          queue: record.mutationQueue.stats(),
          ring: deltaStore.sessionStats(record.sessionId),
          stream: record.stream.stats()
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
    ...(terminalMetricsProfile.enabled
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
      diagnosticsEnabled: isTerminalDiagnosticsEnabled,
      onRequest: (event) => {
        logTerminalDiagnostics("terminal.pty-resize.coalescer-request", {
          surfaceId: request.spec.surfaceId,
          sessionId: request.spec.sessionId,
          ...event
        });
      },
      commit: (cols, rows, context) => {
        if (context) {
          record.lastPtyResizeCommit = { ...context, cols, rows };
        }
        try {
          ptyProcess.resize(cols, rows);
          if (context) {
            logTerminalDiagnostics("terminal.pty-resize.commit", {
              surfaceId: request.spec.surfaceId,
              sessionId: request.spec.sessionId,
              ...context,
              cols,
              rows,
              succeeded: true,
              ptyReportedCols: ptyProcess.cols,
              ptyReportedRows: ptyProcess.rows
            });
          }
        } catch (error) {
          record.lastPtyResizeCommit = undefined;
          if (context) {
            logTerminalDiagnostics("terminal.pty-resize.commit", {
              surfaceId: request.spec.surfaceId,
              sessionId: request.spec.sessionId,
              ...context,
              cols,
              rows,
              succeeded: false,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          logDiagnostics("pty-host.resize.commit.failed", {
            surfaceId: request.spec.surfaceId,
            sessionId: request.spec.sessionId,
            ...(context ?? {}),
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
    inputTelemetrySequence: uint64(0n),
    outputDiagnosticClassifier: terminalMetricsProfile.enabled
      ? createTerminalOutputDiagnosticClassifier()
      : undefined,
    outputDiagnosticClassifierActive: terminalMetricsProfile.enabled,
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
    sequence: uint64(0n),
    parsedSequence: uint64(0n),
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
    pendingCloseAcks: [],
    exited: false
  };
  sessions.set(record.sessionId, record);
  syncSessionTerminalVtDiagnostics(record);
  if (isTerminalDiagnosticsEnabled()) {
    logTerminalDiagnostics("terminal.pty-resize.initial", {
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      cols: record.cols,
      rows: record.rows,
      ptyPid: record.pty.pid,
      ptyReportedCols: record.pty.cols,
      ptyReportedRows: record.pty.rows,
      coalescer: record.ptyResize.getState()
    });
  }
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
    const telemetryEnabled = terminalMetricsProfile.enabled;
    const ptyReadAt = telemetryEnabled
      ? terminalDataPlaneNowMs(performance)
      : undefined;
    let outputKind: TerminalOutputDiagnosticKind | undefined;
    if (telemetryEnabled) {
      const classifier = (record.outputDiagnosticClassifier ??=
        createTerminalOutputDiagnosticClassifier());
      if (!record.outputDiagnosticClassifierActive) {
        classifier.invalidate();
        record.outputDiagnosticClassifierActive = true;
      }
      outputKind = classifier.classify(chunk);
    } else {
      record.outputDiagnosticClassifierActive = false;
    }
    if (diagnosticsIpc?.enabled && ptyReadAt !== undefined) {
      const previousOutputAt = record.lastDiagnosticOutputAt;
      const gapMs = resolveTerminalOutputGapMs(previousOutputAt, ptyReadAt);
      if (gapMs !== undefined) {
        logTerminalDiagnostics("terminal.data-plane.output-gap", {
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          gapMs,
          ptyReadAt,
          nextSequence: formatUint64Decimal(
            incrementUint64(record.sequence)
          ),
          chunkBytes: Buffer.byteLength(chunk, "utf8"),
          outputKind,
          ...(record.pendingInputTelemetry
            ? {
                inputSequence: formatUint64Decimal(
                  record.pendingInputTelemetry.inputSequence
                ),
                inputKind: record.pendingInputTelemetry.inputKind,
                inputToOutputMs:
                  ptyReadAt - record.pendingInputTelemetry.inputAcceptedAt
              }
            : {}),
          queue: record.mutationQueue.stats(),
          ring: deltaStore.sessionStats(record.sessionId),
          stream: record.stream.stats()
        });
      }
      record.lastDiagnosticOutputAt = ptyReadAt;
    }
    const visibleAtPtyRead = record.stream.attachmentCount > 0;
    const pendingInputTelemetry = record.pendingInputTelemetry;
    record.pendingInputTelemetry = undefined;
    if (outputKind !== undefined && ptyReadAt !== undefined) {
      recordPtyChunk(record, chunk, outputKind, ptyReadAt);
    }
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
        ptyReadAt === undefined || outputKind === undefined
          ? segment
          : {
              ...segment,
              telemetry: {
                ptyReadAt,
                visibleAtPtyRead,
                outputKind,
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
    diagnosticsIpc?.close();
    diagnosticsIpc = null;
    applyDiagnosticsLogPath(process.env, undefined);
    setDiagnosticsRecordSink(null);
    send({ type: "shutdown:ack", requestId: request.requestId });
    return;
  }
  if (shutdownRequested) {
    return;
  }

  switch (request.type) {
    case "diagnostics.configure": {
      const nextLogPath = resolveDiagnosticsLogPath(request.logPath);
      if (nextLogPath) {
        applyDiagnosticsLogPath(process.env, nextLogPath);
        diagnosticsIpc ??= createDiagnosticsIpc();
        setDiagnosticsRecordSink(recordPtyDiagnostics);
        refreshTerminalTelemetry();
        logDiagnostics("pty-host.diagnostics.configuration.changed", {
          enabled: true,
          logPath: nextLogPath
        });
        for (const record of sessions.values()) {
          logPtyResizeState(record, "diagnostics-enabled");
        }
      } else {
        settlePtyProfileBucketsBeforeDiagnosticsDisable({
          continuousProfileEnabled: smoothnessProfile.enabled,
          flushAll: () => ptyBucket.flushAll()
        });
        logDiagnostics("pty-host.diagnostics.configuration.changed", {
          enabled: false
        });
        diagnosticsIpc?.flush();
        diagnosticsIpc?.close();
        diagnosticsIpc = null;
        setDiagnosticsRecordSink(null);
        applyDiagnosticsLogPath(process.env, undefined);
        refreshTerminalTelemetry();
      }
      diagnosticsIpc?.flush();
      send({
        type: "diagnostics.configured",
        requestId: request.requestId,
        enabled: Boolean(nextLogPath)
      });
      break;
    }
    case "diagnostics.flush":
      diagnosticsIpc?.flush();
      send({ type: "diagnostics.flushed", requestId: request.requestId });
      break;
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
        if (!record) {
          if (request.requestId) {
            send({
              type: "close.ack",
              requestId: request.requestId,
              sessionId: request.sessionId,
              ...(request.surfaceId === undefined
                ? {}
                : { surfaceId: request.surfaceId }),
              ...(request.expectedRuntimeEpoch === undefined
                ? {}
                : { runtimeEpoch: request.expectedRuntimeEpoch }),
              outcome: "already-exited"
            });
          }
          break;
        }
        if (
          (request.surfaceId !== undefined &&
            request.surfaceId !== record.surfaceId) ||
          (request.expectedRuntimeEpoch !== undefined &&
            request.expectedRuntimeEpoch !== record.runtimeEpoch)
        ) {
          if (request.requestId) {
            send({
              type: "close.ack",
              requestId: request.requestId,
              sessionId: request.sessionId,
              surfaceId: record.surfaceId,
              runtimeEpoch: record.runtimeEpoch,
              outcome: "generation-mismatch"
            });
          }
          break;
        }
        if (request.requestId) {
          record.pendingCloseAcks.push({
            requestId: request.requestId,
            outcome: record.exited ? "already-exited" : "terminated"
          });
        }
        if (record.closing) break;
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
  record.vtDiagnosticsListener?.dispose();
  record.vtDiagnosticsListener = undefined;
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
  for (const acknowledgement of record.pendingCloseAcks.splice(0)) {
    send({
      type: "close.ack",
      requestId: acknowledgement.requestId,
      sessionId: record.sessionId,
      surfaceId: record.surfaceId,
      runtimeEpoch: record.runtimeEpoch,
      outcome: acknowledgement.outcome
    });
  }
  disposeSettledSnapshotState(record);
  disposeShellReadyFallback(record);
  record.stream.dispose();
  record.mutationQueue.dispose();
  sessionScheduler.unregister(record.sessionId);
  deltaStore.removeSession(record.sessionId);
  record.trimListener.dispose();
  record.queryReplyListener.dispose();
  record.vtDiagnosticsListener?.dispose();
  record.vtDiagnosticsListener = undefined;
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
