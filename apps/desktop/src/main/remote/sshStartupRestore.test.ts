import { describe, expect, it, vi } from "vitest";

import { createInitialState, workspaceLocation } from "@kmux/core";

import {
  collectSshStartupTargets,
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
      collectSshStartupTargets({
        state,
        retained: [
          {
            resourceKey: { targetId: "target_retained" },
            processState: "running"
          },
          {
            resourceKey: { targetId: "target_termination" },
            processState: "running",
            termination: { operationId: "termination_1" }
          },
          {
            resourceKey: { targetId: "target_workspace" },
            processState: "running",
            termination: { operationId: "termination_2" }
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
      {
        targetId: "target_conversion",
        mode: "interactive-restore"
      },
      {
        targetId: "target_pending",
        mode: "non-interactive-maintenance"
      },
      {
        targetId: "target_termination",
        mode: "non-interactive-maintenance"
      },
      {
        targetId: "target_workspace",
        mode: "interactive-restore"
      }
    ]);
  });

  it("deduplicates plans, preserves interactive priority, and contains failures", async () => {
    const onFailure = vi.fn();
    const restored: Array<{ targetId: string; mode: string }> = [];
    const result = await restoreSshStartupTargets({
      targets: [
        {
          targetId: "target_b",
          mode: "non-interactive-maintenance"
        },
        { targetId: "target_a", mode: "interactive-restore" },
        { targetId: "target_b", mode: "interactive-restore" }
      ],
      async restoreTarget(targetId, mode) {
        restored.push({ targetId, mode });
        if (targetId === "target_b") throw new Error("offline");
      },
      onFailure
    });

    expect(
      restored.sort((left, right) =>
        left.targetId.localeCompare(right.targetId)
      )
    ).toEqual([
      { targetId: "target_a", mode: "interactive-restore" },
      { targetId: "target_b", mode: "interactive-restore" }
    ]);
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
