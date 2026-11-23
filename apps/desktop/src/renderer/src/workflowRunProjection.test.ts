import { nestedReviewWorkflow } from "../../../../../packages/orchestration/fixtures/nested-review";
import {
  materializeWorkflowRun,
  publishWorkflowVersion,
  type RunNode,
  type NodeAttempt
} from "@kmux/orchestration";
import {
  projectWorkflowRunExecutions,
  workflowRunDiagramDefinition,
  workflowRunDiagramDocument
} from "./workflowRunProjection";

it("keeps the canonical diagram stable across materialization and retains each iteration's actual status and attempt", () => {
  const definition = nestedReviewWorkflow()!;
  const version = publishWorkflowVersion({
    definition,
    workflowVersionId: "version:test",
    publishedAt: "2026-09-10T00:00:00.000Z"
  });
  const run = materializeWorkflowRun({
    runId: "run:test",
    version,
    inputs: {
      repository: "/fixture",
      authorAgent: "custom",
      regressionReviewerAgent: "custom",
      sideEffectReviewerAgent: "custom",
      testSecurityReviewerAgent: "custom"
    },
    context: {
      now: () => "2026-09-10T00:00:00.000Z",
      id: (kind) => `${kind}:test`
    }
  });
  const template = definition.nodes.find(
    (node) => node.id === "synthesize-fix"
  )!;
  const materialized = (
    iteration: number,
    status: RunNode["status"]
  ): RunNode => ({
    nodeId: `synthesis:${iteration}`,
    definition: template,
    definitionHash: `sha256:${"0".repeat(64)}`,
    stateRevision: 1,
    status,
    selectedPredecessors: [],
    attemptIds: [`attempt:${iteration}`],
    materialization: {
      templateNodeId: template.id,
      ownerLoopNodeId: "review-rounds:0",
      iterationId: `iteration:${iteration}`,
      iteration,
      path: [
        { loopNodeId: "items", iterationId: "ticket:0", iteration: 0 },
        {
          loopNodeId: "review-rounds",
          iterationId: `iteration:${iteration}`,
          iteration
        }
      ],
      bodyEntry: false
    }
  });
  const nodes = {
    ...run.graph.nodes,
    "synthesis:0": materialized(0, "succeeded"),
    "synthesis:1": materialized(1, "uncertain")
  };
  const attempt: NodeAttempt = {
    attemptId: "attempt:1",
    runId: run.runId,
    nodeId: "synthesis:1",
    ordinal: 2,
    status: "uncertain",
    createdAt: run.createdAt,
    effectiveDefinitionHash: `sha256:${"0".repeat(64)}`,
    effectiveGraphRevision: 2,
    effectiveNodeStateRevision: 1,
    resolvedInputs: {},
    inputInterventionIds: []
  };
  const projection = projectWorkflowRunExecutions(nodes, {
    "attempt:1": attempt
  });
  expect(projection.get(template.id)).toEqual([
    {
      nodeId: "synthesis:0",
      status: "succeeded",
      iterationPath: "items 1 / review-rounds 1"
    },
    {
      nodeId: "synthesis:1",
      status: "uncertain",
      iterationPath: "items 1 / review-rounds 2",
      attemptId: "attempt:1",
      attemptOrdinal: 2
    }
  ]);
  const nextRun = {
    ...run,
    graph: { ...run.graph, nodes, revision: run.graph.revision + 1 }
  };
  expect(workflowRunDiagramDefinition(nextRun)).toEqual(
    workflowRunDiagramDefinition(run)
  );
});

it("restores only pinned layout coordinates and keeps Runtime definitions authoritative", () => {
  const definition = nestedReviewWorkflow()!;
  const restored = workflowRunDiagramDocument(definition, {
    documentVersion: 1,
    nodes: [
      {
        id: "synthesize-fix",
        position: { x: 400, y: 800 },
        definition: { title: "Stale title", kind: "shell" }
      },
      { id: "analyze-fix", position: { x: null, y: 100 } }
    ]
  });
  expect(
    restored.nodes.find((entry) => entry.id === "synthesize-fix")
  ).toMatchObject({
    position: { x: 400, y: 800 },
    definition: definition.nodes.find((node) => node.id === "synthesize-fix")
  });
  const generated = workflowRunDiagramDocument(definition);
  expect(
    restored.nodes.find((entry) => entry.id === "analyze-fix")?.position
  ).toEqual(
    generated.nodes.find((entry) => entry.id === "analyze-fix")?.position
  );
});
