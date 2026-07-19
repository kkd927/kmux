// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

import { ExternalSessionsPanel } from "./ExternalSessionsPanel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createSnapshot(count = 31): ExternalAgentSessionsSnapshot {
  const vendors = [
    { vendor: "codex", vendorLabel: "CODEX" },
    { vendor: "claude", vendorLabel: "CLAUDE" },
    { vendor: "antigravity", vendorLabel: "AGY" }
  ] as const;

  return {
    updatedAt: "2026-04-26T12:00:00.000Z",
    sessions: Array.from({ length: count }, (_, index) => {
      const vendor = vendors[index % vendors.length];
      const sessionNumber = index + 1;
      return {
        key: `${vendor.vendor}:session-${sessionNumber}`,
        target: { kind: "local" as const },
        vendor: vendor.vendor,
        vendorLabel: vendor.vendorLabel,
        title:
          index === 0
            ? "Fix terminal focus"
            : `${vendor.vendorLabel} Session ${String(sessionNumber).padStart(2, "0")}`,
        recentConversation:
          index === 0
            ? "Terminal focus remains stable across pane switches"
            : `Recent conversation ${sessionNumber}`,
        model:
          vendor.vendor === "codex"
            ? "gpt-5.4"
            : vendor.vendor === "claude"
              ? "claude-sonnet-4-5"
              : undefined,
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

  it("renders workspace-style three-line session rows", () => {
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
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("CODEX");
    expect(container.textContent).toContain("CLAUDE");
    expect(container.textContent).toContain("AGY");
    expect(container.textContent).toContain("Fix terminal focus");
    expect(container.textContent).toContain(
      "Terminal focus remains stable across pane switches"
    );
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).toContain("1m");
    expect(container.textContent).not.toContain("codex resume session-1");
    expect(container.textContent).not.toContain("CODEX Session 31");
    expect(sessionCountText(container)).toBe("(31)");
    expect(container.textContent).not.toContain("31 sessions");

    const filterTrigger = agentFilterTrigger(container);
    expect(filterTrigger?.getAttribute("aria-label")).toBe("Agent filter: All");
    expect(filterTrigger?.getAttribute("aria-expanded")).toBe("false");

    openAgentFilterMenu(container);

    expect(filterOptionKeys(container)).toEqual([
      "all",
      "codex",
      "claude",
      "antigravity"
    ]);
    expect(filterOptionText(container, "all")).toBe("All31");
    expect(filterOptionText(container, "codex")).toBe("Codex11");
    expect(filterOption(container, "all")?.getAttribute("aria-checked")).toBe(
      "true"
    );

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

  it("shows immutable target identity and target-local degradation", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-07-18T00:00:00.000Z",
            sessions: [
              {
                key: "ssh:target_1:codex:session-1",
                target: {
                  kind: "ssh",
                  targetId: "target_1",
                  principal: { uid: 1_000, accountName: "kmux" }
                },
                vendor: "codex",
                vendorLabel: "CODEX",
                title: "Remote session",
                relativeTimeLabel: "1m",
                canResume: true,
                resumeCommandPreview: "codex resume session-1"
              }
            ],
            unavailableTargets: [
              {
                kind: "ssh",
                targetId: "target_2",
                message: "metadata channel unavailable"
              }
            ]
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    expect(container.textContent).toContain("kmux@target_1");
    expect(
      container
        .querySelector("[data-testid='external-session-row']")
        ?.getAttribute("aria-label")
    ).toContain("on kmux@target_1");
    expect(
      container.querySelector(
        "[data-testid='external-sessions-target-unavailable']"
      )?.textContent
    ).toContain("SSH target_2 history unavailable");
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

    selectAgentFilter(container, "codex");

    expect(agentFilterTrigger(container)?.getAttribute("aria-label")).toBe(
      "Agent filter: Codex"
    );
    expect(sessionCountText(container)).toBe("(31)");
    expect(container.textContent).not.toContain("31 sessions");
    expect(container.textContent).toContain("Fix terminal focus");
    expect(container.textContent).toContain("CODEX Session 31");
    expect(container.textContent).not.toContain("CLAUDE Session 02");
    expect(container.textContent).not.toContain("AGY Session 03");
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

    selectAgentFilter(container, "claude");

    expect(container.textContent).toContain("CLAUDE Session 02");
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

    openAgentFilterMenu(container);

    expect(filterOptionKeys(container)).toEqual(["all", "codex", "claude"]);
    expect(filterOptionText(container, "claude")).toBe("Claude1");

    selectAgentFilter(container, "claude");

    expect(agentFilterTrigger(container)?.getAttribute("aria-label")).toBe(
      "Agent filter: Claude"
    );
    expect(sessionCountText(container)).toBe("(1)");
    expect(container.textContent).toContain("CLAUDE Session 02");
    expect(container.textContent).not.toContain("Fix terminal focus");
    expect(container.textContent).not.toContain("AGY");
  });

  it("filters Antigravity sessions with the AGY compact label", () => {
    act(() => {
      root.render(
        <ExternalSessionsPanel
          snapshot={{
            updatedAt: "2026-06-02T02:30:00.000Z",
            sessions: [
              {
                key: "codex:session-1",
                target: { kind: "local" },
                vendor: "codex",
                vendorLabel: "CODEX",
                title: "Codex session",
                cwd: "/Users/test/codex",
                updatedAt: "2026-06-02T02:00:00.000Z",
                relativeTimeLabel: "30m",
                canResume: true,
                resumeCommandPreview: "codex resume session-1"
              },
              {
                key: "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
                target: { kind: "local" },
                vendor: "antigravity",
                vendorLabel: "AGY",
                title: "Antigravity 9a8b7c6",
                cwd: "/Users/test/antigravity",
                updatedAt: "2026-06-02T02:05:00.000Z",
                relativeTimeLabel: "25m",
                canResume: true,
                resumeCommandPreview:
                  "agy --conversation 9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
              }
            ]
          }}
          loading={false}
          error={null}
          onRefresh={() => undefined}
          onResume={() => undefined}
        />
      );
    });

    openAgentFilterMenu(container);

    expect(filterOptionKeys(container)).toEqual([
      "all",
      "codex",
      "antigravity"
    ]);
    expect(filterOptionText(container, "antigravity")).toBe("Antigravity1");

    selectAgentFilter(container, "antigravity");

    expect(sessionCountText(container)).toBe("(1)");
    expect(container.textContent).toContain("AGY");
    expect(container.textContent).toContain("Antigravity 9a8b7c6");
    expect(container.textContent).not.toContain("Codex session");
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

    selectAgentFilter(container, "claude");

    expect(sessionCountText(container)).toBe("(1)");
    expect(container.textContent).toContain("CLAUDE Session 02");

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
    expect(container.textContent).not.toContain("No Claude sessions found.");
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

    const row = container.querySelector('[data-testid="external-session-row"]');
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

function sessionCountText(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-testid="external-sessions-count"]')
      ?.textContent ?? null
  );
}

function agentFilterTrigger(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]'
  );
}

function openAgentFilterMenu(container: HTMLElement): void {
  const trigger = agentFilterTrigger(container);
  expect(trigger).toBeTruthy();

  act(() => {
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function selectAgentFilter(container: HTMLElement, key: string): void {
  if (agentFilterTrigger(container)?.getAttribute("aria-expanded") !== "true") {
    openAgentFilterMenu(container);
  }

  const option = filterOption(container, key);
  expect(option).toBeTruthy();

  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function filterOption(
  container: HTMLElement,
  key: string
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `[role="menuitemradio"][data-filter-key="${key}"]`
  );
}

function filterOptionKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="menuitemradio"]')).map(
    (button) => button.getAttribute("data-filter-key") ?? ""
  );
}

function filterOptionText(container: HTMLElement, key: string): string | null {
  return filterOption(container, key)?.textContent ?? null;
}
