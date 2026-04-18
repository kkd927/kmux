import { describe, expect, it } from "vitest";

import { estimateUsageComponentCosts } from "./modelPricing";

describe("model pricing", () => {
  it("uses exact pricing for the latest published Codex model entries", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5-codex",
      inputTokens: 2_000,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-5-codex",
        inputCostUsd: expect.closeTo(0.0025, 8),
        outputCostUsd: expect.closeTo(0.004, 8),
        thinkingCostUsd: expect.closeTo(0.001, 8),
        cacheReadCostUsd: expect.closeTo(0.0001, 8)
      })
    );
  });

  it("falls back to the nearest lower Codex main-tier pricing for newer same-major models", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.5",
      inputTokens: 2_000,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.4",
        inputCostUsd: expect.closeTo(0.005, 8),
        outputCostUsd: expect.closeTo(0.006, 8),
        thinkingCostUsd: expect.closeTo(0.0015, 8),
        cacheReadCostUsd: expect.closeTo(0.0002, 8)
      })
    );
  });

  it("falls back to the nearest lower Claude family pricing within the same line", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "claude",
      model: "claude-sonnet-4-7",
      inputTokens: 1_000,
      outputTokens: 200,
      thinkingTokens: 50,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "claude-sonnet-4-6",
        inputCostUsd: expect.closeTo(0.003, 8),
        outputCostUsd: expect.closeTo(0.003, 8),
        thinkingCostUsd: expect.closeTo(0.00075, 8),
        cacheReadCostUsd: expect.closeTo(0.00015, 8),
        cacheWriteCostUsd: expect.closeTo(0.000375, 8)
      })
    );
  });

  it("does not cross Codex major versions when no same-major fallback exists", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-6.0",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toBeNull();
  });

  it("falls back to the nearest lower Gemini tier pricing for newer preview variants", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3.2-pro-preview-06-15",
      inputTokens: 1_500,
      outputTokens: 250,
      thinkingTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gemini-3.1-pro-preview",
        inputCostUsd: expect.closeTo(0.003, 8),
        outputCostUsd: expect.closeTo(0.003, 8),
        thinkingCostUsd: expect.closeTo(0.0006, 8),
        cacheReadCostUsd: expect.closeTo(0.00008, 8)
      })
    );
  });

  it("uses exact pricing for Gemini preview entries that now exist in the table", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3.1-flash-lite-preview",
      inputTokens: 2_000,
      outputTokens: 300,
      thinkingTokens: 100,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gemini-3.1-flash-lite-preview",
        inputCostUsd: expect.closeTo(0.0005, 8),
        outputCostUsd: expect.closeTo(0.00045, 8),
        thinkingCostUsd: expect.closeTo(0.00015, 8),
        cacheReadCostUsd: expect.closeTo(0.000025, 8)
      })
    );
  });

  it("applies tiered pricing when prompt context exceeds the published threshold", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.4",
      inputTokens: 300_000,
      outputTokens: 1_000,
      thinkingTokens: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        inputCostUsd: expect.closeTo(1.5, 8),
        outputCostUsd: expect.closeTo(0.0225, 8),
        thinkingCostUsd: expect.closeTo(0.01125, 8),
        cacheReadCostUsd: expect.closeTo(0.01, 8),
        cacheWriteCostUsd: 0,
        cacheWriteCostKnown: true
      })
    );
  });

  it("marks cache create cost unknown when the source cannot surface cache creation tokens", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        cacheWriteCostUsd: 0,
        cacheWriteCostKnown: false
      })
    );
  });
});
