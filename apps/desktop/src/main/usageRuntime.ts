import { basename, dirname } from "node:path";
import { BrowserWindow } from "electron";

import {
  encodeLocatedPathDto,
  terminalRuntimeMetadataForSurface,
  terminalSessionForSurface,
  type AppAction,
  type AppState,
  type LocatedPath,
  type WorkspaceTarget
} from "@kmux/core";
import type { Id } from "@kmux/proto";
import {
  createEmptyUsageViewSnapshot,
  isoNow,
  type ModelUsageVm,
  type SubscriptionProviderUsageVm,
  type UsageCostSource,
  type UsageDailyActivityVm,
  type UsageAttributionState,
  type UsagePricingCoverageVm,
  type UsageTargetIdentityVm,
  type UsageUnavailableTargetVm,
  type UsageTokenCostBreakdownVm,
  type UsageTokenBreakdownVm,
  type UsageVendor,
  type UsageViewSnapshot
} from "@kmux/proto";
import {
  resolveAiCliProcessMatches,
  isProcessAlive,
  type AgentStorageRoots,
  type AiCliProcessMatch,
  type AiCliProcessProbe,
  estimateUsageComponentCosts,
  resolveCanonicalModelId,
  scanUsageHistoryDays,
  shouldReplaceUsageSample,
  usageSampleIdentity,
  type SupportedPricingVendor,
  type UsageAdapter,
  type UsageAdapterReadResult,
  type UsageCostSource as SampleCostSource,
  type UsageEventSample
} from "@kmux/metadata";
import type {
  UsageHistoryDayRecord,
  UsageHistoryFileStore
} from "@kmux/persistence";

import {
  createSubscriptionAuthDetectors,
  createSubscriptionUsageFetchers,
  formatResetLabel,
  type SubscriptionProviderAuthDetector,
  type SubscriptionProviderFetcher
} from "./subscriptionUsage";
import {
  createUsageScanWorkerClient,
  type UsageScanService
} from "./usageScanWorkerClient";
import type { LocalPathResolver } from "./targets/targetServiceRegistry";
import type {
  TargetServiceRegistry,
  TargetUsageRecord
} from "./targets/contracts";

const ACTIVE_REFRESH_MS = 10_000;
const DASHBOARD_REFRESH_MS = 15_000;
const BACKGROUND_USAGE_REFRESH_MS = 60_000;
const SUBSCRIPTION_LIVE_REFRESH_MS = 3 * 60 * 1000;
const SUBSCRIPTION_RECENT_REFRESH_MS = 10 * 60 * 1000;
const SUBSCRIPTION_INTERACTIVE_REFRESH_COOLDOWN_MS = 60_000;
const SUBSCRIPTION_RESET_REFRESH_GRACE_MS = 30_000;
const SUBSCRIPTION_STALE_RESET_RETRY_MS = 60_000;
const SUBSCRIPTION_FAILURE_BACKOFF_MS = [
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000
];

function getSubscriptionRefreshMs(visibility: SubscriptionVisibility): number {
  return visibility === "live"
    ? SUBSCRIPTION_LIVE_REFRESH_MS
    : SUBSCRIPTION_RECENT_REFRESH_MS;
}
const MANUAL_CLI_CANDIDATE_TTL_MS = 15_000;
const AUTH_VISIBILITY_REFRESH_MS = 5 * 60 * 1000;
const MANUAL_CLI_BIND_GRACE_MS = 5_000;
const MANUAL_USAGE_CATCHUP_DELAYS_MS = [1_000, 3_000];
const MANUAL_INPUT_BUFFER_LIMIT = 512;
const USAGE_HISTORY_DAY_COUNT = 210;
type SurfaceBindingSource = "agent" | "manual_cli";

type SurfaceBinding = {
  surfaceId: Id;
  workspaceId: Id;
  vendor: Exclude<UsageVendor, "unknown">;
  source: SurfaceBindingSource;
  kmuxSessionId: Id;
  vendorSessionId?: string;
  vendorProcessId?: number;
  cwd?: LocatedPath;
  boundAtMs: number;
  lastAgentEventAtMs: number;
};

type DerivedSurface = {
  surfaceId: Id;
  workspaceId: Id;
  vendor: Exclude<UsageVendor, "unknown">;
  model?: string;
  sessionCostUsd: number;
  sessionTokens: number;
  todayCostUsd: number;
  todayTokens: number;
  updatedAtMs: number;
  attributionState: UsageAttributionState;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
};

type DerivedWorkspace = {
  workspaceId: Id;
  todayCostUsd: number;
  todayTokens: number;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
};

type DerivedDirectory = {
  target: UsageTargetIdentityVm;
  directoryPath: string;
  todayCostUsd: number;
  todayTokens: number;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
};

type DerivedTarget = {
  target: UsageTargetIdentityVm;
  todayCostUsd: number;
  todayTokens: number;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
  truncated: boolean;
};

type ScopedUsageEventSample = UsageEventSample & {
  usageTarget: WorkspaceTarget;
  principal?: { uid: number; accountName: string };
};

type DerivedVendor = {
  vendor: Exclude<UsageVendor, "unknown">;
  todayCostUsd: number;
  todayTokens: number;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
};

type DerivedModel = {
  vendor: Exclude<UsageVendor, "unknown">;
  modelId: string;
  modelLabel: string;
  todayCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costSource: UsageCostSource;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
};

type UsageSampleMatch = {
  surfaceId: Id;
  attribution: "session" | "path";
  attributionState: UsageAttributionState;
};

type ManualCliCandidate = {
  surfaceId: Id;
  vendor: Exclude<UsageVendor, "unknown">;
  submittedAtMs: number;
  expiresAtMs: number;
  nextProbeAtMs: number;
};

type ResolveAiCliProcesses = (
  probes: AiCliProcessProbe[]
) => Promise<Map<number, AiCliProcessMatch>>;

type SubscriptionProvider = Exclude<UsageVendor, "unknown">;
type PricingVendor = SupportedPricingVendor;
type SubscriptionVisibility = "live" | "recent";
const SUBSCRIPTION_PROVIDER_ORDER: SubscriptionProvider[] = [
  "codex",
  "claude",
  "antigravity"
];
const DISCOVER_ONLY_DIRTY_OPTIONS = {
  discoverNewSources: true,
  markKnownSourcesDirty: false
} as const;

function getNextSubscriptionPollAtMs(
  nowMs: number,
  visibility: SubscriptionVisibility,
  providerUsage: SubscriptionProviderUsageVm | null
): number {
  const cadencePollAtMs = nowMs + getSubscriptionRefreshMs(visibility);
  const resetDrivenPollAtMs = getResetDrivenPollAtMs(providerUsage, nowMs, {
    staleDelayMs: SUBSCRIPTION_STALE_RESET_RETRY_MS
  });
  return resetDrivenPollAtMs === null
    ? cadencePollAtMs
    : Math.min(cadencePollAtMs, resetDrivenPollAtMs);
}

function getResetDrivenPollAtMs(
  providerUsage: SubscriptionProviderUsageVm | null | undefined,
  nowMs: number,
  options: { staleDelayMs?: number } = {}
): number | null {
  const resetTimes =
    providerUsage?.rows.flatMap((row) => {
      if (!row.resetsAt) {
        return [];
      }
      const resetAtMs = Date.parse(row.resetsAt);
      return Number.isFinite(resetAtMs) ? [resetAtMs] : [];
    }) ?? [];

  if (resetTimes.length === 0) {
    return null;
  }
  if (resetTimes.some((resetAtMs) => resetAtMs <= nowMs)) {
    return nowMs + (options.staleDelayMs ?? 0);
  }

  let nextResetAtMs = Number.POSITIVE_INFINITY;
  for (const resetAtMs of resetTimes) {
    nextResetAtMs = Math.min(nextResetAtMs, resetAtMs);
  }
  return nextResetAtMs + SUBSCRIPTION_RESET_REFRESH_GRACE_MS;
}

type SubscriptionPollState = {
  failureCount: number;
  nextPollAtMs: number;
  visibility: SubscriptionVisibility;
};

interface UsageRuntimeOptions {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  adapters?: UsageAdapter[];
  scanService?: UsageScanService;
  historyStore?: UsageHistoryFileStore;
  resolveAiCliProcesses?: ResolveAiCliProcesses;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  now?: () => number;
  emitSnapshot?: (snapshot: UsageViewSnapshot) => void;
  subscriptionFetchers?: Partial<
    Record<SubscriptionProvider, SubscriptionProviderFetcher>
  >;
  subscriptionAuthDetectors?: Partial<
    Record<SubscriptionProvider, SubscriptionProviderAuthDetector>
  >;
  resolveLocalPath: LocalPathResolver;
  targetServices?: () => TargetServiceRegistry | undefined;
  reportTargetUsageError?: (target: WorkspaceTarget, error: Error) => void;
}

export interface UsageRuntime {
  start(): void;
  shutdown(): void;
  getSnapshot(): UsageViewSnapshot;
  getSurfaceVendor(surfaceId: Id): UsageVendor;
  handleAppAction(action: AppAction): void;
  handleTerminalInput(surfaceId: Id, text: string): void;
  setDashboardOpen(open: boolean): void;
  refreshNow(): Promise<void>;
}

