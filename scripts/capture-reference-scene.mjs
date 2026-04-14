import {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

import {_electron as electron} from "@playwright/test";

const cwd = globalThis.process.cwd();
const appRoot = path.join(cwd, "apps", "desktop");
const outputPath = path.join(
  cwd,
  "output",
  "playwright",
  "reference-scene.png"
);

const profileRoot = mkdtempSync(path.join(tmpdir(), "kmux-reference-scene-"));
const configDir = path.join(profileRoot, "config");
const runtimeDir = path.join(profileRoot, "runtime");
mkdirSync(configDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const app = await electron.launch({
  args: [appRoot],
  env: {
    ...globalThis.process.env,
    NODE_ENV: "test",
    KMUX_CONFIG_DIR: configDir,
    KMUX_RUNTIME_DIR: runtimeDir
  }
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1277, height: 1179 });

  const getView = () => page.evaluate(() => globalThis.window.kmux.getView());
  const dispatch = (action) =>
    page.evaluate(
      (payload) => globalThis.window.kmux.dispatch(payload),
      action
    );
  const sendText = (surfaceId, text) =>
    page.evaluate(
      ({ id, value }) => globalThis.window.kmux.sendText(id, value),
      { id: surfaceId, value: text }
    );
  const renderBlock = async (surfaceId, content) => {
    const shellSafe = content
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replaceAll("\n", "\\n");
    await sendText(
      surfaceId,
      `printf '%s' $'\\033[2J\\033[H${shellSafe}\\n'\r`
    );
    await page.waitForTimeout(180);
  };

  const waitFor = async (predicate, timeoutMs = 6000) => {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
      const view = await getView();
      if (predicate(view)) {
        return view;
      }
      last = view;
      await page.waitForTimeout(50);
    }
    throw new Error(
      `Timed out waiting for reference scene state: ${JSON.stringify(last)}`
    );
  };

  await dispatch({
    type: "workspace.rename",
    workspaceId: (await getView()).activeWorkspace.id,
    name: "hq"
  });
  let view = await getView();
  await dispatch({
    type: "sidebar.setStatus",
    workspaceId: view.activeWorkspace.id,
    text: "Claude is waiting for your input"
  });

  await dispatch({ type: "workspace.create", name: "cli/unix socket" });
  view = await waitFor(
    (next) => next.activeWorkspace.name === "cli/unix socket"
  );
  const activeWorkspaceId = view.activeWorkspace.id;

  await dispatch({
    type: "sidebar.setStatus",
    workspaceId: activeWorkspaceId,
    text: "Implemented and pushed: socket focus-policy refactor"
  });
  await dispatch({
    type: "sidebar.setProgress",
    workspaceId: activeWorkspaceId,
    progress: { value: 0.68, label: "Core parity pass" }
  });
  await dispatch({
    type: "sidebar.log",
    workspaceId: activeWorkspaceId,
    level: "info",
    message: "Validated tests and updated terminal layout polish"
  });

  const queueWorkspace = async (name, status, cwdSummary) => {
    await dispatch({ type: "workspace.create", name });
    const nextView = await waitFor(
      (next) => next.activeWorkspace.name === name
    );
    await dispatch({
      type: "sidebar.setStatus",
      workspaceId: nextView.activeWorkspace.id,
      text: status
    });
    if (cwdSummary) {
      await dispatch({
        type: "surface.metadata",
        surfaceId:
          nextView.activeWorkspace.panes[nextView.activeWorkspace.activePaneId]
            .activeSurfaceId,
        cwd: cwdSummary
      });
    }
  };

  await queueWorkspace(
    "ssh",
    "Opened draft PR for socket focus-policy refactor",
    "~/work/kmux-hq"
  );
  await queueWorkspace(
    "cmd shift t tabs",
    "Follow-up PR is open and implemented",
    "~/work/kmux-hq"
  );
  await queueWorkspace(
    "posthog",
    "Created worktree feat-posthog-version-ads",
    "~/work/kmux-hq"
  );
  await queueWorkspace(
    "mark tab as unread",
    "Merged PR and verified follow-up commit",
    "~/work/kmux-hq"
  );
  await dispatch({ type: "workspace.select", workspaceId: activeWorkspaceId });
  view = await waitFor((next) => next.activeWorkspace.id === activeWorkspaceId);

  let paneId = view.activeWorkspace.activePaneId;
  await dispatch({ type: "pane.split", paneId, direction: "right" });
  view = await waitFor(
    (next) => Object.keys(next.activeWorkspace.panes).length === 2
  );

  const topLeftPaneId = paneId;
  const topRightPaneId = view.activeWorkspace.activePaneId;

  await dispatch({
    type: "pane.split",
    paneId: topRightPaneId,
    direction: "down"
  });
  view = await waitFor(
    (next) => Object.keys(next.activeWorkspace.panes).length === 3
  );

  const paneIds = Object.keys(view.activeWorkspace.panes);
  const bottomRightPaneId =
    paneIds.find((id) => id !== topLeftPaneId && id !== topRightPaneId) ??
    topRightPaneId;

  await dispatch({
    type: "surface.rename",
    surfaceId: view.activeWorkspace.panes[topLeftPaneId].activeSurfaceId,
    title: "codex --dangerously-bypass..."
  });
  await dispatch({
    type: "surface.rename",
    surfaceId: view.activeWorkspace.panes[topRightPaneId].activeSurfaceId,
    title: "Claude Code"
  });
  await dispatch({
    type: "surface.rename",
    surfaceId: view.activeWorkspace.panes[bottomRightPaneId].activeSurfaceId,
    title: "bun dev"
  });
  await dispatch({
    type: "surface.create",
    paneId: bottomRightPaneId,
    title: "tab 2"
  });

  view = await waitFor(
    (next) =>
      next.activeWorkspace.panes[bottomRightPaneId].surfaceIds.length === 2
  );

  const leftSurfaceId =
    view.activeWorkspace.panes[topLeftPaneId].activeSurfaceId;
  const rightSurfaceId =
    view.activeWorkspace.panes[topRightPaneId].activeSurfaceId;
  const bottomSurfaceIds =
    view.activeWorkspace.panes[bottomRightPaneId].surfaceIds;
  const firstBottomSurfaceId = bottomSurfaceIds[0];
  const secondBottomSurfaceId = bottomSurfaceIds[1];

  await renderBlock(
    leftSurfaceId,
    [
      "Implemented and pushed:",
      "- socket focus-policy refactor across v1/v2 command dispatch",
      "- rename-tab CLI command with env-default targeting",
      "- command audit todo tracking",
      "",
      "Validated:",
      "- tests_v2/test_rename_tab_cli_parity.py (pass)",
      "- tests_v2/test_cli_non_focus_commands_preserve_workspace.py (pass)",
      "- tests_v2/test_rename_window_workspace_parity.py (pass)"
    ].join("\n")
  );
  await renderBlock(
    rightSurfaceId,
    [
      "52 -- The comment that will be posted",
      "53 ++ Issue number and title",
      "54 ++ The exact comment that will be posted",
      "",
      "Phase 1: automatic review summary",
      "Phase 2: post comments after user confirms"
    ].join("\n")
  );
  await renderBlock(
    firstBottomSurfaceId,
    [
      "Next.js 16.1.6 (Turbopack)",
      "Local: http://localhost:3777",
      "Ready in 729ms",
      "GET / 200 in 820ms",
      "GET /docs/getting-started 200 in 467ms"
    ].join("\n")
  );
  await dispatch({ type: "surface.focus", surfaceId: secondBottomSurfaceId });
  await renderBlock(
    secondBottomSurfaceId,
    [
      "git status",
      "On branch issue-230-cli-unix-socket-lag",
      "Your branch is up to date with origin/main",
      "",
      "nothing to commit, working tree clean"
    ].join("\n")
  );
  await dispatch({ type: "surface.focus", surfaceId: firstBottomSurfaceId });

  await dispatch({
    type: "notification.create",
    workspaceId: activeWorkspaceId,
    paneId: topRightPaneId,
    surfaceId: rightSurfaceId,
    title: "App hanging 2s+ on main thread",
    message: "Reduce main-thread lag from repeated socket metadata updates"
  });

  await page.waitForTimeout(900);
  await page.screenshot({ path: outputPath, fullPage: true });
  globalThis.console.log(`reference scene captured at ${outputPath}`);
} finally {
  await app.close();
  rmSync(profileRoot, { force: true, recursive: true });
}
