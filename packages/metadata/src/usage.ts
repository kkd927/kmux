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
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { estimateModelCost } from "./modelPricing";

const JSON_EXTENSIONS = new Set([".json"]);
const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const MAX_RECURSION_DEPTH = 6;
const WATCH_DEBOUNCE_MS = 180;
const SOURCE_INDEX_RESYNC_MS = 60_000;
const WATCH_ROOT_RETRY_MS = 60_000;

export type UsageVendor = "claude" | "codex" | "gemini" | "unknown";
export type UsageCostSource = "reported" | "estimated" | "unavailable";

export interface UsageEventSample {
  vendor: UsageVendor;
  timestampMs: number;
  sourcePath: string;
  sourceType: "jsonl" | "json";
  sessionId?: string;
  threadId?: string;
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
  readIncremental(startOfDayMs: number): Promise<UsageAdapterReadResult>;
  markDirty?(options?: UsageAdapterDirtyOptions): void;
  watch(onChange: () => void): () => void;
  close(): void;
}

interface CreateUsageAdaptersOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface UsageHistoryDay {
  dayKey: string;
  totalCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
  totalTokens: number;
  activeSessionCount: number;
  vendors: Array<{
    vendor: Exclude<UsageVendor, "unknown">;
    totalCostUsd: number;
    totalTokens: number;
    activeSessionCount: number;
  }>;
}

type UsageTimeRange = {
  fromMs: number;
  toMs?: number;
};

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
  geminiProjectRootsDir?: string;
  includeJson?: boolean;
}

class FileUsageAdapter implements UsageAdapter {
  readonly vendor: UsageVendor;

