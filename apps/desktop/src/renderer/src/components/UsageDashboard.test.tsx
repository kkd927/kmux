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

  it("aligns heatmap columns to Sunday-first weeks and omits future days in the current week", () => {
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot("2026-04-29", "2026-04-29T09:23:00.000Z"),
      dailyActivity: [
        {
          dayKey: "2026-04-19",
          totalCostUsd: 0,
          totalTokens: 100,
          activeSessionCount: 1,
          costSource: "reported"
        },
        {
          dayKey: "2026-04-29",
          totalCostUsd: 0,
          totalTokens: 200,
          activeSessionCount: 1,
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
