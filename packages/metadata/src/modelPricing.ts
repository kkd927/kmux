import bundledModelPricingJson from "./modelPricing.json";
import {
  validateModelPricingCatalog,
  type ModelPricingCatalogDocument,
  type ModelPricingModels
} from "./modelPricingCatalog";

export {
  calculateModelPricingRevision,
  parseModelPricingCatalog,
  validateModelPricingCatalog
} from "./modelPricingCatalog";
export type {
  ModelPricingCatalogDocument,
  ModelPricingModels
} from "./modelPricingCatalog";

type SupportedVendor = "claude" | "codex" | "gemini";
export type SupportedPricingVendor = SupportedVendor;
export type PricingMode = "standard" | "fast";

const DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS = 200_000;

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

export type UsageCostEstimateParams = {
  vendor: SupportedPricingVendor;
  model?: string;
  pricingMode?: PricingMode;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
};

export type ModelCostEstimateParams = {
  vendor: SupportedPricingVendor;
  model?: string;
  pricingMode?: PricingMode;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheCreateTokens?: number;
  thinkingTokens?: number;
  cacheCreateTokensKnown?: boolean;
};

export interface ModelPricingResolver {
  readonly catalog: ModelPricingCatalogDocument;
  estimateUsageComponentCosts(
    params: UsageCostEstimateParams
  ): UsageComponentCostEstimate | null;
  estimateModelCost(
    params: ModelCostEstimateParams
  ): { modelId: string; estimatedCostUsd: number } | null;
  resolveCanonicalModelId(params: {
    vendor: SupportedPricingVendor;
    model?: string;
  }): string | null;
}

export function createModelPricingResolver(
  catalogValue: unknown
): ModelPricingResolver {
  const catalog = validateModelPricingCatalog(catalogValue);
  const canonicalLookup = buildCanonicalModelLookup(catalog.models);
  return Object.freeze({
    catalog,
    estimateUsageComponentCosts: (params: UsageCostEstimateParams) =>
      estimateUsageComponentCostsForCatalog(
        catalog.models[params.vendor],
        params
      ),
    estimateModelCost: (params: ModelCostEstimateParams) => {
      const estimate = estimateUsageComponentCostsForCatalog(
        catalog.models[params.vendor],
        {
          vendor: params.vendor,
          model: params.model,
          pricingMode: params.pricingMode,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          thinkingTokens: params.thinkingTokens,
          cacheReadTokens: params.cacheTokens,
          cacheWriteTokens: params.cacheCreateTokens,
          cacheWriteTokensKnown: params.cacheCreateTokensKnown
        }
      );
      return estimate
        ? { modelId: estimate.modelId, estimatedCostUsd: estimate.totalCostUsd }
        : null;
    },
    resolveCanonicalModelId: (params: {
      vendor: SupportedPricingVendor;
      model?: string;
    }) => {
      if (!params.model?.trim()) {
        return null;
      }
      return (
        canonicalLookup[params.vendor].get(
          normalizeCanonicalModelLookupKey(params.model)
        )?.modelId ?? null
      );
    }
  });
}

function buildCanonicalModelLookup(
  models: ModelPricingModels
): Record<SupportedPricingVendor, Map<string, PricingEntry>> {
  return Object.fromEntries(
    Object.entries(models).map(([vendor, catalog]) => {
      const lookup = new Map<string, PricingEntry>();
      for (const mode of ["standard", "fast"] as PricingMode[]) {
        for (const entry of catalog[mode] ?? []) {
          for (const value of [entry.modelId, ...(entry.aliases ?? [])]) {
            const key = normalizeCanonicalModelLookupKey(value);
            if (!lookup.has(key)) {
              lookup.set(key, entry);
            }
          }
        }
      }
      return [vendor, lookup];
    })
  ) as Record<SupportedPricingVendor, Map<string, PricingEntry>>;
}

export const BUNDLED_MODEL_PRICING_CATALOG = validateModelPricingCatalog(
  bundledModelPricingJson
);
export const BUNDLED_MODEL_PRICING_RESOLVER = createModelPricingResolver(
  BUNDLED_MODEL_PRICING_CATALOG
);

export function resolveCanonicalModelId(params: {
  vendor: SupportedPricingVendor;
  model?: string;
}): string | null {
  return BUNDLED_MODEL_PRICING_RESOLVER.resolveCanonicalModelId(params);
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

export function estimateUsageComponentCosts(
  params: UsageCostEstimateParams
): UsageComponentCostEstimate | null {
  return BUNDLED_MODEL_PRICING_RESOLVER.estimateUsageComponentCosts(params);
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
  }
): UsageComponentCostEstimate | null {
  if (!params.model?.trim()) {
    return null;
  }

  const entry = resolvePricingEntry(
    catalog,
    params.vendor,
    params.model,
    params.pricingMode ?? "standard"
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

export function estimateModelCost(
  params: ModelCostEstimateParams
): { modelId: string; estimatedCostUsd: number } | null {
  return BUNDLED_MODEL_PRICING_RESOLVER.estimateModelCost(params);
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
  pricingMode: PricingMode
): PricingEntry | undefined {
  const index = pricingCatalogIndex(vendor, catalog);
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
  } else {
    const direct = index.lookup.standard.get(normalizedKey);
    if (direct) {
      return direct;
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
