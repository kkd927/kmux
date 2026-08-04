import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { dirname } from "node:path";

import {
  BUNDLED_MODEL_PRICING_CATALOG,
  createModelPricingResolver,
  parseModelPricingCatalog,
  validateModelPricingCatalog,
  type ModelPricingCatalogDocument,
  type ModelPricingResolver
} from "@kmux/metadata";

export const MODEL_PRICING_CATALOG_URL =
  "https://kkd927.github.io/kmux/data/model-pricing/v1/catalog.json";
export const MODEL_PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MODEL_PRICING_REQUEST_TIMEOUT_MS = 10_000;
export const MODEL_PRICING_MAX_RESPONSE_BYTES = 1024 * 1024;

type ModelPricingCache = {
  catalog: ModelPricingCatalogDocument;
  lastAttemptAt: string;
  etag?: string;
};

export type RemoteModelPricingResponse =
  | { status: 304; etag?: string }
  | { status: 200; body: string; etag?: string };

export interface ModelPricingCatalogRuntime {
  getCatalog(): ModelPricingCatalogDocument;
  getResolver(): ModelPricingResolver;
  start(): void;
  shutdown(): void;
  checkNow(): Promise<void>;
}

interface CreateModelPricingCatalogRuntimeOptions {
  cachePath: string;
  bundledCatalog?: unknown;
  now?: () => number;
  requestRemote?: (options: {
    url: string;
    etag?: string;
  }) => Promise<RemoteModelPricingResponse>;
  onCatalogChange?: (resolver: ModelPricingResolver) => void;
  warn?: (message: string) => void;
}

export function createModelPricingCatalogRuntime(
  options: CreateModelPricingCatalogRuntimeOptions
): ModelPricingCatalogRuntime {
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const requestRemote =
    options.requestRemote ?? requestRemoteModelPricingCatalog;
  const bundledCatalog = validateModelPricingCatalog(
    options.bundledCatalog ?? BUNDLED_MODEL_PRICING_CATALOG
  );
  const cached = readModelPricingCache(options.cachePath, warn);
  let activeCatalog = selectStartupCatalog(
    bundledCatalog,
    cached?.catalog,
    warn
  );
  let activeResolver = createModelPricingResolver(activeCatalog);
  let lastAttemptAtMs = cached ? Date.parse(cached.lastAttemptAt) : undefined;
  let etag = cached?.etag;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checkInFlight: Promise<void> | null = null;

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    scheduleNextCheck();
  }

  function shutdown(): void {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNextCheck(): void {
    if (!started) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    const dueAt =
      (lastAttemptAtMs ?? Number.NEGATIVE_INFINITY) +
      MODEL_PRICING_REFRESH_INTERVAL_MS;
    const delay = Number.isFinite(dueAt) ? Math.max(0, dueAt - now()) : 0;
    timer = setTimeout(() => {
      timer = null;
      void checkNow().finally(scheduleNextCheck);
    }, delay);
    timer.unref?.();
  }

  async function checkNow(): Promise<void> {
    if (checkInFlight) {
      return checkInFlight;
    }
    checkInFlight = (async () => {
      const attemptAtMs = now();
      try {
        const response = await requestRemote({
          url: MODEL_PRICING_CATALOG_URL,
          ...(etag ? { etag } : {})
        });
        if (response.status === 304) {
          etag = response.etag ?? etag;
          return;
        }

        const remoteCatalog = parseModelPricingCatalog(response.body);
        etag = response.etag ?? etag;
        if (remoteCatalog.catalogVersion < activeCatalog.catalogVersion) {
          warn("[model-pricing] ignored a catalog version downgrade");
          return;
        }
        if (
          remoteCatalog.catalogVersion === activeCatalog.catalogVersion &&
          remoteCatalog.revision !== activeCatalog.revision
        ) {
          warn("[model-pricing] rejected conflicting catalog revisions");
          return;
        }
        if (remoteCatalog.catalogVersion > activeCatalog.catalogVersion) {
          activeCatalog = remoteCatalog;
          activeResolver = createModelPricingResolver(activeCatalog);
          options.onCatalogChange?.(activeResolver);
        }
      } catch (error) {
        warn(
          `[model-pricing] remote catalog check failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        lastAttemptAtMs = attemptAtMs;
        await writeModelPricingCache(options.cachePath, {
          catalog: activeCatalog,
          lastAttemptAt: new Date(attemptAtMs).toISOString(),
          ...(etag ? { etag } : {})
        }).catch((error) => {
          warn(
            `[model-pricing] cache write failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
    })().finally(() => {
      checkInFlight = null;
    });
    return checkInFlight;
  }

  return {
    getCatalog: () => activeCatalog,
    getResolver: () => activeResolver,
    start,
    shutdown,
    checkNow
  };
}

function selectStartupCatalog(
  bundled: ModelPricingCatalogDocument,
  cached: ModelPricingCatalogDocument | undefined,
  warn: (message: string) => void
): ModelPricingCatalogDocument {
  if (!cached || cached.catalogVersion < bundled.catalogVersion) {
    return bundled;
  }
  if (
    cached.catalogVersion === bundled.catalogVersion &&
    cached.revision !== bundled.revision
  ) {
    warn("[model-pricing] rejected conflicting bundled and cached revisions");
    return bundled;
  }
  return cached.catalogVersion > bundled.catalogVersion ? cached : bundled;
}

function readModelPricingCache(
  cachePath: string,
  warn: (message: string) => void
): ModelPricingCache | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    warn("[model-pricing] ignored an unreadable catalog cache");
    return null;
  }
  if (!isRecord(value)) {
    warn("[model-pricing] ignored an invalid catalog cache");
    return null;
  }
  const keys = Object.keys(value).sort();
  const expectedKeys =
    value.etag === undefined
      ? ["catalog", "lastAttemptAt"]
      : ["catalog", "etag", "lastAttemptAt"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof value.lastAttemptAt !== "string" ||
    !isCanonicalIsoTimestamp(value.lastAttemptAt) ||
    (value.etag !== undefined &&
      (typeof value.etag !== "string" ||
        value.etag.length < 1 ||
        value.etag.length > 1024))
  ) {
    warn("[model-pricing] ignored an invalid catalog cache");
    return null;
  }
  try {
    return {
      catalog: validateModelPricingCatalog(value.catalog),
      lastAttemptAt: value.lastAttemptAt,
      ...(value.etag ? { etag: value.etag } : {})
    };
  } catch {
    warn("[model-pricing] ignored an invalid cached catalog");
    return null;
  }
}

