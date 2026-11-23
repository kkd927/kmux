import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeKmux, launchKmux } from "./helpers";

test("Workflow Studio opens new Drafts for editing and existing rows read-only", async () => {
  const launched = await launchKmux("kmux-workflow-studio-");
  const { page } = launched;
  try {
    const modelCli = join(
      launched.sandbox.profileRoot,
      "copilot-model-catalog"
    );
    writeFileSync(
      modelCli,
      "#!/usr/bin/env node\n" +
        readFileSync(
          new URL("../fixtures/modelCatalogCopilot.cjs", import.meta.url),
          "utf8"
        ),
      { mode: 0o755 }
    );
    await page.evaluate(
      (command) =>
        window.kmux.dispatch({
          type: "settings.update",
          patch: { agents: { copilot: { command } } }
        }),
      modelCli
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("button", { name: "New workflow", exact: true })
      .click();

    const studio = page.getByRole("dialog");
    await expect(studio).toBeVisible();
    // Mouse wheels zoom; continuous trackpad gestures pan without a mode menu.
    const startNode = studio.getByRole("article", {
      name: "Start Start node",
      exact: true
    });
    const canvas = (await studio
      .locator("[class*='canvasShell']")
      .boundingBox())!;
    const initialStart = (await startNode.boundingBox())!;
    await page.mouse.move(
      canvas.x + canvas.width * 0.85,
      canvas.y + canvas.height * 0.75
    );
    await page.mouse.wheel(0, 120);
    await expect
      .poll(async () => (await startNode.boundingBox())!.height)
      .toBeLessThan(initialStart.height);
    const zoomedStart = (await startNode.boundingBox())!;
    await page.mouse.wheel(10, 20);
    await expect
      .poll(async () => (await startNode.boundingBox())!.y)
      .not.toBe(zoomedStart.y);
    expect((await startNode.boundingBox())!.height).toBeCloseTo(
      zoomedStart.height,
      1
    );
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    await studio
      .getByRole("button", { name: "Horizontal Layout", exact: true })
      .click();
    await expect(
      studio.getByRole("button", { name: "Vertical Layout", exact: true })
    ).toBeVisible();
    await studio
      .getByRole("button", { name: "Vertical Layout", exact: true })
      .click();
    await studio.getByRole("button", { name: "Add node", exact: true }).click();
    await studio
      .getByRole("menuitem", { name: "Shell Terminal", exact: true })
      .click();
    await expect(studio.getByLabel("Title")).toHaveValue("Shell Terminal");
    await studio.getByRole("button", { name: "Delete node" }).click();
    await studio.getByLabel("Workflow name").fill("Release review");
    await studio.getByRole("button", { name: "Add node", exact: true }).click();
    await studio
      .getByRole("menuitem", { name: "AI Agent CLI", exact: true })
      .click();
    await expect(studio.getByLabel("Agent", { exact: true })).toHaveValue(
      /^input:/u
    );
    await studio.getByRole("button", { name: "Close node properties" }).click();
    const agentNode = studio.getByRole("article", {
      name: "AI Agent CLI AI Agent CLI node"
    });
    const expandAgent = agentNode.getByRole("button", {
      name: "Expand AI Agent CLI"
    });
    if (await expandAgent.isVisible()) await expandAgent.click();
    await agentNode
      .getByLabel("AI Agent CLI Agent")
      .selectOption("agent:copilot");
    const model = agentNode.getByLabel("AI Agent CLI Model");
    const effort = agentNode.getByLabel("AI Agent CLI Thinking level");
    await expect(model).toBeEnabled();
    await model.selectOption("fixture-model");
    await effort.selectOption("low");
    await agentNode
      .getByLabel("AI Agent CLI Prompt")
      .fill("Review the release and return structured evidence.");
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(studio.getByText("Workflow saved")).toBeVisible();
    await studio.getByRole("button", { name: "JSON" }).click();
    const canonicalWorkflow = studio.getByLabel("Workflow JSON");
    await expect(canonicalWorkflow).toHaveValue(/"model": "fixture-model"/u);
    await expect(canonicalWorkflow).toHaveValue(/"effort": "low"/u);
    await expect(canonicalWorkflow).toHaveValue(
      /Review the release and return structured evidence\./u
    );
    await studio.getByRole("button", { name: "Design" }).click();
    await studio.getByRole("button", { name: "Close Workflow Studio" }).click();
    await page.getByRole("button", { name: /Release review/u }).click();
    await expect(studio.getByText("Read-only", { exact: true })).toBeVisible();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    await agentNode
      .getByRole("button", { name: "Open AI Agent CLI menu" })
      .click();
    await agentNode.getByRole("menuitem", { name: "Properties" }).click();
    await expect(studio.getByLabel("Agent", { exact: true })).toHaveValue(
      "agent:copilot"
    );
    await expect(studio.getByLabel("Task prompt", { exact: true })).toHaveValue(
      "Review the release and return structured evidence."
    );
    await expect(studio.getByLabel("Model", { exact: true })).toHaveValue(
      "fixture-model"
    );
    await expect(
      studio.getByLabel("Thinking level", { exact: true })
    ).toHaveValue("low");
    await studio
      .getByLabel("Agent", { exact: true })
      .selectOption({ label: "Choose at Run" });
    await expect(studio.getByLabel("Agent", { exact: true })).toHaveValue(
      /^input:agent-selector-/u
    );
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await agentNode
      .getByRole("button", { name: "Open AI Agent CLI menu" })
      .click();
    await agentNode.getByRole("menuitem", { name: "Delete" }).click();
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(studio.getByText("Workflow saved")).toBeVisible();

    await studio.getByRole("button", { name: "Close Workflow Studio" }).click();
    await expect(studio).not.toBeVisible();

    await page.getByRole("button", { name: /Release review/u }).click();
    await expect(studio).toBeVisible();
    await expect(studio.getByText("Read-only", { exact: true })).toBeVisible();
    await expect(
      studio.getByRole("button", { name: "Edit", exact: true })
    ).toBeVisible();

    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(studio.getByLabel("Workflow name")).toHaveValue(
      "Release review"
    );

    // Preserve an authored vertical layout when opening the published Run diagram.
    await studio
      .getByRole("button", { name: "Horizontal Layout", exact: true })
      .click();
    await expect(
      studio.getByRole("button", { name: "Vertical Layout", exact: true })
    ).toBeVisible();
    // Flowgram's auto-layout animation takes 260 ms. Finish it before
    // switching tabs, which unmounts the editor and its animation.
    await page.waitForTimeout(350);
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    await expect
      .poll(async () => {
        const editor = JSON.parse(
          await studio.getByLabel("Workflow JSON").inputValue()
        );
        const position = (id: string) =>
          editor.nodes.find((node: any) => node.id === id).position;
        // Wait for the animated layout to finish before leaving the canvas.
        // During the animation, the nodes still form a diagonal arrangement.
        return (
          Math.abs(position("end").x - position("start").x) < 1 &&
          position("end").y > position("start").y
        );
      })
      .toBe(true);
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio.getByRole("button", { name: "Run", exact: true }).click();
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    const diagram = studio.getByLabel("Runtime diagram", { exact: true });
    await expect(diagram).toBeVisible();
    await expect
      .poll(async () => {
        const start = await diagram
          .locator('[data-run-node-id="start"]')
          .boundingBox();
        const end = await diagram
          .locator('[data-run-node-id="end"]')
          .boundingBox();
        return start && end ? end.y > start.y + start.height : false;
      })
      .toBe(true);

    await expect
      .poll(async () => {
        const runs = (await page.evaluate(() =>
          window.kmux.orchestration({
            method: "orchestration.run.list",
            params: {}
          })
        )) as ReadonlyArray<{ status: string; source: { kind: string } }>;
        return runs.find((run) => run.source.kind === "workflow-version")
          ?.status;
      })
      .toBe("succeeded");

    // Repeat the saved execution without creating a duplicate immutable version.
    await studio
      .getByRole("button", { name: "Configure another Run", exact: true })
      .click();
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.kmux.orchestration({
                method: "orchestration.run.list",
                params: {}
              })
            )) as unknown[]
          ).length
      )
      .toBe(2);
    const versions = (await page.evaluate(() =>
      window.kmux.orchestration({ method: "workflow.list", params: {} })
    )) as { versions: readonly unknown[] };
    expect(versions.versions).toHaveLength(1);

    // Palette Run configuration uses the published version while an unsaved
    // authoring buffer remains mounted and is restored when the Run dialog closes.
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio.getByLabel("Workflow name").fill("Unpublished draft changes");
    // Global shortcuts yield while a text field owns input.
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await page.keyboard.press("Meta+Shift+P");
    await page
      .getByLabel("Command palette query")
      .fill("Run workflow: Release review");
    await page
      .getByRole("option", { name: /Run workflow: Release review/u })
      .click();
    const runDialog = page.getByRole("dialog", {
      name: "Orchestration Run",
      exact: true
    });
    await expect(
      runDialog.getByText("Release review · v1", { exact: true })
    ).toBeVisible();
    await expect(
      runDialog.getByRole("button", { name: "Start Run", exact: true })
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.kmux.orchestration({
          method: "orchestration.run.list",
          params: {}
        })
      )
    ).toHaveLength(2);
    await runDialog
      .getByRole("button", { name: "Close Run", exact: true })
      .click();
    await expect(studio.getByLabel("Workflow name")).toHaveValue(
      "Unpublished draft changes"
    );
    // One JSON document saves the execution definition and layout together.
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const json = studio.getByLabel("Workflow JSON");
    const document = JSON.parse(await json.inputValue());
    document.workflow.description = "Saved from one JSON document";
    await json.fill("{");
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(studio.getByRole("alert")).toBeVisible();
    await json.fill(JSON.stringify(document));
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      studio.getByText("Workflow saved", { exact: true })
    ).toBeVisible();
    await studio.getByRole("button", { name: "Run", exact: true }).click();
    await studio
      .getByRole("button", { name: "Configure another Run", exact: true })
      .click();
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.kmux.orchestration({
                method: "workflow.list",
                params: {}
              })
            )) as { versions: readonly unknown[] }
          ).versions.length
      )
      .toBe(2);
    const updated = await page.evaluate(async () => {
      const catalog = (await window.kmux.orchestration({
        method: "workflow.list",
        params: {}
      })) as { versions: readonly { workflowVersionId: string }[] };
      return window.kmux.orchestration({
        method: "workflow.version.get",
        params: { workflowVersionId: catalog.versions[0]!.workflowVersionId }
      });
    });
    expect(updated).toMatchObject({
      definition: {
        name: "Unpublished draft changes",
        description: "Saved from one JSON document"
      }
    });
  } finally {
    await closeKmux(launched);
  }
});
