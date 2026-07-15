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

export type PtyResizeCommitReason =
  | "isolated"
  | "row-only"
  | "gesture-release"
  | "gesture-hold-safety"
  | "storm-settled";

export type PtyResizeRequestDecision =
  | "already-committed"
  | "pending-cancelled"
  | "gesture-held"
  | "gesture-released"
  | "row-only-committed"
  | "isolated-committed"
  | "storm-deferred";

export interface PtyResizeCommitContext {
  reason: PtyResizeCommitReason;
  requestId?: string;
  requestedAt: number;
  committedAt: number;
  requestObserved: boolean;
  previousCols: number;
  previousRows: number;
}

export interface PtyResizeRequestEvent {
  requestId?: string;
  requestedAt: number;
  cols: number;
  rows: number;
  hold: boolean;
  quietBefore: boolean;
  decision: PtyResizeRequestDecision;
  committedCols: number;
  committedRows: number;
  pendingCols: number | null;
  pendingRows: number | null;
}

export interface PtyResizeCoalescerState {
  disposed: boolean;
  committedCols: number;
  committedRows: number;
  pendingCols: number | null;
  pendingRows: number | null;
  pendingRequestId: string | null;
  heldByGesture: boolean;
}

export interface PtyResizeCoalescerOptions {
  initialCols: number;
  initialRows: number;
  commit: (
    cols: number,
    rows: number,
    context: PtyResizeCommitContext | undefined
  ) => void;
  onRequest?: (event: PtyResizeRequestEvent) => void;
  /** Keeps diagnostic allocations out of the normal resize path when false. */
  diagnosticsEnabled?: () => boolean;
  settleMs?: number;
  holdSafetyMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface PtyResizeCoalescer {
  request(
    cols: number,
    rows: number,
    options?: { hold?: boolean; requestId?: string }
  ): void;
  getState(): PtyResizeCoalescerState;
  dispose(): void;
}

export function createPtyResizeCoalescer({
  initialCols,
  initialRows,
  commit,
  onRequest,
  diagnosticsEnabled = () => false,
  settleMs = DEFAULT_PTY_RESIZE_SETTLE_MS,
  holdSafetyMs = DEFAULT_PTY_RESIZE_HOLD_SAFETY_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}: PtyResizeCoalescerOptions): PtyResizeCoalescer {
  let committedCols = initialCols;
  let committedRows = initialRows;
  let pending: {
    cols: number;
    rows: number;
    diagnostics?: {
      requestId?: string;
      requestedAt: number;
    };
  } | null = null;
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

  const recordRequest = (
    cols: number,
    rows: number,
    hold: boolean,
    quietBefore: boolean,
    diagnostics:
      | {
          requestId?: string;
          requestedAt: number;
        }
      | undefined,
    decision: PtyResizeRequestDecision
  ): void => {
    if (!onRequest || !diagnostics) {
      return;
    }
    try {
      onRequest({
        requestId: diagnostics.requestId,
        requestedAt: diagnostics.requestedAt,
        cols,
        rows,
        hold,
        quietBefore,
        decision,
        committedCols,
        committedRows,
        pendingCols: pending?.cols ?? null,
        pendingRows: pending?.rows ?? null
      });
    } catch {
      // Diagnostics must never affect PTY resize behavior.
    }
  };

  const commitNow = (
    cols: number,
    rows: number,
    diagnostics:
      | {
          requestId?: string;
          requestedAt: number;
        }
      | undefined,
    reason: PtyResizeCommitReason
  ): void => {
    clearTimer();
    pending = null;
    heldByGesture = false;
    if (cols === committedCols && rows === committedRows) {
      return;
    }
    const previousCols = committedCols;
    const previousRows = committedRows;
    committedCols = cols;
    committedRows = rows;
    let context: PtyResizeCommitContext | undefined;
    if (diagnosticsEnabled()) {
      const committedAt = now();
      context = {
        reason,
        requestId: diagnostics?.requestId,
        requestedAt: diagnostics?.requestedAt ?? committedAt,
        committedAt,
        requestObserved: Boolean(diagnostics),
        previousCols,
        previousRows
      };
    }
    commit(cols, rows, context);
  };

  const scheduleCommit = (
    delayMs: number,
    reason: "gesture-hold-safety" | "storm-settled"
  ): void => {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      if (disposed || !pending) {
        return;
      }
      const request = pending;
      commitNow(request.cols, request.rows, request.diagnostics, reason);
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  };

  return {
    request(
      cols: number,
      rows: number,
      options?: { hold?: boolean; requestId?: string }
    ): void {
      if (disposed) {
        return;
      }
      const requestedAt = now();
      const quietBefore = requestedAt - lastRequestAt >= settleMs;
      lastRequestAt = requestedAt;
      const hold = options?.hold === true;
      const diagnostics = diagnosticsEnabled()
        ? { requestId: options?.requestId, requestedAt }
        : undefined;

      if (cols === committedCols && rows === committedRows) {
        // The grid moved back to the committed size; drop any pending change.
        const hadPending = pending !== null;
        clearTimer();
        pending = null;
        heldByGesture = false;
        recordRequest(
          cols,
          rows,
          hold,
          quietBefore,
          diagnostics,
          hadPending ? "pending-cancelled" : "already-committed"
        );
        return;
      }
      if (options?.hold) {
        // Gesture in progress: never settle by timing, only re-arm the
        // safety net. The gesture-end request (hold=false) releases this.
        pending = diagnostics ? { cols, rows, diagnostics } : { cols, rows };
        heldByGesture = true;
        recordRequest(
          cols,
          rows,
          hold,
          quietBefore,
          diagnostics,
          "gesture-held"
        );
        scheduleCommit(holdSafetyMs, "gesture-hold-safety");
        return;
      }
      if (heldByGesture) {
        // First request after a gesture ends: release the held size right
        // away so the app repaints at the moment the drag is dropped.
        recordRequest(
          cols,
          rows,
          hold,
          quietBefore,
          diagnostics,
          "gesture-released"
        );
        commitNow(cols, rows, diagnostics, "gesture-release");
        return;
      }
      if (cols === committedCols) {
        // Row-only changes don't re-wrap content, so TUIs handle them without
        // transcript re-prints; pass them through for prompt height tracking.
        recordRequest(
          cols,
          rows,
          hold,
          quietBefore,
          diagnostics,
          "row-only-committed"
        );
        commitNow(cols, rows, diagnostics, "row-only");
        return;
      }
      if (quietBefore) {
        // Isolated resizes (pane split/zoom/close, window snap) commit
        // immediately: the intermediate-width re-print concern only applies
        // to request storms, and known gestures are flagged with hold.
        recordRequest(
          cols,
          rows,
          hold,
          quietBefore,
          diagnostics,
          "isolated-committed"
        );
        commitNow(cols, rows, diagnostics, "isolated");
        return;
      }
      // Unflagged storms (e.g. window live-resize) wait for settle: a
      // re-print at an intermediate width leaves permanently mis-wrapped
      // duplicates in scrollback.
      pending = diagnostics ? { cols, rows, diagnostics } : { cols, rows };
      recordRequest(
        cols,
        rows,
        hold,
        quietBefore,
        diagnostics,
        "storm-deferred"
      );
      scheduleCommit(settleMs, "storm-settled");
    },
    getState(): PtyResizeCoalescerState {
      return {
        disposed,
        committedCols,
        committedRows,
        pendingCols: pending?.cols ?? null,
        pendingRows: pending?.rows ?? null,
        pendingRequestId: pending?.diagnostics?.requestId ?? null,
        heldByGesture
      };
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      pending = null;
      heldByGesture = false;
    }
  };
}
