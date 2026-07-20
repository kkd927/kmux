import { isAbsolute } from "node:path";

import { decodeLocalPath, type LocalPath } from "@kmux/core";
import { usageSampleIdentity, type UsageEventSample } from "@kmux/metadata";

import type { UsageScanService } from "../usageScanWorkerClient";
import type { TargetUsageRecord, UsageProvider } from "./contracts";

const MAX_LOCAL_USAGE_RECORDS = 4_096;

export function createLocalUsageProvider(options: {
  scanService: UsageScanService;
}): UsageProvider<LocalPath> {
  const provider: UsageProvider<LocalPath> = {
    async refresh(request) {
      requireUsageRequest(request);
      const result = await options.scanService.scan({
        startOfDayMs: request.startAtUnixMs,
        initial: request.initial,
        ...(request.historyRange === undefined
          ? {}
          : { historyRange: { ...request.historyRange } })
      });
      const samples = result.reads.flatMap((read) => read.samples);
      return {
        records: samples.slice(0, request.maxRecords).flatMap((sample) => {
          const record = toTargetUsageRecord(sample);
          return record ? [record] : [];
        }),
        truncated: samples.length > request.maxRecords,
        ...(result.historyDays === undefined
          ? {}
          : {
              historyDays: result.historyDays.map((day) => structuredClone(day))
            })
      };
    },
    watch: (onChange) => options.scanService.watch(onChange),
    markDirty: (vendor, dirtyOptions) =>
      options.scanService.markDirty(vendor, dirtyOptions),
    close: () => options.scanService.close()
  };
  return Object.freeze(provider);
}

function toTargetUsageRecord(
  sample: UsageEventSample
): TargetUsageRecord<LocalPath> | null {
  if (sample.vendor === "unknown") return null;
  const cwd = decodeOptionalAbsolutePath(sample.cwd);
  const projectPath = decodeOptionalAbsolutePath(sample.projectPath);
  return {
    vendor: sample.vendor,
    sampleId: usageSampleIdentity(sample),
    timestampUnixMs: sample.timestampMs,
    ...(sample.sessionId === undefined ? {} : { sessionId: sample.sessionId }),
    ...(sample.threadId === undefined ? {} : { threadId: sample.threadId }),
    ...(sample.requestId === undefined ? {} : { requestId: sample.requestId }),
    ...(sample.eventId === undefined ? {} : { eventId: sample.eventId }),
    ...(sample.model === undefined ? {} : { model: sample.model }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(projectPath === undefined ? {} : { projectPath }),
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    ...(sample.thinkingTokens === undefined
      ? {}
      : { thinkingTokens: sample.thinkingTokens }),
    ...(sample.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: sample.cacheReadTokens }),
    ...(sample.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: sample.cacheWriteTokens }),
    ...(sample.cacheWriteTokensKnown === undefined
      ? {}
      : { cacheWriteTokensKnown: sample.cacheWriteTokensKnown }),
    cacheTokens: sample.cacheTokens,
    totalTokens: sample.totalTokens,
    estimatedCostUsd: sample.estimatedCostUsd,
    ...(sample.costSource === undefined
      ? {}
      : { costSource: sample.costSource })
  };
}

function decodeOptionalAbsolutePath(
  value: string | undefined
): LocalPath | undefined {
  if (!value || !isAbsolute(value)) return undefined;
  return decodeLocalPath(value);
}

function requireUsageRequest(request: {
  startAtUnixMs: number;
  maxRecords: number;
}): void {
  if (
    !Number.isSafeInteger(request.startAtUnixMs) ||
    request.startAtUnixMs < 0 ||
    !Number.isSafeInteger(request.maxRecords) ||
    request.maxRecords < 1 ||
    request.maxRecords > MAX_LOCAL_USAGE_RECORDS
  ) {
    throw new TypeError("local usage scan request is outside its hard bounds");
  }
}
