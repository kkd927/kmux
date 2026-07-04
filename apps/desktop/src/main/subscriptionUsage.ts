import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm,
  UsageVendor
} from "@kmux/proto";
import {
  type AgentStorageRoots,
  resolveAgentStorageRoots
} from "@kmux/metadata";

const execFileAsync = promisify(execFile);
const requireForMeta = createRequire(import.meta.url);

type KnownSubscriptionProvider = Exclude<UsageVendor, "unknown">;
type FetchLike = typeof fetch;
type ReadTextFile = (filePath: string) => Promise<string>;
type ExecFileLike = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;
type AntigravityKeyringReader = () => string | null | undefined;

type CodexProbeWindow = {
  key: "session" | "weekly";
  usedPercent: number;
  resetsAtMs?: number;
};

type CodexProbeResult = {
  planType?: string | null;
  credits?: {
    unlimited?: boolean;
  };
  windows: CodexProbeWindow[];
};

type ClaudeCredentials = {
  accessToken: string;
  expiresAtMs?: number;
  scopes: string[];
  rateLimitTier?: string;
};

type ClaudeCredentialsRecord = {
  source: "keychain" | "file";
  credentials: ClaudeCredentials;
};

type GeminiQuotaBucket = {
  modelId: string;
  remainingFraction: number;
  resetTime?: string;
};

type AntigravityQuotaSummaryBucket = {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  disabled?: boolean;
  resetTime?: string;
};

type AntigravityQuotaSummaryGroup = {
  displayName?: string;
  description?: string;
  buckets?: AntigravityQuotaSummaryBucket[];
};

type AntigravityQuotaSummaryPayload = {
  buckets?: AntigravityQuotaSummaryBucket[];
  groups?: AntigravityQuotaSummaryGroup[];
  description?: string;
};

type CodeAssistTier = {
  id?: string;
  name?: string;
  description?: string;
};

type CodeAssistLoadPayload = {
  currentTier?: CodeAssistTier;
  allowedTiers?: CodeAssistTier[];
  paidTier?: CodeAssistTier;
  cloudaicompanionProject?: string | { id?: string; projectId?: string };
};

type AntigravityCredentials = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  auth_method?: string;
};

export type SubscriptionProviderFetcher =
  () => Promise<SubscriptionProviderUsageVm | null>;
export type SubscriptionProviderAuthDetector = () => Promise<boolean>;

export interface CodexSubscriptionUsageOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  fetchImpl?: FetchLike;
  readTextFile?: ReadTextFile;
  codexRpcProbe?: (appVersion: string) => Promise<CodexProbeResult | null>;
  codexStatusProbe?: () => Promise<CodexProbeResult | null>;
}

export interface ClaudeSubscriptionUsageOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  fetchImpl?: FetchLike;
  readTextFile?: ReadTextFile;
  execFileImpl?: ExecFileLike;
}

export interface GeminiSubscriptionUsageOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  fetchImpl?: FetchLike;
  readTextFile?: ReadTextFile;
  execFileImpl?: ExecFileLike;
  googleOAuthClientConfig?: {
    clientId: string;
    clientSecret?: string;
  };
  antigravityKeyringReader?: AntigravityKeyringReader;
}

type FetcherFactoryOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  execFileImpl?: ExecFileLike;
  antigravityKeyringReader?: AntigravityKeyringReader;
};

const GEMINI_OAUTH_CLIENT_ID_ENV_KEYS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_ID"
] as const;
const GEMINI_OAUTH_CLIENT_SECRET_ENV_KEYS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET"
] as const;
const ANTIGRAVITY_OAUTH_CLIENT_ID_ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_CLIENT_ID",
  "AGY_OAUTH_CLIENT_ID"
] as const;
const ANTIGRAVITY_OAUTH_CLIENT_SECRET_ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
  "AGY_OAUTH_CLIENT_SECRET"
] as const;
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 5_000;
const SUBSCRIPTION_EXEC_TIMEOUT_MS = 4_000;
const SUBSCRIPTION_PROBE_TIMEOUT_MS = 4_000;
const GOOGLE_OAUTH_CLIENT_SECRET_LENGTH = 35;
const ANTIGRAVITY_USER_AGENT = "antigravity";
const ANTIGRAVITY_CLIENT_METADATA_HEADER = "X-Goog-Ext-525006001-bin";

class CodexSubscriptionProbeError extends Error {
  constructor() {
    super("Codex subscription probes exhausted");
    this.name = "CodexSubscriptionProbeError";
  }
}

export function createSubscriptionUsageFetchers(
  options: FetcherFactoryOptions = {}
): Partial<Record<KnownSubscriptionProvider, SubscriptionProviderFetcher>> {
  return {
    codex: () => fetchCodexSubscriptionUsage(options),
    claude: () => fetchClaudeSubscriptionUsage(options),
    gemini: () => fetchGeminiSubscriptionUsage(options),
    antigravity: () => fetchAntigravitySubscriptionUsage(options)
  };
}

export function createSubscriptionAuthDetectors(
  options: FetcherFactoryOptions = {}
): Partial<
  Record<KnownSubscriptionProvider, SubscriptionProviderAuthDetector>
> {
  return {
    codex: async () => {
      const readTextFile = defaultReadTextFile;
      const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
      const auth = await readJsonFile<{
        tokens?: {
          access_token?: string;
        };
      }>(agentStorageRoots.codex.authPath, readTextFile);
      return Boolean(auth?.tokens?.access_token?.trim());
    },
    claude: async () => {
      const now = options.now ?? (() => Date.now());
      const readTextFile = defaultReadTextFile;
      const execFileImpl = options.execFileImpl ?? defaultExecFile;
      const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
      const credentials = await loadClaudeCredentials({
        credentialsPath: agentStorageRoots.claude.credentialsPath,
        readTextFile,
        execFileImpl,
        platform: options.platform ?? process.platform
      });
      if (!credentials) {
        return false;
      }
      const { accessToken, expiresAtMs } = credentials.credentials;
      if (!accessToken) {
        return false;
      }
      return !expiresAtMs || now() < expiresAtMs;
    },
    gemini: async () => {
      const now = options.now ?? (() => Date.now());
      const readTextFile = defaultReadTextFile;
      const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
      const settings = await readGeminiSettings(
        agentStorageRoots.gemini.settingsPath,
        readTextFile
      );
      if (settings.selectedType && settings.selectedType !== "oauth-personal") {
        return false;
      }
      const credentials = await readJsonFile<{
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
      }>(agentStorageRoots.gemini.oauthCredentialsPath, readTextFile);
      const accessToken = credentials?.access_token?.trim();
      const refreshToken = credentials?.refresh_token?.trim();
      if (!accessToken && !refreshToken) {
        return false;
      }
      if (!accessToken && refreshToken) {
        return true;
      }
      if (!accessToken) {
        return false;
      }
      if (
        typeof credentials?.expiry_date === "number" &&
        now() >= credentials.expiry_date
      ) {
        return Boolean(refreshToken);
      }
      return true;
    },
    antigravity: async () => {
      const now = options.now ?? (() => Date.now());
      const readTextFile = defaultReadTextFile;
      const execFileImpl = options.execFileImpl ?? defaultExecFile;
      const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
      const credentials = await loadAntigravityCredentials({
        execFileImpl,
        platform: options.platform ?? process.platform,
        keyringReader: options.antigravityKeyringReader,
        fallbackTokenPath: agentStorageRoots.antigravity.oauthTokenPath,
        readTextFile,
        now
      });
      const accessToken = credentials?.access_token?.trim();
      const refreshToken = credentials?.refresh_token?.trim();
      if (accessToken && !isCredentialsExpired(credentials, now())) {
        return true;
      }
      return Boolean(refreshToken);
    }
  };
}

