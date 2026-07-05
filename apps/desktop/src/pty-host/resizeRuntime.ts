import type { Id, SurfaceResizePayload } from "@kmux/proto";

interface ResizableTerminal {
  resize(cols: number, rows: number): void;
}

interface PtyResizeSink {
  request(cols: number, rows: number, options?: { hold?: boolean }): void;
}

interface ResizeSessionRecord {
  sessionId: Id;
  surfaceId: Id;
  cols: number;
  rows: number;
  terminal: ResizableTerminal;
  ptyResize: PtyResizeSink;
}

interface TerminalResizeAckPayload {
  sessionId: Id;
  requestId: Id;
  cols: number;
  rows: number;
}

export function prepareTerminalResize(options: {
  record: ResizeSessionRecord;
  cols: number;
  rows: number;
  gestureActive?: boolean;
  flushOutput: (sessionId: string) => void;
}): boolean {
  const { record, cols, rows, gestureActive, flushOutput } = options;
  flushOutput(record.sessionId);
  // The PTY sink is told about every request — including grid no-ops —
  // because the actual PTY size may lag behind the grid while the sink
  // coalesces SIGWINCH commits: a gesture-end request that repeats the grid
  // size is what releases a held commit.
  record.ptyResize.request(cols, rows, { hold: gestureActive === true });
  if (record.cols === cols && record.rows === rows) {
    return false;
  }
  record.cols = cols;
  record.rows = rows;
  // record.cols/rows track the headless grid; snapshots and the resize
  // barrier read them.
  record.terminal.resize(cols, rows);
  return true;
}

export function handleTerminalResizeRequest(options: {
  record?: ResizeSessionRecord;
  sessionId: Id;
  attachId?: Id;
  requestId?: Id;
  cols: number;
  rows: number;
  gestureActive?: boolean;
  flushOutput: (sessionId: Id) => void;
  emitResize: (payload: SurfaceResizePayload) => void;
  emitAck: (payload: TerminalResizeAckPayload) => void;
}): void {
  const {
    record,
    sessionId,
    attachId,
    requestId,
    cols,
    rows,
    gestureActive,
    flushOutput,
    emitResize,
    emitAck
  } = options;

  if (!record || cols <= 0 || rows <= 0) {
    if (requestId) {
      emitAck({
        sessionId,
        requestId,
        cols: record?.cols ?? 0,
        rows: record?.rows ?? 0
      });
    }
    return;
  }

  prepareTerminalResize({
    record,
    cols,
    rows,
    gestureActive,
    flushOutput
  });

  // Even no-op PTY resizes need this barrier; the visible xterm may be stale.
  emitResize({
    surfaceId: record.surfaceId,
    sessionId: record.sessionId,
    ...(attachId ? { attachId } : {}),
    cols: record.cols,
    rows: record.rows
  });

  if (requestId) {
    emitAck({
      sessionId: record.sessionId,
      requestId,
      cols: record.cols,
      rows: record.rows
    });
  }
}
