// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SshConnectionsSnapshot,
  SshProfileDto,
  SshProfileVm
} from "@kmux/proto";

import { SshConnectionsSettings } from "./SshConnectionsSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CREATED_AT = "2026-07-29T00:00:00.000Z";

describe("SSH connections settings loading", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let previousKmux: typeof window.kmux;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    previousKmux = window.kmux;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.kmux = previousKmux;
  });

  it("renders local profiles and enables New connection while route resolution is pending", async () => {
    const profile = sshProfile("profile_1", "Development", "dev.example.com");
    const resolution = deferred<SshProfileVm | null>();
    installKmux({
      getSshConnections: vi.fn(async () => snapshot(profile)),
      resolveSshProfile: vi.fn(async () => resolution.promise)
    });

    await renderSettings(root);

    expect(container.textContent).toContain("Development");
    expect(button("New connection").disabled).toBe(false);
    expect(window.kmux.resolveSshProfile).toHaveBeenCalledWith("profile_1");
  });

  it("selects the saved profile and re-enables actions without waiting for background resolution", async () => {
    const before = sshProfile("profile_1", "Development", "dev.example.com");
    const after = {
      ...before,
      updatedAt: "2026-07-29T00:00:01.000Z"
    };
    const getSshConnections = vi
      .fn()
      .mockResolvedValueOnce(snapshot(before))
      .mockResolvedValueOnce(snapshot(after));
    installKmux({
      getSshConnections,
      resolveSshProfile: vi.fn(
        async () => new Promise<SshProfileVm | null>(() => undefined)
      ),
      saveSshProfile: vi.fn(async () => after)
    });
    await renderSettings(root);

    act(() => button("Edit profile").click());
    await act(async () => {
      button("Save connection").click();
      await flushUi();
    });

    expect(window.kmux.saveSshProfile).toHaveBeenCalledOnce();
    expect(getSshConnections).toHaveBeenCalledTimes(2);
    expect(button("New connection").disabled).toBe(false);
    expect(
      container.querySelector("[role='option'][aria-selected='true']")
        ?.textContent
    ).toContain("Development");
  });

  it("does not let an older route result overwrite a profile saved while it was resolving", async () => {
    const before = sshProfile("profile_1", "Before", "before.example.com");
    const after = sshProfile(
      "profile_1",
      "After",
      "after.example.com",
      "2026-07-29T00:00:01.000Z"
    );
    const oldResolution = deferred<SshProfileVm | null>();
    const newResolution = deferred<SshProfileVm | null>();
    installKmux({
      getSshConnections: vi
        .fn()
        .mockResolvedValueOnce(snapshot(before))
        .mockResolvedValueOnce(snapshot(after)),
      resolveSshProfile: vi
        .fn()
        .mockImplementationOnce(async () => oldResolution.promise)
        .mockImplementationOnce(async () => newResolution.promise),
      saveSshProfile: vi.fn(async () => after)
    });
    await renderSettings(root);

    act(() => button("Edit profile").click());
    await act(async () => {
      button("Save connection").click();
      await flushUi();
    });
    oldResolution.resolve({
      ...before,
      effectiveConnection: {
        hostName: "stale.internal",
        user: "stale-user",
        port: 2200,
        identityFiles: [],
        policyHash: "a".repeat(64)
      }
    });
    await act(flushUi);

    expect(container.textContent).toContain("After");
    expect(container.textContent).toContain("after.example.com");
    expect(container.textContent).not.toContain("stale.internal");
    expect(container.textContent).not.toContain("stale-user");
  });

  it("replaces a failed local listing with an explicit Retry state", async () => {
    const profile = sshProfile(
      "profile_1",
      "Recovered",
      "recovered.example.com"
    );
    const getSshConnections = vi
      .fn()
      .mockRejectedValueOnce(new Error("profile store unavailable"))
      .mockResolvedValueOnce(snapshot(profile));
    installKmux({
      getSshConnections,
      resolveSshProfile: vi.fn(
        async () => new Promise<SshProfileVm | null>(() => undefined)
      )
    });
    await renderSettings(root);

    expect(container.textContent).toContain("Connections unavailable");
    expect(container.textContent).not.toContain("Loading connections…");
    await act(async () => {
      button("Retry").click();
      await flushUi();
    });

    expect(container.textContent).toContain("Recovered");
    expect(getSshConnections).toHaveBeenCalledTimes(2);
  });

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label)
    );
    if (!(match instanceof HTMLButtonElement)) {
      throw new Error(`button ${label} was not rendered`);
    }
    return match;
  }
});

async function renderSettings(root: ReactDOMClient.Root): Promise<void> {
  await act(async () => {
    root.render(<SshConnectionsSettings />);
    await flushUi();
  });
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installKmux(overrides: {
  getSshConnections: typeof window.kmux.getSshConnections;
  resolveSshProfile: typeof window.kmux.resolveSshProfile;
  saveSshProfile?: typeof window.kmux.saveSshProfile;
}): void {
  window.kmux = {
    ...window.kmux,
    getSshConnections: overrides.getSshConnections,
    resolveSshProfile: overrides.resolveSshProfile,
    saveSshProfile:
      overrides.saveSshProfile ??
      vi.fn(async (request) => ({
        id: request.id ?? "profile_saved",
        ...request.profile,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      })),
    getRetainedRemoteSessions: vi.fn(async () => ({
      sessions: [],
      updatedAt: CREATED_AT
    })),
    listSshConfigAliases: vi.fn(async () => [])
  };
}

function sshProfile(
  id: string,
  name: string,
  host: string,
  updatedAt = CREATED_AT
): SshProfileDto {
  return {
    id,
    name,
    host,
    createdAt: CREATED_AT,
    updatedAt
  };
}

function snapshot(profile: SshProfileDto): SshConnectionsSnapshot {
  return {
    profiles: [profile],
    updatedAt: profile.updatedAt
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
