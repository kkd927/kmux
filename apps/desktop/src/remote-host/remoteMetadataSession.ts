import { createHash } from "node:crypto";

import {
  IncrementalCoreHistoryJsonlParser,
  IncrementalCoreUsageParser,
  METADATA_SOURCE_CONTRACT,
  aggregateCoreUsageSamples,
  applyCoreHistoryClaim,
  cloneCoreUsageParserState,
  coreUsageSampleIdentity,
  createCoreUsageParserState,
  dedupeCoreUsageSamples,
  fallbackCoreHistoryRecord,
  mergeCoreHistoryRecords,
  parseAntigravityConversationRows,
  parseCoreHistorySource,
  shouldReplaceCoreUsageSample,
  type CoreHistoryClaim,
  type CoreHistoryRecord,
  type CoreUsageEventSample,
  type CoreUsageParserState
} from "@kmux/metadata/core";
import type {
  AgentScopeSettings,
  Id,
  RemoteBridgeResponseBody,
  RemoteMetadataClaimDto,
  RemoteMetadataSourceClaimDto,
  RemoteMetadataSourceDto
} from "@kmux/proto";

import type {
  LinuxX64RemoteRuntime,
  RemoteHistoryScan,
  RemoteMetadataSourceQuery,
  RemoteMetadataSourceRead,
  RemoteMetadataSourcesList,
  RemoteUsageScan
} from "./linuxX64RemoteRuntime";
import { RemoteRuntimeError } from "./linuxX64RemoteRuntime";

type RemoteMetadataRuntime = Pick<
  LinuxX64RemoteRuntime,
  "listMetadataSources" | "readMetadataSource" | "queryMetadataSource"
>;

interface UsageSourceState {
  source: RemoteMetadataSourceDto;
  fingerprint: string;
  cursor: number;
  parser: IncrementalCoreUsageParser;
  samples: Map<string, CoreUsageEventSample>;
  continuity?: SourceContinuity;
}

interface HistorySourceState {
  source: RemoteMetadataSourceDto;
  fingerprint: string;
  cursor: number;
  accumulator?: IncrementalCoreHistoryJsonlParser;
  records: CoreHistoryRecord[];
  continuity?: SourceContinuity;
}

interface SourceContinuity {
  offset: number;
  length: number;
  sha256: string;
}

interface LastHistorySnapshot {
  records: RemoteHistoryScan["records"];
  truncated: boolean;
}

interface UsageSnapshot {
  records: RemoteUsageScan["records"];
  truncated: boolean;
}

export interface RemoteMetadataSessionLimits {
  continuityBytes: number;
  maxHistoryRecords: number;
  maxJsonlLineBytes: number;
  maxReadBytes: number;
  maxRefreshBytes: number;
  maxSourceBytesPerRefresh: number;
  maxUsageSamples: number;
}

interface MetadataRefreshBudget {
  historyRecords: number;
  totalBytes: number;
  sourceBytes: Map<string, number>;
  usageSamples: number;
}

const DEFAULT_LIMITS: RemoteMetadataSessionLimits = Object.freeze({
  continuityBytes: 4 * 1024,
  maxHistoryRecords: 65_536,
  maxJsonlLineBytes: 1024 * 1024,
  maxReadBytes: Math.min(
    METADATA_SOURCE_CONTRACT.limits.sourceReadBytes,
    256 * 1024
  ),
  maxRefreshBytes: 32 * 1024 * 1024,
  maxSourceBytesPerRefresh: 8 * 1024 * 1024,
  maxUsageSamples: 16_384
});
const ANTIGRAVITY_EDGE_QUERY_ROWS = 2;

export class RemoteMetadataSession {
  private settingsSignature: string | undefined;
  private refreshSettingsSignature: string | undefined;
  private readonly pendingRefreshes = new Set<"usage" | "history">();
  private refreshPromise: Promise<void> | undefined;
  private refreshUsageStartAtUnixMs: number | undefined;
  private usageRetainedFromUnixMs: number | undefined;
  private usageParserState: CoreUsageParserState = createCoreUsageParserState();
  private usageSources = new Map<string, UsageSourceState>();
  private historySources = new Map<string, HistorySourceState>();
  private historyClaims = new Map<string, RemoteMetadataClaimDto>();
  private usageInventoryTruncated = false;
  private historyInventoryTruncated = false;
  private lastHistory: LastHistorySnapshot | undefined;
  private readonly limits: RemoteMetadataSessionLimits;

  constructor(
    private readonly options: {
      runtime: RemoteMetadataRuntime;
      desktopInstallationId: Id;
      targetId: Id;
      principal: { uid: number; accountName: string };
      limits?: Partial<RemoteMetadataSessionLimits>;
    }
  ) {
    this.limits = metadataSessionLimits(options.limits);
  }

