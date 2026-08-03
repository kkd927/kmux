import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve
} from "node:path";
import {
  type AgentStorageRoots,
  resolveAgentSessionRoots,
  resolveAgentStorageRoots
} from "./agentStorage";
import type { AgentScopeSettings } from "@kmux/proto";
import { readAntigravityConversationMetadataFromInventory } from "./antigravityStorage";
import { isCodexSubagentSessionMetadata } from "./codexSession";
import {
  classifySessionInventoryCandidate,
  collectSessionInventory,
  type SessionInventoryCandidate,
  type SessionInventoryDiagnostic
} from "./sessionInventory";
import {
  consumeCoreUsageJsonLine,
  coreUsageSampleIdentity,
  createCoreUsageParserState,
  parseCoreUsageJsonDocument,
  shouldReplaceCoreUsageSample
} from "./core/usage";

const JSON_EXTENSIONS = new Set([".json"]);
const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const WATCH_DEBOUNCE_MS = 180;
const SOURCE_INDEX_RESYNC_MS = 60_000;
const WATCH_ROOT_RETRY_MS = 60_000;
const CODEX_IDENTITY_SCAN_BYTES = 64 * 1024;
const MAX_USAGE_PARSE_CANDIDATES = 4_096 * 8;

export const USAGE_AGGREGATION_REVISION = "codex-root-authoritative-v2";

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
  initialScanRange?(
    range: UsageTimeRange,
    cursorDayStartMs: number
  ): Promise<UsageAdapterReadResult>;
  readIncremental(startOfDayMs: number): Promise<UsageAdapterReadResult>;
  markDirty?(options?: UsageAdapterDirtyOptions): void;
  watch(onChange: () => void): () => void;
  close(): void;
}

export interface CreateUsageAdaptersOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
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

type CodexSourceIdentity = {
  inode: number;
  isSubagent: boolean;
};

interface AntigravityWorkspaceInventory {
  workspaces: Map<string, string>;
  truncated: boolean;
  diagnostics: SessionInventoryDiagnostic[];
}

interface CachedAntigravityWorkspaceInventory {
  candidateSignature: string;
  fastProbeSignature: string;
  inventory: AntigravityWorkspaceInventory;
  lastFullScanAtMs: number;
}

interface AntigravityWorkspaceCandidateInventory {
  candidates: SessionInventoryCandidate[];
  diagnostics: SessionInventoryDiagnostic[];
  signature: string;
  truncated: boolean;
}

interface FileUsageAdapterOptions {
  includeJson?: boolean;
  includeHiddenDirs?: boolean;
  watchRecursive?: boolean;
  antigravityWorkspaceByConversation?: Map<string, string>;
  antigravityWorkspaceByConversationLoader?: () => AntigravityWorkspaceInventory;
}

class FileUsageAdapter implements UsageAdapter {
  readonly vendor: UsageVendor;

  private readonly coreParserState = createCoreUsageParserState();
  private readonly codexContexts = this.coreParserState.codexContexts;
  private readonly codexTotals = this.coreParserState.codexTotals;
  private readonly codexSourceIdentities = new Map<
    string,
    CodexSourceIdentity
  >();
  private readonly antigravityContexts =
    this.coreParserState.antigravityContexts;
  private readonly antigravityWorkspaceByConversation =
    this.coreParserState.antigravityWorkspaceByConversation;
  private readonly antigravityWorkspaceByConversationLoader?: () => AntigravityWorkspaceInventory;
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
  private inventoryTruncated = false;
  private inventoryDiagnostics: SessionInventoryDiagnostic[] = [];
  private workspaceInventoryTruncated = false;
  private workspaceInventoryDiagnostics: SessionInventoryDiagnostic[] = [];