export async function fetchCodexSubscriptionUsage(
  options: CodexSubscriptionUsageOptions = {}
): Promise<SubscriptionProviderUsageVm | null> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
  const authPath = agentStorageRoots.codex.authPath;
  const auth = await readJsonFile<{
    tokens?: {
      access_token?: string;
      account_id?: string;
    };
  }>(authPath, readTextFile);

  if (!auth?.tokens?.access_token) {
    return null;
  }

  try {
    const response = await fetchImpl(
      "https://chatgpt.com/backend-api/wham/usage",
      withFetchTimeout({
        method: "GET",
        headers: compactHeaders({
          Authorization: `Bearer ${auth.tokens.access_token}`,
          Accept: "application/json",
          "ChatGPT-Account-Id": auth.tokens.account_id
        })
      })
    );
    if (response.ok) {
      const payload = (await response.json()) as {
        plan_type?: string;
        credits?: {
          unlimited?: boolean;
        };
        rate_limit?: {
          primary_window?: {
            used_percent?: number;
            reset_at?: number;
            limit_window_seconds?: number;
          };
          secondary_window?: {
            used_percent?: number;
            reset_at?: number;
            limit_window_seconds?: number;
          };
        };
      };
      return normalizeCodexUsageFromApi(payload, now());
    }
  } catch {
    // Fall back to the local paths below.
  }

  const appVersion = resolveDesktopAppVersion();
  const codexRpcProbe =
    options.codexRpcProbe ??
    ((resolvedAppVersion: string) =>
      probeCodexViaRpc(options.env, resolvedAppVersion));
  try {
    const rpcUsage = await codexRpcProbe(appVersion);
    if (rpcUsage) {
      return normalizeCodexUsageFromProbe(rpcUsage, "rpc", now());
    }
  } catch {
    // Fall through to PTY probing.
  }

  const codexStatusProbe =
    options.codexStatusProbe ??
    (() =>
      probeCodexViaStatus(options.env, options.platform ?? process.platform));
  try {
    const statusUsage = await codexStatusProbe();
    if (statusUsage) {
      return normalizeCodexUsageFromProbe(statusUsage, "pty", now());
    }
  } catch {
    throw new CodexSubscriptionProbeError();
  }

  throw new CodexSubscriptionProbeError();
}

export async function fetchClaudeSubscriptionUsage(
  options: ClaudeSubscriptionUsageOptions = {}
): Promise<SubscriptionProviderUsageVm | null> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
  const credentials = await loadClaudeCredentials({
    credentialsPath: agentStorageRoots.claude.credentialsPath,
    readTextFile,
    execFileImpl,
    platform: options.platform ?? process.platform
  });
  if (!credentials) {
    return null;
  }

  const { accessToken, expiresAtMs, scopes, rateLimitTier } =
    credentials.credentials;
  if (expiresAtMs && now() >= expiresAtMs) {
    return null;
  }
  if (!scopes.includes("user:profile") && !rateLimitTier) {
    return null;
  }

  const headers = compactHeaders({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "claude-code/2.1.0",
    "anthropic-beta": "oauth-2025-04-20"
  });

  const response = await fetchImpl(
    "https://api.anthropic.com/api/oauth/usage",
    withFetchTimeout({
      method: "GET",
      headers
    })
  );
  if (response.ok) {
    const payload = (await response.json()) as {
      five_hour?: { utilization?: number; resets_at?: string } | null;
      seven_day?: { utilization?: number; resets_at?: string } | null;
      extra_usage?: {
        is_enabled?: boolean;
        monthly_limit?: number;
        used_credits?: number;
        utilization?: number;
        currency?: string;
        resets_at?: string;
      } | null;
    };
    const planLabel = normalizeClaudePlanLabel(rateLimitTier, {
      hasActiveSpendCap: Boolean(payload.extra_usage?.is_enabled)
    });
    return normalizeClaudeUsage({
      planLabel,
      source: "oauth_usage",
      fiveHourUtilization: payload.five_hour?.utilization,
      fiveHourResetAt: payload.five_hour?.resets_at,
      weeklyUtilization: payload.seven_day?.utilization,
      weeklyResetAt: payload.seven_day?.resets_at,
      extraUsage: payload.extra_usage
        ? {
            isEnabled: payload.extra_usage.is_enabled,
            monthlyLimitCents: payload.extra_usage.monthly_limit,
            usedCreditsCents: payload.extra_usage.used_credits,
            utilizationPercent: payload.extra_usage.utilization,
            currency: payload.extra_usage.currency,
            resetsAt: payload.extra_usage.resets_at
          }
        : undefined,
      nowMs: now()
    });
  }

  if (isTransientUsageFetchStatus(response.status)) {
    throw new ClaudeSubscriptionTransientError(response.status);
  }

  return null;
}

class ClaudeSubscriptionTransientError extends Error {
  constructor(status: number) {
    super(`Claude usage endpoint returned transient status ${status}`);
    this.name = "ClaudeSubscriptionTransientError";
  }
}

function isTransientUsageFetchStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchGeminiSubscriptionUsage(
  options: GeminiSubscriptionUsageOptions = {}
): Promise<SubscriptionProviderUsageVm | null> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
  const settings = await readGeminiSettings(
    agentStorageRoots.gemini.settingsPath,
    readTextFile
  );
  if (settings.selectedType && settings.selectedType !== "oauth-personal") {
    return null;
  }

  const credentials = await readJsonFile<{
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expiry_date?: number;
  }>(agentStorageRoots.gemini.oauthCredentialsPath, readTextFile);
  let nextCredentials = credentials;
  const accessToken = credentials?.access_token?.trim();
  const refreshToken = credentials?.refresh_token?.trim();
  const isExpired =
    typeof credentials?.expiry_date === "number" &&
    now() >= credentials.expiry_date;
  if ((!accessToken || isExpired) && refreshToken) {
    nextCredentials = await refreshGeminiAccessToken({
      oauthCredentialsPath: agentStorageRoots.gemini.oauthCredentialsPath,
      fetchImpl,
      now,
      credentials,
      env: options.env,
      googleOAuthClientConfig: options.googleOAuthClientConfig
    });
  }
  const resolvedAccessToken = nextCredentials?.access_token?.trim();
  if (!resolvedAccessToken) {
    return null;
  }

  return fetchCodeAssistQuotaUsage({
    provider: "gemini",
    providerLabel: "Gemini",
    source: "quota_api",
    endpointBaseUrl: "https://cloudcode-pa.googleapis.com",
    accessToken: resolvedAccessToken,
    idToken: nextCredentials?.id_token,
    metadata: {
      ideType: "GEMINI_CLI",
      pluginType: "GEMINI"
    },
    fetchImpl,
    now
  });
}

export async function fetchAntigravitySubscriptionUsage(
  options: GeminiSubscriptionUsageOptions = {}
): Promise<SubscriptionProviderUsageVm | null> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const platform = options.platform ?? process.platform;
  const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
  const credentials = await loadAntigravityCredentials({
    execFileImpl,
    platform,
    keyringReader: options.antigravityKeyringReader,
    fallbackTokenPath: agentStorageRoots.antigravity.oauthTokenPath,
    readTextFile: options.readTextFile ?? defaultReadTextFile,
    now
  });

  const existingAccessToken = credentials?.access_token?.trim();
  if (existingAccessToken && !isCredentialsExpired(credentials, now())) {
    const usage = await fetchAntigravityQuotaSummaryUsage({
      endpointBaseUrl: "https://daily-cloudcode-pa.googleapis.com",
      accessToken: existingAccessToken,
      idToken: credentials?.id_token,
      fetchImpl,
      now,
      platform
    });
    if (usage) {
      return usage;
    }
  }

  if (credentials?.refresh_token) {
    const refreshed = await refreshAntigravityAccessToken({
      oauthCredentialsPath: agentStorageRoots.gemini.oauthCredentialsPath,
      fetchImpl,
      now,
      credentials,
      env: options.env,
      googleOAuthClientConfig: options.googleOAuthClientConfig
    });
    const accessToken = refreshed?.access_token?.trim();
    if (accessToken) {
      const usage = await fetchAntigravityQuotaSummaryUsage({
        endpointBaseUrl: "https://daily-cloudcode-pa.googleapis.com",
        accessToken,
        idToken: refreshed?.id_token,
        fetchImpl,
        now,
        platform
      });
      if (usage) {
        return usage;
      }
    }
  }

  return null;
}

