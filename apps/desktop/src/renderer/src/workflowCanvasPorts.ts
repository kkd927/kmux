import type { WorkflowPorts } from "@flowgram.ai/free-layout-editor";
import type { WorkflowNodeDefinition } from "@kmux/orchestration";

export const WORKFLOW_CANVAS_TOP_PORT = "__kmux_canvas_top";
export const WORKFLOW_CANVAS_BOTTOM_PORT = "__kmux_canvas_bottom";

const centeredPort = (
  type: "input" | "output",
  location: "left" | "top" | "right" | "bottom",
  portID?: string
): WorkflowPorts[number] => ({
  type,
  ...(portID ? { portID } : {}),
  location,
  locationConfig:
    location === "left"
      ? { left: 0, top: "50%" }
      : location === "right"
        ? { right: 0, top: "50%" }
        : location === "top"
          ? { left: "50%", top: 0 }
          : { left: "50%", bottom: 0 }
});

const inputPorts = (): WorkflowPorts => [
  centeredPort("input", "left"),
  centeredPort("input", "top", WORKFLOW_CANVAS_TOP_PORT)
];

const outputPorts = (): WorkflowPorts => [
  centeredPort("output", "right"),
  centeredPort("output", "bottom", WORKFLOW_CANVAS_BOTTOM_PORT)
];

const distributedPosition = (index: number, count: number): string =>
  `${Math.round(((index + 1) / (count + 1)) * 100_000) / 1_000}%`;

export function workflowDefaultPorts(
  kind: WorkflowNodeDefinition["kind"]
): WorkflowPorts {
  if (kind === "start") return outputPorts();
  if (kind === "end" || kind === "break" || kind === "continue")
    return inputPorts();
  if (kind === "condition" || kind === "loop" || kind === "human-gate") {
    return inputPorts();
  }
  return [...inputPorts(), ...outputPorts()];
}

export function workflowDynamicPorts(
  outputPortIds: readonly string[],
  vertical = false
): WorkflowPorts {
  if (vertical) {
    const bottomCount = Math.ceil(outputPortIds.length / 2);
    const bottomPorts = outputPortIds.slice(0, bottomCount);
    const rightPorts = outputPortIds.slice(bottomCount);
    return [
      ...inputPorts(),
      ...bottomPorts.map((portID, index) => ({
        type: "output" as const,
        portID,
        location: "bottom" as const,
        locationConfig: {
          left: distributedPosition(index, bottomPorts.length),
          bottom: 0
        }
      })),
      ...rightPorts.map((portID, index) => ({
        type: "output" as const,
        portID,
        location: "right" as const,
        locationConfig: {
          right: 0,
          top: distributedPosition(index, rightPorts.length)
        }
      }))
    ];
  }
  const rightCount = Math.ceil(outputPortIds.length / 2);
  const rightPorts = outputPortIds.slice(0, rightCount);
  const bottomPorts = outputPortIds.slice(rightCount);
  return [
    ...inputPorts(),
    ...rightPorts.map((portID, index) => ({
      type: "output" as const,
      portID,
      location: "right" as const,
      locationConfig: {
        right: 0,
        top: distributedPosition(index, rightPorts.length)
      }
    })),
    ...bottomPorts.map((portID, index) => ({
      type: "output" as const,
      portID,
      location: "bottom" as const,
      locationConfig: {
        left: distributedPosition(index, bottomPorts.length),
        bottom: 0
      }
    }))
  ];
}

export function normalizeWorkflowCanvasPort(
  port: string | number | undefined
): string | undefined {
  if (
    port === undefined ||
    port === WORKFLOW_CANVAS_TOP_PORT ||
    port === WORKFLOW_CANVAS_BOTTOM_PORT
  ) {
    return undefined;
  }
  return String(port);
}
