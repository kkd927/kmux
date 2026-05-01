// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

import { ExternalSessionsPanel } from "./ExternalSessionsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const APP_CSS = readFileSync(
  path.join(
    process.cwd(),
    "apps/desktop/src/renderer/src/styles/App.module.css"
  ),
  "utf8"
);

function createSnapshot(count = 31): ExternalAgentSessionsSnapshot {
  const vendors = [
    { vendor: "codex", vendorLabel: "CODEX" },
    { vendor: "gemini", vendorLabel: "GEMINI" },
    { vendor: "claude", vendorLabel: "CLAUDE" }
  ] as const;

  return {
    updatedAt: "2026-04-26T12:00:00.000Z",
    sessions: Array.from({ length: count }, (_, index) => {
      const vendor = vendors[index % vendors.length];
      const sessionNumber = index + 1;
      return {
        key: `${vendor.vendor}:session-${sessionNumber}`,
        vendor: vendor.vendor,
        vendorLabel: vendor.vendorLabel,
        title:
          index === 0
            ? "Fix terminal focus"
            : `${vendor.vendorLabel} Session ${String(sessionNumber).padStart(2, "0")}`,
        cwd: `/Users/test/project-${sessionNumber}`,
        updatedAt: "2026-04-26T11:00:00.000Z",
        relativeTimeLabel: `${sessionNumber}m`,
        canResume: true,
        resumeCommandPreview: `${vendor.vendor} resume session-${sessionNumber}`
      };
    })
  };
}

