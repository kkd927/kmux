import { IncrementalSha256 } from "@kmux/proto";

type SupportedVendor = "claude" | "codex" | "gemini";
export type SupportedPricingVendor = SupportedVendor;
export type PricingMode = "standard" | "fast";

const DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS = 200_000;
const FORWARD_COMPAT_POLICY_REVISION = 1;

export type PricingEntry = {
  modelId: string;
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreateCostPerToken?: number;
  inputCostPerTokenAboveThreshold?: number;
  outputCostPerTokenAboveThreshold?: number;
  cacheReadCostPerTokenAboveThreshold?: number;
  cacheCreateCostPerTokenAboveThreshold?: number;
  tieredPricingThresholdTokens?: number;
  aliases?: string[];
};

export type PricingCatalog = {
  standard: PricingEntry[];
  fast?: PricingEntry[];
};

export type HistoricalPricingEntry = PricingEntry & {
  retiredAt: string;
};

export type HistoricalPricingCatalog = {
  standard: HistoricalPricingEntry[];
  fast?: HistoricalPricingEntry[];
};

export type UsageComponentCostEstimate = {
  modelId: string;
  inputCostUsd: number;
  outputCostUsd: number;
  thinkingCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalCostUsd: number;
  inputCostKnown: boolean;
  outputCostKnown: boolean;
  thinkingCostKnown: boolean;
  cacheReadCostKnown: boolean;
  cacheWriteCostKnown: boolean;
};

