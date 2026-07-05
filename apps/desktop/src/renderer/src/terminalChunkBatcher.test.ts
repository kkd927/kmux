import { describe, expect, it } from "vitest";

import {
  createTerminalChunkBatcher,
  type TerminalChunkBatcherPayload,
  type TerminalChunkWriteRange
} from "./terminalChunkBatcher";

interface Harness {
  batcher: ReturnType<
    typeof createTerminalChunkBatcher<TerminalChunkBatcherPayload>
  >;
  operations: Array<() => Promise<void> | void>;
  runNextOperation: () => Promise<void>;
  issuedChunks: string[];
  parseNext: (linesAdvanced?: number, trimmed?: number) => void;
  parseAll: () => void;
  recordedRanges: TerminalChunkWriteRange[];
  renderedPayloads: TerminalChunkBatcherPayload[];
  setStale: (sequence: number) => void;
  dropWrites: () => void;
  backlogExceededCount: () => number;
}

interface HarnessOptions {
  backlogLimitChars?: number;
}

function chunkPayload(
  sequence: number,
  overrides: Partial<TerminalChunkBatcherPayload> = {}
): TerminalChunkBatcherPayload {
  return {
    surfaceId: "surface_1",
    sessionId: "session_1",
    sequence,
    chunk: `chunk-${sequence}`,
    ...overrides
  };
}

function createHarness(harnessOptions: HarnessOptions = {}): Harness {
  const operations: Array<() => Promise<void> | void> = [];
  const issuedChunks: string[] = [];
  const pendingParses: Array<() => void> = [];
  const recordedRanges: TerminalChunkWriteRange[] = [];
  const renderedPayloads: TerminalChunkBatcherPayload[] = [];
  const staleSequences = new Set<number>();
  let cursorLine = 0;
  let trimmedLineCount = 0;
  let writesDropped = false;
  let backlogExceeded = 0;

  const issueWrite = (
    payload: TerminalChunkBatcherPayload,
    afterParsed: () => void
  ): boolean => {
    if (writesDropped) {
      issuedChunks.push(`${payload.chunk}:dropped`);
      return false;
    }
    issuedChunks.push(payload.chunk);
    pendingParses.push(afterParsed);
    return true;
  };

  const batcher = createTerminalChunkBatcher<TerminalChunkBatcherPayload>({
    enqueueOperation: (operation) => {
      operations.push(operation);
    },
    isCurrentEvent: (payload) => !staleSequences.has(payload.sequence),
    writeChunk: issueWrite,
    waitForFinalChunkWrite: (payload, afterParsed) =>
      Promise.resolve(issueWrite(payload, afterParsed)),
    readCursorLine: () => cursorLine,
    readTrimmedLineCount: () => trimmedLineCount,
    recordWrite: (range) => {
      recordedRanges.push(range);
    },
    onBatchRendered: (payload) => {
      renderedPayloads.push(payload);
    },
    ...(harnessOptions.backlogLimitChars !== undefined
      ? {
          backlogLimitChars: harnessOptions.backlogLimitChars,
          onBacklogExceeded: () => {
            backlogExceeded += 1;
          }
        }
      : {})
  });

  return {
    batcher,
    operations,
    runNextOperation: async () => {
      const operation = operations.shift();
      if (!operation) {
        throw new Error("no queued operation");
      }
      await operation();
    },
    issuedChunks,
    parseNext: (linesAdvanced = 1, trimmed = 0) => {
      const parse = pendingParses.shift();
      if (!parse) {
        throw new Error("no pending parse");
      }
      cursorLine += linesAdvanced;
      trimmedLineCount += trimmed;
      parse();
    },
    parseAll: () => {
      while (pendingParses.length > 0) {
        const parse = pendingParses.shift();
        cursorLine += 1;
        parse?.();
      }
    },
    recordedRanges,
    renderedPayloads,
    setStale: (sequence) => {
      staleSequences.add(sequence);
    },
    dropWrites: () => {
      writesDropped = true;
    },
    backlogExceededCount: () => backlogExceeded
  };
}

