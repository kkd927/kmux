import { describe, expect, it, vi } from "vitest";

import {
  collectTerminalDataPlaneSupervisorDetails,
  createTerminalDataPlaneSupervisorMetrics,
  type EventLoopDelayMonitorLike
} from "./terminalDataPlaneSupervisorMetrics";

const queue = {
  highWatermarkBytes: 256,
  lowWatermarkBytes: 64,
  pendingMutations: 3,
  queuedOutputBytes: 120,
  inFlightOutputBytes: 8,
  pendingOutputBytes: 128,
  peakPendingOutputBytes: 192,
  highWatermarkActive: true,
  highWatermarkCrossings: 2
};
const stream = {
  maxCreditBytes: 1_024,
  maxOutstandingOutputEvents: 8,
  maxOutstandingOutputBytes: 512,
  attachments: 1,
  startedAttachments: 1,
  resyncingAttachments: 0,
  creditBytes: 64,
  maxAttachmentCreditBytes: 64,
  peakAttachmentCreditBytes: 128,
  outstandingOutputEvents: 2,
  maxAttachmentOutstandingOutputEvents: 2,
  peakAttachmentOutstandingOutputEvents: 3,
  outstandingOutputBytes: 32,
  maxAttachmentOutstandingOutputBytes: 32,
  peakAttachmentOutstandingOutputBytes: 96,
  creditBoundViolationCount: 0
};
const ring = {
  events: 2,
  bytes: 256,
  maxBytes: 512,
  maxEvents: 8,
  peakBytes: 384,
  peakEvents: 4,
  latestSequence: 4,
  retainedFromSequence: 3
};
const ringStore = {
  sessions: 2,
  events: 4,
  bytes: 512,
  maxSessionBytes: 512,
  maxSessionEvents: 8,
  maxTotalBytes: 2_048,
  maxTotalEvents: 32,
  peakSessionBytes: 384,
  peakSessionEvents: 4,
  peakTotalBytes: 768,
  peakTotalEvents: 6,
  boundViolationCount: 0,
  oversizedDeltaCount: 1
};

describe("terminal data-plane supervisor metrics", () => {
  it("aggregates only bounded queue, ring, and credit counters", () => {
    expect(
      collectTerminalDataPlaneSupervisorDetails(
        [
          { queue, ring, stream },
          {
            queue: {
              ...queue,
              pendingMutations: 1,
              pendingOutputBytes: 16,
              peakPendingOutputBytes: 64,
              highWatermarkCrossings: 1,
              highWatermarkActive: false
            },
            ring: { ...ring, events: 1, bytes: 64 },
            stream: {
              ...stream,
              attachments: 0,
              startedAttachments: 0,
              creditBytes: 0,
              maxAttachmentCreditBytes: 0,
              peakAttachmentCreditBytes: 32,
              outstandingOutputEvents: 0,
              maxAttachmentOutstandingOutputEvents: 0,
              peakAttachmentOutstandingOutputEvents: 1,
              outstandingOutputBytes: 0,
              maxAttachmentOutstandingOutputBytes: 0,
              peakAttachmentOutstandingOutputBytes: 16
            }
          }
        ],
        ringStore,
        {
          p50Ns: 2_000_000,
          p95Ns: 12_500_000,
          p99Ns: 20_000_000,
          maxNs: 30_000_000
        }
      )
    ).toEqual({
      sessions: 2,
      pendingMutations: 4,
      pendingOutputBytes: 144,
      queueHighWatermarkBytes: 256,
      queueLowWatermarkBytes: 64,
      maxSessionPendingOutputBytes: 128,
      peakSessionPendingOutputBytes: 192,
      highWatermarkSessions: 1,
      highWatermarkCrossings: 3,
      ringSessions: 2,
      ringEvents: 4,
      ringBytes: 512,
      ringMaxSessionBytes: 512,
      ringMaxSessionEvents: 8,
      ringMaxTotalBytes: 2048,
      ringMaxTotalEvents: 32,
      ringPeakSessionBytes: 384,
      ringPeakSessionEvents: 4,
      ringPeakTotalBytes: 768,
      ringPeakTotalEvents: 6,
      ringBoundViolationCount: 0,
      ringOversizedDeltaCount: 1,
      maxSessionRingEvents: 2,
      maxSessionRingBytes: 256,
      peakSessionRingEvents: 4,
      peakSessionRingBytes: 384,
      attachments: 1,
      creditBytes: 64,
      maxAttachmentCreditBytes: 64,
      creditLimitBytes: 1024,
      peakAttachmentCreditBytes: 128,
      outstandingOutputEvents: 2,
      outstandingOutputEventLimit: 8,
      outstandingOutputByteLimit: 512,
      maxAttachmentOutstandingOutputEvents: 2,
      peakAttachmentOutstandingOutputEvents: 3,
      outstandingOutputBytes: 32,
      maxAttachmentOutstandingOutputBytes: 32,
      peakAttachmentOutstandingOutputBytes: 96,
      creditBoundViolationCount: 0,
      resyncingAttachments: 0,
      eventLoopDelayP50Ms: 2,
      eventLoopDelayP95Ms: 12.5,
      eventLoopDelayP99Ms: 20,
      eventLoopDelayMaxMs: 30
    });
  });

  it("samples and resets the event-loop histogram without logging terminal data", () => {
    const recorder = { enabled: true, record: vi.fn() };
    const monitor: EventLoopDelayMonitorLike = {
      max: 4_000_000,
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      percentile: vi.fn((value: number) => value * 100_000)
    };
    let scheduled: (() => void) | undefined;
    const metrics = createTerminalDataPlaneSupervisorMetrics({
      recorder,
      now: () => 42,
      readSessions: () => [{ queue, ring, stream }],
      readRing: () => ({ ...ringStore, sessions: 1, events: 2, bytes: 32 }),
      createDelayMonitor: () => monitor,
      setIntervalFn: ((callback: () => void) => {
        scheduled = callback;
        return { unref: vi.fn() };
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval
    });

    scheduled?.();

    expect(recorder.record).toHaveBeenCalledWith({
      source: "pty-host",
      name: "terminal.data-plane.supervisor",
      at: 42,
      details: expect.objectContaining({
        sessions: 1,
        pendingOutputBytes: 128,
        ringBytes: 32,
        creditBytes: 64,
        eventLoopDelayP95Ms: 9.5
      })
    });
    expect(monitor.reset).toHaveBeenCalledOnce();
    metrics.stop();
    expect(monitor.disable).toHaveBeenCalledOnce();
  });
});
