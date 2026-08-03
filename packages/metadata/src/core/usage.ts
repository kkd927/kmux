import { isCodexSubagentSessionMetadata } from "../codexSession";
import { estimateModelCost, type PricingMode } from "../modelPricing";
import type { MetadataVendor } from "./sourceContract";

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
}

export interface CoreUsageTimeRange {
  fromMs: number;
  toMs?: number;
}

interface CodexSessionContext {
  cwd?: string;
  hasSessionMetadata?: boolean;
  isSubagent?: boolean;
  model?: string;
  pricingMode: PricingMode;
  projectPath?: string;
  sessionId?: string;
}

interface AntigravitySessionContext {
  model?: string;
}

interface TokenUsageTotals {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

interface ParsedUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  score: number;
}

interface ObjectCandidate {
  path: string;
  value: Record<string, unknown>;
}

export interface CoreUsageParserState {
  codexContexts: Map<string, CodexSessionContext>;
  codexTotals: Map<string, TokenUsageTotals>;
  antigravityContexts: Map<string, AntigravitySessionContext>;
  antigravityWorkspaceByConversation: Map<string, string>;
}

export function createCoreUsageParserState(
  options: {
    antigravityWorkspaceByConversation?: ReadonlyMap<string, string>;
  } = {}
): CoreUsageParserState {
  return {
    codexContexts: new Map(),
    codexTotals: new Map(),
    antigravityContexts: new Map(),
    antigravityWorkspaceByConversation: new Map(
      options.antigravityWorkspaceByConversation
    )
  };
}

export function cloneCoreUsageParserState(
  state: CoreUsageParserState
): CoreUsageParserState {
  return {
    codexContexts: new Map(
      [...state.codexContexts].map(([sourcePath, context]) => [
        sourcePath,
        { ...context }
      ])
    ),
    codexTotals: new Map(
      [...state.codexTotals].map(([sourcePath, totals]) => [
        sourcePath,
        { ...totals }
      ])
    ),
    antigravityContexts: new Map(
      [...state.antigravityContexts].map(([sourcePath, context]) => [
        sourcePath,
        { ...context }
      ])
    ),
    antigravityWorkspaceByConversation: new Map(
      state.antigravityWorkspaceByConversation
    )
  };
}

export function resetCoreUsageSourceState(
  state: CoreUsageParserState,
  sourcePath: string
): void {
  state.codexContexts.delete(sourcePath);
  state.codexTotals.delete(sourcePath);
  state.antigravityContexts.delete(sourcePath);
}

const textEncoder = new TextEncoder();

export function consumeCoreUsageJsonLine(
  output: CoreUsageEventSample[],
  vendor: CoreUsageVendor,
  sourcePath: string,
  range: CoreUsageTimeRange,
  line: string,
  offset: number,
  hasTrailingNewline: boolean,
  state: CoreUsageParserState
): number {
  const nextOffset =
    offset + textEncoder.encode(line).byteLength + (hasTrailingNewline ? 1 : 0);
  const trimmed = line.trim();
  if (!trimmed) return nextOffset;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    output.push(
      ...extractUsageSamplesFromJsonLine(
        vendor,
        parsed,
        sourcePath,
        range,
        state
      )
    );
    return nextOffset;
  } catch {
    return hasTrailingNewline ? nextOffset : offset;
  }
}

