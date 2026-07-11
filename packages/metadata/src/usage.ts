import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher
} from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve
} from "node:path";
import {
  type AgentStorageRoots,
  resolveAgentStorageRoots
} from "./agentStorage";
import { readAntigravityWorkspaceByConversationFromRoot } from "./antigravityStorage";
import { estimateModelCost } from "./modelPricing";

const JSON_EXTENSIONS = new Set([".json"]);
const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const MAX_RECURSION_DEPTH = 6;
const WATCH_DEBOUNCE_MS = 180;
const SOURCE_INDEX_RESYNC_MS = 60_000;
const WATCH_ROOT_RETRY_MS = 60_000;

export type UsageVendor = "claude" | "codex" | "antigravity" | "unknown";
export type UsageCostSource = "reported" | "estimated" | "unavailable";

export interface UsageEventSample {
  vendor: UsageVendor;
  timestampMs: number;
  sourcePath: string;
  sourceType: "jsonl" | "json";
  sessionId?: string;
  threadId?: string;
  requestId?: string;
  eventId?: string;
  model?: string;
  cwd?: string;
  projectPath?: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
  cacheTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costSource?: UsageCostSource;
}

export interface UsageAdapterReadResult {
  samples: UsageEventSample[];
  sourceCount: number;
}

export interface UsageAdapterDirtyOptions {
  discoverNewSources?: boolean;
  markKnownSourcesDirty?: boolean;
}

export interface UsageAdapter {
  readonly vendor: UsageVendor;
  initialScan(startOfDayMs: number): Promise<UsageAdapterReadResult>;
  initialScanRange?(
    range: UsageTimeRange,
    cursorDayStartMs: number
  ): Promise<UsageAdapterReadResult>;
  readIncremental(startOfDayMs: number): Promise<UsageAdapterReadResult>;
  markDirty?(options?: UsageAdapterDirtyOptions): void;
  watch(onChange: () => void): () => void;
  close(): void;
}

interface CreateUsageAdaptersOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
}

export interface UsageHistoryDay {
  dayKey: string;
  totalCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
  totalTokens: number;
  vendors: Array<{
    vendor: Exclude<UsageVendor, "unknown">;
    totalCostUsd: number;
    totalTokens: number;
  }>;
}

type UsageTimeRange = {
  fromMs: number;
  toMs?: number;
};

export interface UsageStartupScanResult {
  reads: UsageAdapterReadResult[];
  historyDays?: UsageHistoryDay[];
}

interface JsonlCursor {
  kind: "jsonl";
  dayKey: string;
  offset: number;
  inode: number;
  mtimeMs: number;
}

interface JsonCursor {
  kind: "json";
  dayKey: string;
  inode: number;
  mtimeMs: number;
}

type SourceCursor = JsonCursor | JsonlCursor;

interface SourceDescriptor {
  kind: "json" | "jsonl";
  path: string;
}

type ParsedUsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  score: number;
};

type ObjectCandidate = {
  path: string;
  value: Record<string, unknown>;
};

type CodexSessionContext = {
  cwd?: string;
  model?: string;
  projectPath?: string;
  sessionId?: string;
};

type AntigravitySessionContext = {
  model?: string;
};

type TokenUsageTotals = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
};

interface FileUsageAdapterOptions {
  includeJson?: boolean;
  includeHiddenDirs?: boolean;
  watchRecursive?: boolean;
  antigravityWorkspaceByConversation?: Map<string, string>;
  antigravityWorkspaceByConversationLoader?: () => Map<string, string>;
}

class FileUsageAdapter implements UsageAdapter {
  readonly vendor: UsageVendor;

  private readonly codexContexts = new Map<string, CodexSessionContext>();
  private readonly codexTotals = new Map<string, TokenUsageTotals>();
  private readonly antigravityContexts = new Map<
    string,
    AntigravitySessionContext
  >();
  private readonly antigravityWorkspaceByConversation: Map<string, string>;
  private readonly antigravityWorkspaceByConversationLoader?: () => Map<
    string,
    string
  >;
  private readonly includeJson: boolean;
  private readonly includeHiddenDirs: boolean;
  private readonly watchRecursive: boolean;
  private readonly roots: string[];
  private readonly cursors = new Map<string, SourceCursor>();
  private readonly sources = new Map<string, SourceDescriptor>();
  private readonly dirtyPaths = new Set<string>();
  private watchers = new Set<FSWatcher>();
  private hasWatchers = false;
  private sourceIndexDirty = true;
  private dirtySourceIndex = true;
  private dayKey: string | null = null;
  private lastSourceIndexRefreshAtMs = 0;

  constructor(
    vendor: UsageVendor,
    roots: string[],
    options: FileUsageAdapterOptions = {}
  ) {
    this.vendor = vendor;
    this.roots = roots.filter(Boolean);
    this.antigravityWorkspaceByConversationLoader =
      options.antigravityWorkspaceByConversationLoader;
    this.antigravityWorkspaceByConversation =
      options.antigravityWorkspaceByConversation ??
      options.antigravityWorkspaceByConversationLoader?.() ??
      new Map();
    this.includeJson = options.includeJson ?? false;
    this.includeHiddenDirs = options.includeHiddenDirs ?? false;
    this.watchRecursive = options.watchRecursive ?? false;
  }

  async initialScan(startOfDayMs: number): Promise<UsageAdapterReadResult> {
    this.resetForInitialScan(startOfDayMs);
    return this.readAllSources({ fromMs: startOfDayMs }, true);
  }

  async initialScanRange(
    range: UsageTimeRange,
    cursorDayStartMs: number
  ): Promise<UsageAdapterReadResult> {
    this.resetForInitialScan(cursorDayStartMs);
    return this.readAllSources(range, true, dayKeyFor(cursorDayStartMs));
  }

  private resetForInitialScan(startOfDayMs: number): void {
    this.dayKey = dayKeyFor(startOfDayMs);
    this.codexContexts.clear();
    this.codexTotals.clear();
    this.antigravityContexts.clear();
    this.cursors.clear();
    this.sourceIndexDirty = true;
    this.dirtySourceIndex = true;
    this.dirtyPaths.clear();
  }

  async readIncremental(startOfDayMs: number): Promise<UsageAdapterReadResult> {
    const nextDayKey = dayKeyFor(startOfDayMs);
    if (this.dayKey !== nextDayKey) {
      return this.initialScan(startOfDayMs);
    }
    return this.readAllSources({ fromMs: startOfDayMs }, true);
  }

  async scanRange(range: UsageTimeRange): Promise<UsageAdapterReadResult> {
    this.codexContexts.clear();
    this.codexTotals.clear();
    this.antigravityContexts.clear();
    return this.readAllSources(range, false);
  }

