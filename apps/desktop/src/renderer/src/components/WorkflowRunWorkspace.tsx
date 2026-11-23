import { orchestration } from "../orchestrationClient";
import type {
  RendererOrchestrationMethod,
  OrchestrationParams
} from "@kmux/orchestration";
import {
  type ArtifactRef,
  type RepositoryStateRef,
  type TerminalExecutionRef,
  type WorkflowDefinitionV1,
  type WorkflowRun
} from "@kmux/orchestration";
import type { WorkflowVersion } from "@kmux/orchestration";
import type { AgentDescriptorDto } from "@kmux/proto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Codicon } from "./Codicon";
import { WorkflowRunInputs } from "./WorkflowRunInputs";
import {
  projectWorkflowRunExecutions,
  workflowRunDiagramDefinition,
  workflowRunDiagramDocument,
  type WorkflowRunExecutionProjection
} from "../workflowRunProjection";
import styles from "../styles/WorkflowsPanel.module.css";
import {
  type WorkflowCanvasController,
  errorMessage,
  NodeKindIcon,
  rendererId,
  messageBody,
  launchDescription,
  pretty
} from "./workflowUi";
import { WorkflowRunProjectionContext, WorkflowCanvas } from "./WorkflowCanvas";

export function RunWorkspace(props: {
  run: WorkflowRun | null;
  runInputs: string;
  setRunInputs: (value: string) => void;
  canRun: boolean;
  definition?: WorkflowDefinitionV1;
  agentDescriptors?: readonly AgentDescriptorDto[];
  onRun: () => void;
  messageText: string;
  setMessageText: (value: string) => void;
  replyTo: string | null;
  setReplyTo: (value: string | null) => void;
  onRefresh: () => Promise<void>;
  inspectionOnly?: boolean;
}): JSX.Element {
  const [showRunInputs, setShowRunInputs] = useState(false);
  const runCanvasRef = useRef<WorkflowCanvasController | null>(null);
  const setRunCanvas = useCallback(
    (controller: WorkflowCanvasController | null) => {
      runCanvasRef.current = controller;
    },
    []
  );
  const [runView, setRunView] = useState<"diagram" | "executions">("diagram");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null
  );
  const [runVersion, setRunVersion] = useState<WorkflowVersion | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const versionId =
    props.run?.source.kind === "workflow-version"
      ? props.run.source.workflowVersionId
      : undefined;
  useEffect(() => {
    let current = true;
    setRunVersion(null);
    setVersionError(null);
    if (versionId)
      void orchestration("workflow.version.get", {
        workflowVersionId: versionId
      })
        .then((version) => {
          if (current) setRunVersion(version);
        })
        .catch((cause) => {
          if (current) setVersionError(errorMessage(cause));
        });
    return () => {
      current = false;
    };
  }, [versionId]);
  const diagramReady =
    !versionId || runVersion?.workflowVersionId === versionId;
  const diagramText =
    props.run && diagramReady
      ? JSON.stringify(workflowRunDiagramDefinition(props.run))
      : "null";
  const diagramDocument = useMemo(() => {
    const definition = JSON.parse(diagramText) as WorkflowDefinitionV1 | null;
    return definition
      ? workflowRunDiagramDocument(definition, runVersion?.editorDocument)
      : null;
  }, [diagramText, runVersion]);
  const executionProjection = useMemo(
    () =>
      props.run
        ? projectWorkflowRunExecutions(
            props.run.graph.nodes,
            props.run.attempts
          )
        : new Map<string, readonly WorkflowRunExecutionProjection[]>(),
    [props.run]
  );
  const showDiagram = runView === "diagram" && diagramDocument !== null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(
    null
  );
  const invoke = async <M extends RendererOrchestrationMethod>(
    method: M,
    params: OrchestrationParams<M>
  ) => {
    try {
      await orchestration(method, params);
      await props.onRefresh();
      setActionError(null);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  };
  const selectedRunNode = props.run
    ? selectedRunNodeId
      ? props.run.graph.nodes[selectedRunNodeId]
      : showDiagram
        ? undefined
        : Object.values(props.run.graph.nodes)[0]
    : undefined;
  return (
    <div
      className={styles.runLayout}
      data-inputs-hidden={
        (props.run && (!showRunInputs || props.inspectionOnly)) || undefined
      }
      data-inspection-only={props.inspectionOnly || undefined}
      data-configuring={!props.run || undefined}
    >
      {!props.inspectionOnly && (!props.run || showRunInputs) ? (
        <form
          className={styles.runLaunch}
          onSubmit={(event) => {
            event.preventDefault();
            props.onRun();
          }}
        >
          <div className={styles.sideHeading}>Run workflow</div>
          {props.definition ? (
            <WorkflowRunInputs
              definition={props.definition}
              agents={props.agentDescriptors ?? []}
              value={props.runInputs}
              onChange={props.setRunInputs}
            />
          ) : (
            <p>Open a workflow to configure its inputs.</p>
          )}
          <button
            type="submit"
            className={styles.runButton}
            disabled={!props.canRun}
          >
            <Codicon name="play" /> Start Run
          </button>
        </form>
      ) : null}
      <main className={styles.runGraph}>
        {!props.run ? (
          <div className={styles.emptyState}>
            <Codicon name="run-all" />
            <strong>No active projection</strong>
            <span>Start the workflow to see its progress.</span>
          </div>
        ) : (
          <>
            <div className={styles.runHeader}>
              <div>
                <span
                  className={styles.statusDot}
                  data-status={props.run.status}
                />
                <strong>{props.run.status}</strong>
                <code>{props.run.runId}</code>
              </div>
              <button type="button" onClick={() => void props.onRefresh()}>
                <Codicon name="refresh" /> Refresh
              </button>
            </div>
            {actionError ? (
              <div className={styles.errorBanner}>{actionError}</div>
            ) : null}
            {!props.inspectionOnly ? (
              <button
                type="button"
                onClick={() => setShowRunInputs((value) => !value)}
              >
                {showRunInputs ? "Hide Run inputs" : "Configure another Run"}
              </button>
            ) : null}
            {versionError ? (
              <div className={styles.errorBanner}>
                Run layout could not be loaded: {versionError}
              </div>
            ) : !diagramReady ? (
              <p>Loading the workflow diagram…</p>
            ) : null}
            {diagramDocument ? (
              <div
                className={styles.runViewTabs}
                role="group"
                aria-label="Run view"
              >
                <button
                  type="button"
                  aria-pressed={showDiagram}
                  onClick={() => setRunView("diagram")}
                >
                  Diagram
                </button>
                <button
                  type="button"
                  aria-pressed={!showDiagram}
                  onClick={() => setRunView("executions")}
                >
                  All executions
                </button>
              </div>
            ) : null}
            {showDiagram ? (
              <label className={styles.runNodePicker}>
                <span>Inspect workflow node</span>
                <select
                  value={selectedTemplateId ?? ""}
                  onChange={(event) => {
                    const id = event.target.value;
                    setSelectedTemplateId(id || null);
                    setSelectedRunNodeId(
                      executionProjection.get(id)?.at(-1)?.nodeId ?? null
                    );
                    if (id) runCanvasRef.current?.focusNode(id);
                  }}
                >
                  <option value="">Choose a node</option>
                  {diagramDocument.nodes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.definition.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {showDiagram ? (
              <div
                className={`${styles.canvasShell} ${styles.runDiagram}`}
                aria-label="Runtime diagram"
              >
                <WorkflowRunProjectionContext.Provider
                  value={executionProjection}
                >
                  <WorkflowCanvas
                    key={diagramText}
                    document={diagramDocument}
                    readonly
                    selectedNodeId={selectedTemplateId}
                    agentDescriptors={props.agentDescriptors ?? []}
                    onSelectNode={(id) => {
                      setSelectedTemplateId(id);
                      const executions = executionProjection.get(id);
                      setSelectedRunNodeId(executions?.at(-1)?.nodeId ?? null);
                    }}
                    onOpenInspector={() => undefined}
                    onAddNode={() => undefined}
                    onDeleteNode={() => undefined}
                    onAgentSelectorChange={() => undefined}
                    onDefinitionChange={() => undefined}
                    onController={setRunCanvas}
                    onChange={() => undefined}
                  />
                </WorkflowRunProjectionContext.Provider>
              </div>
            ) : null}
            {showDiagram ? (
              <p className={styles.fieldHint}>
                {selectedTemplateId
                  ? `Executions of ${diagramDocument.nodes.find((entry) => entry.id === selectedTemplateId)?.definition.title ?? selectedTemplateId}`
                  : "Select a node to inspect its executions. Counts include every materialized iteration."}
              </p>
            ) : null}
            <div className={styles.runNodes}>
              {Object.values(props.run.graph.nodes)
                .filter(
                  (node) =>
                    !showDiagram ||
                    (node.materialization?.templateNodeId ?? node.nodeId) ===
                      selectedTemplateId
                )
                .map((node) => {
                  const attemptId =
                    node.activeAttemptId ?? node.attemptIds.at(-1);
                  const attempt = attemptId
                    ? props.run!.attempts[attemptId]
                    : undefined;
                  return (
                    <article
                      key={node.nodeId}
                      data-selected={
                        selectedRunNode?.nodeId === node.nodeId
                          ? "true"
                          : "false"
                      }
                      tabIndex={0}
                      onClick={() => setSelectedRunNodeId(node.nodeId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRunNodeId(node.nodeId);
                        }
                      }}
                    >
                      <NodeKindIcon kind={node.definition.kind} />
                      <div>
                        <strong>{node.definition.title}</strong>
                        <span>
                          {node.materialization
                            ? `${node.materialization.path.map((scope) => `${scope.loopNodeId} ${scope.iteration + 1}`).join(" / ")} · `
                            : ""}
                          {node.status}
                          {attempt ? ` · attempt ${attempt.ordinal}` : ""}
                        </span>
                      </div>
                      <div className={styles.runNodeActions}>
                        {attempt &&
                        [
                          "preparing",
                          "delivery-pending",
                          "running",
                          "waiting-input"
                        ].includes(attempt.status) ? (
                          <button
                            type="button"
                            onClick={() =>
                              void invoke("orchestration.attempt.cancel", {
                                attemptId: attempt.attemptId,
                                idempotencyKey: rendererId("cancel")
                              })
                            }
                          >
                            Cancel
                          </button>
                        ) : null}
                        {attempt &&
                        ["uncertain", "cancel-uncertain"].includes(
                          attempt.status
                        ) ? (
                          <button
                            type="button"
                            onClick={() =>
                              void invoke("orchestration.attempt.recover", {
                                attemptId: attempt.attemptId,
                                resolution: "mark-failed",
                                summary:
                                  "Local user reconciled the uncertain worker as failed"
                              })
                            }
                          >
                            Mark failed
                          </button>
                        ) : null}
                        {attempt &&
                        props.run &&
                        !isTerminalWorkflowRun(props.run.status) &&
                        ["failed", "canceled"].includes(attempt.status) ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                void invoke("orchestration.attempt.retry", {
                                  attemptId: attempt.attemptId,
                                  idempotencyKey: rendererId("retry")
                                })
                              }
                            >
                              Retry
                            </button>
                            {node.definition.kind === "agent" &&
                            node.definition.retryPolicy?.placement ===
                              "approval-for-change" ? (
                              <button
                                type="button"
                                title="Authorize one retry in a new terminal using this Task's Agent and worktree policy."
                                onClick={() =>
                                  void invoke("orchestration.attempt.retry", {
                                    attemptId: attempt.attemptId,
                                    idempotencyKey: rendererId("retry"),
                                    placementChangeApproved: true
                                  })
                                }
                              >
                                Approve new placement and retry
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
            </div>
            {selectedRunNode && (!showDiagram || selectedTemplateId) ? (
              <RunNodeInspection
                run={props.run}
                nodeId={selectedRunNode.nodeId}
                onInvoke={invoke}
              />
            ) : null}
            {Object.values(props.run.gates)
              .filter((gate) => gate.state === "open")
              .map((gate) => (
                <section className={styles.gateCard} key={gate.gateId}>
                  <div>
                    <Codicon name="lock" />
                    <strong>{gate.question}</strong>
                  </div>
                  <div>
                    {gate.resolutions.map((resolution) => (
                      <button
                        type="button"
                        key={resolution}
                        onClick={() =>
                          void invoke("orchestration.gate.resolve", {
                            runId: props.run!.runId,
                            gateId: gate.gateId,
                            resolution
                          })
                        }
                      >
                        {resolution}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
          </>
        )}
      </main>
      <aside className={styles.runMessages}>
        <div className={styles.sideHeading}>Typed channel</div>
        <div className={styles.messageList}>
          {props.run?.messages.slice(-12).map((message) => (
            <button
              type="button"
              key={message.messageId}
              onClick={() =>
                message.kind === "question"
                  ? props.setReplyTo(message.messageId)
                  : undefined
              }
            >
              <span>
                {message.kind} · {message.principal}
              </span>
              <p>{messageBody(message.body)}</p>
            </button>
          ))}
        </div>
        <label>
          <span>{props.replyTo ? "Reply" : "Guidance"}</span>
          <textarea
            value={props.messageText}
            onChange={(event) => props.setMessageText(event.target.value)}
          />
        </label>
        <div className={styles.inlineActions}>
          {props.replyTo ? (
            <button type="button" onClick={() => props.setReplyTo(null)}>
              Cancel reply
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!props.run || !props.messageText.trim()}
            onClick={() => {
              if (!props.run) return;
              void invoke("orchestration.message.post", {
                runId: props.run.runId,
                kind: props.replyTo ? "reply" : "guidance",
                body: { text: props.messageText.trim() },
                ...(props.replyTo ? { replyToMessageId: props.replyTo } : {})
              }).then(() => {
                props.setMessageText("");
                props.setReplyTo(null);
              });
            }}
          >
            Send
          </button>
        </div>
      </aside>
    </div>
  );
}

function RunNodeInspection(props: {
  run: WorkflowRun;
  nodeId: string;
  onInvoke: <M extends RendererOrchestrationMethod>(
    method: M,
    params: OrchestrationParams<M>
  ) => Promise<void>;
}): JSX.Element | null {
  const node = props.run.graph.nodes[props.nodeId];
  if (!node) return null;
  const attemptId = node.activeAttemptId ?? node.attemptIds.at(-1);
  const attempt = attemptId ? props.run.attempts[attemptId] : undefined;
  const dispatch = attempt?.dispatchId
    ? props.run.dispatches[attempt.dispatchId]
    : undefined;
  const result = attempt
    ? (props.run.attemptResults[attempt.attemptId] ??
      props.run.results[node.nodeId])
    : props.run.results[node.nodeId];
  const readiness = dispatch?.readinessReceiptId
    ? props.run.readinessReceipts[dispatch.readinessReceiptId]
    : undefined;
  const delivery = dispatch?.deliveryOperationId
    ? props.run.deliveries[dispatch.deliveryOperationId]
    : undefined;
  const artifacts = collectInspectionArtifacts(
    dispatch?.repositoryStateInput,
    result?.repositoryState,
    result?.artifacts,
    result?.transcriptRef
  );
  const execution = dispatch?.execution ?? result?.executionReceipt?.execution;
  return (
    <section className={styles.runInspection}>
      <header>
        <div>
          <span>Execution inspection</span>
          <strong>{node.definition.title}</strong>
        </div>
        {execution ? (
          <button
            type="button"
            onClick={() =>
              void window.kmux.dispatch({
                type: "surface.focus",
                surfaceId: execution.surfaceId
              })
            }
          >
            <Codicon name="terminal" /> Focus Surface
          </button>
        ) : null}
      </header>

      {attempt ? (
        <div className={styles.inspectionGrid}>
          <InspectionValue label="Attempt" value={attempt.attemptId} />
          <InspectionValue label="State" value={attempt.status} />
          <InspectionValue
            label="Graph / node revision"
            value={`${attempt.effectiveGraphRevision} / ${attempt.effectiveNodeStateRevision}`}
          />
          <InspectionValue
            label="Definition hash"
            value={attempt.effectiveDefinitionHash}
          />
        </div>
      ) : (
        <p className={styles.inspectionEmpty}>
          No execution attempt has started.
        </p>
      )}

      {node.admissionFailure ? (
        <div className={styles.inspectionIssue}>
          <strong>Admission failed · {node.admissionFailure.code}</strong>
          <span>{node.admissionFailure.message}</span>
        </div>
      ) : null}

      {attempt?.preparationIssue || attempt?.completionIssue ? (
        <div className={styles.inspectionIssue}>
          <strong>
            {attempt.completionIssue?.code ?? attempt.preparationIssue?.code}
          </strong>
          <span>
            {attempt.completionIssue?.message ??
              attempt.preparationIssue?.message}
          </span>
          {attempt.status === "waiting-input" && attempt.completionIssue ? (
            <button
              type="button"
              onClick={() =>
                void props.onInvoke("orchestration.message.post", {
                  runId: props.run.runId,
                  nodeId: node.nodeId,
                  attemptId: attempt.attemptId,
                  kind: "guidance",
                  body: {
                    text: "Repair the missing structured result now. Submit exactly one valid result for the current attempt before doing any more work."
                  }
                })
              }
            >
              Send result repair guidance
            </button>
          ) : null}
        </div>
      ) : null}

      {dispatch ? (
        <>
          <div className={styles.inspectionHeading}>Trusted Agent receipt</div>
          <div className={styles.inspectionGrid}>
            <InspectionValue
              label="Agent / dispatch"
              value={`${dispatch.selectedAgentId} · ${dispatch.dispatchId}`}
            />
            <InspectionValue
              label="Requested model / effort"
              value={launchDescription(dispatch.launchReceipt?.requested)}
            />
            <InspectionValue
              label="Effective model / effort"
              value={launchDescription(dispatch.launchReceipt?.effective)}
            />
            <InspectionValue
              label="Launch evidence"
              value={dispatch.launchReceipt?.evidence ?? "not recorded"}
            />
            <InspectionValue
              label="Agent instance"
              value={readiness?.agentInstanceId ?? "not ready"}
            />
            <InspectionValue
              label="Delivery"
              value={delivery?.state ?? "not prepared"}
            />
          </div>
        </>
      ) : null}

      {execution ? (
        <>
          <div className={styles.inspectionHeading}>Exact Surface identity</div>
          <div className={styles.inspectionGrid}>
            <InspectionValue label="Target" value={execution.targetId} />
            <InspectionValue label="Surface" value={execution.surfaceId} />
            <InspectionValue label="Session" value={execution.sessionId} />
            <InspectionValue
              label="Generation"
              value={executionGeneration(execution.generation)}
            />
            <InspectionValue
              label="Provider session"
              value={
                readiness?.verifiedProviderSessionId
                  ? `${readiness.verifiedProviderSessionId} · verified`
                  : execution.providerSessionClaim
                    ? `${execution.providerSessionClaim.id} · ${execution.providerSessionClaim.trust}`
                    : "not recorded"
              }
            />
            <InspectionValue
              label="Readiness"
              value={
                readiness
                  ? `${readiness.readyEpoch} · ${readiness.state}`
                  : "not recorded"
              }
            />
          </div>
        </>
      ) : null}

      <div className={styles.inspectionHeading}>Structured result</div>
      {result ? (
        <div className={styles.resultInspection}>
          <div>
            <strong>{result.outcome}</strong>
            {result.failureClass ? <span>{result.failureClass}</span> : null}
          </div>
          <p>{result.summary}</p>
          {result.data !== undefined ? <pre>{pretty(result.data)}</pre> : null}
          {result.filesModified?.length ? (
            <div className={styles.modifiedFiles}>
              {result.filesModified.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className={styles.inspectionEmpty}>No structured result recorded.</p>
      )}

      <RepositoryStateInspection
        label="Repository input"
        state={dispatch?.repositoryStateInput}
      />
      <RepositoryStateInspection
        label="Repository output"
        state={result?.repositoryState}
      />

      <div className={styles.inspectionHeading}>Artifacts and retention</div>
      {artifacts.length ? (
        <div className={styles.artifactList}>
          {artifacts.map(({ label, artifact }) => (
            <div key={`${label}:${artifact.artifactId}`}>
              <span>{label}</span>
              <strong>{artifact.kind}</strong>
              <code>{artifact.artifactId}</code>
              <small>
                {formatBytes(artifact.sizeBytes)} ·{" "}
                {artifactRetention(artifact)}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.inspectionEmpty}>
          No retained artifact or snapshot reference was recorded.
        </p>
      )}
    </section>
  );
}

function InspectionValue(props: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <span>{props.label}</span>
      <code title={props.value}>{props.value}</code>
    </div>
  );
}

function RepositoryStateInspection(props: {
  label: string;
  state?: RepositoryStateRef;
}): JSX.Element | null {
  if (!props.state) return null;
  return (
    <>
      <div className={styles.inspectionHeading}>{props.label}</div>
      <div className={styles.inspectionGrid}>
        <InspectionValue label="Repository" value={props.state.repositoryId} />
        <InspectionValue label="HEAD" value={props.state.headOid} />
        <InspectionValue label="Consistency" value={props.state.consistency} />
        <InspectionValue
          label="Worktree"
          value={props.state.worktreeRef?.worktreeId ?? "immutable snapshot"}
        />
        <InspectionValue label="Captured" value={props.state.capturedAt} />
        <InspectionValue
          label="Dirty state"
          value={
            props.state.dirtyPatch || props.state.untrackedManifest
              ? "captured"
              : "clean / none recorded"
          }
        />
      </div>
    </>
  );
}

function executionGeneration(
  generation: TerminalExecutionRef["generation"]
): string {
  return generation.kind === "local"
    ? `local · ${generation.runtimeEpoch}`
    : `remote · ${generation.keeperGeneration}`;
}

function collectInspectionArtifacts(
  repositoryInput?: RepositoryStateRef,
  repositoryOutput?: RepositoryStateRef,
  resultArtifacts: readonly ArtifactRef[] = [],
  transcript?: ArtifactRef
): Array<{ label: string; artifact: ArtifactRef }> {
  return [
    ...(repositoryInput?.dirtyPatch
      ? [{ label: "Input dirty patch", artifact: repositoryInput.dirtyPatch }]
      : []),
    ...(repositoryInput?.untrackedManifest
      ? [
          {
            label: "Input untracked manifest",
            artifact: repositoryInput.untrackedManifest
          }
        ]
      : []),
    ...(repositoryOutput?.dirtyPatch
      ? [
          {
            label: "Output dirty patch",
            artifact: repositoryOutput.dirtyPatch
          }
        ]
      : []),
    ...(repositoryOutput?.untrackedManifest
      ? [
          {
            label: "Output untracked manifest",
            artifact: repositoryOutput.untrackedManifest
          }
        ]
      : []),
    ...resultArtifacts.map((artifact) => ({ label: "Result", artifact })),
    ...(transcript ? [{ label: "Transcript", artifact: transcript }] : [])
  ];
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1_024).toFixed(1)} KiB`;
  return `${(sizeBytes / 1_048_576).toFixed(1)} MiB`;
}

function artifactRetention(artifact: ArtifactRef): string {
  return artifact.retentionUntil
    ? `retained until ${artifact.retentionUntil}`
    : "run-scoped retention";
}
import { isTerminalWorkflowRun } from "../workflowRunProjection";
