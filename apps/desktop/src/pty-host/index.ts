import type {
  ITerminalInitOnlyOptions as HeadlessTerminalInitOptions,
  ITerminalOptions as HeadlessTerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Id,
  PtyEvent,
  PtyRequest,
  SurfaceSnapshotPayload
} from "@kmux/proto";
import type * as PtyModule from "node-pty";
import { loadNodePty } from "./nodePtyLoader";
import { encodeTerminalKeyInput } from "./terminalInput";
import {
  buildOsc9Notification,
  buildOsc777Notification,
  parseOsc99Notification,
  type Osc99NotificationState
} from "./terminalNotifications";
import { resolveOsc7Cwd } from "./osc7";
import {
  SHELL_READY_OSC,
  prepareShellIntegrationLaunch,
  shouldApplyShellIntegration
} from "./shellIntegration";
import {
  armShellReadyFallback,
  disposeShellReadyFallback,
  isShellReadyOscPayload,
  markShellInputReady
} from "./shellInputReady";
import {
  resolveDefaultShellArgs,
  shouldStripShellManagedEnv
} from "./shellLaunch";
import { buildSessionEnv } from "./sessionEnv";
import {
  PTY_STDOUT_LOGS_ENV,
  logDiagnostics
} from "../shared/diagnostics";
import {
  TERMINAL_LIVE_SCROLLBACK_LINES,
  TERMINAL_RESTORE_SCROLLBACK_LINES
} from "../shared/terminalConfig";
import {
  createNodeSmoothnessProfileRecorder,
  profileNowMs
} from "../shared/nodeSmoothnessProfile";
import { createSmoothnessProfileBucket } from "../shared/smoothnessProfileBucket";
import { createRawTerminalEventStdoutLogger } from "./rawTerminalStdoutLog";
import { OutputBatcher } from "./outputBatcher";
import { handleTerminalResizeRequest } from "./resizeRuntime";
import { SnapshotCache } from "./snapshotCache";

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

interface SessionRecord {
  sessionId: Id;
  surfaceId: Id;
  cwd?: string;
  title: string;
  pty: PtyModule.IPty;
  terminal: HeadlessTerminal;
  serialize: SerializeAddon;
  snapshotCache: SnapshotCache;
  rawOutputTail: string;
  rawOutputTailTruncated: boolean;
  rawOutputLogPath?: string;
  rawOutputIndexPath?: string;
  rawOutputLogBytes: number;
  rawOutputLogChars: number;
  rawOutputLogChunks: number;
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
}

