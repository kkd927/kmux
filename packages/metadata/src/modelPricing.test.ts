import { describe, expect, it } from "vitest";

import {
  BUNDLED_MODEL_PRICING_CATALOG,
  calculateModelPricingRevision,
  createModelPricingResolver,
  estimateUsageComponentCosts,
  estimateUsageComponentCostsForCatalog,
  resolveCanonicalModelId,
  validateModelPricingCatalog,
  type ModelPricingCatalogDocument,
  type PricingCatalog,
  type PricingEntry
} from "./modelPricing";

const SYNTHETIC_CODEX_PRICING = {
  standard: [
    pricingEntry("gpt-7.1-codex", 1, 5, 0.1),
    pricingEntry("gpt-7.1", 2, 10, 0.2, {
      cacheCreateCostPerMillionTokens: 2.5,
      inputCostPerMillionTokensAboveThreshold: 4,
      outputCostPerMillionTokensAboveThreshold: 15,
      cacheReadCostPerMillionTokensAboveThreshold: 0.4,
      cacheCreateCostPerMillionTokensAboveThreshold: 5,
      tieredPricingThresholdTokens: 200_000
    }),
    pricingEntry("gpt-7.1-pro", 30, 180, 0, {
      inputCostPerMillionTokensAboveThreshold: 60,
      outputCostPerMillionTokensAboveThreshold: 270,
      cacheReadCostPerMillionTokensAboveThreshold: 0,
      tieredPricingThresholdTokens: 200_000
    }),
    pricingEntry("gpt-7.1-nano", 0.5, 1, 0.05),
    pricingEntry("gpt-7.1-sol", 3, 15, 0.3),
    pricingEntry("gpt-7.1-terra", 2, 10, 0.2)
  ],
  fast: [
    pricingEntry("gpt-7.1-codex", 2, 10, 0.2),
    pricingEntry("gpt-7.0-sol", 4, 20, 0.4)
  ]
} satisfies PricingCatalog;

function pricingEntry(
  modelId: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cachedInputPerMillion: number,
  overrides: Partial<PricingEntry> = {}
): PricingCatalog["standard"][number] {
  return {
    modelId,
    inputCostPerMillionTokens: inputPerMillion,
    outputCostPerMillionTokens: outputPerMillion,
    cacheReadCostPerMillionTokens: cachedInputPerMillion,
    ...overrides
  };
}