describe("ExternalSessionsPanel", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders TailAdmin table chrome around the original four session columns", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={createSnapshot()}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("Vendor");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Title");
    expect(container.textContent).toContain("Time");
    expect(container.textContent).not.toContain("Products");
    expect(container.textContent).not.toContain("Resume");
    expect(container.textContent).toContain("CODEX");
    expect(container.textContent).toContain("GEMINI");
    expect(container.textContent).toContain("CLAUDE");
    expect(container.textContent).toContain("project-1");
    expect(container.textContent).toContain("Fix terminal focus");
    expect(container.textContent).toContain("1m");
    expect(container.textContent).not.toContain("시간");
    expect(container.textContent).not.toContain("codex resume session-1");
    expect(container.textContent).not.toContain("CODEX Session 31");
    expect(sessionCountText(container)).toBe("(31)");
    expect(container.textContent).not.toContain("31 sessions");

    const allFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "ALL"
    );
    expect(allFilter?.getAttribute("aria-pressed")).toBe("true");

    const moreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Load more")
    );
    expect(moreButton).toBeTruthy();
    expect(moreButton?.textContent).toBe("Load more (11)");

    act(() => {
      moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Session 31");
  });

  it("filters sessions by agent and resets paging", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={createSnapshot(93)}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    const codexFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Codex"
    );
    expect(codexFilter).toBeTruthy();

    act(() => {
      codexFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(codexFilter?.getAttribute("aria-pressed")).toBe("true");
    expect(sessionCountText(container)).toBe("(31)");
    expect(container.textContent).not.toContain("31 sessions");
    expect(container.textContent).toContain("Fix terminal focus");
    expect(container.textContent).toContain("CODEX Session 31");
    expect(container.textContent).not.toContain("GEMINI Session 02");
    expect(container.textContent).not.toContain("CLAUDE Session 03");
    expect(container.textContent).not.toContain("CODEX Session 91");

    const moreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Load more")
    );
    expect(moreButton).toBeTruthy();
    expect(moreButton?.textContent).toBe("Load more (11)");

    act(() => {
      moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("CODEX Session 91");
    expect(container.textContent).not.toContain("Load more");

    const claudeFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Claude"
    );

    act(() => {
      claudeFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("CLAUDE Session 03");
    expect(container.textContent).not.toContain("CLAUDE Session 92");
  });

  it("only shows agent filters for vendors present in the session list", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-04-26T12:00:00.000Z",
            sessions: createSnapshot(2).sessions
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    expect(filterButtonLabels(container)).toEqual(["ALL", "Codex", "Gemini"]);

    const geminiFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Gemini"
    );

    act(() => {
      geminiFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(geminiFilter?.getAttribute("aria-pressed")).toBe("true");
    expect(sessionCountText(container)).toBe("(1)");
    expect(container.textContent).toContain("GEMINI Session 02");
    expect(container.textContent).not.toContain("Fix terminal focus");
    expect(container.textContent).not.toContain("Claude");
  });

  it("hides agent filter controls when one vendor has sessions", () => {
    const codexSessions = createSnapshot(7).sessions.filter(
      (session) => session.vendor === "codex"
    );

    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-04-26T12:00:00.000Z",
            sessions: codexSessions
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    expect(
      container.querySelector('[aria-label="Filter sessions by agent"]')
    ).toBeNull();
    expect(sessionCountText(container)).toBe("(3)");
    expect(container.textContent).toContain("CODEX Session 07");
  });

  it("falls back to all sessions when the selected vendor disappears", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-04-26T12:00:00.000Z",
            sessions: createSnapshot(2).sessions
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    const geminiFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Gemini"
    );

    act(() => {
      geminiFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(sessionCountText(container)).toBe("(1)");
    expect(container.textContent).toContain("GEMINI Session 02");

    const codexSessions = createSnapshot(4).sessions.filter(
      (session) => session.vendor === "codex"
    );

    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-04-26T12:01:00.000Z",
            sessions: codexSessions
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    expect(sessionCountText(container)).toBe("(2)");
    expect(container.textContent).toContain("Fix terminal focus");
    expect(container.textContent).toContain("CODEX Session 04");
    expect(container.textContent).not.toContain("No Gemini sessions found.");
  });

  it("keeps the sessions header controls on one row and constrains the table to the sidebar width", () => {
    expect(cssRule(".rightSidebar")).toContain(
      "flex: 0 0 var(--right-sidebar-width)"
    );
    expect(cssRule(".rightSidebar")).toContain("--right-sidebar-width: 370px");
    expect(cssRule(".rightSidebar")).toContain(
      "width: var(--right-sidebar-width)"
    );
    expect(cssRule(".rightSidebar")).toContain(
      "--right-sidebar-content-padding: 12px"
    );
    expect(cssRule(".rightSidebarBody")).toContain(
      "padding: var(--right-sidebar-content-padding)"
    );
    expect(cssRule(".externalSessionsPanel")).toContain("margin: 0");
    expect(cssRule(".usageDashboard")).toContain("padding: 0");
    expect(cssRule(".externalSessionsHeader")).toContain(
      "flex-direction: row"
    );
    expect(cssRule(".externalSessionsActions")).toContain("flex-wrap: nowrap");
    expect(cssRule(".externalSessionsActions")).toContain("flex: 0 0 auto");
    expect(cssRule(".externalSessionsTableWrap")).toContain(
      "overflow-x: hidden"
    );
    expect(cssRule(".externalSessionsTable")).toContain("table-layout: fixed");
    expect(cssRule(".externalSessionsTable")).not.toContain("min-width:");
    expect(cssRule(".externalSessionsTableHead th")).toContain(
      "padding: 10px 2px"
    );
    expect(cssRule(".externalSessionsTableHead th:first-child")).toContain(
      "padding-left: 6px"
    );
    expect(cssRule(".externalSessionsTableHead th:last-child")).toContain(
      "padding-right: 6px"
    );
    expect(cssRule(".externalSessionsTableHead th:nth-child(1)")).toContain(
      "width: 42px"
    );
    expect(cssRule(".externalSessionsTableHead th:nth-child(2)")).toContain(
      "width: 60px"
    );
    expect(cssRule(".externalSessionsTableHead th:nth-child(4)")).toContain(
      "width: 38px"
    );
    expect(cssRule(".externalSessionsFilterGroup")).toContain(
      "height: var(--external-sessions-control-height)"
    );
    expect(cssRule(".externalSessionsFilterGroup")).toContain(
      "flex: 0 0 auto"
    );
    expect(cssRule(".externalSessionsFilterGroup")).toContain(
      "width: max-content"
    );
    expect(cssRule(".externalSessionsFilterGroup")).not.toContain("216px");
    expect(cssRule(".externalSessionsFilterButton")).toContain(
      "flex: 0 0 var(--external-sessions-filter-button-width)"
    );
    expect(cssRule(".externalSessionsFilterButton")).toContain(
      "width: var(--external-sessions-filter-button-width)"
    );
    expect(cssRule(".externalSessionsDescription")).toContain(
      "white-space: nowrap"
    );
    expect(cssRule(".externalSessionsRefreshButton")).toContain(
      "min-height: var(--external-sessions-control-height)"
    );
    expect(cssRule(".externalSessionTitleCell")).toContain(
      "overflow: hidden"
    );
    expect(cssRule(".externalSessionCell")).toContain("padding: 11px 2px");
    expect(cssRule(".externalSessionRow td:first-child")).toContain(
      "padding-left: 6px"
    );
    expect(cssRule(".externalSessionRow td:last-child")).toContain(
      "padding-right: 6px"
    );
    expect(cssRule(".externalSessionTitle")).toContain("display: block");
    expect(cssRule(".externalSessionTitle")).toContain("max-width: 100%");
    expect(cssRule(".externalSessionVendor")).toContain(
      "display: inline-block"
    );
    expect(cssRule(".externalSessionVendor")).not.toContain("background:");
    expect(cssRule(".externalSessionVendor")).not.toContain("border:");
    expect(cssRule(".externalSessionVendor::before")).toBe("");
  });

  it("routes refresh and resumable row activation through the provided callbacks", () => {
    const onResume = vi.fn();
    const onRefresh = vi.fn();
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={createSnapshot(1)}
          loading={false}
          error={null}
          onRefresh={onRefresh}
          onResume={onResume}
        />
      );
    });

    const refreshButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh sessions"]'
    );
    expect(refreshButton).toBeTruthy();
    expect(refreshButton?.querySelector("svg")).not.toBeNull();

    act(() => {
      refreshButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);

    const row = container.querySelector(
      '[data-testid="external-session-row"]'
    );
    expect(row).toBeTruthy();

    act(() => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onResume).toHaveBeenCalledWith("codex:session-1");

    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(onResume).toHaveBeenCalledTimes(2);

    const title = container.querySelector(
      '[data-testid="external-session-title"]'
    );
    expect(title?.getAttribute("title")).toBe("Fix terminal focus");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = APP_CSS.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function sessionCountText(container: HTMLElement): string | null {
  return container.querySelector("p")?.textContent ?? null;
}

function filterButtonLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(
      '[aria-label="Filter sessions by agent"] button'
    )
  ).map((button) => button.textContent ?? "");
}