  async scanUsage(request: {
    startAtUnixMs: number;
    maxRecords: number;
    agentSettings?: AgentScopeSettings;
  }): Promise<RemoteUsageScan> {
    try {
      await this.scheduleRefresh(
        "usage",
        request.agentSettings,
        request.startAtUnixMs
      );
      const snapshot = this.buildUsageSnapshot(
        request.startAtUnixMs,
        request.maxRecords
      );
      return this.usageResponse(snapshot);
    } catch (error) {
      if (
        !canUseStaleMetadataSnapshot(error) ||
        this.usageRetainedFromUnixMs === undefined ||
        request.startAtUnixMs < this.usageRetainedFromUnixMs
      ) {
        throw error;
      }
      return this.usageResponse({
        ...this.buildUsageSnapshot(request.startAtUnixMs, request.maxRecords),
        truncated: true
      });
    }
  }

  async scanHistory(request: {
    maxRecords: number;
    agentSettings?: AgentScopeSettings;
  }): Promise<RemoteHistoryScan> {
    try {
      await this.scheduleRefresh("history", request.agentSettings);
      const snapshot = this.buildHistorySnapshot(request.maxRecords);
      this.lastHistory = snapshot;
      return this.historyResponse(snapshot);
    } catch (error) {
      if (!canUseStaleMetadataSnapshot(error) || !this.lastHistory) throw error;
      return this.historyResponse({
        records: this.lastHistory.records.slice(0, request.maxRecords),
        truncated: true
      });
    }
  }

  clear(): void {
    this.usageSources.clear();
    this.historySources.clear();
    this.historyClaims.clear();
    this.usageInventoryTruncated = false;
    this.historyInventoryTruncated = false;
    this.usageParserState.codexContexts.clear();
    this.usageParserState.codexTotals.clear();
    this.usageParserState.antigravityContexts.clear();
    this.usageParserState.antigravityWorkspaceByConversation.clear();
    this.lastHistory = undefined;
    this.refreshUsageStartAtUnixMs = undefined;
    this.usageRetainedFromUnixMs = undefined;
    this.settingsSignature = undefined;
  }

