import { useEffect, useState } from "react";
import type { JsonValue, WorkflowDefinitionV1 } from "@kmux/orchestration";
import type { AgentDescriptorDto } from "@kmux/proto";
import styles from "../styles/WorkflowsPanel.module.css";

/** Collect inputs for the selected workflow before its execution snapshot is pinned. */
export function WorkflowRunInputs(props: {
  definition: WorkflowDefinitionV1;
  agents: readonly AgentDescriptorDto[];
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [json, setJson] = useState(false);
  let values: Record<string, JsonValue> = {};
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(props.value) as unknown;
    if (!isObject(parsed)) throw new Error("Inputs must be a JSON object.");
    values = parsed;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const agentInputs = new Set(
    Object.values(props.definition.agentBindings).flatMap((binding) =>
      binding.agent.kind === "run-input" ? [binding.agent.inputId] : []
    )
  );
  const setValue = (id: string, value: JsonValue | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[id];
    else next[id] = value;
    props.onChange(JSON.stringify(next, null, 2));
  };
  return (
    <div
      className={styles.runFields}
      data-json={json || Boolean(parseError) || undefined}
    >
      <button type="button" onClick={() => setJson(!json)}>
        {json ? "Use input fields" : "Edit inputs as JSON"}
      </button>
      {json || parseError ? (
        <label>
          <span>Inputs JSON</span>
          <textarea
            value={props.value}
            onChange={(event) => props.onChange(event.target.value)}
            spellCheck={false}
          />
          {parseError ? <span role="alert">{parseError}</span> : null}
        </label>
      ) : (
        props.definition.inputs.map((input) => {
          const schema = isObject(input.schema?.schema)
            ? input.schema.schema
            : {};
          const value = Object.hasOwn(values, input.id)
            ? values[input.id]
            : input.default;
          const required = input.required && input.default === undefined;
          const label = input.id
            .replace(/([a-z])([A-Z])/gu, "$1 $2")
            .replace(/[-_]/gu, " ");
          let field: JSX.Element;
          if (agentInputs.has(input.id)) {
            field = (
              <select
                aria-label={input.id}
                required={required}
                value={typeof value === "string" ? value : ""}
                onChange={(event) =>
                  setValue(input.id, event.target.value || undefined)
                }
              >
                <option value="">Choose an Agent</option>
                {typeof value === "string" &&
                !props.agents.some((agent) => agent.id === value) ? (
                  <option value={value}>{value} · unavailable</option>
                ) : null}
                {props.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            );
          } else if (Array.isArray(schema.enum)) {
            const choices = schema.enum;
            field = (
              <select
                aria-label={input.id}
                required={required}
                value={value === undefined ? "" : JSON.stringify(value)}
                onChange={(event) =>
                  setValue(
                    input.id,
                    event.target.value
                      ? (JSON.parse(event.target.value) as JsonValue)
                      : undefined
                  )
                }
              >
                <option value="">Choose a value</option>
                {choices.map((choice) => (
                  <option
                    key={JSON.stringify(choice)}
                    value={JSON.stringify(choice)}
                  >
                    {String(choice)}
                  </option>
                ))}
              </select>
            );
          } else if (schema.type === "boolean") {
            field = (
              <select
                aria-label={input.id}
                required={required}
                value={value === undefined ? "" : String(value)}
                onChange={(event) =>
                  setValue(
                    input.id,
                    event.target.value
                      ? event.target.value === "true"
                      : undefined
                  )
                }
              >
                <option value="">Choose a value</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            );
          } else if (schema.type === "integer" || schema.type === "number") {
            field = (
              <input
                aria-label={input.id}
                type="number"
                required={required}
                value={typeof value === "number" ? value : ""}
                min={
                  typeof schema.minimum === "number"
                    ? schema.minimum
                    : undefined
                }
                max={
                  typeof schema.maximum === "number"
                    ? schema.maximum
                    : undefined
                }
                step={schema.type === "integer" ? 1 : "any"}
                onChange={(event) =>
                  setValue(
                    input.id,
                    event.target.value === ""
                      ? undefined
                      : event.target.valueAsNumber
                  )
                }
              />
            );
          } else if (
            schema.type === "string" ||
            typeof input.default === "string"
          ) {
            field = (
              <input
                aria-label={input.id}
                required={required}
                value={typeof value === "string" ? value : ""}
                minLength={
                  typeof schema.minLength === "number"
                    ? schema.minLength
                    : undefined
                }
                maxLength={
                  typeof schema.maxLength === "number"
                    ? schema.maxLength
                    : undefined
                }
                onChange={(event) =>
                  setValue(input.id, event.target.value || undefined)
                }
              />
            );
          } else {
            field = (
              <JsonInput
                id={input.id}
                required={required}
                value={value}
                onChange={(next) => setValue(input.id, next)}
              />
            );
          }
          return (
            <label key={input.id}>
              <span>
                {label}
                {required ? " *" : ""}
              </span>
              {field}
            </label>
          );
        })
      )}
    </div>
  );
}

function JsonInput(props: {
  id: string;
  required: boolean;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
}): JSX.Element {
  const [text, setText] = useState(
    props.value === undefined ? "" : JSON.stringify(props.value, null, 2)
  );
  const serialized = JSON.stringify(props.value);
  useEffect(() => {
    setText((current) => {
      try {
        if (
          JSON.stringify(current.trim() ? JSON.parse(current) : undefined) ===
          serialized
        )
          return current;
      } catch {
        /* External changes replace the previous value. */
      }
      return serialized === undefined
        ? ""
        : JSON.stringify(JSON.parse(serialized), null, 2);
    });
  }, [serialized]);
  return (
    <textarea
      aria-label={props.id}
      required={props.required}
      value={text}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try {
          const value = next.trim()
            ? (JSON.parse(next) as JsonValue)
            : undefined;
          event.target.setCustomValidity("");
          props.onChange(value);
        } catch {
          event.target.setCustomValidity("Enter valid JSON.");
        }
      }}
    />
  );
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
