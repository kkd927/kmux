// During a resize gesture (divider/sidebar/window drag) the renderer streams
// a resize request per fit step. The headless terminal and the resize barrier
// follow every step so the visible grid stays true, but committing each step
// to the PTY sends a SIGWINCH storm at the foreground TUI: coding-agent CLIs
// (claude, codex) respond by re-rendering their transcript per step, which
// floods the write pipeline and permanently duplicates re-wrapped blocks in
// scrollback. Every committed width is one re-print, so column changes are
// held until the requests settle and a gesture costs the TUI exactly one
// redraw at the final size. Row-only changes pass through: they do not
// re-wrap content, so TUIs handle them without transcript re-prints.
//
// Requests flagged hold=true come from an explicitly-known active gesture
// (divider/sidebar drag): they never settle by timing alone, because a user
// pausing mid-drag would otherwise leak a commit. The gesture end produces a
// final hold=false request that releases the held size; a long safety timer
// covers a lost release (e.g. renderer teardown mid-drag).
const DEFAULT_PTY_RESIZE_SETTLE_MS = 300;
const DEFAULT_PTY_RESIZE_HOLD_SAFETY_MS = 1500;

export interface PtyResizeCoalescerOptions {
  initialCols: number;
  initialRows: number;
  commit: (cols: number, rows: number) => void;
  settleMs?: number;
  holdSafetyMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface PtyResizeCoalescer {
  request(cols: number, rows: number, options?: { hold?: boolean }): void;
  dispose(): void;
}

export function createPtyResizeCoalescer({
  initialCols,
  initialRows,
  commit,
  settleMs = DEFAULT_PTY_RESIZE_SETTLE_MS,
  holdSafetyMs = DEFAULT_PTY_RESIZE_HOLD_SAFETY_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}: PtyResizeCoalescerOptions): PtyResizeCoalescer {
  let committedCols = initialCols;
  let committedRows = initialRows;
  let pending: { cols: number; rows: number } | null = null;
  let heldByGesture = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const commitNow = (cols: number, rows: number): void => {
    clearTimer();
    pending = null;
    heldByGesture = false;
    if (cols === committedCols && rows === committedRows) {
      return;
    }
    committedCols = cols;
    committedRows = rows;
    commit(cols, rows);
  };

  const scheduleCommit = (delayMs: number): void => {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      if (disposed || !pending) {
        return;
      }
      const { cols, rows } = pending;
      commitNow(cols, rows);
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  };

  return {
    request(cols: number, rows: number, options?: { hold?: boolean }): void {
      if (disposed) {
        return;
      }
      const quietBefore = now() - lastRequestAt >= settleMs;
      lastRequestAt = now();

      if (cols === committedCols && rows === committedRows) {
        // The grid moved back to the committed size; drop any pending change.
        clearTimer();
        pending = null;
        heldByGesture = false;
        return;
      }
      if (options?.hold) {
        // Gesture in progress: never settle by timing, only re-arm the
        // safety net. The gesture-end request (hold=false) releases this.
        pending = { cols, rows };
        heldByGesture = true;
        scheduleCommit(holdSafetyMs);
        return;
      }
      if (heldByGesture) {
        // First request after a gesture ends: release the held size right
        // away so the app repaints at the moment the drag is dropped.
        commitNow(cols, rows);
        return;
      }
      if (cols === committedCols) {
        // Row-only changes don't re-wrap content, so TUIs handle them without
        // transcript re-prints; pass them through for prompt height tracking.
        commitNow(cols, rows);
        return;
      }
      if (quietBefore) {
        // Isolated resizes (pane split/zoom/close, window snap) commit
        // immediately: the intermediate-width re-print concern only applies
        // to request storms, and known gestures are flagged with hold.
        commitNow(cols, rows);
        return;
      }
      // Unflagged storms (e.g. window live-resize) wait for settle: a
      // re-print at an intermediate width leaves permanently mis-wrapped
      // duplicates in scrollback.
      pending = { cols, rows };
      scheduleCommit(settleMs);
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      pending = null;
    }
  };
}
