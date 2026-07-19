import { createInitialState } from "@kmux/core";
import { describe, expect, it, vi } from "vitest";

import type { RemoteLifecycleRuntime } from "./remoteLifecycleRuntime";
import type {
  ConnectedSshProfile,
  SshConnectionRuntime
} from "./sshConnectionRuntime";
import {
  createSshWorkspaceRuntime,
  decodeSshWorkspaceCancelRequest,
  decodeSshWorkspaceCommitRequest,
  decodeSshWorkspacePrepareRequest
} from "./sshWorkspaceRuntime";

describe("SSH workspace runtime", () => {
  it("strictly decodes each profile-backed renderer command", () => {
    const request = {
      requestId: "request_1",
      sourceWorkspaceId: "workspace_1",
      profileId: "profile_1",
      continuation: "create" as const
    };
    expect(decodeSshWorkspacePrepareRequest(request)).toEqual(request);
    expect(() =>
      decodeSshWorkspacePrepareRequest({ ...request, targetId: "target_1" })
    ).toThrow(/unexpected SSH workspace request field/u);
    expect(() =>
      decodeSshWorkspacePrepareRequest({
        ...request,
        continuation: "replace"
      })
    ).toThrow(/continuation is invalid/u);
    expect(
      decodeSshWorkspaceCommitRequest({ preparationId: "preparation_1" })
    ).toEqual({ preparationId: "preparation_1" });
    expect(() =>
      decodeSshWorkspaceCommitRequest({
        preparationId: "preparation_1",
        requestId: "request_1"
      })
    ).toThrow(/unexpected SSH workspace request field/u);
    expect(decodeSshWorkspaceCancelRequest({ requestId: "request_1" })).toEqual(
      { requestId: "request_1" }
    );
  });

  it("verifies a saved profile without creating a keeper until commit", async () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const startWorkspaceConversion = vi.fn(async (request) =>
      transactionRecord(request.workspaceId, request.targetId, "convert")
    );
    const connectProfile = vi.fn(async () => connectedProfile());
    const runtime = createSshWorkspaceRuntime({
      connections: { connectProfile } as unknown as SshConnectionRuntime,
      lifecycle: {
        startWorkspaceConversion
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state,
      makePreparationId: () => "preparation_1"
    });

    await expect(
      runtime.prepare({
        requestId: "request_1",
        sourceWorkspaceId,
        profileId: "profile_1",
        continuation: "convert"
      })
    ).resolves.toEqual({ preparationId: "preparation_1" });
    expect(connectProfile).toHaveBeenCalledWith("profile_1", {
      signal: expect.any(AbortSignal)
    });
    expect(startWorkspaceConversion).not.toHaveBeenCalled();

    await expect(
      runtime.commit({ preparationId: "preparation_1" })
    ).resolves.toEqual({
      workspaceId: sourceWorkspaceId,
      targetId: "target_1",
      continuation: "convert"
    });
    expect(startWorkspaceConversion).toHaveBeenCalledWith({
      workspaceId: sourceWorkspaceId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      connectionName: "dev-gpu",
      defaultCwd: "/home/kmux",
      continuation: "convert",
      launch: {
        cwd: "/home/kmux",
        shell: "/bin/zsh",
        env: { KMUX_REMOTE: "1" }
      }
    });
    await expect(
      runtime.commit({ preparationId: "preparation_1" })
    ).rejects.toThrow(/unavailable or expired/u);
  });

  it("returns the separately-created workspace identity", async () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const runtime = createSshWorkspaceRuntime({
      connections: {
        connectProfile: async () => connectedProfile("/srv/project")
      } as unknown as SshConnectionRuntime,
      lifecycle: {
        startWorkspaceConversion: async () =>
          transactionRecord("workspace_created", "target_1", "create")
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state,
      makePreparationId: () => "preparation_2"
    });

    const prepared = await runtime.prepare({
      requestId: "request_2",
      sourceWorkspaceId,
      profileId: "profile_1",
      continuation: "create"
    });
    await expect(runtime.commit(prepared)).resolves.toEqual({
      workspaceId: "workspace_created",
      targetId: "target_1",
      continuation: "create"
    });
  });

  it("cancels visible verification without starting a workspace transaction", async () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const connection = deferred<ConnectedSshProfile>();
    const startWorkspaceConversion = vi.fn();
    const runtime = createSshWorkspaceRuntime({
      connections: {
        connectProfile: () => connection.promise
      } as unknown as SshConnectionRuntime,
      lifecycle: {
        startWorkspaceConversion
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state,
      makePreparationId: () => "preparation_cancelled"
    });

    const preparing = runtime.prepare({
      requestId: "request_cancelled",
      sourceWorkspaceId,
      profileId: "profile_1",
      continuation: "convert"
    });
    runtime.cancel({ requestId: "request_cancelled" });
    connection.resolve(connectedProfile());

    await expect(preparing).rejects.toThrow(/preparation was cancelled/u);
    expect(startWorkspaceConversion).not.toHaveBeenCalled();
    expect(state.workspaces[sourceWorkspaceId]?.location.target.kind).toBe(
      "local"
    );
  });

  it("rechecks Main-owned source state after verification and before commit", async () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const startWorkspaceConversion = vi.fn();
    const runtime = createSshWorkspaceRuntime({
      connections: {
        connectProfile: async () => connectedProfile()
      } as unknown as SshConnectionRuntime,
      lifecycle: {
        startWorkspaceConversion
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state,
      makePreparationId: () => "preparation_stale"
    });

    const prepared = await runtime.prepare({
      requestId: "request_stale",
      sourceWorkspaceId,
      profileId: "profile_1",
      continuation: "convert"
    });
    delete state.workspaces[sourceWorkspaceId];

    await expect(runtime.commit(prepared)).rejects.toThrow(
      /source no longer exists/u
    );
    expect(startWorkspaceConversion).not.toHaveBeenCalled();
  });

  it("bounds and expires opaque preparations", async () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    let time = 1_000;
    let nextId = 0;
    const runtime = createSshWorkspaceRuntime({
      connections: {
        connectProfile: async () => connectedProfile()
      } as unknown as SshConnectionRuntime,
      lifecycle: {} as RemoteLifecycleRuntime,
      getState: () => state,
      now: () => time,
      preparationTtlMs: 100,
      maxPreparations: 1,
      makePreparationId: () => `preparation_${++nextId}`
    });

    const first = await runtime.prepare({
      requestId: "request_first",
      sourceWorkspaceId,
      profileId: "profile_1",
      continuation: "create"
    });
    await expect(
      runtime.prepare({
        requestId: "request_second",
        sourceWorkspaceId,
        profileId: "profile_1",
        continuation: "create"
      })
    ).rejects.toThrow(/too many SSH workspace preparations/u);

    time += 100;
    await expect(runtime.commit(first)).rejects.toThrow(
      /unavailable or expired/u
    );
    await expect(
      runtime.prepare({
        requestId: "request_second",
        sourceWorkspaceId,
        profileId: "profile_1",
        continuation: "create"
      })
    ).resolves.toEqual({ preparationId: "preparation_2" });
  });
});

function connectedProfile(defaultRemoteCwd?: string): ConnectedSshProfile {
  return {
    profile: {
      id: "profile_1",
      name: "dev-gpu",
      host: "dev.example.com",
      ...(defaultRemoteCwd === undefined ? {} : { defaultRemoteCwd }),
      shellOverride: "/bin/zsh",
      env: { KMUX_REMOTE: "1" },
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
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
        lastVerifiedAt: "2026-07-19T00:00:00.000Z"
      },
      firstVerifiedAt: "2026-07-19T00:00:00.000Z"
    },
    connection: {} as ConnectedSshProfile["connection"],
    verification: {
      remoteHome: "/home/kmux"
    } as ConnectedSshProfile["verification"],
    hello: {} as ConnectedSshProfile["hello"]
  };
}

function transactionRecord(
  workspaceId: string,
  targetId: string,
  continuation: "convert" | "create"
) {
  return {
    state: "cleanup-complete" as const,
    continuation,
    workspaceResourceKey: {
      workspaceId,
      targetId
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
