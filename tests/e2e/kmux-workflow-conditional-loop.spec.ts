import { readWorkflowDefinition } from "./workflowStudio";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createPortProbe, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, loadConfigFromFile, type UserConfig } from "vite";
import {
  initializeFlowEditorDocument,
  type ConditionNodeDefinition,
  type FlowEditorDocumentV1,
  type LoopNodeDefinition,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "@kmux/orchestration";
import { closeKmux, kmuxPaths, launchKmux } from "./helpers";

test("Flowgram variable Conditions and Loop outputs survive saving and stop real commands on a clean review", async ({}, testInfo) => {
  const launched = await launchKmux("kmux-conditional-loop-");
  const { page } = launched;
  page.setDefaultTimeout(8_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let run: WorkflowRun | undefined;
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("button", { name: "New workflow", exact: true })
      .click();
    const studio = page.getByRole("dialog");
    await studio.getByLabel("Workflow name").fill("Review until clean");
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const base = (await readWorkflowDefinition(studio)) as WorkflowDefinitionV1;
    const fixture = reviewFixture(base);
    const definition = {
      ...fixture,
      edges: fixture.edges.filter((edge) => edge.id !== "clean-break")
    };
    const initialized = initializeFlowEditorDocument(definition);
    const editor: FlowEditorDocumentV1 = {
      ...initialized,
      nodes: initialized.nodes.map((entry) => ({
        ...entry,
        position:
          entry.id === "loop"
            ? { x: 80, y: 140 }
            : entry.id === "review"
              ? { x: 120, y: 120 }
              : entry.id === "condition"
                ? { x: 510, y: 120 }
                : entry.id === "stop"
                  ? { x: 850, y: 80 }
                  : entry.id === "again"
                    ? { x: 850, y: 310 }
                    : entry.id === "start"
                      ? { x: 80, y: 30 }
                      : { x: 1200, y: 180 },
        ...(entry.id === "loop" ? { size: { width: 1100, height: 580 } } : {})
      }))
    };
    await studio.getByLabel("Workflow JSON").fill(JSON.stringify(editor));
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    const properties = async (title: string) => {
      await studio
        .getByRole("button", { name: `Open ${title} menu`, exact: true })
        .click();
      await studio
        .getByRole("menuitem", { name: "Properties", exact: true })
        .click();
    };
    const inspector = studio.locator("[class*='propertyForm']");
    await properties("Review condition");
    await inspector
      .locator(".gedit-m-condition-row-left .semi-tree-select")
      .click();
    const dropdown = page.locator(".gedit-m-variable-selector-dropdown");
    await expect(
      dropdown.getByText("Code review", { exact: true })
    ).toBeVisible();
    await dropdown
      .locator(".semi-tree-option")
      .filter({ hasText: "Code review" })
      .locator(".semi-tree-option-expand-icon")
      .click();
    await dropdown.getByText("blockerCount", { exact: true }).click();
    const number = inspector.locator(".gedit-m-condition-row-right input");
    await number.fill("0");
    await number.press("Tab");
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    await page.waitForTimeout(400);
    const sourcePort = (await studio
      .locator('[data-port-entity-id="port_output_condition_clean"]')
      .boundingBox())!;
    const targetPort = (await studio
      .locator('[data-port-entity-id="port_input_stop_"]')
      .boundingBox())!;
    await page.mouse.move(
      sourcePort.x + sourcePort.width / 2,
      sourcePort.y + sourcePort.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      targetPort.x + targetPort.width / 2,
      targetPort.y + targetPort.height / 2,
      { steps: 20 }
    );
    await page.mouse.up();
    await properties("Review loop");
    await inspector
      .getByLabel("Loop mode", { exact: true })
      .selectOption("for-each");
    await inspector.locator(".semi-tree-select").click();
    // Filtered object groups are unselectable; their disclosure arrow still expands.
    const inputsDisclosure = dropdown
      .locator(".semi-tree-option")
      .filter({ hasText: "Workflow inputs" })
      .locator(".semi-tree-option-expand-icon");
    await inputsDisclosure.click({ force: true });
    await dropdown.getByText("items", { exact: true }).click();
    await expect(inspector.locator(".semi-tree-select")).toContainText("items");
    await inspector
      .getByLabel("Loop mode", { exact: true })
      .selectOption("while");
    await inspector.getByRole("button", { name: /Add output/u }).click();
    await inspector
      .getByLabel("Loop output 1 name", { exact: true })
      .fill("counts");
    await inspector.locator(".semi-tree-select").click();
    await expect(
      dropdown.getByText("Code review", { exact: true })
    ).toBeVisible();
    await dropdown
      .locator(".semi-tree-option")
      .filter({ hasText: "Code review" })
      .locator(".semi-tree-option-expand-icon")
      .click();
    await dropdown.getByText("blockerCount", { exact: true }).click();
    await inspector
      .getByLabel("Loop output 1 collection", { exact: true })
      .selectOption("collect");
    await studio.getByRole("button", { name: "Close node properties" }).click();
    const canonical = async () => {
      await studio.getByRole("button", { name: "JSON", exact: true }).click();
      const value = (await readWorkflowDefinition(
        studio
      )) as WorkflowDefinitionV1;
      await studio.getByRole("button", { name: "Design", exact: true }).click();
      return value;
    };
    const authored = await canonical();
    expect(authored.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: { nodeId: "condition", port: "clean" },
          to: { nodeId: "stop" }
        })
      ])
    );
    const inlineCondition = studio.getByRole("article", {
      name: "Review condition Condition node",
      exact: true
    });
    await expect(
      inlineCondition.locator(".gedit-m-condition-row-right input")
    ).toHaveValue("0");
    const condition = authored.nodes.find(
      (node) => node.id === "condition"
    ) as ConditionNodeDefinition;
    expect(condition.config.conditions?.[0]).toMatchObject({
      left: { kind: "node-result", nodeId: "review", path: ["blockerCount"] },
      operator: "eq",
      right: { kind: "literal", value: 0 }
    });
    const loop = authored.nodes.find(
      (node) => node.id === "loop"
    ) as LoopNodeDefinition;
    expect(loop.config.loopOutputs).toEqual([
      {
        name: "counts",
        source: {
          kind: "node-result",
          nodeId: "review",
          path: ["blockerCount"]
        },
        mode: "collect"
      }
    ]);
    await studio.screenshot({
      path: testInfo.outputPath("conditional-loop.png")
    });
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      studio.getByText("Workflow saved", { exact: true })
    ).toBeVisible();
    await studio
      .getByRole("button", { name: "Close Workflow Studio", exact: true })
      .click();
    await page.getByRole("button", { name: /Review until clean/u }).click();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    expect((await canonical()).nodes).toEqual(authored.nodes);
    await studio.getByRole("button", { name: "Run", exact: true }).click();
    await studio
      .getByRole("button", { name: "Start Run", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          run = await page.evaluate(async () => {
            const runs = (await window.kmux.orchestration({
              method: "orchestration.run.list",
              params: {}
            })) as readonly { runId: string }[];
            return runs[0]
              ? (window.kmux.orchestration({
                  method: "orchestration.run.get",
                  params: { runId: runs[0].runId }
                }) as Promise<WorkflowRun>)
              : undefined;
          });
          return run?.status;
        },
        { timeout: 20_000 }
      )
      .toBe("succeeded");
    expect(run!.outputs).toEqual({ counts: [2, 0] });
    expect(Object.values(run!.shellOperations)).toHaveLength(2);
    expect(
      Object.values(run!.attempts)
        .filter(
          (attempt) =>
            run!.graph.nodes[attempt.nodeId]?.materialization
              ?.templateNodeId === "review"
        )
        .map((attempt) => attempt.resolvedInputs.index)
    ).toEqual([0, 1]);
    expect(errors).toEqual([]);
  } finally {
    if (run)
      writeFileSync(
        testInfo.outputPath("last-run.json"),
        JSON.stringify(
          run,
          (key, value) =>
            key === "inputAuthorityRef"
              ? "[redacted]"
              : typeof value === "bigint"
                ? value.toString()
                : value,
          2
        )
      );
    await closeKmux(launched);
  }
});

