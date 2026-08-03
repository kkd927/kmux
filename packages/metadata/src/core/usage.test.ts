import { describe, expect, it } from "vitest";

import {
  aggregateCoreUsageSamples,
  type CoreUsageEventSample
} from "./usage";

describe("metadata usage core", () => {
  it("aggregates deduplicated usage by owned session before applying result limits", () => {
    const records = aggregateCoreUsageSamples([
      sample({ timestampMs: 10, inputTokens: 5, outputTokens: 2 }),
      sample({
        timestampMs: 20,
        inputTokens: 7,
        outputTokens: 3,
        model: "claude-sonnet-4-6"
      })
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        aggregateId: "claude:session-1",
        timestampMs: 20,
        model: "claude-sonnet-4-6",
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17
      })
    ]);
  });
});

function sample(
  overrides: Partial<CoreUsageEventSample>
): CoreUsageEventSample {
  const inputTokens = overrides.inputTokens ?? 0;
  const outputTokens = overrides.outputTokens ?? 0;
  return {
    vendor: "claude",
    timestampMs: 0,
    sourcePath: "/sessions/session-1.jsonl",
    sourceType: "jsonl",
    sessionId: "session-1",
    inputTokens,
    outputTokens,
    cacheTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: 0,
    ...overrides
  };
}