const MODEL_PRICING: Record<SupportedVendor, PricingCatalog> = {
  claude: {
    standard: [
      {
        modelId: "claude-sonnet-5",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.0000002,
        cacheCreateCostPerToken: 0.0000025,
        aliases: ["claude-sonnet-5"]
      },
      {
        modelId: "claude-opus-5",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000025,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        aliases: ["claude-opus-5"]
      },
      {
        modelId: "claude-mythos-5",
        inputCostPerToken: 0.00001,
        outputCostPerToken: 0.00005,
        cacheReadCostPerToken: 0.000001,
        cacheCreateCostPerToken: 0.0000125,
        aliases: ["claude-mythos-5"]
      },
      {
        modelId: "claude-fable-5",
        inputCostPerToken: 0.00001,
        outputCostPerToken: 0.00005,
        cacheReadCostPerToken: 0.000001,
        cacheCreateCostPerToken: 0.0000125,
        aliases: ["claude-fable-5"]
      },
      {
        modelId: "claude-opus-4-8",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000025,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        aliases: ["claude-opus-4.8"]
      },
      {
        modelId: "claude-opus-4-7",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000025,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        aliases: ["claude-opus-4.7"]
      },
      {
        modelId: "claude-sonnet-4-6",
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0.0000003,
        cacheCreateCostPerToken: 0.00000375,
        aliases: ["claude-sonnet-4.6"]
      },
      {
        modelId: "claude-opus-4-6",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000025,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        aliases: ["claude-opus-4.6"]
      },
      {
        modelId: "claude-sonnet-4-5",
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0.0000003,
        cacheCreateCostPerToken: 0.00000375,
        aliases: ["claude-sonnet-4.5"]
      },
      {
        modelId: "claude-opus-4-5",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000025,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        aliases: ["claude-opus-4.5"]
      },
      {
        modelId: "claude-haiku-4-5",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000005,
        cacheReadCostPerToken: 0.0000001,
        cacheCreateCostPerToken: 0.00000125,
        aliases: ["claude-haiku-4.5"]
      },
      {
        modelId: "claude-opus-4-1",
        inputCostPerToken: 0.000015,
        outputCostPerToken: 0.000075,
        cacheReadCostPerToken: 0.0000015,
        cacheCreateCostPerToken: 0.00001875,
        aliases: ["claude-opus-4.1"]
      },
      {
        modelId: "claude-sonnet-4",
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0.0000003,
        cacheCreateCostPerToken: 0.00000375,
        aliases: ["claude-sonnet-4"]
      },
      {
        modelId: "claude-opus-4",
        inputCostPerToken: 0.000015,
        outputCostPerToken: 0.000075,
        cacheReadCostPerToken: 0.0000015,
        cacheCreateCostPerToken: 0.00001875,
        aliases: ["claude-opus-4"]
      },
      {
        modelId: "claude-haiku-3-5",
        inputCostPerToken: 0.0000008,
        outputCostPerToken: 0.000004,
        cacheReadCostPerToken: 0.00000008,
        cacheCreateCostPerToken: 0.000001,
        aliases: ["claude-haiku-3.5"]
      }
    ]
  },
  codex: {
    standard: [
      {
        modelId: "gpt-5.6-sol",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625,
        inputCostPerTokenAboveThreshold: 0.00001,
        outputCostPerTokenAboveThreshold: 0.000045,
        cacheReadCostPerTokenAboveThreshold: 0.000001,
        cacheCreateCostPerTokenAboveThreshold: 0.0000125,
        tieredPricingThresholdTokens: 272_000,
        aliases: ["gpt-5.6"]
      },
      {
        modelId: "gpt-5.6-terra",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000012,
        cacheReadCostPerToken: 0.0000002,
        cacheCreateCostPerToken: 0.0000025,
        inputCostPerTokenAboveThreshold: 0.000004,
        outputCostPerTokenAboveThreshold: 0.000018,
        cacheReadCostPerTokenAboveThreshold: 0.0000004,
        cacheCreateCostPerTokenAboveThreshold: 0.000005,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.6-luna",
        inputCostPerToken: 0.0000002,
        outputCostPerToken: 0.0000012,
        cacheReadCostPerToken: 0.00000002,
        cacheCreateCostPerToken: 0.00000025,
        inputCostPerTokenAboveThreshold: 0.0000004,
        outputCostPerTokenAboveThreshold: 0.0000018,
        cacheReadCostPerTokenAboveThreshold: 0.00000004,
        cacheCreateCostPerTokenAboveThreshold: 0.0000005,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.5",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        cacheReadCostPerToken: 0.0000005,
        inputCostPerTokenAboveThreshold: 0.00001,
        outputCostPerTokenAboveThreshold: 0.000045,
        cacheReadCostPerTokenAboveThreshold: 0.000001,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.5-pro",
        inputCostPerToken: 0.00003,
        outputCostPerToken: 0.00018,
        cacheReadCostPerToken: 0,
        inputCostPerTokenAboveThreshold: 0.00006,
        outputCostPerTokenAboveThreshold: 0.00027,
        cacheReadCostPerTokenAboveThreshold: 0,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.4",
        inputCostPerToken: 0.0000025,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0.00000025,
        inputCostPerTokenAboveThreshold: 0.000005,
        outputCostPerTokenAboveThreshold: 0.0000225,
        cacheReadCostPerTokenAboveThreshold: 0.0000005,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.4-mini",
        inputCostPerToken: 0.00000075,
        outputCostPerToken: 0.0000045,
        cacheReadCostPerToken: 0.000000075
      },
      {
        modelId: "gpt-5.4-nano",
        inputCostPerToken: 0.0000002,
        outputCostPerToken: 0.00000125,
        cacheReadCostPerToken: 0.00000002
      },
      {
        modelId: "gpt-5.4-pro",
        inputCostPerToken: 0.00003,
        outputCostPerToken: 0.00018,
        cacheReadCostPerToken: 0,
        inputCostPerTokenAboveThreshold: 0.00006,
        outputCostPerTokenAboveThreshold: 0.00027,
        cacheReadCostPerTokenAboveThreshold: 0,
        tieredPricingThresholdTokens: 272_000
      },
      {
        modelId: "gpt-5.3-codex",
        inputCostPerToken: 0.00000175,
        outputCostPerToken: 0.000014,
        cacheReadCostPerToken: 0.000000175
      },
      {
        modelId: "gpt-5.2",
        inputCostPerToken: 0.00000175,
        outputCostPerToken: 0.000014,
        cacheReadCostPerToken: 0.000000175
      },
      {
        modelId: "gpt-5.2-pro",
        inputCostPerToken: 0.000021,
        outputCostPerToken: 0.000168,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-5.1",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "gpt-5",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "gpt-5-mini",
        inputCostPerToken: 0.00000025,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0.000000025
      },
      {
        modelId: "gpt-5-nano",
        inputCostPerToken: 0.00000005,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0.000000005
      },
      {
        modelId: "gpt-5-pro",
        inputCostPerToken: 0.000015,
        outputCostPerToken: 0.00012,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-4.1",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadCostPerToken: 0.0000005
      },
      {
        modelId: "gpt-4.1-mini",
        inputCostPerToken: 0.0000004,
        outputCostPerToken: 0.0000016,
        cacheReadCostPerToken: 0.0000001
      },
      {
        modelId: "gpt-4.1-nano",
        inputCostPerToken: 0.0000001,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0.000000025
      },
      {
        modelId: "gpt-4-turbo-2024-04-09",
        inputCostPerToken: 0.00001,
        outputCostPerToken: 0.00003,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-4-0613",
        inputCostPerToken: 0.00003,
        outputCostPerToken: 0.00006,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-3.5-turbo",
        inputCostPerToken: 0.0000005,
        outputCostPerToken: 0.0000015,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-3.5-turbo-0125",
        inputCostPerToken: 0.0000005,
        outputCostPerToken: 0.0000015,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-3.5-turbo-1106",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-3.5-turbo-instruct",
        inputCostPerToken: 0.0000015,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gpt-4o-2024-05-13",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "o4-mini",
        inputCostPerToken: 0.0000011,
        outputCostPerToken: 0.0000044,
        cacheReadCostPerToken: 0.000000275
      },
      {
        modelId: "gpt-4o-mini",
        inputCostPerToken: 0.00000015,
        outputCostPerToken: 0.0000006,
        cacheReadCostPerToken: 0.000000075
      },
      {
        modelId: "gpt-4o",
        inputCostPerToken: 0.0000025,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.00000125
      },
      {
        modelId: "o3-pro",
        inputCostPerToken: 0.00002,
        outputCostPerToken: 0.00008,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "o3-mini",
        inputCostPerToken: 0.0000011,
        outputCostPerToken: 0.0000044,
        cacheReadCostPerToken: 0.00000055
      },
      {
        modelId: "o3",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadCostPerToken: 0.0000005
      },
      {
        modelId: "davinci-002",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "babbage-002",
        inputCostPerToken: 0.0000004,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "o1-pro",
        inputCostPerToken: 0.00015,
        outputCostPerToken: 0.0006,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "o1",
        inputCostPerToken: 0.000015,
        outputCostPerToken: 0.00006,
        cacheReadCostPerToken: 0.0000075
      }
    ],
    fast: [
      {
        modelId: "gpt-5.6-sol",
        inputCostPerToken: 0.00001,
        outputCostPerToken: 0.00006,
        cacheReadCostPerToken: 0.000001,
        cacheCreateCostPerToken: 0.0000125,
        aliases: ["gpt-5.6"]
      },
      {
        modelId: "gpt-5.6-terra",
        inputCostPerToken: 0.000004,
        outputCostPerToken: 0.000024,
        cacheReadCostPerToken: 0.0000004,
        cacheCreateCostPerToken: 0.000005
      },
      {
        modelId: "gpt-5.6-luna",
        inputCostPerToken: 0.0000004,
        outputCostPerToken: 0.0000024,
        cacheReadCostPerToken: 0.00000004,
        cacheCreateCostPerToken: 0.0000005
      },
      {
        modelId: "gpt-5.5",
        inputCostPerToken: 0.0000125,
        outputCostPerToken: 0.000075,
        cacheReadCostPerToken: 0.00000125
      },
      {
        modelId: "gpt-5.4",
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        cacheReadCostPerToken: 0.0000005
      },
      {
        modelId: "gpt-5.4-mini",
        inputCostPerToken: 0.0000015,
        outputCostPerToken: 0.000009,
        cacheReadCostPerToken: 0.00000015
      },
      {
        modelId: "gpt-5.3-codex",
        inputCostPerToken: 0.0000035,
        outputCostPerToken: 0.000028,
        cacheReadCostPerToken: 0.00000035
      },
      {
        modelId: "gpt-5.2",
        inputCostPerToken: 0.0000035,
        outputCostPerToken: 0.000028,
        cacheReadCostPerToken: 0.00000035
      },
      {
        modelId: "gpt-5.1",
        inputCostPerToken: 0.0000025,
        outputCostPerToken: 0.00002,
        cacheReadCostPerToken: 0.00000025
      },
      {
        modelId: "gpt-5",
        inputCostPerToken: 0.0000025,
        outputCostPerToken: 0.00002,
        cacheReadCostPerToken: 0.00000025
      },
      {
        modelId: "gpt-5-mini",
        inputCostPerToken: 0.00000045,
        outputCostPerToken: 0.0000036,
        cacheReadCostPerToken: 0.000000045
      },
      {
        modelId: "gpt-4.1",
        inputCostPerToken: 0.0000035,
        outputCostPerToken: 0.000014,
        cacheReadCostPerToken: 0.000000875
      },
      {
        modelId: "gpt-4.1-mini",
        inputCostPerToken: 0.0000007,
        outputCostPerToken: 0.0000028,
        cacheReadCostPerToken: 0.000000175
      },
      {
        modelId: "gpt-4.1-nano",
        inputCostPerToken: 0.0000002,
        outputCostPerToken: 0.0000008,
        cacheReadCostPerToken: 0.00000005
      },
      {
        modelId: "gpt-4o-2024-05-13",
        inputCostPerToken: 0.00000875,
        outputCostPerToken: 0.00002625,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "o4-mini",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadCostPerToken: 0.0000005
      },
      {
        modelId: "gpt-4o-mini",
        inputCostPerToken: 0.00000025,
        outputCostPerToken: 0.000001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "gpt-4o",
        inputCostPerToken: 0.00000425,
        outputCostPerToken: 0.000017,
        cacheReadCostPerToken: 0.000002125
      },
      {
        modelId: "o3",
        inputCostPerToken: 0.0000035,
        outputCostPerToken: 0.000014,
        cacheReadCostPerToken: 0.000000875
      }
    ]
  },
  gemini: {
    standard: [
      {
        modelId: "gemini-3.6-flash",
        inputCostPerToken: 0.0000015,
        outputCostPerToken: 0.0000075,
        cacheReadCostPerToken: 0.00000015
      },
      {
        modelId: "gemini-3.5-flash-lite",
        inputCostPerToken: 0.0000003,
        outputCostPerToken: 0.0000025,
        cacheReadCostPerToken: 0.00000003
      },
      {
        modelId: "gemini-3.5-flash",
        inputCostPerToken: 0.0000015,
        outputCostPerToken: 0.000009,
        cacheReadCostPerToken: 0.00000015,
        aliases: [
          "Gemini 3.5 Flash (Low)",
          "Gemini 3.5 Flash (Medium)",
          "Gemini 3.5 Flash (High)",
          "gemini-3.5-flash-low",
          "gemini-3.5-flash-medium",
          "gemini-3.5-flash-high"
        ]
      },
      {
        modelId: "gemini-3.1-pro-preview",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000012,
        cacheReadCostPerToken: 0.0000002,
        inputCostPerTokenAboveThreshold: 0.000004,
        outputCostPerTokenAboveThreshold: 0.000018,
        cacheReadCostPerTokenAboveThreshold: 0.0000004,
        cacheCreateCostPerTokenAboveThreshold: 0.0000004,
        aliases: ["gemini-3.1-pro-preview-customtools"]
      },
      {
        modelId: "gemini-3.1-flash-lite",
        inputCostPerToken: 0.00000025,
        outputCostPerToken: 0.0000015,
        cacheReadCostPerToken: 0.000000025
      },
      {
        modelId: "gemini-3-flash-preview",
        inputCostPerToken: 0.0000005,
        outputCostPerToken: 0.000003,
        cacheReadCostPerToken: 0.00000005
      },
      {
        modelId: "gemini-2.5-pro",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125,
        inputCostPerTokenAboveThreshold: 0.0000025,
        outputCostPerTokenAboveThreshold: 0.000015,
        cacheReadCostPerTokenAboveThreshold: 0.00000025,
        cacheCreateCostPerTokenAboveThreshold: 0.00000025
      },
      {
        modelId: "gemini-2.5-flash-lite-preview",
        inputCostPerToken: 0.0000001,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0.00000001
      },
      {
        modelId: "gemini-2.5-flash-lite",
        inputCostPerToken: 0.0000001,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0.00000001
      },
      {
        modelId: "gemini-2.5-flash",
        inputCostPerToken: 0.0000003,
        outputCostPerToken: 0.0000025,
        cacheReadCostPerToken: 0.00000003
      },
      {
        modelId: "gemini-2.0-flash-lite",
        inputCostPerToken: 0.000000075,
        outputCostPerToken: 0.0000003,
        cacheReadCostPerToken: 0
      },
      {
        modelId: "gemini-2.0-flash",
        inputCostPerToken: 0.0000001,
        outputCostPerToken: 0.0000004,
        cacheReadCostPerToken: 0.000000025
      }
    ]
  }
};

