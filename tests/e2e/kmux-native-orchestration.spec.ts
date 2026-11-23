import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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

test("native CLI preserves release across focus changes, retains user input, and archives reuse and stop", async () => {
  test.setTimeout(90_000);
  const sandbox = createSandbox("kmux-native-lifecycle-");
  const fixture = path.resolve(
    "tests/fixtures/orchestration-protocol-agent.mjs"
  );
  const focusGate = path.join(sandbox.profileRoot, "focus-checked");
  const takeoverGate = path.join(sandbox.profileRoot, "takeover-checked");
  const launched = await launchKmuxWithSandbox(sandbox);
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
          antigravity: {
            command: process.execPath,
            args: [fixture, "antigravity", "--fixture-focus-reporting"]
          },
          copilot: {
            command: process.execPath,
            args: [fixture, "copilot", "--fixture-focus-reporting"]
          }
        }
      }
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "Native lifecycle",
      cwd: sandbox.shellHomeDir
    });
    const state = await page.evaluate(() => window.kmux.getShellState());
    const pane =
      state.activeWorkspacePaneTree.panes[
        state.activeWorkspacePaneTree.activePaneId
      ]!;
    const surfaceId = pane.activeSurfaceId;
    const input = terminalInputForSurface(page, surfaceId);
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    await input.pressSequentially(
      `${quote(process.execPath)} ${quote(fixture)} codex --fixture-lifecycle --fixture-focus-gate ${quote(focusGate)} --fixture-takeover-gate ${quote(takeoverGate)}`
    );
    await input.press("Enter");
    const output = async () =>
      (
        await getSurfaceSnapshot(page, surfaceId, {
          includeRawOutputTail: true
        })
      )?.rawOutputTail ?? "";
    await expect
      .poll(output, { timeout: 10_000 })
      .toContain("codex fixture Agent ready");
    await input.pressSequentially(
      "Exercise sequential Tasks, reuse, and stop through the native CLI."
    );
    await input.press("Enter");
    const waitForWorker = async (marker: string) => {
      await expect.poll(output, { timeout: 30_000 }).toContain(`${marker}:`);
      const match = (await output()).match(
        new RegExp(`${marker}: (\\{[^\\r\\n]+\\})`, "u")
      );
      return JSON.parse(match![1]!) as {
        runId: string;
        worker: { dispatchId: string };
      };
    };
    const readRun = (runId: string) =>
      page.evaluate(
        (runId) =>
          window.kmux.orchestration({
            method: "orchestration.run.get",
            params: { runId }
          }) as Promise<WorkflowRun>,
        runId
      );
    const focus = await waitForWorker("LIFECYCLE_FOCUS_READY");
    const firstWorker = (await readRun(focus.runId)).dispatches[
      focus.worker.dispatchId
    ]!;
    expect(firstWorker.terminalState).toBe("reclaimable");
    const workerSurface = firstWorker.execution!.surfaceId;
    const before = await getSurfaceSnapshot(page, workerSurface, {
      includeRawOutputTail: true
    });
    await dispatch(page, { type: "surface.focus", surfaceId: workerSurface });
    await terminalInputForSurface(page, workerSurface).focus();
    await input.focus();
    await terminalInputForSurface(page, workerSurface).focus();
    const focusedState = await page.evaluate(() => window.kmux.getShellState());
    const splits = Object.values(
      focusedState.activeWorkspacePaneTree.nodes
    ).filter((node) => node.kind === "split");
    for (const split of splits) {
      await dispatch(page, {
        type: "pane.setSplitRatio",
        splitNodeId: split.id,
        ratio: 0.35
      });
    }
    await dispatch(page, {
      type: "workspace.create",
      name: "Focus observation",
      cwd: sandbox.shellHomeDir
    });
    await dispatch(page, {
      type: "workspace.select",
      workspaceId: focusedState.activeWorkspace.id
    });
    for (const split of splits) {
      await dispatch(page, {
        type: "pane.setSplitRatio",
        splitNodeId: split.id,
        ratio: split.ratio
      });
    }
    await dispatch(page, { type: "surface.focus", surfaceId: workerSurface });
    await expect
      .poll(
        async () =>
          (
            await getSurfaceSnapshot(page, workerSurface, {
              includeRawOutputTail: true
            })
          )?.rawOutputTail
      )
      .toContain("FIXTURE_FOCUS_REPORT_O");
    const after = await getSurfaceSnapshot(page, workerSurface, {
      includeRawOutputTail: true
    });
    expect(after?.rawOutputTail).toContain("FIXTURE_FOCUS_REPORT_I");
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(after?.rawOutputTail?.startsWith(before!.rawOutputTail!)).toBe(true);
    expect(
      (await readRun(focus.runId)).dispatches[focus.worker.dispatchId]!
        .terminalState
    ).toBe("reclaimable");
    await dispatch(page, { type: "surface.focus", surfaceId });
    writeFileSync(focusGate, "checked\n");

    const takeover = await waitForWorker("LIFECYCLE_TAKEOVER_READY");
    const completed = (await readRun(takeover.runId)).dispatches[
      takeover.worker.dispatchId
    ]!;
    expect(completed.terminalState).toBe("reclaimable");
    await dispatch(page, {
      type: "surface.focus",
      surfaceId: completed.execution!.surfaceId
    });
    await terminalInputForSurface(
      page,
      completed.execution!.surfaceId
    ).pressSequentially("keep this terminal");
    await expect
      .poll(
        async () =>
          (await readRun(takeover.runId)).dispatches[
            takeover.worker.dispatchId
          ]!.terminalDisposition
      )
      .toBe("user-takeover");
    await dispatch(page, { type: "surface.focus", surfaceId });
    writeFileSync(takeoverGate, "checked\n");
    await expect
      .poll(output, { timeout: 60_000 })
      .toMatch(/LIFECYCLE_ACCEPTANCE:|Fixture Agent failed:/u);
    const text = await output();
    expect(text).not.toContain("Fixture Agent failed:");
    const match = text.match(/LIFECYCLE_ACCEPTANCE: (\{[^\r\n]+\})/u);
    expect(match).not.toBeNull();
    const receipt = JSON.parse(match![1]!);
    const run = (await page.evaluate(
      (runId) =>
        window.kmux.orchestration({
          method: "orchestration.run.get",
          params: { runId }
        }),
      receipt.runId
    )) as WorkflowRun;
    expect(Object.keys(run.tasks)).toHaveLength(4);
    expect(Object.keys(run.graph.nodes)).toHaveLength(4);
    expect(run.graph.authoringState).toBe("sealed");
    expect(run.mailboxConsumers.coordinator?.activeDelivery).toBeUndefined();
    const second = run.dispatches[receipt.second.dispatchId]!;
    const reused = run.dispatches[receipt.reused.dispatchId]!;
    expect(reused.execution).toMatchObject({
      surfaceId: second.execution!.surfaceId,
      sessionId: second.execution!.sessionId,
      generation: second.execution!.generation
    });
    expect(run.attempts[receipt.held.attemptId]!.status).toBe("canceled");
    expect(receipt).toMatchObject({
      firstArchived: true,
      previousArchived: true,
      stoppedArchived: true
    });
    expect(run.dispatches[receipt.first.dispatchId]!.terminalState).toBe(
      "released"
    );
    expect(reused.terminalState).toBe("retained");
    expect(
      run.dispatches[receipt.held.dispatchId]!.terminalHistory
    ).toBeDefined();
    expect(
      await getSurfaceSnapshot(
        page,
        run.dispatches[receipt.held.dispatchId]!.execution!.surfaceId
      )
    ).toBeNull();
  } finally {
    await closeKmux(launched);
  }
});

