import {
  ConditionRow,
  type ConditionRowValueType
} from "@flowgram.ai/form-materials";
import { useScopeAvailable } from "@flowgram.ai/free-layout-editor";
import type {
  ConditionNodeDefinition,
  WorkflowCondition
} from "@kmux/orchestration";
import { sourceToFlowRef, variablePathToSource } from "../workflowVariables";
import { Codicon } from "./Codicon";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowConditionProperties(props: {
  node: ConditionNodeDefinition;
  readonly?: boolean;
  inline?: boolean;
  onChange: (node: ConditionNodeDefinition) => void;
}): JSX.Element {
  // Refresh the row props when variable declarations arrive after canvas initialization.
  useScopeAvailable();
  const conditions = props.node.config.conditions;
  const update = (next: readonly WorkflowCondition[]) =>
    props.onChange({
      ...props.node,
      config: {
        ...props.node.config,
        conditions: next,
        ports: [
          ...next.map((condition) => condition.key),
          props.node.config.ports.at(-1) ?? "else"
        ]
      }
    });
  if (!conditions)
    return (
      <div className={styles.conditionForm}>
        <label>
          <span>Saved expression</span>
          <textarea
            value={props.node.config.expression}
            readOnly={props.readonly}
            onChange={(event) =>
              props.onChange({
                ...props.node,
                config: { ...props.node.config, expression: event.target.value }
              })
            }
          />
        </label>
        {!props.readonly && (
          <button
            type="button"
            onClick={() =>
              update([
                {
                  key:
                    props.node.config.ports[0] === "else"
                      ? "if_1"
                      : props.node.config.ports[0]!,
                  left: { kind: "node-result", nodeId: "" },
                  operator: "eq",
                  right: { kind: "literal", value: 0 }
                }
              ])
            }
          >
            Use variable conditions
          </button>
        )}
        <p className={styles.fieldHint}>
          This workflow keeps its saved expression until you choose variable
          conditions.
        </p>
      </div>
    );
  return (
    <div className={styles.conditionForm}>
      {conditions.map((condition, index) => {
        const value: ConditionRowValueType = {
          left: sourceToFlowRef(condition.left),
          operator: condition.operator,
          right:
            condition.right?.kind === "literal"
              ? { type: "constant", content: condition.right.value }
              : condition.right
                ? sourceToFlowRef(condition.right)
                : undefined
        };
        return (
          <div className={styles.conditionBranch} key={condition.key}>
            <span className={styles.conditionBranchLabel}>
              {index === 0 ? "if" : "else if"}
              <b>*</b>
            </span>
            <ConditionRow
              value={value}
              readonly={props.readonly}
              onChange={(row) =>
                update(
                  conditions.map((entry, ordinal) =>
                    ordinal === index
                      ? {
                          ...entry,
                          left: variablePathToSource(row?.left?.content) ?? {
                            kind: "node-result",
                            nodeId: ""
                          },
                          operator:
                            row?.operator as WorkflowCondition["operator"],
                          right:
                            row?.right?.type === "constant"
                              ? { kind: "literal", value: row.right.content }
                              : row?.right?.type === "ref"
                                ? variablePathToSource(row.right.content)
                                : undefined
                        }
                      : entry
                  )
                )
              }
              style={{ flex: 1, minWidth: 0 }}
            />
            {!props.readonly && conditions.length > 1 && (
              <button
                type="button"
                aria-label="Remove condition"
                className={styles.conditionRemove}
                onClick={() =>
                  update(conditions.filter((_, ordinal) => ordinal !== index))
                }
              >
                <Codicon name="close" />
              </button>
            )}
            {props.inline && (
              <span
                data-port-id={condition.key}
                data-port-type="output"
                className={styles.conditionPort}
              />
            )}
          </div>
        );
      })}
      <div className={styles.conditionBranch}>
        <span className={styles.conditionBranchLabel}>else</span>
        {props.inline && (
          <span
            data-port-id={props.node.config.ports.at(-1)}
            data-port-type="output"
            className={styles.conditionPort}
          />
        )}
      </div>
      {!props.readonly && conditions.length < 31 && (
        <button
          className={styles.conditionAdd}
          type="button"
          onClick={() =>
            update([
              ...conditions,
              {
                key: `if_${crypto.randomUUID().slice(0, 8)}`,
                left: { kind: "node-result", nodeId: "" },
                operator: "eq",
                right: { kind: "literal", value: 0 }
              }
            ])
          }
        >
          <Codicon name="add" /> Add
        </button>
      )}
    </div>
  );
}