// Generated from the last published prices of entries removed from a source table.
// Resolution uses this catalog for direct matches only, never for newer models.
const HISTORICAL_MODEL_PRICING: Record<
  SupportedVendor,
  HistoricalPricingCatalog
> = {
  claude: {
    standard: []
  },
  codex: {
    standard: [
      {
        modelId: "gpt-5.2-codex",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.00000175,
        outputCostPerToken: 0.000014,
        cacheReadCostPerToken: 0.000000175
      },
      {
        modelId: "gpt-5.1-codex-max",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "gpt-5.1-codex",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "gpt-5.1-codex-mini",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.00000025,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0.000000025
      },
      {
        modelId: "gpt-5-codex",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125
      },
      {
        modelId: "codex-mini-latest",
        retiredAt: "2026-08-04",
        inputCostPerToken: 0.0000015,
        outputCostPerToken: 0.000006,
        cacheReadCostPerToken: 0.000000375
      }
    ]
  },
  gemini: {
    standard: []
  }
};

export const USAGE_PRICING_REVISION = stableRevision(
  JSON.stringify({
    forwardCompatPolicyRevision: FORWARD_COMPAT_POLICY_REVISION,
    modelPricing: MODEL_PRICING,
    historicalModelPricing: HISTORICAL_MODEL_PRICING
  })
);

