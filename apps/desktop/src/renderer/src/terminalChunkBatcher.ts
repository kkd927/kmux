// Live PTY chunks reach the renderer faster than a write-await-write loop
// can drain them: waiting for each chunk's xterm write callback before
// issuing the next one costs at least a task-queue turn per chunk, which
// caps drain throughput near one chunk per frame while an agent CLI is
// streaming. The pty keeps producing, so the display backlog grows without
// bound and everything ordered behind it (resize barrier application, key
// echo) appears minutes late.
//
// This batcher keeps the operation-queue ordering contract — a resize or
// exit operation enqueued after a set of chunks still applies after those
// chunks are parsed — while letting xterm's write buffer do the batching:
// every chunk that accumulated while the operation waited its turn is
// issued back-to-back in one turn, and only the final chunk's callback is
// awaited before the operation completes. Per-chunk cwd ranges stay exact
// by reading buffer positions inside each chunk's parse callback instead of
// before each write.
export interface TerminalChunkBatcherPayload {
  surfaceId: string;
  sessionId: string;
  sequence: number;
  chunk: string;
  cwd?: string;
}

export interface TerminalChunkWriteRange {
  startLine: number;
  endLine: number;
  cwd?: string;
}

export interface TerminalChunkBatcherOptions<
  P extends TerminalChunkBatcherPayload
> {
  enqueueOperation: (operation: () => Promise<void> | void) => void;
  isCurrentEvent: (payload: P) => boolean;
  // Fire-and-forget write used for every chunk except the last of a batch;
  // a false return means the write was dropped (stale terminal), matching
  // the drop semantics of the awaited path.
  writeChunk: (payload: P, afterParsed: () => void) => boolean;
  // Timeout-guarded write used for the final chunk of a batch; the batch
  // operation completes when this resolves.
  waitForFinalChunkWrite: (
    payload: P,
    afterParsed: () => void
  ) => Promise<boolean>;
  readCursorLine: () => number;
  readTrimmedLineCount: () => number;
  recordWrite: (range: TerminalChunkWriteRange) => void;
  onBatchRendered: (lastParsedPayload: P) => void;
  // Backlog safety valve: when the chars (UTF-16 units) waiting to be handed
  // to xterm exceed this limit, onBacklogExceeded fires once; it re-arms
  // after the backlog drains below half the limit. Agent CLI output never
  // accumulates this much - only pathological floods (yes, cat of huge
  // files) whose parse cost outruns the renderer reach it.
  backlogLimitChars?: number;
  onBacklogExceeded?: () => void;
}

export interface TerminalChunkBatcher<P extends TerminalChunkBatcherPayload> {
  enqueue(payload: P): void;
  // Ends the current batch so chunks arriving later join a new operation
  // enqueued behind whatever the caller enqueues next (resize, exit).
  seal(): void;
  // Drops every batch whose operation has not started yet. Chunks already
  // handed to xterm cannot be recalled; callers skipping ahead to a fresh
  // snapshot rely on sequence gating in isCurrentEvent to reject stragglers.
  discardPending(): void;
}

export function createTerminalChunkBatcher<
  P extends TerminalChunkBatcherPayload
>(options: TerminalChunkBatcherOptions<P>): TerminalChunkBatcher<P> {
  let tailBatch: P[] | null = null;
  const pendingBatches = new Set<P[]>();
  let pendingChars = 0;
  let backlogNotified = false;

  const batchChars = (batch: P[]): number =>
    batch.reduce((total, payload) => total + payload.chunk.length, 0);

  const trackEnqueued = (payload: P): void => {
    pendingChars += payload.chunk.length;
    const limit = options.backlogLimitChars;
    if (limit === undefined || pendingChars <= limit) {
      return;
    }
    if (backlogNotified) {
      return;
    }
    backlogNotified = true;
    options.onBacklogExceeded?.();
  };

  const releasePendingChars = (chars: number): void => {
    pendingChars = Math.max(0, pendingChars - chars);
    const limit = options.backlogLimitChars;
    if (limit !== undefined && pendingChars < limit / 2) {
      backlogNotified = false;
    }
  };

  const drainBatch = async (batch: P[]): Promise<void> => {
    const payloads = batch.filter((payload) => options.isCurrentEvent(payload));
    if (payloads.length === 0) {
      return;
    }
    let trimCountBefore = options.readTrimmedLineCount();
    let startLine = options.readCursorLine();
    let lastParsed: P | null = null;
    const afterParsed = (payload: P): void => {
      const trimDuringWrite =
        options.readTrimmedLineCount() - trimCountBefore;
      const endLine = options.readCursorLine();
      if (options.isCurrentEvent(payload)) {
        options.recordWrite({
          startLine: startLine - trimDuringWrite,
          endLine,
          cwd: payload.cwd
        });
        lastParsed = payload;
      }
      startLine = endLine;
      trimCountBefore = options.readTrimmedLineCount();
    };
    for (let index = 0; index < payloads.length - 1; index += 1) {
      const payload = payloads[index];
      options.writeChunk(payload, () => afterParsed(payload));
    }
    const finalPayload = payloads[payloads.length - 1];
    await options.waitForFinalChunkWrite(finalPayload, () =>
      afterParsed(finalPayload)
    );
    if (lastParsed !== null) {
      options.onBatchRendered(lastParsed);
    }
  };

  return {
    enqueue(payload: P): void {
      if (tailBatch) {
        tailBatch.push(payload);
        trackEnqueued(payload);
        return;
      }
      const batch: P[] = [payload];
      tailBatch = batch;
      pendingBatches.add(batch);
      trackEnqueued(payload);
      options.enqueueOperation(() => {
        // Close the batch when its turn starts: chunks arriving during the
        // drain belong to a new operation queued behind this one.
        if (tailBatch === batch) {
          tailBatch = null;
        }
        if (!pendingBatches.delete(batch)) {
          // The batch was discarded while it waited its turn.
          return;
        }
        releasePendingChars(batchChars(batch));
        return drainBatch(batch);
      });
    },
    seal(): void {
      tailBatch = null;
    },
    discardPending(): void {
      for (const batch of pendingBatches) {
        releasePendingChars(batchChars(batch));
      }
      pendingBatches.clear();
      tailBatch = null;
    }
  };
}