async function fetchAntigravityQuotaSummaryUsage(options: {
  endpointBaseUrl: string;
  accessToken: string;
  idToken?: string;
  fetchImpl: FetchLike;
  now: () => number;
  platform: NodeJS.Platform;
}): Promise<SubscriptionProviderUsageVm | null> {
  const headers = {
    Authorization: `Bearer ${options.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_USER_AGENT,
    [ANTIGRAVITY_CLIENT_METADATA_HEADER]: buildAntigravityClientMetadataHeader(
      options.platform
    )
  };
  const loadCodeAssistResponse = await options.fetchImpl(
    `${options.endpointBaseUrl}/v1internal:loadCodeAssist`,
    withFetchTimeout({
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: {
          ideType: "GEMINI_CLI",
          pluginType: "GEMINI"
        }
      })
    })
  );
  if (!loadCodeAssistResponse.ok) {
    return null;
  }
  const loadCodeAssistPayload =
    (await loadCodeAssistResponse.json()) as CodeAssistLoadPayload;
  const tierId = asTrimmedString(
    loadCodeAssistPayload.currentTier?.id
  )?.toLowerCase();
  const idTokenClaims = decodeJwtPayload(options.idToken);
  const planLabel =
    asTrimmedString(loadCodeAssistPayload.paidTier?.name) ??
    normalizeGeminiPlanLabel(tierId, idTokenClaims.hd) ??
    (!tierId
      ? normalizeCodeAssistAllowedTiersPlanLabel(
          loadCodeAssistPayload.allowedTiers
        )
      : null);
  if (!planLabel) {
    return null;
  }

  const projectId = normalizeGeminiProjectId(
    loadCodeAssistPayload.cloudaicompanionProject
  );
  const quotaResponse = await options.fetchImpl(
    `${options.endpointBaseUrl}/v1internal:retrieveUserQuotaSummary`,
    withFetchTimeout({
      method: "POST",
      headers,
      body: JSON.stringify(projectId ? { project: projectId } : {})
    })
  );
  if (!quotaResponse.ok) {
    return null;
  }
  const quotaPayload =
    (await quotaResponse.json()) as AntigravityQuotaSummaryPayload;
  const rows = normalizeAntigravityQuotaSummaryRows(
    quotaPayload,
    options.now()
  );
  if (rows.length === 0) {
    return null;
  }
  const resolvedPlanLabel = shouldUseAntigravityBusinessPlanLabel(
    loadCodeAssistPayload.allowedTiers,
    rows
  )
    ? "Business"
    : planLabel;

  return {
    provider: "antigravity",
    providerLabel: "Antigravity",
    planLabel: resolvedPlanLabel,
    source: "quota_summary_api",
    updatedAt: new Date(options.now()).toISOString(),
    rows
  };
}

async function fetchCodeAssistQuotaUsage(options: {
  provider: KnownSubscriptionProvider;
  providerLabel: string;
  source: string;
  endpointBaseUrl: string;
  accessToken: string;
  idToken?: string;
  metadata: Record<string, string>;
  fetchImpl: FetchLike;
  now: () => number;
  includeZeroUseRows?: boolean;
  allowAllowedTiersPlanFallback?: boolean;
}): Promise<SubscriptionProviderUsageVm | null> {
  const loadCodeAssistResponse = await options.fetchImpl(
    `${options.endpointBaseUrl}/v1internal:loadCodeAssist`,
    withFetchTimeout({
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        metadata: options.metadata
      })
    })
  );
  if (!loadCodeAssistResponse.ok) {
    return null;
  }
  const loadCodeAssistPayload =
    (await loadCodeAssistResponse.json()) as CodeAssistLoadPayload;
  const tierId = asTrimmedString(
    loadCodeAssistPayload.currentTier?.id
  )?.toLowerCase();
  const idTokenClaims = decodeJwtPayload(options.idToken);
  const currentTierPlanLabel = normalizeGeminiPlanLabel(
    tierId,
    idTokenClaims.hd
  );
  const planLabel =
    currentTierPlanLabel ??
    (!tierId && options.allowAllowedTiersPlanFallback === true
      ? normalizeCodeAssistAllowedTiersPlanLabel(
          loadCodeAssistPayload.allowedTiers
        )
      : null);
  if (!planLabel) {
    return null;
  }
  const projectId = normalizeGeminiProjectId(
    loadCodeAssistPayload.cloudaicompanionProject
  );

  const quotaResponse = await options.fetchImpl(
    `${options.endpointBaseUrl}/v1internal:retrieveUserQuota`,
    withFetchTimeout({
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(projectId ? { project: projectId } : {})
    })
  );
  if (!quotaResponse.ok) {
    return null;
  }
  const quotaPayload = (await quotaResponse.json()) as {
    buckets?: Array<{
      modelId?: string;
      remainingFraction?: number;
      resetTime?: string;
    }>;
  };
  const buckets = (quotaPayload.buckets ?? []).flatMap((bucket) => {
    const modelId = bucket.modelId?.trim();
    const remainingFraction = bucket.remainingFraction;
    if (!modelId || typeof remainingFraction !== "number") {
      return [];
    }
    return [
      {
        modelId,
        remainingFraction,
        resetTime: bucket.resetTime
      }
    ] satisfies GeminiQuotaBucket[];
  });
  const rows = normalizeGeminiQuotaRows(buckets, options.now(), {
    includeZeroUseRows: options.includeZeroUseRows
  });
  if (rows.length === 0) {
    return null;
  }

  return {
    provider: options.provider,
    providerLabel: options.providerLabel,
    planLabel,
    source: options.source,
    updatedAt: new Date(options.now()).toISOString(),
    rows
  };
}

function normalizeCodexUsageFromApi(
  payload: {
    plan_type?: string;
    credits?: {
      unlimited?: boolean;
    };
    rate_limit?: {
      primary_window?: {
        used_percent?: number;
        reset_at?: number;
        limit_window_seconds?: number;
      };
      secondary_window?: {
        used_percent?: number;
        reset_at?: number;
        limit_window_seconds?: number;
      };
    };
  },
  nowMs: number
): SubscriptionProviderUsageVm | null {
  const planLabel = normalizeCodexPlanLabel(payload.plan_type);
  if (!planLabel) {
    return null;
  }
  const windows = [
    normalizeCodexApiWindow(payload.rate_limit?.primary_window),
    normalizeCodexApiWindow(payload.rate_limit?.secondary_window)
  ].filter(
    (
      window
    ): window is {
      usedPercent: number;
      resetsAtMs?: number;
      durationMs: number;
    } => Boolean(window)
  );
  const rows = normalizeCodexWindowRows(windows, nowMs);
  if (rows.length === 0 && payload.credits?.unlimited === true) {
    rows.push(buildUnlimitedCreditsRow());
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    provider: "codex",
    providerLabel: "Codex",
    planLabel,
    source: "oauth",
    updatedAt: new Date(nowMs).toISOString(),
    rows
  };
}

function buildUnlimitedCreditsRow(
  options: {
    key?: string;
    label?: string;
    resetLabel?: string;
  } = {}
): SubscriptionUsageRowVm {
  return {
    key: options.key ?? "credits",
    label: options.label ?? "Credits",
    valueKind: "unlimited",
    resetLabel: options.resetLabel ?? "Unlimited",
    windowKind: "credits"
  };
}

function normalizeCodexUsageFromProbe(
  payload: CodexProbeResult,
  source: "rpc" | "pty",
  nowMs: number
): SubscriptionProviderUsageVm | null {
  const planLabel = normalizeCodexPlanLabel(payload.planType) ?? "Subscription";
  const rows = normalizeCodexWindowRows(
    payload.windows.map((window) => ({
      usedPercent: clampPercent(window.usedPercent),
      resetsAtMs: window.resetsAtMs,
      durationMs:
        window.key === "session" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
    })),
    nowMs
  );
  if (rows.length === 0 && payload.credits?.unlimited === true) {
    rows.push(buildUnlimitedCreditsRow());
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    provider: "codex",
    providerLabel: "Codex",
    planLabel,
    source,
    updatedAt: new Date(nowMs).toISOString(),
    rows
  };
}

function normalizeCodexApiWindow(
  window:
    | {
        used_percent?: number;
        reset_at?: number;
        limit_window_seconds?: number;
      }
    | undefined
): { usedPercent: number; resetsAtMs?: number; durationMs: number } | null {
  const usedPercent = window?.used_percent;
  const durationSeconds = window?.limit_window_seconds;
  if (typeof usedPercent !== "number" || typeof durationSeconds !== "number") {
    return null;
  }
  return {
    usedPercent: clampPercent(usedPercent),
    resetsAtMs:
      typeof window?.reset_at === "number" ? window.reset_at * 1000 : undefined,
    durationMs: durationSeconds * 1000
  };
}

function normalizeCodexWindowRows(
  windows: Array<{
    usedPercent: number;
    resetsAtMs?: number;
    durationMs: number;
  }>,
  nowMs: number
): SubscriptionUsageRowVm[] {
  if (windows.length === 0) {
    return [];
  }
  const sorted = [...windows].sort(
    (left, right) => left.durationMs - right.durationMs
  );
  return sorted.map((window, index) => {
    const isWeeklyOnly =
      sorted.length === 1 && window.durationMs >= 6 * 24 * 60 * 60 * 1000;
    const label = isWeeklyOnly ? "Weekly" : index === 0 ? "Session" : "Weekly";
    return buildRow({
      key: label.toLowerCase(),
      label,
      usedPercent: window.usedPercent,
      resetsAtMs: window.resetsAtMs,
      windowKind: label === "Weekly" ? "weekly" : "session",
      nowMs
    });
  });
}

function normalizeClaudeUsage(options: {
  planLabel: string;
  source: string;
  fiveHourUtilization?: number;
  fiveHourResetAt?: string;
  weeklyUtilization?: number;
  weeklyResetAt?: string;
  extraUsage?: {
    isEnabled?: boolean;
    monthlyLimitCents?: number;
    usedCreditsCents?: number;
    utilizationPercent?: number;
    currency?: string;
    resetsAt?: string;
  };
  nowMs: number;
}): SubscriptionProviderUsageVm | null {
  const rows: SubscriptionUsageRowVm[] = [];
  if (typeof options.fiveHourUtilization === "number") {
    rows.push(
      buildRow({
        key: "session",
        label: "Session",
        usedPercent: options.fiveHourUtilization,
        resetsAtMs: parseDateToMs(options.fiveHourResetAt),
        windowKind: "session",
        nowMs: options.nowMs
      })
    );
  }
  if (typeof options.weeklyUtilization === "number") {
    rows.push(
      buildRow({
        key: "weekly",
        label: "Weekly",
        usedPercent: options.weeklyUtilization,
        resetsAtMs: parseDateToMs(options.weeklyResetAt),
        windowKind: "weekly",
        nowMs: options.nowMs
      })
    );
  }
  const spendRow = buildClaudeSpendRow(options.extraUsage, options.nowMs);
  if (spendRow) {
    rows.push(spendRow);
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    provider: "claude",
    providerLabel: "Claude Code",
    planLabel: options.planLabel,
    source: options.source,
    updatedAt: new Date(options.nowMs).toISOString(),
    rows
  };
}

function buildClaudeSpendRow(
  extraUsage:
    | {
        isEnabled?: boolean;
        monthlyLimitCents?: number;
        usedCreditsCents?: number;
        utilizationPercent?: number;
        currency?: string;
        resetsAt?: string;
      }
    | undefined,
  nowMs: number
): SubscriptionUsageRowVm | null {
  if (!extraUsage?.isEnabled) {
    return null;
  }
  const limitCents = extraUsage.monthlyLimitCents;
  if (typeof limitCents !== "number" || limitCents <= 0) {
    return null;
  }
  const usedCents =
    typeof extraUsage.usedCreditsCents === "number"
      ? Math.max(0, extraUsage.usedCreditsCents)
      : 0;
  const limitUsd = limitCents / 100;
  const usedUsd = usedCents / 100;
  const percent =
    typeof extraUsage.utilizationPercent === "number"
      ? extraUsage.utilizationPercent
      : (usedCents / limitCents) * 100;
  const resetsAtMs =
    parseDateToMs(extraUsage.resetsAt) ?? nextMonthFirstUtcMs(nowMs);
  return buildRow({
    key: "monthly",
    label: "Monthly",
    usedPercent: percent,
    resetsAtMs,
    windowKind: "spend",
    nowMs,
    usedAmountUsd: usedUsd,
    limitAmountUsd: limitUsd,
    currency: extraUsage.currency ?? "USD"
  });
}

function nextMonthFirstUtcMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function normalizeAntigravityQuotaSummaryRows(
  payload: AntigravityQuotaSummaryPayload,
  nowMs: number
): SubscriptionUsageRowVm[] {
  const usedKeys = new Set<string>();
  const rows: SubscriptionUsageRowVm[] = [];

  const addRow = (row: SubscriptionUsageRowVm) => {
    const baseKey = row.key;
    let key = baseKey;
    let duplicate = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey}-${duplicate}`;
      duplicate += 1;
    }
    usedKeys.add(key);
    rows.push(key === row.key ? row : { ...row, key });
  };

  const addBucketRow = (
    groupLabel: string | null | undefined,
    bucket: AntigravityQuotaSummaryBucket,
    fallbackIndex: number
  ) => {
    if (isAntigravityThirdPartyQuota(groupLabel, bucket.bucketId)) {
      return;
    }
    const remainingFraction = bucket.remainingFraction;
    if (
      bucket.disabled === true ||
      typeof remainingFraction !== "number" ||
      !Number.isFinite(remainingFraction) ||
      remainingFraction < 0 ||
      remainingFraction > 1
    ) {
      return;
    }
    const sourceBucketLabel =
      asTrimmedString(bucket.displayName) ??
      humanizeQuotaWindow(bucket.window) ??
      "Quota";
    const displayGroupLabel =
      groupLabel?.trim().toLowerCase() === "gemini models" ? null : groupLabel;
    const windowKind = classifyQuotaSummaryWindow(bucket.window);
    const bucketLabel =
      windowKind === "weekly"
        ? "Weekly"
        : windowKind === "session"
          ? "Session"
          : sourceBucketLabel;
    const label = displayGroupLabel
      ? `${displayGroupLabel} · ${bucketLabel}`
      : bucketLabel;
    addRow(
      buildRow({
        key:
          asTrimmedString(bucket.bucketId) ??
          slugifySubscriptionRowKey(
            `${groupLabel ?? "quota"}-${sourceBucketLabel}`
          ) ??
          `quota-${fallbackIndex}`,
        label,
        usedPercent: (1 - remainingFraction) * 100,
        resetsAtMs: parseDateToMs(bucket.resetTime),
        windowKind,
        nowMs
      })
    );
  };

  for (const group of payload.groups ?? []) {
    const groupLabel = asTrimmedString(group.displayName);
    if (isAntigravityUnlimitedQuotaSummaryGroup(groupLabel, group.buckets)) {
      addRow(buildAntigravityUnlimitedQuotaRow());
      continue;
    }
    const orderedBuckets = [...(group.buckets ?? [])].sort(
      compareQuotaSummaryBuckets
    );
    for (const bucket of orderedBuckets) {
      addBucketRow(groupLabel, bucket, rows.length + 1);
    }
  }
  const orderedBuckets = [...(payload.buckets ?? [])].sort(
    compareQuotaSummaryBuckets
  );
  for (const bucket of orderedBuckets) {
    addBucketRow(undefined, bucket, rows.length + 1);
  }

  return rows;
}

