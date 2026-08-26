import { IncrementalSha256 } from "@kmux/proto";

import type {
  PricingVendorId,
  PricingCatalog,
  PricingEntry,
  PricingMode
} from "./modelPricing";

export type ModelPricingModels = Record<PricingVendorId, PricingCatalog>;

export type ModelPricingCatalogDocument = {
  schemaVersion: 1;
  catalogVersion: number;
  publishedAt: string;
  revision: string;
  models: ModelPricingModels;
};

const PRICING_ENTRY_KEYS = new Set([
  "modelId",
  "inputCostPerMillionTokens",
  "outputCostPerMillionTokens",
  "cacheReadCostPerMillionTokens",
  "cacheCreateCostPerMillionTokens",
  "inputCostPerMillionTokensAboveThreshold",
  "outputCostPerMillionTokensAboveThreshold",
  "cacheReadCostPerMillionTokensAboveThreshold",
  "cacheCreateCostPerMillionTokensAboveThreshold",
  "tieredPricingThresholdTokens",
  "aliases"
]);
const PRICING_VENDOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_PRICING_VENDORS = 32;

export function calculateModelPricingRevision(
  models: ModelPricingModels
): string {
  return new IncrementalSha256()
    .update(new TextEncoder().encode(JSON.stringify(models)))
    .digestHex();
}

export function parseModelPricingCatalog(
  content: string
): ModelPricingCatalogDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError("model pricing catalog is not valid JSON");
  }
  return validateModelPricingCatalog(parsed);
}

export function validateModelPricingCatalog(
  value: unknown
): ModelPricingCatalogDocument {
  requireExactObjectKeys(
    value,
    ["schemaVersion", "catalogVersion", "publishedAt", "revision", "models"],
    "catalog"
  );
  if (value.schemaVersion !== 1) {
    throw new TypeError("model pricing catalog schemaVersion is unsupported");
  }
  if (
    typeof value.catalogVersion !== "number" ||
    !Number.isSafeInteger(value.catalogVersion) ||
    value.catalogVersion < 1
  ) {
    throw new TypeError("model pricing catalogVersion is invalid");
  }
  if (
    typeof value.publishedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.publishedAt)
  ) {
    throw new TypeError("model pricing publishedAt is invalid");
  }
  if (
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.revision)
  ) {
    throw new TypeError("model pricing revision is invalid");
  }
  if (!isRecord(value.models)) {
    throw new TypeError("model pricing models must be an object");
  }
  const vendors = Object.keys(value.models);
  if (vendors.length < 1 || vendors.length > MAX_PRICING_VENDORS) {
    throw new TypeError("model pricing vendor count is invalid");
  }
  for (const vendor of vendors) {
    if (!PRICING_VENDOR_ID_PATTERN.test(vendor)) {
      throw new TypeError(`model pricing vendor ID is invalid: ${vendor}`);
    }
    validateVendorCatalog(value.models[vendor], vendor);
  }
  const catalog = value as ModelPricingCatalogDocument;
  if (calculateModelPricingRevision(catalog.models) !== catalog.revision) {
    throw new TypeError(
      "model pricing revision does not match its models payload"
    );
  }
  return catalog;
}

function validateVendorCatalog(value: unknown, vendor: PricingVendorId): void {
  if (!isRecord(value)) {
    throw new TypeError(`model pricing models.${vendor} must be an object`);
  }
  const modes = Object.keys(value);
  if (
    !modes.includes("standard") ||
    modes.some((mode) => mode !== "standard" && mode !== "fast")
  ) {
    throw new TypeError(`model pricing models.${vendor} keys are invalid`);
  }
  for (const mode of modes as PricingMode[]) {
    const entries = value[mode];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TypeError(`model pricing ${vendor}/${mode} must not be empty`);
    }
    const modelIds = new Set<string>();
    const aliases = new Map<string, string>();
    for (const [index, entry] of entries.entries()) {
      validatePricingEntry(entry, `models.${vendor}.${mode}[${index}]`);
      const modelIdKey = entry.modelId.toLowerCase();
      if (modelIds.has(modelIdKey)) {
        throw new TypeError(
          `duplicate model pricing ID: ${vendor}/${mode}/${entry.modelId}`
        );
      }
      modelIds.add(modelIdKey);
      for (const alias of [entry.modelId, ...(entry.aliases ?? [])]) {
        const aliasKey = alias.toLowerCase();
        const existing = aliases.get(aliasKey);
        if (existing && existing !== modelIdKey) {
          throw new TypeError(
            `model pricing alias is ambiguous: ${vendor}/${mode}/${alias}`
          );
        }
        aliases.set(aliasKey, modelIdKey);
      }
    }
  }
}

function validatePricingEntry(
  value: unknown,
  path: string
): asserts value is PricingEntry {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!PRICING_ENTRY_KEYS.has(key)) {
      throw new TypeError(`${path}.${key} is not supported`);
    }
  }
  if (
    typeof value.modelId !== "string" ||
    value.modelId.trim() !== value.modelId ||
    !value.modelId
  ) {
    throw new TypeError(`${path}.modelId is invalid`);
  }
  for (const key of [
    "inputCostPerMillionTokens",
    "outputCostPerMillionTokens",
    "cacheReadCostPerMillionTokens"
  ] as const) {
    requireNonNegativeFinite(value[key], `${path}.${key}`);
  }
  for (const key of [
    "cacheCreateCostPerMillionTokens",
    "inputCostPerMillionTokensAboveThreshold",
    "outputCostPerMillionTokensAboveThreshold",
    "cacheReadCostPerMillionTokensAboveThreshold",
    "cacheCreateCostPerMillionTokensAboveThreshold"
  ] as const) {
    if (value[key] !== undefined) {
      requireNonNegativeFinite(value[key], `${path}.${key}`);
    }
  }
  if (
    value.tieredPricingThresholdTokens !== undefined &&
    (typeof value.tieredPricingThresholdTokens !== "number" ||
      !Number.isSafeInteger(value.tieredPricingThresholdTokens) ||
      value.tieredPricingThresholdTokens < 1)
  ) {
    throw new TypeError(`${path}.tieredPricingThresholdTokens is invalid`);
  }
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) {
      throw new TypeError(`${path}.aliases must be an array`);
    }
    const aliases = new Set<string>();
    for (const alias of value.aliases) {
      if (typeof alias !== "string" || alias.trim() !== alias || !alias) {
        throw new TypeError(`${path}.aliases contains an invalid alias`);
      }
      const aliasKey = alias.toLowerCase();
      if (aliases.has(aliasKey)) {
        throw new TypeError(`${path}.aliases contains a duplicate alias`);
      }
      aliases.add(aliasKey);
    }
  }
}

function requireExactObjectKeys(
  value: unknown,
  expectedKeys: string[],
  path: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`model pricing ${path} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`model pricing ${path} keys are invalid`);
  }
}

function requireNonNegativeFinite(
  value: unknown,
  path: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite non-negative number`);
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
