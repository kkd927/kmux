import type { CoreUsageEventSample } from "@kmux/metadata";

import type { AgentUsageSourceProjection } from "../../contracts";
import {
  createJsonlUsageSourceProjection,
  isRecord,
  isUsageTimestampInRange,
  normalizeUsageTimestamp,
  pickFirstString,
  toFiniteNumber,
  type UsageProjectionPolicy,
  type UsageProjectionRecordInput
} from "../usageParsingShared";
import { copilotSessionIdFromPath } from "./inventory";

interface CopilotContext {
  cwd?: string;
  sessionId?: string;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface CopilotUsageState {
  contexts: Map<string, CopilotContext>;
  totals: Map<string, TokenTotals>;
}

const copilotUsagePolicy: UsageProjectionPolicy<CopilotUsageState> = {
  createState: () => ({ contexts: new Map(), totals: new Map() }),
  cloneState: (state) => ({
    contexts: new Map(
      [...state.contexts].map(([path, context]) => [path, { ...context }])
    ),
    totals: new Map(
      [...state.totals].map(([key, totals]) => [key, { ...totals }])
    )
  }),
  resetSource(state, sourcePath) {
    state.contexts.delete(sourcePath);
    for (const key of state.totals.keys()) {
      if (key.startsWith(`${sourcePath}\t`)) state.totals.delete(key);
    }
  },
  parseRecord: parseCopilotUsageRecord
};

export function createCopilotUsageSourceProjection(): AgentUsageSourceProjection {
  return createJsonlUsageSourceProjection("copilot", copilotUsagePolicy);
}

function parseCopilotUsageRecord(
  state: CopilotUsageState,
  input: UsageProjectionRecordInput
): readonly CoreUsageEventSample[] {
  if (input.role !== "copilot-session") return [];
  const eventType =
    typeof input.record.type === "string" ? input.record.type : undefined;
  const data = isRecord(input.record.data) ? input.record.data : null;
  if (!eventType || !data) return [];
  if (eventType === "session.start" || eventType === "session.resume") {
    const previous = state.contexts.get(input.sourcePath) ?? {};
    const context = isRecord(data.context) ? data.context : null;
    state.contexts.set(input.sourcePath, {
      sessionId:
        pickFirstString(data, ["sessionId", "session_id"]) ??
        previous.sessionId ??
        copilotSessionIdFromPath(input.sourcePath),
      cwd:
        pickFirstString(context, ["cwd"]) ??
        pickFirstString(data, ["cwd"]) ??
        previous.cwd
    });
    return [];
  }
  if (eventType === "session.context_changed") {
    const previous = state.contexts.get(input.sourcePath) ?? {};
    state.contexts.set(input.sourcePath, {
      ...previous,
      cwd: pickFirstString(data, ["cwd"]) ?? previous.cwd
    });
    return [];
  }
  if (eventType !== "session.shutdown") return [];
  const modelMetrics = isRecord(data.modelMetrics) ? data.modelMetrics : null;
  if (!modelMetrics) return [];
  const context = state.contexts.get(input.sourcePath) ?? {
    sessionId: copilotSessionIdFromPath(input.sourcePath)
  };
  const timestampMs = normalizeUsageTimestamp(
    input.record.timestamp,
    Date.now()
  );
  const eventId =
    typeof input.record.id === "string" ? input.record.id : undefined;
  const samples: CoreUsageEventSample[] = [];
  for (const [model, rawMetric] of Object.entries(modelMetrics)) {
    if (!isRecord(rawMetric) || !isRecord(rawMetric.usage)) continue;
    const usage = rawMetric.usage;
    const absolute = tokenTotals(usage);
    const key = `${input.sourcePath}\t${model}`;
    const previous = state.totals.get(key) ?? emptyTotals();
    state.totals.set(key, absolute);
    const cacheReadTokens = delta(
      absolute.cacheReadTokens,
      previous.cacheReadTokens
    );
    const cacheWriteTokens = delta(
      absolute.cacheWriteTokens,
      previous.cacheWriteTokens
    );
    const inputTokens = delta(
      Math.max(
        0,
        absolute.inputTokens -
          absolute.cacheReadTokens -
          absolute.cacheWriteTokens
      ),
      Math.max(
        0,
        previous.inputTokens -
          previous.cacheReadTokens -
          previous.cacheWriteTokens
      )
    );
    const thinkingTokens = delta(
      absolute.reasoningTokens,
      previous.reasoningTokens
    );
    const outputTokens = delta(
      Math.max(0, absolute.outputTokens - absolute.reasoningTokens),
      Math.max(0, previous.outputTokens - previous.reasoningTokens)
    );
    const totalTokens =
      inputTokens +
      outputTokens +
      thinkingTokens +
      cacheReadTokens +
      cacheWriteTokens;
    if (
      totalTokens <= 0 ||
      !isUsageTimestampInRange(timestampMs, input.range)
    ) {
      continue;
    }
    const dedupeKey = [
      context.sessionId ?? input.sourcePath,
      eventId ?? timestampMs,
      model
    ].join("\t");
    samples.push({
      vendor: "copilot",
      timestampMs,
      sourcePath: input.sourcePath,
      sourceType: "jsonl",
      sessionId: context.sessionId,
      threadId: context.sessionId,
      eventId: eventId ? `${eventId}:${model}` : undefined,
      dedupeKey,
      model,
      cwd: context.cwd,
      projectPath: context.cwd,
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteTokensKnown: true,
      cacheTokens: cacheReadTokens + cacheWriteTokens,
      totalTokens,
      estimatedCostUsd: 0,
      costSource: "unavailable"
    });
  }
  return samples;
}

function tokenTotals(usage: Record<string, unknown>): TokenTotals {
  return {
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens)
  };
}

function nonNegative(value: unknown): number {
  return Math.max(0, toFiniteNumber(value) ?? 0);
}

function delta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
}
