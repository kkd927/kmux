import {
  WORKFLOW_CANVAS_BOTTOM_PORT,
  WORKFLOW_CANVAS_TOP_PORT,
  normalizeWorkflowCanvasPort,
  workflowDynamicPorts
} from "./workflowCanvasPorts";

describe("Workflow Studio canvas ports", () => {
  it.each([false, true])(
    "preserves each outcome ID with vertical layout set to %s",
    (vertical) => {
      const outcomes = ["retry", "accept-risk", "skip-ticket", "abort"];
      const ids = workflowDynamicPorts(outcomes, vertical)
        .filter((port) => port.type === "output")
        .map((port) => port.portID);
      expect(ids.sort()).toEqual([...outcomes].sort());
    }
  );

  it("normalizes visual-only top and bottom ports to the canonical default", () => {
    expect(
      normalizeWorkflowCanvasPort(WORKFLOW_CANVAS_TOP_PORT)
    ).toBeUndefined();
    expect(
      normalizeWorkflowCanvasPort(WORKFLOW_CANVAS_BOTTOM_PORT)
    ).toBeUndefined();
    expect(normalizeWorkflowCanvasPort("clean")).toBe("clean");
  });
});