export function createUsageRuntime(options: UsageRuntimeOptions): UsageRuntime {
  const adapters = options.adapters ?? [];
  const scanService =
    options.targetServices === undefined
      ? (options.scanService ??
        (options.adapters === undefined
          ? createUsageScanWorkerClient({
              env: options.env,
              homeDir: options.homeDir,
              agentStorageRoots: options.agentStorageRoots,
              platform: options.platform
            })
          : null))
      : null;
  const emitSnapshot =
    options.emitSnapshot ??
    ((snapshot: UsageViewSnapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("kmux:usage", snapshot);
      }
    });
  const now = options.now ?? (() => Date.now());
  const resolveAiCliProcesses =
    options.resolveAiCliProcesses ??
    ((probes: AiCliProcessProbe[]) =>
      resolveAiCliProcessMatches(probes, options.env));
  const subscriptionFetchers = {
    ...createSubscriptionUsageFetchers({
      env: options.env,
      homeDir: options.homeDir,
      agentStorageRoots: options.agentStorageRoots,
      platform: options.platform,
      now
    }),
    ...(options.subscriptionFetchers ?? {})
  };
  const subscriptionAuthDetectors =
    options.subscriptionAuthDetectors ??
    createSubscriptionAuthDetectors({
      env: options.env,
      homeDir: options.homeDir,
      agentStorageRoots: options.agentStorageRoots,
      platform: options.platform,
      now
    });

  let snapshot = createEmptyUsageViewSnapshot(dayKeyFor(now()), isoNow());
  let snapshotSignature = createSnapshotSignature(snapshot);
  let started = false;
  let initialScanComplete = false;
  let dashboardOpen = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let subscriptionTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let subscriptionRefreshInFlight: Promise<void> | null = null;
  let authVisibilityRefreshInFlight: Promise<void> | null = null;
  let watchCleanup: (() => void) | null = null;
  let daySamples: ScopedUsageEventSample[] = [];
  const targetUsageScans = new Map<
    string,
    {
      target: WorkspaceTarget;
      principal?: { uid: number; accountName: string };
      truncated: boolean;
      records: ScopedUsageEventSample[];
    }
  >();
  const initializedUsageTargets = new Set<string>();
  let unavailableUsageTargets: UsageUnavailableTargetVm[] = [];
  let dayKey = dayKeyFor(now());
  let historyDays = normalizeHistoryDays(options.historyStore?.load() ?? []);
  let historyBackfillPromise: Promise<void> | null = null;
  let workerHistoryBackfillComplete = false;
  let lastAuthVisibilityRefreshAtMs = Number.NEGATIVE_INFINITY;

  const bindings = new Map<Id, SurfaceBinding>();
  const inputBuffers = new Map<Id, string>();
  const manualCandidates = new Map<Id, ManualCliCandidate>();
  const manualUsageCatchupTimers = new Map<
    Id,
    Set<ReturnType<typeof setTimeout>>
  >();
  const subscriptionUsage = new Map<
    SubscriptionProvider,
    SubscriptionProviderUsageVm
  >();
  const subscriptionPollStates = new Map<
    SubscriptionProvider,
    SubscriptionPollState
  >();
  const lastInteractiveSubscriptionRefreshAtMs = new Map<
    SubscriptionProvider,
    number
  >();
  const daySampleIndexes = new Map<string, number>();
  let authVisibleProviders = new Set<SubscriptionProvider>();
  let lastSubscriptionVisibilitySignature = "";

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    const handleUsageSourceChange = (vendor: UsageVendor): void => {
      const nowMs = now();
      for (const candidate of manualCandidates.values()) {
        if (candidate.vendor === vendor) {
          candidate.nextProbeAtMs = nowMs;
        }
      }
      void refreshNow();
    };
    const registry = options.targetServices?.();
    const targetLocalUsage = registry?.resolveLocated({ kind: "local" }).usage;
    const cleanups = targetLocalUsage?.watch
      ? [targetLocalUsage.watch(handleUsageSourceChange)]
      : scanService
        ? [scanService.watch(handleUsageSourceChange)]
        : adapters.map((adapter) =>
            adapter.watch(() => handleUsageSourceChange(adapter.vendor))
          );
    watchCleanup = () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    scheduleRefresh();
    scheduleSubscriptionRefresh();
    void refreshNow();
    if (!scanService) {
      void backfillHistoryIfNeeded();
    }
  }

  function shutdown(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (subscriptionTimer) {
      clearTimeout(subscriptionTimer);
      subscriptionTimer = null;
    }
    if (watchCleanup) {
      watchCleanup();
      watchCleanup = null;
    }
    clearAllManualUsageCatchups();
    for (const adapter of adapters) {
      adapter.close();
    }
    scanService?.close();
    options
      .targetServices?.()
      ?.resolveLocated({ kind: "local" })
      .usage.close?.();
  }

  function getSnapshot(): UsageViewSnapshot {
    return snapshot;
  }

  function setDashboardOpen(open: boolean): void {
    const wasDashboardOpen = dashboardOpen;
    dashboardOpen = open;
    scheduleRefresh();
    if (!open) {
      scheduleSubscriptionRefresh();
      return;
    }
    void refreshSubscriptionUsageNow({
      forceAuthRefresh: true,
      forceInteractiveRefresh: !wasDashboardOpen
    });
  }

  function scheduleRefresh(): void {
    if (!started) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    const nextDelay = minPositiveDelay([
      getNextManualCliRefreshDelayMs(now()),
      dashboardOpen ? DASHBOARD_REFRESH_MS : BACKGROUND_USAGE_REFRESH_MS
    ]);

    if (nextDelay === null) {
      return;
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshNow();
    }, nextDelay);
  }

  async function refreshNow(): Promise<void> {
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      try {
        await refreshManualCliBindings();
        await refreshAdapters();
        rebuildSnapshot();
      } finally {
        refreshInFlight = null;
        scheduleRefresh();
        if (!subscriptionRefreshInFlight) {
          const visibleProviders = getVisibleSubscriptionProviders();
          const nextVisibilitySignature =
            createSubscriptionVisibilitySignature(visibleProviders);
          if (
            nextVisibilitySignature !== lastSubscriptionVisibilitySignature ||
            (dashboardOpen &&
              visibleProviders.size > 0 &&
              subscriptionTimer === null)
          ) {
            scheduleSubscriptionRefresh();
          }
        }
        if (refreshQueued) {
          refreshQueued = false;
          void refreshNow();
        }
      }
    })();

    return refreshInFlight;
  }

  function getSurfaceVendor(surfaceId: Id): UsageVendor {
    const bindingVendor = bindings.get(surfaceId)?.vendor;
    if (bindingVendor) {
      return bindingVendor;
    }
    return manualCandidates.get(surfaceId)?.vendor ?? "unknown";
  }

  function scheduleSubscriptionRefresh(): void {
    if (subscriptionTimer) {
      clearTimeout(subscriptionTimer);
      subscriptionTimer = null;
    }
    if (!started || !dashboardOpen) {
      lastSubscriptionVisibilitySignature = "";
      return;
    }

    const visibleProviders = getVisibleSubscriptionProviders();
    lastSubscriptionVisibilitySignature =
      createSubscriptionVisibilitySignature(visibleProviders);
    pruneHiddenSubscriptionProviders(visibleProviders);
    if (visibleProviders.size === 0) {
      return;
    }

    const nowMs = now();
    let nextDelayMs: number | null = null;
    for (const [provider, visibility] of visibleProviders.entries()) {
      const currentState = subscriptionPollStates.get(provider);
      if (!currentState || currentState.visibility !== visibility) {
        subscriptionPollStates.set(provider, {
          failureCount: currentState?.failureCount ?? 0,
          nextPollAtMs: nowMs,
          visibility
        });
      }
      const state = subscriptionPollStates.get(provider);
      if (!state) {
        continue;
      }
      if (state.failureCount === 0) {
        const resetDrivenPollAtMs = getResetDrivenPollAtMs(
          subscriptionUsage.get(provider),
          nowMs
        );
        if (
          resetDrivenPollAtMs !== null &&
          resetDrivenPollAtMs < state.nextPollAtMs
        ) {
          state.nextPollAtMs = resetDrivenPollAtMs;
        }
      }
      const delayMs = Math.max(0, state.nextPollAtMs - nowMs);
      if (nextDelayMs === null || delayMs < nextDelayMs) {
        nextDelayMs = delayMs;
      }
    }

    if (nextDelayMs === null) {
      return;
    }

    subscriptionTimer = setTimeout(() => {
      subscriptionTimer = null;
      void refreshSubscriptionUsageNow();
    }, nextDelayMs);
  }

  async function refreshSubscriptionUsageNow(
    options: {
      forceAuthRefresh?: boolean;
      forceInteractiveRefresh?: boolean;
    } = {}
  ): Promise<void> {
    if (!dashboardOpen) {
      return;
    }
    if (subscriptionRefreshInFlight) {
      return subscriptionRefreshInFlight;
    }

    subscriptionRefreshInFlight = (async () => {
      await refreshSubscriptionAuthVisibility({
        force: options.forceAuthRefresh
      });
      const visibleProviders = getVisibleSubscriptionProviders();
      let didChange = pruneHiddenSubscriptionProviders(visibleProviders);
      const nowMs = now();
      const dueProviders = Array.from(visibleProviders.entries()).flatMap(
        ([provider, visibility]) => {
          const state = subscriptionPollStates.get(provider);
          const shouldForceInteractiveRefresh =
            options.forceInteractiveRefresh === true &&
            shouldForceInteractiveSubscriptionRefresh(provider, nowMs);
          if (
            !state ||
            state.nextPollAtMs <= nowMs ||
            state.visibility !== visibility ||
            shouldForceInteractiveRefresh
          ) {
            return [[provider, visibility] as const];
          }
          return [];
        }
      );

      if (dueProviders.length === 0) {
        if (didChange) {
          rebuildSnapshot();
        }
        return;
      }

      await Promise.all(
        dueProviders.map(async ([provider, visibility]) => {
          if (options.forceInteractiveRefresh === true) {
            lastInteractiveSubscriptionRefreshAtMs.set(provider, nowMs);
          }
          const fetcher = subscriptionFetchers[provider];
          if (!fetcher) {
            return;
          }
          const currentState = subscriptionPollStates.get(provider) ?? {
            failureCount: 0,
            nextPollAtMs: nowMs,
            visibility
          };
          try {
            const nextUsage = await fetcher();
            const previousUsage = subscriptionUsage.get(provider);
            if (nextUsage) {
              if (JSON.stringify(previousUsage) !== JSON.stringify(nextUsage)) {
                didChange = true;
              }
              subscriptionUsage.set(provider, nextUsage);
            } else if (previousUsage) {
              didChange = true;
              subscriptionUsage.delete(provider);
            }
            subscriptionPollStates.set(provider, {
              failureCount: 0,
              nextPollAtMs: getNextSubscriptionPollAtMs(
                nowMs,
                visibility,
                nextUsage
              ),
              visibility
            });
          } catch {
            const failureCount = currentState.failureCount + 1;
            subscriptionPollStates.set(provider, {
              failureCount,
              nextPollAtMs:
                nowMs +
                SUBSCRIPTION_FAILURE_BACKOFF_MS[
                  Math.min(
                    SUBSCRIPTION_FAILURE_BACKOFF_MS.length - 1,
                    failureCount - 1
                  )
                ],
              visibility
            });
          }
        })
      );

      if (didChange) {
        rebuildSnapshot();
      }
    })().finally(() => {
      subscriptionRefreshInFlight = null;
      scheduleSubscriptionRefresh();
    });

    return subscriptionRefreshInFlight;
  }

  function getVisibleSubscriptionProviders(): Map<
    SubscriptionProvider,
    SubscriptionVisibility
  > {
    const visibleProviders = new Map<
      SubscriptionProvider,
      SubscriptionVisibility
    >();
    const state = options.getState();

    for (const binding of bindings.values()) {
      if (!isSubscriptionProvider(binding.vendor)) {
        continue;
      }
      if (
        options.getState().workspaces[binding.workspaceId]?.location.target
          .kind !== "local"
      ) {
        continue;
      }
      const surface = state.surfaces[binding.surfaceId];
      const session = surface
        ? terminalSessionForSurface(state, surface.id)
        : undefined;
      if (!surface || session?.runtimeStatus.processState === "exited") {
        continue;
      }
      visibleProviders.set(binding.vendor, "live");
    }

    for (const sample of daySamples) {
      if (
        sample.usageTarget.kind !== "local" ||
        sample.vendor === "unknown" ||
        !isSubscriptionProvider(sample.vendor)
      ) {
        continue;
      }
      if (visibleProviders.has(sample.vendor)) {
        continue;
      }
      visibleProviders.set(sample.vendor, "recent");
    }

    for (const provider of SUBSCRIPTION_PROVIDER_ORDER) {
      if (visibleProviders.has(provider)) {
        continue;
      }
      if (authVisibleProviders.has(provider)) {
        visibleProviders.set(provider, "recent");
      }
    }

    return visibleProviders;
  }

  function pruneHiddenSubscriptionProviders(
    visibleProviders: Map<SubscriptionProvider, SubscriptionVisibility>
  ): boolean {
    let didChange = false;
    for (const provider of subscriptionUsage.keys()) {
      if (!visibleProviders.has(provider)) {
        subscriptionUsage.delete(provider);
        didChange = true;
      }
    }
    for (const provider of subscriptionPollStates.keys()) {
      if (!visibleProviders.has(provider)) {
        subscriptionPollStates.delete(provider);
      }
    }
    for (const provider of lastInteractiveSubscriptionRefreshAtMs.keys()) {
      if (!visibleProviders.has(provider)) {
        lastInteractiveSubscriptionRefreshAtMs.delete(provider);
      }
    }
    return didChange;
  }

  function shouldForceInteractiveSubscriptionRefresh(
    provider: SubscriptionProvider,
    nowMs: number
  ): boolean {
    const lastRefreshAtMs =
      lastInteractiveSubscriptionRefreshAtMs.get(provider);
    return (
      typeof lastRefreshAtMs !== "number" ||
      nowMs - lastRefreshAtMs >= SUBSCRIPTION_INTERACTIVE_REFRESH_COOLDOWN_MS
    );
  }

  async function refreshSubscriptionAuthVisibility(
    options: {
      force?: boolean;
    } = {}
  ): Promise<void> {
    const nowMs = now();
    if (
      !options.force &&
      nowMs - lastAuthVisibilityRefreshAtMs < AUTH_VISIBILITY_REFRESH_MS
    ) {
      return;
    }
    if (authVisibilityRefreshInFlight) {
      return authVisibilityRefreshInFlight;
    }

    authVisibilityRefreshInFlight = (async () => {
      const nextVisibleProviders = new Set<SubscriptionProvider>();

      await Promise.all(
        SUBSCRIPTION_PROVIDER_ORDER.map(async (provider) => {
          const detector = subscriptionAuthDetectors[provider];
          if (!detector) {
            return;
          }
          try {
            if (await detector()) {
              nextVisibleProviders.add(provider);
            }
          } catch {
            // Treat detector failures as auth unavailable.
          }
        })
      );

      authVisibleProviders = nextVisibleProviders;
      lastAuthVisibilityRefreshAtMs = now();
    })().finally(() => {
      authVisibilityRefreshInFlight = null;
    });

    return authVisibilityRefreshInFlight;
  }

  async function refreshAdapters(): Promise<void> {
    const nextDayKey = dayKeyFor(now());
    if (dayKey !== nextDayKey) {
      dayKey = nextDayKey;
      daySamples = [];
      daySampleIndexes.clear();
      initialScanComplete = false;
      targetUsageScans.clear();
      initializedUsageTargets.clear();
    }

    if (options.targetServices !== undefined) {
      await refreshTargetUsageProviders();
      return;
    }

    const startOfDayMs = startOfLocalDay(now());
    let reads: UsageAdapterReadResult[];
    if (scanService) {
      const historyRange = workerHistoryBackfillComplete
        ? undefined
        : resolveHistoryBackfillRange();
      try {
        const result = await scanService.scan({
          startOfDayMs,
          initial: !initialScanComplete,
          ...(historyRange ? { historyRange } : {})
        });
        reads = result.reads;
        if (result.historyDays) {
          historyDays = normalizeHistoryDays(result.historyDays);
          options.historyStore?.save(historyDays);
        }
        workerHistoryBackfillComplete = true;
      } catch (error) {
        const hasWorkerDiagnostic =
          error instanceof Error &&
          ("workerStack" in error || "workerContext" in error);
        const workerDiagnostic =
          process.env.NODE_ENV === "development" && hasWorkerDiagnostic
            ? {
                message: error.message,
                stack:
                  "workerStack" in error
                    ? String(error.workerStack)
                    : error.stack,
                context:
                  "workerContext" in error
                    ? String(error.workerContext)
                    : undefined
              }
            : error instanceof Error
              ? error.message
              : String(error);
        console.warn(
          "[usage] scan worker failed; keeping the last usage snapshot:",
          workerDiagnostic
        );
        return;
      }
    } else {
      reads = await Promise.all(
        adapters.map((adapter) =>
          initialScanComplete
            ? adapter.readIncremental(startOfDayMs)
            : adapter.initialScan(startOfDayMs)
        )
      );
    }
    initialScanComplete = true;

    for (const read of reads) {
      if (read.samples.length === 0) {
        continue;
      }
      for (const sample of read.samples) {
        upsertDaySample({ ...sample, usageTarget: { kind: "local" } });
      }
    }
  }

  async function refreshTargetUsageProviders(): Promise<void> {
    const registry = options.targetServices?.();
    if (!registry) {
      return;
    }
    const targets = currentUsageTargets(options.getState());
    const failures: UsageUnavailableTargetVm[] = [];
    const historyRange = workerHistoryBackfillComplete
      ? undefined
      : resolveHistoryBackfillRange();
    await Promise.all(
      targets.map(async (target) => {
        const key = usageTargetKey(target);
        try {
          const provider = registry.resolveLocated(target).usage;
          const scan = await provider.refresh({
            startAtUnixMs: startOfLocalDay(now()),
            initial: !initializedUsageTargets.has(key),
            maxRecords: target.kind === "local" ? 4_096 : 64,
            ...(target.kind === "local" && historyRange ? { historyRange } : {})
          });
          const incoming = scan.records.map((record) =>
            scopedUsageSample(target, scan.principal, record)
          );
          const previous = targetUsageScans.get(key)?.records ?? [];
          targetUsageScans.set(key, {
            target: { ...target },
            ...(scan.principal === undefined
              ? {}
              : { principal: { ...scan.principal } }),
            truncated: scan.truncated,
            records:
              target.kind === "ssh"
                ? incoming
                : mergeScopedUsageSamples(previous, incoming)
          });
          initializedUsageTargets.add(key);
          if (target.kind === "local" && scan.historyDays) {
            historyDays = normalizeHistoryDays(scan.historyDays);
            options.historyStore?.save(historyDays);
            workerHistoryBackfillComplete = true;
          }
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          options.reportTargetUsageError?.(target, failure);
          failures.push(
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
    const currentKeys = new Set(
      currentUsageTargets(options.getState()).map(usageTargetKey)
    );
    for (const key of targetUsageScans.keys()) {
      if (!currentKeys.has(key)) targetUsageScans.delete(key);
    }
    for (const key of initializedUsageTargets) {
      if (!currentKeys.has(key)) initializedUsageTargets.delete(key);
    }
    unavailableUsageTargets = failures
      .filter((target) => currentKeys.has(usageUnavailableTargetKey(target)))
      .sort((left, right) =>
        usageUnavailableTargetKey(left).localeCompare(
          usageUnavailableTargetKey(right)
        )
      );
    daySamples = [];
    daySampleIndexes.clear();
    for (const scan of targetUsageScans.values()) {
      for (const sample of scan.records) upsertDaySample(sample);
    }
    initialScanComplete = initializedUsageTargets.has("local");
  }

  function upsertDaySample(sample: ScopedUsageEventSample): void {
    const identity = `${usageTargetKey(sample.usageTarget)}\0${usageSampleIdentity(sample)}`;
    const existingIndex = daySampleIndexes.get(identity);
    if (existingIndex !== undefined) {
      const existingSample = daySamples[existingIndex];
      if (shouldReplaceUsageSample(existingSample, sample)) {
        daySamples[existingIndex] = sample;
      }
      return;
    }
    daySampleIndexes.set(identity, daySamples.length);
    daySamples.push(sample);
  }

  async function backfillHistoryIfNeeded(): Promise<void> {
    if (!options.historyStore || historyBackfillPromise) {
      return historyBackfillPromise ?? Promise.resolve();
    }

    const expectedDayKeys = buildRollingDayKeys(now(), USAGE_HISTORY_DAY_COUNT);
    const shouldBackfill = expectedDayKeys.some(
      (expectedDayKey) =>
        !historyDays.some((day) => day.dayKey === expectedDayKey)
    );
    if (!shouldBackfill) {
      return Promise.resolve();
    }

    historyBackfillPromise = (async () => {
      const rangeStartMs = startOfRollingDayRange(
        now(),
        USAGE_HISTORY_DAY_COUNT
      );
      const backfilledDays = await scanUsageHistoryDays({
        env: options.env,
        homeDir: options.homeDir,
        agentStorageRoots: options.agentStorageRoots,
        platform: options.platform,
        fromMs: rangeStartMs,
        toMs: endOfLocalDay(now())
      });
      historyDays = normalizeHistoryDays(backfilledDays);
      options.historyStore?.save(historyDays);
      rebuildSnapshot();
    })()
      .catch((error) => {
        console.warn(
          "[usage] history backfill failed:",
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        historyBackfillPromise = null;
      });

    return historyBackfillPromise;
  }

  function resolveHistoryBackfillRange():
    | { fromMs: number; toMs: number }
    | undefined {
    if (!options.historyStore) {
      return undefined;
    }
    const expectedDayKeys = buildRollingDayKeys(now(), USAGE_HISTORY_DAY_COUNT);
    const shouldBackfill = expectedDayKeys.some(
      (expectedDayKey) =>
        !historyDays.some((day) => day.dayKey === expectedDayKey)
    );
    if (!shouldBackfill) {
      return undefined;
    }
    return {
      fromMs: startOfRollingDayRange(now(), USAGE_HISTORY_DAY_COUNT),
      toMs: endOfLocalDay(now())
    };
  }

  async function refreshManualCliBindings(): Promise<void> {
    pruneBindings();

    const state = options.getState();
    const nowMs = now();
    const probes: AiCliProcessProbe[] = [];
    const surfaceProbeMeta = new Map<
      Id,
      {
        parentPid: number;
        vendor: Exclude<UsageVendor, "unknown">;
        boundAtMs: number;
      }
    >();

    for (const [surfaceId, candidate] of manualCandidates.entries()) {
      if (nowMs > candidate.expiresAtMs && !hasManualBinding(surfaceId)) {
        manualCandidates.delete(surfaceId);
      }
    }

    for (const surface of Object.values(state.surfaces)) {
      const existingBinding = bindings.get(surface.id);
      if (existingBinding?.source === "agent") {
        continue;
      }

      const candidate = manualCandidates.get(surface.id);
      if (!candidate && existingBinding?.source !== "manual_cli") {
        continue;
      }

      const session = terminalSessionForSurface(state, surface.id);
      if (existingBinding?.source === "manual_cli") {
        if (
          !existingBinding.vendorProcessId ||
          !isProcessAlive(existingBinding.vendorProcessId)
        ) {
          bindings.delete(surface.id);
        }
        continue;
      }

      const vendor = candidate?.vendor;
      const boundAtMs = existingBinding?.boundAtMs ?? candidate?.submittedAtMs;
      if (!session?.pid || !vendor || !boundAtMs) {
        continue;
      }
      if (candidate && nowMs < candidate.nextProbeAtMs) {
        continue;
      }

      probes.push({
        parentPid: session.pid,
        vendor
      });
      surfaceProbeMeta.set(surface.id, {
        parentPid: session.pid,
        vendor,
        boundAtMs
      });
    }

    if (probes.length === 0) {
      return;
    }

    let matchesByPid: Map<number, AiCliProcessMatch>;
    try {
      matchesByPid = await resolveAiCliProcesses(probes);
    } catch (error) {
      console.warn(
        "[usage] manual CLI process scan failed:",
        error instanceof Error ? error.message : String(error)
      );
      for (const surfaceId of surfaceProbeMeta.keys()) {
        const candidate = manualCandidates.get(surfaceId);
        if (candidate) {
          candidate.nextProbeAtMs = nowMs + ACTIVE_REFRESH_MS;
        }
      }
      return;
    }

    for (const [surfaceId, probeMeta] of surfaceProbeMeta.entries()) {
      const surface = state.surfaces[surfaceId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const match = matchesByPid.get(probeMeta.parentPid);
      const existingBinding = bindings.get(surfaceId);

      if (!surface || !pane) {
        continue;
      }
      const session = terminalSessionForSurface(state, surfaceId);
      const metadata = terminalRuntimeMetadataForSurface(state, surfaceId);
      if (!session || !metadata) {
        continue;
      }

      if (match && match.vendor === probeMeta.vendor) {
        bindings.set(surfaceId, {
          surfaceId,
          workspaceId: pane.workspaceId,
          vendor: match.vendor,
          source: "manual_cli",
          kmuxSessionId: session.id,
          vendorProcessId: match.pid,
          cwd: metadata.cwd,
          boundAtMs: existingBinding?.boundAtMs ?? probeMeta.boundAtMs,
          lastAgentEventAtMs: nowMs
        });
        manualCandidates.delete(surfaceId);
        refreshQueued = true;
        continue;
      }

      const candidate = manualCandidates.get(surfaceId);
      if (candidate) {
        candidate.nextProbeAtMs = nowMs + ACTIVE_REFRESH_MS;
      }
    }
  }

  function handleAppAction(action: AppAction): void {
    if (action.type === "agent.event") {
      handleAgentEvent(action);
      return;
    }

    if (action.type === "session.exited") {
      const binding = findBindingByKmuxSessionId(action.sessionId);
      if (binding?.source === "manual_cli") {
        bindings.delete(binding.surfaceId);
      }
      const surfaceId =
        options.getState().sessions[action.sessionId]?.surfaceId;
      if (surfaceId) {
        clearSurfaceInputState(surfaceId);
      }
      rebuildSnapshot();
      return;
    }

    if (
      action.type === "surface.close" ||
      action.type === "workspace.close" ||
      action.type === "pane.close" ||
      action.type === "surface.closeOthers" ||
      action.type === "state.restore"
    ) {
      pruneBindings();
      rebuildSnapshot();
      return;
    }

    if (action.type === "surface.metadata") {
      if (action.cwd !== undefined) {
        updateBindingSurfaceCwd(action.surfaceId);
        rebuildSnapshot();
      }
      return;
    }

    if (
      action.type === "surface.rename" ||
      action.type === "workspace.rename"
    ) {
      rebuildSnapshot();
    }
  }

  function handleTerminalInput(surfaceId: Id, text: string): void {
    if (!text || !options.getState().surfaces[surfaceId]) {
      return;
    }

    const currentBuffer = inputBuffers.get(surfaceId) ?? "";
    const nextInputState = applyTerminalInput(currentBuffer, text);
    if (nextInputState.nextBuffer) {
      inputBuffers.set(surfaceId, nextInputState.nextBuffer);
    } else {
      inputBuffers.delete(surfaceId);
    }

    if (nextInputState.interrupted && !bindings.get(surfaceId)) {
      manualCandidates.delete(surfaceId);
    }

    for (const submittedLine of nextInputState.submittedLines) {
      const detectedVendor = detectAiCliVendorFromCommand(submittedLine);
      if (!detectedVendor) {
        if (!bindings.get(surfaceId)) {
          manualCandidates.delete(surfaceId);
        }
        continue;
      }
      manualCandidates.set(surfaceId, {
        surfaceId,
        vendor: detectedVendor,
        submittedAtMs: now(),
        expiresAtMs: now() + MANUAL_CLI_CANDIDATE_TTL_MS,
        nextProbeAtMs: now()
      });
      markVendorAdaptersDirty(detectedVendor, DISCOVER_ONLY_DIRTY_OPTIONS);
      scheduleManualUsageCatchup(surfaceId, detectedVendor);
      void refreshNow();
    }
  }

  function handleAgentEvent(
    action: Extract<AppAction, { type: "agent.event" }>
  ): void {
    if (action.details?.uiOnly === true) {
      return;
    }
    const vendor = normalizeVendor(action.agent);
    if (vendor === "unknown") {
      return;
    }
    const state = options.getState();
    const surfaceId = resolveSurfaceId(state, action);
    if (!surfaceId) {
      return;
    }

    const surface = state.surfaces[surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    if (!surface || !pane) {
      return;
    }
    const session = terminalSessionForSurface(state, surfaceId);
    const metadata = terminalRuntimeMetadataForSurface(state, surfaceId);
    if (!session || !metadata) {
      return;
    }

    const existing = bindings.get(surfaceId);
    if (action.event !== "session_start" && action.event !== "needs_input") {
      if (existing?.vendor === vendor) {
        existing.workspaceId = pane.workspaceId;
        existing.kmuxSessionId = session.id;
        existing.cwd = metadata.cwd;
        existing.lastAgentEventAtMs = now();
      }
      return;
    }

    const kmuxSessionId = session.id;
    const vendorSessionId =
      action.sessionId && action.sessionId !== kmuxSessionId
        ? action.sessionId
        : existing?.vendorSessionId;
    bindings.set(surfaceId, {
      surfaceId,
      workspaceId: pane.workspaceId,
      vendor,
      source: "agent",
      kmuxSessionId,
      vendorSessionId,
      cwd: metadata.cwd,
      boundAtMs: existing?.boundAtMs ?? now(),
      lastAgentEventAtMs: now()
    });
    manualCandidates.delete(surfaceId);
    pruneBindings();
    rebuildSnapshot();
  }

  function pruneBindings(): void {
    const state = options.getState();
    for (const surfaceId of inputBuffers.keys()) {
      if (!state.surfaces[surfaceId]) {
        inputBuffers.delete(surfaceId);
      }
    }
    for (const surfaceId of manualCandidates.keys()) {
      if (!state.surfaces[surfaceId]) {
        manualCandidates.delete(surfaceId);
      }
    }
    for (const [surfaceId, binding] of bindings.entries()) {
      const surface = state.surfaces[surfaceId];
      if (!surface) {
        bindings.delete(surfaceId);
        continue;
      }
      const pane = state.panes[surface.paneId];
      if (!pane) {
        bindings.delete(surfaceId);
        continue;
      }
      const session = terminalSessionForSurface(state, surfaceId);
      const metadata = terminalRuntimeMetadataForSurface(state, surfaceId);
      if (!session || session.runtimeStatus.processState === "exited") {
        if (binding.source === "manual_cli") {
          bindings.delete(surfaceId);
        }
        continue;
      }
      binding.workspaceId = pane.workspaceId;
      binding.kmuxSessionId = session.id;
      binding.cwd = metadata?.cwd;
    }
  }

  function rebuildSnapshot(): void {
    pruneBindings();

    const state = options.getState();
    const derivedSurfaces = new Map<Id, DerivedSurface>();
    const workspaceTotals = new Map<Id, DerivedWorkspace>();
    const directoryTotals = new Map<string, DerivedDirectory>();
    const vendorTotals = new Map<
      Exclude<UsageVendor, "unknown">,
      DerivedVendor
    >();
    const modelTotals = new Map<string, DerivedModel>();
    const targetTotals = new Map<string, DerivedTarget>();
    const unboundSurfacePathIndex = buildUnboundSurfacePathIndex(
      state,
      bindings
    );
    let totalTodayCostUsd = 0;
    let totalTodayTokens = 0;
    let unattributedTodayCostUsd = 0;
    let unattributedTodayTokens = 0;
    const todayTokenBreakdown: UsageTokenBreakdownVm = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0
    };
    const todayTokenCostBreakdown: UsageTokenCostBreakdownVm = {
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      thinkingCostUsd: 0,
      hasUnknownInputCost: false,
      hasUnknownOutputCost: false,
      hasUnknownCacheReadCost: false,
      hasUnknownCacheWriteCost: false,
      hasUnknownThinkingCost: false
    };
    const pricingCoverage = {
      fullyPriced: true,
      hasEstimatedCosts: false,
      hasMissingPricing: false,
      reportedCostUsd: 0,
      estimatedCostUsd: 0,
      unknownCostTokens: 0
    };

    for (const binding of bindings.values()) {
      const surface = state.surfaces[binding.surfaceId];
      const workspace = state.workspaces[binding.workspaceId];
      if (!surface || !workspace) {
        continue;
      }
      derivedSurfaces.set(binding.surfaceId, {
        surfaceId: binding.surfaceId,
        workspaceId: binding.workspaceId,
        vendor: binding.vendor,
        sessionCostUsd: 0,
        sessionTokens: 0,
        todayCostUsd: 0,
        todayTokens: 0,
        updatedAtMs: binding.lastAgentEventAtMs,
        attributionState: "bound",
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0
      });
    }

    for (const sample of daySamples) {
      if (sample.vendor === "unknown") {
        continue;
      }

      const sampleCostSource = normalizeUsageSampleCostSource(sample);
      const sampleCostUsd = costedUsageSampleUsd(sample, sampleCostSource);
      const cacheReadTokens = sample.cacheReadTokens ?? sample.cacheTokens;
      const cacheWriteTokens = sample.cacheWriteTokens ?? 0;
      totalTodayCostUsd += sampleCostUsd;
      totalTodayTokens += sample.totalTokens;
      todayTokenBreakdown.inputTokens += sample.inputTokens;
      todayTokenBreakdown.outputTokens += sample.outputTokens;
      todayTokenBreakdown.cacheReadTokens += cacheReadTokens;
      todayTokenBreakdown.cacheWriteTokens += cacheWriteTokens;
      todayTokenBreakdown.thinkingTokens += sample.thinkingTokens ?? 0;
      todayTokenBreakdown.totalTokens += sample.totalTokens;
      applyTokenCostBreakdown(todayTokenCostBreakdown, sample);
      applyPricingCoverage(pricingCoverage, sample, sampleCostSource);

      const vendorTotal = vendorTotals.get(sample.vendor) ?? {
        vendor: sample.vendor,
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0
      };
      vendorTotal.todayCostUsd += sampleCostUsd;
      vendorTotal.todayTokens += sample.totalTokens;
      applyCostBreakdown(vendorTotal, sample, sampleCostSource);
      vendorTotals.set(sample.vendor, vendorTotal);

      const sampleTargetKey = usageTargetKey(sample.usageTarget);
      const targetTotal = targetTotals.get(sampleTargetKey) ?? {
        target: usageTargetIdentity(sample.usageTarget, sample.principal),
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0,
        truncated: targetUsageScans.get(sampleTargetKey)?.truncated ?? false
      };
      targetTotal.todayCostUsd += sampleCostUsd;
      targetTotal.todayTokens += sample.totalTokens;
      applyCostBreakdown(targetTotal, sample, sampleCostSource);
      targetTotals.set(sampleTargetKey, targetTotal);

      const modelIdentity = resolveModelUsageIdentity(sample);
      if (modelIdentity) {
        const modelKey = `${sample.vendor}:${modelIdentity.modelId}`;
        const modelTotal = modelTotals.get(modelKey) ?? {
          vendor: sample.vendor,
          modelId: modelIdentity.modelId,
          modelLabel: modelIdentity.modelLabel,
          todayCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalTokens: 0,
          costSource: "reported",
          reportedCostUsd: 0,
          estimatedCostUsd: 0,
          unknownCostTokens: 0
        };
        modelTotal.todayCostUsd += sampleCostUsd;
        modelTotal.inputTokens += sample.inputTokens;
        modelTotal.outputTokens += sample.outputTokens;
        modelTotal.cacheTokens += sample.cacheTokens;
        modelTotal.totalTokens += sample.totalTokens;
        applyCostBreakdown(modelTotal, sample, sampleCostSource);
        modelTotals.set(modelKey, modelTotal);
      }

      const sampleMatch = matchSampleToSurface(
        sample,
        state,
        bindings,
        unboundSurfacePathIndex
      );
      const matchedBinding = sampleMatch
        ? bindings.get(sampleMatch.surfaceId)
        : undefined;
      const fallbackSurfaceCwd = sampleMatch
        ? terminalRuntimeMetadataForSurface(state, sampleMatch.surfaceId)?.cwd
        : undefined;
      const directoryPath = resolveDirectoryHotspotPath(
        sample,
        rawUsagePath(
          sample.usageTarget,
          matchedBinding?.cwd ?? fallbackSurfaceCwd
        )
      );
      if (directoryPath) {
        const directoryKey = `${sampleTargetKey}\0${directoryPath}`;
        const directoryTotal = directoryTotals.get(directoryKey) ?? {
          target: usageTargetIdentity(sample.usageTarget, sample.principal),
          directoryPath,
          todayCostUsd: 0,
          todayTokens: 0,
          costSource: "reported",
          reportedCostUsd: 0,
          estimatedCostUsd: 0,
          unknownCostTokens: 0
        };
        directoryTotal.todayCostUsd += sampleCostUsd;
        directoryTotal.todayTokens += sample.totalTokens;
        applyCostBreakdown(directoryTotal, sample, sampleCostSource);
        directoryTotals.set(directoryKey, directoryTotal);
      }
      if (!sampleMatch) {
        unattributedTodayCostUsd += sampleCostUsd;
        unattributedTodayTokens += sample.totalTokens;
        continue;
      }

      let surfaceAggregate: DerivedSurface | null | undefined =
        derivedSurfaces.get(sampleMatch.surfaceId);
      const binding = bindings.get(sampleMatch.surfaceId);
      if (!surfaceAggregate) {
        surfaceAggregate = createDerivedSurfaceForMatch(
          state,
          sampleMatch.surfaceId,
          sample.vendor,
          sampleMatch.attributionState,
          sample.timestampMs
        );
        if (surfaceAggregate) {
          derivedSurfaces.set(sampleMatch.surfaceId, surfaceAggregate);
        }
      }

      if (!surfaceAggregate) {
        unattributedTodayCostUsd += sampleCostUsd;
        unattributedTodayTokens += sample.totalTokens;
        continue;
      }

      if (surfaceAggregate.vendor !== sample.vendor) {
        unattributedTodayCostUsd += sampleCostUsd;
        unattributedTodayTokens += sample.totalTokens;
        continue;
      }

      surfaceAggregate.todayCostUsd += sampleCostUsd;
      surfaceAggregate.todayTokens += sample.totalTokens;
      surfaceAggregate.updatedAtMs = Math.max(
        surfaceAggregate.updatedAtMs,
        sample.timestampMs
      );
      applyCostBreakdown(surfaceAggregate, sample, sampleCostSource);
      if (sample.model) {
        surfaceAggregate.model = sample.model;
      }
      if (
        surfaceAggregate.attributionState === "bound" &&
        binding &&
        (sampleMatch.attribution === "session" ||
          sample.timestampMs >=
            binding.boundAtMs -
              (binding.source === "manual_cli" ? MANUAL_CLI_BIND_GRACE_MS : 0))
      ) {
        surfaceAggregate.sessionCostUsd += sampleCostUsd;
        surfaceAggregate.sessionTokens += sample.totalTokens;
      }

      const workspaceId = binding?.workspaceId ?? surfaceAggregate.workspaceId;
      const workspaceTotal = workspaceTotals.get(workspaceId) ?? {
        workspaceId,
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0
      };
      workspaceTotal.todayCostUsd += sampleCostUsd;
      workspaceTotal.todayTokens += sample.totalTokens;
      applyCostBreakdown(workspaceTotal, sample, sampleCostSource);
      workspaceTotals.set(workspaceId, workspaceTotal);
    }

    for (const binding of bindings.values()) {
      const workspaceTotal = workspaceTotals.get(binding.workspaceId) ?? {
        workspaceId: binding.workspaceId,
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0
      };
      workspaceTotals.set(binding.workspaceId, workspaceTotal);

      const vendorTotal = vendorTotals.get(binding.vendor) ?? {
        vendor: binding.vendor,
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0
      };
      vendorTotals.set(binding.vendor, vendorTotal);
    }

    for (const [key, scan] of targetUsageScans) {
      if (targetTotals.has(key)) continue;
      targetTotals.set(key, {
        target: usageTargetIdentity(scan.target, scan.principal),
        todayCostUsd: 0,
        todayTokens: 0,
        costSource: "reported",
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0,
        truncated: scan.truncated
      });
    }

    for (const surface of derivedSurfaces.values()) {
      surface.costSource = resolveCostSource(surface);
    }
    for (const workspace of workspaceTotals.values()) {
      workspace.costSource = resolveCostSource(workspace);
    }
    for (const directory of directoryTotals.values()) {
      directory.costSource = resolveCostSource(directory);
    }
    for (const vendor of vendorTotals.values()) {
      vendor.costSource = resolveCostSource(vendor);
    }
    for (const target of targetTotals.values()) {
      target.costSource = resolveCostSource(target);
    }

    const todayHistory = buildTodayHistoryRecord(
      dayKey,
      totalTodayCostUsd,
      totalTodayTokens,
      vendorTotals,
      pricingCoverage
    );
    persistUsageHistory(todayHistory);
    const dailyActivity = buildDailyActivity(todayHistory);
    const models = Array.from(modelTotals.values())
      .map<ModelUsageVm>((model) => ({
        vendor: model.vendor,
        modelId: model.modelId,
        modelLabel: model.modelLabel,
        todayCostUsd: roundUsd(model.todayCostUsd),
        inputTokens: Math.round(model.inputTokens),
        outputTokens: Math.round(model.outputTokens),
        cacheTokens: Math.round(model.cacheTokens),
        totalTokens: Math.round(model.totalTokens),
        costSource: resolveCostSource(model)
      }))
      .sort(
        (left, right) =>
          right.todayCostUsd - left.todayCostUsd ||
          right.totalTokens - left.totalTokens
      )
      .slice(0, 8);

    const nextSnapshot: UsageViewSnapshot = {
      dayKey,
      updatedAt: isoNow(),
      totalTodayCostUsd: roundUsd(totalTodayCostUsd),
      totalTodayTokens: Math.round(totalTodayTokens),
      unattributedTodayCostUsd: roundUsd(unattributedTodayCostUsd),
      unattributedTodayTokens: Math.round(unattributedTodayTokens),
      surfaces: Object.fromEntries(
        Array.from(derivedSurfaces.values())
          .map((surface) => {
            const currentSurface = state.surfaces[surface.surfaceId];
            const currentWorkspace = state.workspaces[surface.workspaceId];
            if (!currentSurface || !currentWorkspace) {
              return null;
            }
            return [
              surface.surfaceId,
              {
                target: usageTargetIdentity(
                  currentWorkspace.location.target,
                  targetUsageScans.get(
                    usageTargetKey(currentWorkspace.location.target)
                  )?.principal
                ),
                surfaceId: surface.surfaceId,
                workspaceId: surface.workspaceId,
                surfaceTitle: currentSurface.title,
                workspaceName: currentWorkspace.name,
                vendor: surface.vendor,
                model: surface.model,
                sessionCostUsd: roundUsd(surface.sessionCostUsd),
                sessionTokens: Math.round(surface.sessionTokens),
                todayCostUsd: roundUsd(surface.todayCostUsd),
                todayTokens: Math.round(surface.todayTokens),
                attributionState: surface.attributionState,
                costSource: surface.costSource,
                updatedAt: new Date(surface.updatedAtMs || now()).toISOString()
              }
            ];
          })
          .filter(Boolean) as Array<[Id, UsageViewSnapshot["surfaces"][Id]]>
      ),
      workspaces: Array.from(workspaceTotals.values())
        .flatMap((workspaceTotal) => {
          const workspace = state.workspaces[workspaceTotal.workspaceId];
          if (!workspace) {
            return [];
          }
          return [
            {
              target: usageTargetIdentity(
                workspace.location.target,
                targetUsageScans.get(usageTargetKey(workspace.location.target))
                  ?.principal
              ),
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              todayCostUsd: roundUsd(workspaceTotal.todayCostUsd),
              todayTokens: Math.round(workspaceTotal.todayTokens),
              costSource: workspaceTotal.costSource
            }
          ];
        })
        .sort((left, right) => right.todayCostUsd - left.todayCostUsd),
      directoryHotspots: buildDirectoryHotspots(
        Array.from(directoryTotals.values())
      ),
      targets: Array.from(targetTotals.values())
        .map((target) => ({
          target: target.target,
          todayCostUsd: roundUsd(target.todayCostUsd),
          todayTokens: Math.round(target.todayTokens),
          costSource: target.costSource,
          truncated: target.truncated
        }))
        .sort(
          (left, right) =>
            right.todayCostUsd - left.todayCostUsd ||
            right.todayTokens - left.todayTokens ||
            usageTargetIdentityKey(left.target).localeCompare(
              usageTargetIdentityKey(right.target)
            )
        ),
      unavailableTargets: unavailableUsageTargets.map((target) => ({
        ...target
      })),
      vendors: Array.from(vendorTotals.values())
        .filter(
          (vendorTotal) =>
            vendorTotal.todayCostUsd > 0 || vendorTotal.todayTokens > 0
        )
        .map((vendorTotal) => ({
          vendor: vendorTotal.vendor,
          todayCostUsd: roundUsd(vendorTotal.todayCostUsd),
          todayTokens: Math.round(vendorTotal.todayTokens),
          costSource: vendorTotal.costSource
        }))
        .sort((left, right) => right.todayCostUsd - left.todayCostUsd),
      topSessions: Array.from(derivedSurfaces.values())
        .sort((left, right) => right.todayCostUsd - left.todayCostUsd)
        .slice(0, 8)
        .map((surface) => {
          const currentSurface = state.surfaces[surface.surfaceId];
          const currentWorkspace = state.workspaces[surface.workspaceId];
          return {
            target: usageTargetIdentity(
              currentWorkspace?.location.target ?? { kind: "local" },
              currentWorkspace
                ? targetUsageScans.get(
                    usageTargetKey(currentWorkspace.location.target)
                  )?.principal
                : undefined
            ),
            surfaceId: surface.surfaceId,
            workspaceId: surface.workspaceId,
            surfaceTitle: currentSurface?.title ?? surface.surfaceId,
            workspaceName: currentWorkspace?.name ?? surface.workspaceId,
            vendor: surface.vendor,
            model: surface.model,
            sessionCostUsd: roundUsd(surface.sessionCostUsd),
            sessionTokens: Math.round(surface.sessionTokens),
            todayCostUsd: roundUsd(surface.todayCostUsd),
            todayTokens: Math.round(surface.todayTokens),
            attributionState: surface.attributionState,
            costSource: surface.costSource,
            updatedAt: new Date(surface.updatedAtMs || now()).toISOString()
          };
        }),
      models,
      todayTokenBreakdown: {
        inputTokens: Math.round(todayTokenBreakdown.inputTokens),
        outputTokens: Math.round(todayTokenBreakdown.outputTokens),
        cacheReadTokens: Math.round(todayTokenBreakdown.cacheReadTokens),
        cacheWriteTokens: Math.round(todayTokenBreakdown.cacheWriteTokens),
        thinkingTokens: Math.round(todayTokenBreakdown.thinkingTokens),
        totalTokens: Math.round(todayTokenBreakdown.totalTokens)
      },
      todayTokenCostBreakdown: {
        inputCostUsd: roundUsd(todayTokenCostBreakdown.inputCostUsd),
        outputCostUsd: roundUsd(todayTokenCostBreakdown.outputCostUsd),
        cacheReadCostUsd: roundUsd(todayTokenCostBreakdown.cacheReadCostUsd),
        cacheWriteCostUsd: roundUsd(todayTokenCostBreakdown.cacheWriteCostUsd),
        thinkingCostUsd: roundUsd(todayTokenCostBreakdown.thinkingCostUsd),
        hasUnknownInputCost: todayTokenCostBreakdown.hasUnknownInputCost,
        hasUnknownOutputCost: todayTokenCostBreakdown.hasUnknownOutputCost,
        hasUnknownCacheReadCost:
          todayTokenCostBreakdown.hasUnknownCacheReadCost,
        hasUnknownCacheWriteCost:
          todayTokenCostBreakdown.hasUnknownCacheWriteCost,
        hasUnknownThinkingCost: todayTokenCostBreakdown.hasUnknownThinkingCost
      },
      dailyActivity,
      pricingCoverage: {
        fullyPriced: pricingCoverage.unknownCostTokens === 0,
        hasEstimatedCosts: pricingCoverage.estimatedCostUsd > 0,
        hasMissingPricing: pricingCoverage.unknownCostTokens > 0,
        reportedCostUsd: roundUsd(pricingCoverage.reportedCostUsd),
        estimatedCostUsd: roundUsd(pricingCoverage.estimatedCostUsd),
        unknownCostTokens: Math.round(pricingCoverage.unknownCostTokens)
      },
      subscriptionUsage: buildSubscriptionUsageSnapshot()
    };

    const nextSignature = createSnapshotSignature(nextSnapshot);
    if (nextSignature === snapshotSignature) {
      snapshot = nextSnapshot;
      return;
    }

    snapshot = nextSnapshot;
    snapshotSignature = nextSignature;
    emitSnapshot(snapshot);
  }

  function persistUsageHistory(todayHistory: UsageHistoryDayRecord): void {
    if (!options.historyStore) {
      return;
    }
    const nextHistory = normalizeHistoryDays(
      historyDays
        .filter((entry) => entry.dayKey !== todayHistory.dayKey)
        .concat(todayHistory)
    );
    if (JSON.stringify(nextHistory) === JSON.stringify(historyDays)) {
      return;
    }
    historyDays = nextHistory;
    options.historyStore.save(historyDays);
  }

  function buildDailyActivity(
    todayHistory: UsageHistoryDayRecord
  ): UsageDailyActivityVm[] {
    const expectedDayKeys = buildRollingDayKeys(now(), USAGE_HISTORY_DAY_COUNT);
    const historyByDayKey = new Map(
      historyDays
        .filter((entry) => expectedDayKeys.includes(entry.dayKey))
        .map((entry) => [entry.dayKey, entry] as const)
    );
    historyByDayKey.set(todayHistory.dayKey, todayHistory);

    return expectedDayKeys.map((expectedDayKey) => {
      const history = historyByDayKey.get(expectedDayKey);
      return {
        dayKey: expectedDayKey,
        totalCostUsd: roundUsd(history?.totalCostUsd ?? 0),
        totalTokens: Math.round(history?.totalTokens ?? 0),
        costSource: resolveHistoryCostSource(history)
      };
    });
  }

  function findBindingByKmuxSessionId(
    sessionId: Id
  ): SurfaceBinding | undefined {
    return Array.from(bindings.values()).find(
      (binding) => binding.kmuxSessionId === sessionId
    );
  }

  function hasManualBinding(surfaceId: Id): boolean {
    return bindings.get(surfaceId)?.source === "manual_cli";
  }

  function clearSurfaceInputState(surfaceId: Id): void {
    inputBuffers.delete(surfaceId);
    manualCandidates.delete(surfaceId);
    clearManualUsageCatchup(surfaceId);
  }

  function updateBindingSurfaceCwd(surfaceId: Id): void {
    const binding = bindings.get(surfaceId);
    if (!binding) {
      return;
    }
    binding.cwd = terminalRuntimeMetadataForSurface(
      options.getState(),
      surfaceId
    )?.cwd;
  }

  function markVendorAdaptersDirty(
    vendor: Exclude<UsageVendor, "unknown">,
    dirtyOptions?: Parameters<NonNullable<UsageAdapter["markDirty"]>>[0]
  ): void {
    const targetLocalUsage = options
      .targetServices?.()
      ?.resolveLocated({ kind: "local" }).usage;
    if (targetLocalUsage?.markDirty) {
      targetLocalUsage.markDirty(vendor, dirtyOptions);
      return;
    }
    if (scanService) {
      scanService.markDirty(vendor, dirtyOptions);
      return;
    }
    for (const adapter of adapters) {
      if (adapter.vendor === vendor) {
        adapter.markDirty?.(dirtyOptions);
      }
    }
  }

  function scheduleManualUsageCatchup(
    surfaceId: Id,
    vendor: Exclude<UsageVendor, "unknown">
  ): void {
    clearManualUsageCatchup(surfaceId);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    manualUsageCatchupTimers.set(surfaceId, timers);
    for (const delayMs of MANUAL_USAGE_CATCHUP_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) {
          manualUsageCatchupTimers.delete(surfaceId);
        }
        markVendorAdaptersDirty(vendor, DISCOVER_ONLY_DIRTY_OPTIONS);
        void refreshNow();
      }, delayMs);
      timers.add(timer);
    }
  }

  function clearManualUsageCatchup(surfaceId: Id): void {
    const timers = manualUsageCatchupTimers.get(surfaceId);
    if (!timers) {
      return;
    }
    for (const timer of timers) {
      clearTimeout(timer);
    }
    manualUsageCatchupTimers.delete(surfaceId);
  }

  function clearAllManualUsageCatchups(): void {
    for (const surfaceId of manualUsageCatchupTimers.keys()) {
      clearManualUsageCatchup(surfaceId);
    }
  }

  function getNextManualCliRefreshDelayMs(nowMs: number): number | null {
    let nextDelayMs: number | null = null;
    for (const candidate of manualCandidates.values()) {
      const candidateDelay = Math.max(
        0,
        Math.min(candidate.nextProbeAtMs, candidate.expiresAtMs) - nowMs
      );
      if (nextDelayMs === null || candidateDelay < nextDelayMs) {
        nextDelayMs = candidateDelay;
      }
    }
    return nextDelayMs;
  }

  function buildSubscriptionUsageSnapshot(): SubscriptionProviderUsageVm[] {
    const visibleProviders = getVisibleSubscriptionProviders();

    return SUBSCRIPTION_PROVIDER_ORDER.flatMap((provider) => {
      if (!visibleProviders.has(provider)) {
        return [];
      }
      const providerUsage = subscriptionUsage.get(provider);
      if (!providerUsage || providerUsage.rows.length === 0) {
        return [];
      }
      return [
        {
          ...providerUsage,
          rows: providerUsage.rows.map((row) => {
            const resetsAtMs = row.resetsAt
              ? Date.parse(row.resetsAt)
              : Number.NaN;
            return {
              ...row,
              resetLabel: Number.isFinite(resetsAtMs)
                ? formatResetLabel(resetsAtMs, now(), row.resetLabel)
                : row.resetLabel
            };
          })
        }
      ];
    });
  }

  function createSubscriptionVisibilitySignature(
    visibleProviders: Map<SubscriptionProvider, SubscriptionVisibility>
  ): string {
    return SUBSCRIPTION_PROVIDER_ORDER.flatMap((provider) => {
      const visibility = visibleProviders.get(provider);
      return visibility ? [`${provider}:${visibility}`] : [];
    }).join("|");
  }

  return {
    start,
    shutdown,
    getSnapshot,
    getSurfaceVendor,
    handleAppAction,
    handleTerminalInput,
    setDashboardOpen,
    refreshNow
  };
}

function resolveSurfaceId(
  state: AppState,
  action: Extract<AppAction, { type: "agent.event" }>
): Id | null {
  if (action.surfaceId && state.surfaces[action.surfaceId]) {
    return action.surfaceId;
  }
  if (action.sessionId) {
    const session = state.sessions[action.sessionId];
    if (session?.surfaceId) {
      return session.surfaceId;
    }
  }
  return null;
}

function currentUsageTargets(state: AppState): WorkspaceTarget[] {
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

function usageTargetKey(target: WorkspaceTarget): string {
  return target.kind === "local" ? "local" : `ssh:${target.targetId}`;
}

function sameUsageTarget(
  left: WorkspaceTarget | undefined,
  right: WorkspaceTarget
): boolean {
  return (
    left?.kind === right.kind &&
    (left.kind === "local" ||
      (right.kind === "ssh" && left.targetId === right.targetId))
  );
}

function usageTargetIdentity(
  target: WorkspaceTarget,
  principal?: { uid: number; accountName: string }
): UsageTargetIdentityVm {
  return target.kind === "local"
    ? { kind: "local" }
    : {
        kind: "ssh",
        targetId: target.targetId,
        ...(principal === undefined ? {} : { principal: { ...principal } })
      };
}

function usageTargetIdentityKey(target: UsageTargetIdentityVm): string {
  return target.kind === "local" ? "local" : `ssh:${target.targetId}`;
}

function usageUnavailableTargetKey(target: UsageUnavailableTargetVm): string {
  return target.kind === "local" ? "local" : `ssh:${target.targetId}`;
}

function scopedUsageSample(
  target: WorkspaceTarget,
  principal: { uid: number; accountName: string } | undefined,
  record: TargetUsageRecord<LocatedPath>
): ScopedUsageEventSample {
  const cwd = rawUsagePath(target, record.cwd);
  const projectPath = rawUsagePath(target, record.projectPath);
  return {
    usageTarget: { ...target },
    ...(principal === undefined ? {} : { principal: { ...principal } }),
    vendor: record.vendor,
    timestampMs: record.timestampUnixMs,
    sourcePath: `kmux-usage://${encodeURIComponent(usageTargetKey(target))}/${encodeURIComponent(record.sampleId)}`,
    sourceType: "jsonl",
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
    ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
    eventId: record.eventId ?? record.sampleId,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(projectPath === undefined ? {} : { projectPath }),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(record.thinkingTokens === undefined
      ? {}
      : { thinkingTokens: record.thinkingTokens }),
    ...(record.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: record.cacheReadTokens }),
    ...(record.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: record.cacheWriteTokens }),
    ...(record.cacheWriteTokensKnown === undefined
      ? {}
      : { cacheWriteTokensKnown: record.cacheWriteTokensKnown }),
    cacheTokens: record.cacheTokens,
    totalTokens: record.totalTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    ...(record.costSource === undefined
      ? {}
      : { costSource: record.costSource })
  };
}

function rawUsagePath(
  target: WorkspaceTarget,
  path: LocatedPath | undefined
): string | undefined {
  if (!path) return undefined;
  const encoded = encodeLocatedPathDto(path);
  if (
    (target.kind === "local" && encoded.kind !== "local") ||
    (target.kind === "ssh" &&
      (encoded.kind !== "ssh" || encoded.targetId !== target.targetId))
  ) {
    throw new Error("target usage path crossed its provider target");
  }
  return encoded.path;
}

function mergeScopedUsageSamples(
  previous: ScopedUsageEventSample[],
  incoming: ScopedUsageEventSample[]
): ScopedUsageEventSample[] {
  const merged = new Map<string, ScopedUsageEventSample>();
  for (const sample of previous) {
    merged.set(usageSampleIdentity(sample), sample);
  }
  for (const sample of incoming) {
    const identity = usageSampleIdentity(sample);
    const existing = merged.get(identity);
    if (!existing || shouldReplaceUsageSample(existing, sample)) {
      merged.set(identity, sample);
    }
  }
  return [...merged.values()];
}

function matchSampleToSurface(
  sample: ScopedUsageEventSample,
  state: AppState,
  bindings: Map<Id, SurfaceBinding>,
  unboundSurfacePathIndex: Map<string, Id | null>
): UsageSampleMatch | null {
  const vendorBindings = Array.from(bindings.values()).filter(
    (binding) =>
      binding.vendor === sample.vendor &&
      sameUsageTarget(
        state.workspaces[binding.workspaceId]?.location.target,
        sample.usageTarget
      )
  );

  const sessionKey = sample.threadId ?? sample.sessionId;
  if (sessionKey) {
    const bySession = vendorBindings.filter(
      (binding) =>
        binding.vendorSessionId === sessionKey ||
        binding.kmuxSessionId === sessionKey
    );
    if (bySession.length === 1) {
      return {
        surfaceId: bySession[0].surfaceId,
        attribution: "session",
        attributionState: "bound"
      };
    }
    if (bySession.length > 1) {
      return null;
    }
  }

  const pathKey = normalizeComparablePath(sample.cwd ?? sample.projectPath);
  if (!pathKey) {
    return null;
  }
  const byPath = vendorBindings.filter(
    (binding) =>
      normalizeComparablePath(rawUsagePath(sample.usageTarget, binding.cwd)) ===
      pathKey
  );
  if (byPath.length === 1) {
    return {
      surfaceId: byPath[0].surfaceId,
      attribution: "path",
      attributionState: "bound"
    };
  }

  const inferredSurfaceId = unboundSurfacePathIndex.get(
    `${usageTargetKey(sample.usageTarget)}\0${pathKey}`
  );
  if (!inferredSurfaceId) {
    return null;
  }
  return {
    surfaceId: inferredSurfaceId,
    attribution: "path",
    attributionState: "aggregate_only"
  };
}

function normalizeComparablePath(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.replace(/\/+$/, "") : null;
}

function resolveDirectoryHotspotPath(
  sample: UsageEventSample,
  fallbackCwd?: string
): string | null {
  return normalizeComparablePath(
    sample.projectPath ?? sample.cwd ?? fallbackCwd
  );
}

function buildUnboundSurfacePathIndex(
  state: AppState,
  bindings: Map<Id, SurfaceBinding>
): Map<string, Id | null> {
  const index = new Map<string, Id | null>();

  for (const surface of Object.values(state.surfaces)) {
    if (bindings.has(surface.id)) {
      continue;
    }
    const pane = state.panes[surface.paneId];
    const target = pane
      ? state.workspaces[pane.workspaceId]?.location.target
      : undefined;
    if (!target) continue;
    const rawPath = rawUsagePath(
      target,
      terminalRuntimeMetadataForSurface(state, surface.id)?.cwd
    );
    const comparablePath = normalizeComparablePath(rawPath);
    const pathKey = comparablePath
      ? `${usageTargetKey(target)}\0${comparablePath}`
      : null;
    if (!pathKey) {
      continue;
    }
    const existing = index.get(pathKey);
    if (!existing) {
      index.set(pathKey, surface.id);
      continue;
    }
    if (existing !== surface.id) {
      index.set(pathKey, null);
    }
  }

  return index;
}

function createDerivedSurfaceForMatch(
  state: AppState,
  surfaceId: Id,
  vendor: Exclude<UsageVendor, "unknown">,
  attributionState: UsageAttributionState,
  timestampMs: number
): DerivedSurface | null {
  const surface = state.surfaces[surfaceId];
  const pane = surface ? state.panes[surface.paneId] : undefined;
  if (!surface || !pane) {
    return null;
  }

  return {
    surfaceId,
    workspaceId: pane.workspaceId,
    vendor,
    sessionCostUsd: 0,
    sessionTokens: 0,
    todayCostUsd: 0,
    todayTokens: 0,
    updatedAtMs: timestampMs,
    attributionState,
    costSource: "reported",
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    unknownCostTokens: 0
  };
}

function minPositiveDelay(delays: Array<number | null>): number | null {
  let nextDelay: number | null = null;
  for (const delay of delays) {
    if (delay === null) {
      continue;
    }
    if (nextDelay === null || delay < nextDelay) {
      nextDelay = delay;
    }
  }
  return nextDelay;
}

function createSnapshotSignature(snapshot: UsageViewSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    updatedAt: ""
  });
}

