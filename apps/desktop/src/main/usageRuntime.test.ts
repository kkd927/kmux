import { applyAction, createInitialState } from "@kmux/core";
import { type AppAction } from "@kmux/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageAdapter, UsageAdapterReadResult, UsageEventSample } from "@kmux/metadata";
import type { SubscriptionProviderUsageVm } from "@kmux/proto";
import { createUsageRuntime } from "./usageRuntime";

class FakeUsageAdapter implements UsageAdapter {
  readonly vendor;
  private initialReads: UsageAdapterReadResult[];
  private incrementalReads: UsageAdapterReadResult[];
  markDirty = vi.fn();

  constructor(options: {
    vendor?: UsageAdapter["vendor"];
    initialReads?: UsageAdapterReadResult[];
    incrementalReads?: UsageAdapterReadResult[];
  }) {
    this.vendor = options.vendor ?? "claude";
    this.initialReads = options.initialReads ?? [];
    this.incrementalReads = options.incrementalReads ?? [];
  }

  async initialScan(): Promise<UsageAdapterReadResult> {
    return this.initialReads.shift() ?? { samples: [], sourceCount: 1 };
  }

  async readIncremental(): Promise<UsageAdapterReadResult> {
    return this.incrementalReads.shift() ?? { samples: [], sourceCount: 1 };
  }

  watch(): () => void {
    return () => undefined;
  }

  close(): void {}
}