  markDirty(options: UsageAdapterDirtyOptions = {}): void {
    const discoverNewSources = options.discoverNewSources ?? true;
    const markKnownSourcesDirty = options.markKnownSourcesDirty ?? true;
    if (discoverNewSources) {
      this.sourceIndexDirty = true;
      if (markKnownSourcesDirty) {
        this.dirtySourceIndex = true;
      }
    }
    if (!markKnownSourcesDirty) {
      return;
    }
    for (const sourcePath of this.sources.keys()) {
      this.dirtyPaths.add(sourcePath);
    }
  }

  watch(onChange: () => void): () => void {
    const cleanups = this.roots.map((root) => {
      let watcherCleanup = this.startWatchingRoot(root, onChange);
      if (watcherCleanup) {
        return () => {
          watcherCleanup?.();
          watcherCleanup = null;
        };
      }
      const retryTimer = setInterval(() => {
        if (watcherCleanup) {
          return;
        }
        watcherCleanup = this.startWatchingRoot(root, onChange);
        if (!watcherCleanup) {
          return;
        }
        clearInterval(retryTimer);
        this.markDirty({
          discoverNewSources: true,
          markKnownSourcesDirty: false
        });
        onChange();
      }, WATCH_ROOT_RETRY_MS);
      return () => {
        clearInterval(retryTimer);
        watcherCleanup?.();
        watcherCleanup = null;
      };
    });

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }

  close(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.hasWatchers = false;
  }

  private async readAllSources(
    range: UsageTimeRange,
    useCursors: boolean,
    cursorDayKey = dayKeyFor(range.fromMs)
  ): Promise<UsageAdapterReadResult> {
    this.refreshAntigravityWorkspaceByConversation();
    const samples: UsageEventSample[] = [];
    const sources = this.resolveSourcesForRead(useCursors);

    for (const source of sources) {
      if (source.kind === "json") {
        for (const sample of this.readJsonSource(
          source,
          range,
          useCursors,
          cursorDayKey
        )) {
          samples.push(sample);
        }
        continue;
      }
      for (const sample of this.readJsonlSource(
        source,
        range,
        useCursors,
        cursorDayKey
      )) {
        samples.push(sample);
      }
    }

    return {
      samples,
      sourceCount: this.sources.size
    };
  }

  private refreshAntigravityWorkspaceByConversation(): void {
    if (
      this.vendor !== "antigravity" ||
      !this.antigravityWorkspaceByConversationLoader
    ) {
      return;
    }
    const nextWorkspaces = this.antigravityWorkspaceByConversationLoader();
    if (
      stringMapEquals(this.antigravityWorkspaceByConversation, nextWorkspaces)
    ) {
      return;
    }
    this.antigravityWorkspaceByConversation.clear();
    for (const [conversationId, workspace] of nextWorkspaces.entries()) {
      this.antigravityWorkspaceByConversation.set(conversationId, workspace);
    }
    this.antigravityContexts.clear();
    for (const sourcePath of this.sources.keys()) {
      this.cursors.delete(sourcePath);
      this.dirtyPaths.add(sourcePath);
    }
  }

  private resolveSourcesForRead(useCursors: boolean): SourceDescriptor[] {
    if (!useCursors) {
      this.refreshSourceIndex(true);
      return Array.from(this.sources.values());
    }

    const shouldResyncSourceIndex = this.shouldResyncSourceIndex();
    if (this.sourceIndexDirty || shouldResyncSourceIndex) {
      // A low-frequency resync must also revisit known files so append-only
      // providers still catch up when a filesystem watch event is missed.
      this.refreshSourceIndex(this.dirtySourceIndex || shouldResyncSourceIndex);
      this.dirtySourceIndex = false;
    }

    if (!this.hasWatchers) {
      return Array.from(this.sources.values());
    }

    if (this.dirtyPaths.size === 0) {
      return [];
    }

    const sources = Array.from(this.dirtyPaths)
      .map((sourcePath) => this.sources.get(sourcePath))
      .filter((source): source is SourceDescriptor => Boolean(source));
    this.dirtyPaths.clear();
    return sources;
  }

  private refreshSourceIndex(markAllDirty: boolean): void {
    const nextSources = collectUsageSources(this.vendor, this.roots, {
      includeJson: this.includeJson,
      includeHiddenDirs: this.includeHiddenDirs
    });
    const nextSourceMap = new Map(
      nextSources.map((source) => [source.path, source] as const)
    );

    for (const existingPath of this.sources.keys()) {
      if (nextSourceMap.has(existingPath)) {
        continue;
      }
      this.removeTrackedSource(existingPath);
    }

    this.sources.clear();
    for (const source of nextSources) {
      this.sources.set(source.path, source);
      if (markAllDirty || !this.cursors.has(source.path)) {
        this.dirtyPaths.add(source.path);
      }
    }

    this.sourceIndexDirty = false;
    this.lastSourceIndexRefreshAtMs = Date.now();
  }

