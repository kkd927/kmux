import { requireTerminalSurfaceContent } from "@kmux/core";

import {
  createInitialState,
  locatedPathForTarget,
  workspaceLocation,
  type AppState
} from "@kmux/core";
import { uint64 } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import type { RemoteLifecycleRuntime } from "../remote/remoteLifecycleRuntime";
import type { RemoteHostManager } from "../remoteHost";
import {
  createRemoteForwardQueue,
  createRemotePortProvider
} from "./remotePortProvider";

describe("remote port provider", () => {
  it("durably records a collision remap before returning the rewritten URL", async () => {
    const state = remoteState();
    const descriptors: Array<Record<string, unknown>> = [];
    const executeCommand = vi.fn(async (command) => {
      if (command.payload.kind === "forward.ensure") {
        const existing = descriptors.find(
          (entry) => entry.forwardId === command.payload.forwardId
        );
        const descriptor = {
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId: command.workspaceId
          },
          ...command.payload,
          operationId: `operation_${executeCommand.mock.calls.length}`,
          remoteResourceRevision: String(executeCommand.mock.calls.length)
        };
        if (existing) Object.assign(existing, descriptor);
        else descriptors.push(descriptor);
      }
      return {
        operationId: `operation_${executeCommand.mock.calls.length}`,
        outcome: {
          status: "succeeded" as const,
          remoteResourceRevision: uint64(
            BigInt(executeCommand.mock.calls.length)
          ),
          resultDigest: "a".repeat(64)
        }
      };
    });
    const reconcileForwards = vi.fn(async () => {
      const descriptor = descriptors[0];
      return descriptor
        ? [
            {
              forwardId: descriptor.forwardId as string,
              workspaceId: "workspace_1",
              remoteHost: "127.0.0.1",
              remotePort: 3_000,
              localBindHost: "127.0.0.1" as const,
              localPort: (descriptor.localPort as number | undefined) ?? 45_321,
              status: "active" as const
            }
          ]
        : [];
    });
    const provider = createRemotePortProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: {
        inspectPorts: vi.fn(),
        observeForwards: vi.fn(async () => ({
          type: "forwards.observed" as const,
          targetId: "target_1",
          forwards: descriptors as never
        })),
        reconcileForwards,
        closeWorkspaceForwards: vi.fn()
      } as unknown as Pick<
        RemoteHostManager,
        | "inspectPorts"
        | "observeForwards"
        | "reconcileForwards"
        | "closeWorkspaceForwards"
      >,
      lifecycle: {
        executeCommand,
        isTargetConnected: () => true
      } as unknown as RemoteLifecycleRuntime,
      getState: () => state,
      queue: createRemoteForwardQueue(),
      makeForwardId: () => "forward_1"
    });

    const result = await provider.remapBrowserUrl({
      workspaceId: "workspace_1",
      url: new URL("http://localhost:3000/path?q=1")
    });

    expect(result.url.toString()).toBe("http://127.0.0.1:45321/path?q=1");
    expect(result.mapping).toMatchObject({
      forwardId: "forward_1",
      remotePort: 3_000,
      localPort: 45_321,
      status: "active"
    });
    expect(
      executeCommand.mock.calls.map(([command]) => command.payload)
    ).toEqual([
      {
        kind: "forward.ensure",
        forwardId: "forward_1",
        remoteHost: "127.0.0.1",
        remotePort: 3_000,
        localBindHost: "127.0.0.1"
      },
      {
        kind: "forward.ensure",
        forwardId: "forward_1",
        remoteHost: "127.0.0.1",
        remotePort: 3_000,
        localBindHost: "127.0.0.1",
        localPort: 45_321
      }
    ]);
    expect(reconcileForwards).toHaveBeenCalledTimes(2);
  });

  it("does not forward a non-loopback browser URL", async () => {
    const state = remoteState();
    const observeForwards = vi.fn();
    const provider = createRemotePortProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: {
        inspectPorts: vi.fn(),
        observeForwards,
        reconcileForwards: vi.fn(),
        closeWorkspaceForwards: vi.fn()
      } as never,
      lifecycle: {} as RemoteLifecycleRuntime,
      getState: () => state,
      queue: createRemoteForwardQueue()
    });

    await expect(
      provider.remapBrowserUrl({
        workspaceId: "workspace_1",
        url: new URL("https://example.com/path")
      })
    ).resolves.toMatchObject({ url: new URL("https://example.com/path") });
    expect(observeForwards).not.toHaveBeenCalled();
  });

  it("discovers ports through the target-bound metadata channel", async () => {
    const state = remoteState();
    const sessionId = Object.values(state.sessions)[0].id;
    const inspectPorts = vi.fn(async () => ({
      type: "ports.inspected" as const,
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1",
        sessionId
      },
      ports: [3_000, 5_173, 8_080, 9_000]
    }));
    const provider = createRemotePortProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: {
        inspectPorts,
        observeForwards: vi.fn(),
        reconcileForwards: vi.fn(),
        closeWorkspaceForwards: vi.fn()
      } as never,
      lifecycle: {} as RemoteLifecycleRuntime,
      getState: () => state,
      queue: createRemoteForwardQueue()
    });

    await expect(provider.list(sessionId)).resolves.toEqual([
      3_000, 5_173, 8_080
    ]);
    expect(inspectPorts).toHaveBeenCalledWith({
      targetId: "target_1",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1",
        sessionId
      }
    });
  });
});

function remoteState(): AppState {
  const state = createInitialState("/tmp");
  const window = state.windows[state.activeWindowId];
  const workspace = state.workspaces[window.activeWorkspaceId];
  const pane = state.panes[workspace.activePaneId];
  const surface = state.surfaces[pane.activeSurfaceId];
  workspace.id = "workspace_1";
  delete state.workspaces[window.activeWorkspaceId];
  state.workspaces.workspace_1 = workspace;
  window.activeWorkspaceId = workspace.id;
  window.workspaceOrder = [workspace.id];
  pane.workspaceId = workspace.id;
  workspace.location = workspaceLocation(
    { kind: "ssh", targetId: "target_1" },
    "/home/kmux"
  );
  state.sessions[
    requireTerminalSurfaceContent(surface).sessionId
  ].runtimeMetadata.cwd = locatedPathForTarget(
    { kind: "ssh", targetId: "target_1" },
    "/home/kmux"
  );
  return state;
}
