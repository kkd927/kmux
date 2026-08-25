import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm
} from "@kmux/proto";
import type { AgentStorageRoots } from "@kmux/metadata";

import {
  asTrimmedString,
  buildSubscriptionRow,
  defaultExecFile,
  defaultReadJsonText,
  defaultReadTextFile,
  humanizePlanLabel,
  isRecord,
  parseDateToMs,
  resolveSubscriptionAgentStorageRoots,
  safeJsonParse,
  withFetchTimeout,
  type ExecFileLike,
  type FetchLike,
  type ReadTextFile,
  type SubscriptionRuntimeBaseOptions
} from "../subscriptionShared";

const requireForMeta = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json")
);

type AntigravityKeyringReader = () => string | null | undefined;

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
export interface AntigravitySubscriptionUsageOptions extends SubscriptionRuntimeBaseOptions {
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

const ANTIGRAVITY_OAUTH_CLIENT_ID_ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_CLIENT_ID",
  "AGY_OAUTH_CLIENT_ID"
] as const;
const ANTIGRAVITY_OAUTH_CLIENT_SECRET_ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
  "AGY_OAUTH_CLIENT_SECRET"
] as const;
const GOOGLE_OAUTH_CLIENT_SECRET_LENGTH = 35;
const ANTIGRAVITY_USER_AGENT = "antigravity";
const ANTIGRAVITY_CLIENT_METADATA_HEADER = "X-Goog-Ext-525006001-bin";
export async function detectAntigravitySubscriptionAuth(
  options: AntigravitySubscriptionUsageOptions = {}
): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const credentials = await loadAntigravityCredentials({
    execFileImpl: options.execFileImpl ?? defaultExecFile,
    platform: options.platform ?? process.platform,
    keyringReader: options.antigravityKeyringReader,
    fallbackTokenPath:
      resolveSubscriptionAgentStorageRoots(options).antigravity.oauthTokenPath,
    readTextFile: defaultReadTextFile,
    now
  });
  const accessToken = credentials?.access_token?.trim();
  if (accessToken && !isCredentialsExpired(credentials, now())) return true;
  return Boolean(credentials?.refresh_token?.trim());
}

export async function fetchAntigravitySubscriptionUsage(
  options: AntigravitySubscriptionUsageOptions = {}
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
    normalizeCodeAssistPlanLabel(tierId, idTokenClaims.hd) ??
    (!tierId
      ? normalizeCodeAssistAllowedTiersPlanLabel(
          loadCodeAssistPayload.allowedTiers
        )
      : null);
  if (!planLabel) {
    return null;
  }

  const projectId = normalizeCodeAssistProjectId(
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
      buildSubscriptionRow({
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
  return {
    key: "all-models",
    label: "All Models",
    valueKind: "unlimited",
    resetLabel: "No quota limit reported",
    windowKind: "credits"
  };
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

function normalizeCodeAssistPlanLabel(
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

function normalizeCodeAssistProjectId(
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

async function refreshGoogleCodeAssistAccessToken(options: {
  oauthCredentialsPath?: string;
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
    resolveFirstGoogleOAuthClientConfig(options.env);
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
  if (options.persist !== false && options.oauthCredentialsPath) {
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
    const refreshed = await refreshGoogleCodeAssistAccessToken({
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

function resolveFirstGoogleOAuthClientConfig(
  env?: NodeJS.ProcessEnv
): { clientId: string; clientSecret?: string } | null {
  return resolveAntigravityOAuthClientConfigs(env)[0] ?? null;
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
