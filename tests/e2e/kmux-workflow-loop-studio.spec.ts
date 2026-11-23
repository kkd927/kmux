import { readWorkflowDefinition } from "./workflowStudio";
import { writeFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import type {
  FlowEditorDocumentV1,
  WorkflowDefinitionV1,
  WorkflowRun
} from "@kmux/orchestration";
import { closeKmux, getSurfaceSnapshot, launchKmux } from "./helpers";

for (const mode of ["for-each", "while"] as const) {
  test(`Studio authors a ${mode} Loop, saves its scope and dataflow, and runs real body commands`, async ({}, testInfo) => {
    const launched = await launchKmux("kmux-loop-studio-");
    const { page } = launched;
    let run: WorkflowRun | undefined;
    try {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page
        .getByRole("button", { name: "Toggle usage dashboard" })
        .click();
      await page.getByRole("tab", { name: "Workflows", exact: true }).click();
      await page
        .getByRole("button", { name: "New workflow", exact: true })
        .click();
      const studio = page.getByRole("dialog");
      const name = `Generic ${mode} authoring`;
      await studio.getByLabel("Workflow name").fill(name);
      const closeProperties = () =>
        studio.getByRole("button", { name: "Close node properties" }).click();
      const addNode = async (kind: string, title: string) => {
        await studio
          .getByRole("button", { name: "Add node", exact: true })
          .click();
        await studio.getByRole("menuitem", { name: kind, exact: true }).click();
        await studio.getByLabel("Title", { exact: true }).fill(title);
      };
      const properties = async (title: string) => {
        const menu = studio.getByRole("button", {
          name: `Open ${title} menu`,
          exact: true
        });
        await menu.click();
        await studio
          .getByRole("menuitem", { name: "Properties", exact: true })
          .click();
      };
      const canonical = async (): Promise<WorkflowDefinitionV1> => {
        await studio.getByRole("button", { name: "JSON", exact: true }).click();
        const definition = (await readWorkflowDefinition(
          studio
        )) as WorkflowDefinitionV1;
        await studio
          .getByRole("button", { name: "Design", exact: true })
          .click();
        return definition;
      };
      const addPath = async (scope: Locator, segments: string[]) => {
        for (const [index, segment] of segments.entries()) {
          await scope
            .getByRole("button", { name: "Add path segment", exact: true })
            .click();
          await scope
            .getByLabel(`Path segment ${index + 1}`, { exact: true })
            .fill(segment);
        }
      };
      const connect = async (from: string, to: string, port = "") => {
        const close = studio.getByRole("button", {
          name: "Close node properties"
        });
        if (await close.isVisible()) await close.click();
        await studio
          .getByRole("button", { name: "Fit workflow to canvas", exact: true })
          .click();
        // FlowGram animates fit-view for 300 ms; measure/drag after it settles.
        await page.waitForTimeout(400);
        const source = (await studio
          .locator(`[data-port-entity-id="port_output_${from}_${port}"]`)
          .boundingBox())!;
        const target = (await studio
          .locator(`[data-port-entity-id="port_input_${to}_"]`)
          .boundingBox())!;
        await page.mouse.move(
          source.x + source.width / 2,
          source.y + source.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(
          target.x + target.width / 2,
          target.y + target.height / 2,
          { steps: 20 }
        );
        await page.mouse.up();
      };

      await addNode("Shell Terminal", "Emit item");
      await studio
        .getByLabel("Executable", { exact: true })
        .fill("/usr/bin/printf");
      await studio
        .getByLabel("On failure", { exact: true })
        .selectOption("skip-descendants");
      for (const ordinal of [1, 2]) {
        await studio
          .getByRole("button", { name: "Add argument", exact: true })
          .click();
        const argument = studio.getByRole("group", {
          name: `Argument ${ordinal}`,
          exact: true
        });
        if (ordinal === 1)
          await argument
            .getByLabel("Literal value", { exact: true })
            .fill(
              mode === "for-each"
                ? '{"payload":"%s"}'
                : '{"payload":"next","previous":"%s"}'
            );
        else {
          await argument
            .getByRole("combobox", { name: "Argument source", exact: true })
            .selectOption("input");
          await argument
            .getByLabel("Node input name", { exact: true })
            .fill("value");
        }
      }
      await closeProperties();
      await addNode("Loop", "Process items");
      await studio.getByLabel("Loop mode", { exact: true }).selectOption(mode);
      await closeProperties();
      if (mode === "while") {
        await addNode("Human Gate", "Continue review");
        await studio
          .getByRole("textbox", { name: "Question", exact: true })
          .fill("Continue the bounded loop?");
        const resolutions = studio.getByLabel("Permitted resolutions", {
          exact: true
        });
        await resolutions.fill("retry");
        await resolutions.pressSequentially(", approve, abort");
        await closeProperties();
      }
      const initial = await canonical();
      const bodyId = initial.nodes.find(
        (node) => node.title === "Emit item"
      )!.id;
      const loopId = initial.nodes.find(
        (node) => node.title === "Process items"
      )!.id;
      const gateId = initial.nodes.find(
        (node) => node.title === "Continue review"
      )?.id;
      await properties("Emit item");
      await studio
        .getByRole("button", { name: "Add input mapping", exact: true })
        .click();
      const mapping = studio.getByRole("group", {
        name: "Mapping 1",
        exact: true
      });
      await mapping
        .getByLabel("Node input name", { exact: true })
        .fill("value");
      await mapping
        .getByLabel("Source", { exact: true })
        .selectOption(mode === "for-each" ? "loop-item" : "loop-carry");
      await mapping
        .getByLabel("Owning Loop", { exact: true })
        .selectOption(loopId);
      if (mode === "while")
        await mapping
          .getByLabel("Carried input name", { exact: true })
          .fill("latest");
      await closeProperties();

      // Carry, accumulation and maximum-gate policies remain supported in saved
      // workflows. Author this advanced fixture through JSON; the initial UI
      // now focuses on the collection/iteration controls and canvas connections.
      await studio.getByRole("button", { name: "JSON", exact: true }).click();
      const fixture = (await readWorkflowDefinition(
        studio
      )) as WorkflowDefinitionV1;
      const editor = JSON.parse(
        await studio.getByLabel("Workflow JSON").inputValue()
      ) as FlowEditorDocumentV1;
      const loop = fixture.nodes.find((node) => node.id === loopId)!;
      if (loop.kind !== "loop") throw new Error("Expected Loop");
      const configured = {
        ...loop,
        config:
          mode === "for-each"
            ? {
                version: 1 as const,
                mode,
                body: {
                  nodeIds: [bodyId],
                  entryNodeIds: [bodyId],
                  exits: [
                    {
                      nodeId: bodyId,
                      port: "success",
                      outcome: "item-complete"
                    }
                  ]
                },
                completedPort: "completed",
                maxReachedPort: "max-reached",
                maxItems: 2,
                concurrency: 1,
                itemInputId: "item",
                collection: {
                  kind: "literal" as const,
                  value: ["alpha", "beta"]
                },
                accumulator: {
                  outputId: "items",
                  source: { kind: "node-result" as const, nodeId: bodyId }
                }
              }
            : {
                version: 1 as const,
                mode,
                body: {
                  nodeIds: [bodyId],
                  entryNodeIds: [bodyId],
                  exits: [
                    { nodeId: bodyId, port: "success", outcome: "continue" },
                    { nodeId: bodyId, port: "failure", outcome: "clean" }
                  ]
                },
                completedPort: "completed",
                maxReachedPort: "max-reached",
                maxIterations: 1,
                repeatOutcome: "continue",
                completedOutcomes: ["clean"],
                carry: [
                  {
                    inputId: "latest",
                    initial: { kind: "literal" as const, value: "seed" },
                    next: {
                      kind: "node-result" as const,
                      nodeId: bodyId,
                      path: ["payload"]
                    }
                  }
                ],
                maxGate: {
                  nodeId: gateId!,
                  retryResolution: "retry",
                  abortResolution: "abort",
                  completedResolutions: [
                    { resolution: "approve", port: "completed" }
                  ]
                }
              }
      };
      const configuredEditor = {
        ...editor,
        nodes: editor.nodes.map((entry) =>
          entry.id === loopId
            ? {
                ...entry,
                definition: configured,
                size: undefined,
                loopAnchors: undefined
              }
            : {
                ...entry,
                position:
                  entry.id === bodyId
                    ? { x: 184, y: 156 }
                    : entry.id === gateId
                      ? { x: 184, y: 300 }
                      : entry.position
              }
        )
      };
      await studio
        .getByLabel("Workflow JSON")
        .fill(JSON.stringify(configuredEditor));
      await studio.getByRole("button", { name: "Design", exact: true }).click();
      await connect("start", loopId);
      const connectedRoot = await canonical();
      expect(connectedRoot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: { nodeId: "start" },
            to: { nodeId: loopId }
          })
        ])
      );
      await connect(loopId, "end", "completed");
      if (mode === "for-each") await connect(loopId, "end", "max-reached");
      await properties("End");
      await studio
        .getByLabel("Join policy", { exact: true })
        .selectOption("all-successful");
      await studio
        .getByRole("button", { name: "Add Run output", exact: true })
        .click();
      const output = studio.getByRole("group", {
        name: "Run output 1",
        exact: true
      });
      await output.getByLabel("Output ID", { exact: true }).fill("items");
      await output
        .getByLabel("Source node", { exact: true })
        .selectOption(loopId);
      await addPath(
        output,
        mode === "for-each" ? ["accumulated"] : ["carry", "latest"]
      );
      await closeProperties();
      const authored = await canonical();
      writeFileSync(
        testInfo.outputPath("authored.json"),
        JSON.stringify(authored, null, 2)
      );
      await studio.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        studio.getByText("Workflow saved", { exact: true })
      ).toBeVisible();
      await studio
        .getByRole("button", { name: "Close Workflow Studio", exact: true })
        .click();
      await page.getByRole("button", { name, exact: false }).click();
      await studio.getByRole("button", { name: "Edit", exact: true }).click();
      expect((await canonical()).nodes).toEqual(authored.nodes);
      await studio.getByRole("button", { name: "Run", exact: true }).click();
      await studio
        .getByRole("button", { name: "Start Run", exact: true })
        .click();
      const inspect = async () => {
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
        return run;
      };
      if (mode === "while") {
        for (const [index, resolution] of ["retry", "approve"].entries()) {
          await expect
            .poll(
              async () =>
                Object.values((await inspect())?.gates ?? {}).filter(
                  (gate) => gate.state === "open"
                ).length
            )
            .toBe(1);
          expect(Object.values(run!.shellOperations)).toHaveLength(index + 1);
          await studio
            .getByRole("button", { name: resolution, exact: true })
            .click();
          await expect
            .poll(
              async () =>
                Object.values((await inspect())?.gates ?? {}).filter(
                  (gate) => gate.state === "resolved"
                ).length
            )
            .toBe(index + 1);
        }
      }
      await expect
        .poll(async () => (await inspect())?.status, { timeout: 20_000 })
        .toBe("succeeded");
      expect(run!.outputs).toEqual({
        items:
          mode === "for-each"
            ? [{ payload: "alpha" }, { payload: "beta" }]
            : "next"
      });
      const bodyAttempts = Object.values(run!.attempts).filter(
        (attempt) =>
          run!.graph.nodes[attempt.nodeId]?.materialization?.templateNodeId ===
          bodyId
      );
      expect(bodyAttempts).toHaveLength(2);
      expect(
        bodyAttempts.map((attempt) => attempt.resolvedInputs.value)
      ).toEqual(mode === "for-each" ? ["alpha", "beta"] : ["seed", "next"]);
      const operations = Object.values(run!.shellOperations);
      expect(operations).toHaveLength(2);
      const snapshots = [];
      for (const operation of operations) {
        expect(operation).toMatchObject({
          state: "applied",
          exitCode: 0,
          processId: expect.any(Number)
        });
        const snapshot = await getSurfaceSnapshot(
          page,
          operation.execution!.surfaceId
        );
        expect(snapshot?.sessionId).toBe(operation.execution!.sessionId);
        snapshots.push(snapshot);
      }
      writeFileSync(
        testInfo.outputPath("loop-studio-run.json"),
        JSON.stringify({ authored, run, snapshots }, evidenceValue, 2)
      );
    } finally {
      if (run)
        writeFileSync(
          testInfo.outputPath("last-run.json"),
          JSON.stringify(run, evidenceValue, 2)
        );
      await closeKmux(launched);
    }
  });
}

