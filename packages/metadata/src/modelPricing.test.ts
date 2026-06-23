import { describe, expect, it } from "vitest";

import {
  estimateUsageComponentCosts,
  resolveCanonicalModelId
} from "./modelPricing";

describe("model pricing", () => {
  it.each([
    ["Gemini 3.5 Flash (Medium)", "gemini-3.5-flash"],
    ["Gemini 3.5 Flash (High)", "gemini-3.5-flash"],
    ["gemini-3.5-flash-medium", "gemini-3.5-flash"],
    ["gemini-3.1-pro-preview-customtools", "gemini-3.1-pro-preview"]
  ])("canonicalizes confirmed Gemini model aliases: %s", (model, modelId) => {
    expect(resolveCanonicalModelId({ vendor: "gemini", model })).toBe(modelId);
  });

  it("canonicalizes confirmed Claude dotted aliases", () => {
    expect(
      resolveCanonicalModelId({
        vendor: "claude",
        model: "claude-opus-4.8"
      })
    ).toBe("claude-opus-4-8");
  });

  it.each([
    ["gemini", "Gemini 4.0"],
    ["claude", "claude-tapdancer-6"],
    ["codex", "gpt-hyper-6"],
    ["codex", "gpt-5.6"],
    ["claude", "claude-sonnet-4-7"],
    ["gemini", "gemini-3.2-pro-preview-06-15"],
    ["codex", "gpt-5.5-2026-01-01"],
    ["gemini", "gemini-2.5-pro-20250605"],
    ["gemini", "models/gemini-2.5-pro"],
    ["codex", "openai.gpt-5.5"]
  ] as const)(
    "does not canonicalize unknown or fallback-only model IDs: %s %s",
    (vendor, model) => {
      expect(resolveCanonicalModelId({ vendor, model })).toBeNull();
    }
  );

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

  it("uses exact pricing for the latest OpenAI text-token Codex model entries", () => {
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
        modelId: "gpt-5.5",
        inputCostUsd: expect.closeTo(0.01, 8),
        outputCostUsd: expect.closeTo(0.012, 8),
        thinkingCostUsd: expect.closeTo(0.003, 8),
        cacheReadCostUsd: expect.closeTo(0.0004, 8)
      })
    );
  });

  it("applies GPT-5.5 long-context pricing above the published threshold", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.5",
      inputTokens: 300_000,
      outputTokens: 1_000,
      thinkingTokens: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.5",
        inputCostUsd: expect.closeTo(3, 8),
        outputCostUsd: expect.closeTo(0.045, 8),
        thinkingCostUsd: expect.closeTo(0.0225, 8),
        cacheReadCostUsd: expect.closeTo(0.02, 8)
      })
    );
  });

  it.each(["gpt-5.5-pro", "gpt-5.4-pro"])(
    "applies OpenAI pro long-context pricing above the published threshold for %s",
    (model) => {
      const estimate = estimateUsageComponentCosts({
        vendor: "codex",
        model,
        inputTokens: 300_000,
        outputTokens: 1_000,
        thinkingTokens: 500,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      });

      expect(estimate).toEqual(
        expect.objectContaining({
          modelId: model,
          inputCostUsd: expect.closeTo(18, 8),
          outputCostUsd: expect.closeTo(0.27, 8),
          thinkingCostUsd: expect.closeTo(0.135, 8),
          cacheReadCostUsd: 0
        })
      );
    }
  );

  it("uses exact pricing for current non-GPT Codex table entries", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "codex-mini-latest",
      inputTokens: 2_000,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "codex-mini-latest",
        inputCostUsd: expect.closeTo(0.003, 8),
        outputCostUsd: expect.closeTo(0.0024, 8),
        thinkingCostUsd: expect.closeTo(0.0006, 8),
        cacheReadCostUsd: expect.closeTo(0.0003, 8)
      })
    );
  });

  it("does not preserve manual Codex entries that are absent from current pricing tables", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.3-codex-spark",
      inputTokens: 2_000,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toBeNull();
  });

  it("falls back to the nearest lower Codex main-tier pricing for newer same-major models", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.6",
      inputTokens: 2_000,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.5",
        inputCostUsd: expect.closeTo(0.01, 8),
        outputCostUsd: expect.closeTo(0.012, 8),
        thinkingCostUsd: expect.closeTo(0.003, 8),
        cacheReadCostUsd: expect.closeTo(0.0004, 8)
      })
    );
  });

  it("does not apply Codex-specific pricing to a bare GPT model without explicit pricing", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toBeNull();
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

  it.each([
    ["claude-fable-5", "claude-fable-5"],
    ["claude-mythos-5", "claude-mythos-5"]
  ])(
    "uses exact pricing for current Claude 5 model entries: %s",
    (model, modelId) => {
      const estimate = estimateUsageComponentCosts({
        vendor: "claude",
        model,
        inputTokens: 1_000,
        outputTokens: 200,
        thinkingTokens: 50,
        cacheReadTokens: 500,
        cacheWriteTokens: 100,
        cacheWriteTokensKnown: true
      });

      expect(estimate).toEqual(
        expect.objectContaining({
          modelId,
          inputCostUsd: expect.closeTo(0.01, 8),
          outputCostUsd: expect.closeTo(0.01, 8),
          thinkingCostUsd: expect.closeTo(0.0025, 8),
          cacheReadCostUsd: expect.closeTo(0.0005, 8),
          cacheWriteCostUsd: expect.closeTo(0.00125, 8)
        })
      );
    }
  );

  it.each(["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"])(
    "uses current Claude table pricing above 200K context for %s",
    (model) => {
      const estimate = estimateUsageComponentCosts({
        vendor: "claude",
        model,
        inputTokens: 210_000,
        outputTokens: 1_000,
        thinkingTokens: 500,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 100,
        cacheWriteTokensKnown: true
      });

      expect(estimate).toEqual(
        expect.objectContaining({
          modelId: model,
          inputCostUsd: expect.closeTo(0.63, 8),
          outputCostUsd: expect.closeTo(0.015, 8),
          thinkingCostUsd: expect.closeTo(0.0075, 8),
          cacheReadCostUsd: expect.closeTo(0.0003, 8),
          cacheWriteCostUsd: expect.closeTo(0.000375, 8)
        })
      );
    }
  );

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

  it("does not preserve legacy Gemini model labels that are absent from current pricing tables", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3-pro-preview",
      inputTokens: 1_000,
      outputTokens: 100,
      thinkingTokens: 50,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toBeNull();
  });

  it("does not apply Gemini preview pricing to a stable model without explicit pricing", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3-flash",
      inputTokens: 1_000,
      outputTokens: 100,
      thinkingTokens: 50,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toBeNull();
  });

  it("uses exact pricing for current Gemini 3.1 Flash-Lite table entries", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3.1-flash-lite",
      inputTokens: 2_000,
      outputTokens: 300,
      thinkingTokens: 100,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gemini-3.1-flash-lite",
        inputCostUsd: expect.closeTo(0.0005, 8),
        outputCostUsd: expect.closeTo(0.00045, 8),
        thinkingCostUsd: expect.closeTo(0.00015, 8),
        cacheReadCostUsd: expect.closeTo(0.000025, 8)
      })
    );
  });

  it("uses official Gemini aliases when a pricing section lists multiple model IDs", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "gemini-3.1-pro-preview-customtools",
      inputTokens: 1_000,
      outputTokens: 100,
      thinkingTokens: 50,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gemini-3.1-pro-preview",
        inputCostUsd: expect.closeTo(0.002, 8),
        outputCostUsd: expect.closeTo(0.0012, 8),
        thinkingCostUsd: expect.closeTo(0.0006, 8),
        cacheReadCostUsd: expect.closeTo(0.00002, 8)
      })
    );
  });

  it("uses Gemini 3.5 Flash pricing for Antigravity model labels", () => {
    const estimate = estimateUsageComponentCosts({
      vendor: "gemini",
      model: "Gemini 3.5 Flash (Medium)",
      inputTokens: 2_000,
      outputTokens: 300,
      thinkingTokens: 100,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: true
    });

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gemini-3.5-flash",
        inputCostUsd: expect.closeTo(0.003, 8),
        outputCostUsd: expect.closeTo(0.0027, 8),
        thinkingCostUsd: expect.closeTo(0.0009, 8),
        cacheReadCostUsd: expect.closeTo(0.00015, 8)
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
