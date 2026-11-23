import { readWorkflowDefinition } from "./workflowStudio";
import { writeFileSync } from "node:fs";

import type { WorkflowRun } from "@kmux/orchestration";
import { expect, test } from "@playwright/test";

import { closeKmux, getSurfaceSnapshot, launchKmux } from "./helpers";

test("Studio authors typed Run inputs, required Shell result mappings and outputs through managed PTYs", async ({}, testInfo) => {
  const launched = await launchKmux("kmux-shell-studio-");
  const { page } = launched;
  let run: WorkflowRun | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("button", { name: "New workflow", exact: true })
      .click();
    const studio = page.getByRole("dialog");
    await studio.getByLabel("Workflow name").fill("Structured Shell arguments");
    await studio.getByRole("button", { name: "Add node", exact: true }).click();
    await studio
      .getByRole("menuitem", { name: "Shell Terminal", exact: true })
      .click();
    await studio
      .getByLabel("Executable", { exact: true })
      .fill("/usr/bin/printf");
    // These bytes are data in a single argv slot, including actual newlines.
    const forwarded = { text: "결과 key.with.dot 🧪", count: 2 };
    const expected = {
      "payload.with.dot": JSON.stringify(forwarded),
      text: "한글 🧪 'single' \"double\" $(printf injected) `printf injected` ; | > $PATH",
      values: [1, true, null]
    };
    const literal = JSON.stringify(expected, null, 2);
    const argument = (ordinal: number) =>
      studio.getByRole("group", { name: `Argument ${ordinal}`, exact: true });
    await studio
      .getByRole("button", { name: "Add argument", exact: true })
      .click();
    await argument(1)
      .getByRole("textbox", { name: "Literal value", exact: true })
      .fill(literal);
    await studio
      .getByRole("button", { name: "Add argument", exact: true })
      .click();
    await argument(2)
      .getByRole("textbox", { name: "Literal value", exact: true })
      .fill("%s");
    await argument(2)
      .getByRole("button", { name: "Move up", exact: true })
      .click();
    await expect(
      argument(1).getByRole("textbox", { name: "Literal value", exact: true })
    ).toHaveValue("%s");
    await expect(
      argument(2).getByRole("textbox", { name: "Literal value", exact: true })
    ).toHaveValue(literal);
    await studio
      .getByRole("checkbox", { name: "Retry failed attempts", exact: true })
      .check();
    await studio
      .getByRole("checkbox", { name: "Execution error", exact: true })
      .uncheck();
    await studio
      .getByRole("checkbox", { name: "Timeout", exact: true })
      .check();
    await studio
      .getByRole("checkbox", { name: "Set an attempt timeout", exact: true })
      .check();
    await studio
      .getByLabel("Attempt timeout (ms)", { exact: true })
      .fill("5000");
    await studio
      .getByLabel("When the timeout expires", { exact: true })
      .selectOption("cancel-and-retry");
    await studio
      .getByLabel("On failure", { exact: true })
      .selectOption("fail-run");
    await studio
      .getByRole("checkbox", { name: "Required side effect", exact: true })
      .check();
    await studio.getByRole("button", { name: "Close node properties" }).click();
    const properties = async (title: string) => {
      const node = studio.getByRole("article").filter({
        has: page.getByRole("button", {
          name: `Open ${title} menu`,
          exact: true
        })
      });
      await node
        .getByRole("button", { name: `Open ${title} menu`, exact: true })
        .click();
      await node
        .getByRole("menuitem", { name: "Properties", exact: true })
        .click();
    };
    await properties("Start");
    await studio
      .getByRole("button", { name: "Add Run input", exact: true })
      .click();
    const runInput = studio.getByRole("group", {
      name: "Run input 1",
      exact: true
    });
    await runInput
      .getByRole("textbox", { name: "Input ID", exact: true })
      .fill("format");
    await runInput
      .getByRole("textbox", { name: "Default JSON (optional)", exact: true })
      .fill('{"unfinished":');
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await expect(
      studio.getByRole("button", { name: "Save", exact: true })
    ).toBeDisabled();
    await studio
      .getByRole("button", {
        name: "Default JSON (optional) · Start",
        exact: true
      })
      .click();
    await expect(
      runInput.getByRole("textbox", {
        name: "Default JSON (optional)",
        exact: true
      })
    ).toHaveValue('{"unfinished":');
    await runInput
      .getByRole("textbox", { name: "Default JSON (optional)", exact: true })
      .fill("");
    await studio.getByRole("button", { name: "Close node properties" }).click();

    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const definition = await readWorkflowDefinition(studio);
    const shellId = definition.nodes.find(
      (node: { kind: string }) => node.kind === "shell"
    )!.id as string;
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    const connect = async (from: string, to: string) => {
      const source = studio.locator(
        `[data-port-entity-id="port_output_${from}_"]`
      );
      const target = studio.locator(
        `[data-port-entity-id="port_input_${to}_"]`
      );
      await source.dragTo(target);
    };
    await connect("start", shellId);
    await connect(shellId, "end");
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      studio.getByText("Workflow saved", { exact: true })
    ).toBeVisible();
    await studio.getByRole("button", { name: "Close Workflow Studio" }).click();
    await page
      .getByRole("button", { name: /Structured Shell arguments/u })
      .click();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    const shell = studio.getByRole("article", {
      name: "Shell Terminal Shell Terminal node",
      exact: true
    });
    await shell
      .getByRole("button", { name: "Open Shell Terminal menu" })
      .click();
    await shell
      .getByRole("menuitem", { name: "Properties", exact: true })
      .click();
    await expect(studio.getByLabel("Executable", { exact: true })).toHaveValue(
      "/usr/bin/printf"
    );
    await expect(
      argument(1).getByRole("textbox", { name: "Literal value", exact: true })
    ).toHaveValue("%s");
    await expect(
      argument(2).getByRole("textbox", { name: "Literal value", exact: true })
    ).toHaveValue(literal);
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await studio.getByRole("button", { name: "Add node", exact: true }).click();
    await studio
      .getByRole("menuitem", { name: "Shell Terminal", exact: true })
      .click();
    await studio
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Forward result");
    await studio
      .getByRole("textbox", { name: "Executable", exact: true })
      .fill("/usr/bin/printf");
    for (const [ordinal, input] of [
      [1, "format"],
      [2, "payload"]
    ] as const) {
      await studio
        .getByRole("button", { name: "Add argument", exact: true })
        .click();
      await argument(ordinal)
        .getByRole("combobox", { name: "Argument source", exact: true })
        .selectOption("input");
      await argument(ordinal)
        .getByRole("textbox", { name: "Node input name", exact: true })
        .fill(input);
      await studio
        .getByRole("button", { name: "Add input mapping", exact: true })
        .click();
      const mapping = studio.getByRole("group", {
        name: `Mapping ${ordinal}`,
        exact: true
      });
      await mapping
        .getByRole("textbox", { name: "Node input name", exact: true })
        .fill(input);
      if (ordinal === 1) {
        await mapping
          .getByRole("combobox", { name: "Run input", exact: true })
          .selectOption("format");
      } else {
        await mapping
          .getByRole("combobox", { name: "Source", exact: true })
          .selectOption("node-result");
        await mapping
          .getByRole("combobox", { name: "Source node", exact: true })
          .selectOption(shellId);
        await mapping
          .getByRole("button", { name: "Add path segment", exact: true })
          .click();
        await mapping
          .getByRole("textbox", { name: "Path segment 1", exact: true })
          .fill("payload.with.dot");
      }
    }
    await studio
      .getByRole("group", { name: "Structured result schema", exact: true })
      .getByRole("combobox", { name: "Value type", exact: true })
      .selectOption("object");
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const nextDefinition = await readWorkflowDefinition(studio);
    const forwardId = nextDefinition.nodes.find(
      (node: { title: string }) => node.title === "Forward result"
    )!.id as string;
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    // Control edges allow both shells after Start; the required result mapping
    // independently prevents Forward result from starting before its source settles.
    await connect("start", forwardId);
    await connect(forwardId, "end");
    // Automatic execution preparation validates the graph and shows an actionable error.
    await studio.getByRole("button", { name: "Run", exact: true }).click();
    await studio
      .getByRole("textbox", { name: "format", exact: true })
      .fill("%s");
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    const joinIssue = studio
      .getByRole("button", {
        name: /nodes with multiple incoming edges require an explicit joinPolicy/u
      })
      .first();
    await expect(joinIssue).toBeVisible();
    await joinIssue.click();
    await expect(studio.getByLabel("Title", { exact: true })).toHaveValue(
      "End"
    );
    await expect(
      studio.getByRole("combobox", { name: "Join policy", exact: true })
    ).toHaveValue("");
    await studio
      .getByRole("combobox", { name: "Join policy", exact: true })
      .selectOption("all-successful");
    await studio
      .getByRole("button", { name: "Add Run output", exact: true })
      .click();
    const output = studio.getByRole("group", {
      name: "Run output 1",
      exact: true
    });
    await output
      .getByRole("textbox", { name: "Output ID", exact: true })
      .fill("forwarded");
    await output
      .getByRole("combobox", { name: "Source node", exact: true })
      .selectOption(forwardId);
    await output
      .getByRole("combobox", { name: "Value type", exact: true })
      .selectOption("object");
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await studio
      .getByRole("button", { name: "Close Workflow Studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Structured Shell arguments/u })
      .click();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    await studio.getByRole("button", { name: "Run", exact: true }).click();
    await studio
      .getByRole("textbox", { name: "format", exact: true })
      .fill("%s");
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          run = await page.evaluate(async () => {
            const summaries = (await window.kmux.orchestration({
              method: "orchestration.run.list",
              params: {}
            })) as ReadonlyArray<{ runId: string }>;
            if (!summaries[0]) return undefined;
            return (await window.kmux.orchestration({
              method: "orchestration.run.get",
              params: { runId: summaries[0].runId }
            })) as WorkflowRun;
          });
          return run?.status;
        },
        { timeout: 20_000 }
      )
      .toBe("succeeded");
    const attempt = Object.values(run!.attempts).find(
      (entry) => entry.nodeId === shellId
    )!;
    const operation = Object.values(run!.shellOperations).find(
      (entry) => entry.attemptId === attempt.attemptId
    )!;
    expect(attempt.status).toBe("succeeded");
    expect(run!.attemptResults[attempt.attemptId]?.data).toEqual(expected);
    const forwardedAttempt = Object.values(run!.attempts).find(
      (entry) => entry.nodeId === forwardId
    )!;
    expect(forwardedAttempt.resolvedInputs).toEqual({
      format: "%s",
      payload: expected["payload.with.dot"]
    });
    expect(Date.parse(forwardedAttempt.startedAt!)).toBeGreaterThanOrEqual(
      Date.parse(attempt.settledAt!)
    );
    expect(run!.attemptResults[forwardedAttempt.attemptId]?.data).toEqual(
      forwarded
    );
    expect(run!.outputs).toEqual({ forwarded });
    expect(run!.graph.nodes[shellId]!.definition).toMatchObject({
      retryPolicy: {
        maxAttempts: 2,
        retryable: ["timeout"],
        backoffMs: 1000,
        placement: "allow-fresh"
      },
      timeoutPolicy: { timeoutMs: 5000, onTimeout: "cancel-and-retry" },
      onFailure: "fail-run",
      requiredSideEffect: true
    });
    const timer = Object.values(run!.timers).find(
      (timer) =>
        timer.attemptId === attempt.attemptId && timer.kind === "timeout"
    )!;
    expect(Date.parse(timer.dueAt) - Date.parse(attempt.createdAt)).toBe(5000);
    expect(Object.values(run!.shellOperations)).toHaveLength(2);
    expect(operation).toMatchObject({
      state: "applied",
      exitCode: 0,
      outputBytes: expect.any(Number),
      processId: expect.any(Number),
      execution: {
        targetId: "local",
        generation: { kind: "local", runtimeEpoch: expect.any(String) }
      }
    });
    expect(
      run!.attemptResults[attempt.attemptId]?.shellExecutionReceipt
    ).toMatchObject({
      operationId: operation.operationId,
      execution: operation.execution,
      commandHash: operation.commandHash,
      exitCode: 0,
      outputHash: operation.outputHash,
      outputBytes: operation.outputBytes
    });
    expect(Object.values(run!.dispatches)).toHaveLength(0);
    const snapshot = await getSurfaceSnapshot(
      page,
      operation.execution!.surfaceId,
      { includeRawOutputTail: true }
    );
    writeFileSync(
      testInfo.outputPath("shell-run.json"),
      JSON.stringify({ run, snapshot }, evidenceValue, 2)
    );
  } finally {
    if (run?.status !== "succeeded")
      writeFileSync(
        testInfo.outputPath("shell-failure.json"),
        JSON.stringify(run ?? null, evidenceValue, 2)
      );
    await closeKmux(launched);
  }
});

function evidenceValue(key: string, value: unknown): unknown {
  if (key === "inputAuthorityRef") return "[redacted]";
  return typeof value === "bigint" ? value.toString() : value;
}
