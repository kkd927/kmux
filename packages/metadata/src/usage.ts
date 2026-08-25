import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  AgentMetadataQueryRequest,
  AgentMetadataQueryResult,
  AgentMetadataInventoryService,
  AgentMetadataTextReadRequest
} from "./localMetadataInventory";
import {
  collectSessionInventory,
  type SessionInventoryCandidate,
  type SessionInventoryDiagnostic,
  type SessionInventory
} from "./sessionInventory";
import {
  coreUsageSampleIdentity,
  shouldReplaceCoreUsageSample,
  type CoreUsageEventSample,
  type CoreUsageTimeRange
} from "./core/usage";
import type { AgentId, MetadataSourceRoleId } from "@kmux/proto";

const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const WATCH_DEBOUNCE_MS = 180;
const SOURCE_INDEX_RESYNC_MS = 60_000;
const WATCH_ROOT_RETRY_MS = 60_000;
const MAX_SHARED_READ_BYTES = 256 * 1024;
// This bounds retained parser state, not the size of each source read.
const MAX_USAGE_JSONL_RECORD_BYTES = 256 * 1024;
const MAX_USAGE_PARSE_CANDIDATES = 4_096 * 8;

export type UsageVendor = AgentId | "unknown";
export type UsageCostSource = "reported" | "estimated" | "unavailable";

export type UsageEventSample = CoreUsageEventSample;

export interface UsageAdapterReadResult {
  samples: UsageEventSample[];
  sourceCount: number;
  truncated?: boolean;
  diagnostics?: SessionInventoryDiagnostic[];
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

type UsageTimeRange = CoreUsageTimeRange;

export interface UsageStartupScanResult {
  reads: UsageAdapterReadResult[];
  failures: UsageAdapterScanFailure[];
}

export interface UsageAdapterScanFailure {
  vendor: UsageVendor;
  message: string;
}

interface JsonlCursor {
  kind: "jsonl";
  dayKey: string;
  offset: number;
  identity: string;
  mtimeMs: number;
}

type SourceCursor = JsonlCursor;

interface SourceDescriptor {
  kind: "jsonl";
  role: MetadataSourceRoleId;
  path: string;
  size: number;
  mtimeMs: number;
  identity: string;
}

interface LocalUsageSourceParser {
  append(
    text: string,
    range: CoreUsageTimeRange,
    options?: { readonly eof?: boolean }
  ): readonly CoreUsageEventSample[];
  reset(): void;
}

interface LocalUsageProjectionSession {
  beginInventory(options: { readonly truncated: boolean }): void;
  applySourceClaim(options: {
    readonly role: MetadataSourceRoleId;
    readonly claim: UsageSourceClaim;
  }): void;
  createParser(options: {
    readonly role: MetadataSourceRoleId;
    readonly format: "jsonl";
    readonly sourcePath: string;
    readonly maximumPendingBytes: number;
  }): LocalUsageSourceParser;
}

interface LocalUsageSourceProjection {
  createSession(): LocalUsageProjectionSession;
}

export interface UsageSourceClaim {
  readonly sessionId: string;
  readonly claimedAtUnixMs?: number;
  readonly lastSeenAtUnixMs?: number;
  readonly cwd?: string;
  readonly workspacePaths?: readonly string[];
  readonly launchTitle?: string;
}

export interface UsageProjectionPreparationResult {
  readonly claims: readonly {
    readonly role: MetadataSourceRoleId;
    readonly claim: UsageSourceClaim;
  }[];
  readonly revision: string;
  readonly truncated?: boolean;
  readonly diagnostics?: readonly SessionInventoryDiagnostic[];
}

export interface UsageProjectionPreparationInput {
  readonly roots: readonly string[];
  readonly inventory: SessionInventory;
  readText(request: AgentMetadataTextReadRequest): Promise<string>;
  readonly query?: (
    request: AgentMetadataQueryRequest
  ) => Promise<AgentMetadataQueryResult>;
}

interface FileUsageAdapterOptions {
  watchRecursive?: boolean;
  sourceProjection: LocalUsageSourceProjection;
  classifySource(candidate: SessionInventoryCandidate): {
    readonly role: MetadataSourceRoleId;
    readonly format: "jsonl";
  } | null;
  prepareProjection?: (
    input: UsageProjectionPreparationInput
  ) => Promise<UsageProjectionPreparationResult>;
  probeProjectionRevision?: () => string;
  projectionRoots?: readonly string[];
  inventoryRoots?: readonly string[];
  inventoryLoader?: () => SessionInventory | Promise<SessionInventory>;
  inventoryWatch?: (onChange: (sourcePath?: string) => void) => () => void;
  inventoryInvalidate?: () => void;
  inventoryClose?: () => void;
  readText?: (request: AgentMetadataTextReadRequest) => Promise<string>;
  query?: (
    request: AgentMetadataQueryRequest
  ) => Promise<AgentMetadataQueryResult>;
}

export interface FileUsageAdapterDefinition {
  readonly agentId: AgentId;
  readonly roots: readonly string[];
  readonly watchRecursive?: boolean;
  readonly sourceProjection: LocalUsageSourceProjection;
  readonly classifySource: FileUsageAdapterOptions["classifySource"];
  readonly prepareProjection?: FileUsageAdapterOptions["prepareProjection"];
  readonly probeProjectionRevision?: FileUsageAdapterOptions["probeProjectionRevision"];
  readonly metadataInventory?: AgentMetadataInventoryService;
  readonly topologyRoots?: readonly string[];
}

class FileUsageAdapter implements UsageAdapter {
  readonly vendor: UsageVendor;

