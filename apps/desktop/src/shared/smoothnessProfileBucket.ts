export interface SmoothnessProfileBucketHandle<TDetails extends object> {
  update(key: string, update: (details: TDetails) => void): void;
  record(key: string, update: (details: TDetails) => void): void;
  flush(key: string): void;
  flushAll(): void;
}

export function createSmoothnessProfileBucket<TDetails extends object>(options: {
  minEvents: number;
  maxDurationMs: number;
  now: () => number;
  createDetails: (key: string, startedAt: number) => TDetails;
  onFlush: (details: TDetails, durationMs: number, at: number) => void;
}): SmoothnessProfileBucketHandle<TDetails> {
  const buckets = new Map<
    string,
    {
      eventCount: number;
      startedAt: number;
      details: TDetails;
    }
  >();

  function getBucket(key: string, now: number) {
    const existing = buckets.get(key);
    if (existing) {
      return existing;
    }
    const next = {
      eventCount: 0,
      startedAt: now,
      details: options.createDetails(key, now)
    };
    buckets.set(key, next);
    return next;
  }

  function flushBucket(key: string, at: number): void {
    const bucket = buckets.get(key);
    if (!bucket || bucket.eventCount === 0) {
      return;
    }
    buckets.delete(key);
    options.onFlush(bucket.details, at - bucket.startedAt, at);
  }

  return {
    update(key, update) {
      const now = options.now();
      const bucket = getBucket(key, now);
      update(bucket.details);
    },
    record(key, update) {
      const now = options.now();
      const bucket = getBucket(key, now);
      bucket.eventCount += 1;
      update(bucket.details);
      if (
        bucket.eventCount >= options.minEvents ||
        now - bucket.startedAt >= options.maxDurationMs
      ) {
        flushBucket(key, now);
      }
    },
    flush(key) {
      flushBucket(key, options.now());
    },
    flushAll() {
      const now = options.now();
      for (const key of [...buckets.keys()]) {
        flushBucket(key, now);
      }
    }
  };
}