  constructor(
    vendor: UsageVendor,
    roots: string[],
    options: FileUsageAdapterOptions = {}
  ) {
    this.vendor = vendor;
    this.roots = roots.filter(Boolean);
    this.antigravityWorkspaceByConversationLoader =
      options.antigravityWorkspaceByConversationLoader;
    for (const [
      conversationId,
      workspace
    ] of options.antigravityWorkspaceByConversation ?? []) {
      this.antigravityWorkspaceByConversation.set(conversationId, workspace);
    }
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
      sourceCount: this.sources.size,
      truncated: this.inventoryTruncated || this.workspaceInventoryTruncated,
      ...([...this.inventoryDiagnostics, ...this.workspaceInventoryDiagnostics]
        .length === 0
        ? {}
        : {
            diagnostics: [
              ...this.inventoryDiagnostics,
              ...this.workspaceInventoryDiagnostics
            ].map((diagnostic) => ({ ...diagnostic }))
          })
    };
  }

  private refreshAntigravityWorkspaceByConversation(): void {
    if (
      this.vendor !== "antigravity" ||
      !this.antigravityWorkspaceByConversationLoader
    ) {
      return;
    }
    const workspaceInventory = this.antigravityWorkspaceByConversationLoader();
    this.workspaceInventoryTruncated = workspaceInventory.truncated;
    this.workspaceInventoryDiagnostics = workspaceInventory.diagnostics;
    const nextWorkspaces = workspaceInventory.truncated
      ? new Map([
          ...this.antigravityWorkspaceByConversation,
          ...workspaceInventory.workspaces
        ])
      : workspaceInventory.workspaces;
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
    const inventory = collectUsageSources(this.vendor, this.roots, {
      includeJson: this.includeJson,
      includeHiddenDirs: this.includeHiddenDirs
    });
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
    this.codexContexts.delete(sourcePath);
    this.codexTotals.delete(sourcePath);
    this.codexSourceIdentities.delete(sourcePath);
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

    // Codex team counters are shared with the root conversation. Forked
    // rollout files replay that same counter, so reading them would count the
    // team's usage once per subagent. The root rollout remains authoritative.
    if (this.isCodexSubagentSource(source.path, Number(stats.ino))) {
      if (useCursors) {
        this.cursors.set(source.path, {
          kind: "jsonl",
          dayKey: cursorDayKey,
          offset: Number(stats.size),
          inode: Number(stats.ino),
          mtimeMs: Number(stats.mtimeMs)
        });
      }
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
      offset = consumeCoreUsageJsonLine(
        samples,
        this.vendor,
        source.path,
        range,
        line,
        offset,
        true,
        this.coreParserState
      );
    }

    const trailingLine = endedWithNewline ? "" : (lines.at(-1) ?? "");
    if (trailingLine) {
      offset = consumeCoreUsageJsonLine(
        samples,
        this.vendor,
        source.path,
        range,
        trailingLine,
        offset,
        false,
        this.coreParserState
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

  private isCodexSubagentSource(sourcePath: string, inode: number): boolean {
    if (this.vendor !== "codex") {
      return false;
    }
    const cached = this.codexSourceIdentities.get(sourcePath);
    if (cached?.inode === inode) {
      return cached.isSubagent;
    }
    const metadata = readFirstCodexSessionMetadata(sourcePath);
    if (!metadata) {
      return false;
    }
    const identity = {
      inode,
      isSubagent: isCodexSubagentSessionMetadata(metadata)
    };
    this.codexSourceIdentities.set(sourcePath, identity);
    return identity.isSubagent;
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
      const samples = parseCoreUsageJsonDocument({
        vendor: this.vendor,
        value: parsed,
        sourcePath: source.path,
        range,
        state: this.coreParserState
      });
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
  const sessionRoots = resolveAgentSessionRoots({
    agentStorageRoots,
    agentSettings: options.agentSettings
  });
  const antigravityRoots =
    options.agentSettings?.antigravity?.sessionRoot === undefined &&
    env.KMUX_ANTIGRAVITY_USAGE_DIR?.trim()
      ? resolveRoots(
          env.KMUX_ANTIGRAVITY_USAGE_DIR,
          agentStorageRoots.antigravity.brainDir
        )
      : sessionRoots.antigravity.map((root) => join(root, "brain"));
  const antigravityWorkspaceInventoryLoader =
    createAntigravityWorkspaceInventoryLoader(sessionRoots.antigravity);

  return [
    new FileUsageAdapter(
      "claude",
      options.agentSettings?.claude?.sessionRoot === undefined &&
        env.KMUX_CLAUDE_USAGE_DIR?.trim()
        ? resolveRoots(
            env.KMUX_CLAUDE_USAGE_DIR,
            agentStorageRoots.claude.projectsDir
          )
        : sessionRoots.claude,
      { watchRecursive }
    ),
    new FileUsageAdapter(
      "codex",
      options.agentSettings?.codex?.sessionRoot === undefined &&
        env.KMUX_CODEX_USAGE_DIR?.trim()
        ? resolveRoots(
            env.KMUX_CODEX_USAGE_DIR,
            agentStorageRoots.codex.sessionsDir
          )
        : sessionRoots.codex,
      { watchRecursive }
    ),
    new FileUsageAdapter("antigravity", antigravityRoots, {
      antigravityWorkspaceByConversationLoader:
        antigravityWorkspaceInventoryLoader,
      includeHiddenDirs: true,
      watchRecursive
    })
  ];
}

function createAntigravityWorkspaceInventoryLoader(
  roots: string[]
): () => AntigravityWorkspaceInventory {
  let cached: CachedAntigravityWorkspaceInventory | undefined;
  const fastProbePaths = antigravityWorkspaceFastProbePaths(roots);
  return () => {
    // Workspace metadata lives outside the watched brain roots. Probe its
    // stable entry points on each read, then revalidate every candidate only
    // on the same low-frequency interval used by the usage source inventory.
    const fastProbeSignature =
      antigravityWorkspaceProbeSignature(fastProbePaths);
    if (
      cached &&
      fastProbeSignature === cached.fastProbeSignature &&
      Date.now() - cached.lastFullScanAtMs < SOURCE_INDEX_RESYNC_MS
    ) {
      return cloneAntigravityWorkspaceInventory(cached.inventory);
    }

    const collected = collectAntigravityWorkspaceCandidates(roots);
    const inventory =
      cached?.candidateSignature === collected.signature
        ? cached.inventory
        : buildAntigravityWorkspaceInventory(roots, collected);
    cached = {
      candidateSignature: collected.signature,
      fastProbeSignature,
      inventory,
      lastFullScanAtMs: Date.now()
    };
    return cloneAntigravityWorkspaceInventory(inventory);
  };
}

function collectAntigravityWorkspaceCandidates(
  roots: string[]
): AntigravityWorkspaceCandidateInventory {
  const inventory = collectSessionInventory(roots);
  const candidateByPath = new Map(
    inventory.candidates.map(
      (candidate) => [candidate.path, candidate] as const
    )
  );
  const candidates = inventory.candidates
    .filter((candidate) =>
      roots.some((root) => {
        const role = classifySessionInventoryCandidate(
          "antigravity",
          root,
          candidate.path
        );
        return (
          role === "antigravity-history" ||
          role === "antigravity-conversation" ||
          role === "antigravity-project-index"
        );
      })
    )
    .map((candidate) =>
      candidate.path.endsWith(".db")
        ? {
            ...candidate,
            mtimeMs: Math.max(
              candidate.mtimeMs,
              candidateByPath.get(`${candidate.path}-wal`)?.mtimeMs ?? 0
            )
          }
        : candidate
    )
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
    );
  const parsingTruncated = candidates.length > MAX_USAGE_PARSE_CANDIDATES;
  if (parsingTruncated) {
    candidates.length = MAX_USAGE_PARSE_CANDIDATES;
  }
  const signature = antigravityWorkspaceCandidateSignature(
    candidates,
    candidateByPath,
    inventory.truncated || parsingTruncated,
    inventory.diagnostics
  );

  return {
    candidates,
    diagnostics: inventory.diagnostics,
    signature,
    truncated: inventory.truncated || parsingTruncated
  };
}

function buildAntigravityWorkspaceInventory(
  roots: readonly string[],
  collected: AntigravityWorkspaceCandidateInventory
): AntigravityWorkspaceInventory {
  const workspaces = new Map<string, string>();
  for (const root of roots) {
    for (const conversation of readAntigravityConversationMetadataFromInventory(
      root,
      collected.candidates,
      { maxConversationFiles: MAX_USAGE_PARSE_CANDIDATES }
    )) {
      if (
        conversation.workspace &&
        !workspaces.has(conversation.conversationId)
      ) {
        workspaces.set(conversation.conversationId, conversation.workspace);
      }
    }
  }
  return {
    workspaces,
    truncated: collected.truncated,
    diagnostics: collected.diagnostics
  };
}

function antigravityWorkspaceCandidateSignature(
  candidates: readonly SessionInventoryCandidate[],
  candidateByPath: ReadonlyMap<string, SessionInventoryCandidate>,
  truncated: boolean,
  diagnostics: readonly SessionInventoryDiagnostic[]
): string {
  const candidateSignatures = candidates.map((candidate) => {
    const rawCandidate = candidateByPath.get(candidate.path) ?? candidate;
    const wal = candidate.path.endsWith(".db")
      ? candidateByPath.get(`${candidate.path}-wal`)
      : undefined;
    return [
      candidate.path,
      rawCandidate.size,
      rawCandidate.mtimeMs,
      candidate.mtimeMs,
      wal?.path ?? "",
      wal?.size ?? "",
      wal?.mtimeMs ?? ""
    ].join("\0");
  });
  const diagnosticSignatures = diagnostics.map((diagnostic) =>
    [
      diagnostic.root,
      diagnostic.path,
      diagnostic.kind,
      diagnostic.message ?? ""
    ].join("\0")
  );
  return [
    truncated ? "truncated" : "complete",
    ...candidateSignatures,
    ...diagnosticSignatures
  ].join("\n");
}

function antigravityWorkspaceFastProbePaths(
  roots: readonly string[]
): string[] {
  const paths = new Set<string>();
  for (const root of roots) {
    paths.add(resolve(root));
    paths.add(resolve(root, "cache"));
    paths.add(resolve(root, "cache", "projects.json"));
    paths.add(resolve(root, "conversations"));
    paths.add(resolve(root, "history.jsonl"));
  }
  return Array.from(paths).sort();
}

function antigravityWorkspaceProbeSignature(paths: readonly string[]): string {
  return paths
    .map((path) => {
      try {
        const stats = statSync(path);
        return [
          path,
          stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          Number(stats.size),
          Number(stats.mtimeMs)
        ].join("\0");
      } catch {
        return `${path}\0missing`;
      }
    })
    .join("\n");
}

function cloneAntigravityWorkspaceInventory(
  inventory: AntigravityWorkspaceInventory
): AntigravityWorkspaceInventory {
  return {
    workspaces: new Map(inventory.workspaces),
    truncated: inventory.truncated,
    diagnostics: inventory.diagnostics.map((diagnostic) => ({
      ...diagnostic
    }))
  };
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
          truncated: historyRead.truncated,
          ...(historyRead.diagnostics === undefined
            ? {}
            : {
                diagnostics: historyRead.diagnostics.map((diagnostic) => ({
                  ...diagnostic
                }))
              }),
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
  agentSettings?: AgentScopeSettings;
  platform?: NodeJS.Platform;
  fromMs: number;
  toMs: number;
}): Promise<UsageHistoryDay[]> {
  const adapters = createUsageAdapters({
    env: options.env,
    homeDir: options.homeDir,
    agentStorageRoots: options.agentStorageRoots,
    agentSettings: options.agentSettings,
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
): {
  sources: SourceDescriptor[];
  truncated: boolean;
  diagnostics: SessionInventoryDiagnostic[];
} {
  const sources: SourceDescriptor[] = [];
  const inventory = collectSessionInventory(roots);
  let truncated = inventory.truncated;

  if (vendor === "unknown") {
    return {
      sources,
      truncated,
      diagnostics: inventory.diagnostics
    };
  }
  const matching = inventory.candidates.filter(
    (candidate) =>
      roots.some(
        (root) =>
          classifySessionInventoryCandidate(vendor, root, candidate.path) !==
          null
      ) ||
      ((vendor === "codex" || vendor === "claude") &&
        extname(candidate.path).toLowerCase() === ".ndjson")
  );
  if (matching.length > MAX_USAGE_PARSE_CANDIDATES) {
    matching.length = MAX_USAGE_PARSE_CANDIDATES;
    truncated = true;
  }
  for (const candidate of matching) {
    const source = describeUsageSource(vendor, candidate.path, options);
    if (source) {
      sources.push(source);
    }
  }

  return {
    sources,
    truncated,
    diagnostics: inventory.diagnostics
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

function readFirstCodexSessionMetadata(
  filePath: string
): Record<string, unknown> | null {
  const prefix = readJsonlSlice(filePath, 0, CODEX_IDENTITY_SCAN_BYTES);
  for (const line of prefix.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (record.type === "session_meta" && isRecord(record.payload)) {
        return record.payload;
      }
    } catch {
      // The prefix may end in the middle of a JSONL record.
    }
  }
  return null;
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
  return coreUsageSampleIdentity(sample);
}

export function shouldReplaceUsageSample(
  existing: UsageEventSample,
  candidate: UsageEventSample
): boolean {
  return shouldReplaceCoreUsageSample(existing, candidate);
}

function usageHistorySampleIdentity(sample: UsageEventSample): string {
  return [dayKeyFor(sample.timestampMs), usageSampleIdentity(sample)].join(
    "\t"
  );
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
