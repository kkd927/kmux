import {
  BUNDLED_MODEL_PRICING_CATALOG,
  calculateModelPricingRevision,
  createModelPricingResolver
} from "@kmux/metadata";

// Alias and aggregation tests need stable prices even after a model leaves
// the live pricing page. This catalog is never bundled with the application.
export function createAntigravityTestPricingResolver() {
  const catalog = structuredClone(BUNDLED_MODEL_PRICING_CATALOG);
  catalog.models.gemini.standard = [
    {
      modelId: "gemini-3.5-flash",
      inputCostPerMillionTokens: 1.5,
      outputCostPerMillionTokens: 9,
      cacheReadCostPerMillionTokens: 0.15,
      aliases: [
        "Gemini 3.5 Flash (Medium)",
        "Gemini 3.5 Flash (High)",
        "gemini-3.5-flash-medium"
      ]
    }
  ];
  catalog.revision = calculateModelPricingRevision(catalog.models);
  return createModelPricingResolver(catalog);
}
