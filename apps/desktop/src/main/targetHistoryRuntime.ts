import {
  decodeLocalPath,
  type AppState,
  type LocatedPath,
  type LocalPath,
  type WorkspaceTarget
} from "@kmux/core";
import type {
  ExternalAgentSessionVendor,
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot
} from "@kmux/proto";

import type {
  ExternalSessionResumeSpec,
  createExternalSessionIndexer
} from "./externalSessions";
import type {
  HistoryProvider,
  TargetHistoryRecord,
  TargetServiceRegistry
} from "./targets/contracts";

const MAX_HISTORY_RECORDS = 100;

type ExternalSessionIndexer = ReturnType<typeof createExternalSessionIndexer>;

export function createLocalHistoryProvider(options: {
  indexer: ExternalSessionIndexer;
  refreshUsage: () => Promise<void>;
}): HistoryProvider<LocalPath> {
  const provider: HistoryProvider<LocalPath> = {
    async refresh(request) {
      requireHistoryBound(request.maxRecords);
      await options.refreshUsage();
      const snapshot = options.indexer.listExternalAgentSessions();
      return snapshot.sessions
        .slice(0, request.maxRecords)
        .map((session) => localHistoryRecord(session, snapshot.updatedAt));
    }
  };
  return Object.freeze(provider);
}

export interface TargetHistoryRuntime {
  listExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot>;
  resolveExternalAgentSession(key: string): ExternalSessionResumeSpec | null;
}

export function createTargetHistoryRuntime(options: {
  targetServices: TargetServiceRegistry;
  getState: () => AppState;
  localIndexer: ExternalSessionIndexer;
  now?: () => Date;
  reportError?: (target: WorkspaceTarget, error: Error) => void;
}): TargetHistoryRuntime {
  const now = options.now ?? (() => new Date());
  const recordsByTarget = new Map<string, TargetHistoryRecordWithTarget[]>();
  const resumeByKey = new Map<string, ExternalSessionResumeSpec>();
  let refreshInFlight: Promise<ExternalAgentSessionsSnapshot> | null = null;

  async function refresh(): Promise<ExternalAgentSessionsSnapshot> {
    const targets = currentTargets(options.getState());
    const unavailableTargets: NonNullable<
      ExternalAgentSessionsSnapshot["unavailableTargets"]
    > = [];
    await Promise.all(
      targets.map(async (target) => {
        const key = targetKey(target);
        try {
          const services = options.targetServices.resolveLocated(target);
          const records = await services.history.refresh({
            maxRecords: MAX_HISTORY_RECORDS
          });
          if (
            target.kind === "ssh" &&
            records.some((record) => record.principal === undefined)
          ) {
            throw new Error(
              "remote history record lacks its authenticated principal"
            );
          }
          recordsByTarget.set(
            key,
            records.map((record) => ({ target, services, record }))
          );
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          options.reportError?.(target, failure);
          unavailableTargets.push(
            target.kind === "local"
              ? { kind: "local", message: failure.message }
              : {
                  kind: "ssh",
                  targetId: target.targetId,
                  message: failure.message
                }
          );
        }
      })
    );

    const currentTargetKeys = new Set(
      currentTargets(options.getState()).map(targetKey)
    );
    for (const key of recordsByTarget.keys()) {
      if (!currentTargetKeys.has(key)) recordsByTarget.delete(key);
    }
    const currentRecords = [...recordsByTarget]
      .flatMap(([, records]) => records)
      .sort(
        (left, right) =>
          right.record.updatedAtUnixMs - left.record.updatedAtUnixMs
      )
      .slice(0, MAX_HISTORY_RECORDS);
    const nextResumeByKey = new Map<string, ExternalSessionResumeSpec>();
    const sessions = currentRecords.map((entry) =>
      toExternalSession(entry, now(), nextResumeByKey)
    );
    resumeByKey.clear();
    for (const [key, spec] of nextResumeByKey) resumeByKey.set(key, spec);
    const currentUnavailableTargets = unavailableTargets.filter((target) =>
      currentTargetKeys.has(
        target.kind === "local" ? "local" : `ssh:${target.targetId}`
      )
    );
    return {
      sessions,
      updatedAt: now().toISOString(),
      ...(currentUnavailableTargets.length === 0
        ? {}
        : { unavailableTargets: currentUnavailableTargets })
    };
  }

  const runtime: TargetHistoryRuntime = {
    listExternalAgentSessions() {
      refreshInFlight ??= refresh().finally(() => {
        refreshInFlight = null;
      });
      return refreshInFlight;
    },
    resolveExternalAgentSession(key) {
      return (
        resumeByKey.get(key) ??
        options.localIndexer.resolveExternalAgentSession(key)
      );
    }
  };
  return Object.freeze(runtime);
}

interface TargetHistoryRecordWithTarget {
  target: WorkspaceTarget;
  services: ReturnType<TargetServiceRegistry["resolveLocated"]>;
  record: TargetHistoryRecord<LocatedPath>;
}

