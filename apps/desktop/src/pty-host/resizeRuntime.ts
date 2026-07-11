interface ResizableTerminal {
  resize(cols: number, rows: number): void;
}

interface PtyResizeSink {
  request(cols: number, rows: number, options?: { hold?: boolean }): void;
}

interface ResizeSessionRecord {
  cols: number;
  rows: number;
  terminal: ResizableTerminal;
  ptyResize: PtyResizeSink;
}

export function prepareTerminalResize(options: {
  record: ResizeSessionRecord;
  cols: number;
  rows: number;
  gestureActive?: boolean;
}): boolean {
  const { record, cols, rows, gestureActive } = options;
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
