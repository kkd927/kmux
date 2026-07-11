export type SessionDrain = () => Promise<boolean> | boolean;

export interface FairSessionSchedulerOptions {
  schedule?: (callback: () => void) => void;
  onDrainError?: (sessionId: string, error: unknown) => void;
}

interface SchedulerEntry {
  drain: SessionDrain;
  queued: boolean;
  running: boolean;
  rerun: boolean;
}

/**
 * Gives every runnable session at most one in-flight drain slice. A slow
 * headless parser therefore cannot prevent the other sessions from starting
 * their own bounded slice while its callback is pending.
 */
export class FairSessionScheduler {
  private readonly entries = new Map<string, SchedulerEntry>();
  private readonly ready: string[] = [];
  private pumpScheduled = false;
  private disposed = false;
  private readonly schedule: (callback: () => void) => void;

  constructor(private readonly options: FairSessionSchedulerOptions = {}) {
    this.schedule = options.schedule ?? queueMicrotask;
  }

  register(sessionId: string, drain: SessionDrain): void {
    if (this.disposed) {
      return;
    }
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.drain = drain;
      return;
    }
    this.entries.set(sessionId, {
      drain,
      queued: false,
      running: false,
      rerun: false
    });
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  wake(sessionId: string): void {
    if (this.disposed) {
      return;
    }
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    if (entry.queued) {
      return;
    }
    entry.queued = true;
    this.ready.push(sessionId);
    this.schedulePump();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.ready.length = 0;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) {
      return;
    }
    this.pumpScheduled = true;
    this.schedule(() => this.pump());
  }

  private pump(): void {
    this.pumpScheduled = false;
    if (this.disposed) {
      return;
    }

    const runnable = this.ready.splice(0);
    for (const sessionId of runnable) {
      const entry = this.entries.get(sessionId);
      if (!entry || !entry.queued || entry.running) {
        continue;
      }
      entry.queued = false;
      entry.running = true;
      entry.rerun = false;
      void Promise.resolve()
        .then(() => entry.drain())
        .then(
          (hasMore) => this.finishDrain(sessionId, entry, hasMore),
          (error) => {
            this.options.onDrainError?.(sessionId, error);
            this.finishDrain(sessionId, entry, true);
          }
        );
    }
  }

  private finishDrain(
    sessionId: string,
    entry: SchedulerEntry,
    hasMore: boolean
  ): void {
    const current = this.entries.get(sessionId);
    if (current !== entry || this.disposed) {
      return;
    }
    entry.running = false;
    if (hasMore || entry.rerun) {
      this.wake(sessionId);
    }
  }
}
