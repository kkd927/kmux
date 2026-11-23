import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition,
  type InputMapping,
  type ShellNodeDefinition,
  type WorkflowControlEdge,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "@kmux/orchestration";
import { closeKmux, getSurfaceSnapshot, launchKmux } from "./helpers";

test("a sealed Workflow delivers admission, unsatisfied-join, and skip outcomes to a real Shell failure handler", async ({}, testInfo) => {
  const launched = await launchKmux("kmux-workflow-outcomes-");
  const { page } = launched;
  const base = starterWorkflowDefinition({
    definitionId: "outcomes",
    name: "Terminal outcomes"
  });
  const shell = (id: string): ShellNodeDefinition => ({
    id,
    kind: "shell",
    title: id,
    onFailure: "skip-descendants",
    config: {
      version: 1,
      targetPolicy: "local",
      surfacePolicy: "create",
      cwdPolicy: "workspace",
      resultMode: "json-stdout",
      maxOutputBytes: 4096,
      command: {
        kind: "structured",
        executable: "/usr/bin/printf",
        args: [{ kind: "literal", value: "{}" }]
      }
    }
  });
  const missing: InputMapping = {
    target: "requiredValue",
    source: { kind: "run-input", inputId: "optionalValue" },
    required: true,
    missing: "fail"
  };
  const edge = (
    from: string,
    to: string,
    port?: string
  ): WorkflowControlEdge => ({
    id: `${from}:${to}`,
    from: { nodeId: from, ...(port ? { port } : {}) },
    to: { nodeId: to }
  });
  const handler = shell("handler");
  const definition: WorkflowDefinitionV1 = {
    ...base,
    inputs: [{ id: "optionalValue", required: false }],
    nodes: [
      ...base.nodes,
      {
        ...handler,
        onFailure: "fail-run",
        joinPolicy: "all-settled",
        inputMappings: [
          {
            target: "admission",
            source: {
              kind: "node-outcome",
              nodeId: "a",
              path: ["admissionFailure", "code"]
            },
            required: true,
            missing: "fail"
          },
          {
            target: "join",
            source: {
              kind: "node-outcome",
              nodeId: "race",
              path: ["joinResolution", "outcome"]
            },
            required: true,
            missing: "fail"
          },
          {
            target: "skippedBy",
            source: {
              kind: "node-outcome",
              nodeId: "skipped",
              path: ["skipProvenance", "sourceNodeId"]
            },
            required: true,
            missing: "fail"
          }
        ],
        config: {
          ...handler.config,
          command: {
            kind: "structured",
            executable: "/usr/bin/printf",
            args: [
              {
                kind: "literal",
                value: '{"admission":"%s","join":"%s","skippedBy":"%s"}'
              },
              ...["admission", "join", "skippedBy"].map((input) => ({
                kind: "input" as const,
                input
              }))
            ]
          }
        }
      },
      shell("skipped"),
      {
        ...shell("race"),
        joinPolicy: "any-successful",
        anySuccessfulDisposition: "wait"
      },
      ...["a", "b"].map((id) => ({ ...shell(id), inputMappings: [missing] }))
    ],
    edges: [
      edge("start", "a"),
      edge("start", "b"),
      edge("a", "race", "success"),
      edge("b", "race", "success"),
      edge("race", "handler", "failure"),
      edge("race", "skipped", "success"),
      edge("skipped", "handler"),
      edge("handler", "end", "success")
    ],
    outputs: [
      {
        id: "handled",
        required: true,
        source: { kind: "node-result", nodeId: "handler" }
      },
      ...["a", "race", "skipped"].map((nodeId) => ({
        id: nodeId,
        required: true,
        source: { kind: "node-outcome" as const, nodeId }
      }))
    ]
  };
  let run: WorkflowRun | undefined;
  try {
    const runId = await publishRun(page, definition);
    await expect
      .poll(
        async () => {
          run = (await page.evaluate(
            (runId) =>
              window.kmux.orchestration({
                method: "orchestration.run.get",
                params: { runId }
              }),
            runId
          )) as WorkflowRun;
          return run.status;
        },
        { timeout: 20_000 }
      )
      .toBe("succeeded");

    expect(run!.outputs).toMatchObject({
      handled: {
        admission: "missing-required-input",
        join: "unsatisfied",
        skippedBy: "race"
      },
      a: {
        outcome: "failed",
        admissionFailure: {
          class: "input-mapping",
          mappingTarget: "requiredValue"
        }
      },
      race: {
        outcome: "failed",
        joinResolution: {
          outcome: "unsatisfied",
          selectedPredecessors: ["a", "b"]
        }
      },
      skipped: {
        outcome: "skipped",
        skipProvenance: { sourceNodeId: "race", selectedPort: "failure" }
      }
    });
    for (const id of ["a", "b", "race", "skipped"]) {
      expect(run!.graph.nodes[id]!.attemptIds).toEqual([]);
      expect(run!.results[id]).toBeUndefined();
    }
    expect(run!.coordinatorTurns).toEqual([]);
    const operations = Object.values(run!.shellOperations);
    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    expect(operation).toMatchObject({ state: "applied", exitCode: 0 });
    expect(operation.processId).toBeGreaterThan(0);
    expect(run!.attempts[operation.attemptId]).toMatchObject({
      nodeId: "handler",
      status: "succeeded"
    });
    const execution = operation.execution!;
    const snapshot = await getSurfaceSnapshot(page, execution.surfaceId, {
      includeRawOutputTail: true
    });
    expect(snapshot).toMatchObject({
      surfaceId: execution.surfaceId,
      sessionId: execution.sessionId
    });
    expect(run!.results.handler!.shellExecutionReceipt).toMatchObject({
      operationId: operation.operationId,
      execution,
      exitCode: 0,
      outputHash: operation.outputHash,
      outputBytes: operation.outputBytes
    });
    writeFileSync(
      testInfo.outputPath("outcome-dataflow-run.json"),
      JSON.stringify(
        {
          run,
          execution,
          snapshot
        },
        evidenceValue,
        2
      )
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

test("a for-each Loop handles unstarted body failures and forwards every scoped receipt to a managed Shell", async ({}, testInfo) => {
  const launched = await launchKmux("kmux-loop-outcomes-");
  const { page } = launched;
  const base = starterWorkflowDefinition({
    definitionId: "loop-outcomes",
    name: "Loop outcomes"
  });
  const command: ShellNodeDefinition["config"] = {
    version: 1,
    targetPolicy: "local",
    surfacePolicy: "create",
    cwdPolicy: "workspace",
    resultMode: "json-stdout",
    maxOutputBytes: 4096,
    command: {
      kind: "structured",
      executable: "/usr/bin/printf",
      args: [{ kind: "literal", value: "{}" }]
    }
  };
  const definition: WorkflowDefinitionV1 = {
    ...base,
    inputs: [{ id: "optionalValue", required: false }],
    nodes: [
      ...base.nodes,
      {
        id: "handler",
        kind: "shell",
        title: "Report both outcomes",
        joinPolicy: "all-successful",
        inputMappings: ["first", "second"].map((target, index) => ({
          target,
          source: {
            kind: "node-result",
            nodeId: "loop",
            path: ["accumulated", String(index), "admissionFailure", "code"]
          },
          required: true,
          missing: "fail"
        })),
        config: {
          ...command,
          command: {
            kind: "structured",
            executable: "/usr/bin/printf",
            args: [
              { kind: "literal", value: '{"first":"%s","second":"%s"}' },
              { kind: "input", input: "first" },
              { kind: "input", input: "second" }
            ]
          }
        }
      },
      {
        id: "loop",
        kind: "loop",
        title: "Collect handled failures",
        config: {
          version: 1,
          mode: "for-each",
          maxItems: 2,
          concurrency: 1,
          collection: { kind: "literal", value: ["first", "second"] },
          itemInputId: "item",
          body: {
            nodeIds: ["body"],
            entryNodeIds: ["body"],
            exits: [{ nodeId: "body", port: "failure", outcome: "handled" }]
          },
          accumulator: {
            outputId: "receipts",
            source: { kind: "node-outcome", nodeId: "body" }
          },
          completedPort: "completed",
          maxReachedPort: "max-reached"
        }
      },
      {
        id: "body",
        kind: "shell",
        title: "Fail before execution",
        onFailure: "skip-descendants",
        inputMappings: [
          {
            target: "requiredValue",
            source: { kind: "run-input", inputId: "optionalValue" },
            required: true,
            missing: "fail"
          }
        ],
        config: command
      }
    ],
    edges: [
      { id: "start-loop", from: { nodeId: "start" }, to: { nodeId: "loop" } },
      {
        id: "loop-handler",
        from: { nodeId: "loop", port: "completed" },
        to: { nodeId: "handler" }
      },
      {
        id: "loop-max",
        from: { nodeId: "loop", port: "max-reached" },
        to: { nodeId: "handler" }
      },
      { id: "handler-end", from: { nodeId: "handler" }, to: { nodeId: "end" } }
    ],
    outputs: [
      {
        id: "handled",
        required: true,
        source: { kind: "node-result", nodeId: "handler" }
      }
    ]
  };
  let run: WorkflowRun | undefined;
  try {
    const runId = await publishRun(page, definition);
    await expect
      .poll(
        async () => {
          run = (await page.evaluate(
            (runId) =>
              window.kmux.orchestration({
                method: "orchestration.run.get",
                params: { runId }
              }),
            runId
          )) as WorkflowRun;
          return run.status;
        },
        { timeout: 20_000 }
      )
      .toBe("succeeded");
    expect(run!.outputs).toEqual({
      handled: {
        first: "missing-required-input",
        second: "missing-required-input"
      }
    });
    expect(
      run!.graph.nodes.loop?.loopState?.completedIterationIds
    ).toHaveLength(2);
    const body = Object.values(run!.graph.nodes).filter(
      (node) => node.materialization?.templateNodeId === "body"
    );
    expect(body).toHaveLength(2);
    expect(
      new Set(body.map((node) => node.materialization!.iterationId)).size
    ).toBe(2);
    for (const node of body) {
      expect(node).toMatchObject({ status: "failed", attemptIds: [] });
      expect(run!.results[node.nodeId]).toBeUndefined();
    }
    const operations = Object.values(run!.shellOperations);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      nodeId: "handler",
      state: "applied",
      exitCode: 0,
      processId: expect.any(Number)
    });
    const snapshot = await getSurfaceSnapshot(
      page,
      operations[0]!.execution!.surfaceId
    );
    expect(snapshot?.sessionId).toBe(operations[0]!.execution!.sessionId);
    writeFileSync(
      testInfo.outputPath("loop-outcome-dataflow-run.json"),
      JSON.stringify({ run, snapshot }, evidenceValue, 2)
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

function evidenceValue(key: string, value: unknown): unknown {
  if (key === "inputAuthorityRef") return "[redacted]";
  return typeof value === "bigint" ? value.toString() : value;
}

async function publishRun(
  page: Page,
  definition: WorkflowDefinitionV1
): Promise<string> {
  return page.evaluate(
    async (serialized) => {
      const { definition, editor } = JSON.parse(serialized);
      const draft = (await window.kmux.orchestration({
        method: "workflow.draft.create",
        params: {
          draftId: `draft:${definition.definitionId}`,
          definitionId: definition.definitionId,
          name: definition.name,
          canonicalDraft: definition,
          editorDocument: editor
        }
      })) as { draftId: string; revision: number };
      const published = (await window.kmux.orchestration({
        method: "workflow.publish",
        params: { draftId: draft.draftId, expectedRevision: draft.revision }
      })) as { version: { workflowVersionId: string } };
      const started = (await window.kmux.orchestration({
        method: "workflow.run",
        params: {
          runId: `run:${definition.definitionId}`,
          workflowVersionId: published.version.workflowVersionId,
          inputs: {}
        }
      })) as { runId: string };
      return started.runId;
    },
    JSON.stringify({
      definition,
      editor: initializeFlowEditorDocument(definition)
    })
  );
}
