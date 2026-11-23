import type {
  FlowEditorDocumentV1,
  InputMapping,
  JsonSchemaRef,
  JsonValue,
  WorkflowInputDefinition,
  WorkflowNodeDefinition,
  WorkflowOutputDefinition
} from "@kmux/orchestration";
import { WorkflowDataSource } from "./WorkflowDataSource";
import {
  WorkflowJsonField,
  requireJsonObject,
  useWorkflowJsonDraftContext
} from "./WorkflowJsonField";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowSchemaField(props: {
  value?: JsonSchemaRef;
  path: readonly (string | number)[];
  onChange: (schema: JsonSchemaRef | undefined) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const schema = props.value?.schema;
  const simple =
    schema &&
    Object.keys(schema).length === 1 &&
    typeof schema.type === "string"
      ? schema.type
      : undefined;
  const types = [
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null"
  ];
  const selected =
    props.value?.ref !== undefined
      ? "reference"
      : simple && types.includes(simple)
        ? simple
        : schema
          ? "custom"
          : "any";
  return (
    <>
      <label>
        <span>Value type</span>
        <select
          aria-label="Value type"
          value={selected}
          onChange={(event) => {
            drafts.clear(props.path);
            props.onChange(
              event.target.value === "any"
                ? undefined
                : event.target.value === "reference"
                  ? { ref: "" }
                  : {
                      schema:
                        event.target.value === "custom"
                          ? {}
                          : { type: event.target.value }
                    }
            );
          }}
        >
          <option value="any">Any JSON value</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
          <option value="custom">Custom JSON Schema</option>
          <option value="reference">Schema reference</option>
        </select>
      </label>
      {schema !== undefined ? (
        <WorkflowJsonField
          label="JSON Schema"
          path={props.path}
          value={schema as JsonValue}
          validate={requireJsonObject}
          onChange={(value) =>
            props.onChange({
              schema: value as NonNullable<JsonSchemaRef["schema"]>
            })
          }
        />
      ) : null}
      {selected === "reference" ? (
        <label>
          <span>Schema reference</span>
          <input
            value={props.value?.ref ?? ""}
            onChange={(event) =>
              props.onChange({ ...props.value, ref: event.target.value })
            }
          />
        </label>
      ) : null}
    </>
  );
}

export function WorkflowInputProperties(props: {
  document: FlowEditorDocumentV1;
  nodeId: string;
  onChange: (document: FlowEditorDocumentV1) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const inputs = props.document.workflow.inputs;
  const path = ["nodes", props.nodeId, "inputs"] as const;
  const update = (next: readonly WorkflowInputDefinition[]) =>
    props.onChange({
      ...props.document,
      workflow: { ...props.document.workflow, inputs: next }
    });
  return (
    <>
      <div className={styles.sectionLabel}>Workflow inputs</div>
      {inputs.map((input, index) => {
        const patch = (value: Partial<WorkflowInputDefinition>) =>
          update(
            inputs.map((entry, ordinal) =>
              ordinal === index ? { ...input, ...value } : entry
            )
          );
        return (
          <fieldset className={styles.argumentRow} key={index}>
            <legend>Run input {index + 1}</legend>
            <label>
              <span>Input ID</span>
              <input
                value={input.id}
                onChange={(event) => patch({ id: event.target.value })}
              />
            </label>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={input.required}
                onChange={(event) => patch({ required: event.target.checked })}
              />
              <span>Required input</span>
            </label>
            <WorkflowSchemaField
              value={input.schema}
              path={[...path, index, "schema"]}
              onChange={(schema) => patch({ schema })}
            />
            <WorkflowJsonField
              label="Default JSON (optional)"
              path={[...path, index, "default"]}
              value={input.default}
              optional
              onChange={(value) => patch({ default: value })}
            />
            <div className={styles.inlineActions}>
              <button
                type="button"
                onClick={() => {
                  drafts.removeItem(path, index);
                  update(inputs.filter((_, ordinal) => ordinal !== index));
                }}
              >
                Remove input
              </button>
            </div>
          </fieldset>
        );
      })}
      <div className={styles.inlineActions}>
        <button
          type="button"
          onClick={() =>
            update([
              ...inputs,
              {
                id: uniqueId(
                  inputs.map((input) => input.id),
                  "input"
                ),
                required: true,
                schema: { schema: { type: "string" } }
              }
            ])
          }
        >
          Add Run input
        </button>
      </div>
      <p className={styles.fieldHint}>
        IDs are referenced by mappings and Agent roles. Rename or remove them
        only with corresponding reference changes; Validate identifies
        unresolved references.
      </p>
    </>
  );
}

export function WorkflowMappingFields(props: {
  mapping: InputMapping;
  path: readonly (string | number)[];
  document: FlowEditorDocumentV1;
  nodeId: string;
  onChange: (mapping: InputMapping) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const mapping = props.mapping;
  return (
    <>
      <label>
        <span>Node input name</span>
        <input
          value={mapping.target}
          onChange={(event) =>
            props.onChange({ ...mapping, target: event.target.value })
          }
        />
      </label>
      <WorkflowDataSource
        value={mapping.source}
        path={[...props.path, "source"]}
        document={props.document}
        nodeId={props.nodeId}
        onChange={(source) => props.onChange({ ...mapping, source })}
      />
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={mapping.required}
          onChange={(event) =>
            props.onChange({ ...mapping, required: event.target.checked })
          }
        />
        <span>Required dependency</span>
      </label>
      <label>
        <span>When source is missing</span>
        <select
          aria-label="When source is missing"
          value={mapping.missing}
          onChange={(event) => {
            const missing = event.target.value as InputMapping["missing"];
            drafts.clear([...props.path, "default"]);
            props.onChange({
              ...mapping,
              missing,
              default:
                missing === "use-default"
                  ? (mapping.default ?? null)
                  : undefined
            });
          }}
        >
          <option value="fail">Fail preparation</option>
          <option value="use-default">Use default value</option>
          <option value="omit">Omit this input</option>
        </select>
      </label>
      {mapping.missing === "use-default" ? (
        <WorkflowJsonField
          label="Fallback JSON"
          path={[...props.path, "default"]}
          value={mapping.default}
          onChange={(value) => props.onChange({ ...mapping, default: value })}
        />
      ) : null}
    </>
  );
}

export function WorkflowNodeMappings(props: {
  node: WorkflowNodeDefinition;
  document: FlowEditorDocumentV1;
  onChange: (node: WorkflowNodeDefinition) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const mappings = props.node.inputMappings ?? [];
  const path = ["nodes", props.node.id, "mappings"] as const;
  const update = (inputMappings: readonly InputMapping[]) =>
    props.onChange({ ...props.node, inputMappings });
  return (
    <>
      <div className={styles.sectionLabel}>Input mappings</div>
      {mappings.map((mapping, index) => (
        <fieldset className={styles.argumentRow} key={index}>
          <legend>Mapping {index + 1}</legend>
          <WorkflowMappingFields
            mapping={mapping}
            path={[...path, index]}
            document={props.document}
            nodeId={props.node.id}
            onChange={(next) =>
              update(
                mappings.map((entry, ordinal) =>
                  ordinal === index ? next : entry
                )
              )
            }
          />
          <div className={styles.inlineActions}>
            <button
              type="button"
              onClick={() => {
                drafts.removeItem(path, index);
                update(mappings.filter((_, ordinal) => ordinal !== index));
              }}
            >
              Remove mapping
            </button>
          </div>
        </fieldset>
      ))}
      <div className={styles.inlineActions}>
        <button
          type="button"
          onClick={() =>
            update([
              ...mappings,
              {
                target: uniqueId(
                  mappings.map((mapping) => mapping.target),
                  "input"
                ),
                source: { kind: "run-input", inputId: "" },
                required: true,
                missing: "fail"
              }
            ])
          }
        >
          Add input mapping
        </button>
      </div>
      <p className={styles.fieldHint}>
        Required mappings wait for their source to settle. Shell arguments and
        prompt inputs refer to the node input name.
      </p>
    </>
  );
}

export function WorkflowOutputProperties(props: {
  document: FlowEditorDocumentV1;
  nodeId: string;
  onChange: (document: FlowEditorDocumentV1) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const outputs = props.document.workflow.outputs;
  const path = ["nodes", props.nodeId, "outputs"] as const;
  const update = (next: readonly WorkflowOutputDefinition[]) =>
    props.onChange({
      ...props.document,
      workflow: { ...props.document.workflow, outputs: next }
    });
  return (
    <>
      <div className={styles.sectionLabel}>Workflow outputs</div>
      {outputs.map((output, index) => {
        const patch = (next: Partial<WorkflowOutputDefinition>) =>
          update(
            outputs.map((entry, ordinal) =>
              ordinal === index ? { ...output, ...next } : entry
            )
          );
        return (
          <fieldset className={styles.argumentRow} key={index}>
            <legend>Run output {index + 1}</legend>
            <label>
              <span>Output ID</span>
              <input
                value={output.id}
                onChange={(event) => patch({ id: event.target.value })}
              />
            </label>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={output.required}
                onChange={(event) => patch({ required: event.target.checked })}
              />
              <span>Required output</span>
            </label>
            <WorkflowDataSource
              value={output.source}
              path={[...path, index, "source"]}
              document={props.document}
              nodeId={props.nodeId}
              onChange={(source) => patch({ source })}
            />
            <WorkflowSchemaField
              value={output.schema}
              path={[...path, index, "schema"]}
              onChange={(schema) => patch({ schema })}
            />
            <div className={styles.inlineActions}>
              <button
                type="button"
                onClick={() => {
                  drafts.removeItem(path, index);
                  update(outputs.filter((_, ordinal) => ordinal !== index));
                }}
              >
                Remove output
              </button>
            </div>
          </fieldset>
        );
      })}
      <div className={styles.inlineActions}>
        <button
          type="button"
          onClick={() =>
            update([
              ...outputs,
              {
                id: uniqueId(
                  outputs.map((output) => output.id),
                  "output"
                ),
                required: true,
                source: { kind: "node-result", nodeId: "" }
              }
            ])
          }
        >
          Add Run output
        </button>
      </div>
    </>
  );
}

function uniqueId(existing: readonly string[], prefix: string): string {
  let ordinal = 1;
  while (existing.includes(`${prefix}-${ordinal}`)) ordinal += 1;
  return `${prefix}-${ordinal}`;
}
