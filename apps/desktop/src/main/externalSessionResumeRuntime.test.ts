import {
  applyAction,
  createInitialState,
  requireTerminalSurfaceContent,
  type AppAction,
  type AppState
} from "@kmux/core";
import { uint64 } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import type { ExternalSessionResumeSpec } from "./externalSessions";
import {
  ExternalSessionConnectionError,
  ExternalSessionLaunchError,
  createExternalSessionResumeRuntime
} from "./externalSessionResumeRuntime";
import type { ActiveSshTarget } from "./remote/sshConnectionRuntime";
import type { SshReconnectCoordinator } from "./remote/sshReconnectCoordinator";
import type {
  SshWorkspaceCreationResult,
  SshWorkspaceCreationRuntime
} from "./remote/sshWorkspaceCreationRuntime";

describe("external session resume runtime", () => {
  it("keeps local sessions on the existing local workspace.create path", async () => {
    const fixture = createFixture(localSpec());

    const result = await resume(fixture, "codex:session-1");
    const session = sessionForResult(fixture.state, result.surfaceId);

    expect(fixture.ensureTargetConnected).not.toHaveBeenCalled();
    expect(fixture.createSshWorkspace).not.toHaveBeenCalled();
    expect(session.agentSessionRef).toMatchObject({
      vendor: "codex",
      id: "session-1",
      targetId: "local"
    });
    expect(session.launch.initialInput).toBe("codex resume session-1\r");
  });

  it("coalesces concurrent SSH resumes into one connection and creation", async () => {
    const connection = deferred<ActiveSshTarget>();
    const fixture = createFixture(sshSpec(), {
      ensureTargetConnected: vi.fn(() => connection.promise)
    });

    const first = resume(fixture, "ssh:target_1:codex:session-1");
    const second = resume(fixture, "ssh:target_1:codex:session-1");
    expect(first).toBe(second);
    connection.resolve(activeTarget());

    await expect(Promise.all([first, second])).resolves.toEqual([
      { workspaceId: "workspace_remote", surfaceId: "surface_remote" },
      { workspaceId: "workspace_remote", surfaceId: "surface_remote" }
    ]);
    expect(fixture.ensureTargetConnected).toHaveBeenCalledTimes(1);
    expect(fixture.createSshWorkspace).toHaveBeenCalledTimes(1);
    expect(fixture.createSshWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-new",
        destinationWindowId: fixture.state.activeWindowId,
        workspaceName: "Remote session",
        initialInput: "codex resume session-1\r",
        agentSessionRef: sshSpec().agentSessionRef
      })
    );
  });

  it("reconnects an existing SSH workspace before focusing its surface", async () => {
    const state = createInitialState("/bin/zsh");
    const spec = sshSpec();
    applyAction(state, {
      type: "workspace.create",
      name: spec.title,
      target: spec.target,
      cwd: spec.cwd,
      launch: spec.launch,
      agentSessionRef: spec.agentSessionRef
    });
    const existingWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const existingSurfaceId =
      state.panes[state.workspaces[existingWorkspaceId].activePaneId]
        .activeSurfaceId;
    applyAction(state, {
      type: "workspace.create",
      name: "other",
      cwd: "/tmp/other"
    });
    const fixture = createFixture(spec, { state });

    await expect(
      resume(fixture, "ssh:target_1:codex:session-1")
    ).resolves.toEqual({
      workspaceId: existingWorkspaceId,
      surfaceId: existingSurfaceId
    });
    expect(fixture.ensureTargetConnected).toHaveBeenCalledTimes(1);
    expect(fixture.createSshWorkspace).not.toHaveBeenCalled();
    expect(state.windows[state.activeWindowId].activeWorkspaceId).toBe(
      existingWorkspaceId
    );
  });

  it("does not create a workspace when SSH connection fails", async () => {
    const state = createInitialState("/bin/zsh");
    const workspaceCount = Object.keys(state.workspaces).length;
    const fixture = createFixture(sshSpec(), {
      state,
      ensureTargetConnected: vi.fn(async () => {
        throw new Error("authentication cancelled");
      })
    });

    await expect(
      resume(fixture, "ssh:target_1:codex:session-1")
    ).rejects.toBeInstanceOf(ExternalSessionConnectionError);
    expect(Object.keys(state.workspaces)).toHaveLength(workspaceCount);
    expect(fixture.createSshWorkspace).not.toHaveBeenCalled();
  });

  it("preserves a created workspace when durable resume input fails", async () => {
    const state = createInitialState("/bin/zsh");
    const workspaceCount = Object.keys(state.workspaces).length;
    const createSshWorkspace = vi.fn(async () => {
      const result = createRemoteWorkspaceInState(state);
      return {
        ...result,
        resumeInputResult: {
          operationId: "operation_launch_input",
          outcome: {
            status: "failed" as const,
            resultDigest: "f".repeat(64),
            code: "resume-rejected",
            message: "resume command rejected"
          }
        }
      };
    });
    const fixture = createFixture(sshSpec(), {
      state,
      createSshWorkspace
    });

    await expect(
      resume(fixture, "ssh:target_1:codex:session-1")
    ).rejects.toBeInstanceOf(ExternalSessionLaunchError);
    expect(Object.keys(state.workspaces)).toHaveLength(workspaceCount + 1);
    expect(
      state.workspaces[state.windows[state.activeWindowId].activeWorkspaceId]
        .location.target
    ).toEqual({ kind: "ssh", targetId: "target_1" });
  });
});

