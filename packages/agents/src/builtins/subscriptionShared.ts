import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type {
  SubscriptionProviderUsageVm,
  SubscriptionUsageRowVm
} from "@kmux/proto";
import {
  resolveAgentStorageRoots,
  type AgentStorageRoots
} from "@kmux/metadata";

const execFileAsync = promisify(execFile);

export const SUBSCRIPTION_PROBE_TIMEOUT_MS = 4_000;
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 5_000;
const SUBSCRIPTION_EXEC_TIMEOUT_MS = 4_000;

export type FetchLike = typeof fetch;
export type ReadTextFile = (filePath: string) => Promise<string>;
export type ExecFileLike = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

export type SubscriptionProviderFetcher =
  () => Promise<SubscriptionProviderUsageVm | null>;
export type SubscriptionProviderAuthDetector = () => Promise<boolean>;

export interface SubscriptionRuntimeBaseOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export function buildSubscriptionRow(options: {
  key: string;
  label: string;
  usedPercent: number;
  resetsAtMs?: number;
  windowKind: SubscriptionUsageRowVm["windowKind"];
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
  if (!resetsAtMs || !Number.isFinite(resetsAtMs)) return fallbackLabel;
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  if (remainingMs <= 30_000) return "Resets soon";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Resets in ${days}d ${Math.max(1, hours)}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

export function compactHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      value ? [[key, value]] : []
    )
  );
}

export async function readJsonFile<T>(
  filePath: string,
  readTextFile: ReadTextFile
): Promise<T | null> {
  try {
    return safeJsonParse(await readTextFile(filePath)) as T | null;
  } catch {
    return null;
  }
}

export async function defaultReadJsonText(
  filePath: string,
  readTextFile: ReadTextFile
): Promise<string | null> {
  try {
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

export async function defaultReadTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function defaultExecFile(
  file: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    timeout: SUBSCRIPTION_EXEC_TIMEOUT_MS
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function withFetchTimeout(init: RequestInit): RequestInit {
  return {
    ...init,
    signal:
      init.signal ??
      (typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(SUBSCRIPTION_FETCH_TIMEOUT_MS)
        : undefined)
  };
}

export async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
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

export function parseDateToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function stripAnsiCodes(value: string): string {
  const ansiEscape = String.fromCharCode(27);
  return value.replace(new RegExp(`${ansiEscape}\\[[0-9;]*[A-Za-z]`, "gu"), "");
}

export function resolveSubscriptionAgentStorageRoots(
  options: SubscriptionRuntimeBaseOptions
): AgentStorageRoots {
  return (
    options.agentStorageRoots ??
    resolveAgentStorageRoots({ homeDir: options.homeDir, env: options.env })
  );
}

export function humanizePlanLabel(value: string): string {
  return value
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}
