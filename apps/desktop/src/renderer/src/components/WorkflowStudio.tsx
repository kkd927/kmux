import { useWorkflowDraft } from "../hooks/useWorkflowDraft";
import { useWorkflowRun } from "../hooks/useWorkflowRun";
import { orchestration } from "../orchestrationClient";
import {
  type FlowEditorDocumentV1,
  type ValidationIssue,
  type WorkflowDefinitionV1,
  type WorkflowNodeDefinition
} from "@kmux/orchestration";
import { workflowRequiresCaller } from "@kmux/orchestration/editor";
import { workflowNodeOwners } from "@kmux/orchestration/scopes";
import type { AgentDescriptorDto } from "@kmux/proto";
import { useRef, useState } from "react";
import { WorkflowFormScope } from "./WorkflowVariableField";
import { WorkflowConditionProperties } from "./WorkflowConditionProperties";
import { Codicon } from "./Codicon";
import { WorkflowShellProperties } from "./WorkflowShellProperties";
import { WorkflowExecutionPolicies } from "./WorkflowExecutionPolicies";
import { WorkflowLoopProperties } from "./WorkflowLoopProperties";
import {
  WorkflowInputProperties,
  WorkflowOutputProperties,
  WorkflowNodeMappings,
  WorkflowSchemaField
} from "./WorkflowDataProperties";
import {
  WorkflowJsonDraftContext,
  workflowJsonDraftNodeId
} from "./WorkflowJsonField";
import {
  LOOP_FRAME_DEFAULT_SIZE,
  createStudioNode,
  mergeFlowgramDocument,
  nodeKindLabel,
  removeStudioNode,
  replaceNodeDefinition,
  replaceAgentSelector
} from "../workflowProjection";
import styles from "../styles/WorkflowsPanel.module.css";
import {
  type Catalog,
  type DraftValidation,
  type WorkflowCanvasController,
  errorMessage,
  isRecord,
  rendererId,
  NodeKindIcon,
  nodeSummary,
  CommaList,
  WorkflowAdvancedFields,
  formatPath
} from "./workflowUi";
import { WorkflowCanvas, AgentNodeInlineEditor } from "./WorkflowCanvas";
import { RunWorkspace } from "./WorkflowRunWorkspace";