export function parseCoreUsageJsonDocument(options: {
  vendor: CoreUsageVendor;
  sourcePath: string;
  value: Record<string, unknown>;
  range: CoreUsageTimeRange;
  state: CoreUsageParserState;
}): CoreUsageEventSample[] {
  const { vendor, value, sourcePath, range } = options;
  if (vendor === "claude") {
    const sample = extractClaudeUsageSample(value, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }
  const sample = extractUsageSampleFromRecord(vendor, value, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range)
    ? [sample]
    : [];
}

export class IncrementalCoreUsageParser {
  private pending = "";
  private readonly maximumPendingBytes: number;

  constructor(
    readonly vendor: CoreUsageVendor,
    readonly sourcePath: string,
    readonly state: CoreUsageParserState,
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
  ): CoreUsageEventSample[] {
    const combined = this.pending + text;
    const lines = combined.split("\n");
    const trailingLine = lines.pop() ?? "";
    this.pending = "";
    if (trailingLine) {
      if (options.eof && isCompleteJsonLine(trailingLine)) {
        lines.push(trailingLine);
      } else {
        this.pending = trailingLine;
        if (
          textEncoder.encode(this.pending).byteLength > this.maximumPendingBytes
        ) {
          throw new RangeError("usage JSONL record exceeds its byte bound");
        }
      }
    }
    const samples: CoreUsageEventSample[] = [];
    for (const line of lines) {
      if (textEncoder.encode(line).byteLength > this.maximumPendingBytes) {
        throw new RangeError("usage JSONL record exceeds its byte bound");
      }
      consumeCoreUsageJsonLine(
        samples,
        this.vendor,
        this.sourcePath,
        range,
        line,
        0,
        true,
        this.state
      );
    }
    return samples;
  }

  reset(): void {
    this.pending = "";
    resetCoreUsageSourceState(this.state, this.sourcePath);
  }

  clone(state: CoreUsageParserState = this.state): IncrementalCoreUsageParser {
    const parser = new IncrementalCoreUsageParser(
      this.vendor,
      this.sourcePath,
      state,
      { maximumPendingBytes: this.maximumPendingBytes }
    );
    parser.pending = this.pending;
    return parser;
  }
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

function extractUsageSamplesFromJsonLine(
  vendor: CoreUsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  range: CoreUsageTimeRange,
  state: CoreUsageParserState
): CoreUsageEventSample[] {
  if (vendor === "codex") {
    return extractCodexUsageSamples(
      record,
      sourcePath,
      range,
      state.codexContexts,
      state.codexTotals
    );
  }
  if (vendor === "antigravity") {
    return extractAntigravityUsageSamples(
      record,
      sourcePath,
      range,
      state.antigravityContexts,
      state.antigravityWorkspaceByConversation
    );
  }
  if (vendor === "claude") {
    const sample = extractClaudeUsageSample(record, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }
  const sample = extractUsageSampleFromRecord(vendor, record, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range)
    ? [sample]
    : [];
}

function extractUsageSampleFromRecord(
  vendor: CoreUsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  metricsRoot: Record<string, unknown> = record
): CoreUsageEventSample | null {
  const metrics = pickBestUsageMetrics(vendor, metricsRoot);
  if (!metrics) return null;
  const timestampMs = normalizeTimestamp(
    pickFirstString(record, [
      "timestamp",
      "created_at",
      "createdAt",
      "updated_at",
      "updatedAt"
    ]) ?? pickFirstNumber(record, ["timestamp_ms", "timestampMs", "ts"]),
    Date.now()
  );
  const model = pickFirstString(record, ["model", "model_name", "modelName"]);
  const pricingMode =
    vendor === "codex" ? pricingModeFromRecord(record, "standard") : undefined;
  const reportedCostUsd = metrics.estimatedCostUsd;
  const estimate =
    reportedCostUsd > 0
      ? null
      : estimateModelCostForSample(vendor, model, metrics, pricingMode);
  const costSource: CoreUsageCostSource =
    reportedCostUsd > 0
      ? "reported"
      : metrics.totalTokens > 0
        ? (estimate?.costSource ?? "unavailable")
        : "unavailable";
  return {
    vendor,
    timestampMs,
    sourcePath,
    sourceType: "jsonl",
    sessionId: pickFirstString(record, [
      "session_id",
      "sessionId",
      "conversation_id",
      "conversationId",
      "request_id",
      "requestId"
    ]),
    threadId: pickFirstString(record, [
      "thread_id",
      "threadId",
      "conversation_id",
      "conversationId",
      "id"
    ]),
    requestId: pickFirstOwnString(record, ["request_id", "requestId"]),
    model,
    pricingMode,
    cwd: normalizePathValue(
      pickFirstString(record, ["cwd", "current_working_directory", "path"])
    ),
    projectPath: normalizePathValue(
      pickFirstString(record, ["project_path", "projectPath", "worktree"])
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
      reportedCostUsd > 0 ? reportedCostUsd : (estimate?.estimatedCostUsd ?? 0),
    costSource
  };
}

function extractClaudeUsageSample(
  record: Record<string, unknown>,
  sourcePath: string
): CoreUsageEventSample | null {
  const message = isRecord(record.message) ? record.message : null;
  const usage = message && isRecord(message.usage) ? message.usage : null;
  const recordType = typeof record.type === "string" ? record.type : undefined;
  const hasClaudeCodeMarker =
    "uuid" in record ||
    "parentUuid" in record ||
    "userType" in record ||
    "isSidechain" in record ||
    "agentId" in record;
  if (message && recordType === "assistant") {
    return usage
      ? extractUsageSampleFromRecord("claude", record, sourcePath, usage)
      : null;
  }
  if (hasClaudeCodeMarker && isClaudeCodeNonUsageRecordType(recordType)) {
    return null;
  }
  return extractUsageSampleFromRecord("claude", record, sourcePath);
}

function isClaudeCodeNonUsageRecordType(type: string | undefined): boolean {
  return (
    type === "user" ||
    type === "attachment" ||
    type === "system" ||
    type === "mode" ||
    type === "permission-mode" ||
    type === "file-history-snapshot" ||
    type === "ai-title" ||
    type === "last-prompt" ||
    type === "queue-operation" ||
    type === "pr-link" ||
    type === "agent-name"
  );
}

function extractCodexUsageSamples(
  record: Record<string, unknown>,
  sourcePath: string,
  range: CoreUsageTimeRange,
  contexts: Map<string, CodexSessionContext>,
  totals: Map<string, TokenUsageTotals>
): CoreUsageEventSample[] {
  const recordType = typeof record.type === "string" ? record.type : undefined;
  if (!recordType) {
    const sample = extractUsageSampleFromRecord("codex", record, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }
  if (recordType === "session_meta") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const previous: CodexSessionContext = contexts.get(sourcePath) ?? {
      pricingMode: "standard"
    };
    const first = !previous.hasSessionMetadata;
    contexts.set(sourcePath, {
      ...previous,
      cwd: first
        ? (normalizePathValue(
            pickFirstString(payload, ["cwd", "project_path", "projectPath"])
          ) ?? previous.cwd)
        : previous.cwd,
      hasSessionMetadata: true,
      isSubagent: first
        ? isCodexSubagentSessionMetadata(payload)
        : previous.isSubagent,
      model: first
        ? (pickFirstString(payload, ["model", "model_name", "modelName"]) ??
          previous.model)
        : previous.model,
      pricingMode: pricingModeFromRecord(
        payload,
        previous.pricingMode ?? "standard"
      ),
      projectPath: first
        ? (normalizePathValue(
            pickFirstString(payload, ["project_path", "projectPath", "cwd"])
          ) ?? previous.projectPath)
        : previous.projectPath,
      sessionId: first
        ? (pickFirstString(payload, ["id", "session_id", "sessionId"]) ??
          previous.sessionId)
        : previous.sessionId
    });
    return [];
  }
  if (recordType === "turn_context") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const previous: CodexSessionContext = contexts.get(sourcePath) ?? {
      pricingMode: "standard"
    };
    contexts.set(sourcePath, {
      ...previous,
      model:
        pickFirstString(payload, ["model", "model_name", "modelName"]) ??
        previous.model,
      pricingMode: pricingModeFromRecord(
        payload,
        previous.pricingMode ?? "standard"
      )
    });
    return [];
  }
  if (recordType !== "event_msg") return [];
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return [];
  if (payload.type === "session_configured") {
    const previous = contexts.get(sourcePath) ?? { pricingMode: "standard" };
    contexts.set(sourcePath, {
      ...previous,
      cwd:
        normalizePathValue(
          pickFirstString(payload, ["cwd", "project_path", "projectPath"])
        ) ?? previous.cwd,
      model:
        pickFirstString(payload, ["model", "model_name", "modelName"]) ??
        previous.model,
      pricingMode: pricingModeFromRecord(payload, "standard"),
      sessionId:
        pickFirstString(payload, [
          "session_id",
          "sessionId",
          "thread_id",
          "threadId"
        ]) ?? previous.sessionId
    });
    return [];
  }
  if (payload.type === "thread_settings_applied") {
    const settings = isRecord(payload.thread_settings)
      ? payload.thread_settings
      : isRecord(payload.threadSettings)
        ? payload.threadSettings
        : {};
    const previous = contexts.get(sourcePath) ?? { pricingMode: "standard" };
    contexts.set(sourcePath, {
      ...previous,
      cwd:
        normalizePathValue(
          pickFirstString(settings, ["cwd", "project_path", "projectPath"])
        ) ?? previous.cwd,
      model:
        pickFirstString(settings, ["model", "model_name", "modelName"]) ??
        previous.model,
      pricingMode: pricingModeFromRecord(settings, previous.pricingMode)
    });
    return [];
  }
  if (payload.type !== "token_count") return [];
  const context = contexts.get(sourcePath);
  if (context?.isSubagent) return [];
  const info = isRecord(payload.info) ? payload.info : null;
  const totalUsage =
    info && isRecord(info.total_token_usage) ? info.total_token_usage : null;
  if (!totalUsage) return [];
  const absoluteInputTokens = toFiniteNumber(totalUsage.input_tokens) ?? 0;
  const absoluteCacheReadTokens =
    toFiniteNumber(totalUsage.cached_input_tokens) ?? 0;
  const absoluteOutputTokens = toFiniteNumber(totalUsage.output_tokens) ?? 0;
  const absoluteThinkingTokens =
    toFiniteNumber(totalUsage.reasoning_output_tokens) ?? 0;
  const absoluteTotalTokens =
    toFiniteNumber(totalUsage.total_tokens) ??
    absoluteInputTokens + absoluteOutputTokens;
  const previous = totals.get(sourcePath) ?? {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  };
  const deltaInputTokens = Math.max(
    0,
    absoluteInputTokens - previous.inputTokens
  );
  const deltaCacheReadTokens = Math.max(
    0,
    absoluteCacheReadTokens - previous.cacheReadTokens
  );
  const deltaOutputTokens = Math.max(
    0,
    absoluteOutputTokens - previous.outputTokens
  );
  const deltaThinkingTokens = Math.max(
    0,
    absoluteThinkingTokens - previous.thinkingTokens
  );
  const deltaVisibleOutputTokens = Math.max(
    0,
    deltaOutputTokens - deltaThinkingTokens
  );
  const deltaTotalTokens = Math.max(
    0,
    absoluteTotalTokens - previous.totalTokens
  );
  totals.set(sourcePath, {
    cacheReadTokens: absoluteCacheReadTokens,
    cacheWriteTokens: 0,
    cacheTokens: absoluteCacheReadTokens,
    inputTokens: absoluteInputTokens,
    outputTokens: absoluteOutputTokens,
    thinkingTokens: absoluteThinkingTokens,
    totalTokens: absoluteTotalTokens
  });
  if (deltaTotalTokens <= 0) return [];
  const timestampMs = normalizeTimestamp(
    record.timestamp ?? payload.timestamp,
    Date.now()
  );
  if (!isTimestampInRange(timestampMs, range)) return [];
  const estimatedCostUsd =
    estimateModelCost({
      vendor: "codex",
      model: context?.model,
      pricingMode: context?.pricingMode ?? "standard",
      inputTokens: Math.max(0, deltaInputTokens - deltaCacheReadTokens),
      outputTokens: deltaVisibleOutputTokens,
      cacheTokens: deltaCacheReadTokens,
      thinkingTokens: deltaThinkingTokens,
      cacheCreateTokens: 0,
      cacheCreateTokensKnown: false
    })?.estimatedCostUsd ?? 0;
  return [
    {
      vendor: "codex",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: context?.sessionId,
      threadId: context?.sessionId,
      eventId: [
        "codex-token-count",
        context?.sessionId ?? "",
        timestampMs,
        absoluteInputTokens,
        absoluteCacheReadTokens,
        absoluteOutputTokens,
        absoluteThinkingTokens,
        absoluteTotalTokens
      ].join(":"),
      model: context?.model,
      pricingMode: context?.pricingMode ?? "standard",
      cwd: context?.cwd,
      projectPath: context?.projectPath ?? context?.cwd,
      inputTokens: Math.max(0, deltaInputTokens - deltaCacheReadTokens),
      outputTokens: deltaVisibleOutputTokens,
      thinkingTokens: deltaThinkingTokens,
      cacheReadTokens: deltaCacheReadTokens,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: deltaCacheReadTokens,
      totalTokens: deltaTotalTokens,
      estimatedCostUsd,
      costSource: estimatedCostUsd > 0 ? "estimated" : "unavailable"
    }
  ];
}

function extractAntigravityUsageSamples(
  record: Record<string, unknown>,
  sourcePath: string,
  range: CoreUsageTimeRange,
  contexts: Map<string, AntigravitySessionContext>,
  workspaceByConversation: Map<string, string>
): CoreUsageEventSample[] {
  const conversationId =
    antigravityConversationIdFromPath(sourcePath) ??
    pickFirstString(record, ["conversationId", "conversation_id"]);
  const cwd = conversationId
    ? workspaceByConversation.get(conversationId)
    : undefined;
  const inferredModel = inferAntigravityModelFromRecord(record);
  const previousContext = contexts.get(sourcePath);
  const model = inferredModel ?? previousContext?.model;
  if (inferredModel && previousContext?.model !== inferredModel) {
    contexts.set(sourcePath, { model: inferredModel });
  }
  const augmented: Record<string, unknown> = { ...record };
  if (conversationId && !pickFirstString(augmented, ["conversationId"])) {
    augmented.conversationId = conversationId;
  }
  if (cwd && !pickFirstString(augmented, ["cwd"])) augmented.cwd = cwd;
  if (cwd && !pickFirstString(augmented, ["projectPath"])) {
    augmented.projectPath = cwd;
  }
  if (model && !pickFirstString(augmented, ["model"])) augmented.model = model;
  const reported = extractUsageSampleFromRecord(
    "antigravity",
    augmented,
    sourcePath
  );
  if (reported && isTimestampInRange(reported.timestampMs, range)) {
    return [
      {
        ...reported,
        sessionId: reported.sessionId ?? conversationId,
        threadId:
          reported.threadId ??
          antigravityThreadId(conversationId, record, reported.timestampMs),
        model: reported.model ?? model,
        cwd: reported.cwd ?? cwd,
        projectPath: reported.projectPath ?? cwd,
        costSource: reported.costSource ?? "unavailable"
      }
    ];
  }
  const timestampMs = normalizeTimestamp(
    record.created_at ??
      record.createdAt ??
      record.timestamp ??
      record.updated_at ??
      record.updatedAt,
    Date.now()
  );
  if (!isTimestampInRange(timestampMs, range)) return [];
  const text = extractAntigravityTranscriptText(record);
  const inputTokens = estimateTranscriptTokens(text.inputText);
  const outputTokens = estimateTranscriptTokens(text.outputText);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return [];
  const estimated = estimateModelCostForSample("antigravity", model, {
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    totalTokens,
    estimatedCostUsd: 0,
    score: 0
  });
  return [
    {
      vendor: "antigravity",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: conversationId,
      threadId: antigravityThreadId(conversationId, record, timestampMs),
      model,
      cwd,
      projectPath: cwd,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: 0,
      totalTokens,
      estimatedCostUsd: estimated?.estimatedCostUsd ?? 0,
      costSource: estimated?.costSource ?? "unavailable"
    }
  ];
}

function extractAntigravityTranscriptText(record: Record<string, unknown>): {
  inputText: string;
  outputText: string;
} {
  const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
  const source =
    typeof record.source === "string" ? record.source.toUpperCase() : "";
  const content = stringifyTranscriptValue(record.content);
  const toolCalls = Array.isArray(record.tool_calls)
    ? stringifyTranscriptValue(record.tool_calls)
    : "";
  return source === "MODEL" &&
    (type.endsWith("_RESPONSE") || Boolean(toolCalls))
    ? {
        inputText: "",
        outputText: [content, toolCalls].filter(Boolean).join("\n")
      }
    : { inputText: content, outputText: "" };
}

function stringifyTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function estimateTranscriptTokens(value: string): number {
  const normalized = value.trim();
  return normalized ? Math.max(1, Math.ceil(normalized.length / 4)) : 0;
}

function antigravityConversationIdFromPath(
  sourcePath: string
): string | undefined {
  return sourcePath
    .replace(/\\/g, "/")
    .match(/\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/u)?.[1];
}

function antigravityThreadId(
  conversationId: string | undefined,
  record: Record<string, unknown>,
  timestampMs: number
): string | undefined {
  const explicit = pickFirstString(record, [
    "thread_id",
    "threadId",
    "id",
    "messageId",
    "eventId"
  ]);
  if (explicit) return explicit;
  const stepIndex = toFiniteNumber(record.step_index ?? record.stepIndex);
  if (conversationId && stepIndex !== undefined) {
    return `${conversationId}:${stepIndex}`;
  }
  return conversationId ? `${conversationId}:${timestampMs}` : undefined;
}

function inferAntigravityModelFromRecord(
  record: Record<string, unknown>
): string | undefined {
  const explicit = pickFirstString(record, [
    "model",
    "model_name",
    "modelName"
  ]);
  if (explicit) return explicit;
  const content = stringifyTranscriptValue(record.content);
  return (
    content.match(/gemini-[A-Za-z0-9._-]+/iu)?.[0] ??
    content
      .match(
        /Gemini\s+\d+(?:\.\d+)?\s+(?:Pro|Flash(?:[- ]Lite)?)(?:\s*\((?:Low|Medium|High)\))?/iu
      )?.[0]
      ?.trim()
      .replace(/[.。]+$/u, "")
  );
}

function pickBestUsageMetrics(
  vendor: CoreUsageVendor,
  root: Record<string, unknown>
): ParsedUsageMetrics | null {
  let best: ParsedUsageMetrics | null = null;
  for (const candidate of collectObjectCandidates(root)) {
    const parsed = parseUsageMetrics(vendor, candidate.value);
    if (
      parsed &&
      (!best ||
        parsed.score > best.score ||
        (parsed.score === best.score &&
          parsed.totalTokens > best.totalTokens) ||
        (parsed.score === best.score &&
          parsed.totalTokens === best.totalTokens &&
          parsed.estimatedCostUsd > best.estimatedCostUsd))
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
  vendor: CoreUsageVendor,
  record: Record<string, unknown>
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
  const inputTokens = treatsInputTokensAsUncached(vendor, record)
    ? Math.max(0, rawInputTokens)
    : Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, rawOutputTokens - thinkingTokens);
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  const totalTokens =
    readNumericField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + outputTokens + thinkingTokens + cacheTokens;
  const estimatedCostUsd =
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
  if (totalTokens <= 0 && estimatedCostUsd <= 0) return null;
  const score =
    (inputTokens > 0 ? 2 : 0) +
    (outputTokens > 0 ? 2 : 0) +
    (thinkingTokens > 0 ? 1 : 0) +
    (cacheTokens > 0 ? 1 : 0) +
    (totalTokens > 0 ? 2 : 0) +
    (estimatedCostUsd > 0 ? 3 : 0);
  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheTokens,
    totalTokens,
    estimatedCostUsd,
    score
  };
}

function estimateModelCostForSample(
  vendor: CoreUsageVendor,
  model: string | undefined,
  metrics: ParsedUsageMetrics,
  pricingMode?: PricingMode
): { estimatedCostUsd: number; costSource: CoreUsageCostSource } | null {
  if (vendor === "unknown") return null;
  const estimated = estimateModelCost({
    vendor: vendor === "antigravity" ? "gemini" : vendor,
    model,
    pricingMode,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheTokens: metrics.cacheReadTokens,
    cacheCreateTokens: metrics.cacheWriteTokens,
    cacheCreateTokensKnown: true,
    thinkingTokens: metrics.thinkingTokens
  });
  return estimated
    ? { estimatedCostUsd: estimated.estimatedCostUsd, costSource: "estimated" }
    : null;
}

function pricingModeFromRecord(
  record: Record<string, unknown>,
  fallback: PricingMode
): PricingMode {
  for (const key of [
    "service_tier",
    "serviceTier",
    "pricing_mode",
    "pricingMode"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    return typeof value === "string" &&
      ["fast", "priority"].includes(value.trim().toLowerCase())
      ? "fast"
      : "standard";
  }
  return fallback;
}

export function coreUsageSampleIdentity(sample: CoreUsageEventSample): string {
  if (sample.aggregateId) return `aggregate\t${sample.aggregateId}`;
  const claudeIdentity = claudeCanonicalUsageIdentity(sample);
  if (claudeIdentity) return claudeIdentity;
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
  if (
    (sample.vendor === "codex" || sample.vendor === "antigravity") &&
    (sample.eventId || sample.threadId)
  ) {
    return [sample.vendor, sample.sessionId ?? "", eventKey].join("\t");
  }
  return [sample.vendor, sample.sourcePath, eventKey].join("\t");
}

export function shouldReplaceCoreUsageSample(
  existing: CoreUsageEventSample,
  candidate: CoreUsageEventSample
): boolean {
  const existingIdentity = claudeCanonicalUsageIdentity(existing);
  const candidateIdentity = claudeCanonicalUsageIdentity(candidate);
  if (
    existingIdentity &&
    candidateIdentity &&
    existingIdentity === candidateIdentity
  ) {
    if (candidate.totalTokens !== existing.totalTokens) {
      return candidate.totalTokens > existing.totalTokens;
    }
    const existingSubagent = isClaudeSubagentSource(existing);
    const candidateSubagent = isClaudeSubagentSource(candidate);
    if (existingSubagent !== candidateSubagent) {
      return existingSubagent && !candidateSubagent;
    }
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

function claudeCanonicalUsageIdentity(
  sample: CoreUsageEventSample
): string | null {
  return sample.vendor === "claude" && sample.threadId && sample.requestId
    ? [sample.vendor, sample.threadId, sample.requestId].join("\t")
    : null;
}

function isClaudeSubagentSource(sample: CoreUsageEventSample): boolean {
  return sample.sourcePath.replace(/\\/g, "/").includes("/subagents/");
}

function isTimestampInRange(
  timestampMs: number,
  range: CoreUsageTimeRange
): boolean {
  return (
    timestampMs >= range.fromMs &&
    (typeof range.toMs !== "number" || timestampMs <= range.toMs)
  );
}

function pickFirstOwnString(
  root: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickFirstString(
  root: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!root) return undefined;
  for (const candidate of collectObjectCandidates(root)) {
    const value = pickFirstOwnString(candidate.value, keys);
    if (value) return value;
  }
  return undefined;
}

function pickFirstNumber(
  root: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const candidate of collectObjectCandidates(root)) {
    for (const key of keys) {
      const value = toFiniteNumber(candidate.value[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function readNumericField(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNestedNumericField(
  record: Record<string, unknown>,
  parentKeys: string[],
  childKeys: string[]
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

function treatsInputTokensAsUncached(
  vendor: CoreUsageVendor,
  record: Record<string, unknown>
): boolean {
  return (
    vendor === "claude" &&
    readNumericField(record, ["input_tokens", "inputTokens"]) !== undefined
  );
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return normalizeTimestamp(number, fallback);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return fallback;
}

function normalizePathValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