async function writeModelPricingCache(
  cachePath: string,
  cache: ModelPricingCache
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(cache), {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function requestRemoteModelPricingCatalog(options: {
  url: string;
  etag?: string;
}): Promise<RemoteModelPricingResponse> {
  const url = new URL(options.url);
  if (url.protocol !== "https:") {
    return Promise.reject(new TypeError("model pricing URL must use HTTPS"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (
      result:
        | { kind: "resolve"; value: RemoteModelPricingResponse }
        | { kind: "reject"; error: unknown }
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (requestTimeout) {
        clearTimeout(requestTimeout);
      }
      if (result.kind === "resolve") {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };
    const request = httpsGet(
      url,
      {
        headers: {
          accept: "application/json",
          ...(options.etag ? { "if-none-match": options.etag } : {})
        }
      },
      (response) => {
        const responseEtag = Array.isArray(response.headers.etag)
          ? response.headers.etag[0]
          : response.headers.etag;
        if (response.statusCode === 304) {
          response.resume();
          settle({
            kind: "resolve",
            value: {
              status: 304,
              ...(responseEtag ? { etag: responseEtag } : {})
            }
          });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          settle({
            kind: "reject",
            error: new Error(
              `model pricing request returned HTTP ${String(response.statusCode)}`
            )
          });
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.byteLength;
          if (byteLength > MODEL_PRICING_MAX_RESPONSE_BYTES) {
            response.destroy(
              new RangeError("model pricing response exceeds 1 MiB")
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          settle({
            kind: "resolve",
            value: {
              status: 200,
              body: Buffer.concat(chunks).toString("utf8"),
              ...(responseEtag ? { etag: responseEtag } : {})
            }
          });
        });
        response.once("error", (error) => settle({ kind: "reject", error }));
      }
    );
    requestTimeout = setTimeout(() => {
      const error = new Error("model pricing request timed out");
      request.destroy(error);
      settle({ kind: "reject", error });
    }, MODEL_PRICING_REQUEST_TIMEOUT_MS);
    requestTimeout.unref?.();
    request.once("error", (error) => settle({ kind: "reject", error }));
  });
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
