import { describe, expect, it, vi } from "vitest";

import {
  createInitialState,
  workspaceLocation,
  type AppAction,
  type AppState
} from "@kmux/core";

import {
  SshAuthenticationCancelledError,
  type ActiveSshTarget,
  type ConnectedSshProfile
} from "./sshConnectionRuntime";
import { createSshReconnectCoordinator } from "./sshReconnectCoordinator";

describe("SSH reconnect coordinator", () => {
  it("coalesces one target attempt and updates every workspace sharing it", async () => {
    const state = sshStateWithSharedTarget();
    const pending = deferred<ConnectedSshProfile>();
    const restoreTarget = vi.fn(() => pending.promise);
    const onConnected = vi.fn();
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget,
      onConnected
    });

    const startup = coordinator.reconnectTarget("target_shared", {
      authentication: "interactive",
      purpose: "startup-restore"
    });
    const runtime = coordinator.reconnectTarget("target_shared", {
      authentication: "non-interactive",
      purpose: "runtime-reconnect"
    });

    expect(restoreTarget).toHaveBeenCalledTimes(1);
    expect(
      Object.values(state.workspaces).map(
        (workspace) => workspace.statusEntries["ssh:connection"]?.text
      )
    ).toEqual(["Reconnecting SSH…", "Reconnecting SSH…"]);
    coordinator.targetConnected("target_shared");
    pending.resolve({} as ConnectedSshProfile);
    await expect(Promise.all([startup, runtime])).resolves.toHaveLength(2);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(
      Object.values(state.workspaces).every(
        (workspace) => !workspace.statusEntries["ssh:connection"]
      )
    ).toBe(true);
  });

  it("reuses a validated active target without reconnecting", async () => {
    const state = sshStateWithSharedTarget();
    const active = activeTarget();
    const restoreTarget = vi.fn();
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget,
      getActiveTarget: () => active,
      isTargetConnected: () => true
    });

    await expect(
      coordinator.ensureTargetConnected("target_shared", "session-resume")
    ).resolves.toEqual(active);
    expect(restoreTarget).not.toHaveBeenCalled();
  });

  it("coalesces interactive session restore for a stale target", async () => {
    const state = sshStateWithSharedTarget();
    const pending = deferred<ConnectedSshProfile>();
    let active: ActiveSshTarget | null = null;
    const restoreTarget = vi.fn(() => pending.promise);
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget,
      getActiveTarget: () => active,
      isTargetConnected: () => false
    });

    const first = coordinator.ensureTargetConnected(
      "target_shared",
      "session-resume"
    );
    const second = coordinator.ensureTargetConnected(
      "target_shared",
      "session-resume"
    );
    active = activeTarget();
    pending.resolve(connectedProfile());

    await expect(Promise.all([first, second])).resolves.toEqual([
      active,
      active
    ]);
    expect(restoreTarget).toHaveBeenCalledTimes(1);
    expect(restoreTarget).toHaveBeenCalledWith("target_shared", {
      authentication: "interactive",
      purpose: "session-resume"
    });
  });

  it("falls back to interactive restore after joining a failed runtime reconnect", async () => {
    const state = sshStateWithSharedTarget();
    const nonInteractive = deferred<ConnectedSshProfile>();
    let active: ActiveSshTarget | null = null;
    const restoreTarget = vi
      .fn()
      .mockImplementationOnce(() => nonInteractive.promise)
      .mockImplementationOnce(async () => {
        active = activeTarget();
        return connectedProfile();
      });
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget,
      getActiveTarget: () => active,
      isTargetConnected: () => false
    });
    void coordinator
      .reconnectTarget("target_shared", {
        authentication: "non-interactive",
        purpose: "runtime-reconnect"
      })
      .catch(() => undefined);
    const ensured = coordinator.ensureTargetConnected(
      "target_shared",
      "session-resume"
    );
    nonInteractive.reject(new Error("agent unavailable"));

    await expect(ensured).resolves.toEqual(activeTarget());
    expect(restoreTarget).toHaveBeenCalledTimes(2);
    expect(restoreTarget).toHaveBeenLastCalledWith("target_shared", {
      authentication: "interactive",
      purpose: "session-resume"
    });
  });

  it("rejects a restore that no longer has a validated active target", async () => {
    const state = sshStateWithSharedTarget();
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget: vi.fn(async () => connectedProfile()),
      getActiveTarget: () => null,
      isTargetConnected: () => false
    });

    await expect(
      coordinator.ensureTargetConnected("target_shared", "session-resume")
    ).rejects.toThrow(/saved binding/u);
  });

  it("contains authentication cancellation until an explicit manual retry", async () => {
    const state = sshStateWithSharedTarget();
    const restoreTarget = vi
      .fn()
      .mockRejectedValueOnce(new SshAuthenticationCancelledError())
      .mockResolvedValueOnce({} as ConnectedSshProfile);
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget
    });

    await expect(
      coordinator.reconnectTarget("target_shared", {
        authentication: "interactive",
        purpose: "startup-restore"
      })
    ).rejects.toBeInstanceOf(SshAuthenticationCancelledError);
    expect(restoreTarget).toHaveBeenCalledTimes(1);
    expect(
      Object.values(state.workspaces).map(
        (workspace) => workspace.statusEntries["ssh:connection"]?.text
      )
    ).toEqual(["SSH authentication cancelled", "SSH authentication cancelled"]);

    await expect(
      coordinator.reconnectWorkspace(Object.keys(state.workspaces)[0]!)
    ).resolves.toEqual({ status: "connected" });
    expect(restoreTarget).toHaveBeenCalledTimes(2);
  });

  it("clears stale errors when the target connects outside the coordinator", () => {
    const state = sshStateWithSharedTarget();
    const dispatchAppAction = createStatusDispatcher(state);
    for (const workspaceId of Object.keys(state.workspaces)) {
      dispatchAppAction({
        type: "sidebar.setStatus",
        workspaceId,
        key: "ssh:connection",
        text: "Permission denied",
        variant: "error"
      });
    }
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction,
      restoreTarget: vi.fn()
    });

    coordinator.targetConnected("target_shared");

    expect(
      Object.values(state.workspaces).every(
        (workspace) => !workspace.statusEntries["ssh:connection"]
      )
    ).toBe(true);
  });

  it("does not let an older reconnect failure overwrite a newer success", async () => {
    const state = sshStateWithSharedTarget();
    const stale = deferred<ConnectedSshProfile>();
    const replacement = deferred<ConnectedSshProfile>();
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget: vi
        .fn()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => replacement.promise)
    });
    const staleReconnect = coordinator.reconnectTarget("target_shared", {
      authentication: "non-interactive",
      purpose: "runtime-reconnect"
    });

    coordinator.targetConnected("target_shared");
    expect(coordinator.isTargetReconnecting("target_shared")).toBe(false);
    const replacementReconnect = coordinator.reconnectTarget("target_shared", {
      authentication: "non-interactive",
      purpose: "runtime-reconnect"
    });
    stale.reject(new Error("stale reconnect failed"));

    await expect(staleReconnect).rejects.toThrow("stale reconnect failed");
    expect(
      Object.values(state.workspaces).map(
        (workspace) => workspace.statusEntries["ssh:connection"]?.text
      )
    ).toEqual(["Reconnecting SSH…", "Reconnecting SSH…"]);

    coordinator.targetConnected("target_shared");
    replacement.resolve({} as ConnectedSshProfile);
    await expect(replacementReconnect).resolves.toEqual({});
    expect(
      Object.values(state.workspaces).every(
        (workspace) => !workspace.statusEntries["ssh:connection"]
      )
    ).toBe(true);
  });

  it("revalidates workspace identity and only reconnects SSH workspaces", async () => {
    const state = createInitialState();
    const restoreTarget = vi.fn();
    const coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget
    });
    const workspaceId = state.windows[state.activeWindowId]!.activeWorkspaceId;

    await expect(
      coordinator.reconnectWorkspace("workspace_missing")
    ).rejects.toThrow(/does not exist/u);
    await expect(coordinator.reconnectWorkspace(workspaceId)).rejects.toThrow(
      /not an SSH workspace/u
    );
    expect(restoreTarget).not.toHaveBeenCalled();
  });

  it("does not misreport a connected target when post-connect reconciliation fails", async () => {
    const state = sshStateWithSharedTarget();
    const reportError = vi.fn();
    let coordinator!: ReturnType<typeof createSshReconnectCoordinator>;
    const restoreTarget = vi.fn(async () => {
      coordinator.targetConnected("target_shared");
      return {} as ConnectedSshProfile;
    });
    coordinator = createSshReconnectCoordinator({
      getState: () => state,
      dispatchAppAction: createStatusDispatcher(state),
      restoreTarget,
      onConnected: vi.fn(async () => {
        throw new Error("worktree refresh failed");
      }),
      reportError
    });

    await expect(
      coordinator.reconnectTarget("target_shared", {
        authentication: "non-interactive",
        purpose: "runtime-reconnect"
      })
    ).resolves.toEqual({});
    expect(restoreTarget).toHaveBeenCalledWith("target_shared", {
      authentication: "non-interactive",
      purpose: "runtime-reconnect"
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "worktree refresh failed" })
    );
    expect(
      Object.values(state.workspaces).every(
        (workspace) => !workspace.statusEntries["ssh:connection"]
      )
    ).toBe(true);
  });
});

