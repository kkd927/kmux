import { expect, it } from "vitest";
import { nestedReviewWorkflow } from "../../../../../packages/orchestration/fixtures/nested-review";
import { setLoopExitAction } from "./workflowLoopActions";

it("maps Repeat and Finish to saved outcome names while preserving other exits and advanced policies", () => {
  const node = nestedReviewWorkflow()!.nodes.find(
    (entry) => entry.id === "review-rounds"
  )!;
  if (node.kind !== "loop" || node.config.mode !== "while")
    throw new Error("Expected while Loop");
  const original = structuredClone(node);
  const completed = setLoopExitAction(node, 0, "complete");
  if (completed.config.mode !== "while") throw new Error("Expected while Loop");
  expect(completed.config.body.exits[0]?.outcome).toBe(
    node.config.completedOutcomes[0]
  );
  expect(completed.config.body.exits.slice(1)).toEqual(
    node.config.body.exits.slice(1)
  );
  expect({ ...completed.config, body: node.config.body }).toEqual(node.config);
  const repeated = setLoopExitAction(completed, 0, "repeat");
  expect(repeated.config.body.exits[0]?.outcome).toBe(
    node.config.repeatOutcome
  );
  expect(node).toEqual(original);
});
