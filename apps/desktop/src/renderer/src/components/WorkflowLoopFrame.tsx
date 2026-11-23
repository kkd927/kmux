import { TransformData } from "@flowgram.ai/core";
import {
  FreeOperationType,
  WorkflowDragService,
  useClientContext,
  type FreeLayoutPluginContext,
  type WorkflowNodeEntity
} from "@flowgram.ai/free-layout-editor";
import { useLayoutEffect, useRef } from "react";
import { LOOP_FRAME_MIN_SIZE } from "../workflowProjection";
import styles from "../styles/WorkflowsPanel.module.css";

// FlowGram normally derives a container's geometry from its children. Keep the
// transform hierarchy (so children still follow their parent), but let a Loop
// own its frame geometry. Register before FlowNodeTransformData initializes.
class LoopFrameTransformData extends TransformData {
  override get isContainer(): boolean {
    return false;
  }
}

export function installWorkflowLoopFrames(
  context: FreeLayoutPluginContext
): void {
  const previous = context.document.options.preNodeCreate;
  context.document.options.preNodeCreate = (node) => {
    previous?.(node);
    if (node.flowNodeType === "loop") node.addData(LoopFrameTransformData);
  };

  // Flowgram 1.0.14 also normalizes a container's position after a child drag,
  // independently of its transform's bounds. There is no public option for
  // this step. Scope the adapter to this editor and retain native behavior for
  // other containers. The Electron drag regression covers this version seam.
  const drag = context.get(WorkflowDragService) as unknown as {
    resetContainerInternalPosition: (nodes: WorkflowNodeEntity[]) => void;
  };
  const reset = drag.resetContainerInternalPosition.bind(drag);
  drag.resetContainerInternalPosition = (nodes) => {
    if (nodes.length && nodes.every((node) => node.parent?.flowNodeType === "loop"))
      return;
    reset(nodes);
  };
}

type FrameSize = { width: number; height: number };
const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof EDGES)[number];

export function WorkflowLoopFrame(props: {
  node: WorkflowNodeEntity;
  size: FrameSize;
  expanded: boolean;
  readonly: boolean;
  zoom: () => number;
  onChange: (size: FrameSize) => void;
}): JSX.Element | null {
  const context = useClientContext();
  const drag = useRef<{
    edge: Edge;
    x: number;
    y: number;
    zoom: number;
    size: FrameSize;
    next: FrameSize;
    position: { x: number; y: number };
    children: { node: WorkflowNodeEntity; x: number; y: number }[];
  } | null>(null);

  const finishResize = () => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    context.history.transact(() => {
      const nodes = [
        { node: props.node, ...state.position },
        ...state.children
      ];
      if (nodes.some(({ node, x, y }) =>
        node.transform.position.x !== x || node.transform.position.y !== y
      )) {
        context.history.pushOperation({
          type: FreeOperationType.dragNodes,
          value: {
            ids: nodes.map(({ node }) => node.id),
            value: nodes.map(({ node }) => ({ ...node.transform.position })),
            oldValue: nodes.map(({ x, y }) => ({ x, y }))
          }
        }, { noApply: true });
      }
      props.onChange(state.next);
    });
  };

  useLayoutEffect(() => {
    props.node.transform.size = {
      width: props.size.width,
      height: props.expanded ? props.size.height : 54
    };
  }, [props.node, props.size.width, props.size.height, props.expanded]);

  if (!props.expanded || props.readonly) return null;
  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={styles.loopResizeHandle}
          data-edge={edge}
          role="separator"
          aria-label={`Resize ${props.node.id} ${edge}`}
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              edge,
              x: event.clientX,
              y: event.clientY,
              zoom: props.zoom(),
              size: { ...props.size },
              next: { ...props.size },
              position: { ...props.node.transform.position },
              children: props.node.blocks.map((node) => ({
                node,
                ...node.transform.position
              }))
            };
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            if (!state) return;
            event.stopPropagation();
            const dx = (event.clientX - state.x) / state.zoom;
            const dy = (event.clientY - state.y) / state.zoom;
            const width = Math.max(
              LOOP_FRAME_MIN_SIZE.width,
              state.size.width +
                (state.edge.includes("e")
                  ? dx
                  : state.edge.includes("w")
                    ? -dx
                    : 0)
            );
            const height = Math.max(
              LOOP_FRAME_MIN_SIZE.height,
              state.size.height +
                (state.edge.includes("s")
                  ? dy
                  : state.edge.includes("n")
                    ? -dy
                    : 0)
            );
            const shiftX = state.edge.includes("w")
              ? state.size.width - width
              : 0;
            const shiftY = state.edge.includes("n")
              ? state.size.height - height
              : 0;
            state.next = { width, height };
            props.node.transform.size = state.next;
            props.node.transform.position = {
              x: state.position.x + shiftX,
              y: state.position.y + shiftY
            };
            for (const child of state.children)
              child.node.transform.position = {
                x: child.x - shiftX,
                y: child.y - shiftY
              };
          }}
          onPointerUp={(event) => {
            if (!drag.current) return;
            event.stopPropagation();
            finishResize();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={finishResize}
        />
      ))}
    </>
  );
}