  private scheduleRefresh(
    purpose: "usage" | "history",
    agentSettings: AgentScopeSettings | undefined,
    usageStartAtUnixMs?: number
  ): Promise<void> {
    const signature = stableSettingsSignature(agentSettings);
    if (
      this.refreshPromise &&
      this.refreshSettingsSignature !== undefined &&
      this.refreshSettingsSignature !== signature
    ) {
      return this.refreshPromise
        .catch(() => undefined)
        .then(() =>
          this.scheduleRefresh(purpose, agentSettings, usageStartAtUnixMs)
        );
    }
    this.requireSettings(agentSettings);
    this.pendingRefreshes.add(purpose);
    if (purpose === "usage" && usageStartAtUnixMs !== undefined) {
      this.refreshUsageStartAtUnixMs = Math.min(
        this.refreshUsageStartAtUnixMs ?? usageStartAtUnixMs,
        usageStartAtUnixMs
      );
    }
    if (!this.refreshPromise) {
      this.refreshSettingsSignature = signature;
      this.refreshPromise = this.drainRefreshes(agentSettings).finally(() => {
        this.refreshPromise = undefined;
        this.refreshSettingsSignature = undefined;
        this.refreshUsageStartAtUnixMs = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async drainRefreshes(
    agentSettings: AgentScopeSettings | undefined
  ): Promise<void> {
    while (true) {
      await Promise.resolve();
      if (this.pendingRefreshes.size === 0) return;
      const purposes = new Set(this.pendingRefreshes);
      this.pendingRefreshes.clear();
      if (purposes.has("usage")) {
        const startAtUnixMs = this.refreshUsageStartAtUnixMs;
        if (startAtUnixMs === undefined) {
          throw new Error("usage metadata refresh lost its requested range");
        }
        await this.withStaleSourceRetry(() =>
          this.refreshUsage(agentSettings, startAtUnixMs)
        );
      }
      if (purposes.has("history")) {
        await this.withStaleSourceRetry(() =>
          this.refreshHistory(agentSettings)
        );
      }
    }
  }

  private requireSettings(settings: AgentScopeSettings | undefined): void {
    const signature = stableSettingsSignature(settings);
    if (this.settingsSignature === undefined) {
      this.settingsSignature = signature;
      return;
    }
    if (this.settingsSignature === signature) return;
    this.clear();
    this.settingsSignature = signature;
  }

  private async refreshUsage(
    agentSettings: AgentScopeSettings | undefined,
    startAtUnixMs: number
  ): Promise<void> {
    const inventory = await this.options.runtime.listMetadataSources({
      desktopInstallationId: this.options.desktopInstallationId,
      targetId: this.options.targetId,
      purpose: "usage",
      ...(agentSettings === undefined ? {} : { agentSettings })
    });
    requireSourceInventory(inventory, this.options.targetId, "usage");

    const resetForEarlierRange =
      !inventory.truncated &&
      this.usageRetainedFromUnixMs !== undefined &&
      startAtUnixMs < this.usageRetainedFromUnixMs;
    const parserState = resetForEarlierRange
      ? createCoreUsageParserState()
      : cloneCoreUsageParserState(this.usageParserState);
    const sources = resetForEarlierRange
      ? new Map<string, UsageSourceState>()
      : cloneUsageSources(this.usageSources, parserState);
    for (const state of sources.values()) {
      for (const [identity, sample] of state.samples) {
        if (sample.timestampMs < startAtUnixMs) state.samples.delete(identity);
      }
    }
    const listedSources = dedupeInventorySources("usage", inventory.sources);
    if (!inventory.truncated) {
      parserState.antigravityWorkspaceByConversation.clear();
    }
    const present = new Set(
      listedSources.map((source) => metadataSourceKey("usage", source))
    );
    if (!inventory.truncated) {
      for (const [key, state] of sources) {
        if (present.has(key)) continue;
        state.parser.reset();
        sources.delete(key);
      }
    }
    const budget: MetadataRefreshBudget = {
      historyRecords: 0,
      totalBytes: 0,
      sourceBytes: new Map(),
      usageSamples: [...sources.values()].reduce(
        (total, state) => total + state.samples.size,
        0
      )
    };
    requireUsageSampleBudget(budget, this.limits);
    for (const source of listedSources) {
      const key = metadataSourceKey("usage", source);
      await this.refreshUsageSource(
        sources,
        parserState,
        budget,
        key,
        source,
        startAtUnixMs
      );
    }
    this.usageSources = sources;
    this.usageParserState = parserState;
    this.usageRetainedFromUnixMs = inventory.truncated
      ? Math.max(this.usageRetainedFromUnixMs ?? startAtUnixMs, startAtUnixMs)
      : startAtUnixMs;
    this.usageInventoryTruncated = inventory.truncated;
  }

  private async refreshUsageSource(
    sources: Map<string, UsageSourceState>,
    parserState: CoreUsageParserState,
    budget: MetadataRefreshBudget,
    key: string,
    source: RemoteMetadataSourceDto,
    startAtUnixMs: number
  ): Promise<void> {
    if (source.format !== "jsonl") return;
    const size = safeDecimalNumber(source.size, "metadata source size");
    const fingerprint = metadataSourceFingerprint(source);
    const virtualPath = metadataVirtualPath(source);
    const claim = toCoreHistoryClaim(source.claim);
    if (source.vendor === "antigravity") {
      if (claim.cwd) {
        parserState.antigravityWorkspaceByConversation.set(
          claim.sessionId,
          claim.cwd
        );
      } else {
        parserState.antigravityWorkspaceByConversation.delete(claim.sessionId);
      }
    }
    let state = sources.get(key);
    const previousSize = state
      ? safeDecimalNumber(state.source.size, "metadata source size")
      : undefined;
    if (state?.cursor === size && state.fingerprint === fingerprint) {
      state.source = source;
      return;
    }
    let reset =
      !state ||
      state.source.fileIdentity !== source.fileIdentity ||
      size < state.cursor ||
      (size === previousSize && state.fingerprint !== fingerprint);
    let tail = "";
    if (!reset && state && state.cursor > 0) {
      const verifiedTail = await this.verifySourceContinuity(
        key,
        source,
        state.continuity,
        budget
      );
      if (verifiedTail === undefined) reset = true;
      else tail = verifiedTail;
    }
    if (reset || !state) {
      if (state) budget.usageSamples -= state.samples.size;
      state?.parser.reset();
      state = {
        source,
        fingerprint,
        cursor: 0,
        parser: new IncrementalCoreUsageParser(
          source.vendor,
          virtualPath,
          parserState,
          { maximumPendingBytes: this.limits.maxJsonlLineBytes }
        ),
        samples: new Map()
      };
      sources.set(key, state);
      tail = "";
    }
    reserveTransferBytes(budget, key, size - state.cursor, this.limits);
    while (state.cursor < size) {
      const chunk = await this.options.runtime.readMetadataSource({
        sourceId: source.sourceId,
        offset: state.cursor,
        maxBytes: this.limits.maxReadBytes
      });
      requireSourceRead(chunk, source, state.cursor);
      const nextOffset = safeDecimalNumber(
        chunk.nextOffset,
        "metadata source next offset"
      );
      if (nextOffset <= state.cursor) {
        throw new Error("metadata source read made no progress");
      }
      state.cursor = nextOffset;
      tail = utf8Tail(tail + chunk.content, this.limits.continuityBytes);
      for (const parsed of state.parser.append(
        chunk.content,
        { fromMs: startAtUnixMs },
        {
          eof: chunk.eof
        }
      )) {
        if (parsed.sessionId !== source.claim.sessionId) {
          continue;
        }
        if (
          parsed.timestampMs <
          safeDecimalNumber(
            source.claim.claimedAtUnixMs,
            "metadata claim timestamp"
          )
        ) {
          continue;
        }
        const sample: CoreUsageEventSample = {
          ...parsed,
          sessionId: source.claim.sessionId,
          cwd: absolutePath(parsed.cwd),
          projectPath:
            absolutePath(parsed.projectPath) ?? absolutePath(parsed.cwd)
        };
        const identity = coreUsageSampleIdentity(sample);
        const existing = state.samples.get(identity);
        if (!existing || shouldReplaceCoreUsageSample(existing, sample)) {
          if (!existing) {
            budget.usageSamples += 1;
            requireUsageSampleBudget(budget, this.limits);
          }
          state.samples.set(identity, sample);
        }
      }
      if (chunk.eof) break;
    }
    state.source = source;
    state.fingerprint = fingerprint;
    state.continuity = sourceContinuity(tail, state.cursor);
  }

  private async refreshHistory(
    agentSettings: AgentScopeSettings | undefined
  ): Promise<void> {
    const inventory = await this.options.runtime.listMetadataSources({
      desktopInstallationId: this.options.desktopInstallationId,
      targetId: this.options.targetId,
      purpose: "history",
      ...(agentSettings === undefined ? {} : { agentSettings })
    });
    requireSourceInventory(inventory, this.options.targetId, "history");
    const nextClaims = inventory.truncated
      ? new Map(this.historyClaims)
      : new Map<string, RemoteMetadataClaimDto>();
    for (const claim of inventory.claims) {
      nextClaims.set(`${claim.vendor}:${claim.sessionId}`, claim);
    }
    const sources = cloneHistorySources(this.historySources);
    const listedSources = dedupeInventorySources("history", inventory.sources);
    const present = new Set(
      listedSources.map((source) => metadataSourceKey("history", source))
    );
    if (!inventory.truncated) {
      for (const key of sources.keys()) {
        if (!present.has(key)) sources.delete(key);
      }
    }
    const budget: MetadataRefreshBudget = {
      historyRecords: [...sources.values()].reduce(
        (total, state) => total + (state.accumulator?.records().length ?? 0),
        0
      ),
      totalBytes: 0,
      sourceBytes: new Map(),
      usageSamples: 0
    };
    requireHistoryRecordBudget(budget, this.limits);
    for (const source of listedSources) {
      const key = metadataSourceKey("history", source);
      await this.refreshHistorySource(sources, budget, key, source);
    }
    this.historySources = sources;
    this.historyClaims = nextClaims;
    this.historyInventoryTruncated = inventory.truncated;
  }

  private async refreshHistorySource(
    sources: Map<string, HistorySourceState>,
    budget: MetadataRefreshBudget,
    key: string,
    source: RemoteMetadataSourceDto
  ): Promise<void> {
    const size = safeDecimalNumber(source.size, "metadata source size");
    const fingerprint = metadataSourceFingerprint(source);
    let state = sources.get(key);
    const previousRetainedRecords = state?.accumulator?.records().length ?? 0;
    const previousSize = state
      ? safeDecimalNumber(state.source.size, "metadata source size")
      : undefined;
    if (state?.cursor === size && state.fingerprint === fingerprint) {
      state.source = source;
      return;
    }
    let reset =
      !state ||
      state.source.fileIdentity !== source.fileIdentity ||
      size < state.cursor ||
      (size === previousSize && state.fingerprint !== fingerprint) ||
      (source.format === "sqlite" && state.fingerprint !== fingerprint);
    let tail = "";
    if (!reset && state && source.format === "jsonl" && state.cursor > 0) {
      const verifiedTail = await this.verifySourceContinuity(
        key,
        source,
        state.continuity,
        budget
      );
      if (verifiedTail === undefined) reset = true;
      else tail = verifiedTail;
    }
    if (reset || !state) {
      state = {
        source,
        fingerprint,
        cursor: 0,
        ...(source.format === "jsonl"
          ? {
              accumulator: new IncrementalCoreHistoryJsonlParser(512, {
                maximumPendingBytes: this.limits.maxJsonlLineBytes
              })
            }
          : {}),
        records: []
      };
      sources.set(key, state);
      tail = "";
    }
    if (source.format === "sqlite") {
      const rows = await this.readConversationEdgeRows(source, budget, key);
      const record = parseAntigravityConversationRows({
        logicalName: `/${source.logicalName}`,
        mtimeMs: safeDecimalNumber(source.mtimeUnixMs, "metadata source mtime"),
        rows,
        claim: identityHistoryClaim(source.claim)
      });
      state.records = record ? [record] : [];
      state.cursor = size;
      state.source = source;
      state.fingerprint = fingerprint;
      state.continuity = undefined;
      return;
    }
    const accumulator =
      state.accumulator ??
      new IncrementalCoreHistoryJsonlParser(512, {
        maximumPendingBytes: this.limits.maxJsonlLineBytes
      });
    state.accumulator = accumulator;
    reserveTransferBytes(budget, key, size - state.cursor, this.limits);
    while (state.cursor < size) {
      const chunk = await this.options.runtime.readMetadataSource({
        sourceId: source.sourceId,
        offset: state.cursor,
        maxBytes: this.limits.maxReadBytes
      });
      requireSourceRead(chunk, source, state.cursor);
      const nextOffset = safeDecimalNumber(
        chunk.nextOffset,
        "metadata source next offset"
      );
      if (nextOffset <= state.cursor) {
        throw new Error("metadata source read made no progress");
      }
      state.cursor = nextOffset;
      tail = utf8Tail(tail + chunk.content, this.limits.continuityBytes);
      accumulator.append(chunk.content, { eof: chunk.eof });
      if (chunk.eof) break;
    }
    state.records = parseCoreHistorySource({
      vendor: source.vendor,
      role: source.role,
      logicalName: `/${source.logicalName}`,
      mtimeMs: safeDecimalNumber(source.mtimeUnixMs, "metadata source mtime"),
      records: accumulator.records(),
      ...(source.role === "antigravity-history"
        ? {}
        : { claim: identityHistoryClaim(source.claim) })
    });
    state.source = source;
    state.fingerprint = fingerprint;
    state.continuity = sourceContinuity(tail, state.cursor);
    budget.historyRecords +=
      accumulator.records().length - previousRetainedRecords;
    requireHistoryRecordBudget(budget, this.limits);
  }

  private async verifySourceContinuity(
    key: string,
    source: RemoteMetadataSourceDto,
    continuity: SourceContinuity | undefined,
    budget: MetadataRefreshBudget
  ): Promise<string | undefined> {
    if (!continuity || continuity.length === 0) return undefined;
    reserveTransferBytes(budget, key, continuity.length, this.limits);
    const read = await this.options.runtime.readMetadataSource({
      sourceId: source.sourceId,
      offset: continuity.offset,
      maxBytes: continuity.length
    });
    requireSourceRead(read, source, continuity.offset);
    const nextOffset = safeDecimalNumber(
      read.nextOffset,
      "metadata continuity next offset"
    );
    if (
      nextOffset !== continuity.offset + continuity.length ||
      Buffer.byteLength(read.content, "utf8") !== continuity.length ||
      sha256(read.content) !== continuity.sha256
    ) {
      return undefined;
    }
    return read.content;
  }

  private async readConversationEdgeRows(
    source: RemoteMetadataSourceDto,
    budget: MetadataRefreshBudget,
    key: string
  ): Promise<RemoteMetadataSourceQuery["rows"]> {
    const queryId =
      METADATA_SOURCE_CONTRACT.queries.antigravityConversationSteps.id;
    const result = await this.options.runtime.queryMetadataSource({
      sourceId: source.sourceId,
      queryId,
      maxRows: ANTIGRAVITY_EDGE_QUERY_ROWS
    });
    if (result.fileIdentity !== source.fileIdentity) {
      throw new RemoteRuntimeError(
        "stale_source",
        "metadata query source identity changed",
        true
      );
    }
    if (
      result.rows.length > ANTIGRAVITY_EDGE_QUERY_ROWS ||
      result.nextPageToken !== undefined
    ) {
      throw new Error("metadata edge query returned an unbounded result");
    }
    reserveTransferBytes(
      budget,
      key,
      result.rows.reduce(
        (bytes, row) =>
          bytes + Buffer.byteLength(row.payloadBase64, "utf8") + 128,
        0
      ),
      this.limits
    );
    return result.rows;
  }

  private buildUsageSnapshot(
    startAtUnixMs: number,
    maxRecords: number
  ): UsageSnapshot {
    const samples = aggregateCoreUsageSamples(
      dedupeCoreUsageSamples(
        [...this.usageSources.values()].flatMap((state) =>
          [...state.samples.values()].map((sample) =>
            applyUsageClaim(sample, state.source.claim)
          )
        )
      ).filter((sample) => sample.timestampMs >= startAtUnixMs)
    ).sort(
      (left, right) =>
        right.timestampMs - left.timestampMs ||
        coreUsageSampleIdentity(left).localeCompare(
          coreUsageSampleIdentity(right)
        )
    );
    const truncated =
      this.usageInventoryTruncated || samples.length > maxRecords;
    return {
      truncated,
      records: samples.slice(0, maxRecords).map(toRemoteUsageRecord)
    };
  }

  private buildHistorySnapshot(maxRecords: number): LastHistorySnapshot {
    const records: CoreHistoryRecord[] = [];
    const representedClaims = new Set<string>();
    const claims = new Map<
      string,
      { vendor: RemoteMetadataSourceDto["vendor"]; claim: CoreHistoryClaim }
    >();
    for (const listed of this.historyClaims.values()) {
      claims.set(`${listed.vendor}:${listed.sessionId}`, {
        vendor: listed.vendor,
        claim: toCoreHistoryClaim(listed)
      });
    }
    for (const state of this.historySources.values()) {
      for (const record of state.records) {
        const owned = claims.get(record.key);
        if (!owned) continue;
        records.push(applyCoreHistoryClaim(record, owned.claim));
        representedClaims.add(record.key);
      }
    }
    for (const [key, claim] of claims) {
      if (!representedClaims.has(key)) {
        records.push(fallbackCoreHistoryRecord(claim));
      }
    }
    const merged = mergeCoreHistoryRecords(records, { maxRecords });
    return {
      truncated:
        this.historyInventoryTruncated ||
        merged.truncated ||
        [...this.historySources.values()].some(
          (state) => state.accumulator?.truncated === true
        ),
      records: merged.records.map((record) => ({
        vendor: record.vendor,
        sessionId: record.sessionId,
        updatedAtUnixMs: Math.max(0, Math.trunc(record.updatedAtMs)).toString(
          10
        ),
        canResume: true,
        ...(absolutePath(record.cwd) === undefined
          ? {}
          : { cwd: absolutePath(record.cwd) }),
        ...(record.title ? { title: boundedText(record.title, 96) } : {}),
        ...(record.recentConversation
          ? { recentConversation: boundedText(record.recentConversation, 220) }
          : {}),
        ...(record.model ? { model: boundedText(record.model, 128) } : {}),
        ...(record.createdAt === undefined
          ? {}
          : { createdAt: boundedText(record.createdAt, 256) }),
        ...(record.updatedAt === undefined
          ? {}
          : { updatedAt: boundedText(record.updatedAt, 256) })
      }))
    };
  }

  private usageResponse(snapshot: UsageSnapshot): RemoteUsageScan {
    return {
      type: "usage.scanned",
      targetId: this.options.targetId,
      principal: { ...this.options.principal },
      truncated: snapshot.truncated,
      records: structuredClone(snapshot.records)
    };
  }

  private historyResponse(snapshot: LastHistorySnapshot): RemoteHistoryScan {
    return {
      type: "history.scanned",
      targetId: this.options.targetId,
      principal: { ...this.options.principal },
      truncated: snapshot.truncated,
      records: structuredClone(snapshot.records)
    };
  }

  private async withStaleSourceRetry<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof RemoteRuntimeError) ||
        error.code !== "stale_source"
      ) {
        throw error;
      }
      return await operation();
    }
  }
}

