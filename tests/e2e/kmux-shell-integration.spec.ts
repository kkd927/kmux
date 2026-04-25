import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmux,
  createSandbox,
  launchKmux,
  launchKmuxWithSandbox,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test.skip(
  process.platform !== "darwin",
  "shell integration regression is macOS-specific"
);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createGitFixtureRepo(root: string): string {
  const repoDir = join(root, "branch-refresh-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "kmux\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=kmux",
      "-c",
      "user.email=kmux@example.invalid",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: repoDir, stdio: "ignore" }
  );
  return repoDir;
}

function resolveOptionalShellPath(shellName: string): string | undefined {
  try {
    return (
      execFileSync("sh", ["-lc", `command -v ${shellName}`], {
        encoding: "utf8"
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

const fishPath = resolveOptionalShellPath("fish");
const shellCases: Array<{ path: string; skipReason?: string }> = [
  { path: "/bin/zsh" },
  { path: "/bin/bash" },
  {
    path: fishPath ?? "fish",
    skipReason: fishPath ? undefined : "fish is not installed"
  }
];

for (const shellCase of shellCases) {
  const shellPath = shellCase.path;
  const shellName = shellPath.split("/").pop() ?? shellPath;

  test(`kmux tracks cwd and branch changes for ${shellPath}`, async () => {
    test.skip(!!shellCase.skipReason, shellCase.skipReason ?? "");

    const launched = await launchKmux(
      `kmux-e2e-shell-integration-${shellName}-`,
      {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          SHELL: shellPath
        }
      }
    );

    try {
      const { page, sandbox } = launched;
      const repoDir = createGitFixtureRepo(sandbox.profileRoot);
      const expectedBranch = execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: repoDir,
          encoding: "utf8"
        }
      ).trim();

      const runningView = await waitForView(
        page,
        (view) => {
          const activePaneId = view.activeWorkspace.activePaneId;
          const activeSurfaceId =
            view.activeWorkspace.panes[activePaneId]?.activeSurfaceId;
          return (
            !!activeSurfaceId &&
            view.activeWorkspace.surfaces[activeSurfaceId]?.sessionState ===
              "running"
          );
        },
        "initial shell should reach a running session state",
        10_000
      );

      const workspaceId = runningView.activeWorkspace.id;
      const activePaneId = runningView.activeWorkspace.activePaneId;
      const activeSurfaceId =
        runningView.activeWorkspace.panes[activePaneId].activeSurfaceId;

      await page.evaluate(
        ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
        {
          surfaceId: activeSurfaceId,
          text: `cd ${shellQuote(repoDir)}; pwd\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        repoDir,
        10_000
      );

      const repoView = await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            view.activeWorkspace.surfaces[activeSurfaceId]?.cwd ===
              repoDir &&
            row?.cwd === repoDir &&
            row?.branch === expectedBranch
          );
        },
        "sidebar cwd and branch should follow repo navigation",
        10_000
      );

      expect(repoView.activeWorkspace.surfaces[activeSurfaceId]?.cwd).toBe(
        repoDir
      );
      expect(
        repoView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.branch
      ).toBe(expectedBranch);

      const switchedBranch = "kmux-e2e-branch-refresh";
      await page.evaluate(
        ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
        {
          surfaceId: activeSurfaceId,
          text:
            `git switch -c ${shellQuote(switchedBranch)}; ` +
            "printf '__KMUX_BRANCH_SWITCHED__\\n'\r"
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        "__KMUX_BRANCH_SWITCHED__",
        10_000
      );

      await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            view.activeWorkspace.surfaces[activeSurfaceId]?.cwd === repoDir &&
            row?.cwd === repoDir &&
            row?.branch === switchedBranch
          );
        },
        "sidebar branch should refresh after same-cwd git branch switch",
        10_000
      );

      await page.evaluate(
        ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
        {
          surfaceId: activeSurfaceId,
          text: `cd ${shellQuote(sandbox.shellHomeDir)}; pwd\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        sandbox.shellHomeDir,
        10_000
      );

      const homeView = await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            view.activeWorkspace.surfaces[activeSurfaceId]?.cwd ===
              sandbox.shellHomeDir &&
            row?.cwd === sandbox.shellHomeDir &&
            row?.branch === undefined
          );
        },
        "sidebar should clear branch after leaving the repo",
        10_000
      );

      expect(
        homeView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.branch
      ).toBeUndefined();
    } finally {
      await closeKmux(launched);
    }
  });
}

test("kmux preserves zsh login startup files while wrapping zsh", async () => {
  const sandbox = createSandbox("kmux-e2e-shell-integration-zlogin-");
  writeFileSync(
    join(sandbox.shellHomeDir, ".zlogin"),
    "export KMUX_E2E_ZLOGIN_MARKER=loaded\n",
    "utf8"
  );

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh"
    }
  });

  try {
    const { page } = launched;
    const runningView = await waitForView(
      page,
      (view) => {
        const activePaneId = view.activeWorkspace.activePaneId;
        const activeSurfaceId =
          view.activeWorkspace.panes[activePaneId]?.activeSurfaceId;
        return (
          !!activeSurfaceId &&
          view.activeWorkspace.surfaces[activeSurfaceId]?.sessionState ===
            "running"
        );
      },
      "initial zsh shell should reach a running session state",
      10_000
    );

    const activePaneId = runningView.activeWorkspace.activePaneId;
    const activeSurfaceId =
      runningView.activeWorkspace.panes[activePaneId].activeSurfaceId;

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text: 'printf "__KMUX_ZLOGIN__=%s\\n" "$KMUX_E2E_ZLOGIN_MARKER"\r'
      }
    );

    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "__KMUX_ZLOGIN__=loaded",
      10_000
    );
  } finally {
    await closeKmux(launched);
  }
});

test("kmux restores zsh history before loading the user zshrc", async () => {
  const sandbox = createSandbox("kmux-e2e-shell-integration-history-");
  writeFileSync(
    sandbox.shellHistoryPath,
    ": 1710000000:0;echo kmux-history-proof\n",
    "utf8"
  );

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh"
    }
  });

  try {
    const { page } = launched;
    const runningView = await waitForView(
      page,
      (view) => {
        const activePaneId = view.activeWorkspace.activePaneId;
        const activeSurfaceId =
          view.activeWorkspace.panes[activePaneId]?.activeSurfaceId;
        return (
          !!activeSurfaceId &&
          view.activeWorkspace.surfaces[activeSurfaceId]?.sessionState ===
            "running"
        );
      },
      "initial zsh shell should reach a running session state",
      10_000
    );

    const activePaneId = runningView.activeWorkspace.activePaneId;
    const activeSurfaceId =
      runningView.activeWorkspace.panes[activePaneId].activeSurfaceId;

    await page.evaluate(
      ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
      {
        surfaceId: activeSurfaceId,
        text:
          'print -r -- "__KMUX_HISTORY__ HISTFILE=$HISTFILE COUNT=${#history} MATCH=${history[(r)echo kmux-history-proof*]}"\r'
      }
    );

    await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      `__KMUX_HISTORY__ HISTFILE=${sandbox.shellHistoryPath}`,
      10_000
    );

    const snapshot = await waitForSurfaceSnapshotContains(
      page,
      activeSurfaceId,
      "MATCH=echo kmux-history-proof",
      10_000
    );

    expect(snapshot).toMatch(/COUNT=[1-9][0-9]*/);
  } finally {
    await closeKmux(launched);
  }
});
