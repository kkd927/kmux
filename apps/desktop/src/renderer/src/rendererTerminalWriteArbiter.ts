export interface RendererTerminalWriteArbiterOptions {
  maxStartsPerTurn?: number;
  maxRunMs?: number;
  now?: () => number;
  scheduleTurn?: (callback: () => void) => void;
  onError?: (laneId: string, error: unknown) => void;
}

interface PendingLane {
  runOne(): void;
}

const DEFAULT_MAX_STARTS_PER_TURN = 8;
const DEFAULT_MAX_RUN_MS = 8;

/**
 * Renderer-wide admission clock for xterm writes. Each lane represents one
 * visible surface; callers re-admit a lane only after its prior xterm parse
 * callback, which prevents hidden backlog inside xterm's own WriteBuffer.
 */
export class RendererTerminalWriteArbiter {
  private readonly ready: string[] = [];
  private readonly pending = new Map<string, PendingLane>();
  private readonly priorityPending = new Set<string>();
  private readonly maxStartsPerTurn: number;
  private readonly maxRunMs: number;
  private readonly now: () => number;
  private readonly scheduleTurn: (callback: () => void) => void;
  private readonly disposeTurnScheduler: () => void;
  private scheduled = false;
  private running = false;
  private disposed = false;

  constructor(
    private readonly options: RendererTerminalWriteArbiterOptions = {}
  ) {
    this.maxStartsPerTurn = positiveInteger(
      options.maxStartsPerTurn ?? DEFAULT_MAX_STARTS_PER_TURN,
      "maxStartsPerTurn"
    );
    this.maxRunMs = finiteNonNegative(
      options.maxRunMs ?? DEFAULT_MAX_RUN_MS,
      "maxRunMs"
    );
    this.now = options.now ?? defaultNow;
    if (options.scheduleTurn) {
      this.scheduleTurn = options.scheduleTurn;
      this.disposeTurnScheduler = () => {};
    } else {
      const turnScheduler = createMessageTurnScheduler();
      this.scheduleTurn = turnScheduler.schedule;
      this.disposeTurnScheduler = turnScheduler.dispose;
    }
  }

  request(laneId: string, runOne: () => void, priority = false): void {
    if (this.disposed) {
      return;
    }
    const reservedPriority = this.priorityPending.delete(laneId);
    const shouldPrioritize = priority || reservedPriority;
    const existing = this.pending.get(laneId);
    if (existing) {
      existing.runOne = runOne;
      if (shouldPrioritize) {
        this.moveToFront(laneId);
      }
      return;
    }

    this.pending.set(laneId, { runOne });
    if (shouldPrioritize) {
      this.ready.unshift(laneId);
    } else {
      this.ready.push(laneId);
    }
    this.ensureScheduled();
  }

  prioritize(laneId: string): void {
    if (this.disposed) {
      return;
    }
    if (this.pending.has(laneId)) {
      this.moveToFront(laneId);
      return;
    }
    this.priorityPending.add(laneId);
  }

  cancel(laneId: string): void {
    this.pending.delete(laneId);
    this.priorityPending.delete(laneId);
    const index = this.ready.indexOf(laneId);
    if (index >= 0) {
      this.ready.splice(index, 1);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.ready.length = 0;
    this.pending.clear();
    this.priorityPending.clear();
    this.disposeTurnScheduler();
  }

  private moveToFront(laneId: string): void {
    const index = this.ready.indexOf(laneId);
    if (index <= 0) {
      return;
    }
    this.ready.splice(index, 1);
    this.ready.unshift(laneId);
  }

  private ensureScheduled(): void {
    if (
      this.scheduled ||
      this.running ||
      this.disposed ||
      this.ready.length === 0
    ) {
      return;
    }
    this.scheduled = true;
    this.scheduleTurn(() => this.runTurn());
  }

  private runTurn(): void {
    this.scheduled = false;
    if (this.disposed) {
      return;
    }
    this.running = true;
    const startedAt = this.now();
    let starts = 0;
    try {
      while (this.ready.length > 0) {
        if (
          starts >= this.maxStartsPerTurn ||
          (starts > 0 && this.now() - startedAt >= this.maxRunMs)
        ) {
          break;
        }
        const laneId = this.ready.shift();
        if (!laneId) {
          break;
        }
        const lane = this.pending.get(laneId);
        if (!lane) {
          continue;
        }
        this.pending.delete(laneId);
        starts += 1;
        try {
          lane.runOne();
        } catch (error) {
          try {
            this.options.onError?.(laneId, error);
          } catch {
            // Diagnostics for one failed lane must not stop every peer lane.
          }
        }
      }
    } finally {
      this.running = false;
      this.ensureScheduled();
    }
  }
}

function createMessageTurnScheduler(): {
  schedule(callback: () => void): void;
  dispose(): void;
} {
  if (typeof MessageChannel === "undefined") {
    let disposed = false;
    return {
      schedule(callback) {
        setTimeout(() => {
          if (!disposed) {
            callback();
          }
        }, 0);
      },
      dispose() {
        disposed = true;
      }
    };
  }

  const channel = new MessageChannel();
  let callback: (() => void) | null = null;
  let disposed = false;
  channel.port1.onmessage = () => {
    const current = callback;
    callback = null;
    if (!disposed) {
      current?.();
    }
  };
  channel.port1.start?.();
  return {
    schedule(next) {
      if (disposed) {
        return;
      }
      callback = next;
      channel.port2.postMessage(undefined);
    },
    dispose() {
      disposed = true;
      callback = null;
      channel.port1.close();
      channel.port2.close();
    }
  };
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
  return value;
}
