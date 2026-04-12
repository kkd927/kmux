import * as pty from "node-pty";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import type {
  Id,
  PtyEvent,
  PtyRequest,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import type {
  ITerminalInitOnlyOptions as HeadlessTerminalInitOptions,
  ITerminalOptions as HeadlessTerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";

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
  pty: pty.IPty;
  terminal: HeadlessTerminal;
  serialize: SerializeAddon;
  sequence: number;
  cols: number;
  rows: number;
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

function parseOsc7(data: string): string | undefined {
  if (!data.startsWith("file://")) {
    return undefined;
  }
  const url = new URL(data);
  return decodeURIComponent(url.pathname);
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

function spawnSession(request: Extract<PtyRequest, { type: "spawn" }>): void {
  const shell = request.spec.launch.shell || process.env.SHELL || "/bin/zsh";
  const ptyProcess = pty.spawn(shell, request.spec.launch.args ?? [], {
    name: "xterm-256color",
    cols: request.spec.cols,
    rows: request.spec.rows,
    cwd: request.spec.launch.cwd ?? process.env.HOME,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      ...(request.spec.launch.env ?? {}),
      ...request.spec.env
    }
  });
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
    rows: request.spec.rows
  };
  sessions.set(record.sessionId, record);

  terminal.parser.registerOscHandler(7, (data: string) => {
    const cwd = parseOsc7(data);
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
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
  });
  terminal.parser.registerOscHandler(9, () => {
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
    return true;
  });
  terminal.parser.registerOscHandler(99, () => {
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
    return true;
  });
  terminal.parser.registerOscHandler(777, () => {
    send({
      type: "bell",
      surfaceId: record.surfaceId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd
    });
    return true;
  });

  ptyProcess.onData((chunk) => {
    record.sequence += 1;
    terminal.write(chunk);
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
      sessions.get(request.sessionId)?.pty.kill();
      sessions.delete(request.sessionId);
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
        send({
          type: "snapshot",
          requestId: request.requestId,
          payload: snapshot(record)
        });
      }
      break;
    }
    default:
      break;
  }
});

send({ type: "ready" });