function stableRevision(value: string): string {
  return new IncrementalSha256()
    .update(new TextEncoder().encode(value))
    .digestHex()
    .slice(0, 16);
}

const CANONICAL_MODEL_LOOKUP = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([vendor, catalog]) => {
    const lookup = new Map<string, PricingEntry>();
    for (const candidateCatalog of [
      catalog,
      HISTORICAL_MODEL_PRICING[vendor as SupportedVendor]
    ]) {
      for (const mode of ["standard", "fast"] as PricingMode[]) {
        for (const entry of candidateCatalog[mode] ?? []) {
          const modelKey = normalizeCanonicalModelLookupKey(entry.modelId);
          if (!lookup.has(modelKey)) {
            lookup.set(modelKey, entry);
          }
          for (const alias of entry.aliases ?? []) {
            const aliasKey = normalizeCanonicalModelLookupKey(alias);
            if (!lookup.has(aliasKey)) {
              lookup.set(aliasKey, entry);
            }
          }
        }
      }
    }
    return [vendor, lookup];
  })
) as Record<SupportedVendor, Map<string, PricingEntry>>;

export function resolveCanonicalModelId(params: {
  vendor: SupportedPricingVendor;
  model?: string;
}): string | null {
  if (!params.model?.trim()) {
    return null;
  }

  const entry = CANONICAL_MODEL_LOOKUP[params.vendor].get(
    normalizeCanonicalModelLookupKey(params.model)
  );
  return entry?.modelId ?? null;
}