function localHistoryRecord(
  session: ExternalAgentSessionVm,
  snapshotUpdatedAt: string
): TargetHistoryRecord<LocalPath> {
  const updatedAt = session.updatedAt ?? snapshotUpdatedAt;
  const updatedAtUnixMs = Date.parse(updatedAt);
  return {
    vendor: session.vendor,
    sessionId: session.key.slice(session.vendor.length + 1),
    updatedAtUnixMs: Number.isFinite(updatedAtUnixMs)
      ? updatedAtUnixMs
      : Date.now(),
    canResume: session.canResume,
    ...(session.cwd === undefined ? {} : { cwd: decodeLocalPath(session.cwd) }),
    title: session.title,
    ...(session.recentConversation === undefined
      ? {}
      : { recentConversation: session.recentConversation }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.createdAt === undefined
      ? {}
      : { createdAt: session.createdAt }),
    updatedAt
  };
}

function toExternalSession(
  entry: TargetHistoryRecordWithTarget,
  currentNow: Date,
  resumeByKey: Map<string, ExternalSessionResumeSpec>
): ExternalAgentSessionVm {
  const record = entry.record;
  const key = externalKey(entry.target, record.vendor, record.sessionId);
  const title =
    record.title ??
    `${vendorTitle(record.vendor)} ${record.sessionId.slice(0, 8)}`;
  const cwd = record.cwd ? entry.services.files.display(record.cwd) : undefined;
  const updatedAt =
    record.updatedAt ?? new Date(record.updatedAtUnixMs).toISOString();
  const command = resumeCommand(record.vendor, record.sessionId);
  if (record.canResume) {
    resumeByKey.set(key, {
      key,
      vendor: record.vendor,
      agentSessionRef: {
        vendor: record.vendor,
        externalKey: key,
        sessionId: record.sessionId
      },
      title,
      target: { ...entry.target },
      ...(cwd === undefined ? {} : { cwd }),
      launch: {
        ...(cwd === undefined ? {} : { cwd }),
        initialInput: `${command.map(shellQuote).join(" ")}\r`,
        title
      }
    });
  }
  return {
    key,
    target:
      entry.target.kind === "local"
        ? { kind: "local" }
        : {
            kind: "ssh",
            targetId: entry.target.targetId,
            principal: requireRemotePrincipal(record)
          },
    vendor: record.vendor,
    vendorLabel: vendorLabel(record.vendor),
    title,
    ...(record.recentConversation === undefined
      ? {}
      : { recentConversation: record.recentConversation }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    updatedAt,
    relativeTimeLabel: formatRelativeTime(currentNow, record.updatedAtUnixMs),
    canResume: record.canResume,
    resumeCommandPreview: command.join(" ")
  };
}

function requireRemotePrincipal(record: TargetHistoryRecord<LocatedPath>): {
  uid: number;
  accountName: string;
} {
  if (!record.principal) {
    throw new Error("remote history record lacks its authenticated principal");
  }
  return { ...record.principal };
}

function currentTargets(state: AppState): WorkspaceTarget[] {
  const targets: WorkspaceTarget[] = [{ kind: "local" }];
  const seen = new Set<string>();
  for (const workspace of Object.values(state.workspaces)) {
    const target = workspace.location.target;
    if (target.kind !== "ssh" || seen.has(target.targetId)) continue;
    seen.add(target.targetId);
    targets.push({ kind: "ssh", targetId: target.targetId });
  }
  return targets;
}

function targetKey(target: WorkspaceTarget): string {
  return target.kind === "local" ? "local" : `ssh:${target.targetId}`;
}

function externalKey(
  target: WorkspaceTarget,
  vendor: ExternalAgentSessionVendor,
  sessionId: string
): string {
  return target.kind === "local"
    ? `${vendor}:${sessionId}`
    : `ssh:${encodeURIComponent(target.targetId)}:${vendor}:${encodeURIComponent(sessionId)}`;
}

function vendorLabel(
  vendor: ExternalAgentSessionVendor
): ExternalAgentSessionVm["vendorLabel"] {
  switch (vendor) {
    case "codex":
      return "CODEX";
    case "claude":
      return "CLAUDE";
    case "antigravity":
      return "AGY";
  }
}

function vendorTitle(vendor: ExternalAgentSessionVendor): string {
  return vendor === "antigravity" ? "Antigravity" : vendorLabel(vendor);
}

function resumeCommand(
  vendor: ExternalAgentSessionVendor,
  sessionId: string
): string[] {
  switch (vendor) {
    case "codex":
      return ["codex", "resume", sessionId];
    case "claude":
      return ["claude", "--resume", sessionId];
    case "antigravity":
      return ["agy", "--conversation", sessionId];
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatRelativeTime(now: Date, updatedAtUnixMs: number): string {
  const deltaMs = Math.max(0, now.getTime() - updatedAtUnixMs);
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1_000)}s`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h`;
  return `${Math.floor(deltaMs / 86_400_000)}d`;
}

function requireHistoryBound(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_HISTORY_RECORDS
  ) {
    throw new TypeError("target history record bound is invalid");
  }
}
