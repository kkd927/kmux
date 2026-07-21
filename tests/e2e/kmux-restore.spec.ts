import { terminalSurfaceVmContent } from "@kmux/proto";

import { requireTerminalSurfaceContent } from "@kmux/core";

import process from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import {
  applyAction,
  createInitialState,
  locatedPathForTarget
} from "@kmux/core";

import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  dispatch,
  forceKillKmuxApp,
  getView,
  launchKmuxWithSandbox,
  terminalInputForSurface,
  waitForView
} from "./helpers";

import type { KmuxSandbox } from "./helpers";

function seedPriorReleaseSnapshot(sandbox: KmuxSandbox) {
  const shell = process.env.SHELL || "/bin/sh";
  const snapshot = createInitialState(shell);
  const firstWorkspaceId =
    snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;
  applyAction(snapshot, {
    type: "workspace.rename",
    workspaceId: firstWorkspaceId,
    name: "restored alpha"
  });
  applyAction(snapshot, {
    type: "workspace.create",
    name: "restored beta"
  });
  const secondWorkspaceId =
    snapshot.windows[snapshot.activeWindowId].activeWorkspaceId;

  snapshot.settings.restoreWorkspacesAfterQuit = true;
  snapshot.settings.warnBeforeQuit = false;
  for (const surface of Object.values(snapshot.surfaces)) {
    snapshot.sessions[
      requireTerminalSurfaceContent(surface).sessionId
    ].runtimeMetadata.cwd = locatedPathForTarget(
      { kind: "local" },
      sandbox.shellHomeDir
    );
  }
  for (const session of Object.values(snapshot.sessions)) {
    session.launch = {
      cwd: locatedPathForTarget({ kind: "local" }, sandbox.shellHomeDir),
      shell
    };
    session.runtimeStatus.processState = "running";
    session.shellInputReady = true;
    session.pid = 42_000;
  }
  const exitedSession = Object.values(snapshot.sessions)[0];
  exitedSession.runtimeStatus.processState = "exited";
  exitedSession.shellInputReady = false;
  delete exitedSession.pid;
  exitedSession.exitCode = 137;

  const workspaces = [firstWorkspaceId, secondWorkspaceId].map(
    (workspaceId) => ({
      id: workspaceId,
      name: snapshot.workspaces[workspaceId].name,
      surfaceIds: Object.values(snapshot.panes)
        .filter((pane) => pane.workspaceId === workspaceId)
        .flatMap((pane) => pane.surfaceIds)
    })
  );
  const envelope = {
    version: 1,
    cleanShutdown: true,
    restoreOnLaunch: true,
    snapshot
  };
  const persisted = JSON.stringify(envelope);
  expect(persisted).not.toMatch(/"(?:runtimeEpoch|epoch|sequence)"\s*:/);
  writeFileSync(join(sandbox.stateDir, "state.json"), persisted, "utf8");
  writeFileSync(
    join(sandbox.configDir, "settings.json"),
    JSON.stringify(snapshot.settings, null, 2),
    "utf8"
  );
  return { exitedSurfaceId: exitedSession.surfaceId, workspaces };
}

function terminalProbeCommand(marker: string): string {
  const octal = Array.from(
    marker,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`
  ).join("");
  return `printf '${octal}\\012'`;
}

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

async function probeVisibleRestoredShell(
  page: Page,
  workspaceId: string,
  surfaceId: string,
  marker: string
): Promise<void> {
  await dispatch(page, { type: "workspace.select", workspaceId });
  await dispatch(page, { type: "surface.focus", surfaceId });
  await waitForView(
    page,
    (view) =>
      view.activeWorkspace.id === workspaceId &&
      terminalSurfaceVmContent(view.activeWorkspace.surfaces[surfaceId])
        ?.runtimeStatus === "running" &&
      terminalSurfaceVmContent(view.activeWorkspace.surfaces[surfaceId])
        ?.shellInputReady === true &&
      Object.values(view.activeWorkspace.panes).some(
        (pane) => pane.activeSurfaceId === surfaceId
      ),
    `restored shell should become ready: ${surfaceId}`,
    10_000
  );

  const terminal = page.getByTestId(`terminal-${surfaceId}`);
  await expect(terminal).toHaveAttribute(
    "data-terminal-stream-ready",
    /^attach_/,
    { timeout: 10_000 }
  );
  const input = terminalInputForSurface(page, surfaceId);
  await expect(input).toBeVisible();
  await input.pressSequentially(terminalProbeCommand(marker));
  await input.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(marker, {
    timeout: 10_000
  });
}

test("clean update restore respawns prior-release shells on the direct terminal stream", async () => {
  const sandbox = createSandbox("kmux-update-restore-");
  const fixture = seedPriorReleaseSnapshot(sandbox);
  const launched = await launchKmuxWithSandbox(sandbox);

  try {
    const restored = await waitForView(
      launched.page,
      (view) =>
        view.settings.restoreWorkspacesAfterQuit === true &&
        fixture.workspaces.every((workspace) =>
          view.workspaceRows.some(
            (row) =>
              row.workspaceId === workspace.id && row.name === workspace.name
          )
        ),
      "prior-release workspace snapshot should restore after update",
      10_000
    );
    expect(restored.workspaceRows).toHaveLength(fixture.workspaces.length);

    let probeIndex = 0;
    for (const workspace of fixture.workspaces) {
      for (const surfaceId of workspace.surfaceIds) {
        await probeVisibleRestoredShell(
          launched.page,
          workspace.id,
          surfaceId,
          surfaceId === fixture.exitedSurfaceId
            ? "kmuxrestoreexited"
            : `kmuxrestore${probeIndex++}`
        );
      }
    }
  } finally {
    await closeKmuxApp(launched).catch(() => {});
    destroySandbox(sandbox);
  }
});

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

    const statePath = join(sandbox.stateDir, "state.json");
    expect(existsSync(statePath)).toBe(true);
    await expect
      .poll(() => {
        if (!existsSync(statePath)) {
          return false;
        }
        const stateJson = JSON.parse(readFileSync(statePath, "utf8")) as {
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
        return workspaceNames.includes("restore workspace") && paneCount === 2;
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
          (surface) =>
            terminalSurfaceVmContent(surface)?.runtimeStatus === "running"
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