type CodexForwardCompatSpec = {
  kind: "codex";
  major: number;
  minor: number;
  tier: string;
};

type ClaudeForwardCompatSpec = {
  kind: "claude";
  line: "fable" | "mythos" | "sonnet" | "opus" | "haiku";
  major: number;
  minor: number;
};

type GeminiForwardCompatSpec = {
  kind: "gemini";
  major: number;
  minor: number;
  tier: "pro" | "flash" | "flash-lite";
  preview: boolean;
};

type ForwardCompatSpec =
  | CodexForwardCompatSpec
  | ClaudeForwardCompatSpec
  | GeminiForwardCompatSpec;

type PricingCatalogIndex = {
  lookup: Record<PricingMode, Map<string, PricingEntry>>;
  forwardCompatEntries: Record<
    PricingMode,
    Array<{ entry: PricingEntry; spec: ForwardCompatSpec }>
  >;
};

const PRICING_CATALOG_INDEX_CACHE: Record<
  SupportedVendor,
  WeakMap<PricingCatalog, PricingCatalogIndex>
> = {
  claude: new WeakMap(),
  codex: new WeakMap(),
  gemini: new WeakMap()
};

export function estimateUsageComponentCosts(params: {
  vendor: SupportedVendor;
  model?: string;
  pricingMode?: PricingMode;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
}): UsageComponentCostEstimate | null {
  return estimateUsageComponentCostsForCatalog(
    MODEL_PRICING[params.vendor],
    params,
    HISTORICAL_MODEL_PRICING[params.vendor]
  );
}

