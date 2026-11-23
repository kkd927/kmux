import { canonicalJson, deepClone, publishWorkflowVersion } from "./canonical";
import { compileFlowEditorDocument } from "./editor";
import { validateWorkflowDefinition } from "./schema";
import {
  OrchestrationError,
  type JsonValue,
  type OrchestrationSnapshot,
  type WorkflowDraft,
  type WorkflowVersion
} from "./types";
import type { RuntimeContext } from "./runtime";
import type { WorkflowDraftValidation } from "./rpcTypes";

export function validateWorkflowDraft(
  draft: WorkflowDraft
): WorkflowDraftValidation {
  const canonical = validateWorkflowDefinition(draft.canonicalDraft);
  const editor = compileFlowEditorDocument(draft.editorDocument);
  const semanticallyEquivalent =
    canonical.ok &&
    editor.ok &&
    canonicalJson(canonical.value as unknown as JsonValue) ===
      canonicalJson(editor.value as unknown as JsonValue);
  return {
    canonical,
    editor,
    semanticallyEquivalent,
    publishable: canonical.ok && editor.ok && semanticallyEquivalent
  };
}

/** Resolve the latest saved document and pin an immutable, validated execution. */
export function prepareWorkflowInvocation(
  snapshot: OrchestrationSnapshot,
  workflow: string,
  context: RuntimeContext,
  expectedDraft?: Pick<WorkflowDraft, "draftId" | "revision">
): WorkflowVersion {
  const latest = new Map<string, (typeof snapshot.workflowDrafts)[string]>();
  for (const draft of Object.values(snapshot.workflowDrafts)) {
    const prior = latest.get(draft.definitionId);
    if (
      !prior ||
      draft.updatedAt > prior.updatedAt ||
      (draft.updatedAt === prior.updatedAt && draft.revision > prior.revision)
    )
      latest.set(draft.definitionId, draft);
  }
  const versions = Object.values(snapshot.workflowVersions);
  const isId =
    latest.has(workflow) ||
    versions.some((version) => version.definitionId === workflow);
  const byId = latest.get(workflow);
  const candidates = byId
    ? [byId]
    : isId
      ? []
      : [...latest.values()].filter(
          (draft) =>
            draft.canonicalDraft !== null &&
            typeof draft.canonicalDraft === "object" &&
            !Array.isArray(draft.canonicalDraft) &&
            draft.canonicalDraft.name === workflow
        );
  const legacyMatches = versions.filter(
    (version) =>
      !latest.has(version.definitionId) &&
      (isId
        ? version.definitionId === workflow
        : version.definition.name === workflow)
  );
  if (
    new Set([
      ...candidates.map((draft) => draft.definitionId),
      ...legacyMatches.map((version) => version.definitionId)
    ]).size > 1
  )
    throw new OrchestrationError(
      "conflict",
      "Workflow title is ambiguous. Use its Definition ID."
    );
  const draft = candidates[0];
  if (
    expectedDraft &&
    (!draft ||
      draft.draftId !== expectedDraft.draftId ||
      draft.revision !== expectedDraft.revision)
  ) {
    throw new OrchestrationError(
      "stale-revision",
      "Workflow changed before execution preparation. Reopen it and try again."
    );
  }
  if (!draft) {
    const known = legacyMatches;
    const version = known.sort((a, b) => b.version - a.version)[0];
    if (!version)
      throw new OrchestrationError(
        "not-found",
        `Workflow '${workflow}' was not found`
      );
    return version;
  }
  const { canonical, publishable } = validateWorkflowDraft(draft);
  if (
    !canonical.ok ||
    !publishable ||
    canonical.value.definitionId !== draft.definitionId
  )
    throw new OrchestrationError(
      "invalid",
      "Latest saved Workflow is invalid or its editor and definition differ"
    );
  const previous = versions
    .filter((v) => v.definitionId === draft.definitionId)
    .sort((a, b) => b.version - a.version)[0];
  const same = (left: JsonValue, right: JsonValue) =>
    canonicalJson(left) === canonicalJson(right);
  const withoutVersion = (value: typeof canonical.value): JsonValue =>
    ({ ...value, version: 1 }) as unknown as JsonValue;
  const editorAtVersionOne = (value: JsonValue): JsonValue => {
    const document = value as unknown as {
      workflow: Record<string, JsonValue>;
    };
    return {
      ...document,
      workflow: { ...document.workflow, version: 1 }
    } as unknown as JsonValue;
  };
  if (
    previous &&
    same(
      withoutVersion(previous.definition),
      withoutVersion(canonical.value)
    ) &&
    previous.editorDocument &&
    same(
      editorAtVersionOne(previous.editorDocument),
      editorAtVersionOne(draft.editorDocument)
    )
  )
    return previous;
  const versionNumber = (previous?.version ?? 0) + 1;
  const document = deepClone(draft.editorDocument) as unknown as {
    workflow: Record<string, JsonValue>;
  };
  return publishWorkflowVersion({
    definition: { ...canonical.value, version: versionNumber },
    editorDocument: {
      ...document,
      workflow: { ...document.workflow, version: versionNumber }
    } as unknown as JsonValue,
    workflowVersionId: context.id("workflow-version"),
    publishedAt: context.now()
  });
}
