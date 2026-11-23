import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  compileFlowEditorDocument,
  type FlowEditorDocumentV1,
  type JsonValue,
  type WorkflowRun
} from "@kmux/orchestration";
const document = JSON.parse(
  readFileSync(
    path.resolve("packages/orchestration/fixtures/caller-review.workflow.json"),
    "utf8"
  )
);
import {
  closeKmux,
  createSandbox,
  dispatch,
  getSurfaceSnapshot,
  launchKmuxWithSandbox,
  terminalInputForSurface
} from "./helpers";

for (const limit of [false, true])
  test(`existing calling Agent completes a saved review Workflow (${limit ? "final review requires user judgment" : "clean second review"})`, async ({}, testInfo) => {
    test.setTimeout(100000);
    const sandbox = createSandbox("kmux-workflow-caller-");
    const repository = path.join(sandbox.profileRoot, "repository");
    mkdirSync(repository);
    execFileSync("git", ["init", "-b", "main"], { cwd: repository });
    writeFileSync(path.join(repository, "REVIEW_INPUT.md"), "BLOCKER\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "baseline"
      ],
      { cwd: repository }
    );
    const fixture = path.resolve("tests/fixtures/workflow-caller-agent.mjs");
    const launched = await launchKmuxWithSandbox(sandbox);
    const { page } = launched;
    let surfaceId = "";
    const getRun = async () =>
      (await page.evaluate(async () => {
        const runs = (await window.kmux.orchestration({
          method: "orchestration.run.list"
        })) as ReadonlyArray<{ runId: string }>;
        return runs[0]
          ? window.kmux.orchestration({
              method: "orchestration.run.get",
              params: { runId: runs[0].runId }
            })
          : null;
      })) as WorkflowRun | null;
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
            codex: {
              command: process.execPath,
              args: [fixture, "codex", ...(limit ? ["--always-blocker"] : [])]
            },
            antigravity: {
              command: process.execPath,
              args: [
                fixture,
                "antigravity",
                ...(limit ? ["--always-blocker"] : [])
              ]
            }
          }
        }
      });
      const doc = structuredClone(document) as unknown as FlowEditorDocumentV1;
      // This test exercises native caller protocol, not provider model catalogs.
      for (const entry of doc.nodes)
        if (entry.definition.kind === "agent")
          delete (entry.definition.config as { launch?: unknown }).launch;
      const compiled = compileFlowEditorDocument(doc as unknown as JsonValue);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
      await page.evaluate(
        async (serialized) => {
          const { definition, editor } = JSON.parse(serialized);
          await window.kmux.orchestration({
            method: "workflow.draft.create",
            params: {
              draftId: "draft:caller-review",
              definitionId: definition.definitionId,
              name: definition.name,
              canonicalDraft: definition,
              editorDocument: editor
            }
          });
          let blocked = false;
          try {
            await window.kmux.orchestration({
              method: "workflow.run",
              params: {
                workflow: definition.definitionId,
                runId: "run:manual-blocked",
                inputs: {
                  task: "Review",
                  implementationResult: {
                    summary: "Done",
                    changedFiles: [],
                    tests: []
                  }
                }
              }
            });
          } catch (error) {
            blocked = String(error).includes("requires a calling Agent");
          }
          if (!blocked)
            throw new Error("Manual Run must be blocked before launch");
        },
        JSON.stringify({ definition: compiled.value, editor: doc })
      );
      if (!limit) {
        await page.setViewportSize({ width: 1800, height: 1100 });
        await page
          .getByRole("button", { name: "Toggle usage dashboard" })
          .click();
        await page.getByRole("tab", { name: "Workflows", exact: true }).click();
        await page
          .getByRole("button", { name: /코드 리뷰 · 수정 2회 후 최종 검증/u })
          .click();
        const studio = page.getByRole("dialog");
        await studio.getByRole("button", { name: "Edit", exact: true }).click();
        await studio
          .getByRole("button", { name: "Fit workflow to canvas", exact: true })
          .click();
        const callerNode = studio.getByRole("article", {
          name: "Fact-check and revise AI Agent CLI node",
          exact: true
        });
        await callerNode
          .getByRole("button", {
            name: "Open Fact-check and revise menu",
            exact: true
          })
          .click();
        await callerNode
          .getByRole("menuitem", { name: "Properties", exact: true })
          .click();
        await studio
          .getByLabel("Agent", { exact: true })
          .selectOption("agent:codex");
        await studio
          .getByLabel("Agent", { exact: true })
          .selectOption("caller");
        await studio.getByRole("button", { name: "Save", exact: true }).click();
        await expect(
          studio.getByText("Workflow saved", { exact: true })
        ).toBeVisible();
        await studio.screenshot({
          path: testInfo.outputPath("calling-agent-properties.png")
        });
        await studio
          .getByRole("button", { name: "Close Workflow Studio" })
          .click();
        await page
          .getByRole("button", { name: "Toggle usage dashboard" })
          .click();
      }
      const state = await page.evaluate(() => window.kmux.getShellState());
      surfaceId =
        state.activeWorkspacePaneTree.panes[
          state.activeWorkspacePaneTree.activePaneId
        ]!.activeSurfaceId;
      const input = terminalInputForSurface(page, surfaceId);
      const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      await input.pressSequentially(`cd ${quote(repository)}`);
      await input.press("Enter");
      await expect
        .poll(async () => (await getSurfaceSnapshot(page, surfaceId))?.cwd)
        .toBe(repository);
      await input.pressSequentially(
        `${quote(process.execPath)} ${quote(fixture)} original --caller`
      );
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (
              await getSurfaceSnapshot(page, surfaceId, {
                includeRawOutputTail: true
              })
            )?.rawOutputTail
        )
        .toContain("original Workflow fixture ready");
      await input.pressSequentially("run");
      await input.press("Enter");
      if (limit) {
        await expect
          .poll(async () => (await getRun())?.status, { timeout: 80000 })
          .toBe("waiting-gate");
        const waiting = (await getRun())!;
        expect(Object.values(waiting.dispatches)).toHaveLength(6);
        expect(
          Object.values(waiting.attempts).filter(
            (attempt) => attempt.callerTask
          )
        ).toHaveLength(2);
        const gate = Object.values(waiting.gates).find(
          (gate) => gate.state === "open"
        )!;
        await page.evaluate(
          ({ runId, gateId }) =>
            window.kmux.orchestration({
              method: "orchestration.gate.resolve",
              params: { runId, gateId, resolution: "stop" }
            }),
          { runId: waiting.runId, gateId: gate.gateId }
        );
      }
      await expect
        .poll(
          async () =>
            (
              await getSurfaceSnapshot(page, surfaceId, {
                includeRawOutputTail: true
              })
            )?.rawOutputTail,
          { timeout: 80000 }
        )
        .toContain("WORKFLOW_COMPLETE:");
      const run = (await getRun())!;
      expect(run.status).toBe("succeeded");
      expect(run.outputs?.reviewResult).toMatchObject({
        iterations: limit ? 3 : 2,
        outcome: limit ? "max-reached" : "clean"
      });
      const workers = Object.values(run.dispatches);
      expect(workers).toHaveLength(limit ? 6 : 4);
      expect(
        new Set(workers.map((worker) => worker.execution?.surfaceId)).size
      ).toBe(limit ? 6 : 4);
      expect(
        workers.every((worker) => worker.execution?.surfaceId !== surfaceId)
      ).toBe(true);
      expect(
        new Set(workers.map((worker) => worker.bindingInstanceKey)).size
      ).toBe(limit ? 6 : 4);
      const tasks = Object.values(run.attempts).filter(
        (attempt) => attempt.callerTask
      );
      expect(tasks).toHaveLength(limit ? 2 : 1);
      expect(
        tasks.every((task) => task.callerTask?.state === "completed")
      ).toBe(true);
      expect(run.coordinatorAttachment?.surfaceId).toBe(surfaceId);
      expect(
        readFileSync(path.join(repository, "REVIEW_INPUT.md"), "utf8")
      ).toContain("FIXED by original Agent");
      expect(
        (
          await getSurfaceSnapshot(page, surfaceId, {
            includeRawOutputTail: true
          })
        )?.rawOutputTail
      ).toContain("Original conversation remains ready");
      expect(run.graph.authoringState).toBe("sealed");
    } catch (error) {
      await testInfo.attach("workflow-state", {
        body: JSON.stringify(await getRun(), null, 2),
        contentType: "application/json"
      });
      if (surfaceId)
        await testInfo.attach("caller-terminal", {
          body: JSON.stringify(
            await getSurfaceSnapshot(page, surfaceId, {
              includeRawOutputTail: true
            })
          ),
          contentType: "application/json"
        });
      throw error;
    } finally {
      await closeKmux(launched);
    }
  });