test("AI Agent output fields change types in the development renderer without React warnings and survive reopening", async ({}, testInfo) => {
  // Production React omits the StrictMode warnings that users see in the dev app.
  const appRoot = kmuxPaths().appRoot;
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    path.join(appRoot, "electron.vite.config.ts")
  );
  const renderer = (loaded!.config as UserConfig & { renderer: UserConfig })
    .renderer;
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createPortProbe();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const selectedPort = (probe.address() as AddressInfo).port;
      probe.close((error) => (error ? reject(error) : resolve(selectedPort)));
    });
  });
  const cacheDir = mkdtempSync(path.join(tmpdir(), "kmux-dev-renderer-cache-"));
  const server = await createServer({
    ...renderer,
    configFile: false,
    mode: "development",
    define: {
      ...renderer.define,
      "process.env.NODE_ENV": JSON.stringify("development")
    },
    cacheDir,
    root: path.join(appRoot, "src/renderer"),
    server: { host: "127.0.0.1", port, strictPort: true },
    logLevel: "error"
  }).catch((error: unknown) => {
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  });
  const closeRenderer = async () => {
    try {
      await server.close();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  };
  await server.listen().catch(async (error: unknown) => {
    await closeRenderer();
    throw error;
  });
  const launched = await launchKmux("kmux-agent-output-fields-", {
    env: { ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0]! }
  }).catch(async (error: unknown) => {
    await closeRenderer();
    throw error;
  });
  const { page } = launched;
  const diagnostics: string[] = [];
  const exceptions: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      diagnostics.push(message.text());
  });
  page.on("pageerror", (error) => exceptions.push(error.message));
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("button", { name: "New workflow", exact: true })
      .click();
    const studio = page.getByRole("dialog");
    await studio.getByLabel("Workflow name").fill("Agent output contract");
    await studio.getByRole("button", { name: "Add node", exact: true }).click();
    await studio
      .getByRole("menuitem", { name: "AI Agent CLI", exact: true })
      .click();
    const inspector = studio.locator("[class*='propertyForm']");
    await inspector.getByText("Outputs", { exact: true }).click();
    await inspector.getByRole("button", { name: /Add output/u }).click();
    await inspector
      .getByPlaceholder("Field name", { exact: true })
      .fill("blockerCount");
    await inspector
      .getByPlaceholder("Field name", { exact: true })
      .press("Tab");
    for (const label of ["Integer", "Number", "String", "Integer"]) {
      await inspector
        .locator(".gedit-m-json-schema-editor-type button")
        .click();
      await page
        .locator(".semi-cascader-option")
        .filter({ hasText: label })
        .click();
      await expect(page.locator(".semi-cascader-option")).toHaveCount(0);
    }
    await inspector
      .locator(".gedit-m-json-schema-editor-required .semi-checkbox")
      .click();
    await expect(
      inspector.locator(".gedit-m-json-schema-editor-required input")
    ).toBeChecked();
    await studio.getByRole("button", { name: "Close node properties" }).click();
    await studio
      .getByRole("button", { name: "Fit workflow to canvas", exact: true })
      .click();
    const inlineAgent = studio.getByRole("article", {
      name: "AI Agent CLI AI Agent CLI node",
      exact: true
    });
    for (const label of ["Number", "Integer"]) {
      await inlineAgent
        .locator(".gedit-m-json-schema-editor-type button")
        .click();
      await page
        .locator(".semi-cascader-option")
        .filter({ hasText: label })
        .click();
      await expect(page.locator(".semi-cascader-option")).toHaveCount(0);
    }
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const read = async () =>
      (await readWorkflowDefinition(studio)) as WorkflowDefinitionV1;
    const agent = (await read()).nodes.find((node) => node.kind === "agent")!;
    expect(agent.resultSchema?.schema).toMatchObject({
      type: "object",
      properties: { blockerCount: { type: "integer" } },
      required: ["blockerCount"]
    });
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      studio.getByText("Workflow saved", { exact: true })
    ).toBeVisible();
    await studio
      .getByRole("button", { name: "Close Workflow Studio", exact: true })
      .click();
    await page.getByRole("button", { name: /Agent output contract/u }).click();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    expect(
      (await read()).nodes.find((node) => node.id === agent.id)?.resultSchema
    ).toEqual(agent.resultSchema);
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    await studio.screenshot({
      path: testInfo.outputPath("agent-output-fields.png")
    });
    expect(exceptions).toEqual([]);
    expect(
      diagnostics.filter((message) =>
        /findDOMNode|scheduled from inside an update function/u.test(message)
      )
    ).toEqual([]);
  } finally {
    try {
      await closeKmux(launched);
    } finally {
      await closeRenderer();
    }
  }
});