function compareQuotaSummaryBuckets(
  left: AntigravityQuotaSummaryBucket,
  right: AntigravityQuotaSummaryBucket
): number {
  const priority = { session: 0, weekly: 1, model: 2, spend: 2 } as const;
  return (
    priority[classifyQuotaSummaryWindow(left.window)] -
    priority[classifyQuotaSummaryWindow(right.window)]
  );
}

function buildAntigravityUnlimitedQuotaRow(): SubscriptionUsageRowVm {
  return buildUnlimitedCreditsRow({
    key: "all-models",
    label: "All Models",
    resetLabel: "No quota limit reported"
  });
}

function isAntigravityUnlimitedQuotaSummaryGroup(
  groupLabel: string | null | undefined,
  buckets: AntigravityQuotaSummaryBucket[] | undefined
): boolean {
  if (isAntigravityThirdPartyQuota(groupLabel, undefined)) {
    return false;
  }
  const enabledBuckets = (buckets ?? []).filter(
    (bucket) => bucket.disabled !== true
  );
  if (enabledBuckets.length === 0) {
    return false;
  }
  return enabledBuckets.every(
    (bucket) =>
      !isAntigravityThirdPartyQuota(groupLabel, bucket.bucketId) &&
      bucket.remainingFraction === 1 &&
      !asTrimmedString(bucket.window) &&
      !asTrimmedString(bucket.resetTime)
  );
}

