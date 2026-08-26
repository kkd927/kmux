import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm
} from "@kmux/proto";

import {
  buildSubscriptionRow,
  withTimeout,
  type SubscriptionRuntimeBaseOptions
} from "../subscriptionShared";

const COPILOT_QUOTA_TIMEOUT_MS = 10_000;
const COPILOT_QUOTA_CACHE_MS = 15_000;
const MAX_RPC_HEADER_BYTES = 8 * 1024;
const MAX_RPC_MESSAGE_BYTES = 256 * 1024;
const MAX_RPC_OUTPUT_BYTES = 1024 * 1024;

interface CopilotQuotaSnapshot {
  readonly isUnlimitedEntitlement: boolean;
  readonly entitlementRequests: number;
  readonly usedRequests: number;
  readonly remainingPercentage: number;
  readonly tokenBasedBilling?: boolean;
}

interface CopilotAccountMetadata {
  readonly copilotPlan?: string;
  readonly accessTypeSku?: string;
  readonly quotaResetDate?: string;
  readonly quotaResetDateUtc?: string;
  readonly limitedUserResetDate?: string;
}

export interface CopilotQuotaResult {
  readonly quotaSnapshots: Readonly<Record<string, unknown>>;
  readonly account?: CopilotAccountMetadata;
}

export interface CopilotSubscriptionUsageOptions extends SubscriptionRuntimeBaseOptions {
  readonly quotaProbe?: () => Promise<CopilotQuotaResult>;
  readonly spawnImpl?: CopilotSpawn;
  readonly quotaTimeoutMs?: number;
}

export interface CopilotSubscriptionRuntime {
  detectAuth(): Promise<boolean>;
  fetch(): Promise<SubscriptionProviderUsageVm | null>;
}

type CopilotSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

interface RpcResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

export function createCopilotSubscriptionRuntime(
  options: CopilotSubscriptionUsageOptions = {}
): CopilotSubscriptionRuntime {
  const now = options.now ?? (() => Date.now());
  const probe =
    options.quotaProbe ??
    (() =>
      probeCopilotQuotaViaRpc({
        env: options.env,
        spawnImpl: options.spawnImpl,
        timeoutMs: options.quotaTimeoutMs
      }));
  let cached:
    | {
        readonly expiresAtMs: number;
        readonly result: Promise<CopilotQuotaResult>;
      }
    | undefined;

  const readQuota = (): Promise<CopilotQuotaResult> => {
    const nowMs = now();
    if (cached && nowMs < cached.expiresAtMs) {
      return cached.result;
    }
    const result = probe();
    cached = {
      expiresAtMs: nowMs + COPILOT_QUOTA_CACHE_MS,
      result
    };
    return result;
  };

  return {
    async detectAuth() {
      try {
        return (
          selectCopilotPlanQuota((await readQuota()).quotaSnapshots) !== null
        );
      } catch {
        return false;
      }
    },
    async fetch() {
      return normalizeCopilotSubscriptionUsage(await readQuota(), now());
    }
  };
}

export function normalizeCopilotSubscriptionUsage(
  result: CopilotQuotaResult,
  nowMs: number
): SubscriptionProviderUsageVm | null {
  const selected = selectCopilotPlanQuota(result.quotaSnapshots);
  if (!selected) return null;

  const { snapshot } = selected;
  const resetsAtMs = resolveCopilotQuotaResetAt(result.account);
  const row: SubscriptionUsageRowVm = snapshot.isUnlimitedEntitlement
    ? {
        key: "plan",
        label: quotaLabel(snapshot),
        valueKind: "unlimited",
        resetLabel: "No quota limit reported",
        windowKind: "credits"
      }
    : buildSubscriptionRow({
        key: "plan",
        label: quotaLabel(snapshot),
        usedPercent: 100 - snapshot.remainingPercentage,
        resetsAtMs,
        windowKind: "credits",
        nowMs
      });

  return {
    provider: "copilot",
    providerLabel: "GitHub Copilot",
    planLabel: resolveCopilotPlanLabel(result.account),
    accentTone: "violet",
    source: "copilot-rpc",
    updatedAt: new Date(nowMs).toISOString(),
    rows: [row]
  };
}