function normalizeVendor(agent: string): UsageVendor {
  const normalized = agent.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "codex":
    case "antigravity":
      return normalized;
    case "agy":
    case "antigravity-cli":
      return "antigravity";
    default:
      return "unknown";
  }
}

function isSubscriptionProvider(
  vendor: UsageVendor
): vendor is SubscriptionProvider {
  return vendor === "claude" || vendor === "codex" || vendor === "antigravity";
}

function pricingVendorForUsageVendor(
  vendor: UsageVendor
): PricingVendor | null {
  if (vendor === "antigravity") {
    return "gemini";
  }
  if (vendor === "claude" || vendor === "codex") {
    return vendor;
  }
  return null;
}

function normalizeAiCliExecutableVendor(
  normalizedExecutable: string
): Exclude<UsageVendor, "unknown"> | null {
  if (normalizedExecutable === "codex") {
    return "codex";
  }
  if (
    normalizedExecutable === "agy" ||
    normalizedExecutable === "antigravity" ||
    normalizedExecutable === "antigravity-cli"
  ) {
    return "antigravity";
  }
  if (
    normalizedExecutable === "claude" ||
    normalizedExecutable === "claude-code"
  ) {
    return "claude";
  }
  return null;
}

function detectAiCliVendorFromCommand(
  commandLine: string
): Exclude<UsageVendor, "unknown"> | null {
  const tokens = tokenizeCommandLine(commandLine);
  const executable = firstExecutableToken(tokens);
  if (!executable) {
    return null;
  }

  const normalizedExecutable = normalizeCommandName(executable);
  return normalizeAiCliExecutableVendor(normalizedExecutable);
}

