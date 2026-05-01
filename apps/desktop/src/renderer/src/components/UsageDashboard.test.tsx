// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const APP_CSS = readFileSync(
  path.join(
    process.cwd(),
    "apps/desktop/src/renderer/src/styles/App.module.css"
  ),
  "utf8"
);

describe("UsageDashboard", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    mockUseUsageSnapshot.mockReturnValue({
      ...createEmptyUsageViewSnapshot(
        "2026-04-27",
        "2026-04-27T09:23:00.000Z"
      ),
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
        <UsageDashboard
          embedded
          onJumpToSurface={() => undefined}
        />
      );
    });

    expect(container.textContent).toContain("Updated");
    expect(container.textContent).toContain(
      "includes estimated subscription spend"
    );
    expect(container.textContent).not.toContain("2026-04-27");
  });

  it("uses a VS Code-style text tab strip in the right panel", () => {
    expect(cssRule(".rightSidebar")).toContain(
      "border-top: 1px solid var(--border-strong)"
    );
    expect(cssRule(".rightSidebarTabBar")).toContain("display: flex");
    expect(cssRule(".rightSidebarTabBar")).toContain("height: 35px");
    expect(cssRule(".rightSidebarTabBar")).toContain("padding: 0 12px");
    expect(cssRule(".rightSidebarTabBar")).toContain(
      "background: var(--usage-panel-bg)"
    );
    expect(cssRule(".rightSidebarTabBarItem")).toContain(
      "border-bottom: 1px solid transparent"
    );
    expect(cssRule(".rightSidebarTabBarItem")).toContain("border-radius: 0");
    expect(cssRule(".rightSidebarTabBarItem")).toContain(
      "color: var(--usage-subtle)"
    );
    expect(cssRule(".rightSidebarTabBarItem")).toContain("font-size: 0.75rem");
    expect(cssRule(".rightSidebarTabBarItem")).toContain("min-height: 35px");
    expect(cssRule(".rightSidebarTabBarItem")).toContain(
      "text-transform: uppercase"
    );
    expect(cssRule('.rightSidebarTabBarItem[data-active="true"]')).toContain(
      "border-bottom-color: var(--usage-title)"
    );
    expect(cssRule('.rightSidebarTabBarItem[data-active="true"]')).not.toContain(
      "box-shadow"
    );
    expect(cssRule(".usageDashboardStatus")).toContain("min-height: 22px");
    expect(cssRule(".usageDashboardStatus")).toContain(
      "color: var(--usage-subtle)"
    );
    expect(
      cssRule('.rightSidebar[data-has-tabs="true"] .rightSidebarBody > .usageDashboard')
    ).toContain("margin-top: 0");
  });

  it("keeps the top usage summary cards compact in the right panel", () => {
    expect(cssRule(".usageMetricCard")).toContain("min-height: 83px");
    expect(cssRule(".usageMetricCard")).toContain("padding: 14px 20px 12px");
    expect(cssRule(".usageMetricBody")).toContain("gap: 8px");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = APP_CSS.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}