  private projectionSession: LocalUsageProjectionSession;
  private readonly parsers = new Map<string, LocalUsageSourceParser>();
  private readonly sourceProjection: LocalUsageSourceProjection;
  private readonly classifySource: FileUsageAdapterOptions["classifySource"];
  private readonly prepareProjection?: FileUsageAdapterOptions["prepareProjection"];
  private readonly probeProjectionRevision?: FileUsageAdapterOptions["probeProjectionRevision"];
  private readonly projectionRoots: readonly string[];
  private readonly inventoryRoots: readonly string[];
  private readonly inventoryLoader?: () =>
    | SessionInventory
    | Promise<SessionInventory>;
  private readonly inventoryWatch?: (
    onChange: (sourcePath?: string) => void
  ) => () => void;
  private readonly inventoryInvalidate?: () => void;
  private readonly inventoryClose?: () => void;
  private readonly readText?: (
    request: AgentMetadataTextReadRequest
  ) => Promise<string>;
  private readonly query?: (
    request: AgentMetadataQueryRequest
  ) => Promise<AgentMetadataQueryResult>;
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
  private inventoryTruncated = false;
  private inventoryDiagnostics: SessionInventoryDiagnostic[] = [];
  private projectionTruncated = false;
  private projectionDiagnostics: SessionInventoryDiagnostic[] = [];
  private projectionRevision: string | undefined;
  private projectionProbeRevision: string | undefined;

  constructor(
    vendor: UsageVendor,
    roots: string[],
    options: FileUsageAdapterOptions
  ) {
    this.vendor = vendor;
    this.roots = roots.filter(Boolean);
    this.sourceProjection = options.sourceProjection;
    this.projectionSession = options.sourceProjection.createSession();
    this.classifySource = options.classifySource;
    this.prepareProjection = options.prepareProjection;
    this.probeProjectionRevision = options.probeProjectionRevision;
    this.projectionRoots = options.projectionRoots ?? this.roots;
    this.inventoryRoots = options.inventoryRoots ?? this.roots;
    this.inventoryLoader = options.inventoryLoader;
    this.inventoryWatch = options.inventoryWatch;
    this.inventoryInvalidate = options.inventoryInvalidate;
    this.inventoryClose = options.inventoryClose;
    this.readText = options.readText;
    this.query = options.query;
    this.watchRecursive = options.watchRecursive ?? false;
  }