  private markSourceDirty(
    root: string,
    filename: string | Buffer | null
  ): void {
    if (!filename) {
      this.sourceIndexDirty = true;
      return;
    }

    const absolutePath = resolve(root, filename.toString());
    const stats = safeStat(absolutePath);
    if (!stats) {
      this.removeTrackedSource(absolutePath);
      return;
    }
    if (stats.isDirectory()) {
      this.sourceIndexDirty = true;
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    const source = describeUsageSource(this.vendor, absolutePath, {
      includeJson: this.includeJson,
      includeHiddenDirs: this.includeHiddenDirs
    });
    if (!source) {
      return;
    }
    this.sources.set(source.path, source);
    this.dirtyPaths.add(source.path);
  }

  private shouldResyncSourceIndex(): boolean {
    return (
      Date.now() - this.lastSourceIndexRefreshAtMs >= SOURCE_INDEX_RESYNC_MS
    );
  }

  private removeTrackedSource(sourcePath: string): void {
    this.sources.delete(sourcePath);
    this.cursors.delete(sourcePath);
    this.codexContexts.delete(sourcePath);
    this.codexTotals.delete(sourcePath);
    this.antigravityContexts.delete(sourcePath);
    this.dirtyPaths.delete(sourcePath);
  }

  private startWatchingRoot(
    root: string,
    onChange: () => void
  ): (() => void) | null {
    const watchRoot = resolveExistingWatchRoot(root);
    if (!watchRoot) {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const watcher = watch(
        watchRoot,
        { recursive: this.watchRecursive },
        (_eventType, filename) => {
          this.markSourceDirty(watchRoot, filename);
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(() => {
            timer = null;
            onChange();
          }, WATCH_DEBOUNCE_MS);
        }
      );
      this.watchers.add(watcher);
      this.hasWatchers = true;
      return () => {
        if (timer) {
          clearTimeout(timer);
        }
        watcher.close();
        this.watchers.delete(watcher);
        this.hasWatchers = this.watchers.size > 0;
      };
    } catch {
      return null;
    }
  }

  private readJsonlSource(
    source: SourceDescriptor,
    range: UsageTimeRange,
    useCursors: boolean,
    cursorDayKey: string
  ): UsageEventSample[] {
    const stats = safeStat(source.path);
    if (!stats) {
      this.removeTrackedSource(source.path);
      return [];
    }

    const previous = this.cursors.get(source.path);
    let offset =
      useCursors &&
      previous?.kind === "jsonl" &&
      previous.dayKey === cursorDayKey &&
      previous.inode === stats.ino &&
      stats.size >= previous.offset
        ? previous.offset
        : 0;

    const text = readJsonlSlice(source.path, offset, Number(stats.size));
    const samples: UsageEventSample[] = [];
    const lines = text.split("\n");
    const endedWithNewline = text.endsWith("\n");
    const completeLines = endedWithNewline
      ? lines.slice(0, -1)
      : lines.slice(0, -1);

    for (const line of completeLines) {
      offset = consumeJsonLine(
        samples,
        this.vendor,
        source.path,
        range,
        line,
        offset,
        true,
        this.codexContexts,
        this.codexTotals,
        this.antigravityContexts,
        this.antigravityWorkspaceByConversation
      );
    }

    const trailingLine = endedWithNewline ? "" : (lines.at(-1) ?? "");
    if (trailingLine) {
      offset = consumeJsonLine(
        samples,
        this.vendor,
        source.path,
        range,
        trailingLine,
        offset,
        false,
        this.codexContexts,
        this.codexTotals,
        this.antigravityContexts,
        this.antigravityWorkspaceByConversation
      );
    }

    if (useCursors) {
      this.cursors.set(source.path, {
        kind: "jsonl",
        dayKey: cursorDayKey,
        offset,
        inode: Number(stats.ino),
        mtimeMs: Number(stats.mtimeMs)
      });
    }

    return samples;
  }

  private readJsonSource(
    source: SourceDescriptor,
    range: UsageTimeRange,
    useCursors: boolean,
    cursorDayKey: string
  ): UsageEventSample[] {
    const stats = safeStat(source.path);
    if (!stats) {
      this.removeTrackedSource(source.path);
      return [];
    }

    const previous = this.cursors.get(source.path);
    if (
      useCursors &&
      previous?.kind === "json" &&
      previous.dayKey === cursorDayKey &&
      previous.inode === Number(stats.ino) &&
      previous.mtimeMs === Number(stats.mtimeMs)
    ) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(source.path, "utf8")) as Record<
        string,
        unknown
      >;
      const samples = extractUsageSamplesFromJsonDocument(
        this.vendor,
        parsed,
        source.path,
        range,
        {
          antigravityWorkspaceByConversation:
            this.antigravityWorkspaceByConversation
        }
      );
      if (useCursors) {
        this.cursors.set(source.path, {
          kind: "json",
          dayKey: cursorDayKey,
          inode: Number(stats.ino),
          mtimeMs: Number(stats.mtimeMs)
        });
      }
      return samples;
    } catch {
      return [];
    }
  }
}

export function createUsageAdapters(
  options: CreateUsageAdaptersOptions = {}
): UsageAdapter[] {
  const env = options.env ?? process.env;
  const watchRecursive = shouldUseRecursiveUsageWatch(
    options.platform ?? process.platform
  );
  const agentStorageRoots =
    options.agentStorageRoots ??
    resolveAgentStorageRoots({
      homeDir: options.homeDir,
      env
    });
  const antigravityRoots = resolveRoots(
    env.KMUX_ANTIGRAVITY_USAGE_DIR,
    agentStorageRoots.antigravity.brainDir
  );

  return [
    new FileUsageAdapter(
      "claude",
      resolveRoots(
        env.KMUX_CLAUDE_USAGE_DIR,
        agentStorageRoots.claude.projectsDir
      ),
      { watchRecursive }
    ),
    new FileUsageAdapter(
      "codex",
      resolveRoots(
        env.KMUX_CODEX_USAGE_DIR,
        agentStorageRoots.codex.sessionsDir
      ),
      { watchRecursive }
    ),
    new FileUsageAdapter("antigravity", antigravityRoots, {
      antigravityWorkspaceByConversationLoader: () =>
        readAntigravityWorkspaceByConversationFromRoot(
          agentStorageRoots.antigravity.root
        ),
      includeHiddenDirs: true,
      watchRecursive
    })
  ];
}

export async function scanUsageAdaptersAtStartup(
  adapters: UsageAdapter[],
  options: {
    startOfDayMs: number;
    historyRange?: { fromMs: number; toMs: number };
  }
): Promise<UsageStartupScanResult> {
  if (!options.historyRange) {
    return {
      reads: await Promise.all(
        adapters.map((adapter) => adapter.initialScan(options.startOfDayMs))
      )
    };
  }

  const scanResults = await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.initialScanRange) {
        const read = await adapter.initialScan(options.startOfDayMs);
        return { read, historySamples: read.samples };
      }
      const historyRead = await adapter.initialScanRange(
        options.historyRange!,
        options.startOfDayMs
      );
      return {
        read: {
          sourceCount: historyRead.sourceCount,
          samples: historyRead.samples.filter(
            (sample) => sample.timestampMs >= options.startOfDayMs
          )
        },
        historySamples: historyRead.samples
      };
    })
  );

  return {
    reads: scanResults.map((result) => result.read),
    historyDays: summarizeUsageHistorySampleGroups(
      scanResults.map((result) => result.historySamples)
    )
  };
}

export async function scanUsageHistoryDays(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  fromMs: number;
  toMs: number;
}): Promise<UsageHistoryDay[]> {
  const adapters = createUsageAdapters({
    env: options.env,
    homeDir: options.homeDir,
    agentStorageRoots: options.agentStorageRoots,
    platform: options.platform
  });
  const historySamples = new Map<string, UsageEventSample>();

  try {
    for (const adapter of adapters) {
      if (!(adapter instanceof FileUsageAdapter)) {
        continue;
      }
      const result = await adapter.scanRange({
        fromMs: options.fromMs,
        toMs: options.toMs
      });
      appendUsageHistorySamples(historySamples, result.samples);
    }
  } finally {
    for (const adapter of adapters) {
      adapter.close();
    }
  }

  return summarizeDedupedUsageHistorySamples(historySamples.values());
}