function evidenceValue(key: string, value: unknown): unknown {
  if (key === "inputAuthorityRef") return "[redacted]";
  return typeof value === "bigint" ? value.toString() : value;
}

test("Loop supports dragged Agent connections, a fixed frame, border resizing and saved layout", async () => {
  const launched = await launchKmux("kmux-loop-frame-");
  const { page } = launched;
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole("button", { name: "Toggle usage dashboard" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    await page
      .getByRole("button", { name: "New workflow", exact: true })
      .click();
    const studio = page.getByRole("dialog");
    await studio.getByLabel("Workflow name").fill("Loop frame regression");
    for (const kind of ["Loop", "AI Agent CLI"]) {
      await studio
        .getByRole("button", { name: "Add node", exact: true })
        .click();
      await studio.getByRole("menuitem", { name: kind, exact: true }).click();
      await studio
        .getByRole("button", { name: "Close node properties" })
        .click();
    }
    await studio.getByRole("button", { name: "JSON", exact: true }).click();
    const document = JSON.parse(
      await studio.getByLabel("Workflow JSON").inputValue()
    ) as FlowEditorDocumentV1;
    const loopId = document.nodes.find(
      (entry) => entry.definition.kind === "loop"
    )!.id;
    const agentId = document.nodes.find(
      (entry) => entry.definition.kind === "agent"
    )!.id;
    const positioned = {
      ...document,
      nodes: document.nodes.map((entry) => ({
        ...entry,
        position:
          entry.id === loopId
            ? { x: 40, y: 120 }
            : entry.id === agentId
              ? { x: 1070, y: 300 }
              : entry.id === "start"
                ? { x: 40, y: 20 }
                : { x: 1070, y: 20 },
        ...(entry.id === loopId
          ? {
              size: { width: 980, height: 640 },
              loopAnchors: { start: { x: 32, y: 280 }, end: { x: 800, y: 280 } }
            }
          : {})
      }))
    };
    await studio.getByLabel("Workflow JSON").fill(JSON.stringify(positioned));
    await studio.getByRole("button", { name: "Design", exact: true }).click();
    const fit = async () => {
      await studio
        .getByRole("button", { name: "Fit workflow to canvas", exact: true })
        .click();
      await page.waitForTimeout(400);
    };
    await fit();
    const loop = studio.getByRole("article", {
      name: "Loop Loop node",
      exact: true
    });
    const agent = studio.getByRole("article", {
      name: "AI Agent CLI AI Agent CLI node",
      exact: true
    });
    const loopBox = (await loop.boundingBox())!;
    const agentHeader = (await agent.locator("header").boundingBox())!;
    const zoom = loopBox.width / 980;
    await page.mouse.move(agentHeader.x + 90 * zoom, agentHeader.y + 20 * zoom);
    await page.mouse.down();
    await page.mouse.move(loopBox.x + 330 * zoom, loopBox.y + 190 * zoom, {
      steps: 30
    });
    await page.mouse.up();
    const read = async () => {
      await studio.getByRole("button", { name: "JSON", exact: true }).click();
      const editor = JSON.parse(
        await studio.getByLabel("Workflow JSON").inputValue()
      ) as FlowEditorDocumentV1;
      await studio.getByRole("button", { name: "Design", exact: true }).click();
      return editor;
    };
    const nested = await read();
    expect(
      nested.nodes.find((entry) => entry.id === loopId)!.definition.config
    ).toMatchObject({ body: { nodeIds: [agentId] } });
    expect(nested.nodes.find((entry) => entry.id === loopId)!.size).toEqual({
      width: 980,
      height: 640
    });
    await fit();
    const connect = async (from: string, to: string) => {
      const source = (await studio
        .locator(`[data-port-entity-id="port_output_${from}_"]`)
        .boundingBox())!;
      const target = (await studio
        .locator(`[data-port-entity-id="port_input_${to}_"]`)
        .boundingBox())!;
      await page.mouse.move(
        source.x + source.width / 2,
        source.y + source.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        target.x + target.width / 2,
        target.y + target.height / 2,
        { steps: 20 }
      );
      await page.mouse.up();
    };
    await connect(`__kmux_loop_start:${loopId}`, agentId);
    await connect(agentId, `__kmux_loop_end:${loopId}`);
    const connected = await read();
    expect(
      connected.nodes.find((entry) => entry.id === loopId)!.definition.config
    ).toMatchObject({
      body: {
        entryNodeIds: [agentId],
        exits: [{ nodeId: agentId, outcome: "continue" }]
      }
    });
    // Keep the authored connections through layout edits and a saved Draft reopen.
    await fit();
    const beforeMove = (await loop.boundingBox())!;
    const start = studio.getByLabel("Loop block start", { exact: true });
    const startBox = (await start.boundingBox())!;
    await page.mouse.move(startBox.x + 20, startBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(startBox.x + 55, startBox.y + 65, { steps: 15 });
    await page.mouse.up();
    const afterMove = (await loop.boundingBox())!;
    const moved = await read();
    expect(moved.nodes.find((entry) => entry.id === loopId)!.position).toEqual(
      connected.nodes.find((entry) => entry.id === loopId)!.position
    );
    expect(
      moved.nodes.find((entry) => entry.id === loopId)!.loopAnchors
    ).not.toEqual(
      connected.nodes.find((entry) => entry.id === loopId)!.loopAnchors
    );
    expect(afterMove.width).toBeCloseTo(beforeMove.width, 0);
    expect(afterMove.height).toBeCloseTo(beforeMove.height, 0);
    const closeProperties = studio.getByRole("button", {
      name: "Close node properties"
    });
    if (await closeProperties.isVisible()) await closeProperties.click();
    await fit();
    const corner = studio.getByRole("separator", {
      name: `Resize ${loopId} se`,
      exact: true
    });
    const cornerBox = (await corner.boundingBox())!;
    const frameBeforeResize = (await loop.boundingBox())!;
    const expectFrame = async (
      expected: NonNullable<Awaited<ReturnType<typeof loop.boundingBox>>>
    ) => {
      await expect
        .poll(async () => {
          const actual = (await loop.boundingBox())!;
          return ["x", "y", "width", "height"].every(
            (key) =>
              Math.abs(
                actual[key as keyof typeof actual] -
                  expected[key as keyof typeof expected]
              ) < 1
          );
        })
        .toBe(true);
    };
    await page.mouse.move(cornerBox.x + 7, cornerBox.y + 7);
    await page.mouse.down();
    await page.mouse.move(cornerBox.x + 100, cornerBox.y + 80, { steps: 15 });
    await page.mouse.up();
    const frameAfterResize = (await loop.boundingBox())!;
    // Undo/redo belong to this canvas session. Switching to JSON remounts it
    // and intentionally clears the native Flowgram history.
    await studio
      .getByRole("button", { name: "Undo canvas change", exact: true })
      .click();
    await expectFrame(frameBeforeResize);
    await studio
      .getByRole("button", { name: "Redo canvas change", exact: true })
      .click();
    await expectFrame(frameAfterResize);
    const resized = await read();
    let resizedLoop = resized.nodes.find((entry) => entry.id === loopId)!;
    expect(resizedLoop.size!.width).toBeGreaterThan(980);
    expect(resizedLoop.size!.height).toBeGreaterThan(640);
    await fit();
    const oppositeCorner = (await studio
      .getByRole("separator", {
        name: `Resize ${loopId} nw`,
        exact: true
      })
      .boundingBox())!;
    const frameBeforeShift = (await loop.boundingBox())!;
    const agentBeforeShift = (await agent.boundingBox())!;
    await page.mouse.move(oppositeCorner.x + 7, oppositeCorner.y + 7);
    await page.mouse.down();
    await page.mouse.move(oppositeCorner.x - 40, oppositeCorner.y - 30, {
      steps: 15
    });
    await page.mouse.up();
    const frameAfterShift = (await loop.boundingBox())!;
    const agentAfterShift = (await agent.boundingBox())!;
    expect(Math.abs(agentBeforeShift.x - agentAfterShift.x)).toBeLessThan(1);
    expect(Math.abs(agentBeforeShift.y - agentAfterShift.y)).toBeLessThan(1);
    await studio
      .getByRole("button", { name: "Undo canvas change", exact: true })
      .click();
    await expectFrame(frameBeforeShift);
    await studio
      .getByRole("button", { name: "Redo canvas change", exact: true })
      .click();
    await expectFrame(frameAfterShift);
    const shifted = await read();
    const shiftedLoop = shifted.nodes.find((entry) => entry.id === loopId)!;
    expect(shiftedLoop.size!.width).toBeGreaterThan(resizedLoop.size!.width);
    expect(shiftedLoop.size!.height).toBeGreaterThan(resizedLoop.size!.height);
    const agentBefore = resized.nodes.find((entry) => entry.id === agentId)!;
    const agentAfter = shifted.nodes.find((entry) => entry.id === agentId)!;
    expect(shiftedLoop.position.x + agentAfter.position.x).toBeCloseTo(
      resizedLoop.position.x + agentBefore.position.x
    );
    expect(shiftedLoop.position.y + agentAfter.position.y).toBeCloseTo(
      resizedLoop.position.y + agentBefore.position.y
    );
    resizedLoop = shiftedLoop;
    await fit();
    const collapse = loop.getByRole("button", {
      name: "Collapse Loop",
      exact: true
    });
    await collapse.click();
    await loop
      .getByRole("button", { name: "Expand Loop", exact: true })
      .click();
    expect(
      (await read()).nodes.find((entry) => entry.id === loopId)!.size
    ).toEqual(resizedLoop.size);
    await studio.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      studio.getByText("Workflow saved", { exact: true })
    ).toBeVisible();
    await studio
      .getByRole("button", { name: "Close Workflow Studio", exact: true })
      .click();
    await page.getByRole("button", { name: /Loop frame regression/u }).click();
    await studio.getByRole("button", { name: "Edit", exact: true }).click();
    const restored = (await read()).nodes.find((entry) => entry.id === loopId)!;
    expect(restored.size).toEqual(resizedLoop.size);
    expect(restored.loopAnchors).toEqual(resizedLoop.loopAnchors);
    expect(restored.definition).toEqual(resizedLoop.definition);
  } finally {
    await closeKmux(launched);
  }
});