function metadataSessionLimits(
  overrides: Partial<RemoteMetadataSessionLimits> | undefined
): RemoteMetadataSessionLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`remote metadata ${name} limit is invalid`);
    }
  }
  if (
    limits.maxReadBytes > METADATA_SOURCE_CONTRACT.limits.sourceReadBytes ||
    limits.continuityBytes > limits.maxReadBytes ||
    limits.maxSourceBytesPerRefresh > limits.maxRefreshBytes
  ) {
    throw new TypeError("remote metadata limits violate the source contract");
  }
  return Object.freeze(limits);
}

function cloneUsageSources(
  sources: ReadonlyMap<string, UsageSourceState>,
  parserState: CoreUsageParserState
): Map<string, UsageSourceState> {
  return new Map(
    [...sources].map(([key, state]) => [
      key,
      {
        source: state.source,
        fingerprint: state.fingerprint,
        cursor: state.cursor,
        parser: state.parser.clone(parserState),
        samples: new Map(state.samples),
        ...(state.continuity === undefined
          ? {}
          : { continuity: { ...state.continuity } })
      }
    ])
  );
}

function cloneHistorySources(
  sources: ReadonlyMap<string, HistorySourceState>
): Map<string, HistorySourceState> {
  return new Map(
    [...sources].map(([key, state]) => [
      key,
      {
        source: state.source,
        fingerprint: state.fingerprint,
        cursor: state.cursor,
        ...(state.accumulator === undefined
          ? {}
          : { accumulator: state.accumulator.clone() }),
        records: [...state.records],
        ...(state.continuity === undefined
          ? {}
          : { continuity: { ...state.continuity } })
      }
    ])
  );
}

