import {
  applyAction,
  createInitialState,
  encodeLocatedPathDto,
  locatedPathForTarget
} from "@kmux/core";
import { describe, expect, it, vi } from "vitest";

import type { ExternalSessionResumeSpec } from "./externalSessions";
import {
  createLocalHistoryProvider,
  createTargetHistoryRuntime
} from "./targetHistoryRuntime";
import type {
  LocatedTargetServiceSet,
  TargetServiceRegistry
} from "./targets/contracts";

describe("target history runtime", () => {
  it("keeps identical vendor sessions distinct by target and resumes remotely", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    const localHistory = vi.fn(async () => [
      {
        vendor: "codex" as const,
        sessionId: "same-session",
        updatedAtUnixMs: 1_000,
        canResume: true,
        cwd: locatedPathForTarget({ kind: "local" }, "/tmp/local")
      }
    ]);
    const remoteHistory = vi.fn(async () => [
      {
        vendor: "codex" as const,
        sessionId: "same-session",
        updatedAtUnixMs: 2_000,
        canResume: true,
        cwd: locatedPathForTarget(
          { kind: "ssh", targetId: "target_1" },
          "/srv/repo"
        ),
        principal: { uid: 1_000, accountName: "kmux" }
      }
    ]);
    const registry = registryWithHistory(localHistory, remoteHistory);
    const localFallback: ExternalSessionResumeSpec = {
      key: "codex:same-session",
      target: { kind: "local" },
      vendor: "codex",
      agentSessionRef: {
        vendor: "codex",
        externalKey: "codex:same-session",
        sessionId: "same-session"
      },
      title: "local",
      cwd: "/tmp/local",
      launch: { cwd: "/tmp/local" }
    };
    const runtime = createTargetHistoryRuntime({
      targetServices: registry,
      getState: () => state,
      localIndexer: {
        listExternalAgentSessions: vi.fn(),
        resolveExternalAgentSession: (key: string) =>
          key === localFallback.key ? localFallback : null
      } as never,
      now: () => new Date(10_000)
    });

    const snapshot = await runtime.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions.map((session) => session.key)).toEqual([
      "ssh:target_1:codex:same-session",
      "codex:same-session"
    ]);
    expect(snapshot.sessions[0]).toMatchObject({
      target: {
        kind: "ssh",
        targetId: "target_1",
        principal: { uid: 1_000, accountName: "kmux" }
      },
      cwd: "/srv/repo",
      resumeCommandPreview: "codex resume same-session"
    });
    expect(
      runtime.resolveExternalAgentSession(snapshot.sessions[0].key)
    ).toMatchObject({
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo",
      launch: {
        cwd: "/srv/repo",
        initialInput: "codex resume same-session\r"
      }
    });
    expect(
      runtime.resolveExternalAgentSession(localFallback.key)
    ).toMatchObject({
      target: { kind: "local" },
      cwd: "/tmp/local",
      agentSessionRef: { sessionId: "same-session" }
    });
  });

  it("retains a target cache and reports typed unavailability without local fallback", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    let failRemote = false;
    const remoteHistory = vi.fn(async () => {
      if (failRemote) throw new Error("metadata channel unavailable");
      return [
        {
          vendor: "claude" as const,
          sessionId: "remote-only",
          updatedAtUnixMs: 2_000,
          canResume: true,
          principal: { uid: 1_000, accountName: "kmux" }
        }
      ];
    });
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(
        vi.fn(async () => []),
        remoteHistory
      ),
      getState: () => state,
      localIndexer: {
        resolveExternalAgentSession: () => null
      } as never,
      now: () => new Date(10_000)
    });
    await runtime.listExternalAgentSessions();
    failRemote = true;

    const degraded = await runtime.listExternalAgentSessions();

    expect(degraded.sessions.map((session) => session.key)).toEqual([
      "ssh:target_1:claude:remote-only"
    ]);
    expect(degraded.unavailableTargets).toEqual([
      {
        kind: "ssh",
        targetId: "target_1",
        message: "metadata channel unavailable"
      }
    ]);
  });

  it("degrades one target instead of rejecting the snapshot when principal identity is missing", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(
        vi.fn(async () => []),
        vi.fn(async () => [
          {
            vendor: "codex" as const,
            sessionId: "unscoped",
            updatedAtUnixMs: 2_000,
            canResume: true
          }
        ])
      ),
      getState: () => state,
      localIndexer: { resolveExternalAgentSession: () => null } as never,
      now: () => new Date(10_000)
    });

    await expect(runtime.listExternalAgentSessions()).resolves.toEqual({
      sessions: [],
      updatedAt: "1970-01-01T00:00:10.000Z",
      unavailableTargets: [
        {
          kind: "ssh",
          targetId: "target_1",
          message: "remote history record lacks its authenticated principal"
        }
      ]
    });
  });

  it("does not reinsert a target removed while its history scan is in flight", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    const remoteHistory = vi.fn(async () => {
      const remoteWorkspace = Object.values(state.workspaces).find(
        (workspace) => workspace.location.target.kind === "ssh"
      );
      if (remoteWorkspace) delete state.workspaces[remoteWorkspace.id];
      return [
        {
          vendor: "codex" as const,
          sessionId: "removed-target-session",
          updatedAtUnixMs: 2_000,
          canResume: true,
          principal: { uid: 1_000, accountName: "kmux" }
        }
      ];
    });
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(
        vi.fn(async () => []),
        remoteHistory
      ),
      getState: () => state,
      localIndexer: { resolveExternalAgentSession: () => null } as never,
      now: () => new Date(10_000)
    });

    await expect(runtime.listExternalAgentSessions()).resolves.toEqual({
      sessions: [],
      updatedAt: "1970-01-01T00:00:10.000Z"
    });
    expect(
      runtime.resolveExternalAgentSession(
        "ssh:target_1:codex:removed-target-session"
      )
    ).toBeNull();
  });
});

