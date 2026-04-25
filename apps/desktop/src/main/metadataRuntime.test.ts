import { createInitialState } from "@kmux/core";
import { vi } from "vitest";

const { resolveGitBranch, resolveListeningPorts } = vi.hoisted(() => ({
  resolveGitBranch: vi.fn(),
  resolveListeningPorts: vi.fn()
}));

vi.mock("@kmux/metadata", () => ({
  resolveGitBranch,
  resolveListeningPorts
}));

import { createMetadataRuntime } from "./metadataRuntime";
import { BRANCH_ONLY_METADATA_REFRESH_DEBOUNCE_MS } from "./metadataRuntime";

async function flushMetadataRuntime(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("metadata runtime", () => {
  beforeEach(() => {
    resolveGitBranch.mockReset();
    resolveListeningPorts.mockReset();
  });

  it("refreshes only git branch metadata for branch-only prompt ticks", async () => {
    vi.useFakeTimers();
    const state = createInitialState("/bin/zsh");
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const session = state.sessions[surface.sessionId];
    surface.cwd = "/tmp/kmux";
    session.pid = 123;
    const dispatchAppAction = vi.fn();
    const env = { PATH: "/usr/bin:/bin" };
    resolveGitBranch.mockResolvedValue("feature/review");

    const runtime = createMetadataRuntime({
      getState: () => state,
      dispatchAppAction,
      env
    });

    try {
      runtime.refreshMetadata(surfaceId, "/tmp/kmux", 123, {
        branchOnly: true
      });
      runtime.refreshMetadata(surfaceId, "/tmp/kmux", 123, {
        branchOnly: true
      });

      expect(resolveGitBranch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        BRANCH_ONLY_METADATA_REFRESH_DEBOUNCE_MS
      );
      await flushMetadataRuntime();

      expect(resolveGitBranch).toHaveBeenCalledTimes(1);
      expect(resolveGitBranch).toHaveBeenCalledWith("/tmp/kmux", env, {
        bypassCache: true
      });
      expect(resolveListeningPorts).not.toHaveBeenCalled();
      expect(dispatchAppAction).toHaveBeenCalledWith({
        type: "surface.metadata",
        surfaceId,
        branch: "feature/review"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