function dedupeInventorySources(
  purpose: "usage" | "history",
  sources: readonly RemoteMetadataSourceDto[]
): RemoteMetadataSourceDto[] {
  const deduped = new Map<string, RemoteMetadataSourceDto>();
  for (const source of sources) {
    const key = metadataSourceKey(purpose, source);
    if (!deduped.has(key)) deduped.set(key, source);
  }
  return [...deduped.values()];
}

function reserveTransferBytes(
  budget: MetadataRefreshBudget,
  sourceKey: string,
  bytes: number,
  limits: RemoteMetadataSessionLimits
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError("metadata transfer byte count is invalid");
  }
  const sourceBytes = (budget.sourceBytes.get(sourceKey) ?? 0) + bytes;
  const totalBytes = budget.totalBytes + bytes;
  if (
    sourceBytes > limits.maxSourceBytesPerRefresh ||
    totalBytes > limits.maxRefreshBytes
  ) {
    throw new Error("metadata source refresh exceeded its transfer budget");
  }
  budget.sourceBytes.set(sourceKey, sourceBytes);
  budget.totalBytes = totalBytes;
}

function requireUsageSampleBudget(
  budget: MetadataRefreshBudget,
  limits: RemoteMetadataSessionLimits
): void {
  if (budget.usageSamples > limits.maxUsageSamples) {
    throw new Error("metadata usage refresh exceeded its sample budget");
  }
}