function summarizeUsageHistorySampleGroups(
  sampleGroups: Iterable<Iterable<UsageEventSample>>
): UsageHistoryDay[] {
  const historySamples = new Map<string, UsageEventSample>();
  for (const samples of sampleGroups) {
    appendUsageHistorySamples(historySamples, samples);
  }
  return summarizeDedupedUsageHistorySamples(historySamples.values());
}

function appendUsageHistorySamples(
  historySamples: Map<string, UsageEventSample>,
  samples: Iterable<UsageEventSample>
): void {
  for (const sample of samples) {
    if (sample.vendor === "unknown") {
      continue;
    }
    const identity = usageHistorySampleIdentity(sample);
    const existingSample = historySamples.get(identity);
    if (existingSample) {
      if (shouldReplaceUsageSample(existingSample, sample)) {
        historySamples.set(identity, sample);
      }
      continue;
    }
    historySamples.set(identity, sample);
  }
}

function summarizeDedupedUsageHistorySamples(
  historySamples: Iterable<UsageEventSample>
): UsageHistoryDay[] {
  const bucketMap = new Map<
    string,
    {
      dayKey: string;
      totalCostUsd: number;
      reportedCostUsd: number;
      estimatedCostUsd: number;
      unknownCostTokens: number;
      totalTokens: number;
      vendors: Map<
        Exclude<UsageVendor, "unknown">,
        {
          vendor: Exclude<UsageVendor, "unknown">;
          totalCostUsd: number;
          totalTokens: number;
        }
      >;
    }
  >();
  for (const sample of historySamples) {
    const dayKey = dayKeyFor(sample.timestampMs);
    const dayBucket = bucketMap.get(dayKey) ?? {
      dayKey,
      totalCostUsd: 0,
      reportedCostUsd: 0,
      estimatedCostUsd: 0,
      unknownCostTokens: 0,
      totalTokens: 0,
      vendors: new Map()
    };
    const sampleCostSource = normalizeSampleCostSource(sample);
    dayBucket.totalCostUsd += pricedCostForSample(sample, sampleCostSource);
    dayBucket.totalTokens += sample.totalTokens;
    if (sampleCostSource === "reported") {
      dayBucket.reportedCostUsd += sample.estimatedCostUsd;
    } else if (sampleCostSource === "estimated") {
      dayBucket.estimatedCostUsd += sample.estimatedCostUsd;
    } else {
      dayBucket.unknownCostTokens += sample.totalTokens;
    }

    const vendorBucket = dayBucket.vendors.get(sample.vendor) ?? {
      vendor: sample.vendor,
      totalCostUsd: 0,
      totalTokens: 0
    };
    vendorBucket.totalCostUsd += pricedCostForSample(sample, sampleCostSource);
    vendorBucket.totalTokens += sample.totalTokens;
    dayBucket.vendors.set(sample.vendor, vendorBucket);
    bucketMap.set(dayKey, dayBucket);
  }

  return Array.from(bucketMap.values())
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey))
    .map((bucket) => ({
      dayKey: bucket.dayKey,
      totalCostUsd: bucket.totalCostUsd,
      reportedCostUsd: bucket.reportedCostUsd,
      estimatedCostUsd: bucket.estimatedCostUsd,
      unknownCostTokens: bucket.unknownCostTokens,
      totalTokens: bucket.totalTokens,
      vendors: Array.from(bucket.vendors.values())
        .map((vendor) => ({
          vendor: vendor.vendor,
          totalCostUsd: vendor.totalCostUsd,
          totalTokens: vendor.totalTokens
        }))
        .sort((left, right) => right.totalCostUsd - left.totalCostUsd)
    }));
}

function shouldUseRecursiveUsageWatch(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

function resolveRoots(
  overrideValue: string | undefined,
  fallbackRoot: string
): string[] {
  const overrideRoots = overrideValue?.trim()
    ? overrideValue
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => isAbsolute(entry))
    : [];
  const roots = overrideRoots.length > 0 ? overrideRoots : [fallbackRoot];
  return roots.map((entry) => resolve(entry));
}

function collectUsageSources(
  vendor: UsageVendor,
  roots: string[],
  options: { includeJson: boolean; includeHiddenDirs: boolean }
): SourceDescriptor[] {
  const sources: SourceDescriptor[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!root || !existsSync(root)) {
      continue;
    }
    for (const filePath of walkFiles(root, 0, options.includeHiddenDirs)) {
      if (seen.has(filePath)) {
        continue;
      }
      const source = describeUsageSource(vendor, filePath, options);
      if (!source) {
        continue;
      }
      seen.add(filePath);
      sources.push(source);
    }
  }

  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

function describeUsageSource(
  vendor: UsageVendor,
  filePath: string,
  options: { includeJson: boolean; includeHiddenDirs: boolean }
): SourceDescriptor | null {
  const extension = extname(filePath).toLowerCase();
  if (
    JSONL_EXTENSIONS.has(extension) &&
    shouldCollectJsonlSource(vendor, filePath)
  ) {
    return { kind: "jsonl", path: filePath };
  }
  if (
    options.includeJson &&
    JSON_EXTENSIONS.has(extension) &&
    shouldCollectJsonSource(vendor, filePath)
  ) {
    return { kind: "json", path: filePath };
  }
  return null;
}

function shouldCollectJsonlSource(
  vendor: UsageVendor,
  filePath: string
): boolean {
  if (vendor === "antigravity") {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return /\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/u.test(
      normalizedPath
    );
  }
  return true;
}

function shouldCollectJsonSource(
  _vendor: UsageVendor,
  _filePath: string
): boolean {
  return true;
}

function walkFiles(
  rootPath: string,
  depth: number,
  includeHiddenDirs = false
): string[] {
  const stats = safeStat(rootPath);
  if (!stats) {
    return [];
  }
  if (stats.isFile()) {
    return [rootPath];
  }
  if (!stats.isDirectory() || depth > MAX_RECURSION_DEPTH) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      const hiddenException = entry.name.endsWith(".jsonl");
      if (!hiddenException && depth > 0 && !includeHiddenDirs) {
        continue;
      }
    }
    const nextPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      for (const file of walkFiles(nextPath, depth + 1, includeHiddenDirs)) {
        files.push(file);
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files;
}

function safeStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function resolveExistingWatchRoot(rootPath: string): string | null {
  let currentPath = rootPath;
  const watchFloor = dirname(rootPath);
  while (!existsSync(currentPath)) {
    if (currentPath === watchFloor) {
      return null;
    }
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
  return currentPath;
}

function readJsonlSlice(
  filePath: string,
  offset: number,
  fileSize: number
): string {
  const nextOffset = Math.max(0, Math.min(offset, fileSize));
  const byteLength = Math.max(0, fileSize - nextOffset);
  if (byteLength === 0) {
    return "";
  }

  const fd = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(byteLength);
  try {
    const bytesRead = readSync(fd, buffer, 0, byteLength, nextOffset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function stringMapEquals(
  left: Map<string, string>,
  right: Map<string, string>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function extractUsageSampleFromRecord(
  vendor: UsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  metricsRoot: Record<string, unknown> = record
): UsageEventSample | null {
  const metrics = pickBestUsageMetrics(vendor, metricsRoot);
  if (!metrics) {
    return null;
  }

  const timestampMs = normalizeTimestamp(
    pickFirstString(record, [
      "timestamp",
      "created_at",
      "createdAt",
      "updated_at",
      "updatedAt"
    ]) ?? pickFirstNumber(record, ["timestamp_ms", "timestampMs", "ts"]),
    Date.now()
  );

  const model = pickFirstString(record, ["model", "model_name", "modelName"]);
  const reportedCostUsd = metrics.estimatedCostUsd;
  const costSource: UsageCostSource =
    reportedCostUsd > 0
      ? "reported"
      : metrics.totalTokens > 0
        ? (estimateModelCostForSample(vendor, model, metrics)?.costSource ??
          "unavailable")
        : "unavailable";
  const estimatedCostUsd =
    reportedCostUsd > 0
      ? reportedCostUsd
      : (estimateModelCostForSample(vendor, model, metrics)?.estimatedCostUsd ??
        0);

  return {
    vendor,
    timestampMs,
    sourcePath,
    sourceType: "jsonl",
    sessionId: pickFirstString(record, [
      "session_id",
      "sessionId",
      "conversation_id",
      "conversationId",
      "request_id",
      "requestId"
    ]),
    threadId: pickFirstString(record, [
      "thread_id",
      "threadId",
      "conversation_id",
      "conversationId",
      "id"
    ]),
    requestId: pickFirstOwnString(record, ["request_id", "requestId"]),
    model,
    cwd: normalizePathValue(
      pickFirstString(record, ["cwd", "current_working_directory", "path"])
    ),
    projectPath: normalizePathValue(
      pickFirstString(record, ["project_path", "projectPath", "worktree"])
    ),
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    cacheWriteTokensKnown: true,
    cacheTokens: metrics.cacheTokens,
    totalTokens: metrics.totalTokens,
    estimatedCostUsd,
    costSource
  };
}

function extractUsageSamplesFromJsonDocument(
  vendor: UsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  _state: {
    antigravityWorkspaceByConversation: Map<string, string>;
  }
): UsageEventSample[] {
  if (vendor === "claude") {
    const sample = extractClaudeUsageSample(record, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }

  const sample = extractUsageSampleFromRecord(vendor, record, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range)
    ? [sample]
    : [];
}

function extractUsageSamplesFromJsonLine(
  vendor: UsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  state: {
    codexContexts: Map<string, CodexSessionContext>;
    codexTotals: Map<string, TokenUsageTotals>;
    antigravityContexts: Map<string, AntigravitySessionContext>;
    antigravityWorkspaceByConversation: Map<string, string>;
  }
): UsageEventSample[] {
  if (vendor === "codex") {
    return extractCodexUsageSamples(
      record,
      sourcePath,
      range,
      state.codexContexts,
      state.codexTotals
    );
  }
  if (vendor === "antigravity") {
    return extractAntigravityUsageSamples(
      record,
      sourcePath,
      range,
      state.antigravityContexts,
      state.antigravityWorkspaceByConversation
    );
  }
  if (vendor === "claude") {
    const sample = extractClaudeUsageSample(record, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }

  const sample = extractUsageSampleFromRecord(vendor, record, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range)
    ? [sample]
    : [];
}

function extractClaudeUsageSample(
  record: Record<string, unknown>,
  sourcePath: string
): UsageEventSample | null {
  const message = isRecord(record.message) ? record.message : null;
  const usage = message && isRecord(message.usage) ? message.usage : null;
  const recordType = typeof record.type === "string" ? record.type : undefined;
  const hasClaudeCodeMarker =
    "uuid" in record ||
    "parentUuid" in record ||
    "userType" in record ||
    "isSidechain" in record ||
    "agentId" in record;

  if (message && recordType === "assistant") {
    if (!usage) {
      return null;
    }
    return extractUsageSampleFromRecord("claude", record, sourcePath, usage);
  }

  if (hasClaudeCodeMarker && isClaudeCodeNonUsageRecordType(recordType)) {
    return null;
  }

  return extractUsageSampleFromRecord("claude", record, sourcePath);
}

function isClaudeCodeNonUsageRecordType(type: string | undefined): boolean {
  return (
    type === "user" ||
    type === "attachment" ||
    type === "system" ||
    type === "mode" ||
    type === "permission-mode" ||
    type === "file-history-snapshot" ||
    type === "ai-title" ||
    type === "last-prompt" ||
    type === "queue-operation" ||
    type === "pr-link" ||
    type === "agent-name"
  );
}

function consumeJsonLine(
  output: UsageEventSample[],
  vendor: UsageVendor,
  sourcePath: string,
  range: UsageTimeRange,
  line: string,
  offset: number,
  hasTrailingNewline: boolean,
  codexContexts: Map<string, CodexSessionContext>,
  codexTotals: Map<string, TokenUsageTotals>,
  antigravityContexts: Map<string, AntigravitySessionContext>,
  antigravityWorkspaceByConversation: Map<string, string>
): number {
  const nextOffset =
    offset + Buffer.byteLength(line, "utf8") + (hasTrailingNewline ? 1 : 0);
  const trimmed = line.trim();
  if (!trimmed) {
    return nextOffset;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    output.push(
      ...extractUsageSamplesFromJsonLine(vendor, parsed, sourcePath, range, {
        codexContexts,
        codexTotals,
        antigravityContexts,
        antigravityWorkspaceByConversation
      })
    );
    return nextOffset;
  } catch {
    return hasTrailingNewline ? nextOffset : offset;
  }
}

function extractCodexUsageSamples(
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  contexts: Map<string, CodexSessionContext>,
  totals: Map<string, TokenUsageTotals>
): UsageEventSample[] {
  const recordType = typeof record.type === "string" ? record.type : undefined;
  if (!recordType) {
    const sample = extractUsageSampleFromRecord("codex", record, sourcePath);
    return sample && isTimestampInRange(sample.timestampMs, range)
      ? [sample]
      : [];
  }

  if (recordType === "session_meta") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const previous = contexts.get(sourcePath) ?? {};
    contexts.set(sourcePath, {
      cwd:
        normalizePathValue(
          pickFirstString(payload, ["cwd", "project_path", "projectPath"])
        ) ?? previous.cwd,
      model:
        pickFirstString(payload, ["model", "model_name", "modelName"]) ??
        previous.model,
      projectPath:
        normalizePathValue(
          pickFirstString(payload, ["project_path", "projectPath", "cwd"])
        ) ?? previous.projectPath,
      sessionId:
        pickFirstString(payload, ["id", "session_id", "sessionId"]) ??
        previous.sessionId
    });
    return [];
  }

  if (recordType === "turn_context") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const previous = contexts.get(sourcePath) ?? {};
    contexts.set(sourcePath, {
      ...previous,
      model:
        pickFirstString(payload, ["model", "model_name", "modelName"]) ??
        previous.model
    });
    return [];
  }

  if (recordType !== "event_msg") {
    return [];
  }

  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload || payload.type !== "token_count") {
    return [];
  }
  const info = isRecord(payload.info) ? payload.info : null;
  if (!info) {
    return [];
  }
  const totalUsage = isRecord(info.total_token_usage)
    ? info.total_token_usage
    : null;
  if (!totalUsage) {
    return [];
  }

  const absoluteInputTokens = toFiniteNumber(totalUsage.input_tokens) ?? 0;
  const absoluteCacheReadTokens =
    toFiniteNumber(totalUsage.cached_input_tokens) ?? 0;
  const absoluteOutputTokens = toFiniteNumber(totalUsage.output_tokens) ?? 0;
  const absoluteThinkingTokens =
    toFiniteNumber(totalUsage.reasoning_output_tokens) ?? 0;
  const absoluteTotalTokens =
    toFiniteNumber(totalUsage.total_tokens) ??
    absoluteInputTokens + absoluteOutputTokens;
  const previous = totals.get(sourcePath) ?? {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  };

  const deltaInputTokens = Math.max(
    0,
    absoluteInputTokens - previous.inputTokens
  );
  const deltaCacheReadTokens = Math.max(
    0,
    absoluteCacheReadTokens - previous.cacheReadTokens
  );
  const deltaOutputTokens = Math.max(
    0,
    absoluteOutputTokens - previous.outputTokens
  );
  const deltaThinkingTokens = Math.max(
    0,
    absoluteThinkingTokens - previous.thinkingTokens
  );
  const deltaVisibleOutputTokens = Math.max(
    0,
    deltaOutputTokens - deltaThinkingTokens
  );
  const deltaTotalTokens = Math.max(
    0,
    absoluteTotalTokens - previous.totalTokens
  );
  totals.set(sourcePath, {
    cacheReadTokens: absoluteCacheReadTokens,
    cacheWriteTokens: 0,
    cacheTokens: absoluteCacheReadTokens,
    inputTokens: absoluteInputTokens,
    outputTokens: absoluteOutputTokens,
    thinkingTokens: absoluteThinkingTokens,
    totalTokens: absoluteTotalTokens
  });

  if (deltaTotalTokens <= 0) {
    return [];
  }

  const context = contexts.get(sourcePath);
  const timestampMs = normalizeTimestamp(
    record.timestamp ?? payload.timestamp,
    Date.now()
  );
  if (!isTimestampInRange(timestampMs, range)) {
    return [];
  }

  const estimatedCostUsd =
    estimateModelCost({
      vendor: "codex",
      model: context?.model,
      inputTokens: Math.max(0, deltaInputTokens - deltaCacheReadTokens),
      outputTokens: deltaVisibleOutputTokens,
      cacheTokens: deltaCacheReadTokens,
      thinkingTokens: deltaThinkingTokens,
      cacheCreateTokens: 0,
      cacheCreateTokensKnown: false
    })?.estimatedCostUsd ?? 0;
  const costSource: UsageCostSource =
    estimatedCostUsd > 0 ? "estimated" : "unavailable";

  return [
    {
      vendor: "codex",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: context?.sessionId,
      threadId: context?.sessionId,
      eventId: [
        "codex-token-count",
        context?.sessionId ?? "",
        timestampMs,
        absoluteInputTokens,
        absoluteCacheReadTokens,
        absoluteOutputTokens,
        absoluteThinkingTokens,
        absoluteTotalTokens
      ].join(":"),
      model: context?.model,
      cwd: context?.cwd,
      projectPath: context?.projectPath ?? context?.cwd,
      inputTokens: Math.max(0, deltaInputTokens - deltaCacheReadTokens),
      outputTokens: deltaVisibleOutputTokens,
      thinkingTokens: deltaThinkingTokens,
      cacheReadTokens: deltaCacheReadTokens,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: deltaCacheReadTokens,
      totalTokens: deltaTotalTokens,
      estimatedCostUsd,
      costSource
    }
  ];
}

function extractAntigravityUsageSamples(
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  contexts: Map<string, AntigravitySessionContext>,
  workspaceByConversation: Map<string, string>
): UsageEventSample[] {
  const conversationId =
    antigravityConversationIdFromPath(sourcePath) ??
    pickFirstString(record, ["conversationId", "conversation_id"]);
  const cwd = conversationId
    ? workspaceByConversation.get(conversationId)
    : undefined;
  const inferredModel = inferAntigravityModelFromRecord(record);
  const previousContext = contexts.get(sourcePath);
  const model = inferredModel ?? previousContext?.model;
  if (inferredModel && previousContext?.model !== inferredModel) {
    contexts.set(sourcePath, { model: inferredModel });
  }
  const augmentedRecord: Record<string, unknown> = { ...record };
  if (conversationId && !pickFirstString(augmentedRecord, ["conversationId"])) {
    augmentedRecord.conversationId = conversationId;
  }
  if (cwd && !pickFirstString(augmentedRecord, ["cwd"])) {
    augmentedRecord.cwd = cwd;
  }
  if (cwd && !pickFirstString(augmentedRecord, ["projectPath"])) {
    augmentedRecord.projectPath = cwd;
  }
  if (model && !pickFirstString(augmentedRecord, ["model"])) {
    augmentedRecord.model = model;
  }

  const reportedSample = extractUsageSampleFromRecord(
    "antigravity",
    augmentedRecord,
    sourcePath
  );
  if (reportedSample && isTimestampInRange(reportedSample.timestampMs, range)) {
    return [
      {
        ...reportedSample,
        sessionId: reportedSample.sessionId ?? conversationId,
        threadId:
          reportedSample.threadId ??
          antigravityThreadId(
            conversationId,
            record,
            reportedSample.timestampMs
          ),
        model: reportedSample.model ?? model,
        cwd: reportedSample.cwd ?? cwd,
        projectPath: reportedSample.projectPath ?? cwd,
        costSource: reportedSample.costSource ?? "unavailable"
      }
    ];
  }

  const timestampMs = normalizeTimestamp(
    record.created_at ??
      record.createdAt ??
      record.timestamp ??
      record.updated_at ??
      record.updatedAt,
    Date.now()
  );
  if (!isTimestampInRange(timestampMs, range)) {
    return [];
  }

  const transcriptText = extractAntigravityTranscriptText(record);
  const inputTokens = estimateAntigravityTranscriptTokens(
    transcriptText.inputText
  );
  const outputTokens = estimateAntigravityTranscriptTokens(
    transcriptText.outputText
  );
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) {
    return [];
  }
  const estimated = estimateModelCostForSample("antigravity", model, {
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    totalTokens,
    estimatedCostUsd: 0,
    score: 0
  });

  return [
    {
      vendor: "antigravity",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: conversationId,
      threadId: antigravityThreadId(conversationId, record, timestampMs),
      model,
      cwd,
      projectPath: cwd,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: 0,
      totalTokens,
      estimatedCostUsd: estimated?.estimatedCostUsd ?? 0,
      costSource: estimated?.costSource ?? "unavailable"
    }
  ];
}

function extractAntigravityTranscriptText(record: Record<string, unknown>): {
  inputText: string;
  outputText: string;
} {
  const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
  const source =
    typeof record.source === "string" ? record.source.toUpperCase() : "";
  const content = stringifyAntigravityTranscriptValue(record.content);
  const toolCalls = Array.isArray(record.tool_calls)
    ? stringifyAntigravityTranscriptValue(record.tool_calls)
    : "";
  const isModelResponse =
    source === "MODEL" && (type.endsWith("_RESPONSE") || Boolean(toolCalls));

  if (isModelResponse) {
    return {
      inputText: "",
      outputText: [content, toolCalls].filter(Boolean).join("\n")
    };
  }

  return {
    inputText: content,
    outputText: ""
  };
}

function stringifyAntigravityTranscriptValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function estimateAntigravityTranscriptTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function antigravityConversationIdFromPath(
  sourcePath: string
): string | undefined {
  const normalizedPath = sourcePath.replace(/\\/g, "/");
  return normalizedPath.match(
    /\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/u
  )?.[1];
}

function antigravityThreadId(
  conversationId: string | undefined,
  record: Record<string, unknown>,
  timestampMs: number
): string | undefined {
  const explicitId = pickFirstString(record, [
    "thread_id",
    "threadId",
    "id",
    "messageId",
    "eventId"
  ]);
  if (explicitId) {
    return explicitId;
  }
  const stepIndex = toFiniteNumber(record.step_index ?? record.stepIndex);
  if (conversationId && stepIndex !== undefined) {
    return `${conversationId}:${stepIndex}`;
  }
  return conversationId ? `${conversationId}:${timestampMs}` : undefined;
}

function inferAntigravityModelFromRecord(
  record: Record<string, unknown>
): string | undefined {
  const explicit = pickFirstString(record, [
    "model",
    "model_name",
    "modelName"
  ]);
  if (explicit) {
    return explicit;
  }
  const content = stringifyAntigravityTranscriptValue(record.content);
  const modelIdMatch = content.match(/gemini-[A-Za-z0-9._-]+/iu);
  if (modelIdMatch?.[0]) {
    return modelIdMatch[0];
  }
  const humanLabelMatch = content.match(
    /Gemini\s+\d+(?:\.\d+)?\s+(?:Pro|Flash(?:[- ]Lite)?)(?:\s*\((?:Low|Medium|High)\))?/iu
  );
  if (humanLabelMatch?.[0]) {
    return humanLabelMatch[0].trim().replace(/[.。]+$/u, "");
  }
  return undefined;
}

function pickBestUsageMetrics(
  vendor: UsageVendor,
  root: Record<string, unknown>
): ParsedUsageMetrics | null {
  const candidates = collectObjectCandidates(root);
  let best: ParsedUsageMetrics | null = null;

  for (const candidate of candidates) {
    const parsed = parseUsageMetrics(vendor, candidate.value);
    if (!parsed) {
      continue;
    }
    if (
      !best ||
      parsed.score > best.score ||
      (parsed.score === best.score && parsed.totalTokens > best.totalTokens) ||
      (parsed.score === best.score &&
        parsed.totalTokens === best.totalTokens &&
        parsed.estimatedCostUsd > best.estimatedCostUsd)
    ) {
      best = parsed;
    }
  }

  return best;
}

function collectObjectCandidates(
  root: Record<string, unknown>,
  depth = 0,
  path = "$",
  output: ObjectCandidate[] = []
): ObjectCandidate[] {
  if (depth > 5) {
    return output;
  }
  output.push({ path, value: root });
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value)) {
      value.slice(0, 12).forEach((item, index) => {
        if (isRecord(item)) {
          collectObjectCandidates(
            item,
            depth + 1,
            `${path}.${key}[${index}]`,
            output
          );
        }
      });
      continue;
    }
    if (isRecord(value)) {
      collectObjectCandidates(value, depth + 1, `${path}.${key}`, output);
    }
  }
  return output;
}

