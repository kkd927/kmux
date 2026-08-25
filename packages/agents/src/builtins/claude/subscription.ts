import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm
} from "@kmux/proto";
import type { AgentStorageRoots } from "@kmux/metadata";

import {
  asTrimmedString,
  buildSubscriptionRow,
  compactHeaders,
  defaultExecFile,
  defaultReadTextFile,
  isRecord,
  parseDateToMs,
  readJsonFile,
  resolveSubscriptionAgentStorageRoots,
  safeJsonParse,
  withFetchTimeout,
  type ExecFileLike,
  type FetchLike,
  type ReadTextFile,
  type SubscriptionRuntimeBaseOptions
} from "../subscriptionShared";

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
export interface ClaudeSubscriptionUsageOptions extends SubscriptionRuntimeBaseOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  fetchImpl?: FetchLike;
  readTextFile?: ReadTextFile;
  execFileImpl?: ExecFileLike;
}

export async function detectClaudeSubscriptionAuth(
  options: ClaudeSubscriptionUsageOptions = {}
): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const credentials = await loadClaudeCredentials({
    credentialsPath:
      resolveSubscriptionAgentStorageRoots(options).claude.credentialsPath,
    readTextFile: defaultReadTextFile,
    execFileImpl: options.execFileImpl ?? defaultExecFile,
    platform: options.platform ?? process.platform
  });
  if (!credentials?.credentials.accessToken) return false;
  const { expiresAtMs } = credentials.credentials;
  return !expiresAtMs || now() < expiresAtMs;
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
      buildSubscriptionRow({
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
      buildSubscriptionRow({
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
  return buildSubscriptionRow({
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