function reviewFixture(base: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  return {
    ...base,
    inputs: [
      {
        id: "items",
        required: false,
        default: ["a", "b"],
        schema: { schema: { type: "array", items: { type: "string" } } }
      }
    ],
    nodes: [
      base.nodes.find((node) => node.kind === "start")!,
      {
        id: "loop",
        kind: "loop",
        title: "Review loop",
        config: {
          version: 1,
          mode: "while",
          maxIterations: 3,
          repeatOutcome: "again",
          completedOutcomes: [],
          completedPort: "completed",
          maxReachedPort: "max-reached",
          body: {
            nodeIds: ["review", "condition", "stop", "again"],
            entryNodeIds: ["review"],
            exits: [
              { nodeId: "stop", outcome: "clean", action: "break" },
              { nodeId: "again", outcome: "again", action: "continue" }
            ]
          }
        }
      },
      {
        id: "review",
        kind: "shell",
        title: "Code review",
        inputMappings: [
          {
            target: "index",
            source: { kind: "loop-index", loopNodeId: "loop" },
            required: true,
            missing: "fail"
          }
        ],
        resultSchema: {
          schema: {
            type: "object",
            properties: { blockerCount: { type: "integer" } },
            required: ["blockerCount"]
          }
        },
        config: {
          version: 1,
          command: {
            kind: "structured",
            executable: "/bin/sh",
            args: [
              { kind: "literal", value: "-c" },
              {
                kind: "literal",
                value: 'printf \'{"blockerCount":%s}\' "$((2 - $1 * 2))"'
              },
              { kind: "literal", value: "review" },
              { kind: "input", input: "index" }
            ]
          },
          targetPolicy: "local",
          surfacePolicy: "create",
          cwdPolicy: "workspace",
          resultMode: "json-stdout",
          maxOutputBytes: 1024
        }
      },
      {
        id: "condition",
        kind: "condition",
        title: "Review condition",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: "false",
          ports: ["clean", "else"],
          conditions: [
            {
              key: "clean",
              left: { kind: "loop-index", loopNodeId: "loop" },
              operator: "eq",
              right: { kind: "literal", value: 0 }
            }
          ]
        }
      },
      { id: "stop", kind: "break", title: "Break", config: { version: 1 } },
      {
        id: "again",
        kind: "continue",
        title: "Continue",
        config: { version: 1 }
      },
      {
        ...base.nodes.find((node) => node.kind === "end")!,
        joinPolicy: "all-successful"
      }
    ],
    edges: [
      { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
      {
        id: "review-condition",
        from: { nodeId: "review" },
        to: { nodeId: "condition" }
      },
      {
        id: "clean-break",
        from: { nodeId: "condition", port: "clean" },
        to: { nodeId: "stop" }
      },
      {
        id: "else-continue",
        from: { nodeId: "condition", port: "else" },
        to: { nodeId: "again" }
      },
      {
        id: "loop-end",
        from: { nodeId: "loop", port: "completed" },
        to: { nodeId: "end" }
      },
      {
        id: "limit-end",
        from: { nodeId: "loop", port: "max-reached" },
        to: { nodeId: "end" }
      }
    ],
    outputs: [
      {
        id: "counts",
        required: true,
        source: { kind: "node-result", nodeId: "loop", path: ["counts"] }
      }
    ]
  };
}