function shouldUseAntigravityBusinessPlanLabel(
  allowedTiers: CodeAssistTier[] | undefined,
  rows: SubscriptionUsageRowVm[]
): boolean {
  return (
    isAntigravityBusinessUnlimitedAllowedTier(allowedTiers) &&
    rows.length === 1 &&
    rows[0]?.key === "all-models" &&
    rows[0]?.valueKind === "unlimited" &&
    rows[0]?.resetLabel === "No quota limit reported"
  );
}

function isAntigravityBusinessUnlimitedAllowedTier(
  allowedTiers: CodeAssistTier[] | undefined
): boolean {
  if (!Array.isArray(allowedTiers)) {
    return false;
  }
  return allowedTiers.some((tier) => {
    const name = asTrimmedString(tier?.name)?.toLowerCase();
    const description = asTrimmedString(tier?.description)?.toLowerCase();
    if (name !== "antigravity") {
      return false;
    }
    if (!description) {
      return true;
    }
    return (
      description.includes("unlimited") ||
      description.includes("business") ||
      description.includes("trial")
    );
  });
}

function isAntigravityThirdPartyQuota(
  groupLabel: string | null | undefined,
  bucketId: string | undefined
): boolean {
  const normalizedGroup = groupLabel?.trim().toLowerCase() ?? "";
  const normalizedBucketId = bucketId?.trim().toLowerCase() ?? "";
  return (
    normalizedBucketId.startsWith("3p-") ||
    normalizedGroup.includes("claude") ||
    normalizedGroup.includes("gpt")
  );
}

function classifyQuotaSummaryWindow(
  window: string | undefined
): Exclude<SubscriptionUsageRowVm["windowKind"], "credits"> {
  const normalized = window?.trim().toLowerCase();
  if (normalized === "weekly" || normalized === "week") {
    return "weekly";
  }
  if (
    normalized === "5h" ||
    normalized === "five-hour" ||
    normalized === "five_hour"
  ) {
    return "session";
  }
  return "model";
}

function humanizeQuotaWindow(window: string | undefined): string | null {
  const normalized = window?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "weekly" || normalized === "week") {
    return "Weekly Limit";
  }
  if (
    normalized === "5h" ||
    normalized === "five-hour" ||
    normalized === "five_hour"
  ) {
    return "Five Hour Limit";
  }
  return humanizePlanLabel(normalized);
}

function slugifySubscriptionRowKey(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || null;
}

function normalizeGeminiQuotaRows(
  buckets: GeminiQuotaBucket[],
  nowMs: number,
  options: { includeZeroUseRows?: boolean } = {}
): SubscriptionUsageRowVm[] {
  const groups = new Map<"pro" | "flash" | "flash-lite", GeminiQuotaBucket>();
  for (const bucket of buckets) {
    if (!isReliableGeminiQuotaBucket(bucket)) {
      continue;
    }
    const key = classifyGeminiQuotaKey(bucket.modelId);
    if (!key) {
      continue;
    }
    const existing = groups.get(key);
    if (!existing || bucket.remainingFraction < existing.remainingFraction) {
      groups.set(key, bucket);
    }
  }

  const order: Array<["pro" | "flash" | "flash-lite", string]> = [
    ["pro", "Pro"],
    ["flash", "Flash"],
    ["flash-lite", "Flash Lite"]
  ];
  return order.flatMap(([key, label]) => {
    const bucket = groups.get(key);
    if (!bucket) {
      return [];
    }
    const usedPercent = clampPercent((1 - bucket.remainingFraction) * 100);
    if (usedPercent <= 0 && options.includeZeroUseRows !== true) {
      return [];
    }
    return [
      buildRow({
        key,
        label,
        usedPercent,
        resetsAtMs: parseDateToMs(bucket.resetTime),
        windowKind: "model",
        nowMs
      })
    ];
  });
}

function isReliableGeminiQuotaBucket(bucket: GeminiQuotaBucket): boolean {
  if (!Number.isFinite(bucket.remainingFraction)) {
    return false;
  }
  if (bucket.remainingFraction < 0 || bucket.remainingFraction > 1) {
    return false;
  }
  if (bucket.remainingFraction !== 0) {
    return true;
  }
  const resetTimeMs = parseDateToMs(bucket.resetTime);
  return typeof resetTimeMs === "number" && resetTimeMs > 0;
}

function buildAntigravityClientMetadataHeader(
  platform: NodeJS.Platform
): string {
  const platformValue = resolveAntigravityClientPlatform(platform);
  const fields = [
    encodeProtoVarintField(1, 14),
    ...(platformValue ? [encodeProtoVarintField(4, platformValue)] : []),
    encodeProtoVarintField(7, 2),
    encodeProtoStringField(8, "Antigravity CLI")
  ];
  return Buffer.concat(fields).toString("base64");
}

function resolveAntigravityClientPlatform(
  platform: NodeJS.Platform
): number | null {
  if (platform === "darwin") {
    return process.arch === "arm64" ? 2 : 1;
  }
  if (platform === "linux") {
    return process.arch === "arm64" ? 4 : 3;
  }
  if (platform === "win32" && process.arch === "x64") {
    return 5;
  }
  return null;
}

function encodeProtoVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.from([(fieldNumber << 3) | 0, value]);
}

function encodeProtoStringField(fieldNumber: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([
    Buffer.from([(fieldNumber << 3) | 2, bytes.length]),
    bytes
  ]);
}

async function loadClaudeCredentials(options: {
  credentialsPath: string;
  readTextFile: ReadTextFile;
  execFileImpl: ExecFileLike;
  platform: NodeJS.Platform;
}): Promise<ClaudeCredentialsRecord | null> {
  if (options.platform === "darwin") {
    try {
      const { stdout } = await options.execFileImpl("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w"
      ]);
      const fromKeychain = parseClaudeCredentials(stdout);
      if (fromKeychain) {
        return {
          source: "keychain",
          credentials: fromKeychain
        };
      }
    } catch {
      // Fall back to the credentials file.
    }
  }

  const filePayload = await readJsonFile<{
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      scopes?: string[];
      rateLimitTier?: string;
    };
  }>(options.credentialsPath, options.readTextFile);
  const fromFile = parseClaudeCredentials(filePayload);
  if (!fromFile) {
    return null;
  }
  return {
    source: "file",
    credentials: fromFile
  };
}

function parseClaudeCredentials(input: unknown): ClaudeCredentials | null {
  const payload = typeof input === "string" ? safeJsonParse(input) : input;
  const oauth =
    isRecord(payload) && isRecord(payload.claudeAiOauth)
      ? payload.claudeAiOauth
      : null;
  if (!oauth) {
    return null;
  }
  const accessToken = asTrimmedString(oauth.accessToken);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    expiresAtMs:
      typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.flatMap((scope) =>
          typeof scope === "string" ? [scope] : []
        )
      : [],
    rateLimitTier: asTrimmedString(oauth.rateLimitTier) ?? undefined
  };
}

async function loadAntigravityCredentials(options: {
  execFileImpl: ExecFileLike;
  platform: NodeJS.Platform;
  keyringReader?: AntigravityKeyringReader;
  fallbackTokenPath?: string;
  readTextFile?: ReadTextFile;
  now: () => number;
}): Promise<AntigravityCredentials | null> {
  if (options.platform === "linux") {
    if (await isLinuxDefaultKeyringUnlocked(options.execFileImpl)) {
      try {
        const secret = options.keyringReader
          ? options.keyringReader()
          : readLinuxAntigravityKeyringSecret();
        const credentials =
          typeof secret === "string"
            ? parseAntigravityKeychainSecret(secret)
            : null;
        if (hasUsableAntigravityCredentials(credentials, options.now())) {
          return credentials;
        }
      } catch {
        // Fall back to the AGY-owned token file.
      }
    }
    return options.fallbackTokenPath && options.readTextFile
      ? readAntigravityTokenFile(
          options.fallbackTokenPath,
          options.readTextFile
        )
      : null;
  }
  if (options.platform !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await options.execFileImpl("security", [
      "find-generic-password",
      "-s",
      "gemini",
      "-a",
      "antigravity",
      "-w"
    ]);
    return parseAntigravityKeychainSecret(stdout);
  } catch {
    return null;
  }
}