  private readonly codexContexts = new Map<string, CodexSessionContext>();
  private readonly codexTotals = new Map<string, TokenUsageTotals>();
  private readonly geminiProjectRoots = new Map<string, string | undefined>();
  private readonly geminiSeenMessageIds = new Map<string, Set<string>>();
  private readonly geminiProjectRootsDir?: string;
  private readonly includeJson: boolean;
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
    this.geminiProjectRootsDir = options.geminiProjectRootsDir;
    this.includeJson = options.includeJson ?? false;
  }

  async initialScan(startOfDayMs: number): Promise<UsageAdapterReadResult> {
    this.dayKey = dayKeyFor(startOfDayMs);
    this.codexContexts.clear();
    this.codexTotals.clear();
    this.cursors.clear();
    this.geminiProjectRoots.clear();
    this.geminiSeenMessageIds.clear();
    this.sourceIndexDirty = true;
    this.dirtySourceIndex = true;
    this.dirtyPaths.clear();
    return this.readAllSources({ fromMs: startOfDayMs }, true);
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
    this.geminiProjectRoots.clear();
    this.geminiSeenMessageIds.clear();
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
    useCursors: boolean
  ): Promise<UsageAdapterReadResult> {
    const samples: UsageEventSample[] = [];
    const sources = this.resolveSourcesForRead(useCursors);

    for (const source of sources) {
      if (source.kind === "json") {
        samples.push(...this.readJsonSource(source, range, useCursors));
        continue;
      }
      samples.push(...this.readJsonlSource(source, range, useCursors));
    }

    return {
      samples,
      sourceCount: this.sources.size
    };
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
      includeJson: this.includeJson
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

  private markSourceDirty(root: string, filename: string | Buffer | null): void {
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
      includeJson: this.includeJson
    });
    if (!source) {
      return;
    }
    this.sources.set(source.path, source);
    this.dirtyPaths.add(source.path);
  }

  private shouldResyncSourceIndex(): boolean {
    return Date.now() - this.lastSourceIndexRefreshAtMs >= SOURCE_INDEX_RESYNC_MS;
  }

  private removeTrackedSource(sourcePath: string): void {
    this.sources.delete(sourcePath);
    this.cursors.delete(sourcePath);
    this.codexContexts.delete(sourcePath);
    this.codexTotals.delete(sourcePath);
    this.geminiSeenMessageIds.delete(sourcePath);
    this.geminiProjectRoots.delete(sourcePath);
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
        { recursive: true },
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
    useCursors: boolean
  ): UsageEventSample[] {
    const stats = safeStat(source.path);
    if (!stats) {
      this.removeTrackedSource(source.path);
      return [];
    }

    const dayKey = dayKeyFor(range.fromMs);
    const previous = this.cursors.get(source.path);
    let offset =
      useCursors &&
      previous?.kind === "jsonl" &&
      previous.dayKey === dayKey &&
      previous.inode === stats.ino &&
      stats.size >= previous.offset
        ? previous.offset
        : 0;

    const text = readJsonlSlice(source.path, offset, Number(stats.size));
    const samples: UsageEventSample[] = [];
    const lines = text.split("\n");
    const endedWithNewline = text.endsWith("\n");
    const completeLines = endedWithNewline ? lines.slice(0, -1) : lines.slice(0, -1);

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
        this.codexTotals
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
        this.codexTotals
      );
    }

    if (useCursors) {
      this.cursors.set(source.path, {
        kind: "jsonl",
        dayKey,
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
    useCursors: boolean
  ): UsageEventSample[] {
    const stats = safeStat(source.path);
    if (!stats) {
      this.removeTrackedSource(source.path);
      return [];
    }

    const dayKey = dayKeyFor(range.fromMs);
    const previous = this.cursors.get(source.path);
    if (
      useCursors &&
      previous?.kind === "json" &&
      previous.dayKey === dayKey &&
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
          geminiProjectRoots: this.geminiProjectRoots,
          geminiProjectRootsDir: this.geminiProjectRootsDir,
          geminiSeenMessageIds: this.geminiSeenMessageIds
        }
      );
      if (useCursors) {
        this.cursors.set(source.path, {
          kind: "json",
          dayKey,
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
  const homeDirectory = options.homeDir ?? homedir();
  const geminiRoots = resolveRoots(
    env.KMUX_GEMINI_USAGE_DIR,
    join(homeDirectory, ".gemini", "tmp")
  );

  return [
    new FileUsageAdapter(
      "claude",
      resolveRoots(env.KMUX_CLAUDE_USAGE_DIR, join(homeDirectory, ".claude", "projects"))
    ),
    new FileUsageAdapter(
      "codex",
      resolveRoots(env.KMUX_CODEX_USAGE_DIR, join(homeDirectory, ".codex", "sessions"))
    ),
    new FileUsageAdapter(
      "gemini",
      geminiRoots,
      {
        geminiProjectRootsDir: resolveGeminiProjectRootsDir(
          geminiRoots,
          homeDirectory
        ),
        includeJson: true
      }
    )
  ];
}

export async function scanUsageHistoryDays(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fromMs: number;
  toMs: number;
}): Promise<UsageHistoryDay[]> {
  const adapters = createUsageAdapters({
    env: options.env,
    homeDir: options.homeDir
  });
  const bucketMap = new Map<
    string,
    {
      dayKey: string;
      totalCostUsd: number;
      reportedCostUsd: number;
      estimatedCostUsd: number;
      unknownCostTokens: number;
      totalTokens: number;
      activeKeys: Set<string>;
      vendors: Map<
        Exclude<UsageVendor, "unknown">,
        {
          vendor: Exclude<UsageVendor, "unknown">;
          totalCostUsd: number;
          totalTokens: number;
          activeKeys: Set<string>;
        }
      >;
    }
  >();

  try {
    for (const adapter of adapters) {
      if (!(adapter instanceof FileUsageAdapter)) {
        continue;
      }
      const result = await adapter.scanRange({
        fromMs: options.fromMs,
        toMs: options.toMs
      });
      for (const sample of result.samples) {
        if (sample.vendor === "unknown") {
          continue;
        }
        const dayKey = dayKeyFor(sample.timestampMs);
        const dayBucket =
          bucketMap.get(dayKey) ??
          {
            dayKey,
            totalCostUsd: 0,
            reportedCostUsd: 0,
            estimatedCostUsd: 0,
            unknownCostTokens: 0,
            totalTokens: 0,
            activeKeys: new Set<string>(),
            vendors: new Map()
          };
        const sampleCostSource = normalizeSampleCostSource(sample);
        const sessionKey = usageSampleSessionKey(sample);
        dayBucket.totalCostUsd += pricedCostForSample(sample, sampleCostSource);
        dayBucket.totalTokens += sample.totalTokens;
        if (sampleCostSource === "reported") {
          dayBucket.reportedCostUsd += sample.estimatedCostUsd;
        } else if (sampleCostSource === "estimated") {
          dayBucket.estimatedCostUsd += sample.estimatedCostUsd;
        } else {
          dayBucket.unknownCostTokens += sample.totalTokens;
        }
        dayBucket.activeKeys.add(sessionKey);

        const vendorBucket =
          dayBucket.vendors.get(sample.vendor) ??
          {
            vendor: sample.vendor,
            totalCostUsd: 0,
            totalTokens: 0,
            activeKeys: new Set<string>()
          };
        vendorBucket.totalCostUsd += pricedCostForSample(sample, sampleCostSource);
        vendorBucket.totalTokens += sample.totalTokens;
        vendorBucket.activeKeys.add(sessionKey);
        dayBucket.vendors.set(sample.vendor, vendorBucket);
        bucketMap.set(dayKey, dayBucket);
      }
    }
  } finally {
    for (const adapter of adapters) {
      adapter.close();
    }
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
      activeSessionCount: bucket.activeKeys.size,
      vendors: Array.from(bucket.vendors.values())
        .map((vendor) => ({
          vendor: vendor.vendor,
          totalCostUsd: vendor.totalCostUsd,
          totalTokens: vendor.totalTokens,
          activeSessionCount: vendor.activeKeys.size
        }))
        .sort((left, right) => right.totalCostUsd - left.totalCostUsd)
    }));
}

function resolveRoots(overrideValue: string | undefined, fallbackRoot: string): string[] {
  const source = overrideValue?.trim() ? overrideValue : fallbackRoot;
  return source
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function resolveGeminiProjectRootsDir(
  geminiRoots: string[],
  homeDirectory: string
): string {
  for (const root of geminiRoots) {
    if (root.endsWith("/tmp") || root.endsWith("\\tmp")) {
      return resolve(root, "..", "history");
    }
  }
  return join(homeDirectory, ".gemini", "history");
}

function collectUsageSources(
  vendor: UsageVendor,
  roots: string[],
  options: { includeJson: boolean }
): SourceDescriptor[] {
  const sources: SourceDescriptor[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!root || !existsSync(root)) {
      continue;
    }
    for (const filePath of walkFiles(root, 0)) {
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
  options: { includeJson: boolean }
): SourceDescriptor | null {
  const extension = extname(filePath).toLowerCase();
  if (JSONL_EXTENSIONS.has(extension)) {
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

function shouldCollectJsonSource(vendor: UsageVendor, filePath: string): boolean {
  if (vendor === "gemini") {
    return /\/chats\/session-[^/]+\.json$/u.test(filePath);
  }
  return true;
}

function walkFiles(rootPath: string, depth: number): string[] {
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
      if (!hiddenException && depth > 0) {
        continue;
      }
    }
    const nextPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(nextPath, depth + 1));
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

function readJsonlSlice(filePath: string, offset: number, fileSize: number): string {
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

function extractUsageSampleFromRecord(
  vendor: UsageVendor,
  record: Record<string, unknown>,
  sourcePath: string
): UsageEventSample | null {
  const metrics = pickBestUsageMetrics(record);
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
        ? estimateModelCostForSample(vendor, model, metrics)?.costSource ??
          "unavailable"
        : "unavailable";
  const estimatedCostUsd =
    reportedCostUsd > 0
      ? reportedCostUsd
      : estimateModelCostForSample(vendor, model, metrics)?.estimatedCostUsd ?? 0;

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
  state: {
    geminiProjectRoots: Map<string, string | undefined>;
    geminiProjectRootsDir?: string;
    geminiSeenMessageIds: Map<string, Set<string>>;
  }
): UsageEventSample[] {
  if (vendor === "gemini") {
    const samples = extractGeminiUsageSamples(
      record,
      sourcePath,
      range,
      state.geminiSeenMessageIds,
      resolveGeminiProjectRoot(
        sourcePath,
        state.geminiProjectRoots,
        state.geminiProjectRootsDir
      )
    );
    if (samples.length > 0) {
      return samples;
    }
  }

  const sample = extractUsageSampleFromRecord(vendor, record, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range) ? [sample] : [];
}

function extractUsageSamplesFromJsonLine(
  vendor: UsageVendor,
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  state: {
    codexContexts: Map<string, CodexSessionContext>;
    codexTotals: Map<string, TokenUsageTotals>;
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

  const sample = extractUsageSampleFromRecord(vendor, record, sourcePath);
  return sample && isTimestampInRange(sample.timestampMs, range) ? [sample] : [];
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
  codexTotals: Map<string, TokenUsageTotals>
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
      ...extractUsageSamplesFromJsonLine(
        vendor,
        parsed,
        sourcePath,
        range,
        {
          codexContexts,
          codexTotals
        }
      )
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
    return sample && isTimestampInRange(sample.timestampMs, range) ? [sample] : [];
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
      outputTokens: deltaOutputTokens,
      cacheTokens: deltaCacheReadTokens,
      thinkingTokens: deltaThinkingTokens,
      cacheCreateTokens: 0,
      cacheCreateTokensKnown: false
    })?.estimatedCostUsd ?? 0;
  const costSource: UsageCostSource = estimatedCostUsd > 0 ? "estimated" : "unavailable";

  return [
    {
      vendor: "codex",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: context?.sessionId,
      threadId: context?.sessionId,
      model: context?.model,
      cwd: context?.cwd,
      projectPath: context?.projectPath ?? context?.cwd,
      inputTokens: Math.max(0, deltaInputTokens - deltaCacheReadTokens),
      outputTokens: Math.max(0, deltaOutputTokens - deltaThinkingTokens),
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

function extractGeminiUsageSamples(
  record: Record<string, unknown>,
  sourcePath: string,
  range: UsageTimeRange,
  seenMessageIdsByPath: Map<string, Set<string>>,
  projectPath: string | undefined
): UsageEventSample[] {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId : undefined;
  const seenMessageIds =
    seenMessageIdsByPath.get(sourcePath) ?? new Set<string>();
  const samples: UsageEventSample[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const messageId =
      typeof message.id === "string" && message.id.trim()
        ? message.id
        : undefined;
    if (messageId && seenMessageIds.has(messageId)) {
      continue;
    }
    if (messageId) {
      seenMessageIds.add(messageId);
    }
    if (message.type !== "gemini") {
      continue;
    }
    const tokens = isRecord(message.tokens) ? message.tokens : null;
    if (!tokens) {
      continue;
    }
    const timestampMs = normalizeTimestamp(message.timestamp, Date.now());
    if (!isTimestampInRange(timestampMs, range)) {
      continue;
    }

    const inputTokens = toFiniteNumber(tokens.input) ?? 0;
    const cacheReadTokens = toFiniteNumber(tokens.cached) ?? 0;
    const cacheWriteTokens = 0;
    const cacheTokens = cacheReadTokens + cacheWriteTokens;
    const outputTokens = toFiniteNumber(tokens.output) ?? 0;
    const totalTokens =
      toFiniteNumber(tokens.total) ??
      inputTokens + outputTokens + cacheTokens;
    if (totalTokens <= 0) {
      continue;
    }

    const model =
      typeof message.model === "string" && message.model.trim()
        ? message.model
        : undefined;
    const estimatedCostUsd =
      estimateModelCost({
        vendor: "gemini",
        model,
        inputTokens,
        outputTokens,
        cacheTokens,
        cacheCreateTokens: cacheWriteTokens,
        cacheCreateTokensKnown: true
      })?.estimatedCostUsd ?? 0;

    samples.push({
      vendor: "gemini",
      timestampMs,
      sourcePath,
      sourceType: "json",
      sessionId,
      threadId: messageId,
      model,
      cwd: projectPath,
      projectPath,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteTokensKnown: true,
      cacheTokens,
      totalTokens,
      estimatedCostUsd,
      costSource: estimatedCostUsd > 0 ? "estimated" : "unavailable"
    });
  }

  seenMessageIdsByPath.set(sourcePath, seenMessageIds);
  return samples;
}

function resolveGeminiProjectRoot(
  sourcePath: string,
  cache: Map<string, string | undefined>,
  projectRootsDir: string | undefined
): string | undefined {
  if (cache.has(sourcePath)) {
    return cache.get(sourcePath);
  }

  const projectKey = sourcePath.match(/\/tmp\/([^/]+)\/chats\/session-[^/]+\.json$/u)?.[1];
  if (!projectKey || !projectRootsDir) {
    cache.set(sourcePath, undefined);
    return undefined;
  }

  const projectRootPath = join(projectRootsDir, projectKey, ".project_root");
  try {
    const projectRoot = normalizePathValue(readFileSync(projectRootPath, "utf8"));
    cache.set(sourcePath, projectRoot);
    return projectRoot;
  } catch {
    cache.set(sourcePath, undefined);
    return undefined;
  }
}

function pickBestUsageMetrics(
  root: Record<string, unknown>
): ParsedUsageMetrics | null {
  const candidates = collectObjectCandidates(root);
  let best: ParsedUsageMetrics | null = null;

  for (const candidate of candidates) {
    const parsed = parseUsageMetrics(candidate.value);
    if (!parsed) {
      continue;
    }
    if (
      !best ||
      parsed.score > best.score ||
      (parsed.score === best.score &&
        parsed.totalTokens > best.totalTokens) ||
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
    (readNumericField(record, ["cache_tokens", "cacheTokens"]) ?? 0) +
    (readNumericField(record, [
      "cache_read_tokens",
      "cacheReadTokens",
      "cache_read_input_tokens",
      "cacheReadInputTokens"
    ]) ?? 0) +
    (readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      ["cached_tokens", "cachedTokens"]
    ) ?? 0);
  const cacheWriteTokens =
    (readNumericField(record, [
      "cache_creation_tokens",
      "cacheCreationTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens"
    ]) ?? 0) +
    (readNumericField(record, ["cache_write_tokens", "cacheWriteTokens"]) ?? 0) +
    (readNestedNumericField(
      record,
      ["prompt_tokens_details", "input_tokens_details"],
      [
        "cache_write_tokens",
        "cacheWriteTokens",
        "cache_creation_tokens",
        "cacheCreationTokens"
      ]
    ) ?? 0);
  const thinkingTokens =
    (readNumericField(record, [
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
      "thinkingTokens"
    ]) ?? 0) +
    (readNestedNumericField(
      record,
      ["completion_tokens_details", "output_tokens_details"],
      [
        "reasoning_tokens",
        "reasoningTokens",
        "thinking_tokens",
        "thinkingTokens"
      ]
    ) ?? 0);
  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
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
    vendor,
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

function isTimestampInRange(timestampMs: number, range: UsageTimeRange): boolean {
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

function usageSampleSessionKey(sample: UsageEventSample): string {
  return (
    sample.sessionId ??
    sample.threadId ??
    sample.projectPath ??
    sample.cwd ??
    sample.sourcePath
  );
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
