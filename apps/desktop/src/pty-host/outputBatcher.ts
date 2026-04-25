import type { SurfaceChunkPayload, SurfaceChunkSegment } from "@kmux/proto";

interface OutputBatcherOptions {
  flushMs: number;
  maxBatchBytes: number;
  onFlush: (payload: SurfaceChunkPayload) => void;
}

interface PendingOutputBatch {
  surfaceId: string;
  sessionId: string;
  fromSequence: number;
  sequence: number;
  chunk: string;
  segments: SurfaceChunkSegment[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class OutputBatcher {
  private readonly pending = new Map<string, PendingOutputBatch>();

  constructor(private readonly options: OutputBatcherOptions) {}

  push(payload: SurfaceChunkPayload): void {
    let batch = this.pending.get(payload.sessionId);
    if (!batch) {
      batch = {
        surfaceId: payload.surfaceId,
        sessionId: payload.sessionId,
        fromSequence: payload.fromSequence ?? payload.sequence,
        sequence: payload.sequence,
        chunk: "",
        segments: [],
        bytes: 0,
        timer: null
      };
      this.pending.set(payload.sessionId, batch);
    }

    batch.surfaceId = payload.surfaceId;
    batch.fromSequence = Math.min(
      batch.fromSequence,
      payload.fromSequence ?? payload.sequence
    );
    batch.sequence = payload.sequence;
    batch.chunk += payload.chunk;
    batch.segments.push(
      ...(payload.segments ?? [
        {
          sequence: payload.sequence,
          length: payload.chunk.length
        }
      ])
    );
    batch.bytes += Buffer.byteLength(payload.chunk, "utf8");

    if (batch.bytes >= this.options.maxBatchBytes) {
      this.flush(payload.sessionId);
      return;
    }

    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        this.flush(payload.sessionId);
      }, this.options.flushMs);
      if (typeof batch.timer === "object" && "unref" in batch.timer) {
        batch.timer.unref();
      }
    }
  }

  flush(sessionId: string): void {
    const batch = this.pending.get(sessionId);
    if (!batch) {
      return;
    }

    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    this.pending.delete(sessionId);

    if (!batch.chunk) {
      return;
    }

    this.options.onFlush({
      surfaceId: batch.surfaceId,
      sessionId: batch.sessionId,
      fromSequence: batch.fromSequence,
      sequence: batch.sequence,
      segments: batch.segments,
      chunk: batch.chunk
    });
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.flush(sessionId);
    }
  }
}
