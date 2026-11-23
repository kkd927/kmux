import { createHash } from "node:crypto";

import { validateWorkflowDefinition } from "./schema";
import {
  OrchestrationError,
  type ContentHash,
  type JsonValue,
  type WorkflowDefinitionV1,
  type WorkflowVersion
} from "./types";

export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

export function contentHash(value: JsonValue): ContentHash {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function workflowContentHash(
  definition: WorkflowDefinitionV1
): ContentHash {
  return contentHash(definition as unknown as JsonValue);
}

export function publishWorkflowVersion(input: {
  definition: unknown;
  editorDocument?: JsonValue;
  workflowVersionId: string;
  publishedAt: string;
}): WorkflowVersion {
  const validated = validateWorkflowDefinition(input.definition);
  if (!validated.ok) {
    throw new OrchestrationError("invalid", "workflow cannot be published", {
      issues: validated.issues as unknown as JsonValue
    });
  }
  const definition = deepFreeze(deepClone(validated.value));
  return deepFreeze({
    workflowVersionId: input.workflowVersionId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaVersion: 1,
    compilerVersion: 1,
    expressionVersion: 1,
    reachabilityVersion: 1,
    contentHash: workflowContentHash(definition),
    definition,
    ...(input.editorDocument !== undefined
      ? { editorDocument: deepClone(input.editorDocument) }
      : {}),
    publishedAt: input.publishedAt
  });
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OrchestrationError(
        "invalid",
        "canonical JSON rejects non-finite numbers"
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`)
    .join(",")}}`;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
