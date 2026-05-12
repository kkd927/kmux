import { applyAction, createInitialState } from "@kmux/core";
import { vi } from "vitest";

const { resolveGitBranch, resolveGitRepository, resolveListeningPorts } =
  vi.hoisted(() => ({
    resolveGitBranch: vi.fn(),
    resolveGitRepository: vi.fn(),
    resolveListeningPorts: vi.fn()
  }));

vi.mock("@kmux/metadata", () => ({
  resolveGitBranch,
  resolveGitRepository,
  resolveListeningPorts
}));

const { watch } = vi.hoisted(() => ({
  watch: vi.fn()
}));

vi.mock("node:fs", () => ({
  watch
}));

import { createMetadataRuntime } from "./metadataRuntime";

async function flushMetadataRuntime(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("metadata runtime", () => {
  beforeEach(() => {
    resolveGitBranch.mockReset();
    resolveGitRepository.mockReset();
    resolveListeningPorts.mockReset();
    watch.mockReset();
  });

  it("refreshes tracked surfaces when the repo HEAD changes", async () => {
    vi.useFakeTimers();
    const state = createInitialState("/bin/zsh");
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const session = state.sessions[surface.sessionId];
    surface.cwd = "/tmp/kmux";
    session.pid = 123;
    const dispatchAppAction = vi.fn();
    const env = { PATH: "/usr/bin:/bin" };
    let headListener:
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    const watcher = { close: vi.fn(), on: vi.fn() };
    watch.mockImplementation(
      (_path: string, _options: unknown, listener: typeof headListener) => {
        headListener = listener;
        return watcher;
      }
    );
    resolveGitRepository.mockResolvedValue({
      gitDir: "/tmp/kmux/.git",
      root: "/tmp/kmux"
    });
    resolveGitBranch
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("feature/external")
      .mockResolvedValueOnce("feature/external-2")
      .mockResolvedValueOnce("feature/external-3");
    resolveListeningPorts.mockResolvedValue([]);

    const runtime = createMetadataRuntime({
      getState: () => state,
      dispatchAppAction,
      env
    });

    try {
      runtime.refreshMetadata(surfaceId, "/tmp/kmux", 123);
      await flushMetadataRuntime();

      expect(watch).toHaveBeenCalledWith(
        "/tmp/kmux/.git",
        { persistent: false },
        expect.any(Function)
      );
      expect(dispatchAppAction).toHaveBeenCalledWith({
        type: "surface.metadata",
        surfaceId,
        branch: "main",
        ports: []
      });

      headListener?.("rename", "HEAD");
      await vi.advanceTimersByTimeAsync(100);
      await flushMetadataRuntime();

      expect(resolveGitBranch).toHaveBeenLastCalledWith("/tmp/kmux", env, {
        bypassCache: true
      });
      expect(dispatchAppAction).toHaveBeenLastCalledWith({
        type: "surface.metadata",
        surfaceId,
        branch: "feature/external"
      });

      dispatchAppAction.mockClear();
      headListener?.("rename", "index");
      headListener?.("rename", "FETCH_HEAD");
      await vi.advanceTimersByTimeAsync(100);
      await flushMetadataRuntime();
      expect(dispatchAppAction).not.toHaveBeenCalled();

      headListener?.("rename", "HEAD");
      await vi.advanceTimersByTimeAsync(100);
      await flushMetadataRuntime();
      expect(dispatchAppAction).toHaveBeenLastCalledWith({
        type: "surface.metadata",
        surfaceId,
        branch: "feature/external-2"
      });

      dispatchAppAction.mockClear();
      headListener?.("rename", null);
      await vi.advanceTimersByTimeAsync(100);
      await flushMetadataRuntime();
      expect(dispatchAppAction).toHaveBeenLastCalledWith({
        type: "surface.metadata",
        surfaceId,
        branch: "feature/external-3"
      });
    } finally {
      (runtime as { dispose?: () => void }).dispose?.();
      vi.useRealTimers();
    }
  });

  it("closes the repo watcher when a tracked surface is removed", async () => {
    const state = createInitialState("/bin/zsh");
    const surfaceId = Object.keys(state.surfaces)[0];
    state.surfaces[surfaceId].cwd = "/tmp/kmux";
    const watcher = { close: vi.fn(), on: vi.fn() };
    watch.mockReturnValue(watcher);
    resolveGitRepository.mockResolvedValue({
      gitDir: "/tmp/kmux/.git",
      root: "/tmp/kmux"
    });
    resolveGitBranch.mockResolvedValue("main");
    resolveListeningPorts.mockResolvedValue([]);

    const runtime = createMetadataRuntime({
      getState: () => state,
      dispatchAppAction: vi.fn()
    });

    runtime.refreshMetadata(surfaceId, "/tmp/kmux");
    await flushMetadataRuntime();

    delete state.surfaces[surfaceId];
    runtime.handleAppAction({
      type: "surface.close",
      surfaceId
    });

    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("untracks a surface from its previous repo as soon as its cwd changes", async () => {
    vi.useFakeTimers();
    const state = createInitialState("/bin/zsh");
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const firstSurfaceId = state.panes[paneId].activeSurfaceId;
    state.surfaces[firstSurfaceId].cwd = "/tmp/repo-a/first";
    applyAction(state, {
      type: "surface.create",
      paneId,
      title: "second",
      cwd: "/tmp/repo-a/second"
    });
    const secondSurfaceId = state.panes[paneId].activeSurfaceId;
    const dispatchAppAction = vi.fn();
    let headListener:
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    const watcher = { close: vi.fn(), on: vi.fn() };
    watch.mockImplementation(
      (_path: string, _options: unknown, listener: typeof headListener) => {
        headListener = listener;
        return watcher;
      }
    );
    resolveGitRepository.mockResolvedValue({
      gitDir: "/tmp/repo-a/.git",
      root: "/tmp/repo-a"
    });
    resolveGitBranch.mockResolvedValue("main");
    resolveListeningPorts.mockResolvedValue([]);

    const runtime = createMetadataRuntime({
      getState: () => state,
      dispatchAppAction
    });

    try {
      runtime.refreshMetadata(firstSurfaceId, "/tmp/repo-a/first");
      runtime.refreshMetadata(secondSurfaceId, "/tmp/repo-a/second");
      await flushMetadataRuntime();

      dispatchAppAction.mockClear();
      resolveGitBranch.mockClear();
      resolveGitBranch.mockResolvedValueOnce("repo-a-updated");
      state.surfaces[firstSurfaceId].cwd = "/tmp/repo-b";
      runtime.handleAppAction({
        type: "surface.metadata",
        surfaceId: firstSurfaceId,
        cwd: "/tmp/repo-b"
      });

      headListener?.("change", "HEAD");
      await vi.advanceTimersByTimeAsync(100);
      await flushMetadataRuntime();

      expect(resolveGitBranch).toHaveBeenCalledWith(
        "/tmp/repo-a/second",
        undefined,
        {
          bypassCache: true
        }
      );
      expect(dispatchAppAction).toHaveBeenCalledTimes(1);
      expect(dispatchAppAction).toHaveBeenCalledWith({
        type: "surface.metadata",
        surfaceId: secondSurfaceId,
        branch: "repo-a-updated"
      });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });
});
