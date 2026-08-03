import {
  applyAction,
  createInitialState,
  requireTerminalSurfaceContent,
  type AppState
} from "@kmux/core";
import { describe, expect, it, vi } from "vitest";

import type { ConversionWalRecord } from "./conversionWal";
import type { RemoteLifecycleRuntime } from "./remoteLifecycleRuntime";
import type { ActiveSshTarget } from "./sshConnectionRuntime";
import { createSshWorkspaceCreationRuntime } from "./sshWorkspaceCreationRuntime";

describe("SSH workspace creation runtime", () => {
  it("merges history launch settings and passes resume input to the inline transaction", async () => {
    const state = createInitialState("/bin/zsh");
    const startSshWorkspaceTransaction = vi.fn(async (request) =>
      installCreatedWorkspace(state, request)
    );
    const runtime = createSshWorkspaceCreationRuntime({
      lifecycle: {
        startSshWorkspaceTransaction
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state
    });

    const result = await runtime.create({
      kind: "create-new",
      destinationWindowId: state.activeWindowId,
      target: activeTarget({
        defaultRemoteCwd: "/profile/cwd",
        shellOverride: "/bin/profile-shell",
        env: { PROFILE_ONLY: "1", OVERRIDE: "profile" }
      }),
      workspaceName: "Resume remote agent",
      launch: {
        cwd: "/history/cwd",
        shell: "/bin/session-shell",
        args: ["--login"],
        env: { SESSION_ONLY: "1", OVERRIDE: "session" },
        initialInput: "codex resume session-1\r",
        title: "Resume remote agent"
      },
      agentSessionRef: {
        vendor: "codex",
        externalKey: "ssh:target_1:codex:session-1",
        sessionId: "session-1"
      }
    });

    expect(startSshWorkspaceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-new",
        destinationWindowId: state.activeWindowId,
        targetId: "target_1",
        initialWorkspaceName: "Resume remote agent",
        defaultCwd: "/history/cwd",
        launch: {
          cwd: "/history/cwd",
          shell: "/bin/session-shell",
          args: ["--login"],
          env: {
            PROFILE_ONLY: "1",
            SESSION_ONLY: "1",
            OVERRIDE: "session"
          },
          title: "Resume remote agent"
        },
        initialInput: "codex resume session-1\r",
        agentSessionRef: {
          vendor: "codex",
          externalKey: "ssh:target_1:codex:session-1",
          sessionId: "session-1"
        }
      })
    );
    expect(
      startSshWorkspaceTransaction.mock.calls[0]![0].launch
    ).not.toHaveProperty("initialInput");
    expect(result).toMatchObject({
      targetId: "target_1",
      continuation: "create"
    });
  });

  it("falls back from profile cwd to the verified remote home", async () => {
    const state = createInitialState("/bin/zsh");
    const startSshWorkspaceTransaction = vi.fn(async (request) =>
      installCreatedWorkspace(state, request)
    );
    const runtime = createSshWorkspaceCreationRuntime({
      lifecycle: {
        startSshWorkspaceTransaction
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state
    });

    await runtime.create({
      kind: "create-new",
      destinationWindowId: state.activeWindowId,
      target: activeTarget()
    });

    expect(startSshWorkspaceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultCwd: "/verified/home",
        launch: { cwd: "/verified/home" }
      })
    );
  });
});

function activeTarget(
  profile: Partial<ActiveSshTarget["profile"]> = {}
): ActiveSshTarget {
  return {
    profile: {
      id: "profile_1",
      name: "devbox",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      ...profile
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
    remoteHome: "/verified/home"
  };
}

function installCreatedWorkspace(
  state: AppState,
  request: {
    targetId: string;
    defaultCwd: string;
    initialWorkspaceName: string;
    launch: { cwd?: string };
    initialInput?: string;
    agentSessionRef?: {
      vendor: "codex" | "claude" | "antigravity";
      externalKey: string;
      sessionId: string;
    };
  }
): ConversionWalRecord {
  applyAction(state, {
    type: "workspace.create",
    name: request.initialWorkspaceName,
    target: { kind: "ssh", targetId: request.targetId },
    cwd: request.defaultCwd,
    launch: {
      ...request.launch,
      ...(request.initialInput === undefined
        ? {}
        : { initialInput: request.initialInput })
    },
    agentSessionRef: request.agentSessionRef
  });
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const workspace = state.workspaces[workspaceId];
  const surface =
    state.surfaces[state.panes[workspace.activePaneId].activeSurfaceId];
  const sessionId = requireTerminalSurfaceContent(surface).sessionId;
  return {
    version: 3,
    state: "cleanup-complete",
    transactionId: "conversion_1",
    workspaceCreateOperationId: "operation_workspace",
    sessionCreateOperationId: "operation_session",
    workspaceResourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: request.targetId,
      workspaceId
    },
    sessionResourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: request.targetId,
      workspaceId,
      sessionId
    },
    remoteResourceRevision: "1"
  } as unknown as ConversionWalRecord;
}
