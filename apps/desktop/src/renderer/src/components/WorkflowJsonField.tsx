import { createContext, useContext, useId, useMemo, useState } from "react";
import type { FlowEditorDocumentV1, JsonValue } from "@kmux/orchestration";

type FieldPath = readonly (string | number)[];
type JsonDraft = {
  path: FieldPath;
  text: string;
  value: string | undefined;
  label: string;
  error?: string;
};
const under = (path: FieldPath, prefix: FieldPath) =>
  prefix.every((part, index) => path[index] === part);

export function workflowJsonDraftNodeId(
  path: FieldPath,
  document: FlowEditorDocumentV1
): string | undefined {
  return document.nodes.find((entry) =>
    path[0] === "bindings"
      ? entry.definition.kind === "agent" &&
        entry.definition.config.agentRef === path[1]
      : path[0] === "nodes" && entry.id === path[1]
  )?.id;
}

/** Unfinished JSON belongs to the Studio buffer, so changing inspectors cannot discard it. */
export function useWorkflowJsonDrafts() {
  const [buffers, setBuffers] = useState<ReadonlyMap<string, JsonDraft>>(
    new Map()
  );
  const actions = useMemo(
    () => ({
      edit: (draft: JsonDraft) =>
        setBuffers((current) =>
          new Map(current).set(JSON.stringify(draft.path), draft)
        ),
      clear: (prefix: FieldPath) =>
        setBuffers(
          (current) =>
            new Map(
              [...current].filter(([, draft]) => !under(draft.path, prefix))
            )
        ),
      retainNodes: (document: FlowEditorDocumentV1) =>
        setBuffers((current) => {
          const remaining = [...current].filter(([, draft]) =>
            workflowJsonDraftNodeId(draft.path, document)
          );
          return remaining.length === current.size
            ? current
            : new Map(remaining);
        }),
      removeItem: (prefix: FieldPath, index: number) =>
        setBuffers(
          (current) =>
            new Map(
              [...current.values()].flatMap((draft) => {
                if (!under(draft.path, prefix))
                  return [[JSON.stringify(draft.path), draft] as const];
                const ordinal = draft.path[prefix.length];
                if (ordinal === index) return [];
                if (typeof ordinal !== "number" || ordinal < index)
                  return [[JSON.stringify(draft.path), draft] as const];
                const path = [
                  ...prefix,
                  ordinal - 1,
                  ...draft.path.slice(prefix.length + 1)
                ];
                return [[JSON.stringify(path), { ...draft, path }] as const];
              })
            )
        )
    }),
    []
  );
  return {
    buffers,
    errors: [...buffers.values()].filter((draft) => draft.error),
    ...actions
  };
}

export const WorkflowJsonDraftContext = createContext<ReturnType<
  typeof useWorkflowJsonDrafts
> | null>(null);

export function useWorkflowJsonDraftContext() {
  const drafts = useContext(WorkflowJsonDraftContext);
  if (!drafts)
    throw new Error("Workflow JSON fields require a Studio draft buffer");
  return drafts;
}

export function WorkflowJsonField(props: {
  path: FieldPath;
  label: string;
  value: JsonValue | undefined;
  optional?: boolean;
  validate?: (value: JsonValue) => string | undefined;
  onChange: (value: JsonValue | undefined) => void;
}): JSX.Element {
  const drafts = useWorkflowJsonDraftContext();
  const errorId = useId();
  const serialized = JSON.stringify(props.value);
  const stored = drafts.buffers.get(JSON.stringify(props.path));
  const buffer =
    stored?.error || stored?.value === serialized ? stored : undefined;
  return (
    <label>
      <span>{props.label}</span>
      <textarea
        aria-label={props.label}
        aria-invalid={Boolean(buffer?.error)}
        aria-describedby={buffer?.error ? errorId : undefined}
        rows={3}
        spellCheck={false}
        value={
          buffer?.text ??
          (props.value === undefined
            ? ""
            : JSON.stringify(props.value, null, 2))
        }
        onChange={(event) => {
          const text = event.target.value;
          let value = props.value;
          let error: string | undefined;
          try {
            value =
              !text.trim() && props.optional
                ? undefined
                : (JSON.parse(text) as JsonValue);
            JSON.stringify(value, (_key, item: unknown) => {
              if (typeof item === "number" && !Number.isFinite(item))
                throw new Error("JSON numbers must be finite");
              return item;
            });
            error = value === undefined ? undefined : props.validate?.(value);
          } catch {
            error = "Enter valid JSON.";
          }
          drafts.edit({
            path: props.path,
            text,
            label: props.label,
            value: error ? serialized : JSON.stringify(value),
            error
          });
          if (!error) props.onChange(value);
        }}
      />
      {buffer?.error ? (
        <span id={errorId} role="alert">
          {buffer.error}
        </span>
      ) : null}
    </label>
  );
}

export const requireJsonObject = (value: JsonValue): string | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? undefined
    : "Enter a JSON object.";
