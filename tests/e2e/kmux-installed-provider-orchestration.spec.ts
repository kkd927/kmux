import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { WorkflowRun } from "@kmux/orchestration";
import { createSnapshotStore } from "@kmux/persistence";

import {
  closeKmux,
  createSandbox,
  dispatch,
  getSurfaceSnapshot,
  launchKmuxWithSandbox,
  sendRpc,
  terminalInputForSurface
} from "./helpers";

test.skip(
  process.env.KMUX_RUN_INSTALLED_PROVIDER_ACCEPTANCE !== "1",
  "requires an installed and authenticated Agent CLI"
);

const provider =
  process.env.KMUX_INSTALLED_PROVIDER === "antigravity"
    ? {
        agentId: "antigravity" as const,
        executable: "agy",
        label: "AGY"
      }
    : {
        agentId: "copilot" as const,
        executable: "copilot",
        label: "Copilot"
      };

test(`installed ${provider.label} releases after focus changes and preserves its explicit result`, async () => {
  test.setTimeout(4 * 60_000);
  const sandbox = createSandbox(`kmux-installed-${provider.agentId}-`);
  const repository = path.resolve(".");
  const fixture = path.resolve(
    "tests/fixtures/orchestration-protocol-agent.mjs"
  );
  const completionGate = path.join(sandbox.profileRoot, "focus-checked");
  const executable = execFileSync(
    "sh",
    ["-lc", `command -v ${provider.executable}`],
    {
      encoding: "utf8"
    }
  ).trim();
  const actualHome = os.homedir();
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const userPath = [path.dirname(process.execPath), process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  writeFileSync(
    path.join(sandbox.shellHomeDir, ".zshrc"),
    `export PATH="$PATH":${quote(userPath)}\n`
  );
  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      HOME: actualHome,
      ...(provider.agentId === "copilot"
        ? {
            COPILOT_HOME: path.join(actualHome, ".copilot"),
            GH_CONFIG_DIR: path.join(actualHome, ".config", "gh")
          }
        : {}),
      KMUX_FIXTURE_REVIEW_FILE: "AGENTS.md",
      KMUX_FIXTURE_LIVE_AGENT: provider.agentId,
      PATH: userPath
    }
  });
  const { page } = launched;
  try {
    const initial = await page.evaluate(() => window.kmux.getShellState());
    await dispatch(page, {
      type: "settings.update",
      patch: {
        ...initial.settings,
        socketMode: "kmuxOnly",
        orchestrationWorkerPolicy: { succeeded: "release", failed: "retain" },
        agents: {
          ...initial.settings.agents,
          [provider.agentId]: {
            command: executable
          }
        }
      }
    });
    await dispatch(page, {
      type: "workspace.create",
      name: `Installed ${provider.label} orchestration`,
      cwd: repository
    });
    const state = await page.evaluate(() => window.kmux.getShellState());
    const paneId = state.activeWorkspacePaneTree.activePaneId;
    const coordinatorSurfaceId =
      state.activeWorkspacePaneTree.panes[paneId]!.activeSurfaceId;
    const input = terminalInputForSurface(page, coordinatorSurfaceId);
    await input.pressSequentially(
      `${quote(process.execPath)} ${quote(fixture)} codex --fixture-coordinator --fixture-completion-gate ${quote(completionGate)}`
    );
    await input.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await getSurfaceSnapshot(page, coordinatorSurfaceId, {
              includeRawOutputTail: true
            })
          )?.rawOutputTail,
        { timeout: 10_000 }
      )
      .toContain("codex fixture Agent ready");
    await input.pressSequentially(
      `Ask installed ${provider.label} for one review and synthesize its explicit result.`
    );
    await input.press("Enter");

    let observedWorkerCwd: string | undefined;
    let observedWorkerCols: number | undefined;
    await expect
      .poll(
        async () => {
          const runs = (await page.evaluate(() =>
            window.kmux.orchestration({ method: "orchestration.run.list" })
          )) as ReadonlyArray<{ runId: string }>;
          if (!runs.length) return false;
          const run = (await page.evaluate(
            (runId) =>
              window.kmux.orchestration({
                method: "orchestration.run.get",
                params: { runId }
              }),
            runs.at(-1)!.runId
          )) as WorkflowRun;
          const worker = Object.values(run.dispatches)[0];
          if (!worker?.execution) return false;
          const snapshot = await getSurfaceSnapshot(
            page,
            worker.execution.surfaceId
          );
          observedWorkerCwd = snapshot?.cwd;
          observedWorkerCols = snapshot?.cols;
          return (
            observedWorkerCwd === repository &&
            (provider.agentId !== "copilot" ||
              (observedWorkerCols !== undefined && observedWorkerCols <= 70))
          );
        },
        { timeout: 30_000 }
      )
      .toBe(true);

    await expect
      .poll(
        async () =>
          (
            await getSurfaceSnapshot(page, coordinatorSurfaceId, {
              includeRawOutputTail: true
            })
          )?.rawOutputTail,
        { timeout: 3 * 60_000, intervals: [500, 1_000, 2_000] }
      )
      .toContain("WORKER_RESULT_READY:");
    const completedOutput = (await getSurfaceSnapshot(
      page,
      coordinatorSurfaceId,
      {
        includeRawOutputTail: true
      }
    ))!.rawOutputTail!;
    const completed = JSON.parse(
      completedOutput.match(/WORKER_RESULT_READY: (\{[^\r\n]+\})/u)![1]!
    ) as { runId: string; worker: { dispatchId: string } };
    const readCompletedWorker = async () => {
      const run = await page.evaluate(
        (runId) =>
          window.kmux.orchestration({
            method: "orchestration.run.get",
            params: { runId }
          }) as Promise<WorkflowRun>,
        completed.runId
      );
      return run.dispatches[completed.worker.dispatchId]!;
    };
    const beforeFocus = await readCompletedWorker();
    expect(beforeFocus.terminalState).toBe("reclaimable");
    await dispatch(page, {
      type: "surface.focus",
      surfaceId: beforeFocus.execution!.surfaceId
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "Installed Worker focus observation",
      cwd: repository
    });
    await dispatch(page, {
      type: "workspace.select",
      workspaceId: state.activeWorkspace.id
    });
    await dispatch(page, {
      type: "surface.focus",
      surfaceId: coordinatorSurfaceId
    });
    expect((await readCompletedWorker()).terminalState).toBe("reclaimable");
    writeFileSync(completionGate, "checked\n");

    await expect
      .poll(
        async () =>
          (
            await getSurfaceSnapshot(page, coordinatorSurfaceId, {
              includeRawOutputTail: true
            })
          )?.rawOutputTail,
        { timeout: 3 * 60_000, intervals: [500, 1_000, 2_000] }
      )
      .toMatch(/COORDINATOR_SYNTHESIS:|Fixture Agent failed:/u);
    const coordinatorOutput = (
      await getSurfaceSnapshot(page, coordinatorSurfaceId, {
        includeRawOutputTail: true
      })
    )?.rawOutputTail;
    const runs = (await page.evaluate(() =>
      window.kmux.orchestration({ method: "orchestration.run.list" })
    )) as ReadonlyArray<{ runId: string }>;
    const run = (await page.evaluate(
      (runId) =>
        window.kmux.orchestration({
          method: "orchestration.run.get",
          params: { runId }
        }),
      runs.at(-1)!.runId
    )) as WorkflowRun;
    const workers = Object.values(run.dispatches);
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    const workerSnapshot = await getSurfaceSnapshot(
      page,
      worker.execution!.surfaceId,
      { includeRawOutputTail: true }
    );
    const coordinatorSession = Object.values(
      createSnapshotStore(path.join(sandbox.stateDir, "state.json")).load()
        ?.sessions ?? {}
    ).find((session) => session.surfaceId === coordinatorSurfaceId);
    if (!coordinatorSession)
      throw new Error("Coordinator session is not saved");
    const archivedHistory = await sendRpc<{
      vt?: string;
      rawOutputTail?: string;
      cwd?: string;
      archived?: boolean;
      status?: string;
    }>(sandbox.socketPath, "orchestration.worker.read", {
      dispatchId: worker.dispatchId,
      lines: 10000,
      maxBytes: 1024 * 1024,
      authToken: coordinatorSession.authToken
    });
    if (
      !coordinatorOutput?.includes(
        "COORDINATOR_SYNTHESIS: reviewed 1 explicit Worker results in the original terminal"
      )
    ) {
      throw new Error(
        `Installed ${provider.label} did not return an explicit result. Attempt: ${JSON.stringify(
          run.attempts[worker.attemptId]
        )}\nWorker VT:\n${workerSnapshot?.vt ?? archivedHistory?.vt ?? "<unavailable>"}\nWorker raw output:\n${workerSnapshot?.rawOutputTail ?? archivedHistory?.rawOutputTail ?? "<unavailable>"}`
      );
    }
    expect(worker.selectedAgentId).toBe(provider.agentId);
    expect(observedWorkerCwd).toBe(repository);
    if (provider.agentId === "copilot")
      expect(observedWorkerCols).toBeLessThanOrEqual(70);
    expect(archivedHistory).toMatchObject({
      archived: true,
      status: "available"
    });
    const results = Object.values(run.attemptResults);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: "succeeded",
      executionReceipt: { dispatchId: worker.dispatchId }
    });
    expect(results[0]?.summary).toContain("stable");
    expect(run.messages.map((message) => message.kind)).toEqual(
      expect.arrayContaining(["question", "reply"])
    );
    expect(worker.terminalState).toBe("released");
    expect(
      workerSnapshot?.rawOutputTail ??
        archivedHistory?.rawOutputTail ??
        archivedHistory?.vt
    ).toContain("worker-done");
    expect(workerSnapshot).toBeNull();
    expect(
      Object.values(run.dispatches).filter(
        (dispatch) => dispatch.terminalState === "reclaimable"
      )
    ).toEqual([]);
    expect(
      await getSurfaceSnapshot(page, coordinatorSurfaceId, {
        includeRawOutputTail: true
      })
    ).not.toBeNull();
  } finally {
    await closeKmux(launched);
  }
});
