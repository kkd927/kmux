// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

import {
  EXTERNAL_SESSIONS_REFRESH_MS,
  useExternalAgentSessions
} from "./useExternalAgentSessions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createSnapshot(
  title: string,
  updatedAt: string
): ExternalAgentSessionsSnapshot {
  return {
    updatedAt,
    sessions: [
      {
        key: `codex:${title}`,
        vendor: "codex",
        vendorLabel: "CODEX",
        title,
        cwd: "/Users/test/project",
        updatedAt,
        relativeTimeLabel: "now",
        canResume: true,
        resumeCommandPreview: `codex resume ${title}`
      }
    ]
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function ExternalSessionsHarness(): JSX.Element {
  const { snapshot, loading, error } = useExternalAgentSessions();
  return (
    <div>
      <span data-testid="loading">{loading ? "loading" : "idle"}</span>
      <span data-testid="error">{error ?? ""}</span>
      <span data-testid="title">{snapshot.sessions[0]?.title ?? ""}</span>
    </div>
  );
}

describe("useExternalAgentSessions", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    window.kmux = {
      ...window.kmux,
      getExternalAgentSessions: vi
        .fn<() => Promise<ExternalAgentSessionsSnapshot>>()
        .mockResolvedValueOnce(
          createSnapshot("initial-session", "2026-04-26T12:00:00.000Z")
        )
        .mockResolvedValueOnce(
          createSnapshot("resynced-session", "2026-04-26T12:01:00.000Z")
        )
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("periodically refreshes mounted external sessions without a file watch event", async () => {
    await act(async () => {
      root.render(<ExternalSessionsHarness />);
      await flushPromises();
    });

    expect(container.textContent).toContain("initial-session");
    expect(container.textContent).toContain("idle");

    await act(async () => {
      vi.advanceTimersByTime(EXTERNAL_SESSIONS_REFRESH_MS);
      await flushPromises();
    });

    expect(window.kmux.getExternalAgentSessions).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("resynced-session");
    expect(container.textContent).toContain("idle");
  });

  it("stops periodic refreshes after unmount", async () => {
    await act(async () => {
      root.render(<ExternalSessionsHarness />);
      await flushPromises();
    });
    act(() => {
      root.unmount();
    });

    await act(async () => {
      vi.advanceTimersByTime(EXTERNAL_SESSIONS_REFRESH_MS);
      await flushPromises();
    });

    expect(window.kmux.getExternalAgentSessions).toHaveBeenCalledTimes(1);
  });
});