export async function probeCopilotQuotaViaRpc(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly spawnImpl?: CopilotSpawn;
    readonly timeoutMs?: number;
  } = {}
): Promise<CopilotQuotaResult> {
  const spawnImpl: CopilotSpawn =
    options.spawnImpl ??
    ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const child = spawnImpl(
    "copilot",
    ["--headless", "--no-auto-update", "--stdio", "--log-level", "none"],
    {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const rpc = createCopilotRpcClient(child);

  try {
    return await withTimeout(async () => {
      await rpc.request("connect", {});
      const result = await rpc.request("account.getQuota", {});
      if (!isRecord(result) || !isRecord(result.quotaSnapshots)) {
        throw new Error("Copilot quota response is malformed");
      }
      let account: CopilotAccountMetadata | undefined;
      try {
        account = parseCopilotAccountMetadata(
          await rpc.request("account.getCurrentAuth", {})
        );
      } catch {
        // Older Copilot clients may not expose account metadata. Quota usage is
        // still useful without a plan label or reset date.
      }
      return {
        quotaSnapshots: result.quotaSnapshots,
        ...(account ? { account } : {})
      };
    }, options.timeoutMs ?? COPILOT_QUOTA_TIMEOUT_MS);
  } finally {
    rpc.dispose();
    child.kill();
  }
}

function parseCopilotAccountMetadata(
  value: unknown
): CopilotAccountMetadata | undefined {
  if (!isRecord(value) || !isRecord(value.authInfo)) return undefined;
  const user = value.authInfo.copilotUser;
  if (!isRecord(user)) return undefined;
  const metadata: CopilotAccountMetadata = {
    copilotPlan: optionalString(user.copilot_plan),
    accessTypeSku: optionalString(user.access_type_sku),
    quotaResetDate: optionalString(user.quota_reset_date),
    quotaResetDateUtc: optionalString(user.quota_reset_date_utc),
    limitedUserResetDate: optionalString(user.limited_user_reset_date)
  };
  return Object.values(metadata).some((entry) => entry !== undefined)
    ? metadata
    : undefined;
}

function resolveCopilotPlanLabel(
  account: CopilotAccountMetadata | undefined
): string {
  const sku = normalizePlanIdentifier(account?.accessTypeSku);
  if (sku.includes("free_limited")) return "Free";
  if (sku.includes("student")) return "Student";
  if (sku.includes("enterprise")) return "Enterprise";
  if (sku.includes("business")) return "Business";
  if (sku.includes("max")) return "Max";
  if (sku.includes("plus")) return "Pro+";

  switch (normalizePlanIdentifier(account?.copilotPlan)) {
    case "free":
      return "Free";
    case "student":
      return "Student";
    case "individual_pro_plus":
    case "pro_plus":
      return "Pro+";
    case "individual_max":
    case "max":
      return "Max";
    case "individual_pro":
    case "pro":
      return "Pro";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return "";
  }
}

function resolveCopilotQuotaResetAt(
  account: CopilotAccountMetadata | undefined
): number | undefined {
  for (const candidate of [
    account?.quotaResetDateUtc,
    account?.quotaResetDate,
    account?.limitedUserResetDate
  ]) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizePlanIdentifier(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_") ?? ""
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function selectCopilotPlanQuota(
  quotaSnapshots: Readonly<Record<string, unknown>>
): {
  readonly key: "premium_interactions" | "chat";
  readonly snapshot: CopilotQuotaSnapshot;
} | null {
  const premium = parseQuotaSnapshot(quotaSnapshots.premium_interactions);
  if (isApplicablePlanQuota(premium)) {
    return { key: "premium_interactions", snapshot: premium };
  }
  const chat = parseQuotaSnapshot(quotaSnapshots.chat);
  if (isApplicablePlanQuota(chat)) {
    return { key: "chat", snapshot: chat };
  }
  return null;
}

function isApplicablePlanQuota(
  snapshot: CopilotQuotaSnapshot | null
): snapshot is CopilotQuotaSnapshot {
  return Boolean(
    snapshot &&
    (snapshot.isUnlimitedEntitlement || snapshot.entitlementRequests > 0)
  );
}

function parseQuotaSnapshot(value: unknown): CopilotQuotaSnapshot | null {
  if (!isRecord(value)) return null;
  const isUnlimitedEntitlement = value.isUnlimitedEntitlement;
  const entitlementRequests = value.entitlementRequests;
  const usedRequests = value.usedRequests;
  const remainingPercentage = value.remainingPercentage;
  if (
    typeof isUnlimitedEntitlement !== "boolean" ||
    !isFiniteNumber(entitlementRequests) ||
    !isFiniteNumber(usedRequests) ||
    !isFiniteNumber(remainingPercentage) ||
    entitlementRequests < -1 ||
    usedRequests < 0 ||
    remainingPercentage < 0 ||
    remainingPercentage > 100
  ) {
    return null;
  }
  return {
    isUnlimitedEntitlement,
    entitlementRequests,
    usedRequests,
    remainingPercentage,
    tokenBasedBilling:
      typeof value.tokenBasedBilling === "boolean"
        ? value.tokenBasedBilling
        : undefined
  };
}

function quotaLabel(snapshot: CopilotQuotaSnapshot): string {
  if (snapshot.tokenBasedBilling === true) return "AI Credits";
  if (snapshot.tokenBasedBilling === false) return "Premium Requests";
  return "Plan Usage";
}

function createCopilotRpcClient(child: ChildProcessWithoutNullStreams): {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
} {
  let nextId = 1;
  let outputBytes = 0;
  let buffered = Buffer.alloc(0);
  let disposed = false;
  const pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onStdout = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > MAX_RPC_OUTPUT_BYTES) {
      fail(new Error("Copilot quota RPC exceeded its output limit"));
      return;
    }
    buffered = Buffer.concat([buffered, bytes]);
    parseBufferedRpcMessages();
  };
  const onStderr = (chunk: Buffer | string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_RPC_OUTPUT_BYTES) {
      fail(new Error("Copilot quota RPC exceeded its output limit"));
    }
  };
  const onError = (error: Error) => fail(error);
  const onStdinError = (error: Error) => fail(error);
  const onExit = () => fail(new Error("Copilot quota RPC exited"));

  const parseBufferedRpcMessages = () => {
    while (buffered.byteLength > 0) {
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffered.byteLength > MAX_RPC_HEADER_BYTES) {
          fail(new Error("Copilot quota RPC header is too large"));
        }
        return;
      }
      if (headerEnd > MAX_RPC_HEADER_BYTES) {
        fail(new Error("Copilot quota RPC header is too large"));
        return;
      }
      const header = buffered.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(header);
      if (
        contentLength === null ||
        contentLength < 0 ||
        contentLength > MAX_RPC_MESSAGE_BYTES
      ) {
        fail(new Error("Copilot quota RPC content length is invalid"));
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffered.byteLength < bodyEnd) return;
      const body = buffered.subarray(bodyStart, bodyEnd).toString("utf8");
      buffered = buffered.subarray(bodyEnd);
      handleRpcResponse(body);
    }
  };
  const handleRpcResponse = (body: string) => {
    let response: RpcResponse;
    try {
      response = JSON.parse(body) as RpcResponse;
    } catch {
      fail(new Error("Copilot quota RPC returned invalid JSON"));
      return;
    }
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) {
      request.reject(
        new Error(
          typeof response.error.message === "string"
            ? response.error.message
            : "Copilot quota RPC request failed"
        )
      );
      return;
    }
    request.resolve(response.result);
  };

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.stdin.on("error", onStdinError);
  child.once("error", onError);
  child.once("exit", onExit);

  return {
    request(method, params) {
      if (disposed) {
        return Promise.reject(new Error("Copilot quota RPC is closed"));
      }
      const id = nextId;
      nextId += 1;
      const body = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        "utf8"
      );
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(
          `Content-Length: ${body.byteLength}\r\n\r\n`,
          "ascii"
        );
        child.stdin.write(body);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      fail(new Error("Copilot quota RPC was disposed"));
      child.stdin.end();
    }
  };
}

function parseContentLength(header: string): number | null {
  const match = header.match(
    /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/iu
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
