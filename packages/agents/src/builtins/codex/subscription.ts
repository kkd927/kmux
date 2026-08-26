import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm
} from "@kmux/proto";
import type { AgentStorageRoots } from "@kmux/metadata";

import {
  SUBSCRIPTION_PROBE_TIMEOUT_MS,
  buildSubscriptionRow,
  clampPercent,
  compactHeaders,
  defaultReadTextFile,
  humanizePlanLabel,
  readJsonFile,
  resolveSubscriptionAgentStorageRoots,
  stripAnsiCodes,
  withFetchTimeout,
  withTimeout,
  type FetchLike,
  type ReadTextFile,
  type SubscriptionRuntimeBaseOptions
} from "../subscriptionShared";

type CodexProbeWindow = {
  key: "session" | "weekly";
  usedPercent: number;
  resetsAtMs?: number;
};

type CodexIndividualLimit = {
  limit?: string;
  used?: string;
  used_percent?: number;
  remaining_percent?: number;
  reset_at?: number;
};

type CodexProbeResult = {
  planType?: string | null;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
  };
  individualLimit?: CodexIndividualLimit;
  windows: CodexProbeWindow[];
};
export interface CodexSubscriptionUsageOptions extends SubscriptionRuntimeBaseOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  appVersion?: string;
  fetchImpl?: FetchLike;
  readTextFile?: ReadTextFile;
  codexRpcProbe?: (appVersion: string) => Promise<CodexProbeResult | null>;
  codexStatusProbe?: () => Promise<CodexProbeResult | null>;
}

class CodexSubscriptionProbeError extends Error {
  constructor() {
    super("Codex subscription probes exhausted");
    this.name = "CodexSubscriptionProbeError";
  }
}

export async function detectCodexSubscriptionAuth(
  options: CodexSubscriptionUsageOptions = {}
): Promise<boolean> {
  const agentStorageRoots = resolveSubscriptionAgentStorageRoots(options);
  const auth = await readJsonFile<{
    tokens?: { access_token?: string };
  }>(agentStorageRoots.codex.authPath, defaultReadTextFile);
  return Boolean(auth?.tokens?.access_token?.trim());
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
          has_credits?: boolean;
          unlimited?: boolean;
        };
        spend_control?: {
          individual_limit?: CodexIndividualLimit | null;
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

  const appVersion = normalizeAppVersion(options.appVersion);
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

function normalizeAppVersion(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= 128 ? normalized : "0.0.0";
}

function normalizeCodexUsageFromApi(
  payload: {
    plan_type?: string;
    credits?: {
      has_credits?: boolean;
      unlimited?: boolean;
    };
    spend_control?: {
      individual_limit?: CodexIndividualLimit | null;
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
  const creditsRow = buildCodexCreditsRow(
    {
      hasCredits: payload.credits?.has_credits,
      unlimited: payload.credits?.unlimited
    },
    payload.spend_control?.individual_limit ?? undefined,
    nowMs
  );
  if (creditsRow) {
    rows.push(creditsRow);
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    provider: "codex",
    providerLabel: "Codex",
    planLabel,
    accentTone: "blue",
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

/**
 * Credit-backed plans (Codex Business) report no rate-limit windows. They expose
 * a credit pool through the spend control instead, so `hasCredits` — not the
 * spend control itself — is what decides the row is denominated in credits.
 * Metered and unlimited pools render identically apart from the reset line, so
 * both keep the same `Credits` label and both report alongside any window rows.
 */
function buildCodexCreditsRow(
  credits: { hasCredits?: boolean; unlimited?: boolean } | undefined,
  individualLimit: CodexIndividualLimit | undefined,
  nowMs: number
): SubscriptionUsageRowVm | null {
  if (credits?.unlimited === true) {
    return buildUnlimitedCreditsRow();
  }
  if (credits?.hasCredits !== true || !individualLimit) {
    return null;
  }
  const usedPercent = resolveCodexCreditsUsedPercent(individualLimit);
  if (usedPercent === null) {
    return null;
  }
  return buildSubscriptionRow({
    key: "credits",
    label: "Credits",
    usedPercent,
    resetsAtMs:
      typeof individualLimit.reset_at === "number"
        ? individualLimit.reset_at * 1000
        : undefined,
    windowKind: "credits",
    nowMs
  });
}

function resolveCodexCreditsUsedPercent(
  individualLimit: CodexIndividualLimit
): number | null {
  // `limit` and `used` arrive as strings. Prefer deriving the ratio from them:
  // the percent fields are absent on some payloads and pre-rounded on others.
  const limit = Number.parseFloat(individualLimit.limit ?? "");
  const used = Number.parseFloat(individualLimit.used ?? "");
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
    return (used / limit) * 100;
  }
  if (typeof individualLimit.used_percent === "number") {
    return individualLimit.used_percent;
  }
  if (typeof individualLimit.remaining_percent === "number") {
    return 100 - individualLimit.remaining_percent;
  }
  return null;
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
  const creditsRow = buildCodexCreditsRow(
    payload.credits,
    payload.individualLimit,
    nowMs
  );
  if (creditsRow) {
    rows.push(creditsRow);
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    provider: "codex",
    providerLabel: "Codex",
    planLabel,
    accentTone: "blue",
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
    return buildSubscriptionRow({
      key: label.toLowerCase(),
      label,
      usedPercent: window.usedPercent,
      resetsAtMs: window.resetsAtMs,
      windowKind: label === "Weekly" ? "weekly" : "session",
      nowMs
    });
  });
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
            hasCredits?: boolean;
            unlimited?: boolean;
          };
          individualLimit?: {
            limit?: string;
            used?: string;
            remainingPercent?: number;
            resetsAt?: number;
          };
        };
      };
      const individualLimit = limits?.rateLimits?.individualLimit;
      return {
        planType:
          account?.account?.type === "chatgpt"
            ? (account.account.planType ?? null)
            : null,
        credits: limits?.rateLimits?.credits
          ? {
              hasCredits: limits.rateLimits.credits.hasCredits,
              unlimited: limits.rateLimits.credits.unlimited
            }
          : undefined,
        individualLimit: individualLimit
          ? {
              limit: individualLimit.limit,
              used: individualLimit.used,
              remaining_percent: individualLimit.remainingPercent,
              reset_at: individualLimit.resetsAt
            }
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