function createFixture(
  spec: ExternalSessionResumeSpec,
  overrides: {
    state?: AppState;
    ensureTargetConnected?: ReturnType<typeof vi.fn>;
    createSshWorkspace?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const state = overrides.state ?? createInitialState("/bin/zsh");
  const ensureTargetConnected =
    overrides.ensureTargetConnected ?? vi.fn(async () => activeTarget());
  const createSshWorkspace =
    overrides.createSshWorkspace ??
    vi.fn(async () => ({
      workspaceId: "workspace_remote",
      surfaceId: "surface_remote",
      sessionId: "session_remote",
      targetId: "target_1",
      continuation: "create" as const,
      resumeInputResult: {
        operationId: "operation_launch_input",
        outcome: {
          status: "succeeded" as const,
          remoteResourceRevision: uint64(2n),
          resultDigest: "f".repeat(64)
        }
      }
    }));
  const dispatchAppAction = (action: AppAction): void => {
    applyAction(state, action);
  };
  const runtime = createExternalSessionResumeRuntime({
    resolveExternalAgentSession: (key) => (key === spec.key ? spec : null),
    getState: () => state,
    dispatchAppAction,
    defaultShellPath: "/bin/zsh",
    sshReconnect: {
      ensureTargetConnected
    } as unknown as SshReconnectCoordinator,
    sshCreator: {
      create: createSshWorkspace
    } as unknown as SshWorkspaceCreationRuntime
  });
  return {
    state,
    runtime,
    ensureTargetConnected,
    createSshWorkspace
  };
}

function resume(
  fixture: ReturnType<typeof createFixture>,
  key: string
): Promise<{ workspaceId: string; surfaceId: string }> {
  return fixture.runtime.resume({
    key,
    destinationWindowId: fixture.state.activeWindowId
  });
}

function localSpec(): ExternalSessionResumeSpec {
  return {
    key: "codex:session-1",
    vendor: "codex",
    title: "Local session",
    target: { kind: "local" },
    cwd: "/tmp/project",
    launch: {
      cwd: "/tmp/project",
      initialInput: "codex resume session-1\r",
      title: "Local session"
    },
    agentSessionRef: {
      vendor: "codex",
      externalKey: "codex:session-1",
      sessionId: "session-1"
    }
  };
}

function sshSpec(): ExternalSessionResumeSpec {
  return {
    key: "ssh:target_1:codex:session-1",
    vendor: "codex",
    title: "Remote session",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/project",
    launch: {
      cwd: "/srv/project",
      initialInput: "codex resume session-1\r",
      title: "Remote session"
    },
    agentSessionRef: {
      vendor: "codex",
      externalKey: "ssh:target_1:codex:session-1",
      sessionId: "session-1"
    }
  };
}

function activeTarget(): ActiveSshTarget {
  return {
    profile: {
      id: "profile_1",
      name: "devbox",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    },
    binding: {
      id: "target_1",
      authority: {
        remoteInstallationId: "installation_1",
        executionNodeId: "node_1",
        authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
      },
      locator: {
        profileId: "profile_1",
        effectiveConnectionPolicyHash: "a".repeat(64),
        lastVerifiedAt: "2026-07-30T00:00:00.000Z"
      },
      firstVerifiedAt: "2026-07-30T00:00:00.000Z"
    },
    remoteHome: "/home/kmux"
  };
}

function createRemoteWorkspaceInState(
  state: AppState
): SshWorkspaceCreationResult {
  applyAction(state, {
    type: "workspace.create",
    name: "Remote session",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/project",
    launch: {
      cwd: "/srv/project",
      initialInput: "codex resume session-1\r"
    },
    agentSessionRef: sshSpec().agentSessionRef
  });
  const generatedWorkspaceId =
    state.windows[state.activeWindowId].activeWorkspaceId;
  const workspace = state.workspaces[generatedWorkspaceId];
  const pane = state.panes[workspace.activePaneId];
  const surface = state.surfaces[pane.activeSurfaceId];
  return {
    workspaceId: generatedWorkspaceId,
    surfaceId: surface.id,
    sessionId: requireTerminalSurfaceContent(surface).sessionId,
    targetId: "target_1",
    continuation: "create"
  };
}

function sessionForResult(state: AppState, surfaceId: string) {
  const surface = state.surfaces[surfaceId];
  return state.sessions[requireTerminalSurfaceContent(surface).sessionId];
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
