// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyUsageViewSnapshot } from "@kmux/proto";
import type { UsageViewSnapshot } from "@kmux/proto";

const mockUseUsageSnapshot = vi.hoisted(() => vi.fn<() => UsageViewSnapshot>());

vi.mock("../hooks/useUsageView", () => ({
  useUsageSnapshot: mockUseUsageSnapshot
}));

import { UsageDashboard } from "./UsageDashboard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("UsageDashboard", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-04-27", "2026-04-27T09:23:00.000Z"),
      pricingCoverage: {
        fullyPriced: false,
        hasEstimatedCosts: true,
        hasMissingPricing: false,
        reportedCostUsd: 0,
        estimatedCostUsd: 1.25,
        unknownCostTokens: 0
      }
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    mockUseUsageSnapshot.mockReset();
  });

  it("keeps the updated and estimated spend subtitle visible without the day badge when embedded under tabs", () => {
    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    expect(container.textContent).toContain("Updated");
    expect(container.textContent).toContain(
      "includes estimated subscription spend"
    );
    expect(container.textContent).not.toContain("2026-04-27");
  });

  it("rounds visible usage spend up to cents", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      totalTodayCostUsd: 0.0045,
      totalTodayTokens: 1288,
      models: [
        {
          vendor: "antigravity",
          modelId: "gemini-3.5-flash",
          modelLabel: "gemini-3.5-flash",
          todayCostUsd: 0.0045,
          inputTokens: 1000,
          outputTokens: 288,
          cacheTokens: 0,
          totalTokens: 1288,
          costSource: "estimated"
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    expect(
      container.querySelector("[data-testid='usage-summary-card-spend']")
        ?.textContent
    ).toContain("$0.01");
    expect(
      container.querySelector(
        "[data-testid='usage-model-row-gemini-3.5-flash']"
      )?.textContent
    ).toContain("$0.01");
    expect(container.textContent).not.toContain("$0.0045");
  });

  it("shows unknown cost for partial top model rows with zero known cost", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      totalTodayTokens: 31,
      models: [
        {
          vendor: "claude",
          modelId: "claude-unpriced-5",
          modelLabel: "claude-unpriced-5",
          todayCostUsd: 0,
          inputTokens: 20,
          outputTokens: 11,
          cacheTokens: 0,
          totalTokens: 31,
          costSource: "partial"
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const row = container.querySelector<HTMLElement>(
      "[data-testid='usage-model-row-claude-unpriced-5']"
    );
    const cost = container.querySelector<HTMLElement>(
      "[data-testid='usage-model-cost-claude-unpriced-5']"
    );
    expect(row?.textContent).toContain("31");
    expect(cost?.textContent).toBe("—");
  });

  it("shows unknown cost for partial directory rows with zero known cost", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      totalTodayTokens: 31,
      directoryHotspots: [
        {
          directoryPath: "/tmp/kmux-unpriced",
          directoryLabel: "kmux-unpriced",
          todayCostUsd: 0,
          todayTokens: 31,
          costSource: "partial"
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const row = container.querySelector<HTMLElement>(
      "[data-testid='directory-hotspot-row-0']"
    );
    const cost = container.querySelector<HTMLElement>(
      "[data-testid='directory-hotspot-cost-0']"
    );
    expect(row?.textContent).toContain("31");
    expect(cost?.textContent).toBe("—");
  });

  it("renders unlimited Codex credits without a percentage meter", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-05-20", "2026-05-20T03:00:00.000Z"),
      subscriptionUsage: [
        {
          provider: "codex",
          providerLabel: "Codex",
          planLabel: "Business",
          source: "oauth",
          updatedAt: "2026-05-20T03:00:00.000Z",
          rows: [
            {
              key: "credits",
              label: "Credits",
              valueKind: "unlimited",
              resetLabel: "No workspace spend limit",
              windowKind: "credits"
            }
          ]
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const row = container.querySelector<HTMLElement>(
      "[data-testid='subscription-row-codex-credits']"
    );
    expect(row?.textContent).toContain("Credits");
    expect(row?.textContent).toContain("Unlimited");
    expect(row?.textContent).toContain("No workspace spend limit");
    expect(row?.textContent).not.toContain("NaN%");
    expect(row?.querySelector(".usageInlineBarTrack")).toBeNull();
  });

  it("renders unlimited Antigravity quota without a percentage meter", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      subscriptionUsage: [
        {
          provider: "antigravity",
          providerLabel: "Antigravity",
          planLabel: "Business",
          source: "quota_summary_api",
          updatedAt: "2026-06-02T02:00:00.000Z",
          rows: [
            {
              key: "all-models",
              label: "All Models",
              valueKind: "unlimited",
              resetLabel: "No quota limit reported",
              windowKind: "credits"
            }
          ]
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const provider = container.querySelector<HTMLElement>(
      "[data-testid='subscription-provider-antigravity']"
    );
    const row = container.querySelector<HTMLElement>(
      "[data-testid='subscription-row-antigravity-all-models']"
    );
    expect(provider?.textContent).toContain("Antigravity Business");
    expect(row?.textContent).toContain("All Models");
    expect(row?.textContent).toContain("Unlimited");
    expect(row?.textContent).toContain("No quota limit reported");
    expect(row?.textContent).not.toContain("NaN%");
    expect(row?.querySelector(".usageInlineBarTrack")).toBeNull();
  });

  it("renders Antigravity subscription quota rows", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      subscriptionUsage: [
        {
          provider: "antigravity",
          providerLabel: "Antigravity",
          planLabel: "Google AI Pro",
          source: "quota_summary_api",
          updatedAt: "2026-06-02T02:00:00.000Z",
          rows: [
            {
              key: "gemini-weekly",
              label: "Gemini Models · Weekly Limit",
              valueKind: "percent",
              usedPercent: 6,
              resetLabel: "Resets in 13h 0m",
              resetsAt: "2026-06-02T15:00:00.000Z",
              windowKind: "weekly"
            }
          ]
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const provider = container.querySelector<HTMLElement>(
      "[data-testid='subscription-provider-antigravity']"
    );
    const row = container.querySelector<HTMLElement>(
      "[data-testid='subscription-row-antigravity-gemini-weekly']"
    );
    expect(provider?.textContent).toContain("Antigravity Google AI Pro");
    expect(row?.textContent).toContain("Gemini Models · Weekly Limit");
    expect(row?.textContent).toContain("6%");
  });

  it("shows token mix costs as plain values when only some samples have unknown component pricing", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-06-02", "2026-06-02T02:00:00.000Z"),
      totalTodayCostUsd: 181.48,
      totalTodayTokens: 214_067_512,
      todayTokenBreakdown: {
        inputTokens: 2_773_238,
        outputTokens: 1_900_758,
        cacheReadTokens: 202_076_526,
        cacheWriteTokens: 7_212_712,
        thinkingTokens: 104_278,
        totalTokens: 214_067_512
      },
      todayTokenCostBreakdown: {
        inputCostUsd: 6.93,
        outputCostUsd: 45.08,
        cacheReadCostUsd: 83.34,
        cacheWriteCostUsd: 44.53,
        thinkingCostUsd: 1.56,
        hasUnknownInputCost: false,
        hasUnknownOutputCost: true,
        hasUnknownCacheReadCost: true,
        hasUnknownCacheWriteCost: true,
        hasUnknownThinkingCost: false
      }
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    expect(
      container.querySelector<HTMLElement>(
        "[data-testid='token-mix-cost-output']"
      )?.textContent
    ).toBe("$45.08");
    expect(
      container.querySelector<HTMLElement>(
        "[data-testid='token-mix-cost-cache-read']"
      )?.textContent
    ).toBe("$83.34");
    expect(
      container.querySelector<HTMLElement>(
        "[data-testid='token-mix-cost-cache-create']"
      )?.textContent
    ).toBe("$44.53");
  });

  it("aligns heatmap columns to Sunday-first weeks and omits future days in the current week", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-04-29", "2026-04-29T09:23:00.000Z"),
      dailyActivity: [
        {
          dayKey: "2026-04-19",
          totalCostUsd: 0,
          totalTokens: 100,
          costSource: "reported"
        },
        {
          dayKey: "2026-04-29",
          totalCostUsd: 0,
          totalTokens: 200,
          costSource: "reported"
        }
      ]
    });

    act(() => {
      root.render(
        <UsageDashboard embedded onJumpToSurface={() => undefined} />
      );
    });

    const cells = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-testid='usage-heatmap-cell']"
      )
    );
    const columns = Array.from(
      new Set(cells.map((cell) => cell.parentElement).filter(Boolean))
    ) as HTMLElement[];
    const completeWeekColumn = columns.find((column) =>
      Array.from(column.children).some(
        (cell) => (cell as HTMLElement).dataset.dayKey === "2026-04-19"
      )
    );

    expect(
      Array.from(completeWeekColumn?.children ?? []).map(
        (cell) => (cell as HTMLElement).dataset.dayKey
      )
    ).toEqual([
      "2026-04-19",
      "2026-04-20",
      "2026-04-21",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
      "2026-04-25"
    ]);

    const currentWeekColumn = columns.at(-1);
    expect(
      Array.from(currentWeekColumn?.children ?? []).map(
        (cell) => (cell as HTMLElement).dataset.dayKey
      )
    ).toEqual(["2026-04-26", "2026-04-27", "2026-04-28", "2026-04-29"]);
  });
});
