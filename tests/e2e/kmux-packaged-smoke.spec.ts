import {expect, test} from "@playwright/test";

import {
    createSandbox,
    destroySandbox,
    dispatch,
    getView,
    launchKmuxWithSandbox,
    runCliJson,
    waitForSurfaceSnapshotContains,
    waitForView
} from "./helpers";

const packagedExecutablePath = process.env.KMUX_PACKAGED_EXECUTABLE_PATH;

test.skip(
  !packagedExecutablePath,
  "KMUX_PACKAGED_EXECUTABLE_PATH is required for packaged smoke tests"
);

test("packaged kmux smoke flow validates launch, shell attach, CLI, notifications, and restore", async () => {
  const sandbox = createSandbox("kmux-packaged-smoke-");
  const launched = await launchKmuxWithSandbox(sandbox, {
    executablePath: packagedExecutablePath
  });
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;
  const { page, cliPath, workspaceRoot } = launched;

  try {
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1277, height: 1179 });

    const initial = await getView(page);
    expect(initial.workspaceRows.length).toBeGreaterThan(0);

    await dispatch(page, {
      type: "workspace.create",
      name: "packaged smoke workspace"
    });

    const afterWorkspace = await waitForView(
      page,
      (view) =>
        view.workspaceRows.some(
          (row) => row.name === "packaged smoke workspace"
        ) && view.activeWorkspace.name === "packaged smoke workspace",
      "packaged workspace should be created"
    );

    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...afterWorkspace.settings,
        socketMode: "allowAll",
        startupRestore: true
      }
    });

    const configured = await waitForView(
      page,
      (view) =>
        view.settings.socketMode === "allowAll" && view.settings.startupRestore,
      "packaged smoke should enable socket mode and restore"
    );

    const activePaneId = configured.activeWorkspace.activePaneId;
    const activeSurfaceId =
      configured.activeWorkspace.panes[activePaneId].activeSurfaceId;
    const targetWorkspaceId = configured.activeWorkspace.id;
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.surfaces[activeSurfaceId]?.sessionState ===
        "running",
      "packaged shell should reach a running session state",
      15_000
    );

    const ping = runCliJson<{ pong: boolean }>(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      ["system", "ping"]
    );
    expect(ping.pong).toBe(true);

    const identify = runCliJson<{
      socketMode: string;
      capabilities: string[];
      activeWorkspaceId: string;
      activeSurfaceId: string;
    }>(cliPath, workspaceRoot, sandbox.socketPath, ["system", "identify"]);
    expect(identify.socketMode).toBe("allowAll");
    expect(identify.capabilities).toContain("surface.send_text");
    expect(identify.activeWorkspaceId).toBe(targetWorkspaceId);
    expect(identify.activeSurfaceId).toBe(activeSurfaceId);

    const workspaceList = runCliJson<
      Array<{ id: string; name: string; activePaneId: string }>
    >(cliPath, workspaceRoot, sandbox.socketPath, ["workspace", "list"]);
    expect(
      workspaceList.some(
        (workspace) =>
          workspace.id === targetWorkspaceId &&
          workspace.name === "packaged smoke workspace"
      )
    ).toBe(true);

    const currentWorkspace = runCliJson<{ id: string; name: string }>(
      cliPath,
      workspaceRoot,
      sandbox.socketPath,
      ["workspace", "current"]
    );
    expect(currentWorkspace.id).toBe(targetWorkspaceId);
    expect(currentWorkspace.name).toBe("packaged smoke workspace");

    const marker = "packaged-smoke-ok";
    runCliJson(cliPath, workspaceRoot, sandbox.socketPath, [
      "surface",
      "send-text",
      "--surface",
      activeSurfaceId,
      "--text",
      `echo ${marker}\r`
    ]);
    const snapshot = await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      marker,
      15_000
    );
    expect(snapshot).toContain(marker);

    runCliJson(cliPath, workspaceRoot, sandbox.socketPath, [
      "notification",
      "create",
      "--workspace",
      targetWorkspaceId,
      "--title",
      "packaged smoke notification",
      "--message",
      "packaged cli notification"
    ]);

    const notifications = runCliJson<
      Array<{ title: string; workspaceId: string; read: boolean }>
    >(cliPath, workspaceRoot, sandbox.socketPath, ["notification", "list"]);
    expect(
      notifications.some(
        (notification) =>
          notification.workspaceId === targetWorkspaceId &&
          notification.title === "packaged smoke notification"
      )
    ).toBe(true);

    const afterNotification = await waitForView(
      page,
      (view) =>
        view.notifications.some(
          (notification) =>
            notification.workspaceId === targetWorkspaceId &&
            notification.title === "packaged smoke notification"
        ),
      "packaged smoke notification should be visible in the renderer view"
    );
    expect(
      afterNotification.notifications.some(
        (notification) => notification.title === "packaged smoke notification"
      )
    ).toBe(true);

    await launched.app.close();

    relaunch = await launchKmuxWithSandbox(sandbox, {
      executablePath: packagedExecutablePath
    });
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows.some(
          (row) => row.name === "packaged smoke workspace"
        ) &&
        view.activeWorkspace.name === "packaged smoke workspace" &&
        view.settings.startupRestore &&
        view.activeWorkspace.surfaces[
          view.activeWorkspace.panes[view.activeWorkspace.activePaneId]
            .activeSurfaceId
        ]?.sessionState === "running",
      "packaged relaunch should restore the workspace snapshot",
      15_000
    );

    expect(
      restored.workspaceRows.some(
        (row) => row.name === "packaged smoke workspace"
      )
    ).toBe(true);
    const restoredSurfaceId =
      restored.activeWorkspace.panes[restored.activeWorkspace.activePaneId]
        .activeSurfaceId;
    const restoredMarker = "packaged-smoke-restored-ok";
    runCliJson(cliPath, workspaceRoot, sandbox.socketPath, [
      "surface",
      "send-text",
      "--surface",
      restoredSurfaceId,
      "--text",
      `echo ${restoredMarker}\r`
    ]);
    const restoredSnapshot = await waitForSurfaceSnapshotContains(
      relaunch.page,
      restoredSurfaceId,
      restoredMarker,
      15_000
    );
    expect(restoredSnapshot).toContain(restoredMarker);
  } finally {
    await launched.app.close().catch(() => {});
    if (relaunch) {
      await relaunch.app.close().catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
