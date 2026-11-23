import { useEffect, useState } from "react";
import type { AgentModelOptionDto } from "@kmux/proto";
import type { AgentLaunchPreferences } from "@kmux/orchestration";
import { resolveWorkflowAgentLaunchPreferences } from "@kmux/orchestration/editor";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowAgentLaunchFields(props: {
  agentId: string | null;
  capable: boolean;
  value: AgentLaunchPreferences;
  inherited?: AgentLaunchPreferences;
  readonly: boolean;
  modelLabel: string;
  effortLabel: string;
  onChange: (value: AgentLaunchPreferences | undefined) => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<{
    agentId: string | null;
    models: AgentModelOptionDto[];
    error?: string;
  }>({ agentId: null, models: [] });
  const [revision, setRevision] = useState(0);
  const agentId = props.capable && !props.readonly ? props.agentId : null;
  useEffect(() => {
    if (!agentId) return;
    let active = true;
    window.kmux
      .getAgentModelOptions(agentId)
      .then((models) => {
        if (active) setCatalog({ agentId, models });
      })
      .catch(() => {
        if (active)
          setCatalog({
            agentId,
            models: [],
            error: "Could not load models. Check the Agent CLI and sign-in."
          });
      });
    return () => {
      active = false;
    };
  }, [agentId, revision]);
  const loading = agentId !== null && catalog.agentId !== agentId;
  const models = catalog.agentId === agentId ? catalog.models : [];
  const error = catalog.agentId === agentId ? catalog.error : undefined;
  const resolvedLaunch = resolveWorkflowAgentLaunchPreferences(
    props.inherited,
    props.value
  );
  const modelId = resolvedLaunch.model;
  const model = models.find(
    (candidate) =>
      candidate.id === modelId ||
      candidate.variants?.some((variant) => variant.model === modelId)
  );
  const variantEffort = model?.variants?.find(
    (variant) => variant.model === modelId
  )?.effort;
  const effort = resolvedLaunch.effort ?? variantEffort;
  const disabled = props.readonly || !agentId || loading || Boolean(error);
  const effortValue =
    props.value.effort ??
    (model?.effortRequired ? effort : variantEffort) ??
    "";
  const changeModel = (id: string) => {
    if (!id) {
      props.onChange(undefined);
      return;
    }
    const selected = models.find((candidate) => candidate.id === id)!;
    const nextEffort =
      effort && selected.efforts.includes(effort)
        ? effort
        : selected.effortRequired
          ? selected.defaultEffort
          : undefined;
    props.onChange({
      model: id,
      ...(nextEffort ? { effort: nextEffort } : {})
    });
  };
  return (
    <>
      <label>
        <span>Model</span>
        <select
          aria-label={props.modelLabel}
          value={props.value.model ? (model?.id ?? props.value.model) : ""}
          disabled={disabled || models.length === 0}
          onChange={(event) => changeModel(event.target.value)}
        >
          <option value="">
            {loading
              ? "Loading models…"
              : props.inherited?.model
                ? `Inherit ${props.inherited.model}`
                : "Agent default"}
          </option>
          {props.value.model && !model ? (
            <option value={props.value.model}>
              {props.value.model} · saved
            </option>
          ) : null}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
            </option>
          ))}
        </select>
        {error ? (
          <span className={styles.fieldHint} role="alert">
            {error}{" "}
            <button
              type="button"
              disabled={props.readonly}
              onClick={() => {
                setCatalog({ agentId: null, models: [] });
                setRevision((value) => value + 1);
              }}
            >
              Retry
            </button>
          </span>
        ) : null}
        {!agentId && !props.readonly ? (
          <span className={styles.fieldHint}>
            Select an Agent to choose its model.
          </span>
        ) : !props.readonly && !loading && !error && models.length === 0 ? (
          <span className={styles.fieldHint}>
            The CLI did not provide a model list. Existing settings are
            preserved.
          </span>
        ) : null}
      </label>
      <label>
        <span>Thinking level</span>
        <select
          aria-label={props.effortLabel}
          value={effortValue}
          disabled={disabled || !model || model.efforts.length === 0}
          onChange={(event) =>
            props.onChange({
              model: model?.id ?? modelId,
              ...(event.target.value ? { effort: event.target.value } : {})
            })
          }
        >
          {!model?.effortRequired ? (
            <option value="">
              {resolvedLaunch.effort && !props.value.effort
                ? `Inherit ${resolvedLaunch.effort}`
                : "Model default"}
            </option>
          ) : effortValue === "" ? (
            <option value="">Choose a level</option>
          ) : null}
          {effortValue && !model?.efforts.includes(effortValue) ? (
            <option value={effortValue}>{effortValue} · saved</option>
          ) : null}
          {model?.efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {model && model.efforts.length === 0 ? (
          <span className={styles.fieldHint}>
            This model manages thinking automatically.
          </span>
        ) : null}
      </label>
    </>
  );
}
