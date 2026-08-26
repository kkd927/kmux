import {
  IncrementalCoreUsageJsonlParser,
  estimateModelCost,
  type CoreUsageEventSample,
  type CoreUsageTimeRange,
  type PricingVendorId,
  type PricingMode
} from "@kmux/metadata";
import type { AgentId, MetadataSourceRoleId } from "@kmux/proto";

import type {
  AgentSessionSourceClaimProjection,
  AgentUsageSourceParser,
  AgentUsageSourceProjection,
  AgentUsageSourceProjectionSession
} from "../contracts";

export interface UsageProjectionRecordInput {
  readonly sourcePath: string;
  readonly role: MetadataSourceRoleId;
  readonly record: Record<string, unknown>;
  readonly range: CoreUsageTimeRange;
}

export interface UsageProjectionPolicy<State> {
  createState(): State;
  cloneState(state: State): State;
  resetSource(state: State, sourcePath: string): void;
  beginInventory?(state: State, options: { readonly truncated: boolean }): void;
  applySourceClaim?(
    state: State,
    options: {
      readonly role: MetadataSourceRoleId;
      readonly claim: AgentSessionSourceClaimProjection;
    }
  ): void;
  parseRecord(
    state: State,
    input: UsageProjectionRecordInput
  ): readonly CoreUsageEventSample[];
}

export function createJsonlUsageSourceProjection<State>(
  agentId: AgentId,
  policy: UsageProjectionPolicy<State>
): AgentUsageSourceProjection {
  return Object.freeze({
    createSession: () =>
      new JsonlUsageProjectionSession(agentId, policy, policy.createState())
  });
}

class JsonlUsageProjectionSession<
  State
> implements AgentUsageSourceProjectionSession {
  constructor(
    readonly agentId: AgentId,
    readonly policy: UsageProjectionPolicy<State>,
    readonly state: State
  ) {}

  clone(): AgentUsageSourceProjectionSession {
    return new JsonlUsageProjectionSession(
      this.agentId,
      this.policy,
      this.policy.cloneState(this.state)
    );
  }

  beginInventory(options: { readonly truncated: boolean }): void {
    this.policy.beginInventory?.(this.state, options);
  }

  applySourceClaim(options: {
    readonly role: MetadataSourceRoleId;
    readonly claim: AgentSessionSourceClaimProjection;
  }): void {
    this.policy.applySourceClaim?.(this.state, options);
  }

  createParser(options: {
    readonly role: MetadataSourceRoleId;
    readonly format: "jsonl" | "sqlite";
    readonly sourcePath: string;
    readonly maximumPendingBytes: number;
  }): AgentUsageSourceParser {
    if (options.format !== "jsonl") {
      throw new TypeError("usage source projection requires a JSONL source");
    }
    return new JsonlUsageSourceParser(
      this,
      options.role,
      options.sourcePath,
      new IncrementalCoreUsageJsonlParser(
        (record, range) =>
          this.policy.parseRecord(this.state, {
            sourcePath: options.sourcePath,
            role: options.role,
            record,
            range
          }),
        { maximumPendingBytes: options.maximumPendingBytes }
      )
    );
  }
}

class JsonlUsageSourceParser<State> implements AgentUsageSourceParser {
  constructor(
    private readonly session: JsonlUsageProjectionSession<State>,
    private readonly role: MetadataSourceRoleId,
    private readonly sourcePath: string,
    private readonly parser: IncrementalCoreUsageJsonlParser
  ) {}

  append(
    ...args: Parameters<AgentUsageSourceParser["append"]>
  ): ReturnType<AgentUsageSourceParser["append"]> {
    return this.parser.append(...args);
  }

  reset(): void {
    this.parser.reset();
    this.session.policy.resetSource(this.session.state, this.sourcePath);
  }

  clone(session: AgentUsageSourceProjectionSession): AgentUsageSourceParser {
    if (
      !(session instanceof JsonlUsageProjectionSession) ||
      session.agentId !== this.session.agentId ||
      session.policy !== this.session.policy
    ) {
      throw new TypeError(
        "usage parser was cloned into a different projection"
      );
    }
    const typedSession = session as JsonlUsageProjectionSession<State>;
    const consume = (
      record: Record<string, unknown>,
      range: CoreUsageTimeRange
    ) =>
      typedSession.policy.parseRecord(typedSession.state, {
        sourcePath: this.sourcePath,
        role: this.role,
        record,
        range
      });
    return new JsonlUsageSourceParser(
      typedSession,
      this.role,
      this.sourcePath,
      this.parser.clone(consume)
    );
  }
}

