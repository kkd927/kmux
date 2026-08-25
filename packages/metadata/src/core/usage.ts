import type { MetadataVendor } from "./sourceContract";
import type { PricingMode } from "../modelPricing";

export type CoreUsageVendor = MetadataVendor | "unknown";
export type CoreUsageCostSource = "reported" | "estimated" | "unavailable";

export interface CoreUsageEventSample {
  aggregateId?: string;
  vendor: CoreUsageVendor;
  timestampMs: number;
  sourcePath: string;
  sourceType: "jsonl" | "json";
  sessionId?: string;
  threadId?: string;
  requestId?: string;
  eventId?: string;
  model?: string;
  pricingMode?: PricingMode;
  cwd?: string;
  projectPath?: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
  cacheTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costSource?: CoreUsageCostSource;
  /** Agent-owned canonical event identity used by generic aggregation. */
  dedupeKey?: string;
  /** Higher values win when two samples have the same agent-owned identity. */
  dedupeRank?: number;
}

export interface CoreUsageTimeRange {
  fromMs: number;
  toMs?: number;
}

export type CoreUsageRecordConsumer = (
  record: Record<string, unknown>,
  range: CoreUsageTimeRange
) => readonly CoreUsageEventSample[];

const textEncoder = new TextEncoder();

/**
 * Bounded JSONL framing shared by local and remote usage projections. Record
 * interpretation remains in the owning agent module through `consume`.
 * Oversized records are discarded through their newline so unrelated tool
 * output cannot fail the rest of a usage source.
 */
export class IncrementalCoreUsageJsonlParser {
  private pending = "";
  private pendingBytes = 0;
  private discardingOversizedRecord = false;
  private readonly maximumPendingBytes: number;

  constructor(
    private readonly consume: CoreUsageRecordConsumer,
    options: { maximumPendingBytes?: number } = {}
  ) {
    this.maximumPendingBytes =
      options.maximumPendingBytes ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(this.maximumPendingBytes) ||
      this.maximumPendingBytes < 1
    ) {
      throw new TypeError("usage parser pending byte bound is invalid");
    }
  }

  append(
    text: string,
    range: CoreUsageTimeRange,
    options: { eof?: boolean } = {}
  ): readonly CoreUsageEventSample[] {
    const samples: CoreUsageEventSample[] = [];
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      this.appendFragment(text.slice(start, end));
      if (newline < 0) break;
      this.consumePendingRecord(range, samples);
      start = newline + 1;
    }
    if (
      options.eof &&
      !this.discardingOversizedRecord &&
      isCompleteJsonLine(this.pending)
    ) {
      this.consumePendingRecord(range, samples);
    }
    return samples;
  }

  reset(): void {
    this.pending = "";
    this.pendingBytes = 0;
    this.discardingOversizedRecord = false;
  }

  clone(
    consume: CoreUsageRecordConsumer = this.consume
  ): IncrementalCoreUsageJsonlParser {
    const parser = new IncrementalCoreUsageJsonlParser(consume, {
      maximumPendingBytes: this.maximumPendingBytes
    });
    parser.pending = this.pending;
    parser.pendingBytes = this.pendingBytes;
    parser.discardingOversizedRecord = this.discardingOversizedRecord;
    return parser;
  }

  private appendFragment(fragment: string): void {
    if (this.discardingOversizedRecord || fragment.length === 0) return;
    const fragmentBytes = textEncoder.encode(fragment).byteLength;
    if (this.pendingBytes + fragmentBytes > this.maximumPendingBytes) {
      this.pending = "";
      this.pendingBytes = 0;
      this.discardingOversizedRecord = true;
      return;
    }
    this.pending += fragment;
    this.pendingBytes += fragmentBytes;
  }

  private consumePendingRecord(
    range: CoreUsageTimeRange,
    samples: CoreUsageEventSample[]
  ): void {
    if (this.discardingOversizedRecord) {
      this.discardingOversizedRecord = false;
    } else {
      const trimmed = this.pending.trim();
      if (trimmed) {
        try {
          const record = JSON.parse(trimmed) as unknown;
          if (isRecord(record)) samples.push(...this.consume(record, range));
        } catch {
          // A malformed record is isolated to its line.
        }
      }
    }
    this.pending = "";
    this.pendingBytes = 0;
  }
}

export function coreUsageSampleIdentity(sample: CoreUsageEventSample): string {
  if (sample.aggregateId) return `aggregate\t${sample.aggregateId}`;
  if (sample.dedupeKey) return `agent\t${sample.vendor}\t${sample.dedupeKey}`;
  const eventKey =
    sample.eventId ??
    sample.threadId ??
    [
      sample.sessionId ?? "",
      sample.timestampMs,
      sample.inputTokens,
      sample.outputTokens,
      sample.thinkingTokens ?? 0,
      sample.cacheReadTokens ?? sample.cacheTokens,
      sample.cacheWriteTokens ?? 0,
      sample.totalTokens
    ].join(":");
  return [sample.vendor, sample.sourcePath, eventKey].join("\t");
}

export function shouldReplaceCoreUsageSample(
  existing: CoreUsageEventSample,
  candidate: CoreUsageEventSample
): boolean {
  if (
    existing.dedupeKey &&
    candidate.dedupeKey &&
    existing.vendor === candidate.vendor &&
    existing.dedupeKey === candidate.dedupeKey
  ) {
    if (candidate.totalTokens !== existing.totalTokens) {
      return candidate.totalTokens > existing.totalTokens;
    }
    const existingRank = existing.dedupeRank ?? 0;
    const candidateRank = candidate.dedupeRank ?? 0;
    if (candidateRank !== existingRank) return candidateRank > existingRank;
    return existing.sourcePath === candidate.sourcePath
      ? candidate.timestampMs >= existing.timestampMs
      : candidate.sourcePath < existing.sourcePath;
  }
  return true;
}

