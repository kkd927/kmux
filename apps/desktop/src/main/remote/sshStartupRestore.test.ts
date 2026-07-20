import { describe, expect, it, vi } from "vitest";

import { createInitialState, workspaceLocation } from "@kmux/core";

import {
  collectSshStartupTargetIds,
  restoreSshStartupTargets
} from "./sshStartupRestore";

describe("SSH startup restore", () => {
  it("collects desired and unfinished targets without reconnecting history only", () => {
    const initial = createInitialState();
    const workspaceId =
      initial.windows[initial.activeWindowId]!.activeWorkspaceId;
    const workspace = initial.workspaces[workspaceId]!;
    const state = {
      ...initial,
      workspaces: {
        ...initial.workspaces,
        [workspaceId]: {
          ...workspace,
          location: workspaceLocation(
            { kind: "ssh", targetId: "target_workspace" },
            "/srv/project"
          )
        }
      }
    };

    expect(
      collectSshStartupTargetIds({
        state,
        retained: [
          {
            resourceKey: { targetId: "target_retained" },
            processState: "running"
          },
          {
            resourceKey: { targetId: "target_exited" },
            processState: "exited"
          }
        ],
        conversions: [
          {
            state: "remote-created",
            workspaceResourceKey: { targetId: "target_conversion" }
          },
          {
            state: "cleanup-complete",
            workspaceResourceKey: { targetId: "target_complete" }
          }
        ],
        operations: [
          {
            intent: { resourceKey: { targetId: "target_pending" } }
          },
          {
            intent: { resourceKey: { targetId: "target_historical" } },
            result: { outcome: "succeeded" }
          }
        ]
      })
    ).toEqual([
      "target_conversion",
      "target_pending",
      "target_retained",
      "target_workspace"
    ]);
  });

  it("deduplicates restores, contains failures, and reports every target", async () => {
    const onFailure = vi.fn();
    const restored: string[] = [];
    const result = await restoreSshStartupTargets({
      targetIds: ["target_b", "target_a", "target_b"],
      async restoreTarget(targetId) {
        restored.push(targetId);
        if (targetId === "target_b") throw new Error("offline");
      },
      onFailure
    });

    expect(restored.sort()).toEqual(["target_a", "target_b"]);
    expect(result.connected).toEqual(["target_a"]);
    expect(result.failed).toMatchObject([
      { targetId: "target_b", error: { message: "offline" } }
    ]);
    expect(onFailure).toHaveBeenCalledWith(
      "target_b",
      expect.objectContaining({ message: "offline" })
    );
  });
});