describe("usage runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not emit another usage snapshot when incremental reads are unchanged", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const emitSnapshot = vi.fn();
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const adapter = new FakeUsageAdapter({
      initialReads: [
        {
          sourceCount: 1,
          samples: [
            buildSample({
              sessionId: "claude-session-1",
              estimatedCostUsd: 1.25
            })
          ]
        }
      ]
    });

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction,
      adapters: [adapter],
      emitSnapshot,
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "claude-session-1",
      agent: "claude",
      event: "running"
    });

    expect(emitSnapshot).toHaveBeenCalledTimes(1);

    await runtime.refreshNow();
    expect(emitSnapshot).toHaveBeenCalledTimes(2);

    await runtime.refreshNow();

    expect(emitSnapshot).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        todayCostUsd: 1.25,
        sessionCostUsd: 1.25
      })
    );
  });

  it("does not dispatch notifications or sidebar statuses for daily spend totals", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const adapter = new FakeUsageAdapter({
      initialReads: [
        {
          sourceCount: 1,
          samples: [
            buildSample({
              sessionId: "claude-session-2",
              estimatedCostUsd: 8
            })
          ]
        }
      ]
    });

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction,
      adapters: [adapter],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:30:00.000Z").getTime()
    });

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "claude-session-2",
      agent: "claude",
      event: "running"
    });

    await runtime.refreshNow();
    const firstWave = dispatchAppAction.mock.calls.map(([action]) => action.type);

    dispatchAppAction.mockClear();
    await runtime.refreshNow();

    expect(firstWave).not.toContain("notification.create");
    expect(firstWave).not.toContain("sidebar.setStatus");
    expect(dispatchAppAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "notification.create" })
    );
    expect(dispatchAppAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sidebar.setStatus" })
    );
  });

  it("clears restored budget sidebar statuses and notifications from older usage dashboard builds", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    state.workspaces[workspaceId].statusEntries["usage:daily:vendor:codex"] = {
      key: "usage:daily:vendor:codex",
      text: "Codex daily budget 103% reached ($1.03 / $1.00)",
      label: "Codex",
      variant: "attention",
      updatedAt: new Date("2026-04-17T10:55:00.000Z").toISOString()
    };
    state.notifications.push({
      id: "notification_budget_legacy",
      workspaceId,
      title: "Codex budget alert",
      message: "Codex daily budget 103% reached ($1.03 / $1.00)",
      source: "status",
      createdAt: new Date("2026-04-17T10:55:00.000Z").toISOString()
    });
    const dispatchedActions: AppAction[] = [];
    const dispatchAppAction = (action: AppAction) => {
      dispatchedActions.push(action);
      applyAction(state, action);
    };

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction,
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:30:00.000Z").getTime()
    });

    await runtime.refreshNow();

    expect(state.workspaces[workspaceId].statusEntries).not.toHaveProperty(
      "usage:daily:vendor:codex"
    );
    expect(state.notifications).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: "notification_budget_legacy" })
      ])
    );
    expect(dispatchedActions).toContainEqual(
      expect.objectContaining({
        type: "sidebar.clearStatus",
        workspaceId,
        key: "usage:daily:vendor:codex"
      })
    );
    expect(dispatchedActions).toContainEqual(
      expect.objectContaining({
        type: "notification.clear",
        notificationId: "notification_budget_legacy"
      })
    );
  });

  it("keeps session totals when a surface binds to an already-running vendor session", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const adapter = new FakeUsageAdapter({
      initialReads: [
        {
          sourceCount: 1,
          samples: [
            buildSample({
              sessionId: "claude-session-live",
              estimatedCostUsd: 1.25,
              totalTokens: 500
            })
          ]
        }
      ]
    });

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [adapter],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    await runtime.refreshNow();

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "claude-session-live",
      agent: "claude",
      event: "running"
    });

    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        todayCostUsd: 1.25,
        sessionCostUsd: 1.25,
        sessionTokens: 500
      })
    );
  });

  it("ignores non-binding surface metadata churn when rebuilding usage snapshots", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-usage-before-rebind";
    const emitSnapshot = vi.fn();
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                buildSample({
                  cwd: "/tmp/kmux-usage-before-rebind",
                  projectPath: "/tmp/kmux-usage-before-rebind",
                  estimatedCostUsd: 0.75,
                  totalTokens: 320
                })
              ]
            }
          ]
        })
      ],
      emitSnapshot,
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    await runtime.refreshNow();
    emitSnapshot.mockClear();

    const titleAction: AppAction = {
      type: "surface.metadata",
      surfaceId,
      title: "fresh shell title",
      attention: true,
      unreadDelta: 1
    };
    applyAction(state, titleAction);
    runtime.handleAppAction(titleAction);

    expect(emitSnapshot).not.toHaveBeenCalled();

    const cwdAction: AppAction = {
      type: "surface.metadata",
      surfaceId,
      cwd: "/tmp/kmux-usage-rebind"
    };
    applyAction(state, cwdAction);
    runtime.handleAppAction(cwdAction);

    expect(emitSnapshot).toHaveBeenCalledTimes(1);
  });

  it("infers a tracked surface from a unique cwd match even without an agent hook", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-project";

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                buildSample({
                  cwd: "/tmp/kmux-project",
                  projectPath: "/tmp/kmux-project",
                  estimatedCostUsd: 0.75,
                  totalTokens: 320
                })
              ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    await runtime.refreshNow();

    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        todayCostUsd: 0.75,
        todayTokens: 320,
        sessionCostUsd: 0,
        sessionTokens: 0,
        attributionState: "aggregate_only"
      })
    );
  });

  it("shows a live bound HUD state for a manually launched codex CLI once the shell child process is detected", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const sessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-codex-manual";
    state.sessions[sessionId].pid = 4242;
    state.sessions[sessionId].runtimeState = "running";
    const resolveAiCliProcesses = vi.fn(async () => {
      return new Map([
        [
          4242,
          {
            parentPid: 4242,
            pid: process.pid,
            vendor: "codex" as const,
            commandLine: "/usr/local/bin/codex exec"
          }
        ]
      ]);
    });
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                buildSample({
                  vendor: "codex",
                  timestampMs: new Date("2026-04-17T10:59:59.000Z").getTime(),
                  cwd: "/tmp/kmux-codex-manual",
                  projectPath: "/tmp/kmux-codex-manual",
                  sessionId: undefined,
                  estimatedCostUsd: 0,
                  totalTokens: 544,
                  inputTokens: 384,
                  cacheTokens: 128,
                  outputTokens: 32
                })
              ]
            }
          ]
        })
      ],
      resolveAiCliProcesses,
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    runtime.handleTerminalInput(surfaceId, "codex exec --skip-git-repo-check\r");
    await runtime.refreshNow();

    expect(resolveAiCliProcesses).toHaveBeenCalledWith([
      {
        parentPid: 4242,
        vendor: "codex"
      }
    ]);
    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        vendor: "codex",
        attributionState: "bound",
        state: "active",
        sessionTokens: 544,
        todayTokens: 544
      })
    );
  });

  it("builds model, daily activity, and pricing coverage aggregates for the dashboard", async () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                {
                  ...buildSample({
                    vendor: "codex",
                    sessionId: "codex-dashboard-session",
                    model: "gpt-5.4",
                    projectPath: "/tmp/kmux-dashboard",
                    cwd: "/tmp/kmux-dashboard",
                    estimatedCostUsd: 0.00375,
                    totalTokens: 1280,
                    inputTokens: 1000,
                    cacheTokens: 200,
                    outputTokens: 80
                  }),
                  costSource: "estimated"
                } as UsageEventSample
              ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime(),
      historyStore: createFakeUsageHistoryStore([
        {
          dayKey: "2026-04-16",
          totalCostUsd: 2.1,
          reportedCostUsd: 2.1,
          estimatedCostUsd: 0,
          unknownCostTokens: 0,
          totalTokens: 2100,
          activeSessionCount: 2,
          vendors: [
            {
              vendor: "claude",
              totalCostUsd: 2.1,
              totalTokens: 2100,
              activeSessionCount: 2
            }
          ]
        }
      ])
    } as never);

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "codex-dashboard-session",
      agent: "codex",
      event: "running"
    });

    await runtime.refreshNow();

    const snapshot = runtime.getSnapshot() as typeof runtime.getSnapshot extends () => infer T
      ? T & {
          models?: Array<Record<string, unknown>>;
          dailyActivity?: Array<Record<string, unknown>>;
          pricingCoverage?: Record<string, unknown>;
        }
      : never;

    expect(snapshot.models).toEqual([
      expect.objectContaining({
        vendor: "codex",
        modelId: "gpt-5.4",
        totalTokens: 1280,
        todayCostUsd: expect.closeTo(0.00375, 8),
        costSource: "estimated"
      })
    ]);
    expect(snapshot.directoryHotspots).toEqual([
      expect.objectContaining({
        directoryPath: "/tmp/kmux-dashboard",
        directoryLabel: "kmux-dashboard",
        todayTokens: 1280,
        todayCostUsd: expect.closeTo(0.00375, 8),
        costSource: "estimated"
      })
    ]);
    expect("hourly" in snapshot).toBe(false);
    expect(snapshot.dailyActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dayKey: "2026-04-16",
          totalTokens: 2100
        }),
        expect.objectContaining({
          dayKey: "2026-04-17",
          totalTokens: 1280,
          totalCostUsd: expect.closeTo(0.00375, 8)
        })
      ])
    );
    expect(snapshot.pricingCoverage).toEqual(
      expect.objectContaining({
        hasEstimatedCosts: true,
        hasMissingPricing: false,
        estimatedCostUsd: expect.closeTo(0.00375, 8)
      })
    );
  });

  it("aggregates thinking tokens into the token breakdown without double-counting output", async () => {
    const state = createInitialState();
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
      samples: [
        {
          ...buildSample({
            vendor: "claude",
            model: "claude-sonnet-4-5",
                    estimatedCostUsd: 0.006735,
            totalTokens: 1500,
            inputTokens: 900,
            cacheTokens: 300,
            outputTokens: 180
          }),
          cacheReadTokens: 200,
          cacheWriteTokens: 100,
          thinkingTokens: 60
        } as UsageEventSample
      ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:00:00.000Z").getTime()
    });

    await runtime.refreshNow();

    expect(runtime.getSnapshot().todayTokenBreakdown).toEqual(
      expect.objectContaining({
        inputTokens: 900,
        outputTokens: 180,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        thinkingTokens: 60,
        totalTokens: 1500
      })
    );
    expect(runtime.getSnapshot().todayTokenCostBreakdown).toEqual(
      expect.objectContaining({
        inputCostUsd: expect.closeTo(0.0027, 8),
        outputCostUsd: expect.closeTo(0.0027, 8),
        thinkingCostUsd: expect.closeTo(0.0009, 8),
        cacheReadCostUsd: expect.closeTo(0.00006, 8),
        cacheWriteCostUsd: expect.closeTo(0.000375, 8),
        hasUnknownCacheWriteCost: false
      })
    );
  });

  it("rolls the snapshot day forward and synthesizes a zero-usage today activity cell at local midnight", async () => {
    const state = createInitialState();
    let nowMs = new Date(2026, 3, 17, 23, 58, 0, 0).getTime();
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                buildSample({
                  timestampMs: new Date(2026, 3, 17, 22, 15, 0, 0).getTime(),
                  totalTokens: 300,
                  estimatedCostUsd: 1.2
                })
              ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      historyStore: createFakeUsageHistoryStore([]),
      now: () => nowMs
    } as never);

    await runtime.refreshNow();

    nowMs = new Date(2026, 3, 18, 0, 2, 0, 0).getTime();
    await runtime.refreshNow();

    const snapshot = runtime.getSnapshot();
    const lastActivity = snapshot.dailyActivity?.at(-1);

    expect(snapshot.dayKey).toBe("2026-04-18");
    expect(lastActivity).toEqual(
      expect.objectContaining({
        dayKey: "2026-04-18",
        totalTokens: 0,
        totalCostUsd: 0
      })
    );
  });

  it("marks pricing coverage as partial when usage tokens have no local model pricing", async () => {
    const state = createInitialState();
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                {
                  ...buildSample({
                    vendor: "gemini",
                    sessionId: "gemini-unpriced-session",
                    model: "gemini-unknown-preview",
                    estimatedCostUsd: 0,
                    totalTokens: 900,
                    inputTokens: 700,
                    cacheTokens: 0,
                    outputTokens: 200
                  }),
                  costSource: "unavailable"
                } as UsageEventSample
              ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      now: () => new Date("2026-04-17T11:30:00.000Z").getTime(),
      historyStore: createFakeUsageHistoryStore([])
    } as never);

    await runtime.refreshNow();

    const snapshot = runtime.getSnapshot() as typeof runtime.getSnapshot extends () => infer T
      ? T & {
          models?: Array<Record<string, unknown>>;
          pricingCoverage?: Record<string, unknown>;
        }
      : never;

    expect(snapshot.totalTodayCostUsd).toBe(0);
    expect(snapshot.models).toEqual([
      expect.objectContaining({
        modelId: "gemini-unknown-preview",
        totalTokens: 900,
        todayCostUsd: 0,
        costSource: "partial"
      })
    ]);
    expect(snapshot.pricingCoverage).toEqual(
      expect.objectContaining({
        hasEstimatedCosts: false,
        hasMissingPricing: true,
        unknownCostTokens: 900
      })
    );
  });

  it("polls subscription usage every minute for live providers while the dashboard is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const subscriptionFetchers = {
      codex: vi.fn(async (): Promise<SubscriptionProviderUsageVm> => ({
        provider: "codex",
        providerLabel: "Codex",
        planLabel: "Pro",
        source: "oauth",
        updatedAt: new Date("2026-04-17T11:00:00.000Z").toISOString(),
        rows: [
          {
            key: "session",
            label: "Session",
            usedPercent: 42,
            resetLabel: "Resets in 4h 0m",
            resetsAt: new Date("2026-04-17T15:00:00.000Z").toISOString(),
            windowKind: "session"
          }
        ]
      }))
    };
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      emitSnapshot: vi.fn(),
      subscriptionFetchers,
      subscriptionAuthDetectors: {}
    } as never);

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "codex-live-session",
      agent: "codex",
      event: "running"
    });

    runtime.start();
    runtime.setDashboardOpen(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(subscriptionFetchers.codex).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(58_000);
    expect(subscriptionFetchers.codex).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(subscriptionFetchers.codex).toHaveBeenCalledTimes(2);

    runtime.shutdown();
  });

  it("polls recent-only subscription providers every five minutes and stops when the dashboard closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const subscriptionFetchers = {
      gemini: vi.fn(async (): Promise<SubscriptionProviderUsageVm> => ({
        provider: "gemini",
        providerLabel: "Gemini",
        planLabel: "Paid",
        source: "quota_api",
        updatedAt: new Date("2026-04-17T11:00:00.000Z").toISOString(),
        rows: [
          {
            key: "pro",
            label: "Pro",
            usedPercent: 75,
            resetLabel: "Resets in 13h 0m",
            resetsAt: new Date("2026-04-18T00:00:00.000Z").toISOString(),
            windowKind: "model"
          }
        ]
      }))
    };
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [
        new FakeUsageAdapter({
          initialReads: [
            {
              sourceCount: 1,
              samples: [
                buildSample({
                  vendor: "gemini",
                  estimatedCostUsd: 0.75
                })
              ]
            }
          ]
        })
      ],
      emitSnapshot: vi.fn(),
      subscriptionFetchers,
      subscriptionAuthDetectors: {}
    } as never);

    runtime.start();
    runtime.setDashboardOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(subscriptionFetchers.gemini).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(subscriptionFetchers.gemini).toHaveBeenCalledTimes(2);

    runtime.setDashboardOpen(false);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

    expect(subscriptionFetchers.gemini).toHaveBeenCalledTimes(2);

    runtime.shutdown();
  });

  it("shows subscription providers from local auth fetchers even without recent usage samples", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const geminiFetcher = vi.fn(async (): Promise<SubscriptionProviderUsageVm> => ({
      provider: "gemini",
      providerLabel: "Gemini",
      planLabel: "Paid",
      source: "quota_api",
      updatedAt: new Date("2026-04-17T11:00:00.000Z").toISOString(),
      rows: [
        {
          key: "pro",
          label: "Pro",
          usedPercent: 42,
          resetLabel: "Resets in 6h 0m",
          resetsAt: new Date("2026-04-17T17:00:00.000Z").toISOString(),
          windowKind: "model"
        }
      ]
    }));
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      emitSnapshot: vi.fn(),
      subscriptionFetchers: {
        gemini: geminiFetcher
      },
      subscriptionAuthDetectors: {
        gemini: vi.fn(async () => true)
      }
    } as never);

    runtime.start();
    runtime.setDashboardOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(geminiFetcher).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().subscriptionUsage).toEqual([
      expect.objectContaining({
        provider: "gemini",
        planLabel: "Paid",
        rows: [expect.objectContaining({ key: "pro", usedPercent: 42 })]
      })
    ]);

    runtime.shutdown();
  });

  it("does not rerun subscription auth detectors on the dashboard refresh loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const geminiFetcher = vi.fn(async (): Promise<SubscriptionProviderUsageVm> => ({
      provider: "gemini",
      providerLabel: "Gemini",
      planLabel: "Paid",
      source: "quota_api",
      updatedAt: new Date("2026-04-17T11:00:00.000Z").toISOString(),
      rows: [
        {
          key: "pro",
          label: "Pro",
          usedPercent: 42,
          resetLabel: "Resets in 6h 0m",
          resetsAt: new Date("2026-04-17T17:00:00.000Z").toISOString(),
          windowKind: "model"
        }
      ]
    }));
    const geminiDetector = vi.fn(async () => true);
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      emitSnapshot: vi.fn(),
      subscriptionFetchers: {
        gemini: geminiFetcher
      },
      subscriptionAuthDetectors: {
        gemini: geminiDetector
      }
    } as never);

    runtime.start();
    runtime.setDashboardOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(geminiDetector).toHaveBeenCalledTimes(1);
    expect(geminiFetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(geminiDetector).toHaveBeenCalledTimes(1);
    expect(geminiFetcher).toHaveBeenCalledTimes(1);

    runtime.shutdown();
  });

  it("backs off failed subscription provider polls and resets to the live cadence after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const claudeFetcher = vi
      .fn<() => Promise<SubscriptionProviderUsageVm>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({
        provider: "claude",
        providerLabel: "Claude Code",
        planLabel: "Max",
        source: "oauth_usage",
        updatedAt: new Date("2026-04-17T11:07:00.000Z").toISOString(),
        rows: [
          {
            key: "session",
            label: "Session",
            usedPercent: 18,
            resetLabel: "Resets in 4h 0m",
            resetsAt: new Date("2026-04-17T15:00:00.000Z").toISOString(),
            windowKind: "session"
          }
        ]
      });
    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      emitSnapshot: vi.fn(),
      subscriptionFetchers: {
        claude: claudeFetcher
      },
      subscriptionAuthDetectors: {}
    } as never);

    runtime.handleAppAction({
      type: "agent.event",
      workspaceId,
      paneId,
      surfaceId,
      sessionId: "claude-live-session",
      agent: "claude",
      event: "running"
    });

    runtime.start();
    runtime.setDashboardOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(claudeFetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);
    expect(claudeFetcher).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(claudeFetcher).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(claudeFetcher).toHaveBeenCalledTimes(4);

    runtime.shutdown();
  });

  it("refreshes usage in the background even when the dashboard is closed so external writers do not require an app restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-external-refresh";

    const adapter = new FakeUsageAdapter({
      initialReads: [{ sourceCount: 0, samples: [] }],
      incrementalReads: [
        {
          sourceCount: 1,
          samples: [
            buildSample({
              vendor: "codex",
              sessionId: "external-codex-session",
              threadId: "external-codex-session",
              model: "gpt-5.4",
              cwd: "/tmp/kmux-external-refresh",
              projectPath: "/tmp/kmux-external-refresh",
              inputTokens: 320,
              outputTokens: 32,
              cacheTokens: 64,
              totalTokens: 416,
              estimatedCostUsd: 0.09
            })
          ]
        }
      ]
    });

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [adapter],
      emitSnapshot: vi.fn(),
      now: () => Date.now()
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.getSnapshot().surfaces[surfaceId]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        vendor: "codex",
        model: "gpt-5.4",
        todayTokens: 416,
        todayCostUsd: 0.09
      })
    );

    runtime.shutdown();
  });

  it("retries manual CLI process-table scans no more often than every ten seconds and stops once the child pid is bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const sessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-codex-manual-backoff";
    state.sessions[sessionId].pid = 4242;
    state.sessions[sessionId].runtimeState = "running";

    const resolveAiCliProcesses = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(
        new Map([
          [
            4242,
            {
              parentPid: 4242,
              pid: 5001,
              vendor: "codex" as const,
              commandLine: "/usr/local/bin/codex exec"
            }
          ]
        ])
      );

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [new FakeUsageAdapter({ initialReads: [{ sourceCount: 1, samples: [] }] })],
      resolveAiCliProcesses,
      emitSnapshot: vi.fn(),
      now: () => Date.now()
    });

    runtime.start();
    resolveAiCliProcesses.mockClear();

    runtime.handleTerminalInput(surfaceId, "codex exec --skip-git-repo-check\r");
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAiCliProcesses).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(resolveAiCliProcesses).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveAiCliProcesses).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolveAiCliProcesses).toHaveBeenCalledTimes(2);

    runtime.shutdown();
  });

  it("forces bounded manual codex catch-up refreshes so new usage files are ingested without falling back to hot polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;
    const sessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId].cwd = "/tmp/kmux-codex-manual-catchup";
    state.sessions[sessionId].pid = 4242;
    state.sessions[sessionId].runtimeState = "running";

    const adapter = new FakeUsageAdapter({
      vendor: "codex",
      initialReads: [{ sourceCount: 0, samples: [] }],
      incrementalReads: [
        { sourceCount: 0, samples: [] },
        { sourceCount: 0, samples: [] },
        {
          sourceCount: 1,
          samples: [
            buildSample({
              vendor: "codex",
              sessionId: "manual-codex-session",
              threadId: "manual-codex-session",
              model: "gpt-5.4",
              cwd: "/tmp/kmux-codex-manual-catchup",
              projectPath: "/tmp/kmux-codex-manual-catchup",
              inputTokens: 384,
              outputTokens: 32,
              cacheTokens: 128,
              totalTokens: 544,
              estimatedCostUsd: 0.12
            })
          ]
        }
      ]
    });
    const resolveAiCliProcesses = vi.fn().mockResolvedValue(
      new Map([
        [
          4242,
          {
            parentPid: 4242,
            pid: 5001,
            vendor: "codex" as const,
            commandLine: "/usr/local/bin/codex exec"
          }
        ]
      ])
    );

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [adapter],
      resolveAiCliProcesses,
      emitSnapshot: vi.fn(),
      now: () => Date.now()
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    adapter.markDirty.mockClear();
    resolveAiCliProcesses.mockClear();

    runtime.handleTerminalInput(surfaceId, "codex exec --skip-git-repo-check\r");
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAiCliProcesses).toHaveBeenCalledTimes(1);
    expect(adapter.markDirty).toHaveBeenCalledTimes(1);
    expect(adapter.markDirty).toHaveBeenNthCalledWith(1, {
      discoverNewSources: true,
      markKnownSourcesDirty: false
    });
    expect(runtime.getSnapshot().surfaces[surfaceId]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.markDirty).toHaveBeenCalledTimes(2);
    expect(adapter.markDirty).toHaveBeenNthCalledWith(2, {
      discoverNewSources: true,
      markKnownSourcesDirty: false
    });
    expect(runtime.getSnapshot().surfaces[surfaceId]).toEqual(
      expect.objectContaining({
        vendor: "codex",
        model: "gpt-5.4",
        todayTokens: 544
      })
    );

    runtime.shutdown();
  });

  it("backs off failed codex subscription refreshes instead of retrying on the live cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T11:00:00.000Z"));
    const state = createInitialState();
    const codexFetcher = vi.fn(async () => {
      throw new Error("codex subscription probes exhausted");
    });
    const codexAuthDetector = vi.fn(async () => true);

    const runtime = createUsageRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn(),
      adapters: [],
      emitSnapshot: vi.fn(),
      now: () => Date.now(),
      subscriptionFetchers: {
        codex: codexFetcher
      },
      subscriptionAuthDetectors: {
        codex: codexAuthDetector
      }
    });

    runtime.start();
    runtime.setDashboardOpen(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(codexFetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(codexFetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(codexFetcher).toHaveBeenCalledTimes(2);

    runtime.shutdown();
  });
});

function buildSample(
  overrides: Partial<UsageEventSample> = {}
): UsageEventSample {
  return {
    vendor: "claude",
    timestampMs: new Date("2026-04-17T11:00:00.000Z").getTime(),
    sourcePath: "/tmp/usage.jsonl",
    sourceType: "jsonl",
    sessionId: "claude-session",
    inputTokens: 100,
    outputTokens: 40,
    thinkingTokens: 0,
    cacheTokens: 0,
    totalTokens: 140,
    estimatedCostUsd: 0.4,
    ...overrides
  };
}

function createFakeUsageHistoryStore(days: unknown[]) {
  let state = days;
  return {
    load() {
      return state;
    },
    save(nextDays: unknown[]) {
      state = nextDays;
    }
  };
}
