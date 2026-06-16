import { expect, test } from "@playwright/test";

import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  dispatch,
  getRuntimeEnv,
  getSurfaceSnapshot,
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

test("packaged kmux smoke flow validates launch, shell attach, CLI, notifications, and clean relaunch", async () => {
  const sandbox = createSandbox("kmux-packaged-smoke-");
  const launched = await launchKmuxWithSandbox(sandbox, {
    executablePath: packagedExecutablePath
  });
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;
  const { page, cliPath, workspaceRoot } = launched;

  try {
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1277, height: 1179 });

    const runtimeEnv = await getRuntimeEnv(page);
    expect(runtimeEnv.KMUX_PACKAGED_EXECUTABLE_PATH).toBe(
      packagedExecutablePath
    );
    if (process.env.APPIMAGE) {
      expect(runtimeEnv.APPIMAGE).toBe(process.env.APPIMAGE);
      expect(runtimeEnv.APPIMAGE).toBe(packagedExecutablePath);
      if (process.env.APPIMAGE_EXTRACT_AND_RUN) {
        expect(runtimeEnv.APPIMAGE_EXTRACT_AND_RUN).toBe(
          process.env.APPIMAGE_EXTRACT_AND_RUN
        );
      }
    }

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
        socketMode: "allowAll"
      }
    });

    const configured = await waitForView(
      page,
      (view) => view.settings.socketMode === "allowAll",
      "packaged smoke should enable allow-all socket mode"
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

    await dispatch(page, {
      type: "pane.split",
      paneId: activePaneId,
      direction: "right"
    });
    await waitForView(
      page,
      (view) => Object.keys(view.activeWorkspace.panes).length === 2,
      "packaged smoke split should create a second pane"
    );
    const originalRows = page.locator(
      `[data-testid="terminal-${activeSurfaceId}"] .xterm-rows`
    );
    await expect(originalRows).toContainText(marker);

    await dispatch(page, {
      type: "surface.create",
      paneId: activePaneId,
      title: "packaged hidden continuity"
    });
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[activePaneId].activeSurfaceId !==
        activeSurfaceId,
      "packaged smoke should switch away from the original surface"
    );

    const hiddenMarker = "packaged-smoke-hidden-output";
    runCliJson(cliPath, workspaceRoot, sandbox.socketPath, [
      "surface",
      "send-text",
      "--surface",
      activeSurfaceId,
      "--text",
      `echo ${hiddenMarker}\r`
    ]);
    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      hiddenMarker,
      15_000
    );
    await expect(originalRows).not.toContainText(hiddenMarker);

    await dispatch(page, {
      type: "surface.focus",
      surfaceId: activeSurfaceId
    });
    await waitForView(
      page,
      (view) =>
        view.activeWorkspace.panes[activePaneId].activeSurfaceId ===
        activeSurfaceId,
      "packaged smoke should restore focus to the original surface"
    );
    await expect(originalRows).toContainText(marker);
    await expect(originalRows).toContainText(hiddenMarker);
    const restoredSnapshot = await getSurfaceSnapshot(page, activeSurfaceId);
    expect(restoredSnapshot?.vt).toContain(marker);
    expect(restoredSnapshot?.vt).toContain(hiddenMarker);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(originalRows).toContainText(marker);
    await expect(originalRows).toContainText(hiddenMarker);
    const resizedSnapshot = await getSurfaceSnapshot(page, activeSurfaceId);
    expect(resizedSnapshot?.vt).toContain(marker);
    expect(resizedSnapshot?.vt).toContain(hiddenMarker);

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

    await closeKmuxApp(launched);

    relaunch = await launchKmuxWithSandbox(sandbox, {
      executablePath: packagedExecutablePath
    });
    const relaunched = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows.some(
          (row) => row.name === "packaged smoke workspace"
        ) &&
        view.activeWorkspace.name === "packaged smoke workspace" &&
        Object.keys(view.activeWorkspace.panes).length === 2 &&
        Boolean(view.activeWorkspace.surfaces[activeSurfaceId]) &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) => surface.title === "packaged hidden continuity"
        ) &&
        view.settings.socketMode === "allowAll" &&
        view.activeWorkspace.surfaces[
          view.activeWorkspace.panes[view.activeWorkspace.activePaneId]
            .activeSurfaceId
        ]?.sessionState === "running",
      "packaged relaunch should restore workspace continuity while preserving persisted settings",
      15_000
    );

    expect(
      relaunched.workspaceRows.some(
        (row) => row.name === "packaged smoke workspace"
      )
    ).toBe(true);
    expect(Object.keys(relaunched.activeWorkspace.panes)).toHaveLength(2);
    expect(relaunched.activeWorkspace.surfaces[activeSurfaceId]).toBeDefined();
    const relaunchedSurfaceId =
      relaunched.activeWorkspace.panes[relaunched.activeWorkspace.activePaneId]
        .activeSurfaceId;
    const relaunchedMarker = "packaged-smoke-relaunched-ok";
    runCliJson(cliPath, workspaceRoot, sandbox.socketPath, [
      "surface",
      "send-text",
      "--surface",
      relaunchedSurfaceId,
      "--text",
      `echo ${relaunchedMarker}\r`
    ]);
    const relaunchedSnapshot = await waitForSurfaceSnapshotContains(
      relaunch.page,
      relaunchedSurfaceId,
      relaunchedMarker,
      15_000
    );
    expect(relaunchedSnapshot).toContain(relaunchedMarker);
  } finally {
    await closeKmuxApp(launched).catch(() => {});
    if (relaunch) {
      await closeKmuxApp(relaunch).catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
