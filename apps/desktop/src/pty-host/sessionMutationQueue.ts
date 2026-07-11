export interface SessionOutputMutation<T> {
  value: T;
  bytes: number;
}

export interface SessionMutationQueueOptions<T> {
  maxOutputRunBytes: number;
  highWatermarkBytes: number;
  lowWatermarkBytes: number;
  applyOutputRun: (outputs: T[]) => Promise<void> | void;
  onHighWatermark?: () => void;
  onLowWatermark?: () => void;
}

export interface SessionMutationQueueStats {
  highWatermarkBytes: number;
  lowWatermarkBytes: number;
  pendingMutations: number;
  queuedOutputBytes: number;
  inFlightOutputBytes: number;
  pendingOutputBytes: number;
  peakPendingOutputBytes: number;
  highWatermarkActive: boolean;
  highWatermarkCrossings: number;
}

type Mutation<T> =
  | { kind: "output"; value: T; bytes: number }
  | { kind: "barrier"; run: () => Promise<void> | void };

/**
 * Per-session terminal mutation queue. Output is coalesced only until a
 * barrier, so resize/snapshot/exit always observe every preceding byte while
 * still avoiding one awaited task turn per PTY chunk.
 */
export class SessionMutationQueue<T> {
  // Consumed slots are cleared immediately so parsed terminal strings do not
  // remain strongly referenced until the next array compaction.
  private readonly mutations: Array<Mutation<T> | undefined> = [];
  private head = 0;
  private queuedOutputBytes = 0;
  private inFlightOutputBytes = 0;
  private peakPendingOutputBytes = 0;
  private highWatermarkActive = false;
  private highWatermarkCrossings = 0;
  private disposed = false;

  constructor(private readonly options: SessionMutationQueueOptions<T>) {
    if (options.maxOutputRunBytes <= 0) {
      throw new Error("maxOutputRunBytes must be positive");
    }
    if (
      options.lowWatermarkBytes < 0 ||
      options.highWatermarkBytes <= options.lowWatermarkBytes
    ) {
      throw new Error("watermarks must satisfy 0 <= low < high");
    }
  }

  get pendingOutputBytes(): number {
    return this.queuedOutputBytes + this.inFlightOutputBytes;
  }

  get hasPending(): boolean {
    return this.head < this.mutations.length;
  }

  stats(): SessionMutationQueueStats {
    return {
      highWatermarkBytes: this.options.highWatermarkBytes,
      lowWatermarkBytes: this.options.lowWatermarkBytes,
      pendingMutations: this.mutations.length - this.head,
      queuedOutputBytes: this.queuedOutputBytes,
      inFlightOutputBytes: this.inFlightOutputBytes,
      pendingOutputBytes: this.pendingOutputBytes,
      peakPendingOutputBytes: this.peakPendingOutputBytes,
      highWatermarkActive: this.highWatermarkActive,
      highWatermarkCrossings: this.highWatermarkCrossings
    };
  }

  enqueueOutput(output: SessionOutputMutation<T>): void {
    if (this.disposed || !Number.isFinite(output.bytes) || output.bytes < 0) {
      return;
    }
    if (output.bytes > this.options.maxOutputRunBytes) {
      throw new RangeError(
        `session output mutation exceeds ${this.options.maxOutputRunBytes} bytes`
      );
    }
    this.mutations.push({
      kind: "output",
      value: output.value,
      bytes: output.bytes
    });
    this.queuedOutputBytes += output.bytes;
    this.updateWatermark();
  }

  enqueueBarrier(run: () => Promise<void> | void): void {
    if (this.disposed) {
      return;
    }
    this.mutations.push({ kind: "barrier", run });
  }

  async drainSlice(): Promise<boolean> {
    if (this.disposed || !this.hasPending) {
      return false;
    }

    const first = this.mutations[this.head];
    if (!first) {
      throw new Error("session mutation queue contains an empty live entry");
    }
    if (first.kind === "barrier") {
      this.mutations[this.head] = undefined;
      this.head += 1;
      try {
        await first.run();
      } finally {
        this.compact();
      }
      return this.hasPending;
    }

    const outputs: T[] = [];
    let bytes = 0;
    while (this.hasPending) {
      const mutation = this.mutations[this.head];
      if (!mutation) {
        throw new Error("session mutation queue contains an empty live entry");
      }
      if (mutation.kind !== "output") {
        break;
      }
      if (bytes + mutation.bytes > this.options.maxOutputRunBytes) {
        break;
      }
      this.mutations[this.head] = undefined;
      this.head += 1;
      outputs.push(mutation.value);
      bytes += mutation.bytes;
      this.queuedOutputBytes = Math.max(
        0,
        this.queuedOutputBytes - mutation.bytes
      );
      if (bytes >= this.options.maxOutputRunBytes) {
        break;
      }
    }

    this.inFlightOutputBytes += bytes;
    try {
      await this.options.applyOutputRun(outputs);
    } finally {
      this.inFlightOutputBytes = Math.max(0, this.inFlightOutputBytes - bytes);
      this.updateWatermark();
      this.compact();
    }
    return this.hasPending;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mutations.length = 0;
    this.head = 0;
    this.queuedOutputBytes = 0;
    this.inFlightOutputBytes = 0;
    if (this.highWatermarkActive) {
      this.highWatermarkActive = false;
      this.options.onLowWatermark?.();
    }
  }

  private updateWatermark(): void {
    const pendingBytes = this.pendingOutputBytes;
    this.peakPendingOutputBytes = Math.max(
      this.peakPendingOutputBytes,
      pendingBytes
    );
    if (
      !this.highWatermarkActive &&
      pendingBytes >= this.options.highWatermarkBytes
    ) {
      this.highWatermarkActive = true;
      this.highWatermarkCrossings += 1;
      this.options.onHighWatermark?.();
      return;
    }
    if (
      this.highWatermarkActive &&
      pendingBytes <= this.options.lowWatermarkBytes
    ) {
      this.highWatermarkActive = false;
      this.options.onLowWatermark?.();
    }
  }

  private compact(): void {
    if (this.head === this.mutations.length) {
      this.mutations.length = 0;
      this.head = 0;
      return;
    }
    if (this.head >= 1024 && this.head * 2 >= this.mutations.length) {
      this.mutations.splice(0, this.head);
      this.head = 0;
    }
  }
}
