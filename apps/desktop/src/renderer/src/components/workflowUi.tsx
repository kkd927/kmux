import type {
  WorkflowCatalog,
  WorkflowTemplateSummary,
  WorkflowDraftValidation
} from "@kmux/orchestration";
import { type WorkflowJSON } from "@flowgram.ai/free-layout-editor";
import {
  type AgentLaunchPreferences,
  type FlowEditorDocumentV1,
  type JsonValue,
  type WorkflowDefinitionV1,
  type WorkflowNodeDefinition
} from "@kmux/orchestration";
import { useState, type ReactNode } from "react";
import { Codicon } from "./Codicon";
import styles from "../styles/WorkflowsPanel.module.css";
import { workflowNodeIconUrls } from "../workflowNodeIcons";

export type Catalog = WorkflowCatalog;

export type WorkflowTemplate = WorkflowTemplateSummary;

export type DraftValidation = WorkflowDraftValidation;

export type WorkflowCanvasController = {
  createNode: (entry: FlowEditorDocumentV1["nodes"][number]) => WorkflowJSON;
  deleteNode: (nodeId: string) => WorkflowJSON;
  focusNode: (nodeId: string) => void;
};

export type CanvasLayoutDirection = "horizontal" | "vertical";

export function WorkflowAdvancedFields(props: {
  compact: boolean;
  children: ReactNode;
}): JSX.Element {
  return props.compact ? (
    <details className={styles.advancedFields}>
      <summary>Advanced</summary>
      <div>{props.children}</div>
    </details>
  ) : (
    <>{props.children}</>
  );
}

export function CommaList(props: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <label>
      <span>{props.label}</span>
      <input
        value={editing ?? props.value.join(", ")}
        onBlur={() => setEditing(null)}
        onChange={(event) => {
          setEditing(event.target.value);
          props.onChange(
            event.target.value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
          );
        }}
      />
    </label>
  );
}

export function NodeKindIcon(props: {
  kind: WorkflowNodeDefinition["kind"];
}): JSX.Element {
  const image = workflowNodeIconUrls[props.kind];
  if (image)
    return (
      <span className={styles.nodeKindIcon} data-kind={props.kind}>
        <img src={image} alt="" draggable={false} />
      </span>
    );
  const icon =
    props.kind === "agent"
      ? "hubot"
      : props.kind === "shell"
        ? "terminal"
        : props.kind === "condition"
          ? "git-branch"
          : props.kind === "loop"
            ? "sync"
            : props.kind === "human-gate"
              ? "lock"
              : props.kind === "start"
                ? "debug-start"
                : "debug-stop";
  return (
    <span className={styles.nodeKindIcon} data-kind={props.kind}>
      <Codicon name={icon} />
    </span>
  );
}

export function nodeSummary(node: WorkflowNodeDefinition): string {
  if (node.kind === "agent") return node.config.prompt.slice(0, 72);
  if (node.kind === "shell") {
    return node.config.command.kind === "script"
      ? node.config.command.script.slice(0, 72) || "Empty script"
      : node.config.command.executable || "Unresolved executable";
  }
  if (node.kind === "condition") return node.config.expression;
  if (node.kind === "loop")
    return node.config.mode === "for-each"
      ? `For each · ${node.config.maxItems} items max`
      : `Bounded to ${node.config.maxIterations} iterations`;
  if (node.kind === "human-gate") return node.config.question;
  return node.kind === "start" ? "Workflow inputs" : "Required completion";
}

export function dynamicPorts(node: WorkflowNodeDefinition): readonly string[] {
  if (node.kind === "condition") return node.config.ports;
  if (node.kind === "loop")
    return [
      ...new Set([
        node.config.completedPort,
        node.config.maxReachedPort,
        ...(node.config.mode === "while" && node.config.maxGate
          ? node.config.maxGate.completedResolutions.map(
              (resolution) => resolution.port
            )
          : [])
      ])
    ];
  if (node.kind === "human-gate") return node.config.resolutions;
  return [];
}

export function launchDescription(
  preferences?: AgentLaunchPreferences
): string {
  if (!preferences?.model && !preferences?.effort) return "provider default";
  return `${preferences.model ?? "no model"} / ${preferences.effort ?? "default effort"}`;
}

export function asEditorDocument(
  value: JsonValue | null
): FlowEditorDocumentV1 | null {
  if (
    !isRecord(value) ||
    value.documentVersion !== 1 ||
    !isRecord(value.workflow) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return null;
  if (
    value.nodes.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !isRecord(entry.position) ||
        !isRecord(entry.definition)
    )
  )
    return null;
  return value as unknown as FlowEditorDocumentV1;
}

export function asWorkflowDefinition(
  value: JsonValue | null
): WorkflowDefinitionV1 | null {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.name === "string"
    ? (value as unknown as WorkflowDefinitionV1)
    : null;
}

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function rendererId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function workflowLayoutDirection(
  document: FlowEditorDocumentV1
): CanvasLayoutDirection {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  let horizontal = 0;
  let vertical = 0;
  for (const edge of document.edges) {
    const from = nodes.get(edge.from.nodeId)?.position;
    const to = nodes.get(edge.to.nodeId)?.position;
    if (!from || !to) continue;
    horizontal += Math.abs(to.x - from.x);
    vertical += Math.abs(to.y - from.y);
  }
  return vertical > horizontal ? "vertical" : "horizontal";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

export function messageBody(body: JsonValue): string {
  return isRecord(body) && typeof body.text === "string"
    ? body.text
    : JSON.stringify(body);
}
