import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import canonicalWorkflowSchema from "../schema/canonical-workflow-v1.schema.json";
import { nestedReviewWorkflow } from "../fixtures/nested-review";
import {
  builtInWorkflowTemplate,
  SHELL_TEMPLATE_ID,
  canonicalJson,
  parseGraphPatch,
  parseResultSubmitCommand,
  publishWorkflowVersion,
  validateWorkflowDefinition,
  workflowContentHash
} from "./index";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures"
);
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8"));

describe("Canonical Workflow Schema v1", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateJsonSchema = ajv.compile(canonicalWorkflowSchema);

  it("accepts script and executable commands through both publication schemas", () => {
    const template = builtInWorkflowTemplate(SHELL_TEMPLATE_ID)!;
    for (const command of [
      {
        kind: "script",
        script: 'printf "%s" "$1"',
        args: [{ kind: "literal", value: "$(data)" }]
      },
      { kind: "structured", executable: "custom-program", args: [] }
    ]) {
      const workflow = {
        ...template,
        nodes: template.nodes.map((node) =>
          node.kind === "shell"
            ? { ...node, config: { ...node.config, command } }
            : node
        )
      };
      expect(
        validateJsonSchema(workflow),
        JSON.stringify(validateJsonSchema.errors)
      ).toBe(true);
      expect(validateWorkflowDefinition(workflow)).toMatchObject({ ok: true });
    }
  });

  it.each(["collection", "carry-initial"] as const)(
    "rejects a dependency cycle through Loop %s",
    (field) => {
      const base = nestedReviewWorkflow()!;
      const definition = {
        ...base,
        nodes: base.nodes.map((node) => {
          if (
            field === "collection" &&
            node.id === "items" &&
            node.kind === "loop" &&
            node.config.mode === "for-each"
          )
            return {
              ...node,
              config: {
                ...node.config,
                collection: { kind: "node-result" as const, nodeId: "end" }
              }
            };
          if (
            field === "carry-initial" &&
            node.id === "review-rounds" &&
            node.kind === "loop" &&
            node.config.mode === "while"
          )
            return {
              ...node,
              config: {
                ...node.config,
                carry: node.config.carry!.map((entry) => ({
                  ...entry,
                  initial: {
                    kind: "node-result" as const,
                    nodeId: "commit-change"
                  }
                }))
              }
            };
          return node;
        })
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.issues.some((issue) => issue.code === "cycle")).toBe(
          true
        );
    }
  );

  it.each([
    ["unknown", "invalid_loop_gate_resolution"],
    ["duplicate", "ambiguous_loop_gate_resolution"],
    ["unrouted", "unrouted_loop_gate_resolution"],
    ["body-member", "invalid_loop_gate_member"]
  ] as const)(
    "rejects %s maximum-gate routes before publication",
    (variant, code) => {
      const base = nestedReviewWorkflow()!;
      const definition = {
        ...base,
        nodes: base.nodes.map((node) => {
          if (
            node.id !== "review-rounds" ||
            node.kind !== "loop" ||
            node.config.mode !== "while"
          )
            return node;
          const gate = node.config.maxGate!;
          return {
            ...node,
            config: {
              ...node.config,
              ...(variant === "body-member"
                ? {
                    body: {
                      ...node.config.body,
                      nodeIds: [...node.config.body.nodeIds, gate.nodeId]
                    }
                  }
                : {}),
              maxGate: {
                ...gate,
                ...(variant === "unknown"
                  ? { retryResolution: "not-a-resolution" }
                  : {}),
                ...(variant === "duplicate"
                  ? { abortResolution: gate.retryResolution }
                  : {}),
                ...(variant === "unrouted"
                  ? { completedResolutions: gate.completedResolutions.slice(1) }
                  : {})
              }
            }
          };
        })
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.issues.some((issue) => issue.code === code)).toBe(true);
    }
  );

  it.each(["collection", "accumulator"] as const)(
    "validates %s data references on a for-each Loop",
    (field) => {
      const base = nestedReviewWorkflow()!;
      const definition = {
        ...base,
        nodes: base.nodes.map((node) =>
          node.id === "items" &&
          node.kind === "loop" &&
          node.config.mode === "for-each"
            ? {
                ...node,
                config: {
                  ...node.config,
                  ...(field === "collection"
                    ? {
                        collection: {
                          kind: "run-input" as const,
                          inputId: "absent"
                        }
                      }
                    : {
                        accumulator: {
                          outputId: "receipts",
                          source: {
                            kind: "node-result" as const,
                            nodeId: "absent"
                          }
                        }
                      })
                }
              }
            : node
        )
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            code: field === "collection" ? "unknown_input" : "unknown_node",
            path: expect.arrayContaining([field])
          })
        );
    }
  );

  it("agrees across the machine schema, TypeScript validator, canonicalizer, and immutable publisher", () => {
    const workflow = fixture("workflow-v1.valid.json");

    expect(
      validateJsonSchema(workflow),
      JSON.stringify(validateJsonSchema.errors ?? [])
    ).toBe(true);
    const validated = validateWorkflowDefinition(workflow);
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) throw new Error("fixture should be valid");
    expect(workflowContentHash(validated.value)).toBe(
      "sha256:826fe3b4b83b1c7c00ac382cdcca54c086791d9e3a837589bae8a6a270d0a2f1"
    );

    const reordered = JSON.parse(canonicalJson(validated.value as never));
    expect(workflowContentHash(reordered)).toBe(
      workflowContentHash(validated.value)
    );
    const published = publishWorkflowVersion({
      definition: workflow,
      workflowVersionId: "workflow-version:1",
      publishedAt: "2026-08-26T00:00:00.000Z"
    });
    expect(published.contentHash).toBe(workflowContentHash(validated.value));
    expect(Object.isFrozen(published.definition.nodes[0])).toBe(true);
  });

  it("freezes publication layout independently of the canonical execution hash", () => {
    const document = {
      documentVersion: 1,
      nodes: [{ id: "start", position: { x: 0, y: 250 } }]
    };
    const input = {
      definition: fixture("workflow-v1.valid.json"),
      workflowVersionId: "version:layout",
      publishedAt: "2026-09-10T00:00:00.000Z"
    };
    const baseline = publishWorkflowVersion(input);
    const version = publishWorkflowVersion({
      ...input,
      editorDocument: document
    });
    document.nodes[0]!.position.y = 800;
    expect(version.contentHash).toBe(baseline.contentHash);
    expect(version.editorDocument).toMatchObject({
      nodes: [{ position: { x: 0, y: 250 } }]
    });
    expect(
      Object.isFrozen(
        (version.editorDocument as typeof document).nodes[0]!.position
      )
    ).toBe(true);
  });

  it("rejects unknown fields and unsupported executable kinds instead of silently falling back", () => {
    const unknownField = fixture("workflow-v1.unknown-field.json");
    expect(validateJsonSchema(unknownField)).toBe(false);
    expect(validateWorkflowDefinition(unknownField)).toMatchObject({
      ok: false
    });

    const unsupportedKind = structuredClone(
      fixture("workflow-v1.valid.json")
    ) as { nodes: Array<{ kind: string }> };
    unsupportedKind.nodes[1]!.kind = "command";
    const result = validateWorkflowDefinition(unsupportedKind);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("unsupported node must fail");
    expect(
      result.issues.some((issue) => issue.code === "unsupported_node_kind")
    ).toBe(true);
  });

  it("validates binding defaults and node launch overrides without accepting raw argv", () => {
    const workflow = structuredClone(fixture("workflow-v1.valid.json")) as {
      agentBindings: Record<
        string,
        { launch?: { model?: string; effort?: string } }
      >;
      nodes: Array<{
        config: { launch?: { model?: string; effort?: string } };
      }>;
    };
    workflow.agentBindings.author!.launch = {
      model: "gpt-5.5",
      effort: "medium"
    };
    workflow.nodes[1]!.config.launch = { effort: "high" };
    expect(validateJsonSchema(workflow)).toBe(true);
    expect(validateWorkflowDefinition(workflow)).toMatchObject({ ok: true });

    delete workflow.agentBindings.author!.launch!.model;
    const unresolved = validateWorkflowDefinition(workflow);
    expect(unresolved).toMatchObject({ ok: false });
    if (unresolved.ok) throw new Error("effort without a model must fail");
    expect(
      unresolved.issues.some(
        (issue) => issue.code === "launch_effort_requires_model"
      )
    ).toBe(true);

    workflow.agentBindings.author!.launch!.model = "--dangerous-flag";
    expect(validateJsonSchema(workflow)).toBe(false);
    expect(validateWorkflowDefinition(workflow)).toMatchObject({ ok: false });
  });

  it("keeps Graph authoring and worker lifecycle trust boundaries strict and separate", () => {
    expect(() =>
      parseGraphPatch({
        runId: "run:1",
        expectedGraphRevision: 0,
        authorityEpoch: 1,
        authorPrincipal: "coordinator:1",
        capabilityRef: "graph-capability:1",
        idempotencyKey: "patch:1",
        operations: [{ kind: "raise-limits", maxNodes: 1000000 }]
      })
    ).toThrow();

    expect(() =>
      parseResultSubmitCommand({
        attemptId: "attempt:1",
        expectedExecution: {
          targetId: "local",
          targetAuthority: "local",
          surfaceId: "surface:1",
          sessionId: "session:1",
          generation: { kind: "local", runtimeEpoch: "epoch:1" },
          inputAuthorityRef: "input:1"
        },
        idempotencyKey: "submit:1",
        submissionHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        capabilityRef: "worker-capability:1",
        result: { outcome: "succeeded", summary: "done" },
        graphPatch: { operations: [] }
      })
    ).toThrow();
  });
});
