#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agent = process.argv[2];
const isCaller = process.argv.includes("--caller");
const alwaysBlocker = process.argv.includes("--always-blocker");
const rpc = (args) => {
  const command = spawnSync("kmux", args, {
    env: process.env,
    encoding: "utf8",
    timeout: 40000
  });
  if (command.status !== 0)
    throw new Error(command.stderr || `${args.join(" ")} failed`);
  return JSON.parse(command.stdout);
};
const check = (runId, args = []) =>
  rpc(["orchestration", "check", "--run", runId, ...args]);
const submitReview = (prompt) => {
  const task = prompt.match(/^Task: (.+)$/mu)?.[1].trim();
  const dispatch = prompt.match(/^Dispatch: (.+)$/mu)?.[1].trim();
  if (!task || !dispatch) throw new Error("Missing native task identity");
  rpc(["orchestration", "check", "--dispatch", dispatch]);
  const count =
    alwaysBlocker || readFileSync("REVIEW_INPUT.md", "utf8").includes("BLOCKER")
      ? 1
      : 0;
  const data = {
    blockerCount: count,
    blockers: count
      ? [
          {
            title: "Fixture blocker",
            file: "REVIEW_INPUT.md",
            evidence: "BLOCKER",
            reasoning: "Fixture release gate"
          }
        ]
      : [],
    review: `${agent} full independent review by ${process.pid}`,
    processId: process.pid
  };
  delete data.processId; // Workflow declares only its documented review fields.
  rpc([
    "orchestration",
    "worker-done",
    "--task",
    task,
    "--dispatch",
    dispatch,
    "--outcome",
    "succeeded",
    "--summary",
    `Reviewed in new process ${process.pid}`,
    "--data",
    JSON.stringify(data)
  ]);
};
const callWorkflow = () => {
  const inputs = join(process.cwd(), "..", "workflow-inputs.json");
  writeFileSync(
    inputs,
    JSON.stringify({
      task: "Review completed implementation",
      implementationResult: {
        summary: "Implementation complete",
        changedFiles: ["REVIEW_INPUT.md"],
        tests: ["fixture baseline"]
      }
    })
  );
  const created = rpc([
    "workflow",
    "run",
    "--workflow",
    "코드 리뷰 · 수정 2회 후 최종 검증",
    "--inputs",
    inputs
  ]);
  const runId = created.runId;
  process.stdout.write(
    `WORKFLOW_STARTED: ${runId}, original process ${process.pid}\r\n`
  );
  let ack;
  const completed = new Set();
  const deadline = Date.now() + 80000;
  while (Date.now() < deadline) {
    const received = check(
      runId,
      ack ? ["--ack", ack] : ["--wait", "--timeout-ms", "10000"]
    );
    ack = undefined;
    let acknowledgedDelivery = false;
    for (const event of received.delivery?.events ?? []) {
      if (event.type !== "caller_task") continue;
      const task = event.callerTask;
      if (task.state === "completed" || completed.has(task.requestId)) continue;
      if (
        !task.inputs.codexReview?.review ||
        !task.inputs.antigravityReview?.review
      )
        throw new Error("Both complete reviews must be admitted");
      // Acknowledgement alone cannot advance. Preserve any next FIFO Delivery.
      const acknowledged = check(runId, [
        "--ack",
        received.delivery.deliveryId
      ]);
      ack = acknowledged.delivery?.deliveryId;
      acknowledgedDelivery = true;
      writeFileSync("REVIEW_INPUT.md", "FIXED by original Agent\n");
      const resultFile = join(
        process.cwd(),
        "..",
        `caller-result-${task.requestId.replaceAll(":", "_")}.json`
      );
      writeFileSync(
        resultFile,
        JSON.stringify({
          outcome: "succeeded",
          summary: `Fact-checked by original process ${process.pid}`,
          data: {
            factCheck: "Both full reports inspected",
            changes: ["Fixed fixture blocker"],
            tests: ["fixture passed"],
            remainingBlockers: 0
          }
        })
      );
      rpc([
        "workflow",
        "caller-done",
        "--run",
        runId,
        "--attempt",
        task.attemptId,
        "--request",
        task.requestId,
        "--result",
        resultFile
      ]);
      completed.add(task.requestId);
      process.stdout.write(
        `CALLER_FIXED: ${task.requestId}, original process ${process.pid}\r\n`
      );
    }
    if (received.delivery && !acknowledgedDelivery)
      ack = received.delivery.deliveryId;
    if (["failed", "canceled", "needs-attention"].includes(received.run.status))
      throw new Error(`Workflow stopped: ${JSON.stringify(received.run)}`);
    if (received.run.status === "succeeded" && !ack) {
      process.stdout.write(
        `WORKFLOW_COMPLETE: ${JSON.stringify({ runId, fixes: completed.size, output: received.run.outputs.reviewResult, originalPid: process.pid })}\r\n`
      );
      return;
    }
  }
  throw new Error("Workflow timed out");
};
let input = "";
let paste;
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdout.write(`${agent} Workflow fixture ready\r\n> `);
process.stdin.on("data", (chunk) => {
  input += chunk;
  try {
    if (!paste) {
      const start = input.indexOf("\u001b[200~");
      const end = input.indexOf("\u001b[201~", start + 6);
      if (start >= 0 && end >= 0) {
        paste = input.slice(start + 6, end);
        input = input.slice(end + 6);
        process.stdout.write(paste);
      }
    }
    if (paste && /[\r\n]/u.test(input)) {
      const prompt = paste;
      paste = undefined;
      input = "";
      process.stdout.write("\r\nWorking...\r\n");
      submitReview(prompt);
      process.stdout.write("Result submitted.\r\n> ");
    } else if (
      isCaller &&
      !paste &&
      !input.includes("\u001b[200~") &&
      /[\r\n]/u.test(input)
    ) {
      input = "";
      callWorkflow();
      process.stdout.write("Original conversation remains ready.\r\n> ");
    }
  } catch (error) {
    process.stderr.write(`\r\nWORKFLOW_FIXTURE_ERROR: ${error.message}\r\n`);
  }
});
