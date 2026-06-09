import { createHash } from "node:crypto";

type SupportedVendor = "claude" | "codex" | "gemini";

const DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS = 200_000;
const FORWARD_COMPAT_POLICY_REVISION = 1;

type PricingEntry = {
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

const MODEL_PRICING: Record<SupportedVendor, PricingEntry[]> = {
  claude: [
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
  ],
  codex: [
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
      modelId: "gpt-5-codex",
      inputCostPerToken: 0.00000125,
      outputCostPerToken: 0.00001,
      cacheReadCostPerToken: 0.000000125
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
      modelId: "gpt-5.2-codex",
      inputCostPerToken: 0.00000175,
      outputCostPerToken: 0.000014,
      cacheReadCostPerToken: 0.000000175
    },
    {
      modelId: "gpt-5.1-codex-max",
      inputCostPerToken: 0.00000125,
      outputCostPerToken: 0.00001,
      cacheReadCostPerToken: 0.000000125
    },
    {
      modelId: "gpt-5.1-codex",
      inputCostPerToken: 0.00000125,
      outputCostPerToken: 0.00001,
      cacheReadCostPerToken: 0.000000125
    },
    {
      modelId: "gpt-5.1-codex-mini",
      inputCostPerToken: 0.00000025,
      outputCostPerToken: 0.000002,
      cacheReadCostPerToken: 0.000000025
    },
    {
      modelId: "codex-mini-latest",
      inputCostPerToken: 0.0000015,
      outputCostPerToken: 0.000006,
      cacheReadCostPerToken: 0.000000375
    }
  ],
  gemini: [
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
};

export const USAGE_PRICING_REVISION = createHash("sha256")
  .update(
    JSON.stringify({
      forwardCompatPolicyRevision: FORWARD_COMPAT_POLICY_REVISION,
      modelPricing: MODEL_PRICING
    })
  )
  .digest("hex")
  .slice(0, 16);

const PRICING_LOOKUP = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([vendor, entries]) => {
    const lookup = new Map<string, PricingEntry>();
    for (const entry of entries) {
      lookup.set(normalizeModelLookupKey(entry.modelId), entry);
      for (const alias of entry.aliases ?? []) {
        lookup.set(normalizeModelLookupKey(alias), entry);
      }
    }
    return [vendor, lookup];
  })
) as Record<SupportedVendor, Map<string, PricingEntry>>;

type CodexForwardCompatSpec = {
  kind: "codex";
  major: number;
  minor: number;
  tier: "main" | "mini" | "nano" | "pro" | "spark";
};

type ClaudeForwardCompatSpec = {
  kind: "claude";
  line: "sonnet" | "opus" | "haiku";
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

const FORWARD_COMPAT_ENTRIES = Object.fromEntries(
  (Object.keys(MODEL_PRICING) as SupportedVendor[]).map((vendor) => [
    vendor,
    MODEL_PRICING[vendor]
      .map((entry) => {
        const spec = parseForwardCompatSpec(
          vendor,
          normalizeModelLookupKey(entry.modelId)
        );
        return spec ? { entry, spec } : null;
      })
      .filter(
        (value): value is { entry: PricingEntry; spec: ForwardCompatSpec } =>
          value !== null
      )
  ])
) as Record<
  SupportedVendor,
  Array<{ entry: PricingEntry; spec: ForwardCompatSpec }>
>;

export function estimateUsageComponentCosts(params: {
  vendor: SupportedVendor;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
}): UsageComponentCostEstimate | null {
  if (!params.model?.trim()) {
    return null;
  }

  const entry = resolvePricingEntry(params.vendor, params.model);
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

function resolvePricingEntry(
  vendor: SupportedVendor,
  model: string
): PricingEntry | undefined {
  const normalizedKey = normalizeModelLookupKey(model);
  const direct = PRICING_LOOKUP[vendor].get(normalizedKey);
  if (direct) {
    return direct;
  }

  const requestedSpec = parseForwardCompatSpec(vendor, normalizedKey);
  if (!requestedSpec) {
    return undefined;
  }

  return resolveForwardCompatPricingEntry(vendor, requestedSpec);
}

function resolveForwardCompatPricingEntry(
  vendor: SupportedVendor,
  requestedSpec: ForwardCompatSpec
): PricingEntry | undefined {
  if (requestedSpec.kind === "codex") {
    const matches = FORWARD_COMPAT_ENTRIES.codex.filter(
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
    const matches = FORWARD_COMPAT_ENTRIES.claude.filter(
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

  const matches = FORWARD_COMPAT_ENTRIES.gemini
    .filter(
      (
        candidate
      ): candidate is { entry: PricingEntry; spec: GeminiForwardCompatSpec } =>
        candidate.spec.kind === "gemini" &&
        candidate.spec.tier === requestedSpec.tier &&
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
  const match =
    /^gpt-(\d+)\.(\d+)(?:-(codex-spark|mini|nano|pro|codex))?$/u.exec(
      normalizedKey
    );
  if (!match) {
    return null;
  }

  return {
    kind: "codex",
    major: Number(match[1]),
    minor: Number(match[2]),
    tier:
      match[3] === "mini"
        ? "mini"
        : match[3] === "nano"
          ? "nano"
          : match[3] === "pro"
            ? "pro"
            : match[3] === "codex-spark"
              ? "spark"
              : "main"
  };
}

function parseClaudeForwardCompatSpec(
  normalizedKey: string
): ClaudeForwardCompatSpec | null {
  const match = /^claude-(sonnet|opus|haiku)-(\d+)(?:[.-](\d+))?$/u.exec(
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
    /^gemini-(\d+)\.(\d+)-(pro|flash-lite|flash)(?:-(preview))?$/u.exec(
      normalizedKey
    );
  if (!match) {
    return null;
  }

  return {
    kind: "gemini",
    major: Number(match[1]),
    minor: Number(match[2]),
    tier: match[3] as GeminiForwardCompatSpec["tier"],
    preview: match[4] === "preview"
  };
}
