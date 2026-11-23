import type {
  FlowEditorDocumentV1,
  LoopNodeDefinition
} from "@kmux/orchestration";
import { WorkflowVariableField } from "./WorkflowVariableField";
import { Codicon } from "./Codicon";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowLoopOutputs(props: {
  node: LoopNodeDefinition;
  document: FlowEditorDocumentV1;
  readonly?: boolean;
  onChange: (node: LoopNodeDefinition) => void;
}): JSX.Element {
  const outputs = props.node.config.loopOutputs ?? [];
  const update = (loopOutputs: typeof outputs) =>
    props.onChange({
      ...props.node,
      config: { ...props.node.config, loopOutputs }
    });
  return (
    <div className={styles.loopOutputForm}>
      <span className={styles.sectionLabel}>Loop outputs</span>
      {outputs.map((output, index) => (
        <div className={styles.loopOutputRow} key={index}>
          <input
            aria-label={`Loop output ${index + 1} name`}
            value={output.name}
            readOnly={props.readonly}
            onChange={(event) =>
              update(
                outputs.map((entry, ordinal) =>
                  ordinal === index
                    ? { ...entry, name: event.target.value }
                    : entry
                )
              )
            }
            placeholder="Name"
          />
          <WorkflowVariableField
            value={output.source}
            readonly={props.readonly}
            onChange={(source) =>
              update(
                outputs.map((entry, ordinal) =>
                  ordinal === index ? { ...entry, source } : entry
                )
              )
            }
          />
          <select
            aria-label={`Loop output ${index + 1} collection`}
            disabled={props.readonly}
            value={output.mode}
            onChange={(event) =>
              update(
                outputs.map((entry, ordinal) =>
                  ordinal === index
                    ? {
                        ...entry,
                        mode: event.target.value as "last" | "collect"
                      }
                    : entry
                )
              )
            }
          >
            <option value="last">Latest</option>
            <option value="collect">All iterations</option>
          </select>
          {!props.readonly && (
            <button
              type="button"
              aria-label={`Remove Loop output ${index + 1}`}
              onClick={() =>
                update(outputs.filter((_, ordinal) => ordinal !== index))
              }
            >
              <Codicon name="trash" />
            </button>
          )}
        </div>
      ))}
      {!props.readonly && (
        <button
          type="button"
          onClick={() => {
            let index = 1;
            while (outputs.some((output) => output.name === `result${index}`))
              index++;
            update([
              ...outputs,
              {
                name: `result${index}`,
                source: { kind: "node-result", nodeId: "" },
                mode: props.node.config.mode === "for-each" ? "collect" : "last"
              }
            ]);
          }}
        >
          <Codicon name="add" /> Add output
        </button>
      )}
    </div>
  );
}