test("an existing Agent terminal starts two native Workers as tabs in one right pane and receives both explicit results", async () => {
  test.setTimeout(90_000);
  const sandbox = createSandbox("kmux-native-orchestration-");
  const repository = path.join(sandbox.profileRoot, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  writeFileSync(
    path.join(repository, "REVIEW_INPUT.md"),
    "Persist intent before an external write.\n"
  );
  execFileSync("git", ["add", "REVIEW_INPUT.md"], { cwd: repository });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=kmux fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture baseline"
    ],
    { cwd: repository }
  );
  const fixture = path.resolve(
    "tests/fixtures/orchestration-protocol-agent.mjs"
  );
  const placementGate = path.join(sandbox.profileRoot, "placement-checked");
  const launched = await launchKmuxWithSandbox(sandbox);
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
          antigravity: {
            command: process.execPath,
            args: [fixture, "antigravity"]
          },
          copilot: {
            command: process.execPath,
            args: [fixture, "copilot"]
          }
        }
      }
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "Native orchestration",
      cwd: sandbox.shellHomeDir
    });
    const state = await page.evaluate(() => window.kmux.getShellState());
    const paneId = state.activeWorkspacePaneTree.activePaneId;
    const coordinatorSurfaceId =
      state.activeWorkspacePaneTree.panes[paneId]!.activeSurfaceId;
    const input = terminalInputForSurface(page, coordinatorSurfaceId);
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    await input.pressSequentially(`cd ${quote(repository)}`);
    await input.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await getSurfaceSnapshot(page, coordinatorSurfaceId, {
              includeRawOutputTail: true
            })
          )?.cwd,
        { timeout: 10_000 }
      )
      .toBe(repository);
    await input.pressSequentially(
      `${quote(process.execPath)} ${quote(fixture)} codex --fixture-coordinator --fixture-placement-gate ${quote(placementGate)}`
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
      "Analyze the change, ask two independent Workers, and review both results."
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
        { timeout: 30_000 }
      )
      .toContain("WORKER_PLACEMENT_READY");
    const workerLayout = (
      await page.evaluate(() => window.kmux.getShellState())
    ).activeWorkspacePaneTree;
    const workerPanes = Object.values(workerLayout.panes).filter(
      (pane) => pane.id !== paneId
    );
    expect(Object.keys(workerLayout.panes)).toHaveLength(2);
    expect(workerLayout.panes[paneId]!.surfaceIds).toEqual([
      coordinatorSurfaceId
    ]);
    expect(workerPanes[0]!.surfaceIds).toHaveLength(2);
    expect(workerLayout.nodes[workerLayout.rootNodeId]).toMatchObject({
      kind: "split",
      axis: "vertical"
    });
    writeFileSync(placementGate, "checked\n");

    try {
      await expect
        .poll(
          async () =>
            (
              await getSurfaceSnapshot(page, coordinatorSurfaceId, {
                includeRawOutputTail: true
              })
            )?.rawOutputTail,
          { timeout: 60_000 }
        )
        .toContain(
          "COORDINATOR_SYNTHESIS: reviewed 2 explicit Worker results in the original terminal"
        );
    } catch (error) {
      const currentRuns = (await page.evaluate(() =>
        window.kmux.orchestration({ method: "orchestration.run.list" })
      )) as ReadonlyArray<{ runId: string }>;
      const currentRun = currentRuns.at(-1)
        ? ((await page.evaluate(
            (runId) =>
              window.kmux.orchestration({
                method: "orchestration.run.get",
                params: { runId }
              }),
            currentRuns.at(-1)!.runId
          )) as WorkflowRun)
        : undefined;
      const workerOutput = currentRun
        ? await Promise.all(
            Object.values(currentRun.dispatches).map(async (worker) => ({
              dispatchId: worker.dispatchId,
              attempt: currentRun.attempts[worker.attemptId],
              snapshot: worker.execution
                ? await getSurfaceSnapshot(page, worker.execution.surfaceId, {
                    includeRawOutputTail: true
                  }).then((snapshot) => ({
                    cwd: snapshot?.cwd,
                    vt: snapshot?.vt,
                    rawOutputTail: snapshot?.rawOutputTail
                  }))
                : null
            }))
          )
        : [];
      const coordinatorSnapshot = await getSurfaceSnapshot(
        page,
        coordinatorSurfaceId,
        { includeRawOutputTail: true }
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRun context:\n${JSON.stringify(
          {
            workspaceId: currentRun?.workspaceId,
            coordinatorAttachment: currentRun?.coordinatorAttachment,
            coordinatorCwd: coordinatorSnapshot?.cwd,
            workers: workerOutput
          },
          null,
          2
        )}`
      );
    }

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
    const dispatches = Object.values(run.dispatches);
    expect(dispatches).toHaveLength(2);
    expect(new Set(workerPanes[0]!.surfaceIds)).toEqual(
      new Set(dispatches.map((worker) => worker.execution?.surfaceId))
    );
    expect(Object.values(run.attemptResults)).toHaveLength(2);
    expect(
      Object.values(run.attemptResults).every(
        (result) =>
          result.data !== null &&
          typeof result.data === "object" &&
          !Array.isArray(result.data) &&
          result.data.cwd === realpathSync.native(repository)
      )
    ).toBe(true);
    expect(
      new Set(dispatches.map((item) => item.execution?.surfaceId)).size
    ).toBe(2);
    expect(
      dispatches.every(
        (item) => item.execution?.surfaceId !== coordinatorSurfaceId
      )
    ).toBe(true);
    const coordinatorOutput = (await getSurfaceSnapshot(
      page,
      coordinatorSurfaceId,
      { includeRawOutputTail: true }
    ))!.rawOutputTail!;
    const readReceipts = [
      ...coordinatorOutput.matchAll(/WORKER_HISTORY: (\{[^\r\n]+\})/gu)
    ].map((match) => JSON.parse(match[1]!));
    expect(readReceipts).toHaveLength(2);
    const coordinatorSession = Object.values(
      createSnapshotStore(path.join(sandbox.stateDir, "state.json")).load()
        ?.sessions ?? {}
    ).find((session) => session.surfaceId === coordinatorSurfaceId);
    if (!coordinatorSession)
      throw new Error("Coordinator session is not saved");
    await expect(
      sendRpc(sandbox.socketPath, "orchestration.worker.read", {
        dispatchId: dispatches[0]!.dispatchId,
        authToken: coordinatorSession.authToken
      })
    ).rejects.toThrow("authenticated live terminal process");
    for (const worker of dispatches) {
      expect(worker.lastHeartbeat?.phase).toBe(
        "Review complete; submitting findings"
      );
      expect(run.attemptResults[worker.attemptId]?.reportPath).toContain(
        ".kmux-fixture-report-"
      );
      expect(
        readReceipts.find((entry) => entry.dispatchId === worker.dispatchId)
      ).toMatchObject({
        source: "terminal",
        status: "available",
        archived: true,
        hasDispatchMarker: true,
        hasWorkerDone: true
      });
      expect(worker.terminalState).toBe("released");
    }
  } finally {
    await closeKmux(launched);
  }
});
