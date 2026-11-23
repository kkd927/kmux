import {
  DataEvent,
  EditorRenderer,
  Field,
  FreeLayoutEditorProvider,
  InteractiveType,
  Rectangle,
  WorkflowNodeRenderer,
  type EffectFuncProps,
  type FlowNodeRegistry,
  type FormMeta,
  type FreeLayoutProps,
  type FreeLayoutPluginContext,
  type WorkflowJSON,
  type WorkflowNodeProps,
  type WorkflowNodeEntity,
  useClientContext,
  useNodeRender,
  usePlaygroundTools
} from "@flowgram.ai/free-layout-editor";
import {
  SubCanvasRender,
  createContainerNodePlugin
} from "@flowgram.ai/free-container-plugin";
import {
  type FlowEditorDocumentV1,
  type WorkflowNodeDefinition
} from "@kmux/orchestration";
import { workflowNodeOwners } from "@kmux/orchestration/scopes";
import type { AgentDescriptorDto } from "@kmux/proto";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import "@flowgram.ai/free-layout-editor/index.css";
import { createTypePresetPlugin } from "@flowgram.ai/form-materials";
import { WorkflowVariableBridge } from "./WorkflowVariableBridge";
import { WorkflowVariableField } from "./WorkflowVariableField";
import { WorkflowConditionProperties } from "./WorkflowConditionProperties";
import { WorkflowResultFields } from "./WorkflowResultFields";
import { Codicon } from "./Codicon";
import { WorkflowAgentLaunchFields } from "./WorkflowAgentLaunchFields";
import {
  installWorkflowLoopFrames,
  WorkflowLoopFrame
} from "./WorkflowLoopFrame";
import {
  LOOP_FRAME_DEFAULT_SIZE,
  LOOP_END_ANCHOR_TYPE,
  LOOP_START_ANCHOR_TYPE,
  nodeKindLabel,
  toFlowgramDocument
} from "../workflowProjection";
import {
  workflowDefaultPorts,
  workflowDynamicPorts
} from "../workflowCanvasPorts";
import { type WorkflowRunExecutionProjection } from "../workflowRunProjection";
import styles from "../styles/WorkflowsPanel.module.css";
import { workflowNodeIconUrls } from "../workflowNodeIcons";
import {
  type WorkflowCanvasController,
  type CanvasLayoutDirection,
  workflowLayoutDirection,
  dynamicPorts,
  NodeKindIcon,
  nodeSummary
} from "./workflowUi";

const canvasViewInteracted = new WeakSet<FreeLayoutPluginContext>();

export const WorkflowRunProjectionContext = createContext<ReadonlyMap<
  string,
  readonly WorkflowRunExecutionProjection[]
> | null>(null);

function toggleLoopExpanded(node: WorkflowNodeEntity, expanded: boolean): void {
  node.transform.collapsed = !expanded;
  setLoopDescendantVisibility(node, expanded);
}

function setLoopDescendantVisibility(
  node: WorkflowNodeEntity,
  visible: boolean
): void {
  node.blocks.forEach((block) => {
    block.renderData.node.style.display = visible ? "" : "none";
    block.lines.allLines.forEach((line) => {
      line.updateUIState({
        style: {
          ...line.uiState.style,
          display: visible ? "block" : "none"
        }
      });
    });
    if (block.blocks.length > 0) {
      setLoopDescendantVisibility(block, visible && !block.transform.collapsed);
    }
  });
}

const NODE_KINDS: WorkflowNodeDefinition["kind"][] = [
  "shell",
  "agent",
  "condition",
  "loop",
  "human-gate",
  "break",
  "continue",
  "start",
  "end"
];

