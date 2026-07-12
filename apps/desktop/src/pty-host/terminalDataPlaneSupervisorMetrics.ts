import { monitorEventLoopDelay } from "node:perf_hooks";

import type { SmoothnessProfileRecorder } from "../shared/smoothnessProfile";
import type { SessionMutationQueueStats } from "./sessionMutationQueue";
import type {
  TerminalDeltaSessionStats,
  TerminalDeltaStoreStats
} from "./terminalDeltaStore";
import type { TerminalSessionStreamStats } from "./terminalSessionStream";

const NANOS_PER_MILLISECOND = 1_000_000;

export interface TerminalDataPlaneSessionMetricSource {
  queue: SessionMutationQueueStats;
  ring: TerminalDeltaSessionStats;
  stream: TerminalSessionStreamStats;
}

export interface EventLoopDelayMonitorLike {
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
}

export interface TerminalDataPlaneSupervisorMetrics {
  sample(): void;
  stop(): void;
}

export function collectTerminalDataPlaneSupervisorDetails(
  sessions: Iterable<TerminalDataPlaneSessionMetricSource>,
  ring: TerminalDeltaStoreStats,
  eventLoopDelay: { p50Ns: number; p95Ns: number; p99Ns: number; maxNs: number }
): Record<string, number> {
  let sessionCount = 0;
  let pendingMutations = 0;
  let pendingOutputBytes = 0;
  let queueHighWatermarkBytes = 0;
  let queueLowWatermarkBytes = 0;
  let maxSessionPendingOutputBytes = 0;
  let peakSessionPendingOutputBytes = 0;
  let highWatermarkSessions = 0;
  let highWatermarkCrossings = 0;
  let maxSessionRingEvents = 0;
  let maxSessionRingBytes = 0;
  let peakSessionRingEvents = 0;
  let peakSessionRingBytes = 0;
  let attachments = 0;
  let creditBytes = 0;
  let maxAttachmentCreditBytes = 0;
  let creditLimitBytes = 0;
  let peakAttachmentCreditBytes = 0;
  let outstandingOutputEvents = 0;
  let outstandingOutputEventLimit = 0;
  let outstandingOutputByteLimit = 0;
  let maxAttachmentOutstandingOutputEvents = 0;
  let peakAttachmentOutstandingOutputEvents = 0;
  let outstandingOutputBytes = 0;
  let maxAttachmentOutstandingOutputBytes = 0;
  let peakAttachmentOutstandingOutputBytes = 0;
  let creditBoundViolationCount = 0;
  let resyncingAttachments = 0;

  for (const session of sessions) {
    sessionCount += 1;
    pendingMutations += session.queue.pendingMutations;
    pendingOutputBytes += session.queue.pendingOutputBytes;
    queueHighWatermarkBytes = Math.max(
      queueHighWatermarkBytes,
      session.queue.highWatermarkBytes
    );
    queueLowWatermarkBytes = Math.max(
      queueLowWatermarkBytes,
      session.queue.lowWatermarkBytes
    );
    maxSessionPendingOutputBytes = Math.max(
      maxSessionPendingOutputBytes,
      session.queue.pendingOutputBytes
    );
    peakSessionPendingOutputBytes = Math.max(
      peakSessionPendingOutputBytes,
      session.queue.peakPendingOutputBytes
    );
    highWatermarkCrossings += session.queue.highWatermarkCrossings;
    if (session.queue.highWatermarkActive) {
      highWatermarkSessions += 1;
    }
    maxSessionRingEvents = Math.max(maxSessionRingEvents, session.ring.events);
    maxSessionRingBytes = Math.max(maxSessionRingBytes, session.ring.bytes);
    peakSessionRingEvents = Math.max(
      peakSessionRingEvents,
      session.ring.peakEvents
    );
    peakSessionRingBytes = Math.max(
      peakSessionRingBytes,
      session.ring.peakBytes
    );
    attachments += session.stream.attachments;
    creditBytes += session.stream.creditBytes;
    maxAttachmentCreditBytes = Math.max(
      maxAttachmentCreditBytes,
      session.stream.maxAttachmentCreditBytes
    );
    creditLimitBytes = Math.max(
      creditLimitBytes,
      session.stream.maxCreditBytes
    );
    peakAttachmentCreditBytes = Math.max(
      peakAttachmentCreditBytes,
      session.stream.peakAttachmentCreditBytes
    );
    outstandingOutputEvents += session.stream.outstandingOutputEvents;
    outstandingOutputEventLimit = Math.max(
      outstandingOutputEventLimit,
      session.stream.maxOutstandingOutputEvents
    );
    outstandingOutputByteLimit = Math.max(
      outstandingOutputByteLimit,
      session.stream.maxOutstandingOutputBytes
    );
    maxAttachmentOutstandingOutputEvents = Math.max(
      maxAttachmentOutstandingOutputEvents,
      session.stream.maxAttachmentOutstandingOutputEvents
    );
    peakAttachmentOutstandingOutputEvents = Math.max(
      peakAttachmentOutstandingOutputEvents,
      session.stream.peakAttachmentOutstandingOutputEvents
    );
    outstandingOutputBytes += session.stream.outstandingOutputBytes;
    maxAttachmentOutstandingOutputBytes = Math.max(
      maxAttachmentOutstandingOutputBytes,
      session.stream.maxAttachmentOutstandingOutputBytes
    );
    peakAttachmentOutstandingOutputBytes = Math.max(
      peakAttachmentOutstandingOutputBytes,
      session.stream.peakAttachmentOutstandingOutputBytes
    );
    creditBoundViolationCount += session.stream.creditBoundViolationCount;
    resyncingAttachments += session.stream.resyncingAttachments;
  }

  return {
    sessions: sessionCount,
    pendingMutations,
    pendingOutputBytes,
    queueHighWatermarkBytes,
    queueLowWatermarkBytes,
    maxSessionPendingOutputBytes,
    peakSessionPendingOutputBytes,
    highWatermarkSessions,
    highWatermarkCrossings,
    ringSessions: ring.sessions,
    ringEvents: ring.events,
    ringBytes: ring.bytes,
    ringMaxSessionBytes: ring.maxSessionBytes,
    ringMaxSessionEvents: ring.maxSessionEvents,
    ringMaxTotalBytes: ring.maxTotalBytes,
    ringMaxTotalEvents: ring.maxTotalEvents,
    ringPeakSessionBytes: ring.peakSessionBytes,
    ringPeakSessionEvents: ring.peakSessionEvents,
    ringPeakTotalBytes: ring.peakTotalBytes,
    ringPeakTotalEvents: ring.peakTotalEvents,
    ringBoundViolationCount: ring.boundViolationCount,
    ringOversizedDeltaCount: ring.oversizedDeltaCount,
    ringReplayLookupMissCount: ring.replayLookupMissCount,
    ringInternalCursorMissCount: ring.internalCursorMissCount,
    ringInternalCursorMissEpisodeCount: ring.internalCursorMissEpisodeCount,
    maxSessionRingEvents,
    maxSessionRingBytes,
    peakSessionRingEvents,
    peakSessionRingBytes,
    attachments,
    creditBytes,
    maxAttachmentCreditBytes,
    creditLimitBytes,
    peakAttachmentCreditBytes,
    outstandingOutputEvents,
    outstandingOutputEventLimit,
    outstandingOutputByteLimit,
    maxAttachmentOutstandingOutputEvents,
    peakAttachmentOutstandingOutputEvents,
    outstandingOutputBytes,
    maxAttachmentOutstandingOutputBytes,
    peakAttachmentOutstandingOutputBytes,
    creditBoundViolationCount,
    resyncingAttachments,
    eventLoopDelayP50Ms: toMilliseconds(eventLoopDelay.p50Ns),
    eventLoopDelayP95Ms: toMilliseconds(eventLoopDelay.p95Ns),
    eventLoopDelayP99Ms: toMilliseconds(eventLoopDelay.p99Ns),
    eventLoopDelayMaxMs: toMilliseconds(eventLoopDelay.maxNs)
  };
}