function hasUsableAntigravityCredentials(
  credentials: AntigravityCredentials | null,
  nowMs: number
): credentials is AntigravityCredentials {
  const accessToken = credentials?.access_token?.trim();
  const refreshToken = credentials?.refresh_token?.trim();
  return Boolean(
    refreshToken || (accessToken && !isCredentialsExpired(credentials, nowMs))
  );
}

async function readAntigravityTokenFile(
  tokenPath: string,
  readTextFile: ReadTextFile
): Promise<AntigravityCredentials | null> {
  const raw = await defaultReadJsonText(tokenPath, readTextFile);
  return raw ? parseAntigravityCredentialsPayload(raw) : null;
}

async function isLinuxDefaultKeyringUnlocked(
  execFileImpl: ExecFileLike
): Promise<boolean> {
  try {
    const { stdout } = await execFileImpl("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.secrets",
      "--object-path",
      "/org/freedesktop/secrets/aliases/default",
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      "org.freedesktop.Secret.Collection",
      "Locked"
    ]);
    return /<false>/u.test(stdout);
  } catch {
    return false;
  }
}

function readLinuxAntigravityKeyringSecret(): string | null {
  const keyringPackage = resolveLinuxKeyringPackage();
  if (!keyringPackage) {
    return null;
  }
  try {
    const keyring = requireForMeta(keyringPackage) as {
      Entry?: new (
        service: string,
        account: string
      ) => { getPassword(): string | null | undefined };
    };
    if (typeof keyring.Entry !== "function") {
      return null;
    }
    const secret = new keyring.Entry("gemini", "antigravity").getPassword();
    return typeof secret === "string" && secret.trim() ? secret : null;
  } catch {
    return null;
  }
}

function resolveLinuxKeyringPackage(): string | null {
  switch (process.arch) {
    case "arm64":
      return "@napi-rs/keyring-linux-arm64-gnu";
    case "x64":
      return "@napi-rs/keyring-linux-x64-gnu";
    default:
      return null;
  }
}

function parseAntigravityKeychainSecret(
  value: string
): AntigravityCredentials | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const decodedPayload = decodeAntigravityKeyringPayload(trimmed);
  const parsedCredentials = parseAntigravityCredentialsPayload(
    decodedPayload ?? trimmed
  );
  if (parsedCredentials) {
    return parsedCredentials;
  }
  const separatorIndex = trimmed.indexOf(":");
  const refreshToken =
    separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
  return refreshToken ? { refresh_token: refreshToken } : null;
}

function decodeAntigravityKeyringPayload(value: string): string | null {
  const prefix = "go-keyring-base64:";
  if (!value.startsWith(prefix)) {
    return null;
  }
  const encoded = value.slice(prefix.length).trim();
  if (!encoded) {
    return null;
  }
  try {
    return Buffer.from(normalizeBase64(encoded), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function normalizeBase64(value: string): string {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
}

function parseAntigravityCredentialsPayload(
  input: unknown
): AntigravityCredentials | null {
  const payload = typeof input === "string" ? safeJsonParse(input) : input;
  if (!isRecord(payload)) {
    return null;
  }
  const token = isRecord(payload.token) ? payload.token : payload;
  const accessToken = asTrimmedString(token.access_token);
  const refreshToken = asTrimmedString(token.refresh_token);
  if (!accessToken && !refreshToken) {
    return null;
  }
  const expiryDate =
    typeof token.expiry_date === "number"
      ? token.expiry_date
      : parseDateToMs(asTrimmedString(token.expiry) ?? undefined);
  return {
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(asTrimmedString(token.id_token)
      ? { id_token: asTrimmedString(token.id_token) ?? undefined }
      : {}),
    ...(typeof expiryDate === "number" ? { expiry_date: expiryDate } : {}),
    ...(asTrimmedString(token.token_type)
      ? { token_type: asTrimmedString(token.token_type) ?? undefined }
      : {}),
    ...(asTrimmedString(token.scope)
      ? { scope: asTrimmedString(token.scope) ?? undefined }
      : {}),
    ...(asTrimmedString(payload.auth_method)
      ? { auth_method: asTrimmedString(payload.auth_method) ?? undefined }
      : {})
  };
}

function isCredentialsExpired(
  credentials: { expiry_date?: number } | null | undefined,
  nowMs: number
): boolean {
  return (
    typeof credentials?.expiry_date === "number" &&
    nowMs >= credentials.expiry_date
  );
}

async function readGeminiSettings(
  settingsPath: string,
  readTextFile: ReadTextFile
): Promise<{ selectedType?: string }> {
  const raw = await defaultReadJsonText(settingsPath, readTextFile);
  if (!raw) {
    return {};
  }
  const parsed = safeJsonParse(stripJsonComments(raw));
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.security) ||
    !isRecord(parsed.security.auth)
  ) {
    return {};
  }
  return {
    selectedType:
      asTrimmedString(parsed.security.auth.selectedType) ?? undefined
  };
}

function normalizeCodexPlanLabel(
  planType: string | null | undefined
): string | null {
  const normalized = planType?.trim().toLowerCase();
  if (!normalized || ["guest", "free", "free_workspace"].includes(normalized)) {
    return null;
  }
  return humanizePlanLabel(normalized);
}

function normalizeClaudePlanLabel(
  rateLimitTier: string | null | undefined,
  hints: { hasActiveSpendCap?: boolean } = {}
): string {
  const normalized = rateLimitTier?.trim().toLowerCase() ?? "";
  if (normalized.includes("max")) {
    return "Max";
  }
  if (normalized.includes("pro")) {
    return "Pro";
  }
  if (normalized.includes("team")) {
    return "Team";
  }
  if (normalized.includes("enterprise")) {
    return "Enterprise";
  }
  if (normalized.includes("ultra")) {
    return "Ultra";
  }
  if (hints.hasActiveSpendCap) {
    return "Enterprise";
  }
  return "Subscription";
}

function normalizeGeminiPlanLabel(
  tierId: string | undefined,
  hostedDomain: string | undefined
): string | null {
  if (tierId === "standard-tier") {
    return "Paid";
  }
  if (tierId === "free-tier" && hostedDomain) {
    return "Workspace";
  }
  return null;
}

function normalizeCodeAssistAllowedTiersPlanLabel(
  allowedTiers: CodeAssistTier[] | undefined
): string | null {
  if (!Array.isArray(allowedTiers)) {
    return null;
  }
  for (const tier of allowedTiers) {
    const name = asTrimmedString(tier?.name);
    if (name) {
      return name;
    }
  }
  const tierIds = allowedTiers.flatMap((tier) => {
    const tierId = asTrimmedString(tier?.id)?.toLowerCase();
    return tierId ? [tierId] : [];
  });
  if (
    tierIds.length > 0 &&
    tierIds.every((tierId) => tierId === "standard-tier")
  ) {
    return "Paid";
  }
  return null;
}

function humanizePlanLabel(value: string): string {
  return value
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function classifyGeminiQuotaKey(
  modelId: string
): "pro" | "flash" | "flash-lite" | null {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes("flash-lite")) {
    return "flash-lite";
  }
  if (normalized.includes("flash")) {
    return "flash";
  }
  if (normalized.includes("pro")) {
    return "pro";
  }
  return null;
}

function buildRow(options: {
  key: string;
  label: string;
  usedPercent: number;
  resetsAtMs?: number;
  windowKind: Exclude<SubscriptionUsageRowVm["windowKind"], "credits">;
  nowMs: number;
  usedAmountUsd?: number;
  limitAmountUsd?: number;
  currency?: string;
}): SubscriptionUsageRowVm {
  return {
    key: options.key,
    label: options.label,
    valueKind: "percent",
    usedPercent: clampPercent(options.usedPercent),
    resetLabel: formatResetLabel(options.resetsAtMs, options.nowMs),
    resetsAt: options.resetsAtMs
      ? new Date(options.resetsAtMs).toISOString()
      : undefined,
    windowKind: options.windowKind,
    ...(typeof options.usedAmountUsd === "number"
      ? { usedAmountUsd: options.usedAmountUsd }
      : {}),
    ...(typeof options.limitAmountUsd === "number"
      ? { limitAmountUsd: options.limitAmountUsd }
      : {}),
    ...(options.currency ? { currency: options.currency } : {})
  };
}

export function formatResetLabel(
  resetsAtMs: number | undefined,
  nowMs: number,
  fallbackLabel = "Reset time unavailable"
): string {
  if (!resetsAtMs || !Number.isFinite(resetsAtMs)) {
    return fallbackLabel;
  }
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  if (remainingMs <= 30_000) {
    return "Resets soon";
  }
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `Resets in ${days}d ${Math.max(1, hours)}h`;
  }
  if (hours > 0) {
    return `Resets in ${hours}h ${minutes}m`;
  }
  return `Resets in ${minutes}m`;
}