export function WorkflowCanvas(props: {
  document: FlowEditorDocumentV1;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onOpenInspector: (nodeId: string) => void;
  onAddNode: (kind: WorkflowNodeDefinition["kind"]) => void;
  onDeleteNode: (nodeId: string) => void;
  onAgentSelectorChange: (nodeId: string, value: string) => void;
  onDefinitionChange: (definition: WorkflowNodeDefinition) => void;
  agentDescriptors: readonly AgentDescriptorDto[];
  onController: (controller: WorkflowCanvasController | null) => void;
  onChange: (flow: WorkflowJSON) => void;
  readonly?: boolean;
  inspector?: ReactNode;
}): JSX.Element {
  const contentReadyRef = useRef(false);
  const [variablesReady, setVariablesReady] = useState(false);
  const liveStateRef = useRef({
    document: props.document,
    selectedNodeId: props.selectedNodeId,
    agentDescriptors: props.agentDescriptors,
    readonly: props.readonly ?? false,
    onOpenInspector: props.onOpenInspector,
    onDeleteNode: props.onDeleteNode,
    onAgentSelectorChange: props.onAgentSelectorChange,
    onDefinitionChange: props.onDefinitionChange,
    onChange: props.onChange
  });
  liveStateRef.current = {
    document: props.document,
    selectedNodeId: props.selectedNodeId,
    agentDescriptors: props.agentDescriptors,
    readonly: props.readonly ?? false,
    onOpenInspector: props.onOpenInspector,
    onDeleteNode: props.onDeleteNode,
    onAgentSelectorChange: props.onAgentSelectorChange,
    onDefinitionChange: props.onDefinitionChange,
    onChange: props.onChange
  };
  const initialData = useMemo(
    () => toFlowgramDocument(props.document),
    [props.document]
  );
  const dynamicFormMeta = useMemo<FormMeta>(
    () => ({
      effect: {
        portKeys: [
          {
            event: DataEvent.onValueInitOrChange,
            effect: ({
              value,
              context
            }: EffectFuncProps<string[], unknown>) => {
              context.node.ports.updateAllPorts(
                workflowDynamicPorts(value ?? [])
              );
            }
          }
        ]
      },
      render: () => (
        <StudioNodeForm
          selectedNodeId={liveStateRef.current.selectedNodeId}
          document={liveStateRef.current.document}
          agentDescriptors={liveStateRef.current.agentDescriptors}
          readonly={liveStateRef.current.readonly}
          onOpenInspector={(nodeId) =>
            liveStateRef.current.onOpenInspector(nodeId)
          }
          onDeleteNode={(nodeId) => liveStateRef.current.onDeleteNode(nodeId)}
          onAgentSelectorChange={(nodeId, value) =>
            liveStateRef.current.onAgentSelectorChange(nodeId, value)
          }
          onDefinitionChange={(definition) =>
            liveStateRef.current.onDefinitionChange(definition)
          }
        />
      )
    }),
    []
  );
  const staticFormMeta = useMemo<FormMeta>(
    () => ({
      render: () => (
        <StudioNodeForm
          selectedNodeId={liveStateRef.current.selectedNodeId}
          document={liveStateRef.current.document}
          agentDescriptors={liveStateRef.current.agentDescriptors}
          readonly={liveStateRef.current.readonly}
          onOpenInspector={(nodeId) =>
            liveStateRef.current.onOpenInspector(nodeId)
          }
          onDeleteNode={(nodeId) => liveStateRef.current.onDeleteNode(nodeId)}
          onAgentSelectorChange={(nodeId, value) =>
            liveStateRef.current.onAgentSelectorChange(nodeId, value)
          }
          onDefinitionChange={(definition) =>
            liveStateRef.current.onDefinitionChange(definition)
          }
        />
      )
    }),
    []
  );
  const registries = useMemo<FlowNodeRegistry[]>(
    () => [
      ...NODE_KINDS.map((kind) => ({
        type: kind,
        info: { icon: workflowNodeIconUrls[kind] ?? <Codicon name="lock" /> },
        meta: {
          expandable: kind !== "start" && kind !== "end",
          origin: { x: 0, y: 0 },
          defaultExpanded:
            kind === "loop" || kind === "agent" || kind === "condition",
          ...(kind === "start" ? { isStart: true, deleteDisable: true } : {}),
          ...(kind === "end" ? { deleteDisable: true } : {}),
          ...(kind === "break" || kind === "continue"
            ? { onlyInContainer: "loop", expandable: false }
            : {}),
          ...(kind === "loop"
            ? {
                isContainer: true,
                size: LOOP_FRAME_DEFAULT_SIZE,
                autoResizeDisable: true,
                padding: { top: 0, bottom: 0, left: 0, right: 0 },
                wrapperStyle: { minWidth: "unset", width: "100%" }
              }
            : {}),
          defaultPorts: workflowDefaultPorts(kind),
          ...(kind === "condition" || kind === "loop" || kind === "human-gate"
            ? { useDynamicPort: true }
            : {})
        },
        formMeta:
          kind === "condition" || kind === "loop" || kind === "human-gate"
            ? dynamicFormMeta
            : staticFormMeta
      })),
      loopAnchorRegistry(LOOP_START_ANCHOR_TYPE, "start"),
      loopAnchorRegistry(LOOP_END_ANCHOR_TYPE, "end")
    ],
    [dynamicFormMeta, staticFormMeta]
  );
  const editorProps = useMemo<FreeLayoutProps>(
    () => ({
      initialData,
      nodeRegistries: registries,
      twoWayConnection: true,
      background: {
        gridSize: 20,
        dotSize: 1,
        dotColor: "transparent",
        dotFillColor: "var(--wf-grid-dot)",
        dotOpacity: 1
      },
      readonly: props.readonly ?? false,
      nodeEngine: { enable: true },
      variableEngine: { enable: true },
      history: { enable: true, enableChangeNode: true },
      canDropToNode: (_context, params) =>
        params.dragNodeType !== "start" &&
        params.dragNodeType !== "end" &&
        !isLoopAnchorType(params.dragNodeType),
      canAddLine: (_context, from, to) =>
        from.node !== to.node &&
        from.node.parent?.id === to.node.parent?.id &&
        !(
          isLoopAnchorType(from.node.flowNodeType) &&
          isLoopAnchorType(to.node.flowNodeType)
        ) &&
        !from.node.lines.allInputNodes.includes(to.node),
      onInit: installWorkflowLoopFrames,
      plugins: () => [
        createContainerNodePlugin({}),
        createTypePresetPlugin({})
      ],
      playground: {
        preventGlobalGesture: true,
        autoFocus: false,
        minZoom: 0.25,
        maxZoom: 1.8,
        ineractiveType: InteractiveType.MOUSE
      },
      fromNodeJSON: (node, json) => {
        if (node.flowNodeType === "loop") {
          node.transform.size =
            json.data?.frameSize ?? json.meta?.size ?? LOOP_FRAME_DEFAULT_SIZE;
        }
        return json;
      },
      toNodeJSON: (_node, json) => json,
      materials: {
        renderDefaultNode: (nodeProps: WorkflowNodeProps) => {
          const { node, form } = useNodeRender();
          if (isLoopAnchorType(node.flowNodeType)) {
            return (
              <WorkflowNodeRenderer
                node={nodeProps.node}
                className={styles.flowNodeFrame}
              >
                {form?.render()}
              </WorkflowNodeRenderer>
            );
          }
          const nested = workflowNodeOwners(
            liveStateRef.current.document.nodes.map((entry) => entry.definition)
          ).has(node.id);
          return (
            <WorkflowNodeRenderer
              node={nodeProps.node}
              className={styles.flowNodeFrame}
            >
              <div
                className={`${styles.flowNodeClickTarget} ${
                  node.flowNodeType === "loop" ? styles.loopNodeClickTarget : ""
                } ${nested ? styles.nestedNodeClickTarget : ""}`}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (
                    target.closest(
                      "button, input, textarea, select, option, [role='menuitem']"
                    )
                  ) {
                    return;
                  }
                  props.onSelectNode(node.id);
                }}
              >
                {form?.render()}
              </div>
            </WorkflowNodeRenderer>
          );
        }
      },
      onContentChange: (context) => {
        if (contentReadyRef.current) {
          liveStateRef.current.onChange(context.document.toJSON());
        }
      },
      onAllLayersRendered: (context) => {
        if (contentReadyRef.current) return;
        contentReadyRef.current = true;
        setVariablesReady(true);
        // Allow node forms to measure, and never override a view the user has
        // already moved or fitted while opening this canvas.
        window.setTimeout(() => {
          if (!context.document.disposed && !canvasViewInteracted.has(context))
            void openWorkflowCanvas(context);
        }, 250);
      }
    }),
    [initialData, props, registries]
  );

  return (
    <FreeLayoutEditorProvider {...editorProps}>
      {variablesReady && <WorkflowVariableBridge document={props.document} />}
      <EditorRenderer className={styles.flowEditor} />
      {variablesReady ? props.inspector : null}
      <WorkflowCanvasTools
        document={props.document}
        readonly={props.readonly ?? false}
        onSelectNode={props.onSelectNode}
        onAddNode={props.onAddNode}
        onController={props.onController}
      />
    </FreeLayoutEditorProvider>
  );
}