export function createTerminalDataPlaneSupervisorMetrics(options: {
  recorder: SmoothnessProfileRecorder;
  now: () => number;
  readSessions: () => Iterable<TerminalDataPlaneSessionMetricSource>;
  readRing: () => TerminalDeltaStoreStats;
  intervalMs?: number;
  createDelayMonitor?: () => EventLoopDelayMonitorLike;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): TerminalDataPlaneSupervisorMetrics {
  if (!options.recorder.enabled) {
    return { sample() {}, stop() {} };
  }

  const delayMonitor =
    options.createDelayMonitor?.() ?? monitorEventLoopDelay({ resolution: 10 });
  const sample = (): void => {
    const details = collectTerminalDataPlaneSupervisorDetails(
      options.readSessions(),
      options.readRing(),
      {
        p50Ns: delayMonitor.percentile(50),
        p95Ns: delayMonitor.percentile(95),
        p99Ns: delayMonitor.percentile(99),
        maxNs: delayMonitor.max
      }
    );
    options.recorder.record({
      source: "pty-host",
      name: "terminal.data-plane.supervisor",
      at: options.now(),
      details
    });
    delayMonitor.reset();
  };

  delayMonitor.enable();
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const timer = setIntervalFn(sample, options.intervalMs ?? 1_000);
  timer.unref?.();
  let stopped = false;
  return {
    sample,
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      (options.clearIntervalFn ?? clearInterval)(timer);
      delayMonitor.disable();
    }
  };
}

function toMilliseconds(nanoseconds: number): number {
  return Number.isFinite(nanoseconds)
    ? Math.max(0, nanoseconds) / NANOS_PER_MILLISECOND
    : 0;
}