describe("model pricing", () => {
  it("loads a canonical bundled catalog with a verified models revision", () => {
    expect(BUNDLED_MODEL_PRICING_CATALOG).toMatchObject({
      schemaVersion: 1,
      catalogVersion: expect.any(Number),
      publishedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
      )
    });
    expect(BUNDLED_MODEL_PRICING_CATALOG.catalogVersion).toBeGreaterThanOrEqual(
      1
    );
    expect(BUNDLED_MODEL_PRICING_CATALOG.revision).toBe(
      calculateModelPricingRevision(BUNDLED_MODEL_PRICING_CATALOG.models)
    );
  });

  it("creates isolated resolvers from validated catalog documents", () => {
    const catalog = structuredClone(BUNDLED_MODEL_PRICING_CATALOG);
    const sonnet = catalog.models.claude.standard.find(
      (entry) => entry.modelId === "claude-sonnet-5"
    )!;
    sonnet.inputCostPerMillionTokens = 250_000;
    catalog.catalogVersion += 1;
    catalog.revision = calculateModelPricingRevision(catalog.models);

    const resolver = createModelPricingResolver(catalog);

    expect(
      resolver.estimateUsageComponentCosts({
        vendor: "claude",
        model: "claude-sonnet-5",
        inputTokens: 2,
        outputTokens: 0
      })?.inputCostUsd
    ).toBe(0.5);
    expect(
      estimateUsageComponentCosts({
        vendor: "claude",
        model: "claude-sonnet-5",
        inputTokens: 2,
        outputTokens: 0
      })?.inputCostUsd
    ).not.toBe(0.5);
  });

  it("rejects unsupported keys and invalid prices", () => {
    const withUnsupportedKey = {
      ...structuredClone(BUNDLED_MODEL_PRICING_CATALOG),
      unexpected: true
    };
    expect(() => validateModelPricingCatalog(withUnsupportedKey)).toThrow(
      /catalog keys are invalid/u
    );

    const withLegacyPrice = structuredClone(BUNDLED_MODEL_PRICING_CATALOG);
    const legacyEntry = withLegacyPrice.models.claude
      .standard[0] as unknown as Record<string, unknown>;
    legacyEntry.inputCostPerToken =
      Number(legacyEntry.inputCostPerMillionTokens) / 1_000_000;
    delete legacyEntry.inputCostPerMillionTokens;
    expect(() => validateModelPricingCatalog(withLegacyPrice)).toThrow(
      /inputCostPerToken is not supported/u
    );

    const withNegativePrice = structuredClone(
      BUNDLED_MODEL_PRICING_CATALOG
    ) as ModelPricingCatalogDocument;
    withNegativePrice.models.claude.standard[0].inputCostPerMillionTokens = -1;
    withNegativePrice.revision = calculateModelPricingRevision(
      withNegativePrice.models
    );
    expect(() => validateModelPricingCatalog(withNegativePrice)).toThrow(
      /finite non-negative/u
    );
  });

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

  it("canonicalizes the official GPT-5.6 alias to GPT-5.6 Sol", () => {
    expect(resolveCanonicalModelId({ vendor: "codex", model: "gpt-5.6" })).toBe(
      "gpt-5.6-sol"
    );
  });

  it("uses GPT-5.6 Sol pricing for the GPT-5.6 alias in Fast mode", () => {
    const aliasEstimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.6",
      pricingMode: "fast",
      inputTokens: 1_000,
      outputTokens: 100
    });
    const canonicalEstimate = estimateUsageComponentCosts({
      vendor: "codex",
      model: "gpt-5.6-sol",
      pricingMode: "fast",
      inputTokens: 1_000,
      outputTokens: 100
    });

    expect(aliasEstimate).toEqual(canonicalEstimate);
    expect(aliasEstimate.modelId).toBe("gpt-5.6-sol");
    expect(aliasEstimate.inputCostUsd).toBeGreaterThan(0);
    expect(aliasEstimate.outputCostUsd).toBeGreaterThan(0);
  });

  it.each([
    ["gemini", "Gemini 4.0"],
    ["claude", "claude-tapdancer-6"],
    ["codex", "gpt-hyper-6"],
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

  it("uses Standard pricing by default with a synthetic catalog", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1-codex",
        inputTokens: 2_000,
        outputTokens: 400,
        thinkingTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1-codex",
        inputCostUsd: expect.closeTo(0.002, 8),
        outputCostUsd: expect.closeTo(0.002, 8),
        thinkingCostUsd: expect.closeTo(0.0005, 8),
        cacheReadCostUsd: expect.closeTo(0.00008, 8)
      })
    );
  });

  it("uses distinct Fast prices for the same synthetic model", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1-codex",
        pricingMode: "fast",
        inputTokens: 2_000,
        outputTokens: 400,
        thinkingTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1-codex",
        inputCostUsd: expect.closeTo(0.004, 8),
        outputCostUsd: expect.closeTo(0.004, 8),
        thinkingCostUsd: expect.closeTo(0.001, 8),
        cacheReadCostUsd: expect.closeTo(0.00016, 8)
      })
    );
  });

  it("applies synthetic long-context and cache-write pricing above its threshold", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1",
        inputTokens: 300_000,
        outputTokens: 1_000,
        thinkingTokens: 500,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 10_000,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1",
        inputCostUsd: expect.closeTo(1.2, 8),
        outputCostUsd: expect.closeTo(0.015, 8),
        thinkingCostUsd: expect.closeTo(0.0075, 8),
        cacheReadCostUsd: expect.closeTo(0.008, 8),
        cacheWriteCostUsd: expect.closeTo(0.05, 8)
      })
    );
  });

  it("applies synthetic pro long-context pricing above its threshold", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1-pro",
        inputTokens: 300_000,
        outputTokens: 1_000,
        thinkingTokens: 500,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1-pro",
        inputCostUsd: expect.closeTo(18, 8),
        outputCostUsd: expect.closeTo(0.27, 8),
        thinkingCostUsd: expect.closeTo(0.135, 8),
        cacheReadCostUsd: 0
      })
    );
  });

  it("falls back to the nearest lower Codex main-tier pricing for newer same-major models", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.2",
        inputTokens: 2_000,
        outputTokens: 400,
        thinkingTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1",
        inputCostUsd: expect.closeTo(0.004, 8),
        outputCostUsd: expect.closeTo(0.004, 8),
        thinkingCostUsd: expect.closeTo(0.001, 8),
        cacheReadCostUsd: expect.closeTo(0.00016, 8)
      })
    );
  });

  it("does not apply Codex-specific pricing to an unknown bare GPT model", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-8",
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toBeNull();
  });

  it("falls back to exact Standard pricing when Fast does not list the model", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1-nano",
        pricingMode: "fast",
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1-nano",
        inputCostUsd: expect.closeTo(0.0005, 8),
        outputCostUsd: expect.closeTo(0.0001, 8)
      })
    );
  });

  it("uses Fast forward-compatible pricing before Standard fallback pricing", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.2-sol",
        pricingMode: "fast",
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.0-sol",
        inputCostUsd: expect.closeTo(0.004, 8),
        outputCostUsd: expect.closeTo(0.002, 8)
      })
    );
  });

  it("uses Standard forward-compatible pricing when Fast has no matching family", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.2-terra",
        pricingMode: "fast",
        inputTokens: 1_000,
        outputTokens: 100
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        modelId: "gpt-7.1-terra",
        inputCostUsd: expect.closeTo(0.002, 8),
        outputCostUsd: expect.closeTo(0.001, 8)
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

    expect(estimate).not.toBeNull();
    expect(estimate!.modelId).toBe("claude-sonnet-4-6");
    expect(estimate!.inputCostUsd).toBeGreaterThan(0);
    expect(estimate!.outputCostUsd).toBeGreaterThan(0);
    expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheWriteCostUsd).toBeGreaterThan(0);
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

      expect(estimate).not.toBeNull();
      expect(estimate!.modelId).toBe(modelId);
      expect(estimate!.inputCostUsd).toBeGreaterThan(0);
      expect(estimate!.outputCostUsd).toBeGreaterThan(0);
      expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
      expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
      expect(estimate!.cacheWriteCostUsd).toBeGreaterThan(0);
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

      expect(estimate).not.toBeNull();
      expect(estimate!.modelId).toBe(model);
      expect(estimate!.inputCostUsd).toBeGreaterThan(0);
      expect(estimate!.outputCostUsd).toBeGreaterThan(0);
      expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
      expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
      expect(estimate!.cacheWriteCostUsd).toBeGreaterThan(0);
    }
  );

  it("does not cross Codex major versions when no same-major fallback exists", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-8.0",
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: true
      }
    );

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

    expect(estimate).not.toBeNull();
    expect(estimate!.modelId).toBe("gemini-3.1-pro-preview");
    expect(estimate!.inputCostUsd).toBeGreaterThan(0);
    expect(estimate!.outputCostUsd).toBeGreaterThan(0);
    expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
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

    expect(estimate).not.toBeNull();
    expect(estimate!.modelId).toBe("gemini-3.1-flash-lite");
    expect(estimate!.inputCostUsd).toBeGreaterThan(0);
    expect(estimate!.outputCostUsd).toBeGreaterThan(0);
    expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
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

    expect(estimate).not.toBeNull();
    expect(estimate!.modelId).toBe("gemini-3.1-pro-preview");
    expect(estimate!.inputCostUsd).toBeGreaterThan(0);
    expect(estimate!.outputCostUsd).toBeGreaterThan(0);
    expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
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

    expect(estimate).not.toBeNull();
    expect(estimate!.modelId).toBe("gemini-3.5-flash");
    expect(estimate!.inputCostUsd).toBeGreaterThan(0);
    expect(estimate!.outputCostUsd).toBeGreaterThan(0);
    expect(estimate!.thinkingCostUsd).toBeGreaterThan(0);
    expect(estimate!.cacheReadCostUsd).toBeGreaterThan(0);
  });

  it("marks cache create cost unknown when the source cannot surface cache creation tokens", () => {
    const estimate = estimateUsageComponentCostsForCatalog(
      SYNTHETIC_CODEX_PRICING,
      {
        vendor: "codex",
        model: "gpt-7.1",
        inputTokens: 100,
        outputTokens: 20,
        thinkingTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        cacheWriteTokensKnown: false
      }
    );

    expect(estimate).toEqual(
      expect.objectContaining({
        cacheWriteCostUsd: 0,
        cacheWriteCostKnown: false
      })
    );
  });
});