  async initialScan(startOfDayMs: number): Promise<UsageAdapterReadResult> {
    this.resetForInitialScan(startOfDayMs);
    return this.readAllSources({ fromMs: startOfDayMs });
  }

  private resetForInitialScan(startOfDayMs: number): void {
    this.dayKey = dayKeyFor(startOfDayMs);
    this.projectionSession = this.sourceProjection.createSession();
    this.parsers.clear();
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
    return this.readAllSources({ fromMs: startOfDayMs });
  }

  markDirty(options: UsageAdapterDirtyOptions = {}): void {
    const discoverNewSources = options.discoverNewSources ?? true;
    const markKnownSourcesDirty = options.markKnownSourcesDirty ?? true;
    if (discoverNewSources) {
      this.inventoryInvalidate?.();
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
    if (this.inventoryWatch) {
      this.hasWatchers = true;
      const stop = this.inventoryWatch((sourcePath) => {
        if (sourcePath && this.sources.has(sourcePath)) {
          this.dirtyPaths.add(sourcePath);
        } else {
          this.sourceIndexDirty = true;
          this.dirtySourceIndex = true;
          for (const knownPath of this.sources.keys()) {
            this.dirtyPaths.add(knownPath);
          }
        }
        onChange();
      });
      return () => {
        stop();
        this.hasWatchers = false;
      };
    }
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
    this.inventoryClose?.();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.hasWatchers = false;
  }

  private async readAllSources(
    range: UsageTimeRange
  ): Promise<UsageAdapterReadResult> {
    this.refreshProjectionProbe();
    const samples: UsageEventSample[] = [];
    const sources = await this.resolveSourcesForRead();
    const cursorDayKey = dayKeyFor(range.fromMs);

    for (const source of sources) {
      for (const sample of await this.readJsonlSource(
        source,
        range,
        cursorDayKey
      )) {
        samples.push(sample);
      }
    }

    return {
      samples,
      sourceCount: this.sources.size,
      truncated: this.inventoryTruncated || this.projectionTruncated,
      ...([...this.inventoryDiagnostics, ...this.projectionDiagnostics]
        .length === 0
        ? {}
        : {
            diagnostics: [
              ...this.inventoryDiagnostics,
              ...this.projectionDiagnostics
            ].map((diagnostic) => ({ ...diagnostic }))
          })
    };
  }

  private refreshProjectionProbe(): void {
    if (this.hasWatchers || !this.probeProjectionRevision) return;
    const revision = this.probeProjectionRevision();
    if (
      this.projectionProbeRevision !== undefined &&
      revision !== this.projectionProbeRevision
    ) {
      this.inventoryInvalidate?.();
      this.sourceIndexDirty = true;
      this.dirtySourceIndex = true;
    }
    this.projectionProbeRevision = revision;
  }

  private async resolveSourcesForRead(): Promise<SourceDescriptor[]> {
    const shouldResyncSourceIndex = this.shouldResyncSourceIndex();
    if (this.sourceIndexDirty || shouldResyncSourceIndex) {
      // A low-frequency resync must also revisit known files so append-only
      // providers still catch up when a filesystem watch event is missed.
      if (shouldResyncSourceIndex) this.inventoryInvalidate?.();
      await this.refreshSourceIndex(
        this.dirtySourceIndex || shouldResyncSourceIndex
      );
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

  private async refreshSourceIndex(markAllDirty: boolean): Promise<void> {
    const sharedInventory = this.inventoryLoader
      ? await this.inventoryLoader()
      : undefined;
    const inventory = collectUsageSources(
      this.inventoryRoots,
      this.classifySource,
      sharedInventory
    );
    await this.refreshProjection(inventory.inventory);
    const nextSources = inventory.sources;
    const nextSourceMap = new Map(
      nextSources.map((source) => [source.path, source] as const)
    );

    if (!inventory.truncated) {
      for (const existingPath of this.sources.keys()) {
        if (nextSourceMap.has(existingPath)) {
          continue;
        }
        this.removeTrackedSource(existingPath);
      }
    }

    for (const source of nextSources) {
      this.sources.set(source.path, source);
      if (markAllDirty || !this.cursors.has(source.path)) {
        this.dirtyPaths.add(source.path);
      }
    }

    this.inventoryTruncated = inventory.truncated;
    this.inventoryDiagnostics = inventory.diagnostics;
    this.sourceIndexDirty = inventory.truncated;
    this.lastSourceIndexRefreshAtMs = Date.now();
  }

  private async refreshProjection(inventory: SessionInventory): Promise<void> {
    this.projectionSession.beginInventory({ truncated: inventory.truncated });
    if (!this.prepareProjection) {
      this.projectionTruncated = false;
      this.projectionDiagnostics = [];
      return;
    }
    const prepared = await this.prepareProjection({
      roots: this.projectionRoots,
      inventory,
      readText: (request) =>
        this.readText
          ? this.readText(request)
          : Promise.resolve(
              readJsonlSlice(
                request.path,
                request.offset,
                request.offset + request.maxBytes
              )
            ),
      ...(this.query
        ? {
            query: (request: AgentMetadataQueryRequest) => this.query!(request)
          }
        : {})
    });
    this.projectionTruncated = prepared.truncated ?? false;
    this.projectionDiagnostics = prepared.diagnostics
      ? [...prepared.diagnostics]
      : [];
    for (const claim of prepared.claims) {
      this.projectionSession.applySourceClaim(claim);
    }
    if (
      this.projectionRevision !== undefined &&
      prepared.revision !== this.projectionRevision
    ) {
      for (const parser of this.parsers.values()) parser.reset();
      this.parsers.clear();
      this.cursors.clear();
      for (const sourcePath of this.sources.keys()) {
        this.dirtyPaths.add(sourcePath);
      }
    }
    this.projectionRevision = prepared.revision;
  }

  private markSourceDirty(
    root: string,
    filename: string | Buffer | null
  ): void {
    this.sourceIndexDirty = true;
    if (!filename) {
      return;
    }

    const absolutePath = resolve(root, filename.toString());
    const canonicalPath = canonicalUsageSourcePath(absolutePath);
    const stats = safeStat(canonicalPath);
    if (!stats) {
      this.removeTrackedSource(canonicalPath);
      return;
    }
    if (stats.isDirectory()) {
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    if (this.sources.has(canonicalPath)) {
      this.dirtyPaths.add(canonicalPath);
    }
  }

  private shouldResyncSourceIndex(): boolean {
    return (
      Date.now() - this.lastSourceIndexRefreshAtMs >= SOURCE_INDEX_RESYNC_MS
    );
  }

  private removeTrackedSource(sourcePath: string): void {
    this.sources.delete(sourcePath);
    this.cursors.delete(sourcePath);
    this.parsers.get(sourcePath)?.reset();
    this.parsers.delete(sourcePath);
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

  private async readJsonlSource(
    source: SourceDescriptor,
    range: UsageTimeRange,
    cursorDayKey: string
  ): Promise<UsageEventSample[]> {
    const state =
      readSourceState(source.path) ??
      (this.readText
        ? {
            identity: source.identity,
            size: source.size,
            mtimeMs: source.mtimeMs
          }
        : null);
    if (!state) return this.removeMissingSource(source.path);
    const { identity, size, mtimeMs } = state;

    const previous = this.cursors.get(source.path);
    const canContinue =
      previous?.kind === "jsonl" &&
      previous.dayKey === cursorDayKey &&
      previous.identity === identity &&
      size >= previous.offset;
    const offset = canContinue ? previous.offset : 0;
    let parser = this.parsers.get(source.path);
    if (!parser) {
      parser = this.projectionSession.createParser({
        role: source.role,
        format: "jsonl",
        sourcePath: source.path,
        maximumPendingBytes: MAX_USAGE_JSONL_RECORD_BYTES
      });
      this.parsers.set(source.path, parser);
    } else if (!canContinue) {
      parser.reset();
    }

    const samples: UsageEventSample[] = [];
    const appendChunk = (text: string) => {
      samples.push(...parser.append(text, range));
    };
    if (this.readText) {
      await streamSharedTextRange(
        this.readText,
        source.path,
        offset,
        size,
        appendChunk
      );
    } else {
      streamLocalTextRange(source.path, offset, size, appendChunk);
    }
    samples.push(...parser.append("", range, { eof: true }));

    this.cursors.set(source.path, {
      kind: "jsonl",
      dayKey: cursorDayKey,
      offset: size,
      identity,
      mtimeMs
    });

    return samples;
  }

  private removeMissingSource(sourcePath: string): [] {
    this.removeTrackedSource(sourcePath);
    return [];
  }
}

export function createFileUsageAdapter(
  definition: FileUsageAdapterDefinition
): UsageAdapter {
  const topologyRoots = [...(definition.topologyRoots ?? definition.roots)];
  const metadataInventory = definition.metadataInventory;
  const topologyLease = metadataInventory?.acquire(
    definition.agentId,
    topologyRoots
  );
  const loadInventory = topologyLease
    ? () => topologyLease.inventory()
    : undefined;
  return new FileUsageAdapter(definition.agentId, [...definition.roots], {
    sourceProjection: definition.sourceProjection,
    classifySource: definition.classifySource,
    projectionRoots: topologyRoots,
    inventoryRoots: topologyRoots,
    ...(definition.prepareProjection
      ? { prepareProjection: definition.prepareProjection }
      : {}),
    ...(definition.probeProjectionRevision
      ? { probeProjectionRevision: definition.probeProjectionRevision }
      : {}),
    ...(definition.watchRecursive === undefined
      ? {}
      : { watchRecursive: definition.watchRecursive }),
    ...(topologyLease
      ? {
          inventoryLoader: loadInventory,
          inventoryWatch: (onChange: (sourcePath?: string) => void) =>
            topologyLease.watch(onChange),
          inventoryInvalidate: () => topologyLease.invalidate(),
          inventoryClose: () => void topologyLease.release(),
          readText: (request: AgentMetadataTextReadRequest) =>
            topologyLease.readText(request),
          query: (request: AgentMetadataQueryRequest) =>
            topologyLease.query(request)
        }
      : {})
  });
}

export async function scanUsageAdaptersAtStartup(
  adapters: UsageAdapter[],
  options: {
    startOfDayMs: number;
  }
): Promise<UsageStartupScanResult> {
  return scanUsageAdapters(adapters, {
    startOfDayMs: options.startOfDayMs,
    initial: true
  });
}

export async function scanUsageAdapters(
  adapters: UsageAdapter[],
  options: {
    startOfDayMs: number;
    initial: boolean;
  }
): Promise<UsageStartupScanResult> {
  const settled = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return {
          read: options.initial
            ? await adapter.initialScan(options.startOfDayMs)
            : await adapter.readIncremental(options.startOfDayMs)
        };
      } catch (error) {
        return {
          failure: {
            vendor: adapter.vendor,
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    })
  );
  return {
    reads: settled.flatMap((result) => (result.read ? [result.read] : [])),
    failures: settled.flatMap((result) =>
      result.failure ? [result.failure] : []
    )
  };
}

function collectUsageSources(
  roots: readonly string[],
  classifySource: FileUsageAdapterOptions["classifySource"],
  sharedInventory?: SessionInventory
): {
  sources: SourceDescriptor[];
  truncated: boolean;
  diagnostics: SessionInventoryDiagnostic[];
  inventory: SessionInventory;
} {
  const sources: SourceDescriptor[] = [];
  const inventory = sharedInventory ?? collectSessionInventory(roots);
  let truncated = inventory.truncated;
  const matching = inventory.candidates
    .map((candidate) => ({
      candidate,
      classification: classifySource(candidate)
    }))
    .filter(
      (
        entry
      ): entry is {
        candidate: SessionInventoryCandidate;
        classification: { role: MetadataSourceRoleId; format: "jsonl" };
      } => entry.classification !== null
    );
  if (matching.length > MAX_USAGE_PARSE_CANDIDATES) {
    matching.length = MAX_USAGE_PARSE_CANDIDATES;
    truncated = true;
  }
  for (const { candidate, classification } of matching) {
    if (!JSONL_EXTENSIONS.has(extname(candidate.path).toLowerCase())) continue;
    sources.push({
      kind: "jsonl",
      role: classification.role,
      path: candidate.path,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      identity:
        candidate.identity ??
        `${candidate.path}\0${candidate.birthtimeMs ?? candidate.mtimeMs}`
    });
  }

  return {
    sources,
    truncated,
    diagnostics: inventory.diagnostics,
    inventory
  };
}

function canonicalUsageSourcePath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    try {
      return join(realpathSync.native(dirname(filePath)), basename(filePath));
    } catch {
      return filePath;
    }
  }
}

function safeStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function readSourceState(filePath: string): {
  size: number;
  mtimeMs: number;
  identity: string;
} | null {
  const stats = safeStat(filePath);
  if (!stats?.isFile()) return null;
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    identity: fileIdentity(Number(stats.dev), Number(stats.ino), filePath)
  };
}

function fileIdentity(dev: number, inode: number, filePath: string): string {
  return Number.isFinite(dev) && Number.isFinite(inode)
    ? `${dev}:${inode}`
    : filePath;
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

function streamLocalTextRange(
  path: string,
  offset: number,
  fileSize: number,
  onChunk: (text: string) => void
): void {
  let nextOffset = Math.max(0, Math.min(offset, fileSize));
  if (nextOffset >= fileSize) return;
  const decoder = new TextDecoder("utf-8");
  const fd = openSync(path, "r");
  try {
    while (nextOffset < fileSize) {
      const byteLength = Math.min(MAX_SHARED_READ_BYTES, fileSize - nextOffset);
      const buffer = Buffer.allocUnsafe(byteLength);
      const bytesRead = readSync(fd, buffer, 0, byteLength, nextOffset);
      if (bytesRead <= 0) {
        throw new Error("local metadata source read made no progress");
      }
      nextOffset += bytesRead;
      const text = decoder.decode(buffer.subarray(0, bytesRead), {
        stream: nextOffset < fileSize
      });
      if (text) onChunk(text);
    }
    const trailing = decoder.decode();
    if (trailing) onChunk(trailing);
  } finally {
    closeSync(fd);
  }
}

async function streamSharedTextRange(
  readText: (request: AgentMetadataTextReadRequest) => Promise<string>,
  path: string,
  offset: number,
  fileSize: number,
  onChunk: (text: string) => void
): Promise<void> {
  let nextOffset = Math.max(0, Math.min(offset, fileSize));
  while (nextOffset < fileSize) {
    const maxBytes = MAX_SHARED_READ_BYTES;
    const chunk = await readText({ path, offset: nextOffset, maxBytes });
    const bytesRead = Buffer.byteLength(chunk, "utf8");
    if (bytesRead <= 0) {
      throw new Error("shared metadata source read made no progress");
    }
    nextOffset += bytesRead;
    onChunk(chunk);
  }
}

export function usageSampleIdentity(sample: UsageEventSample): string {
  return coreUsageSampleIdentity(sample);
}

export function shouldReplaceUsageSample(
  existing: UsageEventSample,
  candidate: UsageEventSample
): boolean {
  return shouldReplaceCoreUsageSample(existing, candidate);
}

function dayKeyFor(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