function parseUsageMetrics(
  vendor: UsageVendor,
  record: Record<string, unknown>
): ParsedUsageMetrics | null {
  const rawInputTokens =
    readNumericField(record, ["input_tokens", "inputTokens"]) ??
    readNumericField(record, ["prompt_tokens", "promptTokens"]) ??
    0;
  const rawOutputTokens =
    readNumericField(record, ["output_tokens", "outputTokens"]) ??
    readNumericField(record, ["completion_tokens", "completionTokens"]) ??
    0;
  const cacheReadTokens =
    readNumericField(record, [
      "cache_read_input_tokens",
      "cacheReadInputTokens"
    ]) ??
    readNumericField(record, [
      "cache_read_tokens",
      "cacheReadTokens",
      "cache_tokens",
      "cacheTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      ["cached_tokens", "cachedTokens"]
    ) ??
    0;
  const cacheWriteTokens =
    readNumericField(record, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens"
    ]) ??
    readNumericField(record, [
      "cache_creation_tokens",
      "cacheCreationTokens",
      "cache_write_tokens",
      "cacheWriteTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      [
        "cache_write_tokens",
        "cacheWriteTokens",
        "cache_creation_tokens",
        "cacheCreationTokens"
      ]
    ) ??
    0;
  const thinkingTokens =
    readNumericField(record, [
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
      "thinkingTokens"
    ]) ??
    readNestedNumericField(
      record,
      ["completion_tokens_details", "output_tokens_details"],
      [
        "reasoning_tokens",
        "reasoningTokens",
        "thinking_tokens",
        "thinkingTokens"
      ]
    ) ??
    0;
  const inputTokens = treatsInputTokensAsUncached(vendor, record)
    ? Math.max(0, rawInputTokens)
    : Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, rawOutputTokens - thinkingTokens);
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  const totalTokens =
    readNumericField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + outputTokens + thinkingTokens + cacheTokens;
  const estimatedCostUsd =
    readNumericField(record, [
      "estimated_cost",
      "estimatedCost",
      "estimated_cost_usd",
      "estimatedCostUsd",
      "total_cost_usd",
      "totalCostUsd",
      "cost_usd",
      "costUsd",
      "price_usd",
      "priceUsd"
    ]) ?? 0;

  if (totalTokens <= 0 && estimatedCostUsd <= 0) {
    return null;
  }

  let score = 0;
  if (inputTokens > 0) {
    score += 2;
  }
  if (outputTokens > 0) {
    score += 2;
  }
  if (thinkingTokens > 0) {
    score += 1;
  }
  if (cacheTokens > 0) {
    score += 1;
  }
  if (totalTokens > 0) {
    score += 2;
  }
  if (estimatedCostUsd > 0) {
    score += 3;
  }

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheTokens,
    totalTokens,
    estimatedCostUsd,
    score
  };
}