function loopAnchorRegistry(
  type: typeof LOOP_START_ANCHOR_TYPE | typeof LOOP_END_ANCHOR_TYPE,
  side: "start" | "end"
): FlowNodeRegistry {
  return {
    type,
    meta: {
      ...(side === "start" ? { isStart: true } : { isNodeEnd: true }),
      deleteDisable: true,
      copyDisable: true,
      sidebarDisabled: true,
      nodePanelVisible: false,
      size: { width: 64, height: 64 },
      origin: { x: 0, y: 0 },
      defaultPorts: workflowDefaultPorts(side),
      wrapperStyle: {
        minWidth: "unset",
        width: "100%",
        borderWidth: 2,
        borderRadius: 12,
        cursor: "move"
      }
    },
    formMeta: {
      render: () => (
        <div
          className={styles.loopBoundaryNode}
          aria-label={`Loop block ${side}`}
          data-side={side}
        >
          <img
            src={workflowNodeIconUrls[side]}
            alt={side === "start" ? "Start" : "End"}
            draggable={false}
          />
        </div>
      )
    }
  };
}

function isLoopAnchorType(type: string | number | undefined): boolean {
  return type === LOOP_START_ANCHOR_TYPE || type === LOOP_END_ANCHOR_TYPE;
}

function WorkflowCanvasTools(props: {
  document: FlowEditorDocumentV1;
  readonly: boolean;
  onSelectNode: (nodeId: string) => void;
  onAddNode: (kind: WorkflowNodeDefinition["kind"]) => void;
  onController: (controller: WorkflowCanvasController | null) => void;
}): JSX.Element {
  const context = useClientContext();
  const tools = usePlaygroundTools({ minZoom: 0.25, maxZoom: 1.8 });
  useEffect(() => {
    const canvas = context.playground.config.playgroundDomNode;
    const interacted = () => canvasViewInteracted.add(context);
    canvas.addEventListener("pointerdown", interacted, true);
    canvas.addEventListener("wheel", interacted, true);
    return () => {
      canvas.removeEventListener("pointerdown", interacted, true);
      canvas.removeEventListener("wheel", interacted, true);
    };
  }, [context]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [layoutDirection, setLayoutDirection] = useState<CanvasLayoutDirection>(
    () => workflowLayoutDirection(props.document)
  );

  useEffect(() => {
    for (const entry of props.document.nodes) {
      const node = context.document.getNode(entry.id);
      const form = node?.form;
      if (
        !form ||
        JSON.stringify(form.getValueIn("definition")) ===
          JSON.stringify(entry.definition)
      )
        continue;
      form.setValueIn("definition", entry.definition);
      form.setValueIn("portKeys", dynamicPorts(entry.definition));
    }
  }, [context.document, props.document]);

  useEffect(() => {
    const selection = context.document.selectServices;
    const disposable = selection.onSelectionChanged(() => {
      const selected = selection.activatedNode;
      if (selected) props.onSelectNode(selected.id);
    });
    return () => disposable.dispose();
  }, [context.document, props.onSelectNode]);

  useEffect(() => {
    const controller: WorkflowCanvasController = {
      focusNode: (nodeId) => {
        const node = context.document.getNode(nodeId);
        if (!node) return;
        context.document.selectServices.selectNodeAndFocus(node);
        void context.playground.config.scrollToView({
          bounds: node.bounds,
          zoom: 1,
          scrollToCenter: true,
          easing: true
        });
      },
      createNode: (entry) => {
        const json = toFlowgramDocument({
          ...props.document,
          nodes: [entry],
          edges: []
        }).nodes[0];
        if (!json) throw new Error("FlowGram node projection is empty");
        const created = context.document.createWorkflowNodeByType(
          entry.definition.kind,
          entry.position,
          json
        );
        context.document.selectServices.selectNodeAndFocus(created);
        void context.playground.config.scrollToView({
          bounds: created.bounds,
          zoom: 1,
          scrollToCenter: true,
          easing: true
        });
        return context.document.toJSON();
      },
      deleteNode: (nodeId) => {
        const node = context.document.getNode(nodeId);
        if (!node) throw new Error(`FlowGram node '${nodeId}' is unavailable`);
        context.operation.deleteNode(node);
        context.document.selectServices.clear();
        return context.document.toJSON();
      }
    };
    props.onController(controller);
    return () => props.onController(null);
  }, [context, props.document, props.onController]);

  const inputMode = useRef<InteractiveType>(InteractiveType.MOUSE);
  useEffect(() => {
    const canvas = context.playground.config.playgroundDomNode;
    const setInputMode = (next: InteractiveType) => {
      if (inputMode.current === next) return;
      inputMode.current = next;
      tools.setInteractiveType(next);
    };
    // Switch from the actual gesture; no persistent input-device preference.
    const wheel = (event: WheelEvent) => {
      const discrete =
        event.deltaMode !== 0 ||
        (event.deltaX === 0 &&
          Number.isInteger(event.deltaY) &&
          Math.abs(event.deltaY) >= 100 &&
          (event.deltaY % 100 === 0 || event.deltaY % 120 === 0));
      setInputMode(
        event.ctrlKey || event.metaKey || !discrete
          ? InteractiveType.PAD
          : InteractiveType.MOUSE
      );
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button === 0)
        setInputMode(InteractiveType.MOUSE);
    };
    canvas.addEventListener("wheel", wheel, true);
    canvas.addEventListener("pointerdown", pointer, true);
    return () => {
      canvas.removeEventListener("wheel", wheel, true);
      canvas.removeEventListener("pointerdown", pointer, true);
    };
  }, [context, tools.setInteractiveType]);

  const applyLayout = (direction: CanvasLayoutDirection) => {
    setLayoutDirection(direction);
    void tools.autoLayout({
      layoutConfig: {
        rankdir: direction === "horizontal" ? "LR" : "TB",
        nodesep: 64,
        ranksep: 96
      },
      enableAnimation: true,
      animationDuration: 260
    });
  };

  const zoomLabel = `${Math.round(tools.zoom * 100)}%`;
  return (
    <div className={styles.canvasToolbar} aria-label="Workflow canvas controls">
      {!props.readonly ? (
        <div className={styles.canvasToolPopover}>
          <button
            type="button"
            className={styles.addNodeButton}
            aria-label="Add node"
            aria-expanded={addMenuOpen}
            onClick={() => {
              setAddMenuOpen((open) => !open);
            }}
          >
            <Codicon name="add" />
            <span>Add node</span>
          </button>
          {addMenuOpen ? (
            <div className={styles.nodeAdderMenu} role="menu">
              <header>
                <strong>Add a workflow node</strong>
              </header>
              <div>
                {NODE_KINDS.map((kind) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={kind}
                    onClick={() => {
                      props.onAddNode(kind);
                      setAddMenuOpen(false);
                    }}
                  >
                    <NodeKindIcon kind={kind} />
                    <span>{nodeKindLabel(kind)}</span>
                    <Codicon name="add" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.canvasToolGroup}>
        <button
          type="button"
          title={`${layoutDirection === "horizontal" ? "Horizontal" : "Vertical"} Layout`}
          aria-label={`${layoutDirection === "horizontal" ? "Horizontal" : "Vertical"} Layout`}
          data-active="true"
          onClick={() =>
            applyLayout(
              layoutDirection === "horizontal" ? "vertical" : "horizontal"
            )
          }
        >
          <Codicon name="type-hierarchy-sub" />
          <span className={styles.layoutLabel}>
            {layoutDirection === "horizontal" ? "Horizontal" : "Vertical"}
          </span>
        </button>
      </div>
      {!props.readonly ? (
        <div className={styles.canvasToolGroup}>
          <button
            type="button"
            title="Undo"
            aria-label="Undo canvas change"
            onClick={() => void context.history.undo()}
          >
            <Codicon name="discard" />
          </button>
          <button
            type="button"
            title="Redo"
            aria-label="Redo canvas change"
            onClick={() => void context.history.redo()}
          >
            <Codicon name="redo" />
          </button>
        </div>
      ) : null}
      <div className={styles.canvasToolGroup}>
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => tools.zoomout(true)}
        >
          <Codicon name="zoom-out" />
        </button>
        <span>{zoomLabel}</span>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => tools.zoomin(true)}
        >
          <Codicon name="zoom-in" />
        </button>
        <button
          type="button"
          title="Fit workflow"
          aria-label="Fit workflow to canvas"
          onClick={() => void fitWorkflowCanvas(context)}
        >
          <Codicon name="screen-full" />
        </button>
      </div>
    </div>
  );
}

function fitWorkflowCanvas(
  context: FreeLayoutPluginContext,
  easing = true
): Promise<void> {
  if (easing) canvasViewInteracted.add(context);
  // Container bounds include their descendants and padding. FlowGram's default
  // fit uses each raw TransformData bound, which can clip expanded Loop ports.
  const bounds = Rectangle.enlarge(
    context.document.getAllNodes().map((node) => node.bounds)
  );
  return context.playground.config.fitView(bounds, easing, 30);
}

async function openWorkflowCanvas(
  context: FreeLayoutPluginContext
): Promise<void> {
  await fitWorkflowCanvas(context, false);
  if (context.playground.config.zoom >= 0.75) return;
  // Large workflows open at a readable card size; the Fit action remains the
  // explicit overview. Only the viewport moves, never saved node coordinates.
  const firstAgent = context.document
    .getAllNodes()
    .find((node) => node.flowNodeType === "agent");
  const entry =
    firstAgent ??
    context.document
      .getAllNodes()
      .find((node) => node.flowNodeType === "start");
  if (entry) {
    const bounds = Rectangle.enlarge(
      context.document.getAllNodes().map((node) => node.bounds)
    );
    const viewportHeight =
      context.playground.config.playgroundDomNode.clientHeight / 0.75;
    await context.playground.config.scrollToView({
      bounds: new Rectangle(
        entry.bounds.x,
        bounds.y - 40,
        entry.bounds.width,
        viewportHeight
      ),
      zoom: 0.75,
      scrollToCenter: true,
      easing: false
    });
  }
}

function StudioNodeForm(props: {
  selectedNodeId: string | null;
  document: FlowEditorDocumentV1;
  agentDescriptors: readonly AgentDescriptorDto[];
  readonly: boolean;
  onOpenInspector: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onAgentSelectorChange: (nodeId: string, value: string) => void;
  onDefinitionChange: (definition: WorkflowNodeDefinition) => void;
}): JSX.Element {
  const nodeRender = useNodeRender();
  return (
    <Field<WorkflowNodeDefinition> name="definition">
      {({ field }) => {
        const definition = field.value;
        if (!definition)
          return <div className={styles.flowNode}>Invalid node</div>;
        return (
          <StudioNodeCard
            flowNode={nodeRender.node}
            definition={definition}
            selected={
              nodeRender.activated || props.selectedNodeId === definition.id
            }
            initialExpanded={nodeRender.expanded}
            document={props.document}
            agentDescriptors={props.agentDescriptors}
            readonly={props.readonly}
            onChange={(next) => {
              field.onChange(next);
              props.onDefinitionChange(next);
            }}
            onOpenInspector={props.onOpenInspector}
            onDeleteNode={props.onDeleteNode}
            onAgentSelectorChange={props.onAgentSelectorChange}
          />
        );
      }}
    </Field>
  );
}

function StudioNodeCard(props: {
  flowNode: WorkflowNodeEntity;
  definition: WorkflowNodeDefinition;
  selected: boolean;
  initialExpanded: boolean;
  document: FlowEditorDocumentV1;
  agentDescriptors: readonly AgentDescriptorDto[];
  readonly: boolean;
  onChange: (definition: WorkflowNodeDefinition) => void;
  onOpenInspector: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onAgentSelectorChange: (nodeId: string, value: string) => void;
}): JSX.Element {
  const context = useClientContext();
  const runProjection = useContext(WorkflowRunProjectionContext);
  const executions = runProjection?.get(props.definition.id) ?? [];
  const statuses = new Map<string, number>();
  for (const execution of executions)
    statuses.set(execution.status, (statuses.get(execution.status) ?? 0) + 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(props.initialExpanded);

  const definition = props.definition;
  useLayoutEffect(() => {
    const ports = dynamicPorts(definition);
    if (ports.length === 0) return;
    if (definition.kind === "condition" && definition.config.conditions) {
      props.flowNode.ports.updateAllPorts(workflowDynamicPorts(ports));
      const frame = window.requestAnimationFrame(() =>
        props.flowNode.ports.updateDynamicPorts()
      );
      return () => window.cancelAnimationFrame(frame);
    } else props.flowNode.ports.updateAllPorts(workflowDynamicPorts(ports));
  }, [definition, props.document, props.flowNode]);
  useEffect(() => {
    if (definition.kind === "loop") {
      toggleLoopExpanded(props.flowNode, expanded);
    }
  }, [definition.kind, expanded, props.flowNode]);
  const scopeRole = workflowScopeRole(definition.id, props.document);
  const nested = workflowNodeOwners(
    props.document.nodes.map((entry) => entry.definition)
  ).has(definition.id);
  return (
    <article
      className={styles.flowNode}
      data-run-node-id={runProjection ? definition.id : undefined}
      data-kind={definition.kind}
      data-nested={nested ? "true" : "false"}
      data-selected={props.selected ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      aria-label={`${definition.title} ${nodeKindLabel(definition.kind)} node`}
    >
      {definition.kind === "loop" ? (
        <Field<{ width: number; height: number }> name="frameSize">
          {({ field }) => (
            <WorkflowLoopFrame
              node={props.flowNode}
              size={field.value ?? LOOP_FRAME_DEFAULT_SIZE}
              expanded={expanded}
              readonly={props.readonly}
              zoom={() => context.playground.config.zoom}
              onChange={field.onChange}
            />
          )}
        </Field>
      ) : null}
      <header className={styles.flowNodeHeader}>
        <NodeKindIcon kind={definition.kind} />
        <div className={styles.flowNodeTitle}>
          <strong>{definition.title}</strong>
          <span>
            {nodeKindLabel(definition.kind)}
            {scopeRole ? ` · ${scopeRole}` : ""}
          </span>
          {runProjection ? (
            <div
              className={styles.nodeExecutionStatus}
              aria-label={`${definition.title} execution status`}
            >
              {executions.length === 0
                ? "Not materialized"
                : [...statuses].map(([status, count]) => (
                    <span key={status} data-status={status}>
                      {executions.length > 1 ? `${count} ` : ""}
                      {status}
                    </span>
                  ))}
              {executions.length === 1 && executions[0]?.attemptOrdinal ? (
                <span>attempt {executions[0].attemptOrdinal}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        {definition.kind !== "start" &&
        definition.kind !== "end" &&
        definition.kind !== "break" &&
        definition.kind !== "continue" ? (
          <button
            type="button"
            className={styles.nodeHeaderButton}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${definition.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((current) => {
                const next = !current;
                props.flowNode.renderData.expanded = next;
                return next;
              });
            }}
          >
            <Codicon name={expanded ? "chevron-down" : "chevron-left"} />
          </button>
        ) : null}
        {!props.readonly ? (
          <div className={styles.nodeActionMenu}>
            <button
              type="button"
              className={styles.nodeHeaderButton}
              aria-label={`Open ${definition.title} menu`}
              aria-expanded={menuOpen}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((current) => !current);
              }}
            >
              <Codicon name="ellipsis" />
            </button>
            {menuOpen ? (
              <div role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onOpenInspector(definition.id);
                  }}
                >
                  <Codicon name="gear" /> Properties
                </button>
                {definition.kind !== "start" && definition.kind !== "end" ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.nodeDeleteAction}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      props.onDeleteNode(definition.id);
                    }}
                  >
                    <Codicon name="trash" /> Delete
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {expanded ? (
        <div
          className={styles.flowNodeBody}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {definition.kind === "agent" ? (
            <AgentNodeInlineEditor
              node={definition}
              document={props.document}
              agentDescriptors={props.agentDescriptors}
              readonly={props.readonly}
              onChange={props.onChange}
              onAgentSelectorChange={props.onAgentSelectorChange}
            />
          ) : definition.kind === "condition" ? (
            <WorkflowConditionProperties
              node={definition}
              inline
              readonly={props.readonly}
              onChange={props.onChange}
            />
          ) : definition.kind === "loop" ? (
            <LoopNodeInlineEditor
              node={definition}
              document={props.document}
              readonly={props.readonly}
              onChange={props.onChange}
            />
          ) : (
            <div className={styles.inlineNodeSummary}>
              <span>{nodeSummary(definition)}</span>
              {dynamicPorts(definition).length > 0 ? (
                <div className={styles.nodePorts}>
                  {dynamicPorts(definition).map((port) => (
                    <span key={port}>{port}</span>
                  ))}
                </div>
              ) : null}
              {!props.readonly ? (
                <button
                  type="button"
                  onClick={() => props.onOpenInspector(definition.id)}
                >
                  Edit properties
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

function workflowScopeRole(
  nodeId: string,
  document: FlowEditorDocumentV1
): string | null {
  const scopeId = workflowNodeOwners(
    document.nodes.map((entry) => entry.definition)
  ).get(nodeId);
  if (!scopeId) return null;
  const scope = document.nodes.find(
    (entry) => entry.id === scopeId
  )?.definition;
  if (scope?.kind !== "loop") return null;
  if (
    scope.config.mode === "while" &&
    scope.config.maxGate?.nodeId === nodeId
  ) {
    return "Max gate";
  }
  if (scope.config.body.entryNodeIds.includes(nodeId)) return "Entry";
  const exit = scope.config.body.exits.find(
    (candidate) => candidate.nodeId === nodeId
  );
  return exit ? `Exit · ${exit.outcome}` : null;
}

function LoopNodeInlineEditor(props: {
  node: Extract<WorkflowNodeDefinition, { kind: "loop" }>;
  document: FlowEditorDocumentV1;
  readonly: boolean;
  onChange: (definition: WorkflowNodeDefinition) => void;
}): JSX.Element {
  const config = props.node.config;
  const updateLimit = (value: number) => {
    const nextValue = Math.max(1, Math.trunc(value || 1));
    props.onChange({
      ...props.node,
      config:
        config.mode === "for-each"
          ? { ...config, maxItems: nextValue }
          : { ...config, maxIterations: nextValue }
    });
  };

  return (
    <div className={styles.inlineLoopForm}>
      <div className={styles.loopChrome}>
        <div className={styles.loopSettingRow}>
          <label>
            <span>
              {config.mode === "for-each" ? "Max items" : "Max iterations"}
            </span>
            <input
              type="number"
              min={1}
              readOnly={props.readonly}
              value={
                config.mode === "for-each"
                  ? config.maxItems
                  : config.maxIterations
              }
              onChange={(event) => updateLimit(Number(event.target.value))}
            />
          </label>
          {config.mode === "for-each" ? (
            <div className={styles.inlineLoopCollection}>
              <WorkflowVariableField
                value={config.collection}
                arrayOnly
                privateScope
                readonly={props.readonly}
                onChange={(collection) =>
                  props.onChange({
                    ...props.node,
                    config: { ...config, collection }
                  })
                }
              />
            </div>
          ) : (
            <span className={styles.loopConcurrency}>
              Repeat until complete
            </span>
          )}
        </div>
      </div>
      <SubCanvasRender
        className={styles.loopSubCanvas}
        offsetY={-92}
        tipText="Drag nodes here, then connect Start → task → End."
      />
    </div>
  );
}

export function AgentNodeInlineEditor(props: {
  node: Extract<WorkflowNodeDefinition, { kind: "agent" }>;
  document: FlowEditorDocumentV1;
  agentDescriptors: readonly AgentDescriptorDto[];
  readonly: boolean;
  inInspector?: boolean;
  onChange: (definition: WorkflowNodeDefinition) => void;
  onAgentSelectorChange: (nodeId: string, value: string) => void;
}): JSX.Element {
  const label = (field: string) =>
    props.inInspector
      ? field === "Prompt"
        ? "Task prompt"
        : field
      : `${props.node.title} ${field}`;
  const binding =
    props.document.workflow.agentBindings[props.node.config.agentRef];
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() =>
    binding?.agent.kind === "agent-id" ? binding.agent.agentId : null
  );
  const boundAgentId =
    binding?.agent.kind === "agent-id" ? binding.agent.agentId : null;
  useEffect(() => {
    setSelectedAgentId(boundAgentId);
  }, [boundAgentId]);
  const descriptor = props.agentDescriptors.find(
    (candidate) => candidate.id === selectedAgentId
  );
  const nodeLaunch = props.node.config.launch ?? {};
  const bindingLaunch = binding?.launch ?? {};
  const isCaller = binding?.agent.kind === "caller";
  const selectorValue = isCaller
    ? "caller"
    : selectedAgentId
      ? `agent:${selectedAgentId}`
      : binding?.agent.kind === "run-input"
        ? `input:${binding.agent.inputId}`
        : "";
  const updateConfig = (patch: Record<string, unknown>) =>
    props.onChange({
      ...props.node,
      config: { ...props.node.config, ...patch }
    } as WorkflowNodeDefinition);

  return (
    <div className={styles.inlineAgentForm}>
      <label>
        <span>Agent</span>
        <select
          aria-label={label("Agent")}
          value={selectorValue}
          disabled={props.readonly}
          onChange={(event) => {
            const value = event.target.value;
            setSelectedAgentId(
              value.startsWith("agent:") ? value.slice("agent:".length) : null
            );
            props.onAgentSelectorChange(props.node.id, event.target.value);
          }}
        >
          <option value="caller">Calling Agent · existing conversation</option>
          {binding?.agent.kind === "run-input" ? (
            <option value={`input:${binding.agent.inputId}`}>
              Choose at Run
            </option>
          ) : null}
          {binding?.agent.kind !== "run-input" ? (
            <option value={`input:agent-selector-${props.node.id}`}>
              Choose at Run
            </option>
          ) : null}
          {selectedAgentId && !descriptor ? (
            <option value={`agent:${selectedAgentId}`}>
              {selectedAgentId} · unavailable
            </option>
          ) : null}
          {props.agentDescriptors.map((agent) => (
            <option key={agent.id} value={`agent:${agent.id}`}>
              {agent.displayName}
            </option>
          ))}
        </select>
        {isCaller ? (
          <span className={styles.fieldHint}>
            Uses the calling Agent’s existing conversation, model and thinking
            settings.
          </span>
        ) : !selectedAgentId ? (
          <span className={styles.fieldHint}>
            Choose the Agent when starting a Run.
          </span>
        ) : null}
      </label>
      {!isCaller && (
        <WorkflowAgentLaunchFields
          agentId={selectedAgentId}
          capable={Boolean(descriptor?.launchPreferences)}
          value={nodeLaunch}
          inherited={bindingLaunch}
          readonly={props.readonly}
          modelLabel={label("Model")}
          effortLabel={label("Thinking level")}
          onChange={(launch) => updateConfig({ launch })}
        />
      )}
      <label className={styles.inlinePromptField}>
        <span>Prompt</span>
        <textarea
          aria-label={label("Prompt")}
          value={props.node.config.prompt}
          readOnly={props.readonly}
          placeholder="Describe the task and the evidence required."
          onChange={(event) => updateConfig({ prompt: event.target.value })}
        />
      </label>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={props.node.config.coding}
          disabled={props.readonly}
          onChange={(event) => updateConfig({ coding: event.target.checked })}
        />
        <span>Allow code changes</span>
      </label>
      <WorkflowResultFields
        node={props.node}
        readonly={props.readonly}
        onChange={props.onChange}
      />
    </div>
  );
}
