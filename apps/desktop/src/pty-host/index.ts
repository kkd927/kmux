import type {
  ITerminalInitOnlyOptions as HeadlessTerminalInitOptions,
  ITerminalOptions as HeadlessTerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import type {
  Id,
  PtyEvent,
  PtyRequest,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import type * as PtyModule from "node-pty";
import { loadNodePty } from "./nodePtyLoader";
import {
  buildOsc9Notification,
  buildOsc777Notification,
  parseOsc99Notification,
  type Osc99NotificationState
} from "./terminalNotifications";
import { resolveOsc7Cwd } from "./osc7";
import {
  prepareShellIntegrationLaunch,
  shouldApplyShellIntegration
} from "./shellIntegration";
import {
  resolveDefaultShellArgs,
  shouldStripShellManagedEnv
} from "./shellLaunch";
import { buildSessionEnv } from "./sessionEnv";

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
  sequence: number;
  cols: number;
  rows: number;
  osc99State: Osc99NotificationState;
  lastActivityAt: number;
  pendingSettledSnapshots: Array<{
    requestId: Id;
    settleForMs: number;
  }>;
  settledSnapshotTimer: NodeJS.Timeout | null;
}

const sessions = new Map<Id, SessionRecord>();

function send(message: PtyEvent): void {
  if (process.send) {
    process.send(message);
  }
}

function encodeKey(input: TerminalKeyInput): string {
  switch (input.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\u007f";
    case "Tab":
      return "\t";
    case "ArrowUp":
      return "\u001b[A";
    case "ArrowDown":
      return "\u001b[B";
    case "ArrowRight":
      return "\u001b[C";
    case "ArrowLeft":
      return "\u001b[D";
    case "Escape":
      return "\u001b";
    default:
      return input.text ?? input.key;
  }
}

function snapshot(record: SessionRecord): SurfaceSnapshotPayload {
  return {
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    sequence: record.sequence,
    vt: record.serialize.serialize({ scrollback: 5000 }),
    title: record.title,
    cwd: record.cwd,
    branch: undefined,
    ports: [],
    unreadCount: 0,
    attention: false
  };
}

function sendTerminalNotification(
  record: SessionRecord,
  protocol: 9 | 99 | 777,
  title?: string,
  message?: string
): void {
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
    scrollback: 5000
  });
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);

  const record: SessionRecord = {
    sessionId: request.spec.sessionId,
    surfaceId: request.spec.surfaceId,
    cwd: request.spec.launch.cwd,
    title: request.spec.launch.title || request.spec.surfaceId,
    pty: ptyProcess,
    terminal,
    serialize,
    sequence: 0,
    cols: request.spec.cols,
    rows: request.spec.rows,
    osc99State: {},
    lastActivityAt: Date.now(),
    pendingSettledSnapshots: [],
    settledSnapshotTimer: null
  };
  sessions.set(record.sessionId, record);

  terminal.parser.registerOscHandler(7, (data: string) => {
    console.log(`[OSC 7] surface=${record.surfaceId} title=${record.title} data=${JSON.stringify(data)}`);
    const cwd = resolveOsc7Cwd(record.cwd, data);
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
    console.log(`[Bell] surface=${record.surfaceId} title=${record.title}`);
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
  });
  terminal.parser.registerOscHandler(9, (data: string) => {
    console.log(`[OSC 9] surface=${record.surfaceId} title=${record.title} data=${JSON.stringify(data)}`);
    const notification = buildOsc9Notification(data, record.title);
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
    console.log(`[OSC 99] surface=${record.surfaceId} title=${record.title} data=${JSON.stringify(data)}`);
    const { nextState, notification } = parseOsc99Notification(
      data,
      record.osc99State,
      record.title
    );
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
    console.log(`[OSC 777] surface=${record.surfaceId} title=${record.title} data=${JSON.stringify(data)}`);
    const notification = buildOsc777Notification(
      data,
      record.title,
      record.cwd
    );
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
    record.sequence += 1;
    record.lastActivityAt = Date.now();
    terminal.write(chunk);
    scheduleSettledSnapshotCheck(record);
    send({
      type: "chunk",
      payload: {
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        sequence: record.sequence,
        chunk
      }
    });
  });
  ptyProcess.onExit(({ exitCode }) => {
    disposeSettledSnapshotState(record);
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

  send({
    type: "spawned",
    sessionId: record.sessionId,
    pid: ptyProcess.pid
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
        disposeSettledSnapshotState(record);
        record.pty.kill();
        sessions.delete(request.sessionId);
      }
      break;
    case "resize":
      {
        const record = sessions.get(request.sessionId);
        if (
          !record ||
          request.cols <= 0 ||
          request.rows <= 0 ||
          (record.cols === request.cols && record.rows === request.rows)
        ) {
          break;
        }
        record.cols = request.cols;
        record.rows = request.rows;
        record.terminal.resize(request.cols, request.rows);
        record.pty.resize(request.cols, request.rows);
      }
      break;
    case "input:text":
      sessions.get(request.sessionId)?.pty.write(request.text);
      break;
    case "input:key":
      sessions.get(request.sessionId)?.pty.write(encodeKey(request.input));
      break;
    case "snapshot": {
      const record = sessions.get(request.sessionId);
      if (record) {
        if ((request.settleForMs ?? 0) > 0) {
          record.pendingSettledSnapshots.push({
            requestId: request.requestId,
            settleForMs: request.settleForMs ?? 0
          });
          scheduleSettledSnapshotCheck(record);
        } else {
          send({
            type: "snapshot",
            requestId: request.requestId,
            payload: snapshot(record)
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
        payload: snapshot(record)
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