/** @internal Exposed so pricing resolution contracts can use synthetic catalogs. */
export function estimateUsageComponentCostsForCatalog(
  catalog: PricingCatalog,
  params: {
    vendor: SupportedVendor;
    model?: string;
    pricingMode?: PricingMode;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWriteTokensKnown?: boolean;
  },
  historicalCatalog?: HistoricalPricingCatalog
): UsageComponentCostEstimate | null {
  if (!params.model?.trim()) {
    return null;
  }

  const entry = resolvePricingEntry(
    catalog,
    params.vendor,
    params.model,
    params.pricingMode ?? "standard",
    historicalCatalog
  );
  if (!entry) {
    return null;
  }

  const thinkingTokens = params.thinkingTokens ?? 0;
  const cacheReadTokens = params.cacheReadTokens ?? 0;
  const cacheWriteTokens = params.cacheWriteTokens ?? 0;
  const cacheWriteTokensKnown = params.cacheWriteTokensKnown !== false;
  const promptContextTokens =
    params.inputTokens + cacheReadTokens + cacheWriteTokens;
  const useHighTier = shouldUseTieredPricing(entry, promptContextTokens);

  const inputRate = pickRate(
    entry.inputCostPerToken,
    entry.inputCostPerTokenAboveThreshold,
    useHighTier
  );
  const outputRate = pickRate(
    entry.outputCostPerToken,
    entry.outputCostPerTokenAboveThreshold,
    useHighTier
  );
  const cacheReadRate = pickRate(
    entry.cacheReadCostPerToken,
    entry.cacheReadCostPerTokenAboveThreshold,
    useHighTier
  );
  const cacheWriteRate = pickOptionalRate(
    entry.cacheCreateCostPerToken,
    entry.cacheCreateCostPerTokenAboveThreshold,
    useHighTier
  );
  const cacheWriteCostKnown =
    cacheWriteTokensKnown &&
    (cacheWriteTokens <= 0 || typeof cacheWriteRate === "number");

  const inputCostUsd = params.inputTokens * inputRate;
  const outputCostUsd = params.outputTokens * outputRate;
  const thinkingCostUsd = thinkingTokens * outputRate;
  const cacheReadCostUsd = cacheReadTokens * cacheReadRate;
  const cacheWriteCostUsd =
    cacheWriteCostKnown && typeof cacheWriteRate === "number"
      ? cacheWriteTokens * cacheWriteRate
      : 0;

  return {
    modelId: entry.modelId,
    inputCostUsd,
    outputCostUsd,
    thinkingCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd:
      inputCostUsd +
      outputCostUsd +
      thinkingCostUsd +
      cacheReadCostUsd +
      cacheWriteCostUsd,
    inputCostKnown: true,
    outputCostKnown: true,
    thinkingCostKnown: true,
    cacheReadCostKnown: true,
    cacheWriteCostKnown
  };
}

export function estimateModelCost(params: {
  vendor: SupportedVendor;
  model?: string;
  pricingMode?: PricingMode;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheCreateTokens?: number;
  thinkingTokens?: number;
  cacheCreateTokensKnown?: boolean;
}): { modelId: string; estimatedCostUsd: number } | null {
  const estimate = estimateUsageComponentCosts({
    vendor: params.vendor,
    model: params.model,
    pricingMode: params.pricingMode,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    thinkingTokens: params.thinkingTokens,
    cacheReadTokens: params.cacheTokens,
    cacheWriteTokens: params.cacheCreateTokens,
    cacheWriteTokensKnown: params.cacheCreateTokensKnown
  });
  if (!estimate) {
    return null;
  }

  return {
    modelId: estimate.modelId,
    estimatedCostUsd: estimate.totalCostUsd
  };
}

function shouldUseTieredPricing(
  entry: PricingEntry,
  promptContextTokens: number
): boolean {
  const threshold =
    entry.tieredPricingThresholdTokens ??
    (hasTieredPricing(entry)
      ? DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS
      : undefined);
  return typeof threshold === "number" && promptContextTokens > threshold;
}

function hasTieredPricing(entry: PricingEntry): boolean {
  return (
    typeof entry.inputCostPerTokenAboveThreshold === "number" ||
    typeof entry.outputCostPerTokenAboveThreshold === "number" ||
    typeof entry.cacheReadCostPerTokenAboveThreshold === "number" ||
    typeof entry.cacheCreateCostPerTokenAboveThreshold === "number"
  );
}

function pickRate(
  baseRate: number,
  highRate: number | undefined,
  useHighTier: boolean
): number {
  return useHighTier && typeof highRate === "number" ? highRate : baseRate;
}