export function WorkflowStudio(props: {
  draftId: string;
  definitionId: string;
  existing: boolean;
  templateId?: string;
  initiallyEditing: boolean;
  catalog: Catalog;
  agentDescriptors: readonly AgentDescriptorDto[];
  onClose: () => void;
  onCatalogChanged: () => Promise<void>;
}): JSX.Element {
  const {
    jsonDrafts,
    draft,
    canvasRevision,
    validation,
    setValidation,
    jsonDirty,
    editorText,
    dirty,
    notice,
    setNotice,
    error,
    setError,
    editorDocument,
    definition,
    updateDocument,
    removeGeneratedInputBuffers,
    save,
    applyRawJson,
    editJsonText,
    ensureSaved,
    remountCanvas
  } = useWorkflowDraft(props);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mode, setMode] = useState<"design" | "json" | "run">("design");
  const [editing, setEditing] = useState(props.initiallyEditing);
  const [runInputs, setRunInputs] = useState("{}");
  const [runId, setRunId] = useState<string | null>(null);
  const { run, refresh: refreshRun, error: runError } = useWorkflowRun(runId);
  const displayedError = error ?? runError;
  const [messageText, setMessageText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const canvasControllerRef = useRef<WorkflowCanvasController | null>(null);
  const selectedEntry = editorDocument?.nodes.find(
    (entry) => entry.id === selectedNodeId
  );

  const saveFromToolbar = async () => {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      await save();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const runWorkflow = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (definition && workflowRequiresCaller(definition))
        throw new Error(
          "This Workflow requires a calling Agent. Run it from an existing Agent conversation using kmux-orchestration."
        );
      const inputs: unknown = JSON.parse(runInputs);
      if (!isRecord(inputs))
        throw new Error("Run inputs must be a JSON object");
      const saved = await ensureSaved();
      const checked = await orchestration("workflow.draft.validate", {
        draftId: saved.draftId,
        expectedRevision: saved.revision
      });
      setValidation(checked);
      if (!checked.publishable || !checked.canonical.ok) {
        setNotice(null);
        setMode("design");
        return;
      }
      const summary = await orchestration("workflow.run", {
        workflow: props.definitionId,
        expectedDraft: { draftId: saved.draftId, revision: saved.revision },
        runId: rendererId("run"),
        inputs
      });
      await props.onCatalogChanged();
      setRunId(summary.runId);
      setMode("run");
      setNotice("Workflow started");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async () => {
    if (!draft) return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setBusy(true);
    try {
      await orchestration("workflow.draft.delete", {
        draftId: draft.draftId,
        expectedRevision: draft.revision
      });
      await props.onCatalogChanged();
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const changeMode = (next: "design" | "json" | "run") => {
    try {
      if (mode === "json" && jsonDirty) applyRawJson();
      setMode(next);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const addNode = (kind: WorkflowNodeDefinition["kind"]) => {
    if (!editorDocument) return;
    if (
      (kind === "start" || kind === "end") &&
      editorDocument.nodes.some((entry) => entry.definition.kind === kind)
    ) {
      setError(`Only one ${kind} node is supported`);
      return;
    }
    const id = `${kind}:${crypto.randomUUID().slice(0, 8)}`;
    const node = createStudioNode(kind, id);
    const owners = workflowNodeOwners(
      editorDocument.nodes.map((candidate) => candidate.definition)
    );
    const selectedScope =
      selectedEntry?.definition.kind === "loop"
        ? selectedEntry.id
        : selectedEntry
          ? owners.get(selectedEntry.id)
          : undefined;
    if ((kind === "break" || kind === "continue") && !selectedScope) {
      setError(
        "Select a Loop or a node inside it before adding Break or Continue."
      );
      return;
    }
    const scopedNodes = editorDocument.nodes.filter(
      (candidate) => !owners.has(candidate.id)
    );
    const rightmostX = scopedNodes.reduce(
      (current, candidate) =>
        Math.max(
          current,
          candidate.position.x +
            (candidate.size?.width ??
              (candidate.definition.kind === "loop"
                ? LOOP_FRAME_DEFAULT_SIZE.width
                : 360))
        ),
      0
    );
    const entry = {
      id,
      position: {
        x: rightmostX + 100,
        y: 120 + (scopedNodes.length % 3) * 180
      },
      definition: node
    } satisfies FlowEditorDocumentV1["nodes"][number];
    const agentBindings = { ...editorDocument.workflow.agentBindings };
    let workflow = editorDocument.workflow;
    if (node.kind === "agent") {
      const selectorInputId = `agent-selector-${id}`;
      agentBindings[node.config.agentRef] = {
        agent: { kind: "run-input", inputId: selectorInputId },
        scope: { kind: "run" },
        authorityMode: "ambient",
        targetPolicy: "local",
        surfacePolicy: "create",
        sessionPolicy: "fresh",
        worktreePolicy: "current",
        inputMode: "orchestrated"
      };
      workflow = {
        ...workflow,
        inputs: [
          ...workflow.inputs,
          {
            id: selectorInputId,
            required: true,
            schema: { schema: { type: "string", minLength: 1 } }
          }
        ]
      };
    }
    const controller = canvasControllerRef.current;
    if (!controller) {
      setError("Workflow canvas is not ready");
      return;
    }
    try {
      const seeded = {
        ...editorDocument,
        workflow: { ...workflow, agentBindings },
        nodes: [...editorDocument.nodes, entry]
      };
      if ((kind === "break" || kind === "continue") && selectedScope) {
        entry.position = { x: 540, y: 200 };
        const scoped = {
          ...seeded,
          nodes: seeded.nodes.map((candidate) =>
            candidate.id === selectedScope &&
            candidate.definition.kind === "loop"
              ? {
                  ...candidate,
                  definition: {
                    ...candidate.definition,
                    config: {
                      ...candidate.definition.config,
                      body: {
                        ...candidate.definition.config.body,
                        nodeIds: [
                          ...candidate.definition.config.body.nodeIds,
                          id
                        ],
                        exits: [
                          ...candidate.definition.config.body.exits,
                          { nodeId: id, outcome: `${kind}:${id}`, action: kind }
                        ]
                      }
                    }
                  }
                }
              : candidate
          )
        };
        updateDocument(scoped, { remount: true });
      } else
        updateDocument(
          mergeFlowgramDocument(controller.createNode(entry), seeded)
        );
      setSelectedNodeId(id);
      setInspectorOpen(true);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const updateSelected = (next: WorkflowNodeDefinition) => {
    if (!editorDocument) return;
    const previous = editorDocument.nodes.find(
      (entry) => entry.id === next.id
    )?.definition;
    const changedBranches =
      next.kind === "condition" &&
      previous?.kind === "condition" &&
      JSON.stringify(next.config.ports) !==
        JSON.stringify(previous.config.ports);
    updateDocument(replaceNodeDefinition(editorDocument, next), {
      remount: changedBranches
    });
  };

  const updateInlineNode = (next: WorkflowNodeDefinition) => {
    if (!editorDocument) return;
    updateDocument(replaceNodeDefinition(editorDocument, next));
  };

  const deleteNode = (nodeId = selectedEntry?.id) => {
    if (!editorDocument || !nodeId) return;
    const entry = editorDocument.nodes.find(
      (candidate) => candidate.id === nodeId
    );
    if (!entry) return;
    if (entry.definition.kind === "start" || entry.definition.kind === "end") {
      setError("Start and End are structural nodes and cannot be deleted");
      return;
    }
    const controller = canvasControllerRef.current;
    if (!controller) {
      setError("Workflow canvas is not ready");
      return;
    }
    try {
      const pruned = removeStudioNode(editorDocument, entry.id);
      removeGeneratedInputBuffers(pruned);
      updateDocument(
        mergeFlowgramDocument(controller.deleteNode(entry.id), pruned)
      );
      setSelectedNodeId(null);
      setInspectorOpen(false);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const updateAgentSelector = (
    nodeId: string,
    value: string,
    remount = false
  ) => {
    if (!editorDocument) return;
    const entry = editorDocument.nodes.find(
      (candidate) => candidate.id === nodeId
    );
    if (!entry || entry.definition.kind !== "agent") return;
    if (value === "caller") {
      const next = replaceAgentSelector(
        editorDocument,
        entry.definition.config.agentRef,
        { kind: "caller" }
      );
      removeGeneratedInputBuffers(next);
      updateDocument(next, { remount });
      return;
    }
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) return;
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (kind !== "agent" && kind !== "input") return;
    const next = replaceAgentSelector(
      editorDocument,
      entry.definition.config.agentRef,
      kind === "agent"
        ? { kind: "agent-id", agentId: id }
        : { kind: "run-input", inputId: id }
    );
    removeGeneratedInputBuffers(next);
    updateDocument(next, { remount });
  };

  const openValidationIssue = (issue: ValidationIssue) => {
    const nodeId = validationIssueNodeId(issue, definition, editorDocument);
    setMode(nodeId ? "design" : "json");
    if (nodeId) {
      setSelectedNodeId(nodeId);
      setInspectorOpen(true);
      remountCanvas();
    }
  };

  return (
    <WorkflowJsonDraftContext.Provider value={jsonDrafts}>
      <div className={styles.modalBackdrop} role="presentation">
        <section className={styles.studio} role="dialog" aria-modal="true">
          <header className={styles.studioHeader}>
            <div className={styles.studioIdentity}>
              <span className={styles.studioMark}>
                <Codicon name="type-hierarchy-sub" />
              </span>
              <div>
                {editing && editorDocument && definition ? (
                  <input
                    className={styles.workflowNameInput}
                    value={definition.name}
                    aria-label="Workflow name"
                    onChange={(event) =>
                      updateDocument({
                        ...editorDocument,
                        workflow: {
                          ...editorDocument.workflow,
                          name: event.target.value
                        }
                      })
                    }
                  />
                ) : definition ? (
                  <strong>{definition.name}</strong>
                ) : (
                  <strong>Invalid workflow draft</strong>
                )}
                <span>{dirty ? "Unsaved changes" : "Saved"}</span>
              </div>
            </div>
            {editing ? (
              <nav
                className={styles.studioTabs}
                aria-label="Workflow Studio views"
              >
                {(["design", "json"] as const).map((tab) => (
                  <button
                    type="button"
                    key={tab}
                    data-active={mode === tab ? "true" : "false"}
                    onClick={() => changeMode(tab)}
                  >
                    {tab === "design" ? "Design" : "JSON"}
                  </button>
                ))}
              </nav>
            ) : (
              <div className={styles.readOnlyBadge}>
                <Codicon name="eye" /> Read-only
              </div>
            )}
            <div className={styles.studioActions}>
              {editing ? (
                <>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !dirty ||
                      (!jsonDirty && jsonDrafts.errors.length > 0)
                    }
                    onClick={() => void saveFromToolbar()}
                  >
                    Save
                  </button>
                  {mode !== "run" ? (
                    <button
                      type="button"
                      className={styles.runButton}
                      disabled={
                        busy || (!jsonDirty && jsonDrafts.errors.length > 0)
                      }
                      onClick={() => changeMode("run")}
                    >
                      <Codicon name="play" /> Run
                    </button>
                  ) : null}
                  {draft ? (
                    <button
                      type="button"
                      className={
                        deleteConfirm ? styles.dangerButton : undefined
                      }
                      disabled={busy}
                      onClick={() => void deleteDraft()}
                      onBlur={() => setDeleteConfirm(false)}
                    >
                      {deleteConfirm ? "Confirm delete" : "Delete"}
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {mode !== "run" ? (
                    <button
                      type="button"
                      className={styles.runButton}
                      disabled={busy}
                      onClick={() => changeMode("run")}
                    >
                      <Codicon name="play" /> Run
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(true);
                      setMode("design");
                    }}
                  >
                    <Codicon name="edit" /> Edit
                  </button>
                </>
              )}
              <button
                type="button"
                className={styles.closeButton}
                aria-label="Close Workflow Studio"
                onClick={props.onClose}
              >
                <Codicon name="close" />
              </button>
            </div>
          </header>

          <div>
            {jsonDrafts.errors.length > 0 ? (
              <div className={styles.studioError} role="alert">
                <strong>
                  Correct unfinished JSON fields before saving or running.
                </strong>
                <div className={styles.inlineActions}>
                  {jsonDrafts.errors.map((issue) => {
                    const nodeId = editorDocument
                      ? workflowJsonDraftNodeId(issue.path, editorDocument)
                      : undefined;
                    return (
                      <button
                        type="button"
                        key={JSON.stringify(issue.path)}
                        onClick={() => {
                          setMode("design");
                          setSelectedNodeId(nodeId ?? null);
                          setInspectorOpen(true);
                        }}
                      >
                        {issue.label} ·{" "}
                        {editorDocument?.nodes.find(
                          (entry) => entry.id === nodeId
                        )?.definition.title ?? "Workflow"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {notice || displayedError ? (
              <div
                className={
                  displayedError ? styles.studioError : styles.studioNotice
                }
                role={displayedError ? "alert" : "status"}
              >
                {displayedError ?? notice}
              </div>
            ) : null}
          </div>
          {mode === "design" && editing ? (
            <div className={styles.designLayout}>
              <main className={styles.canvasShell}>
                {editorDocument ? (
                  <WorkflowCanvas
                    key={`${props.draftId}:${canvasRevision}`}
                    document={editorDocument}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(nodeId) => {
                      setSelectedNodeId(nodeId);
                      setInspectorOpen(true);
                    }}
                    onOpenInspector={(nodeId) => {
                      setSelectedNodeId(nodeId);
                      setInspectorOpen(true);
                    }}
                    onAddNode={addNode}
                    onDeleteNode={deleteNode}
                    onAgentSelectorChange={updateAgentSelector}
                    onDefinitionChange={updateInlineNode}
                    agentDescriptors={props.agentDescriptors}
                    onController={(controller) => {
                      canvasControllerRef.current = controller;
                    }}
                    onChange={(flow) =>
                      updateDocument(
                        mergeFlowgramDocument(flow, editorDocument)
                      )
                    }
                    inspector={
                      inspectorOpen && selectedEntry && editorDocument ? (
                        <aside className={styles.inspectorDrawer}>
                          <header className={styles.inspectorDrawerHeader}>
                            <div>
                              <span className={styles.sideHeading}>
                                Properties
                              </span>
                              <strong>{selectedEntry.definition.title}</strong>
                            </div>
                            <button
                              type="button"
                              aria-label="Close node properties"
                              onClick={() => setInspectorOpen(false)}
                            >
                              <Codicon name="close" />
                            </button>
                          </header>
                          <>
                            <WorkflowFormScope nodeId={selectedEntry.id}>
                              <NodeInspector
                                key={selectedEntry.id}
                                entry={selectedEntry}
                                document={editorDocument}
                                agentDescriptors={props.agentDescriptors}
                                onChange={updateSelected}
                                onDocumentChange={(next) =>
                                  updateDocument(next, { remount: true })
                                }
                                onAgentSelectorChange={(nodeId, value) =>
                                  updateAgentSelector(nodeId, value, true)
                                }
                                onDelete={() => deleteNode(selectedEntry.id)}
                              />
                            </WorkflowFormScope>
                            <ValidationPanel
                              validation={validation}
                              onIssue={openValidationIssue}
                            />
                          </>
                        </aside>
                      ) : null
                    }
                  />
                ) : (
                  <div className={styles.canvasInvalid}>
                    <Codicon name="warning" />
                    <strong>Editor document is structurally invalid</strong>
                    <span>
                      Use the JSON view to repair it. Your changes remain saved.
                    </span>
                    <button type="button" onClick={() => setMode("json")}>
                      Open JSON
                    </button>
                  </div>
                )}
                {!inspectorOpen && validation ? (
                  <aside
                    className={styles.canvasValidation}
                    aria-label="Workflow validation"
                  >
                    <ValidationPanel
                      validation={validation}
                      onIssue={openValidationIssue}
                    />
                  </aside>
                ) : null}
              </main>
            </div>
          ) : null}

          {mode === "design" && !editing ? (
            <div className={styles.readOnlyLayout}>
              <main className={styles.canvasShell}>
                {editorDocument ? (
                  <WorkflowCanvas
                    key={`${props.draftId}:${canvasRevision}:readonly`}
                    document={editorDocument}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                    onOpenInspector={setSelectedNodeId}
                    onAddNode={() => undefined}
                    onDeleteNode={() => undefined}
                    onAgentSelectorChange={() => undefined}
                    onDefinitionChange={() => undefined}
                    agentDescriptors={props.agentDescriptors}
                    onController={(controller) => {
                      canvasControllerRef.current = controller;
                    }}
                    readonly
                    onChange={() => undefined}
                  />
                ) : (
                  <div className={styles.canvasInvalid}>
                    <Codicon name="warning" />
                    <strong>Editor document is structurally invalid</strong>
                    <span>Edit the workflow to repair it before running.</span>
                  </div>
                )}
              </main>
              <aside className={styles.readOnlySummary}>
                {selectedEntry ? (
                  <ReadOnlyNodeSummary entry={selectedEntry} />
                ) : (
                  <>
                    <div className={styles.sideHeading}>Workflow</div>
                    <strong>{definition?.name}</strong>
                    <p>Run this workflow or edit its steps.</p>
                  </>
                )}
                <div className={styles.policyGrid}>
                  <span>
                    <small>Nodes</small>
                    <strong>{definition?.nodes.length ?? 0}</strong>
                  </span>
                  <span>
                    <small>Edges</small>
                    <strong>{definition?.edges.length ?? 0}</strong>
                  </span>
                  <span>
                    <small>Agents</small>
                    <strong>
                      {definition
                        ? Object.keys(definition.agentBindings).length
                        : 0}
                    </strong>
                  </span>
                </div>
                <p className={styles.fieldHint}>
                  Opening or closing this view never pauses a running workflow.
                </p>
              </aside>
            </div>
          ) : null}

          {mode === "json" ? (
            <div className={styles.jsonLayout}>
              <label>
                <span>Workflow JSON</span>
                <textarea
                  value={editorText}
                  onChange={(event) => {
                    editJsonText(event.target.value);
                  }}
                  spellCheck={false}
                />
              </label>
              <ValidationPanel
                validation={validation}
                onIssue={openValidationIssue}
              />
            </div>
          ) : null}

          {mode === "run" ? (
            <RunWorkspace
              run={run}
              runInputs={runInputs}
              setRunInputs={setRunInputs}
              canRun={
                !busy && jsonDrafts.errors.length === 0 && Boolean(definition)
              }
              definition={definition ?? undefined}
              agentDescriptors={props.agentDescriptors}
              onRun={() => void runWorkflow()}
              messageText={messageText}
              setMessageText={setMessageText}
              replyTo={replyTo}
              setReplyTo={setReplyTo}
              onRefresh={refreshRun}
            />
          ) : null}
        </section>
      </div>
    </WorkflowJsonDraftContext.Provider>
  );
}

function ReadOnlyNodeSummary(props: {
  entry: FlowEditorDocumentV1["nodes"][number];
}): JSX.Element {
  const node = props.entry.definition;
  return (
    <section className={styles.readOnlyNodeSummary}>
      <div className={styles.sideHeading}>Selected node</div>
      <div className={styles.nodeIdentityRow}>
        <NodeKindIcon kind={node.kind} />
        <div>
          <strong>{node.title}</strong>
          <code>{node.id}</code>
        </div>
      </div>
      <p>{nodeSummary(node)}</p>
      <div className={styles.policyGrid}>
        <span>
          <small>Kind</small>
          <strong>{nodeKindLabel(node.kind)}</strong>
        </span>
        <span>
          <small>Join</small>
          <strong>{node.joinPolicy ?? "all-successful"}</strong>
        </span>
      </div>
    </section>
  );
}

function NodeInspector(props: {
  entry: FlowEditorDocumentV1["nodes"][number];
  document: FlowEditorDocumentV1;
  agentDescriptors: readonly AgentDescriptorDto[];
  onChange: (definition: WorkflowNodeDefinition) => void;
  onDocumentChange: (document: FlowEditorDocumentV1) => void;
  onAgentSelectorChange: (nodeId: string, value: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const node = props.entry.definition;
  const update = (patch: Partial<WorkflowNodeDefinition>) =>
    props.onChange({ ...node, ...patch } as WorkflowNodeDefinition);
  const updateConfig = (patch: Record<string, unknown>) =>
    props.onChange({
      ...node,
      config: { ...node.config, ...patch }
    } as WorkflowNodeDefinition);

  return (
    <div className={styles.propertyForm}>
      <div className={styles.nodeIdentityRow}>
        <NodeKindIcon kind={node.kind} />
        <div>
          <strong>{nodeKindLabel(node.kind)}</strong>
          <code>{node.id}</code>
        </div>
      </div>
      <label>
        <span>Title</span>
        <input
          value={node.title}
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>

      {node.kind === "agent" ? (
        <AgentNodeInlineEditor
          node={node}
          document={props.document}
          agentDescriptors={props.agentDescriptors}
          readonly={false}
          inInspector
          onChange={props.onChange}
          onAgentSelectorChange={props.onAgentSelectorChange}
        />
      ) : null}

      {node.kind === "start" ? (
        <WorkflowInputProperties
          document={props.document}
          nodeId={node.id}
          onChange={props.onDocumentChange}
        />
      ) : null}
      {node.kind === "end" ? (
        <WorkflowOutputProperties
          document={props.document}
          nodeId={node.id}
          onChange={props.onDocumentChange}
        />
      ) : null}
      {node.kind === "shell" ? (
        <WorkflowShellProperties
          node={node}
          document={props.document}
          onChange={props.onChange}
        />
      ) : null}

      {node.kind === "condition" ? (
        <WorkflowConditionProperties node={node} onChange={props.onChange} />
      ) : null}
      {node.kind === "loop" ? (
        <WorkflowLoopProperties
          node={node}
          document={props.document}
          onChange={props.onChange}
        />
      ) : null}
      {node.kind === "human-gate" ? (
        <>
          <label>
            <span>Question</span>
            <textarea
              value={node.config.question}
              onChange={(event) =>
                updateConfig({ question: event.target.value })
              }
            />
          </label>
          <CommaList
            key={node.id}
            label="Permitted resolutions"
            value={node.config.resolutions}
            onChange={(resolutions) => updateConfig({ resolutions })}
          />
          <p className={styles.fieldHint}>
            Only an explicit local-user action can resolve this gate.
          </p>
        </>
      ) : null}

      {node.kind !== "start" &&
      node.kind !== "agent" &&
      node.kind !== "condition" &&
      node.kind !== "break" &&
      node.kind !== "continue" &&
      node.kind !== "loop" ? (
        <WorkflowNodeMappings
          node={node}
          document={props.document}
          onChange={props.onChange}
        />
      ) : null}
      {node.kind === "shell" ? (
        <fieldset className={styles.argumentRow}>
          <legend>Structured result schema</legend>
          <WorkflowSchemaField
            value={node.resultSchema}
            path={["nodes", node.id, "resultSchema"]}
            onChange={(resultSchema) => update({ resultSchema })}
          />
        </fieldset>
      ) : null}
      {node.kind !== "agent" && node.kind !== "loop" ? (
        <WorkflowAdvancedFields
          compact={
            node.kind === "condition" ||
            node.kind === "break" ||
            node.kind === "continue"
          }
        >
          <label>
            <span>Join policy</span>
            <select
              aria-label="Join policy"
              value={node.joinPolicy ?? ""}
              onChange={(event) =>
                update({
                  joinPolicy: (event.target.value ||
                    undefined) as WorkflowNodeDefinition["joinPolicy"],
                  anySuccessfulDisposition:
                    event.target.value === "any-successful"
                      ? node.anySuccessfulDisposition
                      : undefined
                })
              }
            >
              <option value="">
                Not set · required for multiple incoming edges
              </option>
              <option value="all-successful">All successful</option>
              <option value="all-settled">All settled</option>
              <option value="any-successful">Any successful</option>
            </select>
          </label>
          {node.joinPolicy === "any-successful" ? (
            <label>
              <span>Remaining attempts after first success</span>
              <select
                aria-label="Remaining attempts after first success"
                value={node.anySuccessfulDisposition ?? ""}
                onChange={(event) =>
                  update({
                    anySuccessfulDisposition: (event.target.value ||
                      undefined) as WorkflowNodeDefinition["anySuccessfulDisposition"]
                  })
                }
              >
                <option value="">Choose a disposition</option>
                <option value="wait">Wait for settlement</option>
                <option value="cancel">Cancel and confirm termination</option>
              </select>
              <span className={styles.fieldHint}>
                The Run waits for settlement or confirmed cancellation.
              </span>
            </label>
          ) : null}
          <WorkflowExecutionPolicies node={node} onChange={props.onChange} />
        </WorkflowAdvancedFields>
      ) : null}
      <button
        type="button"
        className={styles.dangerButton}
        onClick={props.onDelete}
      >
        <Codicon name="trash" /> Delete node
      </button>
    </div>
  );
}

function ValidationPanel(props: {
  validation: DraftValidation | null;
  onIssue?: (issue: ValidationIssue) => void;
}): JSX.Element | null {
  if (!props.validation) return null;
  const issues = [
    ...new Map(
      [
        ...(props.validation.canonical.ok
          ? []
          : props.validation.canonical.issues),
        ...(props.validation.editor.ok ? [] : props.validation.editor.issues)
      ].map((issue) => [JSON.stringify(issue), issue])
    ).values()
  ];
  return (
    <div
      className={
        props.validation.publishable
          ? styles.validationOk
          : styles.validationIssues
      }
    >
      <strong>
        {props.validation.publishable ? "Ready to run" : "Fix workflow errors"}
      </strong>
      {props.validation.canonical.ok &&
      props.validation.editor.ok &&
      !props.validation.semanticallyEquivalent ? (
        <p>Workflow data is inconsistent. Save it again before running.</p>
      ) : null}
      {issues.slice(0, 20).map((issue, index) => (
        <button
          type="button"
          key={`${issue.code}:${index}`}
          disabled={!props.onIssue}
          onClick={() => props.onIssue?.(issue)}
        >
          <code>{formatPath(issue.path)}</code>
          <span>{issue.message}</span>
        </button>
      ))}
    </div>
  );
}

function validationIssueNodeId(
  issue: ValidationIssue,
  definition: WorkflowDefinitionV1 | null,
  editor: FlowEditorDocumentV1 | null
): string | null {
  const nodesIndex = issue.path.findIndex((part) => part === "nodes");
  const candidateIndex =
    nodesIndex >= 0 ? issue.path[nodesIndex + 1] : undefined;
  if (typeof candidateIndex === "number") {
    return (
      editor?.nodes[candidateIndex]?.id ??
      definition?.nodes[candidateIndex]?.id ??
      null
    );
  }
  const candidateId = issue.path.find(
    (part) =>
      typeof part === "string" &&
      (editor?.nodes.some((entry) => entry.id === part) ?? false)
  );
  return typeof candidateId === "string" ? candidateId : null;
}
