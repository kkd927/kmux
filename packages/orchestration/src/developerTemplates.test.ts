import { readFileSync } from "node:fs";
import {
  admitNode,
  compileFlowEditorDocument,
  contentHash,
  markAttemptRunning,
  materializeWorkflowRun,
  openHumanGate,
  publishWorkflowVersion,
  resolveHumanGate,
  selectWorkflowConditionPort,
  settleControlNode,
  startStructuredLoop,
  submitAttemptResult,
  type AgentResultSubmission,
  type JsonValue,
  type NodeAttempt,
  type RepositoryStateRef,
  type RuntimeContext
} from "./index";

function definition(number: number) {
  const document = JSON.parse(
    readFileSync(
      new URL(
        `../../../docs/examples/workflow-templates/case${number}.workflow.json`,
        import.meta.url
      ),
      "utf8"
    )
  ) as JsonValue;
  const compiled = compileFlowEditorDocument(document);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return compiled.value;
}

function harness(number: number) {
  let sequence = 0;
  const context: RuntimeContext = {
    now: () => "2026-10-24T08:00:00.000Z",
    id: (kind) => `${kind}:${++sequence}`
  };
  const template = definition(number);
  const inputs: Record<string, JsonValue> = {
    task: "Add the requested behavior in this project",
    acceptanceCriteria: "Preserve existing behavior and verify the request",
    constraints: "Preserve unrelated edits",
    validationCommand: "project-check --all",
    setupCommand: "project-install --locked",
    baselineCommand: "project-check --baseline",
    approachA: "Small compatible change",
    approachB: "Separate responsibilities",
    issue: "The supplied complete issue text"
  };
  for (const binding of Object.values(template.agentBindings)) {
    if (binding.agent.kind === "run-input")
      inputs[binding.agent.inputId] = `selected-${binding.agent.inputId}`;
  }
  let run = materializeWorkflowRun({
    runId: `run:template-${number}`,
    version: publishWorkflowVersion({
      definition: template,
      workflowVersionId: `version:template-${number}`,
      publishedAt: context.now()
    }),
    inputs,
    context
  });
  const admitted: NodeAttempt[] = [];
  const templateId = (nodeId: string) =>
    run.graph.nodes[nodeId]!.materialization?.templateNodeId ?? nodeId;
  const running = (id: string) =>
    Object.values(run.attempts).find(
      (a) => a.status === "running" && templateId(a.nodeId) === id
    );
  const pump = () => {
    for (let guard = 0; guard < 100; guard++) {
      const node = Object.values(run.graph.nodes).find(
        (node) => node.status === "ready"
      );
      if (!node) return;
      const admission = admitNode({
        run,
        nodeId: node.nodeId,
        expectedGraphRevision: run.graph.revision,
        expectedNodeStateRevision: node.stateRevision,
        context
      });
      run = admission.run;
      admitted.push(admission.attempt);
      if (
        node.definition.kind === "agent" ||
        node.definition.kind === "shell"
      ) {
        run = markAttemptRunning({
          run,
          attemptId: admission.attempt.attemptId,
          startedAt: context.now()
        });
      } else if (node.definition.kind === "human-gate") {
        run = openHumanGate({
          run,
          attemptId: admission.attempt.attemptId,
          context
        }).run;
      } else if (node.definition.kind === "loop") {
        run = startStructuredLoop({
          run,
          attemptId: admission.attempt.attemptId,
          context
        });
      } else {
        run = settleControlNode({
          run,
          attemptId: admission.attempt.attemptId,
          outcome: "succeeded",
          ...(node.definition.kind === "condition"
            ? {
                selectedPort: selectWorkflowConditionPort({
                  config: node.definition.config,
                  inputs: admission.attempt.resolvedInputs,
                  values: {}
                })
              }
            : {}),
          context
        });
      }
    }
    throw new Error("Template driver did not quiesce");
  };
  const complete = (
    id: string,
    data: JsonValue = { summary: `${id}: complete useful result` },
    trusted: { repositoryState?: RepositoryStateRef } = {},
    outcome: "succeeded" | "failed" = "succeeded"
  ) => {
    const attempt = running(id);
    if (!attempt) throw new Error(`${id} is not running`);
    const node = run.graph.nodes[attempt.nodeId]!;
    if (node.definition.kind === "shell") {
      run = settleControlNode({
        run,
        attemptId: attempt.attemptId,
        outcome,
        data,
        context
      });
    } else {
      const submission: AgentResultSubmission = { outcome, summary: id, data };
      run = submitAttemptResult({
        run,
        attemptId: attempt.attemptId,
        idempotencyKey: attempt.attemptId,
        submissionHash: contentHash(submission as unknown as JsonValue),
        submission,
        trusted,
        context
      }).run;
    }
    pump();
  };
  const choose = (nodeId: string, resolution: string) => {
    const gate = Object.values(run.gates).find(
      (g) => g.nodeId === nodeId && g.state === "open"
    );
    if (!gate) throw new Error(`Gate ${nodeId} is not open`);
    run = resolveHumanGate({
      run,
      gateId: gate.gateId,
      resolution,
      principal: "user:local",
      context
    });
    pump();
  };
  pump();
  return {
    get run() {
      return run;
    },
    get admissions() {
      return admitted;
    },
    running,
    complete,
    choose,
    attempts: (id: string) =>
      Object.values(run.attempts).filter((a) => templateId(a.nodeId) === id)
  };
}