describe("terminal chunk batcher", () => {
  it("drains chunks that accumulate behind one queued operation together", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.enqueue(chunkPayload(2));
    harness.batcher.enqueue(chunkPayload(3));

    expect(harness.operations).toHaveLength(1);

    const drained = harness.runNextOperation();
    expect(harness.issuedChunks).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
    harness.parseAll();
    await drained;

    expect(harness.renderedPayloads.map((payload) => payload.sequence)).toEqual(
      [3]
    );
  });

  it("records one cwd range per chunk using positions read after each parse", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1, { cwd: "/one" }));
    harness.batcher.enqueue(chunkPayload(2, { cwd: "/two" }));

    const drained = harness.runNextOperation();
    harness.parseNext(3);
    harness.parseNext(2);
    await drained;

    expect(harness.recordedRanges).toEqual([
      { startLine: 0, endLine: 3, cwd: "/one" },
      { startLine: 3, endLine: 5, cwd: "/two" }
    ]);
  });

  it("subtracts scrollback trims that happen during a chunk's parse", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.enqueue(chunkPayload(2));

    const drained = harness.runNextOperation();
    harness.parseNext(1, 4);
    harness.parseNext(1, 2);
    await drained;

    expect(harness.recordedRanges).toEqual([
      { startLine: -4, endLine: 1, cwd: undefined },
      { startLine: -1, endLine: 2, cwd: undefined }
    ]);
  });

  it("starts a new operation for chunks that arrive after a seal", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.seal();
    harness.operations.push(() => {
      harness.issuedChunks.push("resize");
    });
    harness.batcher.enqueue(chunkPayload(2));

    expect(harness.operations).toHaveLength(3);

    const first = harness.runNextOperation();
    harness.parseAll();
    await first;
    await harness.runNextOperation();
    const second = harness.runNextOperation();
    harness.parseAll();
    await second;

    expect(harness.issuedChunks).toEqual(["chunk-1", "resize", "chunk-2"]);
  });

  it("starts a new operation for chunks that arrive while a batch drains", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));

    const first = harness.runNextOperation();
    harness.batcher.enqueue(chunkPayload(2));
    harness.parseAll();
    await first;

    expect(harness.operations).toHaveLength(1);
    const second = harness.runNextOperation();
    harness.parseAll();
    await second;

    expect(harness.issuedChunks).toEqual(["chunk-1", "chunk-2"]);
  });

  it("skips payloads that went stale before the batch drained", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.enqueue(chunkPayload(2));
    harness.setStale(1);

    const drained = harness.runNextOperation();
    harness.parseAll();
    await drained;

    expect(harness.issuedChunks).toEqual(["chunk-2"]);
    expect(harness.renderedPayloads.map((payload) => payload.sequence)).toEqual(
      [2]
    );
  });

  it("completes without rendering when every payload is stale", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.setStale(1);

    await harness.runNextOperation();

    expect(harness.issuedChunks).toEqual([]);
    expect(harness.renderedPayloads).toEqual([]);
  });

  it("keeps issuing the rest of a batch when a write is dropped", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.enqueue(chunkPayload(2));
    harness.dropWrites();

    await harness.runNextOperation();

    expect(harness.issuedChunks).toEqual([
      "chunk-1:dropped",
      "chunk-2:dropped"
    ]);
    expect(harness.renderedPayloads).toEqual([]);
    expect(harness.recordedRanges).toEqual([]);
  });

  it("reports the last still-current payload when a later one goes stale mid-drain", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));
    harness.batcher.enqueue(chunkPayload(2));

    const drained = harness.runNextOperation();
    harness.parseNext();
    harness.setStale(2);
    harness.parseNext();
    await drained;

    expect(harness.renderedPayloads.map((payload) => payload.sequence)).toEqual(
      [1]
    );
  });

  it("fires the backlog signal once when pending chars cross the limit", () => {
    const harness = createHarness({ backlogLimitChars: 16 });
    harness.batcher.enqueue(chunkPayload(1, { chunk: "0123456789" }));
    expect(harness.backlogExceededCount()).toBe(0);

    harness.batcher.enqueue(chunkPayload(2, { chunk: "0123456789" }));
    expect(harness.backlogExceededCount()).toBe(1);

    harness.batcher.enqueue(chunkPayload(3, { chunk: "0123456789" }));
    expect(harness.backlogExceededCount()).toBe(1);
  });

  it("re-arms the backlog signal after the pending chars drain", async () => {
    const harness = createHarness({ backlogLimitChars: 16 });
    harness.batcher.enqueue(chunkPayload(1, { chunk: "0123456789" }));
    harness.batcher.enqueue(chunkPayload(2, { chunk: "0123456789" }));
    expect(harness.backlogExceededCount()).toBe(1);

    const drained = harness.runNextOperation();
    harness.parseAll();
    await drained;

    harness.batcher.enqueue(chunkPayload(3, { chunk: "0123456789" }));
    harness.batcher.enqueue(chunkPayload(4, { chunk: "0123456789" }));
    expect(harness.backlogExceededCount()).toBe(2);
  });

  it("discards batches whose operation has not started yet", async () => {
    const harness = createHarness();
    harness.batcher.enqueue(chunkPayload(1));

    const first = harness.runNextOperation();
    harness.batcher.enqueue(chunkPayload(2));
    harness.batcher.discardPending();
    harness.parseAll();
    await first;

    await harness.runNextOperation();

    expect(harness.issuedChunks).toEqual(["chunk-1"]);
    harness.batcher.enqueue(chunkPayload(3));
    const next = harness.runNextOperation();
    harness.parseAll();
    await next;
    expect(harness.issuedChunks).toEqual(["chunk-1", "chunk-3"]);
  });
});
