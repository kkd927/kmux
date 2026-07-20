import type { RemotePath } from "@kmux/core";
import type { Id } from "@kmux/proto";

import type { RemoteHostManager } from "../remoteHost";
import type { HistoryProvider, TargetHistoryRecord } from "./contracts";
import type { RemotePathDecoder } from "./targetServiceRegistry";

const MAX_HISTORY_RECORDS = 100;
const MAX_DATE_UNIX_MS = 8_640_000_000_000_000;

export function createRemoteHistoryProvider(options: {
  desktopInstallationId: Id;
  targetId: Id;
  host: Pick<RemoteHostManager, "scanHistory">;
  decodeRemotePath: RemotePathDecoder;
}): HistoryProvider<RemotePath> {
  const provider: HistoryProvider<RemotePath> = {
    async refresh(request) {
      if (
        !Number.isSafeInteger(request.maxRecords) ||
        request.maxRecords < 1 ||
        request.maxRecords > MAX_HISTORY_RECORDS
      ) {
        throw new TypeError("remote history record bound is invalid");
      }
      const scan = await options.host.scanHistory({
        targetId: options.targetId,
        desktopInstallationId: options.desktopInstallationId,
        maxRecords: request.maxRecords
      });
      if (scan.targetId !== options.targetId) {
        throw new Error("remote history scan escaped its target binding");
      }
      return scan.records.map((record) =>
        decodeHistoryRecord(record, scan.principal, options.decodeRemotePath)
      );
    }
  };
  return Object.freeze(provider);
}

function decodeHistoryRecord(
  record: Awaited<
    ReturnType<RemoteHostManager["scanHistory"]>
  >["records"][number],
  principal: Awaited<ReturnType<RemoteHostManager["scanHistory"]>>["principal"],
  decodeRemotePath: RemotePathDecoder
): TargetHistoryRecord<RemotePath> {
  const updatedAtUnixMs = Number(record.updatedAtUnixMs);
  if (
    !Number.isSafeInteger(updatedAtUnixMs) ||
    updatedAtUnixMs < 0 ||
    updatedAtUnixMs > MAX_DATE_UNIX_MS
  ) {
    throw new TypeError("remote history timestamp is invalid");
  }
  if (record.cwd !== undefined && !record.cwd.startsWith("/")) {
    throw new TypeError("remote history cwd must be absolute");
  }
  return {
    vendor: record.vendor,
    sessionId: record.sessionId,
    updatedAtUnixMs,
    canResume: record.canResume,
    ...(record.cwd === undefined ? {} : { cwd: decodeRemotePath(record.cwd) }),
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.recentConversation === undefined
      ? {}
      : { recentConversation: record.recentConversation }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    principal: { ...principal }
  };
}
