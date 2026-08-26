import { formatAgentCommandForShell, type WorkspaceTarget } from "@kmux/core";
import type {
  AgentMetadataInventoryService,
  SessionInventoryLimits
} from "@kmux/metadata";
import { resolveAgentMetadataRoots } from "@kmux/metadata";
import type {
  AgentId,
  AgentScopeSettings,
  ExternalAgentSessionRef,
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";

import type { ResolvedAgentLaunchPolicy } from "./command";
import type {
  AgentCatalog,
  AgentExternalSessionMetadataProjection,
  AgentExternalSessionProjectionOptions,
  AgentExternalSessionProjectionResult,
  AgentExternalSessionRecordProjection,
  AgentSessionsCapability,
  AgentMetadataSourcesCapability
} from "./contracts";

const DEFAULT_MAX_RECORDS = 100;
const SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentSessionProjectionBinding {
  readonly agentId: AgentId;
  readonly capability: AgentSessionsCapability;
}

export interface MaterializedAgentSessionSource {
  readonly agentId: AgentId;
  readonly kind: "metadata";
  readonly roots: readonly string[];
  readonly projection: AgentExternalSessionMetadataProjection;
}

export interface MaterializedExternalSessionIndexerOptions {
  readonly sources: readonly MaterializedAgentSessionSource[];
  readonly metadataInventory: AgentMetadataInventoryService;
  readonly catalog: AgentCatalog;
  readonly resolveResume: (options: {
    readonly agentId: AgentId;
    readonly sessionId: string;
    readonly settings?: AgentScopeSettings[string];
  }) => ResolvedAgentLaunchPolicy | undefined;
  readonly agentSettings?: AgentScopeSettings;
  readonly now?: () => Date;
  readonly maxRecords?: number;
  readonly commandAvailability?: (command: string) => boolean;
  readonly scanLimits?: Partial<SessionInventoryLimits>;
}

export interface MaterializedExternalSessionIndexer {
  listExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot>;
  resolveExternalAgentSession(
    key: string
  ): MaterializedExternalSessionResumeSpec | null;
  close(): void;
}

export interface MaterializedExternalSessionResumeSpec {
  readonly key: string;
  readonly vendor: AgentId;
  readonly agentSessionRef: ExternalAgentSessionRef;
  readonly title: string;
  readonly target: WorkspaceTarget;
  readonly cwd?: string;
  readonly launch: SessionLaunchConfig;
}

interface RuntimeRecord extends AgentExternalSessionRecordProjection {
  readonly agentId: AgentId;
  readonly key: string;
  readonly title: string;
}

export function materializeAgentSessionSources(options: {
  readonly bindings: readonly AgentSessionProjectionBinding[];
  readonly metadataSources: ReadonlyMap<
    AgentId,
    AgentMetadataSourcesCapability
  >;
  readonly runtime: AgentExternalSessionProjectionOptions;
}): readonly MaterializedAgentSessionSource[] {
  return Object.freeze(
    options.bindings.map(({ agentId, capability }) => {
      const metadata = options.metadataSources.get(agentId);
      const projection = capability.createMetadataProjection(options.runtime);
      if (!metadata || !projection) {
        throw new TypeError(
          `agent ${agentId} sessions metadata projection is incomplete`
        );
      }
      const roots =
        metadata.resolveLocalRoots?.(options.runtime) ??
        resolveAgentMetadataRoots({
          agentId,
          env: options.runtime.env,
          homeDir: options.runtime.homeDir,
          pathRoot: metadata.pathRoot,
          defaultRoot: metadata.defaultRoot,
          agentSettings: options.runtime.agentSettings
        });
      if (roots.length === 0) {
        throw new TypeError(`agent ${agentId} sessions has no metadata roots`);
      }
      return Object.freeze({
        agentId,
        kind: "metadata" as const,
        roots: Object.freeze([...roots]),
        projection
      });
    })
  );
}

export function createMaterializedExternalSessionIndexer(
  options: MaterializedExternalSessionIndexerOptions
): MaterializedExternalSessionIndexer {
  const now = options.now ?? (() => new Date());
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const canRunCommand = options.commandAvailability ?? (() => true);
  let cachedRecords: RuntimeRecord[] = [];
  let inFlight: Promise<ExternalAgentSessionsSnapshot> | null = null;
  let closed = false;

  const runtime = Object.freeze({
    listExternalAgentSessions() {
      return listSessions();
    },
    resolveExternalAgentSession(key: string) {
      const record = cachedRecords.find((candidate) => candidate.key === key);
      if (!record) return null;
      const policy = resumePolicy(record);
      return policy && canRunCommand(policy.command)
        ? toResumeSpec(record, policy)
        : null;
    },
    close() {
      if (closed) return;
      closed = true;
      cachedRecords = [];
      inFlight = null;
    }
  });
  return runtime;

  function listSessions(): Promise<ExternalAgentSessionsSnapshot> {
    if (closed) {
      return Promise.reject(new Error("external session indexer is closed"));
    }
    if (inFlight) return inFlight;
    const request = scan().finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  }

  async function scan(): Promise<ExternalAgentSessionsSnapshot> {
    const currentNow = now();
    const results = await Promise.allSettled(
      options.sources.map(projectSource)
    );
    const projected = results.flatMap((result) =>
      result.status === "fulfilled" ? [...result.value.records] : []
    );
    const cutoffMs = currentNow.getTime() - SESSION_LOOKBACK_MS;
    const merged = mergeRecords(
      projected.filter((record) => record.updatedAtMs >= cutoffMs)
    );
    const currentRecords = limitRecordsPerAgent(merged, maxRecords);
    if (!closed) cachedRecords = currentRecords;
    const truncated =
      results.some(
        (result) =>
          result.status === "rejected" || result.value.truncated === true
      ) || merged.length > currentRecords.length;
    return {
      sessions: currentRecords.map((record) => toViewModel(record, currentNow)),
      updatedAt: currentNow.toISOString(),
      ...(truncated ? { truncated: true } : {})
    };
  }

  async function projectSource(
    source: MaterializedAgentSessionSource
  ): Promise<{ records: RuntimeRecord[]; truncated: boolean }> {
    const result = await projectMetadataSource(source);
    return {
      records: decodeProjectionResult(result, maxRecords * 4).records.map(
        (record) => normalizeRecord(source.agentId, record)
      ),
      truncated: result.truncated
    };
  }

  async function projectMetadataSource(
    source: MaterializedAgentSessionSource
  ): Promise<AgentExternalSessionProjectionResult> {
    const lease = options.metadataInventory.acquire(
      source.agentId,
      source.roots,
      options.scanLimits
    );
    try {
      const inventory = await lease.inventory();
      return await source.projection.project({
        roots: source.roots,
        inventory,
        maxRecords,
        ...(options.scanLimits === undefined
          ? {}
          : { scanLimits: options.scanLimits }),
        readText: (request) => lease.readText(request),
        query: (request) => lease.query(request)
      });
    } finally {
      await lease.release();
    }
  }

  function resumePolicy(record: RuntimeRecord) {
    const settings =
      options.agentSettings &&
      Object.hasOwn(options.agentSettings, record.agentId)
        ? options.agentSettings[record.agentId]
        : undefined;
    return options.resolveResume({
      agentId: record.agentId,
      sessionId: record.sessionId,
      ...(settings === undefined ? {} : { settings })
    });
  }

  function toViewModel(
    record: RuntimeRecord,
    currentNow: Date
  ): ExternalAgentSessionVm {
    const descriptor = options.catalog.descriptor(record.agentId);
    const policy = resumePolicy(record);
    const command = policy ? [policy.command, ...policy.args] : [];
    return {
      key: record.key,
      target: { kind: "local" },
      vendor: record.agentId,
      vendorLabel:
        descriptor?.presentation?.shortLabel ?? record.agentId.toUpperCase(),
      title: record.title,
      recentConversation: record.recentConversation,
      model: record.model,
      cwd: record.cwd,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      relativeTimeLabel: formatRelativeTime(currentNow, record.updatedAtMs),
      canResume: Boolean(policy && canRunCommand(policy.command)),
      resumeCommandPreview:
        command.length > 0 ? formatAgentCommandForShell(command) : ""
    };
  }
}

function limitRecordsPerAgent(
  records: readonly RuntimeRecord[],
  maximumPerAgent: number
): RuntimeRecord[] {
  const counts = new Map<AgentId, number>();
  return records.filter((record) => {
    const count = counts.get(record.agentId) ?? 0;
    if (count >= maximumPerAgent) return false;
    counts.set(record.agentId, count + 1);
    return true;
  });
}

function normalizeRecord(
  agentId: AgentId,
  record: AgentExternalSessionRecordProjection
): RuntimeRecord {
  const title = meaningfulTitle(record.title, record.sessionId)
    ? record.title!.trim()
    : `${displayName(agentId)} session`;
  const updatedAtMs = Number.isFinite(record.updatedAtMs)
    ? record.updatedAtMs
    : record.updatedAt
      ? Date.parse(record.updatedAt)
      : 0;
  return {
    ...record,
    agentId,
    key: `${agentId}:${record.sessionId}`,
    title,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    updatedAt: record.updatedAt ?? new Date(updatedAtMs).toISOString()
  };
}

function mergeRecords(records: readonly RuntimeRecord[]): RuntimeRecord[] {
  const latest = new Map<string, RuntimeRecord>();
  for (const record of records) {
    const previous = latest.get(record.key);
    if (!previous || record.updatedAtMs > previous.updatedAtMs) {
      latest.set(record.key, record);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.key.localeCompare(right.key)
  );
}

function toResumeSpec(
  record: RuntimeRecord,
  policy: ResolvedAgentLaunchPolicy
): MaterializedExternalSessionResumeSpec {
  return {
    key: record.key,
    vendor: record.agentId,
    agentSessionRef: {
      vendor: record.agentId,
      externalKey: record.key,
      sessionId: record.sessionId
    },
    title: record.title,
    target: { kind: "local" },
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    launch: {
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      initialInput: `${formatAgentCommandForShell([
        policy.command,
        ...policy.args
      ])}\r`,
      title: record.title
    }
  };
}

function decodeProjectionResult(
  value: unknown,
  maximumRecords: number
): AgentExternalSessionProjectionResult {
  if (!isObject(value) || !Array.isArray(value.records)) {
    throw new TypeError("agent session projection result is invalid");
  }
  if (value.records.length > maximumRecords) {
    throw new RangeError("agent session projection exceeds its record bound");
  }
  if (typeof value.truncated !== "boolean") {
    throw new TypeError("agent session projection truncation is invalid");
  }
  return {
    records: value.records.map(decodeProjectionRecord),
    truncated: value.truncated
  };
}

function decodeProjectionRecord(
  value: unknown
): AgentExternalSessionRecordProjection {
  if (!isObject(value)) {
    throw new TypeError("agent session projection record is invalid");
  }
  const sessionId = boundedString(value.sessionId, 512, "session id");
  if (
    typeof value.updatedAtMs !== "number" ||
    !Number.isFinite(value.updatedAtMs) ||
    value.updatedAtMs < 0
  ) {
    throw new TypeError("agent session updated time is invalid");
  }
  return {
    sessionId,
    ...optionalBoundedString(value, "title", 512),
    ...optionalBoundedString(value, "recentConversation", 16_384),
    ...optionalBoundedString(value, "model", 512),
    ...optionalBoundedString(value, "cwd", 8_192),
    ...optionalBoundedString(value, "createdAt", 128),
    ...optionalBoundedString(value, "updatedAt", 128),
    updatedAtMs: value.updatedAtMs
  };
}

function optionalBoundedString(
  object: Record<string, unknown>,
  key: string,
  maximumBytes: number
): Record<string, string> {
  const value = object[key];
  return value === undefined
    ? {}
    : { [key]: boundedString(value, maximumBytes, key) };
}

function boundedString(value: unknown, maximumBytes: number, label: string) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new TypeError(`agent session ${label} is invalid`);
  }
  return value;
}

function meaningfulTitle(
  title: string | undefined,
  sessionId: string
): boolean {
  const trimmed = title?.trim() ?? "";
  if (
    !trimmed ||
    trimmed.includes(sessionId) ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<system-reminder")
  ) {
    return false;
  }
  return !(/^[0-9a-f_-]+$/iu.test(trimmed) && trimmed.length >= 24);
}

function displayName(agentId: AgentId): string {
  return agentId
    .replace(/[._-]+/gu, " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function formatRelativeTime(now: Date, updatedAtMs: number): string {
  const deltaMs = Math.max(0, now.getTime() - updatedAtMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) return `${Math.floor(deltaMs / 1000)}s`;
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}m`;
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}h`;
  return `${Math.floor(deltaMs / day)}d`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
