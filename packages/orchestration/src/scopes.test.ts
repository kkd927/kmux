import { nestedReviewWorkflow } from "../fixtures/nested-review";
import {
  loopMaxGateRoute,
  workflowNodeOwners,
  workflowScopePath
} from "./index";

describe("structured workflow scopes", () => {
  it("owns a while-Loop max gate in the same scope as its body", () => {
    const definition = nestedReviewWorkflow();
    expect(definition).toBeDefined();
    if (!definition) return;

    const owners = workflowNodeOwners(definition.nodes);
    expect(owners.get("review-rounds")).toBe("items");
    expect(owners.get("review-result")).toBe("review-rounds");
    expect(owners.get("review-limit")).toBe("review-rounds");
    expect(workflowScopePath(definition.nodes, "review-rounds")).toEqual([
      "items",
      "review-rounds"
    ]);
  });

  it("derives the bounded review max-gate route from Loop semantics", () => {
    const definition = nestedReviewWorkflow();
    const reviewLoop = definition?.nodes.find(
      (node) => node.id === "review-rounds"
    );
    expect(reviewLoop).toBeDefined();
    if (!reviewLoop) return;

    expect(loopMaxGateRoute(reviewLoop)).toEqual({
      loopNodeId: "review-rounds",
      sourceNodeId: "review-result",
      sourcePort: "continue",
      gateNodeId: "review-limit"
    });
  });
});