const sessions = new Map<Id, SessionRecord>();
const logRawTerminalEvent = createRawTerminalEventStdoutLogger();
const smoothnessProfile = createNodeSmoothnessProfileRecorder(process.env);
const PROFILE_PTY_BUCKET_MIN_CHUNKS = 100;
const PROFILE_PTY_BUCKET_MAX_DURATION_MS = 1000;
const OUTPUT_BATCH_FLUSH_MS = 8;
const OUTPUT_BATCH_MAX_BYTES = 64 * 1024;
const RAW_OUTPUT_TAIL_MAX_CHARS = 128 * 1024;
const RAW_OUTPUT_HISTORY_ENABLED = process.env[PTY_STDOUT_LOGS_ENV] === "1";
const outputBatcher = new OutputBatcher({
  flushMs: OUTPUT_BATCH_FLUSH_MS,
  maxBatchBytes: OUTPUT_BATCH_MAX_BYTES,
  onFlush: (payload) => {
    send({
      type: "chunk",
      payload
    });
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
  cwd: process.cwd()
});

function send(message: PtyEvent): void {
  if (process.send) {
    process.send(message);
  }
}

function recordPtyChunk(record: SessionRecord, chunk: string): void {
  if (!smoothnessProfile.enabled) {
    return;
  }
  const bytes = Buffer.byteLength(chunk, "utf8");
  ptyBucket.record(`${record.surfaceId}\u0000${record.sessionId}`, (details) => {
    details.chunks += 1;
    details.bytes += bytes;
    details.maxChunkBytes = Math.max(details.maxChunkBytes, bytes);
  });
}

function appendRawOutputTail(record: SessionRecord, chunk: string): void {
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
    const root =
      process.env.KMUX_RUNTIME_DIR ?? join(process.cwd(), ".kmux/dev/runtime");
    const dir = join(
      root,
      "pty-raw",
      `${safePathSegment(sessionId)}-${safePathSegment(surfaceId)}`
    );
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

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function appendRawOutputHistory(
  record: SessionRecord,
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

function flushPtyProfileBucket(record: SessionRecord): void {
  if (smoothnessProfile.enabled) {
    ptyBucket.flush(`${record.surfaceId}\u0000${record.sessionId}`);
  }
}

function snapshot(
  record: SessionRecord,
  options: { includeRawOutputTail?: boolean } = {}
): SurfaceSnapshotPayload {
  outputBatcher.flush(record.sessionId);
  const snapshotSequence = record.parsedSequence;
  return {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    sequence: snapshotSequence,
    vt: record.snapshotCache.get({
      sequence: snapshotSequence,
      cols: record.cols,
      rows: record.rows,
      serialize: () =>
        record.serialize.serialize({
          scrollback: TERMINAL_RESTORE_SCROLLBACK_LINES
        })
    }),
    cols: record.cols,
    rows: record.rows,
    title: record.title,
    cwd: record.cwd,
    branch: undefined,
    ports: [],
    unreadCount: 0,
    attention: false,
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

function sendTerminalNotification(
  record: SessionRecord,
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
  const pty = resolvePtyModule();
  const shell = request.spec.launch.shell || process.env.SHELL || "/bin/zsh";
  const args =
    request.spec.launch.args ??
    resolveDefaultShellArgs(shell, process.platform);
  const stripShellManagedEnv = shouldStripShellManagedEnv(
    shell,
    request.spec.launch.args,
    process.platform
  );
  const env = buildSessionEnv(
    process.env,
    request.spec.launch.env,
    request.spec.env,
    {
      stripShellManagedEnv
    }
  );
  const preparedLaunch = prepareShellIntegrationLaunch(shell, args, env, {
    enabled: shouldApplyShellIntegration(
      shell,
      request.spec.launch.args,
      process.platform
    )
  });
  let ptyProcess: PtyModule.IPty;
  try {
    ptyProcess = pty.spawn(preparedLaunch.shellPath, preparedLaunch.args, {
      name: "xterm-256color",
      cols: request.spec.cols,
      rows: request.spec.rows,
      cwd: request.spec.launch.cwd ?? process.env.HOME,
      env: preparedLaunch.env
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    send({
      type: "error",
      sessionId: request.spec.sessionId,
      message: `session spawn failed for ${shell}: ${errorMessage}`
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

  const record: SessionRecord = {
    sessionId: request.spec.sessionId,
    surfaceId: request.spec.surfaceId,
    cwd: request.spec.launch.cwd,
    title: request.spec.launch.title || request.spec.surfaceId,
    pty: ptyProcess,
    terminal,
    serialize,
    snapshotCache: new SnapshotCache(),
    rawOutputTail: "",
    rawOutputTailTruncated: false,
    rawOutputLogPath: rawOutputHistory?.rawOutputLogPath,
    rawOutputIndexPath: rawOutputHistory?.rawOutputIndexPath,
    rawOutputLogBytes: 0,
    rawOutputLogChars: 0,
    rawOutputLogChunks: 0,
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
    settledSnapshotTimer: null
  };
  sessions.set(record.sessionId, record);

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
      markShellInputReady(record, send, () =>
        outputBatcher.flush(record.sessionId)
      );
    }, 0);
    return true;
  });
  terminal.onTitleChange((title: string) => {
    record.title = title;
    send({
      type: "metadata",
      payload: {
        surfaceId: record.surfaceId,
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
    recordPtyChunk(record, chunk);
    appendRawOutputTail(record, chunk);
    record.sequence += 1;
    const chunkSequence = record.sequence;
    record.lastActivityAt = Date.now();
    appendRawOutputHistory(record, chunk, chunkSequence);
    terminal.write(chunk, () => {
      record.parsedSequence = Math.max(record.parsedSequence, chunkSequence);
    });
    scheduleSettledSnapshotCheck(record);
    outputBatcher.push({
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      sequence: chunkSequence,
      chunk
    });
  });
  ptyProcess.onExit(({ exitCode }) => {
    flushPtyProfileBucket(record);
    outputBatcher.flush(record.sessionId);
    disposeSettledSnapshotState(record);
    disposeShellReadyFallback(record);
    send({
      type: "exit",
      payload: {
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        exitCode
      }
    });
    sessions.delete(record.sessionId);
  });

  if (!preparedLaunch.requiresShellReady && request.spec.launch.initialInput) {
    ptyProcess.write(request.spec.launch.initialInput);
  } else if (preparedLaunch.requiresShellReady) {
    armShellReadyFallback(record, send, () =>
      outputBatcher.flush(record.sessionId)
    );
  }

  send({
    type: "spawned",
    sessionId: record.sessionId,
    pid: ptyProcess.pid,
    shellInputReady: record.shellInputReady
  });
}

process.on("message", (request: PtyRequest) => {
  switch (request.type) {
    case "spawn":
      spawnSession(request);
      break;
    case "close":
      {
        const record = sessions.get(request.sessionId);
        if (!record) {
          break;
        }
        flushPtyProfileBucket(record);
        outputBatcher.flush(record.sessionId);
        disposeSettledSnapshotState(record);
        disposeShellReadyFallback(record);
        record.pty.kill();
        sessions.delete(request.sessionId);
      }
      break;
    case "resize":
      {
        handleTerminalResizeRequest({
          record: sessions.get(request.sessionId),
          sessionId: request.sessionId,
          attachId: request.attachId,
          requestId: request.requestId,
          cols: request.cols,
          rows: request.rows,
          flushOutput: (sessionId) => outputBatcher.flush(sessionId),
          emitResize: (payload) => {
            send({
              type: "resize",
              payload
            });
          },
          emitAck: (payload) => {
            send({
              type: "resize:ack",
              ...payload
            });
          }
        });
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
          send({
            type: "snapshot",
            requestId: request.requestId,
            payload: snapshot(record, {
              includeRawOutputTail: Boolean(request.includeRawOutputTail)
            })
          });
        }
      }
      break;
    }
    default:
      break;
  }
});

send({ type: "ready" });

function scheduleSettledSnapshotCheck(record: SessionRecord): void {
  if (record.settledSnapshotTimer) {
    clearTimeout(record.settledSnapshotTimer);
    record.settledSnapshotTimer = null;
  }
  if (record.pendingSettledSnapshots.length === 0) {
    return;
  }

  const quietForMs = Date.now() - record.lastActivityAt;
  let nextDelay = Number.POSITIVE_INFINITY;
  const remainingSnapshots: SessionRecord["pendingSettledSnapshots"] = [];

  for (const pendingSnapshot of record.pendingSettledSnapshots) {
    const remainingQuietMs = pendingSnapshot.settleForMs - quietForMs;
    if (remainingQuietMs <= 0) {
      send({
        type: "snapshot",
        requestId: pendingSnapshot.requestId,
        payload: snapshot(record, {
          includeRawOutputTail: pendingSnapshot.includeRawOutputTail
        })
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

function disposeSettledSnapshotState(record: SessionRecord): void {
  if (record.settledSnapshotTimer) {
    clearTimeout(record.settledSnapshotTimer);
    record.settledSnapshotTimer = null;
  }
  record.pendingSettledSnapshots = [];
}
