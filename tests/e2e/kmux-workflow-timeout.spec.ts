import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "@kmux/orchestration";
import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  launchKmuxWithSandbox,
  waitForSurfaceSnapshotContains,
  waitForProcessIdsExit
} from "./helpers";

for (const policy of ["checkpoint", "fail", "cancel-and-retry"] as const) {
  test(`managed Shell ${policy} timeout follows persisted policy and exact process cancellation`, async ({}, testInfo) => {
    const sandbox = createSandbox("kmux-shell-timeout-");
    const fixture = path.join(sandbox.profileRoot, "timeout-command.mjs");
    const pidsFile = path.join(sandbox.profileRoot, "fixture-pids.jsonl");
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const marker = fileURLToPath(new URL("./first-attempt", import.meta.url));
const pids = fileURLToPath(new URL("./fixture-pids.jsonl", import.meta.url));
appendFileSync(pids, JSON.stringify({ pid: process.pid, operationId: process.env.KMUX_ORCHESTRATION_COMMAND_ID }) + "\\n");
console.error("workflow-fixture-progress");
const policy = process.argv[2];
if (policy === "checkpoint") {
  setTimeout(() => process.stdout.write(JSON.stringify({ completed: true })), 1900);
} else if (!existsSync(marker)) {
  writeFileSync(marker, "first attempt started");
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ completed: true }));
}
`,
      { mode: 0o755 }
    );
    let launched = await launchKmuxWithSandbox(sandbox);
    const { page } = launched;
    const base = starterWorkflowDefinition({
      definitionId: `timeout-${policy}`,
      name: `Timeout ${policy}`
    });
    const definition: WorkflowDefinitionV1 = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "command",
          kind: "shell",
          title: "Bounded fixture command",
          config: {
            version: 1,
            targetPolicy: "local",
            surfacePolicy: "create",
            cwdPolicy: "workspace",
            resultMode: "json-stdout",
            maxOutputBytes: 1024,
            command: {
              kind: "structured",
              executable: fixture,
              args: [{ kind: "literal", value: policy }]
            }
          },
          timeoutPolicy: { timeoutMs: 1500, onTimeout: policy },
          retryPolicy: {
            maxAttempts: 2,
            retryable: ["timeout"],
            backoffMs: 100,
            placement: "same"
          },
          onFailure: "fail-run"
        }
      ],
      edges: [
        {
          id: "start-command",
          from: { nodeId: "start" },
          to: { nodeId: "command" }
        },
        {
          id: "command-end",
          from: { nodeId: "command" },
          to: { nodeId: "end" }
        }
      ],
      outputs: [
        {
          id: "result",
          required: true,
          source: { kind: "node-result", nodeId: "command" }
        }
      ]
    };
    let run: WorkflowRun | undefined;
    try {
      const runId = await page.evaluate(
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
            params: {
              draftId: draft.draftId,
              expectedRevision: draft.revision
            }
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
        .toBe(policy === "fail" ? "failed" : "succeeded");
      const attempts = Object.values(run!.attempts).filter(
        (attempt) => attempt.nodeId === "command"
      );
      expect(attempts).toHaveLength(policy === "cancel-and-retry" ? 2 : 1);
      expect(Object.values(run!.dispatches)).toHaveLength(0);
      expect(
        Object.values(run!.timers).filter(
          (timer) => timer.kind === "timeout" && timer.state === "fired"
        )
      ).toHaveLength(1);
      if (policy === "checkpoint") {
        expect(run!.outputs).toEqual({ result: { completed: true } });
        expect(Object.values(run!.cancellations)).toHaveLength(0);
      } else {
        const cancellation = Object.values(run!.cancellations)[0]!;
        expect(cancellation).toMatchObject({
          state: "confirmed",
          attemptId: attempts[0]!.attemptId,
          timeout: { onTimeout: policy }
        });
        expect(cancellation.executorReceiptId).toBeTruthy();
        expect(run!.attemptResults[attempts[0]!.attemptId]).toMatchObject({
          outcome: "failed",
          failureClass: "timeout"
        });
        expect(
          Object.values(run!.shellOperations).find(
            (operation) => operation.attemptId === attempts[0]!.attemptId
          )?.state
        ).toBe("canceled");
        if (policy === "cancel-and-retry") {
          expect(attempts[1]).toMatchObject({
            status: "succeeded",
            retryOfAttemptId: attempts[0]!.attemptId
          });
          expect(Date.parse(attempts[1]!.createdAt)).toBeGreaterThanOrEqual(
            Date.parse(cancellation.settledAt!) + 100
          );
          expect(run!.outputs).toEqual({ result: { completed: true } });
        }
      }
      const records = readFileSync(pidsFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { pid: number; operationId: string }
        );
      expect(records).toHaveLength(attempts.length);
      expect(new Set(records.map((record) => record.operationId)).size).toBe(
        attempts.length
      );
      await waitForProcessIdsExit(
        records.map((record) => record.pid),
        10_000
      );
      if (policy === "checkpoint") {
        const surfaceId = Object.values(run!.shellOperations)[0]!.execution!
          .surfaceId;
        await closeKmuxApp(launched);
        launched = await launchKmuxWithSandbox(sandbox);
        await waitForSurfaceSnapshotContains(
          launched.page,
          surfaceId,
          "workflow-fixture-progress"
        );
        expect(readFileSync(pidsFile, "utf8").trim().split("\n")).toHaveLength(
          1
        );
      }
      writeFileSync(
        testInfo.outputPath("timeout-run.json"),
        JSON.stringify({ run, processes: records, terminated: true }, null, 2)
      );
    } finally {
      if (run)
        writeFileSync(
          testInfo.outputPath("last-run.json"),
          JSON.stringify(run, null, 2)
        );
      await closeKmuxApp(launched);
      if (existsSync(pidsFile)) {
        const pids = readFileSync(pidsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { pid: number }).pid);
        await waitForProcessIdsExit(pids, 10_000);
      }
      destroySandbox(sandbox);
    }
  });
}
