import { terminalSurfaceVmContent } from "@kmux/proto";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmux,
  createSandbox,
  launchKmuxWithSandbox,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test.skip(
  process.platform !== "darwin" && process.platform !== "linux",
  "shell integration regression requires a supported POSIX desktop"
);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCompletionMarker(
  firstPart: string,
  secondPart: string
): { command: string; output: string } {
  return {
    command:
      `printf '%s%s\\n' ${shellQuote(firstPart)} ` + shellQuote(secondPart),
    output: `${firstPart}${secondPart}`
  };
}

function createGitFixtureRepo(root: string): string {
  const repoDir = join(root, "branch-refresh-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], {
    cwd: repoDir,
    stdio: "ignore"
  });
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

const zshPath = resolveOptionalShellPath("zsh");
const fishPath = resolveOptionalShellPath("fish");
const shellCases: Array<{ path: string; skipReason?: string }> = [
  {
    path: zshPath ?? "zsh",
    skipReason: zshPath ? undefined : "zsh is not installed"
  },
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

    const repoEntered = shellCompletionMarker("__KMUX_REPO_", "ENTERED__");
    const branchSwitched = shellCompletionMarker(
      "__KMUX_BRANCH_",
      "SWITCHED__"
    );
    const repoLeft = shellCompletionMarker("__KMUX_REPO_", "LEFT__");
    const fixture = createSandbox(`kmux-e2e-shell-integration-${shellName}-`);
    const zshPrecmdSentinelPath =
      shellName === "zsh"
        ? join(fixture.profileRoot, "zsh-existing-precmd-hook")
        : undefined;
    if (zshPrecmdSentinelPath) {
      writeFileSync(
        join(fixture.shellHomeDir, ".zshrc"),
        [
          "fpath=()",
          "function _kmux_e2e_existing_precmd() {",
          `  print -r -- invoked >> ${shellQuote(zshPrecmdSentinelPath)}`,
          "}",
          "precmd_functions+=(_kmux_e2e_existing_precmd)",
          ""
        ].join("\n"),
        "utf8"
      );
    }
    const launched = await launchKmuxWithSandbox(fixture, {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: shellPath
      }
    });

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
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeStatus === "running" &&
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.shellInputReady === true
          );
        },
        "initial shell should be ready for terminal input",
        10_000
      );

      const workspaceId = runningView.activeWorkspace.id;
      const activePaneId = runningView.activeWorkspace.activePaneId;
      const activeSurfaceId =
        runningView.activeWorkspace.panes[activePaneId].activeSurfaceId;

      if (zshPrecmdSentinelPath) {
        await expect
          .poll(() => existsSync(zshPrecmdSentinelPath), {
            message: "existing zsh precmd hook should remain registered",
            timeout: 10_000
          })
          .toBe(true);
      }

      await page.evaluate(
        ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
        {
          surfaceId: activeSurfaceId,
          text: `cd ${shellQuote(repoDir)} && ` + `${repoEntered.command}\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        repoEntered.output,
        10_000
      );

      const repoView = await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeMetadata.cwd === repoDir &&
            row?.cwd === repoDir &&
            row?.branch === expectedBranch &&
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeMetadata.gitRepository?.root === repoDir &&
            row?.gitRepository?.root === repoDir
          );
        },
        "sidebar cwd and branch should follow repo navigation",
        10_000
      );

      expect(
        terminalSurfaceVmContent(
          repoView.activeWorkspace.surfaces[activeSurfaceId]
        )?.runtimeMetadata.cwd
      ).toBe(repoDir);
      expect(
        repoView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.branch
      ).toBe(expectedBranch);
      expect(
        terminalSurfaceVmContent(
          repoView.activeWorkspace.surfaces[activeSurfaceId]
        )?.runtimeMetadata.gitRepository
      ).toMatchObject({ root: repoDir, linkedWorktree: false });
      expect(
        repoView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.gitRepository
      ).toMatchObject({ root: repoDir, linkedWorktree: false });

      const switchedBranch = "kmux-e2e-branch-refresh";
      await page.evaluate(
        ({ surfaceId, text }) => window.kmux.sendText(surfaceId, text),
        {
          surfaceId: activeSurfaceId,
          text:
            `git switch -c ${shellQuote(switchedBranch)} && ` +
            `${branchSwitched.command}\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        branchSwitched.output,
        10_000
      );

      await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeMetadata.cwd === repoDir &&
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
          text:
            `cd ${shellQuote(sandbox.shellHomeDir)} && ` +
            `${repoLeft.command}\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        repoLeft.output,
        10_000
      );

      const homeView = await waitForView(
        page,
        (view) => {
          const row = view.workspaceRows.find(
            (entry) => entry.workspaceId === workspaceId
          );
          return (
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeMetadata.cwd === sandbox.shellHomeDir &&
            row?.cwd === sandbox.shellHomeDir &&
            row?.branch === undefined &&
            terminalSurfaceVmContent(
              view.activeWorkspace.surfaces[activeSurfaceId]
            )?.runtimeMetadata.gitRepository === undefined &&
            row?.gitRepository === undefined
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
      expect(
        homeView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.gitRepository
      ).toBeUndefined();
    } finally {
      await closeKmux(launched);
    }
  });
}

test("kmux preserves zsh login startup files while wrapping zsh", async () => {
  test.skip(
    process.platform !== "darwin",
    "zsh login startup preservation is macOS-specific"
  );
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
          terminalSurfaceVmContent(
            view.activeWorkspace.surfaces[activeSurfaceId]
          )?.runtimeStatus === "running"
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
  test.skip(
    process.platform !== "darwin",
    "zsh history restoration is macOS-specific"
  );
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
          terminalSurfaceVmContent(
            view.activeWorkspace.surfaces[activeSurfaceId]
          )?.runtimeStatus === "running"
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
        text: 'print -r -- "__KMUX_HISTORY__ HISTFILE=$HISTFILE COUNT=${#history} MATCH=${history[(r)echo kmux-history-proof*]}"\r'
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
