import type { ParsedOrchestrationParams } from "@kmux/orchestration";
import { validateWorkflowDraft } from "@kmux/orchestration";
import {
  builtInWorkflowTemplate,
  canonicalJson,
  initializeFlowEditorDocument,
  listBuiltInWorkflowTemplates,
  publishWorkflowVersion,
  starterWorkflowDefinition,
  validateWorkflowDefinition,
  type JsonValue,
  type OrchestrationSnapshot,
  type OrchestrationStore,
  type RuntimeContext,
  type WorkflowDefinitionV1,
  type WorkflowDraft,
  type WorkflowRun
} from "@kmux/orchestration";
import { OrchestrationError } from "@kmux/orchestration";

import type {
  ParsedOrchestrationRequest,
  OrchestrationResponse
} from "@kmux/orchestration";
import {
  requireVisibleRun,
  assertWithinHostLimits
} from "./orchestrationQueries";
type WorkflowCatalogRequest = Extract<
  ParsedOrchestrationRequest,
  {
    method: Exclude<
      Extract<ParsedOrchestrationRequest["method"], `workflow.${string}`>,
      "workflow.run" | "workflow.caller.done"
    >;
  }
>;
export class LocalWorkflowCatalog {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly context: RuntimeContext
  ) {}
  async handle(
    request: WorkflowCatalogRequest,
    principal: string
  ): Promise<OrchestrationResponse<WorkflowCatalogRequest["method"]>> {
    switch (request.method) {
      case "workflow.list":
        return this.listWorkflows();
      case "workflow.version.get": {
        const version = (await this.store.read()).workflowVersions[
          request.params.workflowVersionId
        ];
        if (!version)
          throw new OrchestrationError(
            "not-found",
            "Published workflow version was not found"
          );
        return version;
      }
      case "workflow.template.list":
        return listBuiltInWorkflowTemplates();
      case "workflow.template.get": {
        const template = builtInWorkflowTemplate(request.params.templateId);
        if (!template) {
          throw new OrchestrationError(
            "not-found",
            `Workflow template '${request.params.templateId}' does not exist`
          );
        }
        const definition = {
          ...template,
          definitionId: request.params.definitionId,
          version: 1
        };
        return {
          canonicalDraft: definition,
          editorDocument: initializeFlowEditorDocument(definition)
        };
      }
      case "workflow.draft.initialize": {
        const definition = starterWorkflowDefinition({
          definitionId: request.params.definitionId,
          name: request.params.name
        });
        return {
          canonicalDraft: definition,
          editorDocument: initializeFlowEditorDocument(definition)
        };
      }
      case "workflow.draft.create_from_template":
        return this.createDraftFromTemplate(request.params, principal);
      case "workflow.draft.create":
        return this.createDraft(request.params, principal);
      case "workflow.draft.get":
        return this.getDraft(request.params.draftId);
      case "workflow.draft.create_from_run":
        return this.createDraftFromRun(request.params, principal);
      case "workflow.draft.update":
        return this.updateDraft(request.params, principal);
      case "workflow.draft.delete":
        return this.deleteDraft(request.params, principal);
      case "workflow.draft.validate":
        return this.validateDraft(
          request.params.draftId,
          request.params.expectedRevision
        );
      case "workflow.publish":
        return this.publishDraft(request.params, principal);
    }
  }
  private async listWorkflows(): Promise<
    OrchestrationResponse<"workflow.list">
  > {
    const snapshot = await this.store.read();
    return {
      drafts: Object.values(snapshot.workflowDrafts)
        .map((draft) => ({
          draftId: draft.draftId,
          definitionId: draft.definitionId,
          revision: draft.revision,
          name: draftName(draft.canonicalDraft),
          updatedAt: draft.updatedAt
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      versions: Object.values(snapshot.workflowVersions)
        .map((version) => ({
          workflowVersionId: version.workflowVersionId,
          definitionId: version.definitionId,
          version: version.version,
          name: version.definition.name,
          contentHash: version.contentHash,
          publishedAt: version.publishedAt
        }))
        .sort((left, right) =>
          left.definitionId === right.definitionId
            ? right.version - left.version
            : left.definitionId.localeCompare(right.definitionId)
        )
    };
  }

  private async createDraft(
    params: ParsedOrchestrationParams<"workflow.draft.create">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.draft.create">> {
    const name = params.name.trim();
    if (!params.draftId || !params.definitionId || !name) {
      throw new OrchestrationError(
        "invalid",
        "draftId, definitionId, and a non-empty name are required"
      );
    }
    const starter = starterWorkflowDefinition({
      definitionId: params.definitionId,
      name
    });
    const canonicalDraft =
      params.canonicalDraft ?? (starter as unknown as JsonValue);
    const canonical = validateWorkflowDefinition(canonicalDraft);
    const editorDocument =
      params.editorDocument ??
      (initializeFlowEditorDocument(
        canonical.ok ? canonical.value : starter
      ) as unknown as JsonValue);
    assertDraftDocumentSize(canonicalDraft, "canonicalDraft");
    assertDraftDocumentSize(editorDocument, "editorDocument");
    const createdAt = this.context.now();
    return this.store.transact(
      {
        type: "workflow.draft.created",
        principal,
        payload: {
          draftId: params.draftId,
          definitionId: params.definitionId
        }
      },
      (snapshot) => {
        assertWorkflowCatalogMutationPrincipal(snapshot, principal);
        if (snapshot.workflowDrafts[params.draftId]) {
          throw new OrchestrationError(
            "conflict",
            `Workflow Draft '${params.draftId}' already exists`
          );
        }
        const draft: WorkflowDraft = {
          draftId: params.draftId,
          definitionId: params.definitionId,
          revision: 1,
          canonicalDraft,
          editorDocument,
          createdAt,
          updatedAt: createdAt
        };
        return {
          snapshot: {
            ...snapshot,
            workflowDrafts: {
              ...snapshot.workflowDrafts,
              [draft.draftId]: draft
            }
          },
          value: draft
        };
      }
    );
  }

  private async createDraftFromTemplate(
    params: ParsedOrchestrationParams<"workflow.draft.create_from_template">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.draft.create_from_template">> {
    if (!params.templateId || !params.draftId || !params.definitionId) {
      throw new OrchestrationError(
        "invalid",
        "templateId, draftId, and definitionId are required"
      );
    }
    const template = builtInWorkflowTemplate(params.templateId);
    if (!template) {
      throw new OrchestrationError(
        "not-found",
        `Workflow template '${params.templateId}' does not exist`
      );
    }
    const definition: WorkflowDefinitionV1 = {
      ...template,
      definitionId: params.definitionId,
      version: 1
    };
    return this.createDraft(
      {
        draftId: params.draftId,
        definitionId: params.definitionId,
        name: definition.name,
        canonicalDraft: definition as unknown as JsonValue,
        editorDocument: initializeFlowEditorDocument(
          definition
        ) as unknown as JsonValue
      },
      principal
    );
  }

  private async createDraftFromRun(
    params: ParsedOrchestrationParams<"workflow.draft.create_from_run">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.draft.create_from_run">> {
    const name = params.name.trim();
    if (!params.runId || !params.draftId || !params.definitionId || !name) {
      throw new OrchestrationError(
        "invalid",
        "runId, draftId, definitionId, and a non-empty name are required"
      );
    }
    return this.store.transact(
      {
        type: "workflow.draft.created-from-run",
        principal,
        runId: params.runId,
        payload: {
          draftId: params.draftId,
          definitionId: params.definitionId
        }
      },
      (snapshot) => {
        assertWorkflowCatalogMutationPrincipal(snapshot, principal);
        const run = requireVisibleRun(snapshot, params.runId, principal);
        if (run.source.kind === "workflow-version") {
          throw new OrchestrationError(
            "invalid",
            "only an ad-hoc Run Graph can be saved as a Draft"
          );
        }
        if (snapshot.workflowDrafts[params.draftId]) {
          throw new OrchestrationError(
            "conflict",
            `Workflow Draft '${params.draftId}' already exists`
          );
        }
        const definition = reusableWorkflowDefinitionFromRun({
          run,
          definitionId: params.definitionId,
          name
        });
        const createdAt = this.context.now();
        const draft: WorkflowDraft = {
          draftId: params.draftId,
          definitionId: params.definitionId,
          revision: 1,
          canonicalDraft: definition as unknown as JsonValue,
          editorDocument: initializeFlowEditorDocument(
            definition
          ) as unknown as JsonValue,
          createdAt,
          updatedAt: createdAt
        };
        return {
          snapshot: {
            ...snapshot,
            workflowDrafts: {
              ...snapshot.workflowDrafts,
              [draft.draftId]: draft
            }
          },
          value: draft
        };
      }
    );
  }

  private async getDraft(
    draftId: string
  ): Promise<OrchestrationResponse<"workflow.draft.get">> {
    const snapshot = await this.store.read();
    return requireDraft(snapshot, draftId);
  }

  private async updateDraft(
    params: ParsedOrchestrationParams<"workflow.draft.update">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.draft.update">> {
    assertDraftDocumentSize(params.canonicalDraft, "canonicalDraft");
    assertDraftDocumentSize(params.editorDocument, "editorDocument");
    return this.store.transact(
      {
        type: "workflow.draft.updated",
        principal,
        payload: {
          draftId: params.draftId,
          expectedRevision: params.expectedRevision
        }
      },
      (snapshot) => {
        assertWorkflowCatalogMutationPrincipal(snapshot, principal);
        const current = requireDraft(snapshot, params.draftId);
        if (current.revision !== params.expectedRevision) {
          throw new OrchestrationError(
            "stale-revision",
            `Workflow Draft expected revision ${params.expectedRevision}, current revision is ${current.revision}`
          );
        }
        const draft: WorkflowDraft = {
          ...current,
          revision: current.revision + 1,
          canonicalDraft: params.canonicalDraft,
          editorDocument: params.editorDocument,
          updatedAt: this.context.now()
        };
        return {
          snapshot: {
            ...snapshot,
            workflowDrafts: {
              ...snapshot.workflowDrafts,
              [draft.draftId]: draft
            }
          },
          value: draft
        };
      }
    );
  }

  private async deleteDraft(
    params: ParsedOrchestrationParams<"workflow.draft.delete">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.draft.delete">> {
    return this.store.transact(
      {
        type: "workflow.draft.deleted",
        principal,
        payload: {
          draftId: params.draftId,
          expectedRevision: params.expectedRevision
        }
      },
      (snapshot) => {
        assertWorkflowCatalogMutationPrincipal(snapshot, principal);
        const current = requireDraft(snapshot, params.draftId);
        if (current.revision !== params.expectedRevision) {
          throw new OrchestrationError(
            "stale-revision",
            `Workflow Draft expected revision ${params.expectedRevision}, current revision is ${current.revision}`
          );
        }
        const { [params.draftId]: _deleted, ...workflowDrafts } =
          snapshot.workflowDrafts;
        return {
          snapshot: { ...snapshot, workflowDrafts },
          value: { deleted: true as const }
        };
      }
    );
  }

  private async validateDraft(
    draftId: string,
    expectedRevision?: number
  ): Promise<OrchestrationResponse<"workflow.draft.validate">> {
    const snapshot = await this.store.read();
    const draft = requireDraft(snapshot, draftId);
    if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
      throw new OrchestrationError(
        "stale-revision",
        "Workflow changed before execution preparation. Reopen it and try again."
      );
    }
    return validateWorkflowDraft(draft);
  }

  private async publishDraft(
    params: ParsedOrchestrationParams<"workflow.publish">,
    principal: string
  ): Promise<OrchestrationResponse<"workflow.publish">> {
    return this.store.transact(
      {
        type: "workflow.version.published",
        principal,
        payload: {
          draftId: params.draftId,
          expectedRevision: params.expectedRevision
        }
      },
      (snapshot) => {
        assertWorkflowCatalogMutationPrincipal(snapshot, principal);
        const draft = requireDraft(snapshot, params.draftId);
        if (draft.revision !== params.expectedRevision) {
          throw new OrchestrationError(
            "stale-revision",
            `Workflow Draft expected revision ${params.expectedRevision}, current revision is ${draft.revision}`
          );
        }
        const validation = validateWorkflowDraft(draft);
        if (!validation.publishable || !validation.canonical.ok) {
          throw new OrchestrationError(
            "invalid",
            "Workflow Draft is not publishable",
            { validation: validation as unknown as JsonValue }
          );
        }
        if (validation.canonical.value.definitionId !== draft.definitionId) {
          throw new OrchestrationError(
            "invalid",
            "Workflow Draft definitionId differs from its catalog identity"
          );
        }
        const nextVersion =
          Math.max(
            0,
            ...Object.values(snapshot.workflowVersions)
              .filter((version) => version.definitionId === draft.definitionId)
              .map((version) => version.version)
          ) + 1;
        const definition: WorkflowDefinitionV1 = {
          ...validation.canonical.value,
          version: nextVersion
        };
        assertWithinHostLimits(definition.policies.limits);
        const editorDocument = draft.editorDocument as unknown as {
          readonly [key: string]: JsonValue;
          readonly workflow: { readonly [key: string]: JsonValue };
        };
        const version = publishWorkflowVersion({
          definition,
          editorDocument: {
            ...editorDocument,
            workflow: { ...editorDocument.workflow, version: nextVersion }
          },
          workflowVersionId: this.context.id("workflow-version"),
          publishedAt: this.context.now()
        });
        const nextDraft: WorkflowDraft = {
          ...draft,
          revision: draft.revision + 1,
          updatedAt: this.context.now()
        };
        return {
          snapshot: {
            ...snapshot,
            workflowVersions: {
              ...snapshot.workflowVersions,
              [version.workflowVersionId]: version
            },
            workflowDrafts: {
              ...snapshot.workflowDrafts,
              [draft.draftId]: nextDraft
            }
          },
          value: { version, draft: nextDraft }
        };
      }
    );
  }
}
function reusableWorkflowDefinitionFromRun(input: {
  run: WorkflowRun;
  definitionId: string;
  name: string;
}): WorkflowDefinitionV1 {
  const nodes: WorkflowDefinitionV1["nodes"][number][] = [
    ...Object.values(input.run.graph.nodes)
      .filter((node) => !node.materialization)
      .map(
        (node) =>
          structuredClone(
            node.definition
          ) as WorkflowDefinitionV1["nodes"][number]
      ),
    ...Object.values(input.run.graph.bodyTemplates).map((node) =>
      structuredClone(node)
    )
  ];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [...input.run.graph.edges, ...input.run.graph.bodyTemplateEdges]
    .filter(
      (edge) => nodeIds.has(edge.from.nodeId) && nodeIds.has(edge.to.nodeId)
    )
    .map((edge) => structuredClone(edge));
  const edgeIds = new Set(edges.map((edge) => edge.id));

  let startId = nodes.find((node) => node.kind === "start")?.id;
  if (!startId) {
    startId = availableWorkflowIdentifier("saved-start", nodeIds);
    nodeIds.add(startId);
    nodes.unshift({
      id: startId,
      kind: "start",
      title: "Start",
      config: { version: 1 }
    });
    const roots = nodes.filter(
      (node) =>
        node.id !== startId && !edges.some((edge) => edge.to.nodeId === node.id)
    );
    for (const root of roots) {
      const edgeId = availableWorkflowIdentifier(
        `saved-start-${root.id}`,
        edgeIds
      );
      edgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        from: { nodeId: startId },
        to: { nodeId: root.id }
      });
    }
  }

  if (
    !nodes.some((node) => node.kind === "end" || node.completionRoot === true)
  ) {
    const endId = availableWorkflowIdentifier("saved-end", nodeIds);
    nodeIds.add(endId);
    const leaves = nodes.filter(
      (node) =>
        node.id !== endId && !edges.some((edge) => edge.from.nodeId === node.id)
    );
    nodes.push({
      id: endId,
      kind: "end",
      title: "End",
      config: { version: 1 },
      completionRoot: true
    });
    for (const leaf of leaves) {
      const edgeId = availableWorkflowIdentifier(
        `${leaf.id}-saved-end`,
        edgeIds
      );
      edgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        from: { nodeId: leaf.id },
        to: { nodeId: endId }
      });
    }
  }

  const referencedAgentRefs = new Set(
    nodes.flatMap((node) =>
      node.kind === "agent" ? [node.config.agentRef] : []
    )
  );
  const agentBindings = Object.fromEntries(
    Object.entries(input.run.graph.agentBindings)
      .filter(([agentRef]) => referencedAgentRefs.has(agentRef))
      .map(([agentRef, binding]) => [agentRef, structuredClone(binding)])
  );

  return {
    schemaVersion: 1,
    definitionId: input.definitionId,
    version: 1,
    name: input.name,
    description: `Saved from Run ${input.run.runId}`,
    inputs: Object.entries(input.run.inputs).map(([id, value]) => ({
      id,
      required: false,
      default: structuredClone(value)
    })),
    outputs: structuredClone(input.run.declaredOutputs),
    agentBindings,
    nodes,
    edges,
    policies: {
      limits: structuredClone(input.run.limits),
      failure: "fail-run",
      cancellation: "cancel-active"
    }
  };
}

function availableWorkflowIdentifier(
  base: string,
  used: ReadonlySet<string>
): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function requireDraft(
  snapshot: OrchestrationSnapshot,
  draftId: string
): WorkflowDraft {
  const draft = snapshot.workflowDrafts[draftId];
  if (!draft) {
    throw new OrchestrationError(
      "not-found",
      `Workflow Draft '${draftId}' was not found`
    );
  }
  return draft;
}

function assertWorkflowCatalogMutationPrincipal(
  _snapshot: OrchestrationSnapshot,
  principal: string
): void {
  if (principal === "user:local") return;
  throw new OrchestrationError(
    "unauthorized",
    "only the local user may mutate or execute the saved Workflow catalog"
  );
}

function draftName(value: JsonValue): string | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.name === "string"
    ? value.name
    : null;
}

const MAX_DRAFT_DOCUMENT_BYTES = 4 * 1024 * 1024;

function assertDraftDocumentSize(value: JsonValue, field: string): void {
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (bytes > MAX_DRAFT_DOCUMENT_BYTES) {
    throw new OrchestrationError(
      "budget-exhausted",
      `${field} exceeds the local v1 ${MAX_DRAFT_DOCUMENT_BYTES}-byte limit`
    );
  }
}
