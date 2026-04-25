interface ResizableTerminal {
  resize(cols: number, rows: number): void;
}

interface ResizablePty {
  resize(cols: number, rows: number): void;
}

interface ResizeSessionRecord {
  sessionId: string;
  cols: number;
  rows: number;
  terminal: ResizableTerminal;
  pty: ResizablePty;
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
