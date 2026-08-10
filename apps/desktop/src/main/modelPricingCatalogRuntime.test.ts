import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLED_MODEL_PRICING_CATALOG,
  calculateModelPricingRevision,
  type ModelPricingCatalogDocument
} from "@kmux/metadata";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_PRICING_CATALOG_URL,
  MODEL_PRICING_REFRESH_INTERVAL_MS,
  createModelPricingCatalogRuntime,
  requestRemoteModelPricingCatalog
} from "./modelPricingCatalogRuntime";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("model pricing catalog runtime", () => {
  it("selects the highest valid bundled or cached catalog version", () => {
    const cachePath = createCachePath();
    const cachedCatalog = catalogAfterBundled(7);
    writeCache(cachePath, cachedCatalog, "2026-08-04T00:00:00.000Z");

    const runtime = createModelPricingCatalogRuntime({ cachePath });

    expect(runtime.getCatalog()).toEqual(cachedCatalog);
    expect(runtime.getResolver().catalog.catalogVersion).toBe(
      cachedCatalog.catalogVersion
    );
  });

  it("rejects a cached revision conflict at the bundled version", () => {
    const cachePath = createCachePath();
    writeCache(
      cachePath,
      catalogVersion(BUNDLED_MODEL_PRICING_CATALOG.catalogVersion, 7),
      "2026-08-04T00:00:00.000Z"
    );
    const warn = vi.fn();

    const runtime = createModelPricingCatalogRuntime({ cachePath, warn });

    expect(runtime.getCatalog()).toEqual(BUNDLED_MODEL_PRICING_CATALOG);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicting bundled and cached revisions")
    );
  });

  it("ignores a legacy per-token catalog cache", () => {
    const cachePath = createCachePath();
    writeFileSync(
      cachePath,
      JSON.stringify({
        catalog: legacyPerTokenCatalog(),
        lastAttemptAt: "2026-08-04T00:00:00.000Z"
      })
    );
    const warn = vi.fn();

    const runtime = createModelPricingCatalogRuntime({ cachePath, warn });

    expect(runtime.getCatalog()).toEqual(BUNDLED_MODEL_PRICING_CATALOG);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ignored an invalid cached catalog")
    );
  });

  it("activates and caches only a higher remote version", async () => {
    const cachePath = createCachePath();
    const remoteCatalog = catalogAfterBundled(8);
    const onCatalogChange = vi.fn();
    const requestRemote = vi.fn(async () => ({
      status: 200 as const,
      body: JSON.stringify(remoteCatalog),
      etag: '"catalog-2"'
    }));
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      now: () => Date.parse("2026-08-05T00:00:00.000Z"),
      requestRemote,
      onCatalogChange
    });

    await runtime.checkNow();

    expect(requestRemote).toHaveBeenCalledWith({
      url: MODEL_PRICING_CATALOG_URL
    });
    expect(runtime.getCatalog()).toEqual(remoteCatalog);
    expect(onCatalogChange).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
      catalog: remoteCatalog,
      lastAttemptAt: "2026-08-05T00:00:00.000Z",
      etag: '"catalog-2"'
    });
  });

  it.each([
    ["downgrade", JSON.stringify(BUNDLED_MODEL_PRICING_CATALOG)],
    ["invalid schema", JSON.stringify({ schemaVersion: 99 })],
    ["invalid price", invalidPriceCatalogText()]
  ])("keeps the active catalog after a remote %s", async (_name, body) => {
    const cachePath = createCachePath();
    const activeCatalog = catalogAfterBundled(8);
    writeCache(cachePath, activeCatalog, "2026-08-04T00:00:00.000Z");
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      requestRemote: async () => ({ status: 200, body }),
      warn: vi.fn()
    });

    await runtime.checkNow();

    expect(runtime.getCatalog()).toEqual(activeCatalog);
  });

  it("rejects a remote revision conflict at the active version", async () => {
    const cachePath = createCachePath();
    const activeCatalog = catalogAfterBundled(8);
    const conflictingCatalog = catalogVersion(activeCatalog.catalogVersion, 9);
    writeCache(cachePath, activeCatalog, "2026-08-04T00:00:00.000Z");
    const warn = vi.fn();
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      requestRemote: async () => ({
        status: 200,
        body: JSON.stringify(conflictingCatalog)
      }),
      warn
    });

    await runtime.checkNow();

    expect(runtime.getCatalog()).toEqual(activeCatalog);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicting catalog revisions")
    );
  });

  it("updates only the attempt timestamp and ETag after a 304", async () => {
    const cachePath = createCachePath();
    const activeCatalog = catalogAfterBundled(8);
    writeCache(cachePath, activeCatalog, "2026-08-04T00:00:00.000Z", '"old"');
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      now: () => Date.parse("2026-08-05T00:00:00.000Z"),
      requestRemote: async () => ({ status: 304, etag: '"new"' })
    });

    await runtime.checkNow();

    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
      catalog: activeCatalog,
      lastAttemptAt: "2026-08-05T00:00:00.000Z",
      etag: '"new"'
    });
  });

  it("keeps the selected catalog after timeout or network failure", async () => {
    const cachePath = createCachePath();
    const warn = vi.fn();
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      requestRemote: async () => {
        throw new Error("request timed out");
      },
      warn
    });

    await expect(runtime.checkNow()).resolves.toBeUndefined();

    expect(runtime.getCatalog()).toEqual(BUNDLED_MODEL_PRICING_CATALOG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("checks again once the 24-hour attempt interval expires", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-05T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const cachePath = createCachePath();
    writeCache(
      cachePath,
      BUNDLED_MODEL_PRICING_CATALOG,
      new Date(nowMs).toISOString()
    );
    const requestRemote = vi.fn(async () => ({ status: 304 as const }));
    const runtime = createModelPricingCatalogRuntime({
      cachePath,
      requestRemote
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(MODEL_PRICING_REFRESH_INTERVAL_MS - 1);
    expect(requestRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestRemote).toHaveBeenCalledOnce();
    await runtime.checkNow();
    runtime.shutdown();
  });

  it("rejects non-HTTPS request URLs before opening a connection", async () => {
    await expect(
      requestRemoteModelPricingCatalog({
        url: "http://example.com/catalog.json"
      })
    ).rejects.toThrow(/must use HTTPS/u);
  });
});

function createCachePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kmux-model-pricing-"));
  cleanupPaths.push(directory);
  return join(directory, "catalog-cache.json");
}

function catalogVersion(
  version: number,
  inputCostPerMillionTokensDelta: number
): ModelPricingCatalogDocument {
  const catalog = structuredClone(BUNDLED_MODEL_PRICING_CATALOG);
  catalog.catalogVersion = version;
  catalog.models.claude.standard[0].inputCostPerMillionTokens +=
    inputCostPerMillionTokensDelta;
  catalog.revision = calculateModelPricingRevision(catalog.models);
  return catalog;
}

function catalogAfterBundled(
  inputCostDelta: number,
  versionOffset = 1
): ModelPricingCatalogDocument {
  return catalogVersion(
    BUNDLED_MODEL_PRICING_CATALOG.catalogVersion + versionOffset,
    inputCostDelta
  );
}

function invalidPriceCatalogText(): string {
  const catalog = catalogAfterBundled(8, 2);
  catalog.models.claude.standard[0].inputCostPerMillionTokens = -1;
  catalog.revision = calculateModelPricingRevision(catalog.models);
  return JSON.stringify(catalog);
}

function legacyPerTokenCatalog(): unknown {
  const catalog = catalogAfterBundled(8, 2);
  const fieldMappings = [
    ["inputCostPerMillionTokens", "inputCostPerToken"],
    ["outputCostPerMillionTokens", "outputCostPerToken"],
    ["cacheReadCostPerMillionTokens", "cacheReadCostPerToken"],
    ["cacheCreateCostPerMillionTokens", "cacheCreateCostPerToken"],
    [
      "inputCostPerMillionTokensAboveThreshold",
      "inputCostPerTokenAboveThreshold"
    ],
    [
      "outputCostPerMillionTokensAboveThreshold",
      "outputCostPerTokenAboveThreshold"
    ],
    [
      "cacheReadCostPerMillionTokensAboveThreshold",
      "cacheReadCostPerTokenAboveThreshold"
    ],
    [
      "cacheCreateCostPerMillionTokensAboveThreshold",
      "cacheCreateCostPerTokenAboveThreshold"
    ]
  ] as const;
  for (const vendorCatalog of Object.values(catalog.models)) {
    for (const mode of ["standard", "fast"] as const) {
      for (const pricingEntry of vendorCatalog[mode] ?? []) {
        const entry = pricingEntry as unknown as Record<string, unknown>;
        for (const [perMillionKey, perTokenKey] of fieldMappings) {
          if (typeof entry[perMillionKey] === "number") {
            entry[perTokenKey] = Number(entry[perMillionKey]) / 1_000_000;
            delete entry[perMillionKey];
          }
        }
      }
    }
  }
  return catalog;
}

function writeCache(
  cachePath: string,
  catalog: ModelPricingCatalogDocument,
  lastAttemptAt: string,
  etag?: string
): void {
  writeFileSync(
    cachePath,
    JSON.stringify({
      catalog,
      lastAttemptAt,
      ...(etag ? { etag } : {})
    })
  );
}
