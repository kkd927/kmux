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
    state.settings.agents = {
      codex: { command: "local-codex" },
      ssh: {
        codex: { command: "ccsxp", args: ["remote profile"] }
      }
    };
    const localHistory = vi.fn(async () => ({
      truncated: false,
      records: [
        {
          vendor: "codex" as const,
          sessionId: "same-session",
          updatedAtUnixMs: 1_000,
          canResume: true,
          cwd: locatedPathForTarget({ kind: "local" }, "/tmp/local")
        }
      ]
    }));
    const remoteHistory = vi.fn(async () => ({
      truncated: false,
      records: [
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
      ]
    }));
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
      localAgentSettings: {
        codex: { command: "local-codex" }
      },
      sshAgentSettings: state.settings.agents.ssh,
      now: () => new Date(10_000)
    });
    state.settings.agents = {
      codex: { command: "changed-local-codex" },
      ssh: {
        codex: { command: "changed-remote-codex" }
      }
    };

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
      resumeCommandPreview: "ccsxp 'remote profile' resume same-session"
    });
    expect(
      runtime.resolveExternalAgentSession(snapshot.sessions[0].key)
    ).toMatchObject({
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo",
      launch: {
        cwd: "/srv/repo",
        initialInput: "ccsxp 'remote profile' resume same-session\r"
      }
    });
    expect(localHistory).toHaveBeenCalledWith({
      maxRecords: 100,
      agentSettings: {
        codex: { command: "local-codex" }
      }
    });
    expect(remoteHistory).toHaveBeenCalledWith({
      maxRecords: 100,
      agentSettings: {
        codex: { command: "ccsxp", args: ["remote profile"] }
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

  it("marks the merged snapshot partial when the final record limit is applied", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    const localHistory = vi.fn(async () => ({
      truncated: false,
      records: Array.from({ length: 60 }, (_, index) => ({
        vendor: "codex" as const,
        sessionId: `local-${index}`,
        updatedAtUnixMs: 1_000 + index,
        canResume: true
      }))
    }));
    const remoteHistory = vi.fn(async () => ({
      truncated: false,
      records: Array.from({ length: 60 }, (_, index) => ({
        vendor: "claude" as const,
        sessionId: `remote-${index}`,
        updatedAtUnixMs: 2_000 + index,
        canResume: true,
        principal: { uid: 1_000, accountName: "kmux" }
      }))
    }));
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(localHistory, remoteHistory),
      getState: () => state,
      localIndexer: { resolveExternalAgentSession: () => null } as never,
      now: () => new Date(10_000)
    });

    const snapshot = await runtime.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(100);
    expect(snapshot.truncated).toBe(true);
  });

  it("omits an unavailable target and clears its cached resume entries", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    let failRemote = false;
    const remoteHistory = vi.fn(async () => {
      if (failRemote) throw new Error("metadata channel unavailable");
      return {
        truncated: false,
        records: [
          {
            vendor: "claude" as const,
            sessionId: "remote-only",
            updatedAtUnixMs: 2_000,
            canResume: true,
            principal: { uid: 1_000, accountName: "kmux" }
          }
        ]
      };
    });
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(emptyHistoryRefresh(), remoteHistory),
      getState: () => state,
      localIndexer: {
        resolveExternalAgentSession: () => null
      } as never,
      now: () => new Date(10_000)
    });
    await runtime.listExternalAgentSessions();
    failRemote = true;

    const degraded = await runtime.listExternalAgentSessions();

    expect(degraded.sessions).toEqual([]);
    expect(
      runtime.resolveExternalAgentSession("ssh:target_1:claude:remote-only")
    ).toBeNull();
  });

  it("merges partial history, replaces it on a full scan, and clears it on failure", async () => {
    const state = createInitialState("/bin/zsh");
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/repo"
    });
    const remoteWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    let mode: "initial-partial" | "partial" | "full" | "failed" =
      "initial-partial";
    const remoteHistory = vi.fn(async () => {
      if (mode === "failed") {
        throw new Error("history unavailable");
      }
      return {
        truncated: mode !== "full",
        records: [
          {
            vendor: "codex" as const,
            sessionId: "current",
            updatedAtUnixMs: mode === "initial-partial" ? 2_000 : 3_000,
            canResume: true,
            principal: { uid: 1_000, accountName: "kmux" }
          },
          ...(mode === "initial-partial"
            ? [
                {
                  vendor: "claude" as const,
                  sessionId: "stale",
                  updatedAtUnixMs: 1_000,
                  canResume: true,
                  principal: { uid: 1_000, accountName: "kmux" }
                }
              ]
            : [])
        ]
      };
    });
    const reportError = vi.fn();
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(emptyHistoryRefresh(), remoteHistory),
      getState: () => state,
      localIndexer: { resolveExternalAgentSession: () => null } as never,
      now: () => new Date(10_000),
      reportError
    });

    const initialPartial = await runtime.listExternalAgentSessions();
    expect(initialPartial.sessions.map((session) => session.key)).toEqual([
      "ssh:target_1:codex:current",
      "ssh:target_1:claude:stale"
    ]);
    expect(initialPartial.truncated).toBe(true);

    mode = "partial";
    const nextPartial = await runtime.listExternalAgentSessions();
    expect(nextPartial.sessions.map((session) => session.key)).toEqual([
      "ssh:target_1:codex:current",
      "ssh:target_1:claude:stale"
    ]);
    expect(nextPartial.truncated).toBe(true);
    expect(reportError).not.toHaveBeenCalled();

    mode = "full";
    const full = await runtime.listExternalAgentSessions();
    expect(full.sessions.map((session) => session.key)).toEqual([
      "ssh:target_1:codex:current"
    ]);
    expect(full.truncated).toBeUndefined();

    mode = "failed";
    const failed = await runtime.listExternalAgentSessions();
    expect(failed.sessions).toEqual([]);
    expect(failed.truncated).toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      { kind: "ssh", targetId: "target_1" },
      expect.objectContaining({
        message: "history unavailable"
      })
    );

    applyAction(state, {
      type: "workspace.close",
      workspaceId: remoteWorkspaceId
    });
    expect((await runtime.listExternalAgentSessions()).sessions).toHaveLength(
      0
    );
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
        emptyHistoryRefresh(),
        vi.fn(async () => ({
          truncated: false,
          records: [
            {
              vendor: "codex" as const,
              sessionId: "unscoped",
              updatedAtUnixMs: 2_000,
              canResume: true
            }
          ]
        }))
      ),
      getState: () => state,
      localIndexer: { resolveExternalAgentSession: () => null } as never,
      now: () => new Date(10_000)
    });

    await expect(runtime.listExternalAgentSessions()).resolves.toEqual({
      sessions: [],
      updatedAt: "1970-01-01T00:00:10.000Z"
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
      return {
        truncated: true,
        records: [
          {
            vendor: "codex" as const,
            sessionId: "removed-target-session",
            updatedAtUnixMs: 2_000,
            canResume: true,
            principal: { uid: 1_000, accountName: "kmux" }
          }
        ]
      };
    });
    const runtime = createTargetHistoryRuntime({
      targetServices: registryWithHistory(emptyHistoryRefresh(), remoteHistory),
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
    expect(records).toMatchObject({
      truncated: false,
      records: [
        {
          vendor: "codex",
          sessionId: "session-1",
          canResume: true,
          title: "Local session"
        }
      ]
    });
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

function emptyHistoryRefresh(): LocatedTargetServiceSet["history"]["refresh"] {
  return vi.fn(async () => ({ records: [], truncated: false }));
}