interface ParsedUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  reportedCostUsd: number;
  score: number;
}

interface ObjectCandidate {
  path: string;
  value: Record<string, unknown>;
}

export function extractGenericUsageSample(options: {
  agentId: AgentId;
  pricingVendorId?: PricingVendorId;
  record: Record<string, unknown>;
  metricsRoot?: Record<string, unknown>;
  sourcePath: string;
  pricingMode?: PricingMode;
  treatsInputTokensAsUncached?: boolean;
}): CoreUsageEventSample | null {
  const metrics = pickBestUsageMetrics(
    options.metricsRoot ?? options.record,
    options.treatsInputTokensAsUncached ?? false
  );
  if (!metrics) return null;
  const timestampMs = normalizeUsageTimestamp(
    pickFirstString(options.record, [
      "timestamp",
      "created_at",
      "createdAt",
      "updated_at",
      "updatedAt"
    ]) ??
      pickFirstNumber(options.record, ["timestamp_ms", "timestampMs", "ts"]),
    Date.now()
  );
  const model = pickFirstString(options.record, [
    "model",
    "model_name",
    "modelName"
  ]);
  const estimate =
    metrics.reportedCostUsd > 0 || !options.pricingVendorId
      ? null
      : estimateModelCost({
          vendor: options.pricingVendorId,
          model,
          pricingMode: options.pricingMode,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheTokens: metrics.cacheReadTokens,
          cacheCreateTokens: metrics.cacheWriteTokens,
          cacheCreateTokensKnown: true,
          thinkingTokens: metrics.thinkingTokens
        });
  const costSource =
    metrics.reportedCostUsd > 0
      ? ("reported" as const)
      : metrics.totalTokens > 0
        ? estimate
          ? ("estimated" as const)
          : ("unavailable" as const)
        : ("unavailable" as const);
  return {
    vendor: options.agentId,
    timestampMs,
    sourcePath: options.sourcePath,
    sourceType: "jsonl",
    sessionId: pickFirstString(options.record, [
      "session_id",
      "sessionId",
      "conversation_id",
      "conversationId",
      "request_id",
      "requestId"
    ]),
    threadId: pickFirstString(options.record, [
      "thread_id",
      "threadId",
      "conversation_id",
      "conversationId",
      "id"
    ]),
    requestId: pickFirstOwnString(options.record, ["request_id", "requestId"]),
    model,
    pricingMode: options.pricingMode,
    cwd: normalizeUsagePath(
      pickFirstString(options.record, [
        "cwd",
        "current_working_directory",
        "path"
      ])
    ),
    projectPath: normalizeUsagePath(
      pickFirstString(options.record, [
        "project_path",
        "projectPath",
        "worktree"
      ])
    ),
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    cacheWriteTokensKnown: true,
    cacheTokens: metrics.cacheTokens,
    totalTokens: metrics.totalTokens,
    estimatedCostUsd:
      metrics.reportedCostUsd > 0
        ? metrics.reportedCostUsd
        : (estimate?.estimatedCostUsd ?? 0),
    costSource
  };
}

export function isUsageTimestampInRange(
  timestampMs: number,
  range: CoreUsageTimeRange
): boolean {
  return (
    timestampMs >= range.fromMs &&
    (typeof range.toMs !== "number" || timestampMs <= range.toMs)
  );
}