async function probeCodexViaRpc(
  env: NodeJS.ProcessEnv | undefined,
  appVersion: string
): Promise<CodexProbeResult | null> {
  const child = spawn(
    "codex",
    ["-s", "read-only", "-a", "untrusted", "app-server"],
    {
      env: {
        ...process.env,
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const rl = createInterface({
    input: child.stdout
  });
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let nextId = 1;

  const waitForResponse = (
    method: string,
    params: Record<string, unknown> = {}
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({
          id,
          method,
          params
        })}\n`
      );
    });

  const closeWithError = (message: string) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  rl.on("line", (line) => {
    let payload: {
      id?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(line) as typeof payload;
    } catch {
      return;
    }
    if (typeof payload.id !== "number") {
      return;
    }
    const resolver = pending.get(payload.id);
    if (!resolver) {
      return;
    }
    pending.delete(payload.id);
    if (payload.error?.message) {
      resolver.reject(new Error(payload.error.message));
      return;
    }
    resolver.resolve(payload.result);
  });

  child.once("error", (error) => closeWithError(error.message));
  child.once("exit", () => closeWithError("codex app-server exited"));

  try {
    return await withTimeout(async () => {
      await waitForResponse("initialize", {
        clientInfo: {
          name: "kmux",
          version: appVersion
        }
      });
      child.stdin.write(
        `${JSON.stringify({ method: "initialized", params: {} })}\n`
      );
      const account = (await waitForResponse("account/read")) as {
        account?: { type?: string; planType?: string };
      };
      const limits = (await waitForResponse("account/rateLimits/read")) as {
        rateLimits?: {
          primary?: {
            usedPercent?: number;
            windowDurationMins?: number;
            resetsAt?: number;
          };
          secondary?: {
            usedPercent?: number;
            windowDurationMins?: number;
            resetsAt?: number;
          };
          credits?: {
            unlimited?: boolean;
          };
        };
      };
      return {
        planType:
          account?.account?.type === "chatgpt"
            ? (account.account.planType ?? null)
            : null,
        credits:
          typeof limits?.rateLimits?.credits?.unlimited === "boolean"
            ? { unlimited: limits.rateLimits.credits.unlimited }
            : undefined,
        windows: [
          normalizeCodexRpcWindow("session", limits?.rateLimits?.primary),
          normalizeCodexRpcWindow("weekly", limits?.rateLimits?.secondary)
        ].filter((window): window is CodexProbeWindow => Boolean(window))
      };
    }, SUBSCRIPTION_PROBE_TIMEOUT_MS);
  } finally {
    rl.close();
    child.kill();
  }
}

function resolveDesktopAppVersion(): string {
  try {
    const packageJson = requireForMeta("../../package.json") as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function normalizeCodexRpcWindow(
  fallbackKey: "session" | "weekly",
  window:
    | {
        usedPercent?: number;
        windowDurationMins?: number;
        resetsAt?: number;
      }
    | undefined
): CodexProbeWindow | null {
  if (!window || typeof window.usedPercent !== "number") {
    return null;
  }
  const key =
    typeof window.windowDurationMins === "number" &&
    window.windowDurationMins >= 24 * 60
      ? "weekly"
      : fallbackKey;
  return {
    key,
    usedPercent: clampPercent(window.usedPercent),
    resetsAtMs:
      typeof window.resetsAt === "number" ? window.resetsAt * 1000 : undefined
  };
}

async function probeCodexViaStatus(
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform
): Promise<CodexProbeResult | null> {
  const scriptArgs = resolveCodexStatusScriptArgs(platform);
  if (!scriptArgs) {
    return null;
  }
  const output = await captureCommandOutput(
    "script",
    scriptArgs,
    "/status\n",
    env
  );
  const clean = stripAnsiCodes(output);
  const windows = [
    parseCodexStatusWindow(clean, /5h limit[^\n]*/iu, "session"),
    parseCodexStatusWindow(clean, /Weekly limit[^\n]*/iu, "weekly")
  ].filter((window): window is CodexProbeWindow => Boolean(window));
  if (windows.length === 0) {
    return null;
  }
  return {
    planType: null,
    windows
  };
}

export function resolveCodexStatusScriptArgs(
  platform: NodeJS.Platform
): string[] | null {
  if (platform === "darwin") {
    return ["-q", "/dev/null", "codex", "-s", "read-only", "-a", "untrusted"];
  }
  if (platform === "linux") {
    return ["-q", "-c", "codex -s read-only -a untrusted", "/dev/null"];
  }
  return null;
}

function parseCodexStatusWindow(
  text: string,
  linePattern: RegExp,
  key: "session" | "weekly"
): CodexProbeWindow | null {
  const line = text.match(linePattern)?.[0];
  if (!line) {
    return null;
  }
  const percentLeft = line.match(/(\d+(?:\.\d+)?)%\s*left/iu);
  if (!percentLeft) {
    return null;
  }
  const usedPercent = 100 - Number(percentLeft[1]);
  return {
    key,
    usedPercent: clampPercent(usedPercent)
  };
}

async function captureCommandOutput(
  command: string,
  args: string[],
  input: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, SUBSCRIPTION_PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code && code !== 0 && stdout.length === 0) {
        reject(new Error(stderr || `${command} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(input);
  });
}

function decodeJwtPayload(token: unknown): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) {
    return {};
  }
  const parts = value.split(".");
  if (parts.length < 2) {
    return {};
  }
  const payload = parts[1]?.replace(/-/gu, "+").replace(/_/gu, "/");
  if (!payload) {
    return {};
  }
  const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, entryValue]) =>
        typeof entryValue === "string" ? [[key, entryValue]] : []
      )
    );
  } catch {
    return {};
  }
}

function normalizeGeminiProjectId(
  value: string | { id?: string; projectId?: string } | undefined
): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (isRecord(value)) {
    return (
      asTrimmedString(value.id) ?? asTrimmedString(value.projectId) ?? undefined
    );
  }
  return undefined;
}

async function refreshGeminiAccessToken(options: {
  oauthCredentialsPath: string;
  fetchImpl: FetchLike;
  now: () => number;
  credentials: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expiry_date?: number;
    token_type?: string;
    scope?: string;
  } | null;
  env?: NodeJS.ProcessEnv;
  googleOAuthClientConfig?: {
    clientId: string;
    clientSecret?: string;
  };
  persist?: boolean;
}): Promise<{
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
} | null> {
  const refreshToken = options.credentials?.refresh_token?.trim();
  if (!refreshToken) {
    return null;
  }
  const clientConfig =
    options.googleOAuthClientConfig ??
    resolveGeminiOAuthClientConfig(options.env);
  if (!clientConfig) {
    return null;
  }
  const body = new URLSearchParams({
    client_id: clientConfig.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  if (clientConfig.clientSecret) {
    body.set("client_secret", clientConfig.clientSecret);
  }
  const response = await options.fetchImpl(
    "https://oauth2.googleapis.com/token",
    withFetchTimeout({
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "User-Agent": "google-api-nodejs-client/9.15.1"
      },
      body
    })
  );
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  const nextAccessToken = payload.access_token?.trim();
  if (!nextAccessToken) {
    return null;
  }
  const expiryDate =
    typeof payload.expires_in === "number"
      ? options.now() + payload.expires_in * 1000 - 5 * 60 * 1000
      : undefined;
  const nextCredentials = {
    ...(options.credentials ?? {}),
    access_token: nextAccessToken,
    refresh_token: payload.refresh_token?.trim() || refreshToken,
    ...(payload.id_token ? { id_token: payload.id_token } : {}),
    ...(typeof expiryDate === "number" ? { expiry_date: expiryDate } : {}),
    ...(payload.token_type ? { token_type: payload.token_type } : {}),
    ...(payload.scope ? { scope: payload.scope } : {})
  };
  if (options.persist !== false) {
    try {
      await writeFile(
        options.oauthCredentialsPath,
        `${JSON.stringify(nextCredentials, null, 2)}\n`,
        "utf8"
      );
    } catch {
      // Ignore persistence failures and continue with in-memory credentials.
    }
  }
  return nextCredentials;
}

async function refreshAntigravityAccessToken(options: {
  oauthCredentialsPath: string;
  fetchImpl: FetchLike;
  now: () => number;
  credentials: AntigravityCredentials | null;
  env?: NodeJS.ProcessEnv;
  googleOAuthClientConfig?: {
    clientId: string;
    clientSecret?: string;
  };
}): Promise<AntigravityCredentials | null> {
  const clientConfigs = options.googleOAuthClientConfig
    ? [options.googleOAuthClientConfig]
    : resolveAntigravityOAuthClientConfigs(options.env);
  for (const clientConfig of clientConfigs) {
    const refreshed = await refreshGeminiAccessToken({
      oauthCredentialsPath: options.oauthCredentialsPath,
      fetchImpl: options.fetchImpl,
      now: options.now,
      credentials: options.credentials,
      env: options.env,
      googleOAuthClientConfig: clientConfig,
      persist: false
    });
    if (refreshed?.access_token?.trim()) {
      return refreshed;
    }
  }
  return null;
}

function resolveGeminiOAuthClientConfig(
  env?: NodeJS.ProcessEnv
): { clientId: string; clientSecret?: string } | null {
  const envClientId = resolveFirstEnvValue(
    GEMINI_OAUTH_CLIENT_ID_ENV_KEYS,
    env
  );
  const envClientSecret = resolveFirstEnvValue(
    GEMINI_OAUTH_CLIENT_SECRET_ENV_KEYS,
    env
  );
  if (envClientId) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret
    };
  }
  return extractGeminiCliOAuthClientConfig(env);
}