function tokenizeCommandLine(commandLine: string): string[] {
  return commandLine
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function firstExecutableToken(tokens: string[]): string | null {
  let index = 0;
  if (tokens[index] === "env") {
    index += 1;
  }

  while (index < tokens.length && isShellEnvAssignment(tokens[index] ?? "")) {
    index += 1;
  }

  return tokens[index] ?? null;
}

function isShellEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.+$/u.test(token);
}

function normalizeCommandName(token: string): string {
  return (
    token
      .replace(/^['"]+|['"]+$/gu, "")
      .split("/")
      .pop()
      ?.toLowerCase() ?? ""
  );
}

function applyTerminalInput(
  currentBuffer: string,
  text: string
): {
  nextBuffer: string;
  submittedLines: string[];
  interrupted: boolean;
} {
  let buffer = currentBuffer;
  const submittedLines: string[] = [];
  let interrupted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (character === "\r" || character === "\n") {
      if (buffer.trim()) {
        submittedLines.push(buffer);
      }
      buffer = "";
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      buffer = buffer.slice(0, -1);
      continue;
    }
    if (character === "\u0015") {
      buffer = "";
      continue;
    }
    if (character === "\u0003" || character === "\u0004") {
      interrupted = true;
      buffer = "";
      continue;
    }
    if (character < " " || character === "\u001b") {
      continue;
    }
    buffer = `${buffer}${character}`.slice(-MANUAL_INPUT_BUFFER_LIMIT);
  }

  return {
    nextBuffer: buffer,
    submittedLines,
    interrupted
  };
}

function normalizeUsageSampleCostSource(
  sample: UsageEventSample
): SampleCostSource {
  if (sample.costSource) {
    return sample.costSource;
  }
  return sample.estimatedCostUsd > 0 ? "reported" : "unavailable";
}

function costedUsageSampleUsd(
  sample: UsageEventSample,
  costSource = normalizeUsageSampleCostSource(sample)
): number {
  return costSource === "unavailable" ? 0 : sample.estimatedCostUsd;
}

function buildDirectoryHotspots(
  directoryTotals: DerivedDirectory[]
): UsageViewSnapshot["directoryHotspots"] {
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();

  for (const directory of directoryTotals) {
    const leaf = basename(directory.directoryPath);
    if (!leaf) {
      continue;
    }
    if (seenNames.has(leaf)) {
      duplicateNames.add(leaf);
      continue;
    }
    seenNames.add(leaf);
  }

  return directoryTotals
    .filter(
      (directory) => directory.todayCostUsd > 0 || directory.todayTokens > 0
    )
    .map((directory) => ({
      target: directory.target,
      directoryPath: directory.directoryPath,
      directoryLabel: buildDirectoryHotspotLabel(
        directory.directoryPath,
        duplicateNames
      ),
      todayCostUsd: roundUsd(directory.todayCostUsd),
      todayTokens: Math.round(directory.todayTokens),
      costSource: directory.costSource
    }))
    .sort(
      (left, right) =>
        right.todayCostUsd - left.todayCostUsd ||
        right.todayTokens - left.todayTokens
    )
    .slice(0, 8);
}

function buildDirectoryHotspotLabel(
  directoryPath: string,
  duplicateNames: Set<string>
): string {
  const leaf = basename(directoryPath);
  if (!leaf) {
    return directoryPath;
  }
  if (!duplicateNames.has(leaf)) {
    return leaf;
  }
  const parent = basename(dirname(directoryPath));
  if (!parent || parent === "." || parent === leaf) {
    return directoryPath;
  }
  return `${parent}/${leaf}`;
}

function applyCostBreakdown(
  target: {
    reportedCostUsd: number;
    estimatedCostUsd: number;
    unknownCostTokens: number;
  },
  sample: UsageEventSample,
  costSource = normalizeUsageSampleCostSource(sample)
): void {
  if (costSource === "reported") {
    target.reportedCostUsd += sample.estimatedCostUsd;
    return;
  }
  if (costSource === "estimated") {
    target.estimatedCostUsd += sample.estimatedCostUsd;
    return;
  }
  target.unknownCostTokens += sample.totalTokens;
}

function resolveCostSource(target: {
  estimatedCostUsd: number;
  unknownCostTokens: number;
}): UsageCostSource {
  if (target.unknownCostTokens > 0) {
    return "partial";
  }
  if (target.estimatedCostUsd > 0) {
    return "estimated";
  }
  return "reported";
}

function applyPricingCoverage(
  target: UsagePricingCoverageVm,
  sample: UsageEventSample,
  costSource = normalizeUsageSampleCostSource(sample)
): void {
  if (costSource === "reported") {
    target.reportedCostUsd += sample.estimatedCostUsd;
    return;
  }
  if (costSource === "estimated") {
    target.estimatedCostUsd += sample.estimatedCostUsd;
    target.hasEstimatedCosts = true;
    target.fullyPriced = false;
    return;
  }
  target.unknownCostTokens += sample.totalTokens;
  target.hasMissingPricing = true;
  target.fullyPriced = false;
}

function applyTokenCostBreakdown(
  target: UsageTokenCostBreakdownVm,
  sample: UsageEventSample
): void {
  const pricingVendor = pricingVendorForUsageVendor(sample.vendor);
  if (!pricingVendor) {
    return;
  }

  const cacheReadTokens = sample.cacheReadTokens ?? sample.cacheTokens;
  const cacheWriteTokens = sample.cacheWriteTokens ?? 0;
  const thinkingTokens = sample.thinkingTokens ?? 0;
  const estimate = estimateUsageComponentCosts({
    vendor: pricingVendor,
    model: sample.model,
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWriteTokensKnown: sample.cacheWriteTokensKnown
  });

  if (!estimate) {
    markUnknownTokenCost(target, "input", sample.inputTokens > 0);
    markUnknownTokenCost(target, "output", sample.outputTokens > 0);
    markUnknownTokenCost(target, "thinking", thinkingTokens > 0);
    markUnknownTokenCost(target, "cacheRead", cacheReadTokens > 0);
    markUnknownTokenCost(
      target,
      "cacheWrite",
      cacheWriteTokens > 0 || sample.cacheWriteTokensKnown === false
    );
    return;
  }

  target.inputCostUsd += estimate.inputCostUsd;
  target.outputCostUsd += estimate.outputCostUsd;
  target.thinkingCostUsd += estimate.thinkingCostUsd;
  target.cacheReadCostUsd += estimate.cacheReadCostUsd;
  target.cacheWriteCostUsd += estimate.cacheWriteCostUsd;

  markUnknownTokenCost(target, "input", !estimate.inputCostKnown);
  markUnknownTokenCost(target, "output", !estimate.outputCostKnown);
  markUnknownTokenCost(target, "thinking", !estimate.thinkingCostKnown);
  markUnknownTokenCost(target, "cacheRead", !estimate.cacheReadCostKnown);
  markUnknownTokenCost(target, "cacheWrite", !estimate.cacheWriteCostKnown);
}

function resolveModelUsageIdentity(
  sample: UsageEventSample
): { modelId: string; modelLabel: string } | null {
  if (!sample.model) {
    return null;
  }
  const pricingVendor = pricingVendorForUsageVendor(sample.vendor);
  const canonicalModelId = pricingVendor
    ? resolveCanonicalModelId({
        vendor: pricingVendor,
        model: sample.model
      })
    : null;
  if (canonicalModelId) {
    return {
      modelId: canonicalModelId,
      modelLabel: canonicalModelId
    };
  }
  return {
    modelId: sample.model,
    modelLabel: sample.model
  };
}

function markUnknownTokenCost(
  target: UsageTokenCostBreakdownVm,
  component: "input" | "output" | "thinking" | "cacheRead" | "cacheWrite",
  shouldMark: boolean
): void {
  if (!shouldMark) {
    return;
  }

  if (component === "input") {
    target.hasUnknownInputCost = true;
    return;
  }
  if (component === "output") {
    target.hasUnknownOutputCost = true;
    return;
  }
  if (component === "thinking") {
    target.hasUnknownThinkingCost = true;
    return;
  }
  if (component === "cacheRead") {
    target.hasUnknownCacheReadCost = true;
    return;
  }
  target.hasUnknownCacheWriteCost = true;
}

function buildTodayHistoryRecord(
  dayKey: string,
  totalTodayCostUsd: number,
  totalTodayTokens: number,
  vendorTotals: Map<Exclude<UsageVendor, "unknown">, DerivedVendor>,
  pricingCoverage: UsagePricingCoverageVm
): UsageHistoryDayRecord {
  return {
    dayKey,
    totalCostUsd: roundUsd(totalTodayCostUsd),
    reportedCostUsd: roundUsd(pricingCoverage.reportedCostUsd),
    estimatedCostUsd: roundUsd(pricingCoverage.estimatedCostUsd),
    unknownCostTokens: Math.round(pricingCoverage.unknownCostTokens),
    totalTokens: Math.round(totalTodayTokens),
    vendors: Array.from(vendorTotals.values())
      .map((vendor) => ({
        vendor: vendor.vendor,
        totalCostUsd: roundUsd(vendor.todayCostUsd),
        totalTokens: Math.round(vendor.todayTokens)
      }))
      .sort((left, right) => right.totalCostUsd - left.totalCostUsd)
  };
}

function normalizeHistoryDays(
  days: UsageHistoryDayRecord[]
): UsageHistoryDayRecord[] {
  return days
    .flatMap(normalizeHistoryDay)
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey))
    .slice(-USAGE_HISTORY_DAY_COUNT);
}

