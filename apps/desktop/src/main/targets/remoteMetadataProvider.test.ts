import { requireTerminalSurfaceContent } from "@kmux/core";

import {
  applyAction,
  createInitialState,
  workspaceLocation,
  type RemotePath
} from "@kmux/core";
import { describe, expect, it, vi } from "vitest";

import type { TargetServiceSet } from "./contracts";
import { createRemoteMetadataProvider } from "./remoteMetadataProvider";
import {
  createTargetServiceRegistry,
  type RemotePathDecoder,
  type RemotePathResolver
} from "./targetServiceRegistry";

describe("remote metadata provider", () => {
  it("projects target-bound Git and port metadata only while session/cwd still match", async () => {
    const { decode, resolve } = remotePathCodec("target_1");
    const cwd = decode("/srv/repo/worktree");
    const state = remoteState(cwd);
    const dispatchAppAction = vi.fn((action) => applyAction(state, action));
    const provider = createRemoteMetadataProvider({
      targetId: "target_1",
      git: {
        inspect: vi.fn(async () => ({
          repository: {
            root: decode("/srv/repo/worktree"),
            gitDir: decode("/srv/repo/.git/worktrees/feature"),
            commonGitDir: decode("/srv/repo/.git"),
            linkedWorktree: true
          },
          branch: "feature",
          dirtyEntries: [],
          dirtyEntriesTruncated: false
        }))
      } as never,
      ports: {
        list: vi.fn(async () => [3_000, 5_173])
      } as never,
      getState: () => state,
      dispatchAppAction,
      resolveRemotePath: resolve
    });
    const surface = Object.values(state.surfaces)[0];

    provider.refresh({ surfaceId: surface.id, cwd });
    await vi.waitFor(() => {
      expect(
        state.sessions[requireTerminalSurfaceContent(surface).sessionId]
          .runtimeMetadata.branch
      ).toBe("feature");
    });

    const metadata =
      state.sessions[requireTerminalSurfaceContent(surface).sessionId]
        .runtimeMetadata;
    expect(metadata.ports).toEqual([3_000, 5_173]);
    expect(metadata.gitRepository).toMatchObject({
      root: { kind: "ssh", targetId: "target_1" },
      commonGitDir: { kind: "ssh", targetId: "target_1" },
      linkedWorktree: true
    });
    expect(state.workspaces.workspace_1.detectedWorktree).toMatchObject({
      path: { kind: "ssh", targetId: "target_1" },
      repoRoot: { kind: "ssh", targetId: "target_1" },
      branch: "feature"
    });
  });

  it("drops an asynchronous result after the surface cwd changes", async () => {
    const { decode, resolve } = remotePathCodec("target_1");
    const cwd = decode("/srv/old");
    const state = remoteState(cwd);
    let finishInspection!: (value: {
      branch: string;
      dirtyEntries: string[];
      dirtyEntriesTruncated: boolean;
    }) => void;
    const inspection = new Promise<{
      branch: string;
      dirtyEntries: string[];
      dirtyEntriesTruncated: boolean;
    }>((resolveInspection) => {
      finishInspection = resolveInspection;
    });
    const dispatchAppAction = vi.fn((action) => applyAction(state, action));
    const provider = createRemoteMetadataProvider({
      targetId: "target_1",
      git: { inspect: vi.fn(() => inspection) } as never,
      ports: { list: vi.fn(async () => []) } as never,
      getState: () => state,
      dispatchAppAction,
      resolveRemotePath: resolve
    });
    const surface = Object.values(state.surfaces)[0];

    provider.refresh({ surfaceId: surface.id, cwd });
    state.sessions[
      requireTerminalSurfaceContent(surface).sessionId
    ].runtimeMetadata.cwd = {
      kind: "ssh",
      targetId: "target_1",
      path: decode("/srv/new")
    };
    finishInspection({
      branch: "stale",
      dirtyEntries: [],
      dirtyEntriesTruncated: false
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });
});

function remoteState(cwd: RemotePath) {
  const state = createInitialState("/bin/zsh");
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
    "/srv/repo"
  );
  state.sessions[
    requireTerminalSurfaceContent(surface).sessionId
  ].runtimeMetadata.cwd = {
    kind: "ssh",
    targetId: "target_1",
    path: cwd
  };
  return state;
}

function remotePathCodec(targetId: string): {
  decode: RemotePathDecoder;
  resolve: RemotePathResolver;
} {
  let decode!: RemotePathDecoder;
  let resolve!: RemotePathResolver;
  const registry = createTargetServiceRegistry({
    local: {} as TargetServiceSet<never>,
    remote: (_targetId, resolver, decoder) => {
      resolve = resolver;
      decode = decoder;
      return {} as TargetServiceSet<RemotePath>;
    }
  });
  registry.resolve({ kind: "ssh", targetId });
  return { decode, resolve };
}
