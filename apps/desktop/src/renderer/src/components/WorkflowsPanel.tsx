import { useWorkflowRun } from "../hooks/useWorkflowRun";
import { orchestration } from "../orchestrationClient";
import type {
  WorkflowVersion,
  OrchestrationRunSummary
} from "@kmux/orchestration";
import { workflowRequiresCaller } from "@kmux/orchestration/editor";
import type { AgentDescriptorDto } from "@kmux/proto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Codicon } from "./Codicon";
import styles from "../styles/WorkflowsPanel.module.css";
import {
  type Catalog,
  type WorkflowTemplate,
  errorMessage,
  isRecord,
  rendererId
} from "./workflowUi";
import { RunWorkspace } from "./WorkflowRunWorkspace";
import { WorkflowStudio } from "./WorkflowStudio";

export type WorkflowRunRequest = {
  requestId: string;
  workflowVersionId: string;
};

export function WorkflowsPanel({
  runRequest,
  onRunRequestConsumed
}: {
  runRequest?: WorkflowRunRequest | null;
  onRunRequestConsumed?: () => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog>({ drafts: [], versions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<readonly WorkflowTemplate[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<{
    draftId: string;
    definitionId: string;
    existing: boolean;
    initiallyEditing: boolean;
    templateId?: string;
  } | null>(null);
  const [agentDescriptors, setAgentDescriptors] = useState<
    AgentDescriptorDto[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [decisionRuns, setDecisionRuns] = useState<
    readonly OrchestrationRunSummary[]
  >([]);
  const {
    run: selectedRun,
    refresh: refreshRun,
    error: runError
  } = useWorkflowRun(selectedRunId);
  const [runVersion, setRunVersion] = useState<WorkflowVersion | null>(null);
  const [runInputs, setRunInputs] = useState("{}");
  const [runLaunchError, setRunLaunchError] = useState<string | null>(null);
  const consumeRunRequest = useRef(onRunRequestConsumed);
  consumeRunRequest.current = onRunRequestConsumed;
  const [messageText, setMessageText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  useEffect(() => {
    if (!runRequest) return;
    let current = true;
    void orchestration("workflow.version.get", {
      workflowVersionId: runRequest.workflowVersionId
    })
      .then((version) => {
        if (!current) return;
        setRunVersion(version);
        setSelectedRunId(null);
        setRunInputs("{}");
        setRunLaunchError(null);
        setError(null);
        consumeRunRequest.current?.();
      })
      .catch((cause) => {
        if (!current) return;
        setError(errorMessage(cause));
        consumeRunRequest.current?.();
      });
    return () => {
      current = false;
    };
  }, [runRequest]);

  const refresh = useCallback(async () => {
    try {
      const [nextCatalog, nextAgentDescriptors, nextTemplates] =
        await Promise.all([
          orchestration("workflow.list"),
          window.kmux.getAgentCatalog(),
          orchestration("workflow.template.list")
        ]);
      setCatalog(nextCatalog);
      setAgentDescriptors(nextAgentDescriptors);
      setTemplates(nextTemplates);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Native decision Tasks use the same inspector as saved Workflows. Keep an
  // entry visible while the panel is open, including Gates created later.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const runs = await orchestration("orchestration.run.list");
        if (active)
          setDecisionRuns(
            runs.filter((run) =>
              Object.values(run.nodeStates).includes("waiting-gate")
            )
          );
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const startPublishedRun = async () => {
    if (!runVersion || busy) return;
    setBusy(true);
    setRunLaunchError(null);
    try {
      if (workflowRequiresCaller(runVersion.definition))
        throw new Error(
          "This Workflow requires a calling Agent. Run it from an existing Agent conversation using kmux-orchestration."
        );
      const inputs: unknown = JSON.parse(runInputs);
      if (!isRecord(inputs))
        throw new Error("Run inputs must be a JSON object");
      const summary = await orchestration("workflow.run", {
        workflowVersionId: runVersion.workflowVersionId,
        runId: rendererId("run"),
        inputs
      });
      setSelectedRunId(summary.runId);
      setError(null);
    } catch (cause) {
      setRunLaunchError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const openNewWorkflow = (templateId?: string) => {
    setTemplatePickerOpen(false);
    setSelectedWorkflow({
      draftId: rendererId("workflow-draft"),
      definitionId: rendererId("workflow-definition"),
      existing: false,
      initiallyEditing: true,
      ...(templateId ? { templateId } : {})
    });
  };

  return (
    <div className={styles.panel}>
      <section className={styles.panelIntro}>
        <div>
          <h3>Workflows</h3>
          <p>Create and run reusable workflows.</p>
        </div>
        <button className={styles.iconButton} onClick={() => void refresh()}>
          <Codicon name="refresh" />
        </button>
      </section>

      {decisionRuns.length > 0 ? (
        <section aria-label="Runs awaiting a decision">
          <h3>Waiting for your decision</h3>
          <div className={styles.catalogList}>
            {decisionRuns.map((run) => (
              <button
                type="button"
                className={styles.workflowCard}
                key={run.runId}
                onClick={() => {
                  setRunVersion(null);
                  setSelectedRunId(run.runId);
                  setRunLaunchError(null);
                }}
              >
                <Codicon name="lock" />
                <span className={styles.workflowCopy}>
                  <strong>
                    {run.source.kind === "ad-hoc"
                      ? run.source.objective
                      : (catalog.versions.find(
                          (version) =>
                            run.source.kind === "workflow-version" &&
                            version.workflowVersionId ===
                              run.source.workflowVersionId
                        )?.name ?? "Workflow decision")}
                  </strong>
                </span>
                <Codicon name="chevron-right" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <>
        <div className={styles.createRow}>
          <button
            type="button"
            disabled={busy}
            onClick={() => openNewWorkflow()}
          >
            <Codicon name="add" /> New workflow
          </button>
          <button
            type="button"
            disabled={busy || templates.length === 0}
            aria-expanded={templatePickerOpen}
            onClick={() => setTemplatePickerOpen((open) => !open)}
          >
            <Codicon name="type-hierarchy-sub" /> Templates
          </button>
        </div>

        {templatePickerOpen ? (
          <div className={styles.catalogList} aria-label="Workflow templates">
            {templates.map((template) => (
              <button
                type="button"
                className={styles.workflowCard}
                key={template.templateId}
                disabled={busy}
                onClick={() => openNewWorkflow(template.templateId)}
              >
                <span className={styles.workflowGlyph}>
                  <Codicon name="type-hierarchy-sub" />
                </span>
                <span className={styles.workflowCopy}>
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </span>
                <Codicon name="add" />
              </button>
            ))}
          </div>
        ) : null}

        {loading ? (
          <div className={styles.emptyState}>Loading workflows…</div>
        ) : null}

        {!loading && catalog.drafts.length === 0 ? (
          <div className={styles.emptyState}>
            <Codicon name="type-hierarchy-sub" />
            <strong>No workflow drafts</strong>
            <span>Create one to open the visual Studio.</span>
          </div>
        ) : (
          <div className={styles.catalogList}>
            {catalog.drafts.map((draft) => {
              return (
                <button
                  type="button"
                  className={styles.workflowCard}
                  key={draft.draftId}
                  onClick={() =>
                    setSelectedWorkflow({
                      draftId: draft.draftId,
                      definitionId: draft.definitionId,
                      existing: true,
                      initiallyEditing: false
                    })
                  }
                >
                  <span className={styles.workflowGlyph}>
                    <Codicon name="type-hierarchy-sub" />
                  </span>
                  <span className={styles.workflowCopy}>
                    <strong>{draft.name ?? "Invalid draft"}</strong>
                    <span>Saved workflow</span>
                  </span>
                  <Codicon name="chevron-right" />
                </button>
              );
            })}
          </div>
        )}
      </>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      {selectedRunId || runVersion ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section
            className={styles.studio}
            role="dialog"
            aria-modal="true"
            aria-label="Orchestration Run"
          >
            <header className={styles.studioHeader} data-run-inspector>
              <div className={styles.studioIdentity}>
                <strong>
                  {runVersion
                    ? `${runVersion.definition.name} · v${runVersion.definition.version}`
                    : selectedRun?.source.kind === "ad-hoc"
                      ? selectedRun.source.objective
                      : "Agent Run"}
                </strong>
              </div>
              <button
                className={styles.closeButton}
                aria-label="Close Run"
                onClick={() => {
                  setSelectedRunId(null);
                  setRunVersion(null);
                }}
              >
                <Codicon name="close" />
              </button>
            </header>
            {runLaunchError || error || runError ? (
              <div className={styles.studioError} role="alert">
                {runLaunchError ?? error ?? runError}
              </div>
            ) : null}
            <RunWorkspace
              run={selectedRun}
              runInputs={runInputs}
              setRunInputs={setRunInputs}
              definition={runVersion?.definition}
              agentDescriptors={agentDescriptors}
              canRun={
                Boolean(runVersion) &&
                !busy &&
                (!selectedRunId || Boolean(selectedRun))
              }
              onRun={() => void startPublishedRun()}
              inspectionOnly={!runVersion}
              messageText={messageText}
              setMessageText={setMessageText}
              replyTo={replyTo}
              setReplyTo={setReplyTo}
              onRefresh={refreshRun}
            />
          </section>
        </div>
      ) : null}

      <div hidden={Boolean(selectedRunId || runVersion)}>
        {selectedWorkflow ? (
          <WorkflowStudio
            key={selectedWorkflow.draftId}
            draftId={selectedWorkflow.draftId}
            definitionId={selectedWorkflow.definitionId}
            existing={selectedWorkflow.existing}
            templateId={selectedWorkflow.templateId}
            initiallyEditing={selectedWorkflow.initiallyEditing}
            catalog={catalog}
            agentDescriptors={agentDescriptors}
            onClose={() => setSelectedWorkflow(null)}
            onCatalogChanged={refresh}
          />
        ) : null}
      </div>
    </div>
  );
}
