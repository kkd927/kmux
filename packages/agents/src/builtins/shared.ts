import type { NormalizedAgentHookResult } from "../contracts";
import { delimiter, isAbsolute, resolve } from "node:path";

export type HookPayload = Record<string, unknown>;

export function usageWatchIsRecursive(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function absoluteUsageOverrideRoots(
  value: string | undefined
): string[] {
  if (!value?.trim()) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => isAbsolute(entry))
    .map((entry) => resolve(entry));
}

export function normalizeHookEventName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
}

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function booleanField(
  record: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function recordField(
  record: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function arrayField(
  record: Record<string, unknown> | undefined,
  key: string
): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function firstString(
  ...values: Array<string | undefined>
): string | undefined {
  return values
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
}

export function commonHookResult(options: {
  result: Omit<NormalizedAgentHookResult, "details">;
  payload: HookPayload;
}): NormalizedAgentHookResult {
  const details: Record<string, unknown> = {};
  for (const key of [
    "hook_event_name",
    "notification_type",
    "tool_name",
    "toolName",
    "session_id",
    "sessionId",
    "turn_id",
    "surface_id",
    "conversationId",
    "transcriptPath",
    "artifactDirectoryPath"
  ]) {
    const value = stringField(options.payload, key);
    if (value) details[key] = value.slice(0, 160);
  }
  const fullyIdle = booleanField(options.payload, "fullyIdle");
  if (fullyIdle !== undefined) details.fullyIdle = fullyIdle;
  const workspacePaths = arrayField(options.payload, "workspacePaths")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (workspacePaths.length > 0) details.workspacePaths = workspacePaths;
  return { ...options.result, details };
}

export function needsInputFallback(payload: HookPayload): string {
  return (
    firstString(
      stringField(payload, "message"),
      stringField(payload, "body"),
      stringField(payload, "text"),
      stringField(payload, "prompt"),
      stringField(payload, "reason")
    ) ?? "Needs input"
  );
}

export function summarizeTurnMessage(
  value: string | undefined
): string | undefined {
  let label: string | undefined;
  for (const rawLine of (value ?? "").split("\n")) {
    const trimmed = rawLine.trim();
    const isLabel =
      /^#{1,6}\s/u.test(trimmed) || /^\*\*[^*]+\*\*:?$/u.test(trimmed);
    if (
      /^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed) ||
      /^(?:```|~~~)/u.test(trimmed)
    ) {
      continue;
    }
    const line = trimmed
      .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/u, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/\*\*|`/gu, "")
      .trim();
    if (!line) continue;
    if (isLabel && label === undefined) {
      label = line;
      continue;
    }
    return truncate(label === undefined ? line : `${label} — ${line}`, 100);
  }
  return label === undefined ? undefined : truncate(label, 100);
}

function truncate(value: string, maxLength: number): string {
  const points = Array.from(value);
  return points.length <= maxLength
    ? value
    : `${points.slice(0, maxLength - 1).join("")}…`;
}
