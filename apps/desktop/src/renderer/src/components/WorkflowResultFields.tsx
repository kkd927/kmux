import {
  JsonSchemaEditor,
  type IJsonSchema
} from "@flowgram.ai/form-materials";
import type { JsonValue, WorkflowNodeDefinition } from "@kmux/orchestration";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowResultFields(props: {
  node: WorkflowNodeDefinition;
  readonly?: boolean;
  onChange: (node: WorkflowNodeDefinition) => void;
}): JSX.Element {
  return (
    <details
      className={styles.workflowResultFields}
      open={Boolean(props.node.resultSchema)}
    >
      <summary>Outputs</summary>
      {props.node.resultSchema?.ref ? (
        <p className={styles.fieldHint}>
          Saved schema: {props.node.resultSchema.ref}
        </p>
      ) : (
        <JsonSchemaEditor
          readonly={props.readonly}
          value={
            (props.node.resultSchema?.schema as IJsonSchema) ?? {
              type: "object",
              properties: {}
            }
          }
          config={{ addButtonText: "Add output", placeholder: "Field name" }}
          onChange={(schema) =>
            props.onChange({
              ...props.node,
              resultSchema: Object.keys(schema.properties ?? {}).length
                ? { schema: schema as Record<string, JsonValue> }
                : undefined
            })
          }
        />
      )}
      <p className={styles.fieldHint}>
        Declare the fields returned by this task to use them in Conditions and
        Loops.
      </p>
    </details>
  );
}
