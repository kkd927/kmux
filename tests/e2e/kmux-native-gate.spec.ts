import path from "node:path";
import { expect, test } from "@playwright/test";
import type { WorkflowRun } from "@kmux/orchestration";
import {
  closeKmux,
  createSandbox,
  dispatch,
  getSurfaceSnapshot,
  launchKmuxWithSandbox,
  terminalInputForSurface
} from "./helpers";

test("native CLI decision Tasks are discoverable in the Run UI and block Workers until user selection", async () => {
  const sandbox = createSandbox("kmux-native-decision-");
  const fixture = path.resolve(
    "tests/fixtures/orchestration-protocol-agent.mjs"
  );
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
          }
        }
      }
    });
    await dispatch(page, {
      type: "workspace.create",
      name: "Native decision",
      cwd: sandbox.shellHomeDir
    });
    const state = await page.evaluate(() => window.kmux.getShellState());
    const sid =
      state.activeWorkspacePaneTree.panes[
        state.activeWorkspacePaneTree.activePaneId
      ]!.activeSurfaceId;
    const input = terminalInputForSurface(page, sid);
    const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    await input.pressSequentially(
      `${quote(process.execPath)} ${quote(fixture)} codex --fixture-native-decision`
    );
    await input.press("Enter");
    const output = async () =>
      (await getSurfaceSnapshot(page, sid, { includeRawOutputTail: true }))
        ?.rawOutputTail ?? "";
    await expect.poll(output).toContain("codex fixture Agent ready");
    await input.pressSequentially(
      "Choose before starting the dependent Worker"
    );
    await input.press("Enter");
    await expect.poll(output).toContain("GATE_UI_READY:");
    const rid = JSON.parse(
      (await output()).match(/GATE_UI_READY: (\{[^\r\n]+\})/u)![1]!
    ).runId as string;
    const read = () =>
      page.evaluate(
        (runId) =>
          window.kmux.orchestration({
            method: "orchestration.run.get",
            params: { runId }
          }) as Promise<WorkflowRun>,
        rid
      );
    await expect.poll(async () => (await read()).status).toBe("waiting-gate");
    expect(Object.values((await read()).dispatches)).toHaveLength(0);
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("region", { name: "Runs awaiting a decision" })
      .getByRole("button", { name: "Native decision acceptance" })
      .click();
    const inspector = page.getByRole("dialog", { name: "Orchestration Run" });
    await expect(
      inspector.getByText("Choose the candidate to verify", { exact: true })
    ).toBeVisible();
    await inspector.getByRole("button", { name: "A", exact: true }).click();
    await expect
      .poll(output, { timeout: 20_000 })
      .toContain("GATE_UI_COMPLETE:");
    const run = await read();
    expect(run.status).toBe("succeeded");
    expect(Object.values(run.gates)).toMatchObject([
      { state: "resolved", resolution: "A", resolvedBy: "user:local" }
    ]);
    expect(Object.values(run.dispatches)).toMatchObject([
      { terminalState: "released", terminalHistory: { status: "available" } }
    ]);
    expect(run.graph.authoringState).toBe("sealed");
  } finally {
    await closeKmux(launched);
  }
});
