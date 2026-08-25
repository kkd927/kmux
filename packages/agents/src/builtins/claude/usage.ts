import type { CoreUsageEventSample } from "@kmux/metadata";

import type { AgentUsageSourceProjection } from "../../contracts";
import {
  createJsonlUsageSourceProjection,
  extractGenericUsageSample,
  isRecord,
  isUsageTimestampInRange,
  type UsageProjectionPolicy,
  type UsageProjectionRecordInput
} from "../usageParsingShared";

type ClaudeUsageState = Record<never, never>;

const CLAUDE_NON_USAGE_RECORD_TYPES = new Set([
  "user",
  "attachment",
  "system",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "ai-title",
  "last-prompt",
  "queue-operation",
  "pr-link",
  "agent-name"
]);

const claudeUsagePolicy: UsageProjectionPolicy<ClaudeUsageState> = {
  createState: () => ({}),
  cloneState: () => ({}),
  resetSource: () => undefined,
  parseRecord: (_state, input) => parseClaudeUsageRecord(input)
};

export function createClaudeUsageSourceProjection(): AgentUsageSourceProjection {
  return createJsonlUsageSourceProjection("claude", claudeUsagePolicy);
}

function parseClaudeUsageRecord(
  input: UsageProjectionRecordInput
): readonly CoreUsageEventSample[] {
  const message = isRecord(input.record.message) ? input.record.message : null;
  const usage = message && isRecord(message.usage) ? message.usage : null;
  const recordType =
    typeof input.record.type === "string" ? input.record.type : undefined;
  const hasClaudeCodeMarker =
    "uuid" in input.record ||
    "parentUuid" in input.record ||
    "userType" in input.record ||
    "isSidechain" in input.record ||
    "agentId" in input.record;

  if (message && recordType === "assistant" && !usage) return [];
  if (
    hasClaudeCodeMarker &&
    recordType &&
    CLAUDE_NON_USAGE_RECORD_TYPES.has(recordType)
  ) {
    return [];
  }

  const sample = extractGenericUsageSample({
    agentId: "claude",
    pricingVendorId: "claude",
    record: input.record,
    ...(usage ? { metricsRoot: usage } : {}),
    sourcePath: input.sourcePath,
    treatsInputTokensAsUncached: true
  });
  if (!sample || !isUsageTimestampInRange(sample.timestampMs, input.range)) {
    return [];
  }

  const dedupeKey =
    sample.threadId && sample.requestId
      ? [sample.threadId, sample.requestId].join("\t")
      : undefined;
  return [
    {
      ...sample,
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(dedupeKey
        ? {
            dedupeRank: input.sourcePath
              .replace(/\\/gu, "/")
              .includes("/subagents/")
              ? 0
              : 1
          }
        : {})
    }
  ];
}