describe("local history provider", () => {
  it("refreshes target-local usage and normalizes the existing local index", async () => {
    const refreshUsage = vi.fn(async () => undefined);
    const provider = createLocalHistoryProvider({
      refreshUsage,
      indexer: {
        listExternalAgentSessions: () => ({
          updatedAt: "2026-07-18T00:00:00.000Z",
          sessions: [
            {
              key: "codex:session-1",
              target: { kind: "local" },
              vendor: "codex",
              vendorLabel: "CODEX",
              title: "Local session",
              cwd: "/tmp/repo",
              updatedAt: "2026-07-17T23:00:00.000Z",
              relativeTimeLabel: "1h",
              canResume: true,
              resumeCommandPreview: "codex resume session-1"
            }
          ]
        }),
        resolveExternalAgentSession: () => null
      }
    });

    const records = await provider.refresh({ maxRecords: 10 });

    expect(refreshUsage).toHaveBeenCalledOnce();
    expect(records).toMatchObject([
      {
        vendor: "codex",
        sessionId: "session-1",
        canResume: true,
        title: "Local session"
      }
    ]);
  });
});

function registryWithHistory(
  localRefresh: LocatedTargetServiceSet["history"]["refresh"],
  remoteRefresh: LocatedTargetServiceSet["history"]["refresh"]
): TargetServiceRegistry {
  const services = (
    refresh: LocatedTargetServiceSet["history"]["refresh"]
  ): LocatedTargetServiceSet =>
    ({
      history: { refresh },
      files: {
        display: (
          path: Parameters<LocatedTargetServiceSet["files"]["display"]>[0]
        ) => encodeLocatedPathDto(path).path
      }
    }) as LocatedTargetServiceSet;
  return {
    resolve: vi.fn(),
    resolveLocated: (target) =>
      target.kind === "local" ? services(localRefresh) : services(remoteRefresh)
  } as TargetServiceRegistry;
}