function pickOptionalRate(
  baseRate: number | undefined,
  highRate: number | undefined,
  useHighTier: boolean
): number | undefined {
  if (useHighTier && typeof highRate === "number") {
    return highRate;
  }
  return baseRate;
}

export function normalizeModelLookupKey(model: string): string {
  let value = model.trim().toLowerCase();

  if (value.includes(":")) {
    value = value.slice(value.lastIndexOf(":") + 1);
  }
  if (value.includes("/")) {
    value = value.slice(value.lastIndexOf("/") + 1);
  }

  value = value.replace(/^models\//u, "");
  value = value.replace(
    /^(anthropic|openai|google|gemini|vertex_ai(?:-language-models)?|bedrock)\./u,
    ""
  );
  value = value.replace(/[_\s]+/gu, "-");
  value = value.replace(/-\((low|medium|high)\)$/u, "");
  value = value.replace(/-(low|medium|high)$/u, "");
  value = value.replace(/-v\d+(?::\d+)?$/u, "");
  value = value.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/u, "");
  value = value.replace(/-preview-(\d{2}-\d{2}|\d{2}-\d{4})$/u, "-preview");

  return value;
}

function normalizeCanonicalModelLookupKey(model: string): string {
  return model.trim().toLowerCase();
}

function pricingCatalogIndex(
  vendor: SupportedVendor,
  catalog: PricingCatalog
): PricingCatalogIndex {
  const cached = PRICING_CATALOG_INDEX_CACHE[vendor].get(catalog);
  if (cached) {
    return cached;
  }

  const lookup = Object.fromEntries(
    (["standard", "fast"] as PricingMode[]).map((mode) => {
      const entries = new Map<string, PricingEntry>();
      for (const entry of catalog[mode] ?? []) {
        entries.set(normalizeModelLookupKey(entry.modelId), entry);
        for (const alias of entry.aliases ?? []) {
          entries.set(normalizeModelLookupKey(alias), entry);
        }
      }
      return [mode, entries];
    })
  ) as Record<PricingMode, Map<string, PricingEntry>>;
  const forwardCompatEntries = Object.fromEntries(
    (["standard", "fast"] as PricingMode[]).map((mode) => [
      mode,
      (catalog[mode] ?? []).flatMap((entry) => {
        const spec = parseForwardCompatSpec(
          vendor,
          normalizeModelLookupKey(entry.modelId)
        );
        return spec ? [{ entry, spec }] : [];
      })
    ])
  ) as PricingCatalogIndex["forwardCompatEntries"];
  const created = { lookup, forwardCompatEntries };
  PRICING_CATALOG_INDEX_CACHE[vendor].set(catalog, created);
  return created;
}

function resolvePricingEntry(
  catalog: PricingCatalog,
  vendor: SupportedVendor,
  model: string,
  pricingMode: PricingMode,
  historicalCatalog?: HistoricalPricingCatalog
): PricingEntry | undefined {
  const index = pricingCatalogIndex(vendor, catalog);
  const historicalIndex = historicalCatalog
    ? pricingCatalogIndex(vendor, historicalCatalog)
    : undefined;
  const normalizedKey = normalizeModelLookupKey(model);
  const effectiveMode = vendor === "codex" ? pricingMode : "standard";
  if (effectiveMode === "fast") {
    const fastDirect = index.lookup.fast.get(normalizedKey);
    if (fastDirect) {
      return fastDirect;
    }
    const standardDirect = index.lookup.standard.get(normalizedKey);
    if (standardDirect) {
      return standardDirect;
    }
    const historicalFastDirect =
      historicalIndex?.lookup.fast.get(normalizedKey);
    if (historicalFastDirect) {
      return historicalFastDirect;
    }
    const historicalStandardDirect =
      historicalIndex?.lookup.standard.get(normalizedKey);
    if (historicalStandardDirect) {
      return historicalStandardDirect;
    }
  } else {
    const direct = index.lookup.standard.get(normalizedKey);
    if (direct) {
      return direct;
    }
    const historicalDirect =
      historicalIndex?.lookup.standard.get(normalizedKey);
    if (historicalDirect) {
      return historicalDirect;
    }
  }

  const requestedSpec = parseForwardCompatSpec(vendor, normalizedKey);
  if (!requestedSpec) {
    return undefined;
  }

  if (effectiveMode === "fast") {
    return (
      resolveForwardCompatPricingEntry(
        vendor,
        index.forwardCompatEntries.fast,
        requestedSpec
      ) ??
      resolveForwardCompatPricingEntry(
        vendor,
        index.forwardCompatEntries.standard,
        requestedSpec
      )
    );
  }
  return resolveForwardCompatPricingEntry(
    vendor,
    index.forwardCompatEntries.standard,
    requestedSpec
  );
}