function estimateModelCostForSample(
  vendor: UsageVendor,
  model: string | undefined,
  metrics: ParsedUsageMetrics
): { estimatedCostUsd: number; costSource: UsageCostSource } | null {
  if (vendor === "unknown") {
    return null;
  }
  const estimated = estimateModelCost({
    vendor: vendor === "antigravity" ? "gemini" : vendor,
    model,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheTokens: metrics.cacheReadTokens,
    cacheCreateTokens: metrics.cacheWriteTokens,
    cacheCreateTokensKnown: true,
    thinkingTokens: metrics.thinkingTokens
  });
  if (!estimated) {
    return null;
  }
  return {
    estimatedCostUsd: estimated.estimatedCostUsd,
    costSource: "estimated"
  };
}

function isTimestampInRange(
  timestampMs: number,
  range: UsageTimeRange
): boolean {
  return (
    timestampMs >= range.fromMs &&
    (typeof range.toMs !== "number" || timestampMs <= range.toMs)
  );
}

function normalizeSampleCostSource(sample: UsageEventSample): UsageCostSource {
  if (sample.costSource) {
    return sample.costSource;
  }
  return sample.estimatedCostUsd > 0 ? "reported" : "unavailable";
}

function pricedCostForSample(
  sample: UsageEventSample,
  costSource = normalizeSampleCostSource(sample)
): number {
  return costSource === "unavailable" ? 0 : sample.estimatedCostUsd;
}

