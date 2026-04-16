import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
      const { page, workspaceRoot, sandbox } = launched;
      const expectedBranch = execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: workspaceRoot,
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
          text: `cd ${shellQuote(workspaceRoot)}; pwd\r`
        }
      );

      await waitForSurfaceSnapshotContains(
        page,
        activeSurfaceId,
        workspaceRoot,
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
              workspaceRoot &&
            row?.cwd === workspaceRoot &&
            row?.branch === expectedBranch
          );
        },
        "sidebar cwd and branch should follow repo navigation",
        10_000
      );

      expect(repoView.activeWorkspace.surfaces[activeSurfaceId]?.cwd).toBe(
        workspaceRoot
      );
      expect(
        repoView.workspaceRows.find(
          (entry) => entry.workspaceId === workspaceId
        )?.branch
      ).toBe(expectedBranch);

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