export function pickFirstOwnString(
  root: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function pickFirstString(
  root: Record<string, unknown> | null,
  keys: readonly string[]
): string | undefined {
  if (!root) return undefined;
  for (const candidate of collectObjectCandidates(root)) {
    const value = pickFirstOwnString(candidate.value, keys);
    if (value) return value;
  }
  return undefined;
}

export function pickFirstNumber(
  root: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const candidate of collectObjectCandidates(root)) {
    for (const key of keys) {
      const value = toFiniteNumber(candidate.value[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizeUsageTimestamp(
  value: unknown,
  fallback: number
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number))
      return normalizeUsageTimestamp(number, fallback);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return fallback;
}

export function normalizeUsagePath(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function pricingModeFromRecord(
  record: Record<string, unknown>,
  fallback: PricingMode
): PricingMode {
  for (const key of [
    "service_tier",
    "serviceTier",
    "pricing_mode",
    "pricingMode"
  ]) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    return typeof value === "string" &&
      ["fast", "priority"].includes(value.trim().toLowerCase())
      ? "fast"
      : "standard";
  }
  return fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickBestUsageMetrics(
  root: Record<string, unknown>,
  treatsInputTokensAsUncached: boolean
): ParsedUsageMetrics | null {
  let best: ParsedUsageMetrics | null = null;
  for (const candidate of collectObjectCandidates(root)) {
    const parsed = parseUsageMetrics(
      candidate.value,
      treatsInputTokensAsUncached
    );
    if (
      parsed &&
      (!best ||
        parsed.score > best.score ||
        (parsed.score === best.score &&
          parsed.totalTokens > best.totalTokens) ||
        (parsed.score === best.score &&
          parsed.totalTokens === best.totalTokens &&
          parsed.reportedCostUsd > best.reportedCostUsd))
    ) {
      best = parsed;
    }
  }
  return best;
}

function collectObjectCandidates(
  root: Record<string, unknown>,
  depth = 0,
  path = "$",
  output: ObjectCandidate[] = []
): ObjectCandidate[] {
  if (depth > 5) return output;
  output.push({ path, value: root });
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value)) {
      value.slice(0, 12).forEach((item, index) => {
        if (isRecord(item)) {
          collectObjectCandidates(
            item,
            depth + 1,
            `${path}.${key}[${index}]`,
            output
          );
        }
      });
    } else if (isRecord(value)) {
      collectObjectCandidates(value, depth + 1, `${path}.${key}`, output);
    }
  }
  return output;
}

function parseUsageMetrics(
  record: Record<string, unknown>,
  treatsInputTokensAsUncached: boolean
): ParsedUsageMetrics | null {
  const rawInputTokens =
    readNumericField(record, ["input_tokens", "inputTokens"]) ??
    readNumericField(record, ["prompt_tokens", "promptTokens"]) ??
    0;
  const rawOutputTokens =
    readNumericField(record, ["output_tokens", "outputTokens"]) ??
    readNumericField(record, ["completion_tokens", "completionTokens"]) ??
    0;
  const cacheReadTokens =
    readNumericField(record, [
      "cache_read_input_tokens",
      "cacheReadInputTokens"
    ]) ??
    readNumericField(record, [
      "cache_read_tokens",
      "cacheReadTokens",
      "cache_tokens",
      "cacheTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      ["cached_tokens", "cachedTokens"]
    ) ??
    0;
  const cacheWriteTokens =
    readNumericField(record, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens"
    ]) ??
    readNumericField(record, [
      "cache_creation_tokens",
      "cacheCreationTokens",
      "cache_write_tokens",
      "cacheWriteTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      [
        "cache_write_tokens",
        "cacheWriteTokens",
        "cache_creation_tokens",
        "cacheCreationTokens"
      ]
    ) ??
    0;
  const thinkingTokens =
    readNumericField(record, [
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
      "thinkingTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["completion_tokens_details", "output_tokens_details"],
      [
        "reasoning_tokens",
        "reasoningTokens",
        "thinking_tokens",
        "thinkingTokens"
      ]
    ) ??
    0;
  const inputTokens = treatsInputTokensAsUncached
    ? Math.max(0, rawInputTokens)
    : Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, rawOutputTokens - thinkingTokens);
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  const totalTokens =
    readNumericField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + outputTokens + thinkingTokens + cacheTokens;
  const reportedCostUsd =
    readNumericField(record, [
      "estimated_cost",
      "estimatedCost",
      "estimated_cost_usd",
      "estimatedCostUsd",
      "total_cost_usd",
      "totalCostUsd",
      "cost_usd",
      "costUsd",
      "price_usd",
      "priceUsd"
    ]) ?? 0;
  if (totalTokens <= 0 && reportedCostUsd <= 0) return null;
  const score =
    (inputTokens > 0 ? 2 : 0) +
    (outputTokens > 0 ? 2 : 0) +
    (thinkingTokens > 0 ? 1 : 0) +
    (cacheTokens > 0 ? 1 : 0) +
    (totalTokens > 0 ? 2 : 0) +
    (reportedCostUsd > 0 ? 3 : 0);
  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheTokens,
    totalTokens,
    reportedCostUsd,
    score
  };
}

function readNumericField(
  record: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNestedNumericField(
  record: Record<string, unknown>,
  parentKeys: readonly string[],
  childKeys: readonly string[]
): number | undefined {
  for (const parentKey of parentKeys) {
    const parent = record[parentKey];
    if (isRecord(parent)) {
      const value = readNumericField(parent, childKeys);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
