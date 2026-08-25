import {
  estimateModelCost,
  type CoreUsageEventSample,
  type PricingMode
} from "@kmux/metadata";

import type { AgentUsageSourceProjection } from "../../contracts";
import {
  createJsonlUsageSourceProjection,
  extractGenericUsageSample,
  isRecord,
  isUsageTimestampInRange,
  normalizeUsagePath,
  normalizeUsageTimestamp,
  pickFirstString,
  pricingModeFromRecord,
  toFiniteNumber,
  type UsageProjectionPolicy,
  type UsageProjectionRecordInput
} from "../usageParsingShared";
import { isCodexSubagentSessionMetadata } from "./sessionMetadata";

interface CodexSessionContext {
  cwd?: string;
  hasSessionMetadata?: boolean;
  isSubagent?: boolean;
  model?: string;
  pricingMode: PricingMode;
  projectPath?: string;
  sessionId?: string;
}

interface TokenUsageTotals {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

interface CodexUsageState {
  contexts: Map<string, CodexSessionContext>;
  totals: Map<string, TokenUsageTotals>;
}

const codexUsagePolicy: UsageProjectionPolicy<CodexUsageState> = {
  createState: () => ({ contexts: new Map(), totals: new Map() }),
  cloneState: (state) => ({
    contexts: new Map(
      [...state.contexts].map(([path, context]) => [path, { ...context }])
    ),
    totals: new Map(
      [...state.totals].map(([path, totals]) => [path, { ...totals }])
    )
  }),
  resetSource(state, sourcePath) {
    state.contexts.delete(sourcePath);
    state.totals.delete(sourcePath);
  },
  parseRecord: (state, input) => parseCodexUsageRecord(state, input)
};

export function createCodexUsageSourceProjection(): AgentUsageSourceProjection {
  return createJsonlUsageSourceProjection("codex", codexUsagePolicy);
}

function parseCodexUsageRecord(
  state: CodexUsageState,
  input: UsageProjectionRecordInput
): readonly CoreUsageEventSample[] {
  const { record, sourcePath, range } = input;
  const recordType = typeof record.type === "string" ? record.type : undefined;
  if (!recordType) {
    const sample = extractGenericUsageSample({
      agentId: "codex",
      pricingVendorId: "codex",
      pricingMode: pricingModeFromRecord(record, "standard"),
      record,
      sourcePath
    });
    return sample && isUsageTimestampInRange(sample.timestampMs, range)
      ? [withCrossSourceIdentity(sample)]
      : [];
  }

  if (recordType === "session_meta") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const previous = state.contexts.get(sourcePath) ?? {
      pricingMode: "standard" as const
    };
    const first = !previous.hasSessionMetadata;
    state.contexts.set(sourcePath, {
      ...previous,
      cwd: first
        ? (normalizeUsagePath(
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
      pricingMode: pricingModeFromRecord(payload, previous.pricingMode),
      projectPath: first
        ? (normalizeUsagePath(
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
    const previous = state.contexts.get(sourcePath) ?? {
      pricingMode: "standard" as const
    };
    state.contexts.set(sourcePath, {
      ...previous,
      model:
        pickFirstString(payload, ["model", "model_name", "modelName"]) ??
        previous.model,
      pricingMode: pricingModeFromRecord(payload, previous.pricingMode)
    });
    return [];
  }

  if (recordType !== "event_msg") return [];
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return [];
  if (payload.type === "session_configured") {
    const previous = state.contexts.get(sourcePath) ?? {
      pricingMode: "standard" as const
    };
    state.contexts.set(sourcePath, {
      ...previous,
      cwd:
        normalizeUsagePath(
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
    const previous = state.contexts.get(sourcePath) ?? {
      pricingMode: "standard" as const
    };
    state.contexts.set(sourcePath, {
      ...previous,
      cwd:
        normalizeUsagePath(
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

  const context = state.contexts.get(sourcePath);
  if (context?.isSubagent) return [];
  const info = isRecord(payload.info) ? payload.info : null;
  const usage =
    info && isRecord(info.total_token_usage) ? info.total_token_usage : null;
  if (!usage) return [];

  const absoluteInputTokens = toFiniteNumber(usage.input_tokens) ?? 0;
  const absoluteCacheReadTokens =
    toFiniteNumber(usage.cached_input_tokens) ?? 0;
  const absoluteOutputTokens = toFiniteNumber(usage.output_tokens) ?? 0;
  const absoluteThinkingTokens =
    toFiniteNumber(usage.reasoning_output_tokens) ?? 0;
  const absoluteTotalTokens =
    toFiniteNumber(usage.total_tokens) ??
    absoluteInputTokens + absoluteOutputTokens;
  const previous = state.totals.get(sourcePath) ?? emptyTotals();
  const inputTokens = Math.max(
    0,
    absoluteInputTokens -
      previous.inputTokens -
      Math.max(0, absoluteCacheReadTokens - previous.cacheReadTokens)
  );
  const cacheReadTokens = Math.max(
    0,
    absoluteCacheReadTokens - previous.cacheReadTokens
  );
  const outputDelta = Math.max(0, absoluteOutputTokens - previous.outputTokens);
  const thinkingTokens = Math.max(
    0,
    absoluteThinkingTokens - previous.thinkingTokens
  );
  const outputTokens = Math.max(0, outputDelta - thinkingTokens);
  const totalTokens = Math.max(0, absoluteTotalTokens - previous.totalTokens);
  state.totals.set(sourcePath, {
    cacheReadTokens: absoluteCacheReadTokens,
    inputTokens: absoluteInputTokens,
    outputTokens: absoluteOutputTokens,
    thinkingTokens: absoluteThinkingTokens,
    totalTokens: absoluteTotalTokens
  });
  if (totalTokens <= 0) return [];

  const timestampMs = normalizeUsageTimestamp(
    record.timestamp ?? payload.timestamp,
    Date.now()
  );
  if (!isUsageTimestampInRange(timestampMs, range)) return [];
  const estimatedCostUsd =
    estimateModelCost({
      vendor: "codex",
      model: context?.model,
      pricingMode: context?.pricingMode ?? "standard",
      inputTokens,
      outputTokens,
      cacheTokens: cacheReadTokens,
      thinkingTokens,
      cacheCreateTokens: 0,
      cacheCreateTokensKnown: false
    })?.estimatedCostUsd ?? 0;
  const eventId = [
    "codex-token-count",
    context?.sessionId ?? "",
    timestampMs,
    absoluteInputTokens,
    absoluteCacheReadTokens,
    absoluteOutputTokens,
    absoluteThinkingTokens,
    absoluteTotalTokens
  ].join(":");
  return [
    {
      vendor: "codex",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: context?.sessionId,
      threadId: context?.sessionId,
      eventId,
      dedupeKey: [context?.sessionId ?? "", eventId].join("\t"),
      model: context?.model,
      pricingMode: context?.pricingMode ?? "standard",
      cwd: context?.cwd,
      projectPath: context?.projectPath ?? context?.cwd,
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: cacheReadTokens,
      totalTokens,
      estimatedCostUsd,
      costSource: estimatedCostUsd > 0 ? "estimated" : "unavailable"
    }
  ];
}

function emptyTotals(): TokenUsageTotals {
  return {
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  };
}

function withCrossSourceIdentity(
  sample: CoreUsageEventSample
): CoreUsageEventSample {
  return sample.eventId || sample.threadId
    ? {
        ...sample,
        dedupeKey: [
          sample.sessionId ?? "",
          sample.eventId ?? sample.threadId ?? ""
        ].join("\t")
      }
    : sample;
}
