import type { DataSource, FlowEditorDocumentV1 } from "@kmux/orchestration";
import {
  WorkflowJsonField,
  useWorkflowJsonDraftContext
} from "./WorkflowJsonField";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowDataSource(props: {
  value: DataSource;
  path: readonly (string | number)[];
  document: FlowEditorDocumentV1;
  nodeId: string;
  onChange: (source: DataSource) => void;
}): JSX.Element {
  const source = props.value;
  const drafts = useWorkflowJsonDraftContext();
  const nodes = props.document.nodes.filter(
    (entry) => entry.id !== props.nodeId
  );
  const loops = props.document.nodes.filter(
    (entry) => entry.definition.kind === "loop"
  );
  const nodeOptions = nodes.map((entry) => ({
    id: entry.id,
    title: entry.definition.title
  }));
  const inputOptions = props.document.workflow.inputs.map((input) => ({
    id: input.id,
    title: input.id
  }));
  const pathSource =
    source.kind === "node-result" ||
    source.kind === "node-outcome" ||
    source.kind === "loop-item" ||
    source.kind === "run-input" ||
    source.kind === "loop-carry"
      ? source
      : undefined;
  return (
    <>
      <label>
        <span>Source</span>
        <select
          aria-label="Source"
          value={source.kind}
          onChange={(event) => {
            const kind = event.target.value as DataSource["kind"];
            const next: DataSource =
              kind === "literal"
                ? { kind, value: null }
                : kind === "run-input"
                  ? { kind, inputId: "" }
                  : kind === "loop-index"
                    ? { kind, loopNodeId: "" }
                    : kind === "loop-carry"
                      ? { kind, loopNodeId: "", inputId: "" }
                      : kind === "loop-item"
                        ? { kind, loopNodeId: "", path: [] }
                        : { kind, nodeId: "" };
            drafts.clear(props.path);
            props.onChange(next);
          }}
        >
          <option value="run-input">Run input</option>
          <option value="node-result">Node result</option>
          <option value="node-outcome">Settled node outcome</option>
          <option value="repository-state">Repository state</option>
          <option value="loop-item">Current Loop item</option>
          <option value="loop-index">Current Loop index</option>
          <option value="loop-carry">Loop carried value</option>
          <option value="literal">Literal JSON value</option>
        </select>
      </label>
      {source.kind === "run-input" ? (
        <SourceSelect
          label="Run input"
          value={source.inputId}
          options={inputOptions}
          onChange={(inputId) => props.onChange({ ...source, inputId })}
        />
      ) : null}
      {"nodeId" in source ? (
        <SourceSelect
          label="Source node"
          value={source.nodeId}
          options={nodeOptions}
          onChange={(nodeId) => props.onChange({ ...source, nodeId })}
        />
      ) : null}
      {"loopNodeId" in source ? (
        <SourceSelect
          label="Owning Loop"
          value={source.loopNodeId}
          options={loops.map((entry) => ({
            id: entry.id,
            title: entry.definition.title
          }))}
          onChange={(loopNodeId) => props.onChange({ ...source, loopNodeId })}
        />
      ) : null}
      {source.kind === "loop-carry" ? (
        <label>
          <span>Carried input name</span>
          <input
            value={source.inputId}
            onChange={(event) =>
              props.onChange({ ...source, inputId: event.target.value })
            }
          />
        </label>
      ) : null}
      {pathSource ? (
        <div className={styles.dataPath}>
          <span className={styles.sectionLabel}>Result path</span>
          {(pathSource.path ?? []).map((segment, index) => (
            <div className={styles.inlineActions} key={index}>
              <input
                aria-label={`Path segment ${index + 1}`}
                value={segment}
                onChange={(event) =>
                  props.onChange({
                    ...pathSource,
                    path: pathSource.path!.map((value, ordinal) =>
                      ordinal === index ? event.target.value : value
                    )
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove path segment ${index + 1}`}
                onClick={() =>
                  props.onChange({
                    ...pathSource,
                    path: pathSource.path!.filter(
                      (_, ordinal) => ordinal !== index
                    )
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <div className={styles.inlineActions}>
            <button
              type="button"
              onClick={() =>
                props.onChange({
                  ...pathSource,
                  path: [...(pathSource.path ?? []), ""]
                })
              }
            >
              Add path segment
            </button>
          </div>
          <p className={styles.fieldHint}>
            No segments selects the whole value. Each segment is one exact key
            or array index; dots in keys are preserved.
          </p>
        </div>
      ) : null}
      {source.kind === "literal" ? (
        <WorkflowJsonField
          path={[...props.path, "value"]}
          label="Literal JSON"
          value={source.value}
          onChange={(value) => props.onChange({ ...source, value: value! })}
        />
      ) : null}
    </>
  );
}

function SourceSelect(props: {
  label: string;
  value: string;
  options: readonly { id: string; title: string }[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      <span>{props.label}</span>
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">Select a source</option>
        {props.value &&
        !props.options.some((option) => option.id === props.value) ? (
          <option value={props.value}>
            {props.value} · unresolved reference
          </option>
        ) : null}
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title} · {option.id}
          </option>
        ))}
      </select>
    </label>
  );
}