function resolveForwardCompatPricingEntry(
  vendor: SupportedVendor,
  entries: Array<{ entry: PricingEntry; spec: ForwardCompatSpec }>,
  requestedSpec: ForwardCompatSpec
): PricingEntry | undefined {
  if (requestedSpec.kind === "codex") {
    const matches = entries.filter(
      (
        candidate
      ): candidate is { entry: PricingEntry; spec: CodexForwardCompatSpec } =>
        candidate.spec.kind === "codex" &&
        candidate.spec.tier === requestedSpec.tier &&
        candidate.spec.major === requestedSpec.major &&
        compareVersion(candidate.spec, requestedSpec) <= 0
    );
    return pickHighestVersionEntry(matches);
  }

  if (requestedSpec.kind === "claude") {
    const matches = entries.filter(
      (
        candidate
      ): candidate is { entry: PricingEntry; spec: ClaudeForwardCompatSpec } =>
        candidate.spec.kind === "claude" &&
        candidate.spec.line === requestedSpec.line &&
        candidate.spec.major === requestedSpec.major &&
        compareVersion(candidate.spec, requestedSpec) <= 0
    );
    return pickHighestVersionEntry(matches);
  }

  const matches = entries
    .filter(
      (
        candidate
      ): candidate is { entry: PricingEntry; spec: GeminiForwardCompatSpec } =>
        candidate.spec.kind === "gemini" &&
        candidate.spec.major === requestedSpec.major &&
        candidate.spec.tier === requestedSpec.tier &&
        candidate.spec.preview === requestedSpec.preview &&
        compareVersion(candidate.spec, requestedSpec) <= 0
    )
    .sort((left, right) => {
      const versionDiff = compareVersion(right.spec, left.spec);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (
        Number(right.spec.preview === requestedSpec.preview) -
        Number(left.spec.preview === requestedSpec.preview)
      );
    });
  return matches[0]?.entry;
}

function pickHighestVersionEntry<
  TSpec extends { major: number; minor: number }
>(
  matches: Array<{ entry: PricingEntry; spec: TSpec }>
): PricingEntry | undefined {
  return matches.sort((left, right) => compareVersion(right.spec, left.spec))[0]
    ?.entry;
}

function compareVersion(
  left: { major: number; minor: number },
  right: { major: number; minor: number }
): number {
  return left.major - right.major || left.minor - right.minor;
}

function parseForwardCompatSpec(
  vendor: SupportedVendor,
  normalizedKey: string
): ForwardCompatSpec | null {
  if (vendor === "codex") {
    return parseCodexForwardCompatSpec(normalizedKey);
  }
  if (vendor === "claude") {
    return parseClaudeForwardCompatSpec(normalizedKey);
  }
  return parseGeminiForwardCompatSpec(normalizedKey);
}

function parseCodexForwardCompatSpec(
  normalizedKey: string
): CodexForwardCompatSpec | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z][a-z0-9-]*))?$/u.exec(
    normalizedKey
  );
  if (!match) {
    return null;
  }
  if (!match[2] && !match[3]) {
    return null;
  }

  return {
    kind: "codex",
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    tier: match[3] ?? "main"
  };
}

function parseClaudeForwardCompatSpec(
  normalizedKey: string
): ClaudeForwardCompatSpec | null {
  const match =
    /^claude-(fable|mythos|sonnet|opus|haiku)-(\d+)(?:[.-](\d+))?$/u.exec(
      normalizedKey
    );
  if (!match) {
    return null;
  }

  return {
    kind: "claude",
    line: match[1] as ClaudeForwardCompatSpec["line"],
    major: Number(match[2]),
    minor: Number(match[3] ?? 0)
  };
}

function parseGeminiForwardCompatSpec(
  normalizedKey: string
): GeminiForwardCompatSpec | null {
  const match =
    /^gemini-(\d+)(?:\.(\d+))?-(pro|flash-lite|flash)(?:-(preview))?$/u.exec(
      normalizedKey
    );
  if (!match) {
    return null;
  }

  return {
    kind: "gemini",
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    tier: match[3] as GeminiForwardCompatSpec["tier"],
    preview: match[4] === "preview"
  };
}
