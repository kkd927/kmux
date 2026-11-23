#!/usr/bin/env node
// Deterministic ordinary terminal Agent fixture. It deliberately speaks no
// provider-private protocol: kmux pastes into this TUI exactly as it would an
// installed catalog CLI.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentId = process.argv[2] ?? "fixture-agent";
const sessionId = `terminal-fixture-${agentId}-${process.pid}`;
const focusReports = new RegExp(`${String.fromCharCode(27)}\\[([IO])`, "gu");
let input = "";
let pendingPrompt;
let turns = 0;
let coordinated = false;

const invoke = (args) => {
  const result = spawnSync("kmux", ["orchestration", ...args], {
    env: process.env,
    encoding: "utf8"
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `kmux orchestration ${args[0]} failed`);
  return JSON.parse(result.stdout);
};

const awaitUiGate = (argument, marker, payload) => {
  const index = process.argv.indexOf(argument);
  if (index === -1) return;
  const gate = process.argv[index + 1];
  if (!gate) throw new Error(`${argument} needs a path`);
  process.stdout.write(`${marker}: ${JSON.stringify(payload)}\r\n`);
  const deadline = Date.now() + 45_000;
  while (!existsSync(gate)) {
    if (Date.now() >= deadline) throw new Error(`${marker} timed out`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
};

const submit = (prompt, data, summary) => {
  const taskId = prompt.match(/^Task: (.+)$/mu)?.[1]?.trim();
  const dispatchId = prompt.match(/^Dispatch: (.+)$/mu)?.[1]?.trim();
  if (!taskId || !dispatchId)
    throw new Error("Fixture Task is missing its Task or Dispatch identity");
  const reportPath = join(
    process.cwd(),
    "..",
    `.kmux-fixture-report-${agentId}-${process.pid}.md`
  );
  writeFileSync(reportPath, `${summary}\n\n${JSON.stringify(data, null, 2)}\n`);
  invoke([
    "heartbeat",
    "--task",
    taskId,
    "--dispatch",
    dispatchId,
    "--phase",
    "Review complete; submitting findings"
  ]);
  const result = spawnSync(
    "kmux",
    [
      "orchestration",
      "worker-done",
      "--task",
      taskId,
      "--dispatch",
      dispatchId,
      "--outcome",
      "succeeded",
      "--summary",
      summary,
      "--report-path",
      reportPath,
      "--data",
      JSON.stringify(data)
    ],
    { env: process.env, encoding: "utf8" }
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "worker-done failed");
};

const exchangeMailbox = (prompt) => {
  const dispatchId = prompt.match(/^Dispatch: (.+)$/mu)?.[1]?.trim();
  if (!dispatchId) throw new Error("Fixture Task has no Dispatch identity");
  invoke(["check", "--dispatch", dispatchId]);
  invoke([
    "ask",
    "--dispatch",
    dispatchId,
    "--text",
    "FIXED_QUESTION: which release channel should this Worker report?"
  ]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const received = invoke([
      "check",
      "--dispatch",
      dispatchId,
      "--wait",
      "--types",
      "reply,guidance",
      "--timeout-ms",
      String(Math.min(10_000, Math.max(1, deadline - Date.now())))
    ]);
    const reply = received.delivery?.events?.find(
      (event) => event.type === "reply"
    );
    if (!reply) continue;
    const answer = reply.message?.body?.text;
    if (typeof answer !== "string")
      throw new Error("Fixture reply has no text body");
    invoke([
      "check",
      "--dispatch",
      dispatchId,
      "--ack",
      received.delivery.deliveryId,
      "--summary",
      `Applied Coordinator answer: ${answer}`
    ]);
    return answer;
  }
  throw new Error("Fixture Worker timed out waiting for its durable reply");
};

const coordinateLifecycle = () => {
  const runId = invoke([
    "run-create",
    "--objective",
    "Sequential Tasks, terminal reuse, and archived cancellation"
  ]).run.runId;
  const tasks = ["FIRST", "SECOND", "REUSED", "HOLD"].map((phase, index) => {
    const taskId = `task:lifecycle-${phase.toLowerCase()}`;
    const args = [
      "task-create",
      "--run",
      runId,
      "--task",
      taskId,
      "--spec",
      `FIXTURE_PHASE_${phase}`
    ];
    if (index)
      args.push(
        "--depends",
        `task:lifecycle-${["first", "second", "reused"][index - 1]}`
      );
    invoke(args);
    return taskId;
  });
  const start = (index, reuse) => {
    const args = [
      "worker-start",
      "--run",
      runId,
      "--task",
      tasks[index],
      "--agent",
      index === 0 || index === 3 ? "antigravity" : "copilot",
      "--no-coding"
    ];
    if (reuse) args.push("--reuse", reuse);
    const worker = invoke(args);
    if (worker.reachedStage !== "task-delivered")
      throw new Error(
        `Lifecycle Worker did not start: ${JSON.stringify(worker)}`
      );
    return worker;
  };
  const result = (worker) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const received = invoke([
        "check",
        "--run",
        runId,
        "--wait",
        "--types",
        "worker_done",
        "--timeout-ms",
        "1000"
      ]);
      if (!received.delivery) continue;
      const done = received.delivery.events.find(
        (event) => event.result?.attemptId === worker.attemptId
      );
      if (done?.result?.outcome !== "succeeded")
        throw new Error(
          `Unexpected lifecycle result: ${JSON.stringify(received)}`
        );
      return received.delivery.deliveryId;
    }
    throw new Error("Lifecycle result timed out");
  };
  const ack = (deliveryId) =>
    invoke([
      "check",
      "--run",
      runId,
      "--ack",
      deliveryId,
      "--summary",
      "Evaluated lifecycle result"
    ]);
  const read = (worker) =>
    invoke([
      "worker-read",
      "--dispatch",
      worker.dispatchId,
      "--lines",
      "10000"
    ]);
  const first = start(0);
  const firstDelivery = result(first);
  awaitUiGate("--fixture-focus-gate", "LIFECYCLE_FOCUS_READY", {
    runId,
    worker: first
  });
  ack(firstDelivery);
  const firstHistory = read(first);
  // These Tasks were authored before acknowledgement, but were not graph nodes yet.
  const second = start(1);
  const secondDelivery = result(second);
  const reused = start(2, second.dispatchId);
  const previous = read(second);
  const previousText = previous.rawOutputTail ?? previous.vt ?? "";
  if (
    !previous.archived ||
    !previousText.includes("FIXTURE_PHASE_SECOND") ||
    previousText.includes("FIXTURE_PHASE_REUSED")
  )
    throw new Error(
      "Terminal reuse did not preserve the previous Dispatch's own output"
    );
  ack(secondDelivery);
  const reusedDelivery = result(reused);
  awaitUiGate("--fixture-takeover-gate", "LIFECYCLE_TAKEOVER_READY", {
    runId,
    worker: reused
  });
  ack(reusedDelivery);
  const held = start(3);
  const stopped = invoke(["worker-stop", "--dispatch", held.dispatchId]);
  if (stopped.outcome !== "confirmed")
    throw new Error(
      `Cancellation was not confirmed: ${JSON.stringify(stopped)}`
    );
  const canceled = read(held);
  if (
    !canceled.archived ||
    !(canceled.rawOutputTail ?? canceled.vt ?? "").includes(
      `[kmux-dispatch:${held.dispatchId}]`
    )
  )
    throw new Error("Stopped Worker output was not preserved");
  // worker-stop confirms cancellation directly; it is not a Worker-authored
  // worker-done event. A nonblocking check settles the remaining Run graph.
  invoke(["check", "--run", runId]);
  process.stdout.write(
    `LIFECYCLE_ACCEPTANCE: ${JSON.stringify({ runId, tasks, first, second, reused, held, firstArchived: firstHistory.archived, previousArchived: previous.archived, stoppedArchived: canceled.archived })}\r\n`
  );
};

const coordinateDecision = () => {
  const runId = invoke([
    "run-create",
    "--objective",
    "Native decision acceptance"
  ]).run.runId;
  invoke([
    "task-create",
    "--run",
    runId,
    "--task",
    "choice",
    "--spec",
    "User selects A or B"
  ]);
  invoke([
    "task-create",
    "--run",
    runId,
    "--task",
    "after-choice",
    "--spec",
    "FIXTURE_PHASE_FIRST",
    "--depends",
    "choice"
  ]);
  invoke([
    "gate-create",
    "--run",
    runId,
    "--task",
    "choice",
    "--question",
    "Choose the candidate to verify",
    "--options",
    '["A","B"]'
  ]);
  process.stdout.write(`GATE_UI_READY: ${JSON.stringify({ runId })}\r\n`);
  const deadline = Date.now() + 45_000;
  let gate;
  while (Date.now() < deadline) {
    gate = invoke(["gate-list", "--run", runId, "--task", "choice"]).gates[0];
    if (gate?.state === "resolved") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (gate?.resolution !== "A")
    throw new Error("Expected explicit user choice A");
  const worker = invoke([
    "worker-start",
    "--run",
    runId,
    "--task",
    "after-choice",
    "--agent",
    "antigravity",
    "--no-coding"
  ]);
  let received;
  do {
    received = invoke([
      "check",
      "--run",
      runId,
      "--wait",
      "--timeout-ms",
      "1000"
    ]);
  } while (!received.delivery && Date.now() < deadline);
  if (
    !received.delivery?.events.some(
      (event) => event.result?.outcome === "succeeded"
    )
  )
    throw new Error("Dependent Worker result missing");
  invoke(["worker-release", "--dispatch", worker.dispatchId]);
  const history = invoke(["worker-read", "--dispatch", worker.dispatchId]);
  if (!history.archived) throw new Error("Dependent Worker archive missing");
  const final = invoke([
    "check",
    "--run",
    runId,
    "--ack",
    received.delivery.deliveryId,
    "--summary",
    "Reviewed result and archived history after explicit user choice"
  ]);
  process.stdout.write(
    `GATE_UI_COMPLETE: ${JSON.stringify({ runId, status: final.run.status, gateId: gate.gateId })}\r\n`
  );
};

const review = (prompt) => {
  if (
    process.argv.includes("--fixture-native-decision") &&
    !prompt.includes("[kmux worker task]")
  ) {
    coordinateDecision();
    return;
  }
  if (
    process.argv.includes("--fixture-lifecycle") &&
    !prompt.includes("[kmux worker task]")
  ) {
    coordinateLifecycle();
    return;
  }
  const phase = prompt.match(/FIXTURE_PHASE_(FIRST|SECOND|REUSED|HOLD)/u)?.[1];
  if (phase) {
    process.stdout.write(`FIXTURE_OUTPUT_${phase}\r\n`);
    if (phase === "HOLD") return;
    const dispatchId = prompt.match(/^Dispatch: (.+)$/mu)?.[1]?.trim();
    invoke(["check", "--dispatch", dispatchId]);
    submit(
      prompt,
      { phase, processId: process.pid },
      `Completed lifecycle phase ${phase}; findings none; remaining work none`
    );
    return;
  }
  if (
    process.argv.includes("--fixture-coordinator") &&
    !prompt.includes("[kmux worker task]")
  ) {
    if (coordinated)
      throw new Error("Coordinator fixture received a second objective");
    coordinated = true;
    const reviewFile =
      process.env.KMUX_FIXTURE_REVIEW_FILE ?? "REVIEW_INPUT.md";
    const source = readFileSync(reviewFile, "utf8").trim();
    const analysis = `Coordinator inspected ${reviewFile}: ${source}`;
    process.stdout.write(`ANALYSIS: ${analysis}\r\n`);
    const created = invoke([
      "run-create",
      "--objective",
      "Collect two independent reviews"
    ]);
    const runId = created.run.runId;
    const liveAgent = process.env.KMUX_FIXTURE_LIVE_AGENT;
    const workerAgents = liveAgent ? [liveAgent] : ["antigravity", "copilot"];
    const workersByAttempt = new Map();
    for (const workerAgent of workerAgents) {
      const args = [
        "worker-start",
        "--run",
        runId,
        "--spec",
        `${analysis}\nThis is a protocol acceptance task. Do not edit files, search the repository, or start background work. Run the required nonblocking Worker check. Then run ask --dispatch with exactly: FIXED_QUESTION: which release channel should this Worker report? Wait with check --dispatch --wait --types reply,guidance, process and ack that Delivery. Run the required final nonblocking check, then immediately submit worker-done with a concise summary containing the Coordinator answer and the supplied fact that AGENTS.md describes kmux as a terminal app.`,
        "--agent",
        workerAgent,
        "--no-coding"
      ];
      if (!liveAgent) args.push("--model", "fixture-model", "--effort", "low");
      const started = invoke(args);
      if (started.reachedStage !== "task-delivered")
        throw new Error(
          `${workerAgent} Worker reached '${started.reachedStage}'${
            started.issue?.message
              ? `: ${started.issue.message}`
              : started.failedStage
                ? ` (${started.failedStage})`
                : ""
          }`
        );
      workersByAttempt.set(started.attemptId, started);
    }
    const placementGate = process.argv.indexOf("--fixture-placement-gate");
    if (placementGate !== -1) {
      const gatePath = process.argv[placementGate + 1];
      if (!gatePath) throw new Error("Fixture placement gate needs a path");
      process.stdout.write("WORKER_PLACEMENT_READY\r\n");
      const deadline = Date.now() + 30_000;
      while (!existsSync(gatePath)) {
        if (Date.now() >= deadline)
          throw new Error("Fixture placement gate timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    const results = new Map();
    const resultDeadline = Date.now() + 150_000;
    while (results.size < workerAgents.length && Date.now() < resultDeadline) {
      const received = invoke([
        "check",
        "--run",
        runId,
        "--wait",
        "--types",
        "worker_done,question,escalation",
        "--timeout-ms",
        String(Math.min(30_000, Math.max(1, resultDeadline - Date.now())))
      ]);
      for (const event of received.delivery?.events ?? []) {
        if (event.type === "question") {
          const worker = workersByAttempt.get(event.message?.attemptId);
          if (!worker)
            throw new Error(
              "Coordinator received a question from an unknown Worker"
            );
          invoke([
            "reply",
            "--run",
            runId,
            "--dispatch",
            worker.dispatchId,
            "--reply-to",
            event.message.messageId,
            "--text",
            "stable"
          ]);
        }
        if (event.type !== "worker_done") continue;
        const result = event.result;
        if (result?.outcome !== "succeeded")
          throw new Error(
            `Worker ${result?.attemptId ?? "unknown"} failed before explicit completion: ${result?.summary ?? "missing result"}`
          );
        const worker = workersByAttempt.get(result.attemptId);
        if (!worker)
          throw new Error(
            "Coordinator received a result from an unknown Worker"
          );
        awaitUiGate("--fixture-completion-gate", "WORKER_RESULT_READY", {
          runId,
          worker
        });
        invoke(["worker-release", "--dispatch", worker.dispatchId]);
        const history = invoke([
          "worker-read",
          "--dispatch",
          worker.dispatchId,
          "--lines",
          "10000"
        ]);
        const output = history.rawOutputTail ?? history.vt ?? "";
        process.stdout.write(
          `WORKER_HISTORY: ${JSON.stringify({
            dispatchId: worker.dispatchId,
            source: history.source,
            status: history.status,
            archived: history.archived === true,
            hasDispatchMarker: output.includes(
              `[kmux-dispatch:${worker.dispatchId}]`
            ),
            hasWorkerDone: output.includes("worker-done")
          })}\r\n`
        );
        results.set(result.attemptId, result);
      }
      if (received.delivery?.deliveryId) {
        invoke([
          "check",
          "--run",
          runId,
          "--ack",
          received.delivery.deliveryId,
          "--summary",
          "Coordinator reviewed the delivered evidence"
        ]);
      }
    }
    if (results.size !== workerAgents.length)
      throw new Error(
        `Coordinator received ${results.size} of ${workerAgents.length} explicit results`
      );
    process.stdout.write(
      `COORDINATOR_SYNTHESIS: reviewed ${results.size} explicit Worker results in the original terminal\r\n`
    );
    turns++;
    return;
  }
  const answer = exchangeMailbox(prompt);
  const source = readFileSync("REVIEW_INPUT.md", "utf8").trim();
  submit(
    prompt,
    {
      providerSessionId: sessionId,
      processId: process.pid,
      cwd: process.cwd(),
      turnOrdinal: ++turns,
      coordinatorAnswer: answer,
      findings: [
        {
          severity: "important",
          file: "REVIEW_INPUT.md",
          evidence: source,
          reasoning: `${agentId} checked the supplied instruction against source`
        }
      ]
    },
    `${agentId} reviewed the supplied evidence and applied reply '${answer}' in its ordinary terminal`
  );
};

const fail = (error) => {
  process.stderr.write(
    `\nFixture Agent failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
};

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
if (process.argv.includes("--fixture-focus-reporting"))
  process.stdout.write("\u001b[?1004h");
process.stdout.write(`${agentId} fixture Agent ready\r\n> `);
process.stdin.on("data", (chunk) => {
  if (process.argv.includes("--fixture-focus-reporting")) {
    chunk = chunk.replace(focusReports, (_report, kind) => {
      process.stdout.write(`\r\nFIXTURE_FOCUS_REPORT_${kind}\r\n> `);
      return "";
    });
  }
  input += chunk;
  try {
    if (!pendingPrompt) {
      const start = input.indexOf("\u001b[200~");
      const end = input.indexOf("\u001b[201~", start + 6);
      if (start >= 0 && end >= 0) {
        pendingPrompt = input.slice(start + 6, end);
        input = input.slice(end + 6);
        // A real TUI reflects the paste in its input area. kmux waits for the
        // exact dispatch marker in this output before sending Enter.
        process.stdout.write(pendingPrompt);
      }
    }
    if (pendingPrompt && /[\r\n]/u.test(input)) {
      input = input.replace(/^[\s\S]*?[\r\n]/u, "");
      const prompt = pendingPrompt;
      pendingPrompt = undefined;
      process.stdout.write("\r\nWorking...\r\n");
      review(prompt);
      process.stdout.write("Result submitted.\r\n> ");
    } else if (
      !pendingPrompt &&
      !input.includes("\u001b[200~") &&
      /[\r\n]/u.test(input)
    ) {
      const match = input.match(/^([\s\S]*?)[\r\n]/u);
      const prompt = match?.[1] ?? "";
      input = input.slice(match?.[0].length ?? 0);
      if (prompt.trim()) {
        process.stdout.write(`${prompt}\r\nWorking...\r\n`);
        review(prompt);
        process.stdout.write("Ready for follow-up.\r\n> ");
      }
    }
  } catch (error) {
    fail(error);
  }
});
