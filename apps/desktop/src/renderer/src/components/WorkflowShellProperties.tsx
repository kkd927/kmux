import type {
  ShellArgument,
  ShellCommand,
  ShellNodeDefinition,
  FlowEditorDocumentV1
} from "@kmux/orchestration";
import { WorkflowMappingFields } from "./WorkflowDataProperties";
import { useWorkflowJsonDraftContext } from "./WorkflowJsonField";
import styles from "../styles/WorkflowsPanel.module.css";

/** Mapped values remain individual argv entries, including script parameters. */
export function WorkflowShellProperties(props: {
  node: ShellNodeDefinition;
  document: FlowEditorDocumentV1;
  onChange: (node: ShellNodeDefinition) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const config = props.node.config;
  const command = config.command;
  const update = (patch: Partial<ShellNodeDefinition["config"]>) =>
    props.onChange({
      ...props.node,
      config: { ...config, ...patch }
    });
  const argumentsList = command.args.map(
    (argument, index) => [String(index), argument] as const
  );
  const setArguments = (
    entries: readonly (readonly [string, ShellArgument])[]
  ) =>
    update({
      command: { ...command, args: entries.map(([, argument]) => argument) }
    });
  const setArgument = (index: number, argument: ShellArgument) =>
    setArguments(
      argumentsList.map((entry, ordinal) =>
        ordinal === index ? [entry[0], argument] : entry
      )
    );
  const changeCommandKind = (kind: ShellCommand["kind"]) => {
    if (kind === command.kind) return;
    update({
      command:
        kind === "structured"
          ? {
              kind,
              executable: "",
              args: argumentsList.map(([, argument]) => argument)
            }
          : {
              kind,
              script: "",
              args: argumentsList.map(([, argument]) => argument)
            }
    });
  };
  return (
    <>
      <div className={styles.sectionLabel}>Shell command</div>
      <label>
        <span>Command type</span>
        <select
          value={command.kind}
          onChange={(event) =>
            changeCommandKind(event.target.value as ShellCommand["kind"])
          }
        >
          <option value="structured">Executable and ordered arguments</option>
          <option value="script">Shell script (/bin/sh)</option>
        </select>
      </label>
      <label>
        <span>{command.kind === "structured" ? "Executable" : "Script"}</span>
        {command.kind === "structured" ? (
          <input
            value={command.executable}
            onChange={(event) =>
              update({
                command: { ...command, executable: event.target.value }
              })
            }
          />
        ) : (
          <textarea
            rows={6}
            value={command.script}
            onChange={(event) =>
              update({ command: { ...command, script: event.target.value } })
            }
          />
        )}
      </label>
      <div className={styles.sectionLabel}>Ordered arguments</div>
      {argumentsList.map(([, argument], index) => (
        <fieldset className={styles.argumentRow} key={index}>
          <legend>Argument {index + 1}</legend>
          <label>
            <span>Argument source</span>
            <select
              value={argument.kind}
              onChange={(event) => {
                const value =
                  argument.kind === "literal"
                    ? argument.value
                    : argument.kind === "input"
                      ? argument.input
                      : argument.secretRef;
                setArgument(
                  index,
                  event.target.value === "literal"
                    ? { kind: "literal", value }
                    : event.target.value === "input"
                      ? { kind: "input", input: value }
                      : { kind: "secret", secretRef: "" }
                );
              }}
            >
              <option value="literal">Literal text</option>
              <option value="input">Mapped node input</option>
              <option value="secret">Secret reference</option>
            </select>
          </label>
          <label>
            <span>
              {argument.kind === "literal"
                ? "Literal value"
                : argument.kind === "input"
                  ? "Node input name"
                  : "Secret reference ID"}
            </span>
            {argument.kind === "literal" ? (
              <textarea
                rows={3}
                value={argument.value}
                onChange={(event) =>
                  setArgument(index, { ...argument, value: event.target.value })
                }
              />
            ) : (
              <input
                value={
                  argument.kind === "input"
                    ? argument.input
                    : argument.secretRef
                }
                onChange={(event) =>
                  setArgument(
                    index,
                    argument.kind === "input"
                      ? { ...argument, input: event.target.value }
                      : { ...argument, secretRef: event.target.value }
                  )
                }
              />
            )}
          </label>
          {argument.kind === "secret" ? (
            <p className={styles.fieldHint}>
              Store only the reference ID here. Local execution does not yet
              support resolving secrets.
            </p>
          ) : null}
          <div className={styles.inlineActions}>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => {
                const next = [...argumentsList];
                [next[index - 1], next[index]] = [
                  next[index]!,
                  next[index - 1]!
                ];
                setArguments(next);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              onClick={() =>
                setArguments(
                  argumentsList.filter((_, ordinal) => ordinal !== index)
                )
              }
            >
              Remove argument
            </button>
          </div>
        </fieldset>
      ))}
      <div className={styles.inlineActions}>
        <button
          type="button"
          onClick={() => {
            const index = argumentsList.length + 1;
            setArguments([
              ...argumentsList,
              [`argument-${index}`, { kind: "literal", value: "" }]
            ]);
          }}
        >
          Add argument
        </button>
      </div>
      <p className={styles.fieldHint}>
        Commands run as your local user, with access to the working directory
        and environment. Each argument is one argv value. Scripts run with
        /bin/sh; mapped values are passed as positional parameters ($1, $2), not
        script text.
      </p>
      <label>
        <span>Result mode</span>
        <select
          value={config.resultMode}
          onChange={(event) =>
            update({
              resultMode: event.target.value as typeof config.resultMode
            })
          }
        >
          <option value="exit-code">Exit code</option>
          <option value="json-stdout">JSON stdout</option>
          <option value="result-file">Result file · unavailable locally</option>
        </select>
      </label>
      {config.resultMode === "result-file" ? (
        <label>
          <span>Result file input name</span>
          <input
            value={config.resultFileInput ?? ""}
            onChange={(event) =>
              update({ resultFileInput: event.target.value })
            }
          />
        </label>
      ) : null}
      <label>
        <span>Maximum output bytes</span>
        <input
          type="number"
          min={1}
          value={config.maxOutputBytes}
          onChange={(event) =>
            update({ maxOutputBytes: event.target.valueAsNumber || 0 })
          }
        />
      </label>
      <label>
        <span>Target policy</span>
        <select
          aria-label="Target policy"
          value={config.targetPolicy}
          onChange={(event) =>
            update({
              targetPolicy: event.target.value as typeof config.targetPolicy,
              targetRef: undefined
            })
          }
        >
          <option value="local">Local</option>
          <option value="selected">
            Selected target · unavailable locally
          </option>
          <option value="workflow-input">
            Run-selected target · unavailable locally
          </option>
        </select>
      </label>
      {config.targetPolicy !== "local" ? (
        <label>
          <span>Target reference</span>
          <input
            value={config.targetRef ?? ""}
            onChange={(event) => update({ targetRef: event.target.value })}
          />
        </label>
      ) : null}
      <label>
        <span>Working directory</span>
        <select
          aria-label="Working directory"
          value={config.cwdPolicy}
          onChange={(event) => {
            drafts.clear(["nodes", props.node.id, "cwdInput"]);
            update({
              cwdPolicy: event.target.value as typeof config.cwdPolicy,
              cwdInput:
                event.target.value === "from-input"
                  ? (config.cwdInput ?? {
                      target: "worktree",
                      source: { kind: "run-input", inputId: "" },
                      required: true,
                      missing: "fail"
                    })
                  : undefined
            });
          }}
        >
          <option value="workspace">Current workspace</option>
          <option value="from-input">Trusted worktree from input</option>
        </select>
      </label>
      {config.cwdPolicy === "from-input" && config.cwdInput ? (
        <fieldset className={styles.argumentRow}>
          <legend>Working directory mapping</legend>
          <WorkflowMappingFields
            mapping={config.cwdInput}
            path={["nodes", props.node.id, "cwdInput"]}
            document={props.document}
            nodeId={props.node.id}
            onChange={(cwdInput) => update({ cwdInput })}
          />
        </fieldset>
      ) : null}
      <p className={styles.fieldHint}>
        Each Shell execution uses its own managed Surface. A worktree input must
        resolve a trusted kmux worktree receipt.
      </p>
    </>
  );
}