export function dedupeCoreUsageSamples(
  samples: Iterable<CoreUsageEventSample>
): CoreUsageEventSample[] {
  const deduped = new Map<string, CoreUsageEventSample>();
  for (const sample of samples) {
    const identity = coreUsageSampleIdentity(sample);
    const existing = deduped.get(identity);
    if (!existing || shouldReplaceCoreUsageSample(existing, sample)) {
      deduped.set(identity, sample);
    }
  }
  return [...deduped.values()];
}

export function aggregateCoreUsageSamples(
  samples: Iterable<CoreUsageEventSample>
): CoreUsageEventSample[] {
  const aggregates = new Map<
    string,
    {
      sample: CoreUsageEventSample;
      latestIdentity: string;
      latestTimestampMs: number;
    }
  >();
  for (const sample of samples) {
    if (!sample.sessionId) {
      aggregates.set(`sample\t${coreUsageSampleIdentity(sample)}`, {
        sample,
        latestIdentity: coreUsageSampleIdentity(sample),
        latestTimestampMs: sample.timestampMs
      });
      continue;
    }
    const aggregateId = [
      sample.vendor,
      sample.sessionId,
      ...(sample.pricingMode ? [sample.pricingMode] : [])
    ].join(":");
    const key = `session\t${aggregateId}`;
    const identity = coreUsageSampleIdentity(sample);
    const existing = aggregates.get(key);
    if (!existing) {
      aggregates.set(key, {
        sample: {
          ...sample,
          aggregateId,
          sourcePath: `kmux-usage-aggregate:${aggregateId}`,
          threadId: undefined,
          requestId: undefined,
          eventId: undefined,
          dedupeKey: undefined,
          dedupeRank: undefined,
          thinkingTokens: sample.thinkingTokens ?? 0,
          cacheReadTokens: sample.cacheReadTokens ?? sample.cacheTokens,
          cacheWriteTokens: sample.cacheWriteTokens ?? 0,
          cacheWriteTokensKnown: sample.cacheWriteTokensKnown ?? false
        },
        latestIdentity: identity,
        latestTimestampMs: sample.timestampMs
      });
      continue;
    }
    const preferCandidateMetadata =
      sample.timestampMs > existing.latestTimestampMs ||
      (sample.timestampMs === existing.latestTimestampMs &&
        identity.localeCompare(existing.latestIdentity) < 0);
    const current = existing.sample;
    existing.sample = {
      ...current,
      timestampMs: Math.max(current.timestampMs, sample.timestampMs),
      ...((preferCandidateMetadata || !current.model) && sample.model
        ? { model: sample.model }
        : {}),
      ...((preferCandidateMetadata || !current.cwd) && sample.cwd
        ? { cwd: sample.cwd }
        : {}),
      ...((preferCandidateMetadata || !current.projectPath) &&
      sample.projectPath
        ? { projectPath: sample.projectPath }
        : {}),
      inputTokens: saturatingCoreUsageCount(
        current.inputTokens,
        sample.inputTokens
      ),
      outputTokens: saturatingCoreUsageCount(
        current.outputTokens,
        sample.outputTokens
      ),
      thinkingTokens: saturatingCoreUsageCount(
        current.thinkingTokens ?? 0,
        sample.thinkingTokens ?? 0
      ),
      cacheReadTokens: saturatingCoreUsageCount(
        current.cacheReadTokens ?? current.cacheTokens,
        sample.cacheReadTokens ?? sample.cacheTokens
      ),
      cacheWriteTokens: saturatingCoreUsageCount(
        current.cacheWriteTokens ?? 0,
        sample.cacheWriteTokens ?? 0
      ),
      cacheWriteTokensKnown:
        (current.cacheWriteTokensKnown ?? false) ||
        (sample.cacheWriteTokensKnown ?? false),
      cacheTokens: saturatingCoreUsageCount(
        current.cacheTokens,
        sample.cacheTokens
      ),
      totalTokens: saturatingCoreUsageCount(
        current.totalTokens,
        sample.totalTokens
      ),
      estimatedCostUsd: saturatingCoreUsageCost(
        current.estimatedCostUsd,
        sample.estimatedCostUsd
      ),
      costSource: mergeCoreUsageCostSources(
        current.costSource,
        sample.costSource
      )
    };
    if (preferCandidateMetadata) {
      existing.latestIdentity = identity;
      existing.latestTimestampMs = sample.timestampMs;
    }
  }
  return [...aggregates.values()].map(({ sample }) => sample);
}

function isCompleteJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function saturatingCoreUsageCount(left: number, right: number): number {
  const safe = (value: number): number =>
    Number.isFinite(value)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
      : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, safe(left) + safe(right));
}

function saturatingCoreUsageCost(left: number, right: number): number {
  const safe = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  const total = safe(left) + safe(right);
  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

function mergeCoreUsageCostSources(
  left: CoreUsageCostSource | undefined,
  right: CoreUsageCostSource | undefined
): CoreUsageCostSource | undefined {
  if (left === "unavailable" || right === "unavailable") return "unavailable";
  if (left === "estimated" || right === "estimated") return "estimated";
  return left ?? right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