function normalizeHistoryDay(
  day: UsageHistoryDayRecord
): UsageHistoryDayRecord[] {
  if (!Array.isArray(day.vendors)) {
    return [];
  }
  const vendors = day.vendors
    .filter((vendorRecord) => isSubscriptionProvider(vendorRecord.vendor))
    .map((vendorRecord) => ({
      vendor: vendorRecord.vendor,
      totalCostUsd: roundUsd(vendorRecord.totalCostUsd),
      totalTokens: Math.round(vendorRecord.totalTokens)
    }))
    .filter(
      (vendorRecord) =>
        vendorRecord.totalCostUsd > 0 || vendorRecord.totalTokens > 0
    )
    .sort((left, right) => right.totalCostUsd - left.totalCostUsd);
  if (vendors.length === 0) {
    return [];
  }
  const totalCostUsd = roundUsd(
    vendors.reduce((total, vendor) => total + vendor.totalCostUsd, 0)
  );
  const totalTokens = Math.round(
    vendors.reduce((total, vendor) => total + vendor.totalTokens, 0)
  );
  return [
    {
      ...day,
      totalCostUsd,
      reportedCostUsd: 0,
      estimatedCostUsd: totalCostUsd,
      unknownCostTokens: 0,
      totalTokens,
      vendors
    }
  ];
}

function buildRollingDayKeys(nowMs: number, count: number): string[] {
  const keys: string[] = [];
  const cursor = new Date(startOfLocalDay(nowMs));
  cursor.setDate(cursor.getDate() - (count - 1));
  for (let index = 0; index < count; index += 1) {
    keys.push(dayKeyFor(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function startOfRollingDayRange(nowMs: number, count: number): number {
  const date = new Date(startOfLocalDay(nowMs));
  date.setDate(date.getDate() - (count - 1));
  return date.getTime();
}

function endOfLocalDay(nowMs: number): number {
  const date = new Date(startOfLocalDay(nowMs));
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function resolveHistoryCostSource(
  history: UsageHistoryDayRecord | undefined
): UsageCostSource {
  if (!history) {
    return "reported";
  }
  if (history.unknownCostTokens > 0) {
    return "partial";
  }
  if (history.estimatedCostUsd > 0) {
    return "estimated";
  }
  return "reported";
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function startOfLocalDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyFor(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