function sshStateWithSharedTarget(): AppState {
  const state = createInitialState();
  const workspaceId = state.windows[state.activeWindowId]!.activeWorkspaceId;
  const first = state.workspaces[workspaceId]!;
  first.location = workspaceLocation(
    { kind: "ssh", targetId: "target_shared" },
    "/srv/first"
  );
  const second = structuredClone(first);
  second.id = "workspace_second";
  second.location = workspaceLocation(
    { kind: "ssh", targetId: "target_shared" },
    "/srv/second"
  );
  second.statusEntries = {};
  state.workspaces[second.id] = second;
  return state;
}

function createStatusDispatcher(state: AppState): (action: AppAction) => void {
  return (action) => {
    if (action.type === "sidebar.setStatus") {
      const workspace = state.workspaces[action.workspaceId];
      if (!workspace) return;
      const key = action.key ?? "manual";
      workspace.statusEntries[key] = {
        key,
        text: action.text,
        variant: action.variant ?? "info",
        updatedAt: "2026-07-30T00:00:00.000Z",
        ...(action.label === undefined ? {} : { label: action.label })
      };
    } else if (action.type === "sidebar.clearStatus") {
      const workspace = state.workspaces[action.workspaceId];
      if (workspace) delete workspace.statusEntries[action.key ?? "manual"];
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function activeTarget(): ActiveSshTarget {
  const connected = connectedProfile();
  return {
    profile: connected.profile,
    binding: connected.binding,
    remoteHome: connected.verification.remoteHome
  };
}

function connectedProfile(): ConnectedSshProfile {
  return {
    profile: {
      id: "profile_shared",
      name: "shared",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    },
    binding: {
      id: "target_shared",
      authority: {
        remoteInstallationId: "installation_shared",
        executionNodeId: "node_shared",
        authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
      },
      locator: {
        profileId: "profile_shared",
        effectiveConnectionPolicyHash: "a".repeat(64),
        lastVerifiedAt: "2026-07-30T00:00:00.000Z"
      },
      firstVerifiedAt: "2026-07-30T00:00:00.000Z"
    },
    connection: {} as ConnectedSshProfile["connection"],
    verification: {
      remoteHome: "/home/kmux"
    } as ConnectedSshProfile["verification"],
    hello: {} as ConnectedSshProfile["hello"]
  };
}
