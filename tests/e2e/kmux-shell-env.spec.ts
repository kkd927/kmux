import {execFileSync} from "node:child_process";

import {expect, test} from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test.skip(process.platform !== "darwin", "shell env regression is macOS-specific");

test("kmux resolves login shell env for child processes and terminal sessions on macOS", async () => {
  const launched = await launchKmux("kmux-e2e-shell-env-", {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh"
    }
  });

  try {
    const {page, workspaceRoot} = launched;
    const initial = await getView(page);
    const expectedBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: workspaceRoot,
        encoding: "utf8"
      }
    ).trim();

    await dispatch(page, {
      type: "workspace.create",
      name: "shell env",
      cwd: workspaceRoot
    });

    const activeView = await waitForView(
      page,
      (view) => view.workspaceRows.length === initial.workspaceRows.length + 1,
      "workspace with repo cwd should be created"
    );
    const activeWorkspaceId = activeView.activeWorkspace.id;

    const branchView = await waitForView(
      page,
      (view) =>
        view.workspaceRows.some(
          (row) =>
            row.workspaceId === activeWorkspaceId &&
            row.branch === expectedBranch
        ),
      "workspace branch should resolve through app-side git metadata"
    );

    expect(
      branchView.workspaceRows.find(
        (row) => row.workspaceId === activeWorkspaceId
      )?.branch
    ).toBe(expectedBranch);

    const activeRow = page.locator(`[data-workspace-id="${activeWorkspaceId}"]`);
    await expect(activeRow.locator("[data-workspace-branch]")).toHaveText(
      expectedBranch
    );
    await expect(activeRow.locator("[data-workspace-branch-icon]")).toHaveCount(
      1
    );

    const activePaneId = branchView.activeWorkspace.activePaneId;
    const activeSurfaceId =
      branchView.activeWorkspace.panes[activePaneId].activeSurfaceId;

    await page.evaluate(
      ({surfaceId, text}) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: [
          "printf '__KMUX_LOGIN__=%s\\n' $options[login]",
          "printf '__KMUX_PATH__=%s\\n' \"$PATH\"",
          "command -v git"
        ].join("; ") + "\r"
      }
    );

    const loginSnapshot = await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "/usr/bin/git",
      10_000
    );
    expect(loginSnapshot).toContain("__KMUX_LOGIN__=on");
    expect(loginSnapshot).toContain("__KMUX_PATH__=");
    expect(loginSnapshot).toContain("/usr/local/bin");
    expect(loginSnapshot).toContain("/usr/bin/git");
  } finally {
    await closeKmux(launched);
  }
});