function requireHistoryRecordBudget(
  budget: MetadataRefreshBudget,
  limits: RemoteMetadataSessionLimits
): void {
  if (budget.historyRecords > limits.maxHistoryRecords) {
    throw new Error("metadata history refresh exceeded its record budget");
  }
}

function utf8Tail(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function sourceContinuity(
  tail: string,
  cursor: number
): SourceContinuity | undefined {
  const length = Buffer.byteLength(tail, "utf8");
  if (length === 0) return undefined;
  return {
    offset: cursor - length,
    length,
    sha256: sha256(tail)
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityHistoryClaim(
  claim: RemoteMetadataSourceClaimDto
): CoreHistoryClaim {
  return { sessionId: claim.sessionId };
}

function applyUsageClaim(
  sample: CoreUsageEventSample,
  remoteClaim: RemoteMetadataSourceClaimDto
): CoreUsageEventSample {
  const claim = toCoreHistoryClaim(remoteClaim);
  return {
    ...sample,
    sessionId: claim.sessionId,
    cwd: absolutePath(sample.cwd) ?? claim.cwd,
    projectPath:
      absolutePath(sample.projectPath) ?? absolutePath(sample.cwd) ?? claim.cwd
  };
}

function requireSourceInventory(
  inventory: RemoteMetadataSourcesList,
  targetId: Id,
  purpose: "usage" | "history"
): void {
  if (
    inventory.targetId !== targetId ||
    inventory.purpose !== purpose ||
    inventory.contractVersion !== METADATA_SOURCE_CONTRACT.version
  ) {
    throw new Error("metadata source inventory escaped its target contract");
  }
  if (purpose === "usage" && inventory.claims.length !== 0) {
    throw new Error("usage metadata inventory unexpectedly exposed claims");
  }
  const claimKeys = new Set(
    inventory.claims.map((claim) => `${claim.vendor}\t${claim.sessionId}`)
  );
  const sourcesByKey = new Map<string, RemoteMetadataSourceDto>();
  for (const source of inventory.sources) {
    const definition = METADATA_SOURCE_CONTRACT.sources.find(
      (candidate) =>
        candidate.vendor === source.vendor &&
        candidate.role === source.role &&
        candidate.format === source.format &&
        candidate.purposes.includes(purpose)
    );
    const key = metadataSourceKey(purpose, source);
    const previous = sourcesByKey.get(key);
    if (
      !definition ||
      (previous !== undefined &&
        (source.role !== "antigravity-history" ||
          previous.fileIdentity !== source.fileIdentity ||
          previous.size !== source.size ||
          previous.mtimeUnixMs !== source.mtimeUnixMs)) ||
      (purpose === "history" &&
        !claimKeys.has(`${source.vendor}\t${source.claim.sessionId}`))
    ) {
      throw new Error("metadata source inventory violates its source contract");
    }
    sourcesByKey.set(key, source);
  }
}

function requireSourceRead(
  read: RemoteMetadataSourceRead,
  source: RemoteMetadataSourceDto,
  offset: number
): void {
  const nextOffset = safeDecimalNumber(
    read.nextOffset,
    "metadata source next offset"
  );
  const sourceSize = safeDecimalNumber(source.size, "metadata source size");
  if (
    read.sourceId !== source.sourceId ||
    read.fileIdentity !== source.fileIdentity ||
    safeDecimalNumber(read.offset, "metadata source offset") !== offset ||
    nextOffset < offset ||
    nextOffset > sourceSize ||
    nextOffset - offset !== Buffer.byteLength(read.content, "utf8") ||
    read.eof !== (nextOffset === sourceSize)
  ) {
    throw new RemoteRuntimeError(
      "stale_source",
      "metadata source identity changed during transfer",
      true
    );
  }
}

function metadataSourceKey(
  purpose: "usage" | "history",
  source: RemoteMetadataSourceDto
): string {
  if (source.role === "antigravity-history") {
    return [purpose, source.vendor, source.role, source.logicalName].join("\t");
  }
  return [
    purpose,
    source.vendor,
    source.role,
    source.claim.sessionId,
    source.logicalName
  ].join("\t");
}

function metadataSourceFingerprint(source: RemoteMetadataSourceDto): string {
  return [source.fileIdentity, source.size, source.mtimeUnixMs].join(":");
}

function metadataVirtualPath(source: RemoteMetadataSourceDto): string {
  return `/remote-metadata/${source.vendor}/${source.logicalName}`;
}

function toCoreHistoryClaim(
  claim: RemoteMetadataSourceClaimDto
): CoreHistoryClaim {
  return {
    sessionId: claim.sessionId,
    claimedAtUnixMs: safeDecimalNumber(
      claim.claimedAtUnixMs,
      "metadata claim timestamp"
    ),
    lastSeenAtUnixMs: safeDecimalNumber(
      claim.lastSeenAtUnixMs,
      "metadata claim timestamp"
    ),
    ...(absolutePath(claim.cwd) === undefined
      ? {}
      : { cwd: absolutePath(claim.cwd) }),
    workspacePaths: claim.workspacePaths.flatMap((path) =>
      absolutePath(path) ? [path] : []
    ),
    ...(claim.launchTitle === undefined
      ? {}
      : { launchTitle: claim.launchTitle })
  };
}

function toRemoteUsageRecord(
  sample: CoreUsageEventSample
): RemoteUsageScan["records"][number] {
  const identity = coreUsageSampleIdentity(sample);
  const sampleId =
    sample.aggregateId && Buffer.byteLength(sample.aggregateId, "utf8") <= 512
      ? sample.aggregateId
      : createHash("sha256").update(identity, "utf8").digest("hex");
  const inputTokens = safeTokenCount(sample.inputTokens);
  const outputTokens = safeTokenCount(sample.outputTokens);
  const thinkingTokens = safeTokenCount(sample.thinkingTokens ?? 0);
  const cacheReadTokens = safeTokenCount(
    sample.cacheReadTokens ?? sample.cacheTokens
  );
  const cacheWriteTokens = safeTokenCount(sample.cacheWriteTokens ?? 0);
  const totalTokens = safeTokenCount(sample.totalTokens);
  return {
    vendor: sample.vendor as "claude" | "codex" | "antigravity",
    sampleId,
    timestampUnixMs: safeTokenCount(sample.timestampMs).toString(10),
    ...(sample.sessionId === undefined
      ? {}
      : { sessionId: boundedText(sample.sessionId, 4 * 1024) }),
    ...(sample.model === undefined
      ? {}
      : { model: boundedText(sample.model, 128) }),
    ...(absolutePath(sample.cwd) === undefined
      ? {}
      : { cwd: absolutePath(sample.cwd) }),
    ...(absolutePath(sample.projectPath) === undefined
      ? {}
      : { projectPath: absolutePath(sample.projectPath) }),
    inputTokens: inputTokens.toString(10),
    outputTokens: outputTokens.toString(10),
    thinkingTokens: thinkingTokens.toString(10),
    cacheReadTokens: cacheReadTokens.toString(10),
    cacheWriteTokens: cacheWriteTokens.toString(10),
    cacheWriteTokensKnown: sample.cacheWriteTokensKnown ?? false,
    totalTokens: totalTokens.toString(10)
  };
}

function canUseStaleMetadataSnapshot(error: unknown): boolean {
  return error instanceof RemoteRuntimeError && error.retryable;
}

function stableSettingsSignature(
  settings: AgentScopeSettings | undefined
): string {
  return JSON.stringify(settings ?? {});
}

function safeDecimalNumber(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(`${label} exceeds the desktop safe range`);
  }
  return parsed;
}

function safeTokenCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value) || 0));
}

function absolutePath(value: string | undefined): string | undefined {
  return value?.startsWith("/") ? value : undefined;
}

function boundedText(value: string, maximumBytes: number): string {
  let output = "";
  for (const character of value) {
    if (character < " " && character !== "\t") continue;
    if (Buffer.byteLength(output + character, "utf8") > maximumBytes) break;
    output += character;
  }
  return output;
}

export type RemoteNormalizedMetadataResponse = Extract<
  RemoteBridgeResponseBody,
  { type: "usage.scanned" | "history.scanned" }
>;
