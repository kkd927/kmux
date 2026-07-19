import { posix } from "node:path";

import type { RemotePath } from "@kmux/core";
import { estimateUsageComponentCosts } from "@kmux/metadata";
import type { Id } from "@kmux/proto";

import type { RemoteHostManager } from "../remoteHost";
import type { TargetUsageRecord, UsageProvider } from "./contracts";
import type { RemotePathDecoder } from "./targetServiceRegistry";

const MAX_REMOTE_USAGE_RECORDS = 64;

export function createRemoteUsageProvider(options: {
  desktopInstallationId: Id;
  targetId: Id;
  host: Pick<RemoteHostManager, "scanUsage">;
  decodeRemotePath: RemotePathDecoder;
}): UsageProvider<RemotePath> {
  const provider: UsageProvider<RemotePath> = {
    async refresh(request) {
      requireUsageRequest(request);
      const scan = await options.host.scanUsage({
        desktopInstallationId: options.desktopInstallationId,
        targetId: options.targetId,
        startAtUnixMs: request.startAtUnixMs,
        maxRecords: Math.min(request.maxRecords, MAX_REMOTE_USAGE_RECORDS)
      });
      if (scan.targetId !== options.targetId) {
        throw new Error("remote usage scan crossed its bound target");
      }
      return {
        principal: { ...scan.principal },
        truncated: scan.truncated,
        records: scan.records.map((record) =>
          decodeUsageRecord(record, options.decodeRemotePath)
        )
      };
    }
  };
  return Object.freeze(provider);
}

function decodeUsageRecord(
  record: Awaited<
    ReturnType<RemoteHostManager["scanUsage"]>
  >["records"][number],
  decodeRemotePath: RemotePathDecoder
): TargetUsageRecord<RemotePath> {
  const inputTokens = safeUint64(record.inputTokens, "inputTokens");
  const outputTokens = safeUint64(record.outputTokens, "outputTokens");
  const thinkingTokens = safeUint64(record.thinkingTokens, "thinkingTokens");
  const cacheReadTokens = safeUint64(record.cacheReadTokens, "cacheReadTokens");
  const cacheWriteTokens = safeUint64(
    record.cacheWriteTokens,
    "cacheWriteTokens"
  );
  const totalTokens = safeUint64(record.totalTokens, "totalTokens");
  const estimate = estimateUsageComponentCosts({
    vendor: record.vendor === "antigravity" ? "gemini" : record.vendor,
    model: record.model,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWriteTokensKnown: record.cacheWriteTokensKnown
  });
  const estimatedCostUsd = estimate?.totalCostUsd ?? 0;
  return {
    vendor: record.vendor,
    sampleId: record.sampleId,
    timestampUnixMs: safeUint64(record.timestampUnixMs, "timestampUnixMs"),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.cwd === undefined
      ? {}
      : { cwd: decodeAbsoluteRemotePath(record.cwd, decodeRemotePath) }),
    ...(record.projectPath === undefined
      ? {}
      : {
          projectPath: decodeAbsoluteRemotePath(
            record.projectPath,
            decodeRemotePath
          )
        }),
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWriteTokensKnown: record.cacheWriteTokensKnown,
    cacheTokens: cacheReadTokens + cacheWriteTokens,
    totalTokens,
    estimatedCostUsd,
    costSource: estimate ? "estimated" : "unavailable"
  };
}

function decodeAbsoluteRemotePath(
  value: string,
  decodeRemotePath: RemotePathDecoder
): RemotePath {
  if (!posix.isAbsolute(value)) {
    throw new TypeError("remote usage path is not absolute");
  }
  return decodeRemotePath(value);
}

function safeUint64(value: string, field: string): number {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`remote usage ${field} exceeds the desktop safe range`);
  }
  return Number(parsed);
}

function requireUsageRequest(request: {
  startAtUnixMs: number;
  maxRecords: number;
}): void {
  if (
    !Number.isSafeInteger(request.startAtUnixMs) ||
    request.startAtUnixMs < 0 ||
    !Number.isSafeInteger(request.maxRecords) ||
    request.maxRecords < 1
  ) {
    throw new TypeError("remote usage scan request is invalid");
  }
}