export function usageSampleIdentity(sample: UsageEventSample): string {
  const claudeIdentity = claudeCanonicalUsageIdentity(sample);
  if (claudeIdentity) {
    return claudeIdentity;
  }
  const eventKey =
    sample.eventId ??
    sample.threadId ??
    [
      sample.sessionId ?? "",
      sample.timestampMs,
      sample.inputTokens,
      sample.outputTokens,
      sample.thinkingTokens ?? 0,
      sample.cacheReadTokens ?? sample.cacheTokens,
      sample.cacheWriteTokens ?? 0,
      sample.totalTokens
    ].join(":");
  return [sample.vendor, sample.sourcePath, eventKey].join("\t");
}

export function shouldReplaceUsageSample(
  existing: UsageEventSample,
  candidate: UsageEventSample
): boolean {
  const existingClaudeIdentity = claudeCanonicalUsageIdentity(existing);
  const candidateClaudeIdentity = claudeCanonicalUsageIdentity(candidate);
  if (
    existingClaudeIdentity &&
    candidateClaudeIdentity &&
    existingClaudeIdentity === candidateClaudeIdentity
  ) {
    return shouldReplaceClaudeCanonicalSample(existing, candidate);
  }
  return true;
}

function usageHistorySampleIdentity(sample: UsageEventSample): string {
  return [dayKeyFor(sample.timestampMs), usageSampleIdentity(sample)].join(
    "\t"
  );
}

function claudeCanonicalUsageIdentity(sample: UsageEventSample): string | null {
  if (sample.vendor !== "claude" || !sample.threadId || !sample.requestId) {
    return null;
  }
  return [sample.vendor, sample.threadId, sample.requestId].join("\t");
}

function shouldReplaceClaudeCanonicalSample(
  existing: UsageEventSample,
  candidate: UsageEventSample
): boolean {
  if (candidate.totalTokens !== existing.totalTokens) {
    return candidate.totalTokens > existing.totalTokens;
  }
  const existingSubagent = isClaudeSubagentSource(existing);
  const candidateSubagent = isClaudeSubagentSource(candidate);
  if (existingSubagent !== candidateSubagent) {
    return existingSubagent && !candidateSubagent;
  }
  if (existing.sourcePath === candidate.sourcePath) {
    return candidate.timestampMs >= existing.timestampMs;
  }
  return candidate.sourcePath < existing.sourcePath;
}

function isClaudeSubagentSource(sample: UsageEventSample): boolean {
  return sample.sourcePath.replace(/\\/g, "/").includes("/subagents/");
}

function pickFirstOwnString(
  root: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickFirstString(
  root: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const candidate of collectObjectCandidates(root)) {
    for (const key of keys) {
      const value = candidate.value[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function pickFirstNumber(
  root: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const candidate of collectObjectCandidates(root)) {
    for (const key of keys) {
      const value = toFiniteNumber(candidate.value[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function readNumericField(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readNestedNumericField(
  record: Record<string, unknown>,
  parentKeys: string[],
  childKeys: string[]
): number | undefined {
  for (const parentKey of parentKeys) {
    const parent = record[parentKey];
    if (!isRecord(parent)) {
      continue;
    }
    const value = readNumericField(parent, childKeys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function treatsInputTokensAsUncached(
  vendor: UsageVendor,
  record: Record<string, unknown>
): boolean {
  return (
    vendor === "claude" &&
    readNumericField(record, ["input_tokens", "inputTokens"]) !== undefined
  );
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) {
      return normalizeTimestamp(parsedNumber, fallback);
    }
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }
  return fallback;
}

function normalizePathValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dayKeyFor(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
