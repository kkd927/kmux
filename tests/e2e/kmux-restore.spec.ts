import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  dispatch,
  forceKillKmuxApp,
  getView,
  launchKmuxWithSandbox,
  waitForView
} from "./helpers";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }

    throw error;
  }
}

test("unclean shutdown reuses the saved workspace snapshot on relaunch", async () => {
  const sandbox = createSandbox("kmux-restore-");
  let firstLaunch = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;

  try {
    const initial = await getView(firstLaunch.page);
    const initialWorkspaceCount = initial.workspaceRows.length;
    const appPid = firstLaunch.app.process().pid;

    await dispatch(firstLaunch.page, {
      type: "workspace.create",
      name: "restore workspace"
    });

    const afterWorkspace = await waitForView(
      firstLaunch.page,
      (view) =>
        view.workspaceRows.length === initialWorkspaceCount + 1 &&
        view.activeWorkspace.name === "restore workspace",
      "workspace should be created before restore"
    );

    await dispatch(firstLaunch.page, {
      type: "pane.split",
      paneId: afterWorkspace.activeWorkspace.activePaneId,
      direction: "right"
    });
    await waitForView(
      firstLaunch.page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "split should be reflected before relaunch"
    );

    expect(existsSync(join(sandbox.configDir, "state.json"))).toBe(true);
    await expect
      .poll(() => {
        if (!existsSync(join(sandbox.configDir, "state.json"))) {
          return false;
        }
        const stateJson = JSON.parse(
          readFileSync(join(sandbox.configDir, "state.json"), "utf8")
        ) as {
          snapshot?: {
            workspaces?: Record<string, { name?: string }>;
            panes?: Record<string, { workspaceId?: string }>;
            windows?: Record<string, { activeWorkspaceId?: string }>;
            activeWindowId?: string;
          };
        };
        const workspaceNames = Object.values(
          stateJson.snapshot?.workspaces ?? {}
        ).map((workspace) => workspace.name);
        const activeWindowId = stateJson.snapshot?.activeWindowId;
        const activeWorkspaceId =
          (activeWindowId
            ? stateJson.snapshot?.windows?.[activeWindowId]?.activeWorkspaceId
            : undefined) ?? "";
        const paneCount = Object.values(stateJson.snapshot?.panes ?? {}).filter(
          (pane) => pane.workspaceId === activeWorkspaceId
        ).length;
        return (
          workspaceNames.includes("restore workspace") && paneCount === 2
        );
      })
      .toBe(true);

    if (typeof appPid === "number") {
      await forceKillKmuxApp(firstLaunch);
      await expect
        .poll(() => (isProcessAlive(appPid) ? "alive" : "exited"))
        .toBe("exited");
    }

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows.some((row) => row.name === "restore workspace") &&
        Object.keys(view.activeWorkspace.panes).length === 2 &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.sessionState === "running"
        ),
      "crash recovery relaunch should reuse the saved workspace layout"
    );
    expect(
      restored.workspaceRows.some((row) => row.name === "restore workspace")
    ).toBeTruthy();
    expect(Object.keys(restored.activeWorkspace.panes)).toHaveLength(2);
  } finally {
    await closeKmuxApp(firstLaunch).catch(() => {});
    if (relaunch) {
      await closeKmuxApp(relaunch).catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