function resolveAntigravityOAuthClientConfigs(
  env?: NodeJS.ProcessEnv
): Array<{ clientId: string; clientSecret?: string }> {
  const envClientId = resolveFirstEnvValue(
    ANTIGRAVITY_OAUTH_CLIENT_ID_ENV_KEYS,
    env
  );
  const envClientSecret = resolveFirstEnvValue(
    ANTIGRAVITY_OAUTH_CLIENT_SECRET_ENV_KEYS,
    env
  );
  if (envClientId) {
    return [
      {
        clientId: envClientId,
        clientSecret: envClientSecret
      }
    ];
  }
  return extractAntigravityOAuthClientConfigs(env);
}

function extractAntigravityOAuthClientConfigs(
  env?: NodeJS.ProcessEnv
): Array<{ clientId: string; clientSecret?: string }> {
  const agyPath = findBinaryInPath("agy", env);
  if (!agyPath) {
    return [];
  }
  const resolvedPath = safeRealpathSync(agyPath) ?? agyPath;
  try {
    const content = readFileSync(resolvedPath, "latin1");
    const clientIds = Array.from(
      new Set(
        Array.from(
          content.matchAll(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/giu)
        ).map((match) => match[1])
      )
    );
    if (clientIds.length === 0) {
      return [];
    }
    const clientSecrets = extractGoogleOAuthClientSecrets(content);
    if (clientSecrets.length === 0) {
      return clientIds.map((clientId) => ({ clientId }));
    }
    return clientIds.flatMap((clientId) =>
      clientSecrets.map((clientSecret) => ({
        clientId,
        clientSecret
      }))
    );
  } catch {
    return [];
  }
}

function extractGoogleOAuthClientSecrets(content: string): string[] {
  const secrets = new Set<string>();
  for (
    let index = content.indexOf("GOCSPX-");
    index >= 0;
    index = content.indexOf("GOCSPX-", index + 1)
  ) {
    const candidate = content.slice(
      index,
      index + GOOGLE_OAUTH_CLIENT_SECRET_LENGTH
    );
    if (/^GOCSPX-[A-Za-z0-9_-]{28}$/u.test(candidate)) {
      secrets.add(candidate);
    }
  }
  return Array.from(secrets);
}

function extractGeminiCliOAuthClientConfig(
  env?: NodeJS.ProcessEnv
): { clientId: string; clientSecret?: string } | null {
  const geminiPath = findBinaryInPath("gemini", env);
  if (!geminiPath) {
    return null;
  }
  const resolvedPath = safeRealpathSync(geminiPath) ?? geminiPath;
  const searchDirs = Array.from(
    new Set([
      dirname(dirname(resolvedPath)),
      join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
      join(
        dirname(dirname(resolvedPath)),
        "node_modules",
        "@google",
        "gemini-cli"
      ),
      join(
        dirname(dirname(dirname(resolvedPath))),
        "lib",
        "node_modules",
        "@google",
        "gemini-cli"
      )
    ])
  );
  for (const searchDir of searchDirs) {
    const fromKnownPaths =
      readGeminiCliOAuthClientConfigFromKnownPaths(searchDir);
    if (fromKnownPaths) {
      return fromKnownPaths;
    }
    const fromBundle = readGeminiCliOAuthClientConfigFromBundle(searchDir);
    if (fromBundle) {
      return fromBundle;
    }
  }
  return null;
}

function readGeminiCliOAuthClientConfigFromKnownPaths(
  geminiCliDir: string
): { clientId: string; clientSecret?: string } | null {
  const searchPaths = [
    join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js"
    ),
    join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "code_assist",
      "oauth2.js"
    )
  ];
  for (const filePath of searchPaths) {
    const credentials = readGeminiCliOAuthClientConfigFile(filePath);
    if (credentials) {
      return credentials;
    }
  }
  return null;
}

function readGeminiCliOAuthClientConfigFromBundle(
  geminiCliDir: string
): { clientId: string; clientSecret?: string } | null {
  const bundleDir = join(geminiCliDir, "bundle");
  if (!existsSync(bundleDir)) {
    return null;
  }
  try {
    for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) {
        continue;
      }
      const credentials = readGeminiCliOAuthClientConfigFile(
        join(bundleDir, entry.name)
      );
      if (credentials) {
        return credentials;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readGeminiCliOAuthClientConfigFile(
  filePath: string
): { clientId: string; clientSecret?: string } | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const clientId =
      content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/u)?.[1] ??
      content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/iu)?.[1];
    const clientSecret =
      content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/u)?.[1] ??
      content.match(/(GOCSPX-[A-Za-z0-9_-]+)/u)?.[1];
    if (!clientId || !clientSecret) {
      return null;
    }
    return {
      clientId,
      clientSecret
    };
  } catch {
    return null;
  }
}

function findBinaryInPath(
  name: string,
  env?: NodeJS.ProcessEnv
): string | null {
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function safeRealpathSync(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function resolveFirstEnvValue(
  keys: readonly string[],
  env?: NodeJS.ProcessEnv
): string | undefined {
  for (const key of keys) {
    const value = env?.[key]?.trim() ?? process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function compactHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      value ? [[key, value]] : []
    )
  );
}

async function readJsonFile<T>(
  filePath: string,
  readTextFile: ReadTextFile
): Promise<T | null> {
  const raw = await defaultReadJsonText(filePath, readTextFile);
  if (!raw) {
    return null;
  }
  return safeJsonParse(raw) as T | null;
}

async function defaultReadJsonText(
  filePath: string,
  readTextFile: ReadTextFile
): Promise<string | null> {
  try {
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

async function defaultReadTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function defaultExecFile(
  file: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    timeout: SUBSCRIPTION_EXEC_TIMEOUT_MS
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function withFetchTimeout(init: RequestInit): RequestInit {
  return {
    ...init,
    signal: init.signal ?? createTimeoutSignal(SUBSCRIPTION_FETCH_TIMEOUT_MS)
  };
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  const abortSignal = globalThis.AbortSignal;
  if (!abortSignal || typeof abortSignal.timeout !== "function") {
    return undefined;
  }
  return abortSignal.timeout(timeoutMs);
}

async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void run().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }

  return result;
}

function parseDateToMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripAnsiCodes(value: string): string {
  const ansiEscape = String.fromCharCode(27);
  return value.replace(new RegExp(`${ansiEscape}\\[[0-9;]*[A-Za-z]`, "gu"), "");
}

function resolveSubscriptionAgentStorageRoots(options: {
  agentStorageRoots?: AgentStorageRoots;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): AgentStorageRoots {
  return (
    options.agentStorageRoots ??
    resolveAgentStorageRoots({
      homeDir: options.homeDir,
      env: options.env
    })
  );
}
