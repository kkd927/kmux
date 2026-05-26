import type { Id, SurfaceResizePayload } from "@kmux/proto";

interface ResizableTerminal {
  resize(cols: number, rows: number): void;
}

interface ResizablePty {
  resize(cols: number, rows: number): void;
}

interface ResizeSessionRecord {
  sessionId: Id;
  surfaceId: Id;
  cols: number;
  rows: number;
  terminal: ResizableTerminal;
  pty: ResizablePty;
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
  flushOutput: (sessionId: string) => void;
}): boolean {
  const { record, cols, rows, flushOutput } = options;
  flushOutput(record.sessionId);
  if (record.cols === cols && record.rows === rows) {
    return false;
  }
  record.cols = cols;
  record.rows = rows;
  record.terminal.resize(cols, rows);
  record.pty.resize(cols, rows);
  return true;
}

export function handleTerminalResizeRequest(options: {
  record?: ResizeSessionRecord;
  sessionId: Id;
  attachId?: Id;
  requestId?: Id;
  cols: number;
  rows: number;
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
