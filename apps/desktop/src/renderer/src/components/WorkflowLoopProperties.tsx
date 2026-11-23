import type {
  FlowEditorDocumentV1,
  LoopNodeDefinition
} from "@kmux/orchestration";
import { WorkflowDataSource } from "./WorkflowDataSource";
import { useWorkflowJsonDraftContext } from "./WorkflowJsonField";
import { WorkflowVariableField } from "./WorkflowVariableField";
import { WorkflowLoopOutputs } from "./WorkflowLoopOutputs";
import styles from "../styles/WorkflowsPanel.module.css";

export function WorkflowLoopProperties(props: {
  node: LoopNodeDefinition;
  document: FlowEditorDocumentV1;
  onChange: (node: LoopNodeDefinition) => void;
}): JSX.Element {
  const { node, document } = props;
  const config = node.config;
  const drafts = useWorkflowJsonDraftContext();
  const path = ["nodes", node.id, "config"] as const;
  const update = (next: LoopNodeDefinition["config"]) =>
    props.onChange({ ...node, config: next });
  return (
    <>
      <label>
        <span>Loop mode</span>
        <select
          aria-label="Loop mode"
          value={config.mode}
          onChange={(event) => {
            const mode = event.target
              .value as LoopNodeDefinition["config"]["mode"];
            if (mode === config.mode) return;
            drafts.clear(path);
            const common = {
              version: 1 as const,
              body: config.body,
              completedPort: config.completedPort,
              maxReachedPort: config.maxReachedPort,
              loopOutputs: config.loopOutputs
            };
            update(
              mode === "for-each"
                ? {
                    ...common,
                    mode,
                    collection: { kind: "literal", value: [] },
                    itemInputId: "item",
                    maxItems:
                      config.mode === "while" ? config.maxIterations : 3,
                    concurrency: 1
                  }
                : {
                    ...common,
                    mode,
                    maxIterations:
                      config.mode === "for-each" ? config.maxItems : 3,
                    repeatOutcome: config.body.exits[0]?.outcome ?? "continue",
                    completedOutcomes: []
                  }
            );
          }}
        >
          <option value="while">Repeat until complete</option>
          <option value="for-each">For each item</option>
        </select>
      </label>
      <label>
        <span>
          {config.mode === "while" ? "Maximum iterations" : "Maximum items"}
        </span>
        <input
          type="number"
          min={1}
          max={document.workflow.policies.limits.maxLoopIterations}
          step={1}
          value={
            config.mode === "while" ? config.maxIterations : config.maxItems
          }
          onChange={(event) => {
            const value = Math.max(
              1,
              Math.min(
                document.workflow.policies.limits.maxLoopIterations,
                Math.trunc(Number(event.target.value) || 1)
              )
            );
            update(
              config.mode === "while"
                ? { ...config, maxIterations: value }
                : { ...config, maxItems: value }
            );
          }}
        />
      </label>
      {config.mode === "for-each" ? (
        <fieldset className={styles.argumentRow}>
          <legend>Loop over</legend>
          <WorkflowVariableField
            value={config.collection}
            arrayOnly
            privateScope
            onChange={(collection) => update({ ...config, collection })}
          />
          {config.collection.kind === "literal" ? (
            <details>
              <summary>Use a fixed array</summary>
              <WorkflowDataSource
                value={config.collection}
                path={[...path, "collection"]}
                document={document}
                nodeId={node.id}
                onChange={(collection) => update({ ...config, collection })}
              />
            </details>
          ) : null}
        </fieldset>
      ) : null}
      <WorkflowLoopOutputs
        node={node}
        document={document}
        onChange={props.onChange}
      />
      <p className={styles.fieldHint}>
        Connect Start → task → End for another iteration. Use Condition → Break
        to finish early, or Continue to start the next iteration. Resize the
        Loop by dragging its border.
      </p>
    </>
  );
}
