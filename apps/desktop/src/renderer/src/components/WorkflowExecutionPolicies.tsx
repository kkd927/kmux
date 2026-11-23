import type {
  RetryPolicy,
  TimeoutPolicy,
  WorkflowNodeBase,
  WorkflowNodeDefinition
} from "@kmux/orchestration";
import styles from "../styles/WorkflowsPanel.module.css";

const failureChoices = [
  ["", "Use Runtime default"],
  ["fail-run", "Settle the Run"],
  ["skip-descendants", "Skip success-only descendants"]
] as const;
const retryFailures: readonly (readonly [
  RetryPolicy["retryable"][number],
  string
])[] = [
  ["executor-error", "Execution error"],
  ["invalid-result", "Invalid structured result"],
  ["timeout", "Timeout"],
  ["lost-worker", "Lost worker"]
];

/** Edits the published node contract; Runtime remains the policy owner. */
export function WorkflowExecutionPolicies(props: {
  node: WorkflowNodeDefinition;
  onChange: (node: WorkflowNodeDefinition) => void;
}): JSX.Element {
  const node = props.node;
  const execution = node.kind === "agent" || node.kind === "shell";
  const update = (patch: Partial<WorkflowNodeBase>) =>
    props.onChange({ ...node, ...patch });
  const retry = node.retryPolicy;
  const timeout = node.timeoutPolicy;
  return (
    <>
      <fieldset className={styles.argumentRow}>
        <legend>Failure and completion</legend>
        <PolicyChoice
          label="On failure"
          value={
            node.onFailure === "wake-coordinator"
              ? "fail-run"
              : (node.onFailure ?? "")
          }
          choices={failureChoices}
          onChange={(value) => update({ onFailure: value || undefined })}
        />
        <PolicyChoice
          label="On cancellation"
          value={
            node.onCancel === "wake-coordinator"
              ? "fail-run"
              : (node.onCancel ?? "")
          }
          choices={failureChoices}
          onChange={(value) => update({ onCancel: value || undefined })}
        />
        {node.onFailure === "skip-descendants" ||
        node.onCancel === "skip-descendants" ? (
          <p className={styles.fieldHint}>
            Route handled failures through a declared outcome branch and an
            all-settled join.
          </p>
        ) : null}
        {node.kind !== "end" ? (
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={node.completionRoot ?? false}
              onChange={(event) =>
                update({ completionRoot: event.target.checked })
              }
            />
            <span>Required for Run completion</span>
          </label>
        ) : null}
        {execution ? (
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={node.requiredSideEffect ?? false}
              onChange={(event) =>
                update({ requiredSideEffect: event.target.checked })
              }
            />
            <span>Required side effect</span>
          </label>
        ) : null}
      </fieldset>
      {execution ? (
        <>
          <fieldset className={styles.argumentRow}>
            <legend>Retries</legend>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={retry !== undefined}
                onChange={(event) =>
                  update({
                    retryPolicy: event.target.checked
                      ? {
                          maxAttempts: 2,
                          retryable: ["executor-error"],
                          backoffMs: 1000,
                          placement:
                            node.kind === "agent" ? "same" : "allow-fresh"
                        }
                      : undefined
                  })
                }
              />
              <span>Retry failed attempts</span>
            </label>
            {retry ? (
              <>
                <label>
                  <span>Maximum attempts, including the first</span>
                  <input
                    aria-label="Maximum attempts, including the first"
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    value={retry.maxAttempts}
                    onChange={(event) =>
                      update({
                        retryPolicy: {
                          ...retry,
                          maxAttempts: Number(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <label>
                  <span>Retry delay (ms)</span>
                  <input
                    aria-label="Retry delay (ms)"
                    type="number"
                    min={0}
                    step={1}
                    value={retry.backoffMs}
                    onChange={(event) =>
                      update({
                        retryPolicy: {
                          ...retry,
                          backoffMs: Number(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <div className={styles.sectionLabel}>Retry on</div>
                {retryFailures.map(([failure, label]) => (
                  <label className={styles.checkLabel} key={failure}>
                    <input
                      type="checkbox"
                      checked={retry.retryable.includes(failure)}
                      onChange={(event) =>
                        update({
                          retryPolicy: {
                            ...retry,
                            retryable: event.target.checked
                              ? [...retry.retryable, failure]
                              : retry.retryable.filter(
                                  (value) => value !== failure
                                )
                          }
                        })
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
                {node.kind === "agent" ? (
                  <>
                    <PolicyChoice
                      label="Agent placement on retry"
                      value={retry.placement}
                      choices={[
                        ["same", "Require the same Agent session"],
                        ["allow-fresh", "Allow a fresh Agent session"],
                        [
                          "approval-for-change",
                          "Require approval to change placement"
                        ]
                      ]}
                      onChange={(placement) =>
                        update({ retryPolicy: { ...retry, placement } })
                      }
                    />
                    {retry.placement !== "allow-fresh" ? (
                      <p className={styles.fieldHint}>
                        If the exact session cannot be reused, the Run requests
                        attention.
                        {retry.placement === "approval-for-change"
                          ? " Placement-change approval is not yet available."
                          : ""}
                      </p>
                    ) : null}
                  </>
                ) : null}
                <p className={styles.fieldHint}>
                  Retries wait for prior execution and resources to settle.
                  Uncertain work must be reconciled first.
                </p>
              </>
            ) : null}
          </fieldset>
          <fieldset className={styles.argumentRow}>
            <legend>Execution deadline</legend>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={timeout !== undefined}
                onChange={(event) =>
                  update({
                    timeoutPolicy: event.target.checked
                      ? { timeoutMs: 60000, onTimeout: "needs-attention" }
                      : undefined
                  })
                }
              />
              <span>Set an attempt timeout</span>
            </label>
            {timeout ? (
              <>
                <label>
                  <span>Attempt timeout (ms)</span>
                  <input
                    aria-label="Attempt timeout (ms)"
                    type="number"
                    min={1}
                    step={1}
                    value={timeout.timeoutMs}
                    onChange={(event) =>
                      update({
                        timeoutPolicy: {
                          ...timeout,
                          timeoutMs: Number(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <PolicyChoice<TimeoutPolicy["onTimeout"]>
                  label="When the timeout expires"
                  value={
                    timeout.onTimeout === "wake-coordinator"
                      ? "needs-attention"
                      : timeout.onTimeout
                  }
                  choices={[
                    ["checkpoint", "Record a checkpoint"],
                    ["needs-attention", "Request attention"],
                    ["cancel-and-retry", "Cancel, then apply retry policy"],
                    ["fail", "Cancel and fail the attempt"]
                  ]}
                  onChange={(onTimeout) =>
                    update({ timeoutPolicy: { ...timeout, onTimeout } })
                  }
                />
                {timeout.onTimeout === "cancel-and-retry" &&
                !retry?.retryable.includes("timeout") ? (
                  <p className={styles.fieldHint}>
                    Enable retries for Timeout to start another attempt after
                    confirmed cancellation.
                  </p>
                ) : null}
                {timeout.onTimeout === "checkpoint" ||
                timeout.onTimeout === "needs-attention" ? (
                  <p className={styles.fieldHint}>
                    Execution remains active. This timeout does not terminate
                    the process.
                  </p>
                ) : null}
              </>
            ) : null}
          </fieldset>
        </>
      ) : null}
    </>
  );
}

function PolicyChoice<T extends string>(props: {
  label: string;
  value: T;
  choices: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <label>
      <span>{props.label}</span>
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.choices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