const review = (count: number) => ({
  findingsCount: count,
  findings: Array.from({ length: count }, (_, i) => `Concrete finding ${i}`)
});
const verification = (passed = true) => ({
  passed,
  checks: ["Executed the requested project check"],
  issues: passed ? [] : ["A required check failed"]
});

describe("reusable developer Workflow templates", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "case %s admits user-selected providers and passes project inputs to its first Agent",
    (number) => {
      const h = harness(number);
      const first = Object.values(h.run.dispatches)[0]!;
      expect(first.selectedAgentId).toMatch(/^selected-/);
      expect(h.run.attempts[first.attemptId]!.resolvedInputs).toMatchObject({
        task: "Add the requested behavior in this project",
        validationCommand: "project-check --all"
      });
    }
  );

  it("requires plan approval, transfers prior findings, and rereviews the second correction", () => {
    const h = harness(1);
    h.complete("plan");
    expect(h.running("implement")).toBeUndefined();
    h.choose("approve-plan", "approve");
    h.complete("implement");
    h.complete("review", review(1));
    expect(h.running("correct")!.resolvedInputs.review).toEqual(review(1));
    h.complete("correct");
    expect(h.running("review")!.resolvedInputs.previousReview).toEqual(
      review(1)
    );
    h.complete("review", review(2));
    h.complete("correct");
    expect(h.running("review")!.resolvedInputs.previousReview).toEqual(
      review(2)
    );
    h.complete("review", review(0));
    expect(h.attempts("review")).toHaveLength(3);
    expect(h.attempts("correct")).toHaveLength(2);
    expect(h.running("final-validation")!.resolvedInputs.command).toBe(
      "project-check --all"
    );
    h.complete("final-validation", { exitCode: 0 });
    expect(h.run.status).toBe("succeeded");
    expect(h.run.outputs?.reviewResult).toMatchObject({
      outcome: "clean",
      iterations: 3
    });
  });

  it("does not admit final validation after the last review still has findings", () => {
    const h = harness(1);
    h.complete("plan");
    h.choose("approve-plan", "approve");
    h.complete("implement");
    for (let round = 0; round < 3; round++) {
      h.complete("review", review(1));
      if (round < 2) h.complete("correct");
    }
    expect(h.run.status).toBe("waiting-gate");
    expect(h.attempts("correct")).toHaveLength(2);
    expect(h.attempts("final-validation")).toHaveLength(0);
    h.choose("review-limit", "stop");
    expect(h.run.outputs?.reviewResult).toMatchObject({
      outcome: "max-reached"
    });
    expect(h.run.outputs?.validation).toMatchObject({ outcome: "skipped" });
  });

  it("waits for both parallel research/design results and delivers their full structured decisions", () => {
    const h = harness(2);
    expect(h.running("research")).toBeDefined();
    expect(h.running("design")).toBeDefined();
    const research = {
      summary: "Full research decision",
      evidence: ["actual API"]
    };
    const design = { summary: "Full design", interfaces: ["project boundary"] };
    h.complete("research", research);
    expect(h.running("implement")).toBeUndefined();
    h.complete("design", design);
    expect(h.running("implement")!.resolvedInputs).toMatchObject({
      research,
      design
    });
    h.complete("implement");
    h.complete("verify", verification(false));
    expect(h.attempts("final-validation")).toHaveLength(0);
    expect(h.run.status).toBe("waiting-gate");
  });

  it("holds both merges behind actual choice and admits only selected B", () => {
    const h = harness(3);
    h.complete("baseline", { headOid: "same-head", clean: true });
    expect(h.running("variantA")).toBeDefined();
    expect(h.running("variantB")).toBeDefined();
    h.complete("variantA", {
      baseline: "same-head",
      commit: "commit-A",
      summary: "A"
    });
    expect(h.running("mergeA")).toBeUndefined();
    h.complete("variantB", {
      baseline: "same-head",
      commit: "commit-B",
      summary: "B"
    });
    expect(h.attempts("mergeA")).toHaveLength(0);
    expect(h.attempts("mergeB")).toHaveLength(0);
    h.choose("choose", "B");
    expect(h.running("mergeB")!.resolvedInputs.alternative).toMatchObject({
      commit: "commit-B"
    });
    expect(h.attempts("mergeA")).toHaveLength(0);
    h.complete("mergeB");
    expect(h.running("verify")!.resolvedInputs.choice).toEqual({
      resolution: "B"
    });
    h.complete("verify", verification());
    h.complete("final-validation", { exitCode: 0 });
    expect(h.run.status).toBe("succeeded");
  });

  it.each([false, true])(
    "shares the trusted prepared worktree and stops descendants on setup failure (%s)",
    (failSetup) => {
      const h = harness(4);
      const receipt: RepositoryStateRef = {
        targetId: "local",
        repositoryId: "repository",
        worktreeRef: {
          targetId: "local",
          worktreeId: "prepared",
          pathToken: "trusted-path"
        },
        headOid: "baseline",
        capturedAt: "2026-10-24T08:00:00.000Z",
        consistency: "fenced-live-worktree"
      };
      h.complete(
        "prepare",
        { summary: "Prepared worktree" },
        { repositoryState: receipt }
      );
      expect(h.running("setup")!.resolvedInputs).toMatchObject({
        command: "project-install --locked",
        worktree: receipt
      });
      h.complete(
        "setup",
        { exitCode: failSetup ? 1 : 0 },
        {},
        failSetup ? "failed" : "succeeded"
      );
      if (failSetup) {
        expect(h.run.status).toBe("failed");
        expect(h.attempts("implement")).toHaveLength(0);
        return;
      }
      expect(h.running("baseline")!.resolvedInputs.worktree).toEqual(receipt);
      h.complete("baseline", { exitCode: 0 });
      expect(h.running("implement")!.resolvedInputs.worktree).toEqual(receipt);
      h.complete("implement");
      expect(h.running("verify")!.resolvedInputs.worktree).toEqual(receipt);
      h.complete("verify", verification());
      expect(h.running("final-validation")!.resolvedInputs.worktree).toEqual(
        receipt
      );
      h.complete("final-validation", { exitCode: 0 });
      expect(h.run.status).toBe("succeeded");
    }
  );

  it("does not fix or draft a PR when reproduction was not established", () => {
    const h = harness(5);
    h.complete("read-issue", {
      title: "Issue",
      body: "Complete original issue",
      url: ""
    });
    h.complete("reproduce", {
      reproduced: false,
      trigger: "observed command",
      expected: "required",
      actual: "could not reproduce"
    });
    expect(h.run.status).toBe("waiting-gate");
    expect(h.attempts("fix")).toHaveLength(0);
    expect(h.attempts("draft-pr")).toHaveLength(0);
  });

  it.each([false, true])(
    "retains issue/reproduction and blocks the PR draft on validation failure (%s)",
    (failValidation) => {
      const h = harness(5);
      const issue = {
        title: "Issue",
        body: "Complete original issue",
        url: ""
      };
      h.complete("read-issue", issue);
      const reproduction = {
        reproduced: true,
        trigger: "observed command",
        expected: "required",
        actual: "wrong"
      };
      h.complete("reproduce", reproduction);
      h.complete("fix");
      h.complete("review", review(1));
      expect(h.running("correct")!.resolvedInputs).toMatchObject({
        issue,
        reproduction
      });
      h.complete("correct");
      h.complete("review", review(0));
      expect(h.attempts("draft-pr")).toHaveLength(0);
      h.complete(
        "final-validation",
        { exitCode: failValidation ? 1 : 0 },
        {},
        failValidation ? "failed" : "succeeded"
      );
      if (failValidation) {
        expect(h.run.status).toBe("failed");
        expect(h.attempts("draft-pr")).toHaveLength(0);
        return;
      }
      expect(h.running("draft-pr")!.resolvedInputs).toMatchObject({
        issue,
        reproduction,
        draftPath: "PR-DRAFT.md"
      });
      h.complete("draft-pr");
      expect(h.run.status).toBe("succeeded");
    }
  );

  it("assigns project-derived Epic packages in dependency order and verifies all seven Agent stages", () => {
    const h = harness(6);
    h.complete("architecture", { summary: "Complete architecture" });
    expect(h.running("implement-A")).toBeUndefined();
    const planning = {
      packages: {
        A: {
          goal: "First part",
          ownedPaths: ["project/first"],
          acceptance: "A check"
        },
        B: {
          goal: "Second part",
          ownedPaths: ["project/second"],
          acceptance: "B check"
        }
      },
      integrationPlan: "Connect both parts"
    };
    h.complete("plan", planning);
    expect(h.running("implement-A")!.resolvedInputs.workPackage).toEqual(
      planning.packages.A
    );
    expect(h.running("implement-B")).toBeUndefined();
    h.complete("implement-A", { summary: "A implementation" });
    expect(h.running("implement-B")!.resolvedInputs).toMatchObject({
      workPackage: planning.packages.B,
      workA: { summary: "A implementation" }
    });
    h.complete("implement-B");
    h.complete("integrate");
    h.complete("epic-review", review(0));
    expect(h.running("verify")!.resolvedInputs).toMatchObject({
      planning,
      workA: { summary: "A implementation" }
    });
    h.complete("verify", verification());
    h.complete("final-validation", { exitCode: 0 });
    expect(h.run.status).toBe("succeeded");
    expect(Object.values(h.run.dispatches)).toHaveLength(7);
  });
});
