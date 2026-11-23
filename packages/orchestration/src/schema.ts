import { z } from "zod";
import Ajv from "ajv";
import { isValidOutputPort, validateLoopTemplates } from "./loopTemplates";
import { resolveWorkflowAgentLaunchPreferences } from "./launchPreferences";
import {
  findCycle,
  maximumDepth,
  workflowDependencyGraph
} from "./dependencyGraph";

import type {
  JsonValue,
  JsonSchemaRef,
  ValidationIssue,
  ValidationResult,
  WorkflowDefinitionV1,
  GraphPatch,
  ResultSubmitCommand,
  ResultSubmitIngress,
  CreateAdaptiveRunCommand
} from "./types";

const jsonSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
  validateSchema: true
});

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "must be a stable identifier");
// Materialized IDs include persisted owning-Loop/iteration identities. Their
// bounded reference space is distinct from new canonical template identifiers.
const runtimeNodeId = z
  .string()
  .min(1)
  .max(32_768)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "must be a stable identifier");
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const launchPreference = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u,
    "must be an opaque provider identifier, not an argument or shell fragment"
  );

export const agentLaunchPreferencesSchema = z
  .object({
    model: launchPreference.optional(),
    effort: launchPreference.optional()
  })
  .strict();

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

const jsonSchemaRefSchema = z
  .object({
    ref: z.string().min(1).max(512).optional(),
    schema: z.record(jsonValueSchema).optional()
  })
  .strict()
  .refine(
    (value) =>
      Number(value.ref !== undefined) + Number(value.schema !== undefined) ===
      1,
    {
      message: "exactly one of ref or schema is required"
    }
  );

function createDataSourceSchema(nodeReferenceId: z.ZodString) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("loop-index"), loopNodeId: id }).strict(),
    z
      .object({
        kind: z.literal("run-input"),
        inputId: id,
        path: z.array(z.string().min(1).max(128)).max(32).optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("loop-item"),
        loopNodeId: id,
        path: z.array(z.string().min(1).max(128)).max(32).optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("loop-carry"),
        loopNodeId: id,
        inputId: id,
        path: z.array(z.string().min(1).max(128)).max(32).optional()
      })
      .strict(),
    z
      .object({ kind: z.literal("repository-state"), nodeId: nodeReferenceId })
      .strict(),
    z
      .object({
        kind: z.literal("node-result"),
        nodeId: nodeReferenceId,
        path: z.array(z.string().min(1).max(128)).max(32).optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("node-outcome"),
        nodeId: nodeReferenceId,
        path: z.array(z.string().min(1).max(128)).max(32).optional()
      })
      .strict(),
    z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict()
  ]);
}
const dataSourceSchema = createDataSourceSchema(id);
const runtimeDataSourceSchema = createDataSourceSchema(runtimeNodeId);

function createInputMappingSchema(
  sourceSchema: ReturnType<typeof createDataSourceSchema>
) {
  return z
    .object({
      target: id,
      source: sourceSchema,
      required: z.boolean(),
      missing: z.enum(["fail", "use-default", "omit"]),
      default: jsonValueSchema.optional()
    })
    .strict()
    .superRefine((mapping, context) => {
      if (mapping.missing === "use-default" && mapping.default === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: "use-default requires an explicit default"
        });
      }
      if (mapping.missing === "omit" && mapping.required) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["missing"],
          message: "a required mapping cannot omit missing data"
        });
      }
    });
}
const inputMappingSchema = createInputMappingSchema(dataSourceSchema);
const runtimeInputMappingSchema = createInputMappingSchema(
  runtimeDataSourceSchema
);

const retryPolicySchema = z
  .object({
    maxAttempts: positiveInt.max(20),
    retryable: z
      .array(
        z.enum(["executor-error", "invalid-result", "timeout", "lost-worker"])
      )
      .max(4),
    backoffMs: nonNegativeInt.max(86_400_000),
    placement: z.enum(["same", "allow-fresh", "approval-for-change"])
  })
  .strict();

const timeoutPolicySchema = z
  .object({
    timeoutMs: positiveInt.max(2_592_000_000),
    onTimeout: z.enum([
      "checkpoint",
      "needs-attention",
      "wake-coordinator",
      "cancel-and-retry",
      "fail"
    ])
  })
  .strict();

const commonNodeFields = {
  title: z.string().min(1).max(256),
  resultSchema: jsonSchemaRefSchema.optional(),
  retryPolicy: retryPolicySchema.optional(),
  timeoutPolicy: timeoutPolicySchema.optional(),
  joinPolicy: z
    .enum(["all-successful", "all-settled", "any-successful"])
    .optional(),
  anySuccessfulDisposition: z.enum(["wait", "cancel"]).optional(),
  completionRoot: z.boolean().optional(),
  requiredSideEffect: z.boolean().optional(),
  onFailure: z
    .enum(["fail-run", "skip-descendants", "wake-coordinator"])
    .optional(),
  onCancel: z
    .enum(["fail-run", "skip-descendants", "wake-coordinator"])
    .optional()
} as const;

const shellArgumentSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("literal"), value: z.string().max(32_768) })
    .strict(),
  z.object({ kind: z.literal("input"), input: id }).strict(),
  z.object({ kind: z.literal("secret"), secretRef: id }).strict()
]);

const loopBodySchema = z
  .object({
    nodeIds: z.array(id).min(1).max(1_000),
    entryNodeIds: z.array(id).min(1).max(64),
    exits: z
      .array(
        z
          .object({
            nodeId: id,
            port: id.optional(),
            outcome: id,
            action: z.enum(["break", "continue"]).optional()
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict();

function createWorkflowNodeSchema(
  nodeIdentifier: z.ZodString,
  sourceSchema: ReturnType<typeof createDataSourceSchema>
) {
  const mappingSchema = createInputMappingSchema(sourceSchema);
  const loopOutputsSchema = z
    .array(
      z
        .object({
          name: id,
          source: sourceSchema,
          mode: z.enum(["last", "collect"])
        })
        .strict()
    )
    .max(32)
    .optional();
  const nodeBase = {
    ...commonNodeFields,
    id: nodeIdentifier,
    inputMappings: z.array(mappingSchema).max(128).optional()
  };
  return z.discriminatedUnion("kind", [
    z
      .object({
        ...nodeBase,
        kind: z.literal("start"),
        config: z.object({ version: z.literal(1) }).strict()
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("end"),
        config: z.object({ version: z.literal(1) }).strict()
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("shell"),
        config: z
          .object({
            version: z.literal(1),
            command: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("structured"),
                  executable: z.string().min(1).max(4_096),
                  args: z.array(shellArgumentSchema).max(256)
                })
                .strict(),
              z
                .object({
                  kind: z.literal("script"),
                  script: z.string().min(1).max(262_144),
                  args: z.array(shellArgumentSchema).max(256)
                })
                .strict()
            ]),
            targetPolicy: z.enum(["local", "selected", "workflow-input"]),
            targetRef: id.optional(),
            surfacePolicy: z.literal("create"),
            cwdPolicy: z.enum(["workspace", "from-input"]),
            cwdInput: mappingSchema.optional(),
            resultMode: z.enum(["exit-code", "json-stdout", "result-file"]),
            resultFileInput: id.optional(),
            maxOutputBytes: positiveInt.max(64 * 1024 * 1024)
          })
          .strict()
          .superRefine((config, context) => {
            if (config.targetPolicy === "selected" && !config.targetRef) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["targetRef"],
                message: "selected target policy requires targetRef"
              });
            }
            if (config.cwdPolicy === "from-input" && !config.cwdInput) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["cwdInput"],
                message: "from-input cwd policy requires cwdInput"
              });
            }
            if (
              config.resultMode === "result-file" &&
              !config.resultFileInput
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["resultFileInput"],
                message: "result-file mode requires resultFileInput"
              });
            }
          })
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("agent"),
        config: z
          .object({
            version: z.literal(1),
            agentRef: id,
            launch: agentLaunchPreferencesSchema.optional(),
            prompt: z.string().min(1).max(128_000),
            lifecycleMode: z.literal("managed"),
            coding: z.boolean()
          })
          .strict()
      })
      .strict(),
    ...(["break", "continue"] as const).map((kind) =>
      z
        .object({
          ...nodeBase,
          kind: z.literal(kind),
          config: z.object({ version: z.literal(1) }).strict()
        })
        .strict()
    ),
    z
      .object({
        ...nodeBase,
        kind: z.literal("condition"),
        config: z
          .object({
            version: z.literal(1),
            expressionVersion: z.literal(1),
            expression: z.string().min(1).max(4_096),
            conditions: z
              .array(
                z
                  .object({
                    key: id,
                    left: sourceSchema,
                    operator: z.enum([
                      "eq",
                      "neq",
                      "gt",
                      "gte",
                      "lt",
                      "lte",
                      "contains",
                      "not_contains",
                      "in",
                      "nin",
                      "is_empty",
                      "is_not_empty",
                      "is_true",
                      "is_false"
                    ]),
                    right: sourceSchema.optional()
                  })
                  .strict()
              )
              .min(1)
              .max(31)
              .optional(),
            ports: z.array(id).min(2).max(32),
            errorPort: id.optional()
          })
          .strict()
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("loop"),
        config: z.discriminatedUnion("mode", [
          z
            .object({
              version: z.literal(1),
              mode: z.literal("for-each"),
              collection: sourceSchema,
              itemInputId: id,
              maxItems: positiveInt.max(10_000),
              concurrency: positiveInt.max(1_000),
              body: loopBodySchema,
              completedPort: id,
              maxReachedPort: id,
              loopOutputs: loopOutputsSchema,
              accumulator: z
                .object({ outputId: id, source: sourceSchema })
                .strict()
                .optional()
            })
            .strict(),
          z
            .object({
              version: z.literal(1),
              mode: z.literal("while"),
              maxIterations: positiveInt.max(10_000),
              body: loopBodySchema,
              repeatOutcome: id,
              completedOutcomes: z.array(id).max(32),
              completedPort: id,
              maxReachedPort: id,
              loopOutputs: loopOutputsSchema,
              maxGate: z
                .object({
                  nodeId: id,
                  retryResolution: id,
                  completedResolutions: z
                    .array(z.object({ resolution: id, port: id }).strict())
                    .min(1)
                    .max(32),
                  abortResolution: id
                })
                .strict()
                .optional(),
              carry: z
                .array(
                  z
                    .object({
                      inputId: id,
                      initial: sourceSchema,
                      next: sourceSchema
                    })
                    .strict()
                )
                .max(32)
                .optional()
            })
            .strict()
        ])
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("human-gate"),
        config: z
          .object({
            version: z.literal(1),
            question: z.string().min(1).max(8_192),
            resolutions: z.array(id).min(1).max(32),
            approverPolicy: z.enum(["run-owner", "local-user"])
          })
          .strict()
      })
      .strict()
  ]);
}
export const workflowNodeSchema = createWorkflowNodeSchema(
  id,
  dataSourceSchema
);
const addedRunNodeSchema = createWorkflowNodeSchema(
  id,
  runtimeDataSourceSchema
);
const replacedRunNodeSchema = createWorkflowNodeSchema(
  runtimeNodeId,
  runtimeDataSourceSchema
);

function createAgentBindingSchema(
  mappingSchema: ReturnType<typeof createInputMappingSchema>
) {
  return z
    .object({
      agent: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("caller") }).strict(),
        z.object({ kind: z.literal("agent-id"), agentId: id }).strict(),
        z
          .object({
            kind: z.literal("run-input"),
            inputId: id,
            requiredCapabilities: z.array(id).max(128).optional()
          })
          .strict()
      ]),
      scope: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("run") }).strict(),
        z.object({ kind: z.literal("loop-iteration"), loopNodeId: id }).strict()
      ]),
      authorityMode: z.enum(["restricted", "ambient"]),
      capabilities: z.array(id).max(128).optional(),
      launch: agentLaunchPreferencesSchema.optional(),
      targetPolicy: z.enum(["local", "selected", "workflow-input"]),
      targetRef: id.optional(),
      surfacePolicy: z.enum(["create", "create-or-reuse", "existing"]),
      sessionPolicy: z.enum(["fresh", "reuse", "prefer-reuse", "existing"]),
      existingSurfaceId: id.optional(),
      worktreePolicy: z.enum([
        "current",
        "dedicated-child",
        "dedicated-top-level",
        "target-repository-new",
        "from-input",
        "advisory-read-only"
      ]),
      worktreeInput: mappingSchema.optional(),
      inputMode: z.enum(["orchestrated", "interactive-recorded"]),
      allowSharedWrite: z.boolean().optional()
    })
    .strict()
    .superRefine((binding, context) => {
      if (
        binding.agent.kind === "caller" &&
        (binding.scope.kind !== "run" ||
          binding.targetPolicy !== "local" ||
          binding.worktreePolicy !== "current" ||
          binding.inputMode !== "orchestrated" ||
          binding.launch)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent"],
          message:
            "Calling Agent requires run scope, local target, current worktree, orchestrated input and no launch override"
        });
      }
      if (
        (binding.sessionPolicy === "existing" ||
          binding.surfacePolicy === "existing") &&
        !binding.existingSurfaceId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["existingSurfaceId"],
          message: "existing session/surface policy requires existingSurfaceId"
        });
      }
      if (binding.targetPolicy === "selected" && !binding.targetRef) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetRef"],
          message: "selected target policy requires targetRef"
        });
      }
      if (binding.worktreePolicy === "from-input" && !binding.worktreeInput) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["worktreeInput"],
          message: "from-input worktree policy requires worktreeInput"
        });
      }
    });
}
export const agentBindingSchema = createAgentBindingSchema(inputMappingSchema);
const runAgentBindingSchema = createAgentBindingSchema(
  runtimeInputMappingSchema
);

export const runLimitsSchema = z
  .object({
    maxNodes: positiveInt.max(10_000),
    maxEdges: positiveInt.max(100_000),
    maxGraphDepth: positiveInt.max(1_000),
    maxFanOut: positiveInt.max(1_000),
    maxLoopIterations: positiveInt.max(10_000),
    maxActiveAttempts: positiveInt.max(1_000),
    maxAttemptsPerSession: positiveInt.max(1_000),
    maxDispatches: positiveInt.max(100_000),
    maxCoordinatorTurns: positiveInt.max(10_000),
    maxGraphPatches: positiveInt.max(100_000),
    maxWallClockMs: positiveInt.max(31_536_000_000),
    maxActiveExecutionMs: positiveInt.max(31_536_000_000),
    maxArtifactBytes: positiveInt.max(1_099_511_627_776),
    maxStructuredResultBytes: positiveInt.max(1_073_741_824)
  })
  .strict();

export const workflowDefinitionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    definitionId: id,
    version: positiveInt,
    name: z.string().min(1).max(256),
    description: z.string().max(8_192).optional(),
    inputs: z
      .array(
        z
          .object({
            id,
            required: z.boolean(),
            schema: jsonSchemaRefSchema.optional(),
            default: jsonValueSchema.optional()
          })
          .strict()
      )
      .max(256),
    outputs: z
      .array(
        z
          .object({
            id,
            required: z.boolean(),
            source: dataSourceSchema,
            schema: jsonSchemaRefSchema.optional()
          })
          .strict()
      )
      .max(256),
    agentBindings: z.record(id, agentBindingSchema),
    nodes: z.array(workflowNodeSchema).min(2).max(10_000),
    edges: z
      .array(
        z
          .object({
            id,
            from: z.object({ nodeId: id, port: id.optional() }).strict(),
            to: z.object({ nodeId: id, port: id.optional() }).strict()
          })
          .strict()
      )
      .max(100_000),
    policies: z
      .object({
        limits: runLimitsSchema,
        failure: z.enum(["fail-run", "wake-coordinator", "needs-attention"]),
        cancellation: z.enum(["cancel-active", "wait-active"])
      })
      .strict()
  })
  .strict();

export function validateWorkflowDefinition(
  input: unknown
): ValidationResult<WorkflowDefinitionV1> {
  const parsed = workflowDefinitionV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code:
          issue.code === "invalid_union_discriminator"
            ? "unsupported_node_kind"
            : `schema_${issue.code}`,
        path: issue.path,
        message: issue.message
      }))
    };
  }

  const definition = parsed.data as WorkflowDefinitionV1;
  const issues = validateWorkflowSemantics(definition);
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: definition };
}

export function validateJsonSchemaValue(
  reference: JsonSchemaRef,
  value: JsonValue
): ValidationResult<JsonValue> {
  if (reference.ref !== undefined) {
    return {
      ok: false,
      issues: [
        {
          code: "unsupported_schema_ref",
          path: ["ref"],
          message: `external JSON Schema reference '${reference.ref}' is unsupported in local v1`
        }
      ]
    };
  }
  if (!reference.schema) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_schema",
          path: [],
          message: "inline JSON Schema is missing"
        }
      ]
    };
  }
  try {
    const validate = jsonSchemaValidator.compile(reference.schema);
    if (validate(value)) return { ok: true, value };
    return {
      ok: false,
      issues: (validate.errors ?? []).map((error) => ({
        code: `json_schema_${error.keyword}`,
        path: error.instancePath
          .split("/")
          .filter(Boolean)
          .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~")),
        message: error.message ?? "JSON Schema validation failed"
      }))
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_schema",
          path: [],
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "expected a sha256 content hash")
  .transform((value) => value as `sha256:${string}`);

export const terminalExecutionRefSchema = z
  .object({
    targetId: id,
    targetAuthority: id,
    surfaceId: id,
    sessionId: id,
    generation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("local"), runtimeEpoch: id }).strict(),
      z.object({ kind: z.literal("remote"), keeperGeneration: id }).strict()
    ]),
    inputAuthorityRef: id,
    providerSessionClaim: z
      .object({
        id: z.string().min(1).max(512),
        trust: z.enum(["verified", "inferred"])
      })
      .strict()
      .optional()
  })
  .strict();

const artifactRefSchema = z
  .object({
    artifactId: id,
    kind: id,
    contentHash: contentHashSchema,
    sizeBytes: nonNegativeInt.max(1_099_511_627_776),
    targetId: id.optional(),
    retentionUntil: z.string().datetime().optional()
  })
  .strict();

export const agentResultSubmissionSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    failureClass: z
      .enum(["executor-error", "invalid-result", "timeout", "lost-worker"])
      .optional(),
    summary: z.string().min(1).max(128_000),
    data: jsonValueSchema.optional(),
    artifacts: z.array(artifactRefSchema).max(256).optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome !== "failed" && result.failureClass !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureClass"],
        message: "failureClass is valid only for failed results"
      });
    }
  });

const graphPatchOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add-node"), node: addedRunNodeSchema }).strict(),
  z
    .object({
      kind: z.literal("replace-pending-node"),
      node: replacedRunNodeSchema,
      expectedNodeStateRevision: nonNegativeInt
    })
    .strict(),
  z
    .object({
      kind: z.literal("add-edge"),
      edge: z
        .object({
          id,
          from: z
            .object({ nodeId: runtimeNodeId, port: id.optional() })
            .strict(),
          to: z.object({ nodeId: runtimeNodeId, port: id.optional() }).strict()
        })
        .strict(),
      expectedTargetNodeStateRevision: nonNegativeInt
    })
    .strict(),
  z
    .object({
      kind: z.literal("add-binding"),
      agentRef: id,
      binding: runAgentBindingSchema
    })
    .strict()
]);

export const graphPatchSchema = z
  .object({
    runId: id,
    expectedGraphRevision: nonNegativeInt,
    authorityEpoch: positiveInt,
    authorPrincipal: id,
    capabilityRef: id,
    idempotencyKey: id,
    reason: z.string().max(8_192).optional(),
    operations: z.array(graphPatchOperationSchema).min(1).max(512)
  })
  .strict();

export const resultSubmitCommandSchema = z
  .object({
    attemptId: id,
    expectedExecution: terminalExecutionRefSchema,
    idempotencyKey: id,
    submissionHash: contentHashSchema,
    capabilityRef: id,
    result: agentResultSubmissionSchema
  })
  .strict();

export const resultSubmitIngressSchema = z
  .object({
    attemptId: id,
    expectedExecution: terminalExecutionRefSchema.optional(),
    idempotencyKey: id,
    submissionHash: contentHashSchema,
    capabilityRef: id.optional(),
    result: agentResultSubmissionSchema
  })
  .strict();

const createAdaptiveRunCommandShape = {
  runId: id,
  objective: z.string().min(1).max(128_000),
  inputs: z.record(id, jsonValueSchema),
  limits: runLimitsSchema,
  idempotencyKey: id
} as const;

export const createAdaptiveRunCommandSchema = z
  .object(createAdaptiveRunCommandShape)
  .strict();

export function parseGraphPatch(input: unknown): GraphPatch {
  return graphPatchSchema.parse(input) as GraphPatch;
}

export function parseResultSubmitCommand(input: unknown): ResultSubmitCommand {
  return resultSubmitCommandSchema.parse(input) as ResultSubmitCommand;
}

export function parseResultSubmitIngress(input: unknown): ResultSubmitIngress {
  return resultSubmitIngressSchema.parse(input) as ResultSubmitIngress;
}

export function parseCreateAdaptiveRunCommand(
  input: unknown
): CreateAdaptiveRunCommand {
  return createAdaptiveRunCommandSchema.parse(
    input
  ) as CreateAdaptiveRunCommand;
}

function validateWorkflowSemantics(
  definition: WorkflowDefinitionV1
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    path: readonly (string | number)[],
    message: string
  ) => issues.push({ code, path, message });
  const unique = (
    values: readonly string[],
    path: string,
    label: string
  ): Set<string> => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value))
        add(
          "duplicate_id",
          [path, index, "id"],
          `${label} id '${value}' is duplicated`
        );
      seen.add(value);
    }
    return seen;
  };

  const inputIds = unique(
    definition.inputs.map((input) => input.id),
    "inputs",
    "input"
  );
  unique(
    definition.outputs.map((output) => output.id),
    "outputs",
    "output"
  );
  const nodeIds = unique(
    definition.nodes.map((node) => node.id),
    "nodes",
    "node"
  );
  unique(
    definition.edges.map((edge) => edge.id),
    "edges",
    "edge"
  );

  const starts = definition.nodes.filter((node) => node.kind === "start");
  const ends = definition.nodes.filter((node) => node.kind === "end");
  if (starts.length !== 1)
    add(
      "start_cardinality",
      ["nodes"],
      "a published workflow requires exactly one start node"
    );
  if (ends.length < 1)
    add(
      "missing_terminal",
      ["nodes"],
      "a published workflow requires at least one end node"
    );
  if (definition.nodes.length > definition.policies.limits.maxNodes)
    add("limit_exceeded", ["nodes"], "node count exceeds declared maxNodes");
  if (definition.edges.length > definition.policies.limits.maxEdges)
    add("limit_exceeded", ["edges"], "edge count exceeds declared maxEdges");

  for (const [index, input] of definition.inputs.entries()) {
    validateSchemaReference(input.schema, ["inputs", index, "schema"]);
  }
  for (const [index, output] of definition.outputs.entries()) {
    validateSchemaReference(output.schema, ["outputs", index, "schema"]);
  }

  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const { owners: bodyOwner, issues: loopIssues } = validateLoopTemplates(
    definition.nodes,
    definition.edges
  );
  issues.push(...loopIssues);
  const outgoing = new Map<string, WorkflowDefinitionV1["edges"][number][]>();
  const incoming = new Map<string, WorkflowDefinitionV1["edges"][number][]>();

  for (const [index, edge] of definition.edges.entries()) {
    if (!nodeIds.has(edge.from.nodeId))
      add(
        "unknown_node",
        ["edges", index, "from", "nodeId"],
        `unknown source node '${edge.from.nodeId}'`
      );
    if (!nodeIds.has(edge.to.nodeId))
      add(
        "unknown_node",
        ["edges", index, "to", "nodeId"],
        `unknown target node '${edge.to.nodeId}'`
      );
    if (edge.from.nodeId === edge.to.nodeId)
      add(
        "cycle",
        ["edges", index],
        "self edges are not allowed; use an explicit loop node"
      );
    const from = nodeById.get(edge.from.nodeId);
    if (from && !isValidOutputPort(from, edge.from.port))
      add(
        "unknown_port",
        ["edges", index, "from", "port"],
        `port '${edge.from.port ?? "default"}' is not declared by '${from.id}'`
      );
    const fromEdges = outgoing.get(edge.from.nodeId) ?? [];
    fromEdges.push(edge);
    outgoing.set(edge.from.nodeId, fromEdges);
    const toEdges = incoming.get(edge.to.nodeId) ?? [];
    toEdges.push(edge);
    incoming.set(edge.to.nodeId, toEdges);
  }

  for (const [index, node] of definition.nodes.entries()) {
    validateSchemaReference(node.resultSchema, [
      "nodes",
      index,
      "resultSchema"
    ]);
    if (node.kind === "agent") {
      const binding = definition.agentBindings[node.config.agentRef];
      if (!binding) {
        add(
          "unknown_agent_ref",
          ["nodes", index, "config", "agentRef"],
          `unknown agent binding '${node.config.agentRef}'`
        );
      } else {
        const launch = resolveWorkflowAgentLaunchPreferences(
          binding.launch,
          node.config.launch
        );
        if (binding.agent.kind === "caller" && Object.keys(launch).length > 0) {
          add(
            "caller_launch_override",
            ["nodes", index, "config", "launch"],
            "Calling Agent uses its existing model and thinking settings"
          );
        }
        if (launch.effort && !launch.model) {
          add(
            "launch_effort_requires_model",
            ["nodes", index, "config", "launch", "effort"],
            "resolved Agent effort requires a resolved model"
          );
        }
      }
    }
    if (node.kind === "condition") {
      if (node.config.conditions) {
        const keys = node.config.conditions.map((condition) => condition.key);
        if (new Set(keys).size !== keys.length || keys.includes("else"))
          add(
            "invalid_condition_branch",
            ["nodes", index, "config", "conditions"],
            "Condition branch keys must be unique and cannot be else"
          );
        if (
          node.config.ports.length !== keys.length + 1 ||
          keys.includes(node.config.ports.at(-1)!) ||
          keys.some((key) => !node.config.ports.includes(key))
        )
          add(
            "invalid_condition_ports",
            ["nodes", index, "config", "ports"],
            "Condition ports must match its branches and else"
          );
        node.config.conditions.forEach((condition, ordinal) => {
          validateSource(
            condition.left,
            ["nodes", index, "config", "conditions", ordinal, "left"],
            node.id
          );
          const unary = [
            "is_empty",
            "is_not_empty",
            "is_true",
            "is_false"
          ].includes(condition.operator);
          if (!unary && condition.right === undefined)
            add(
              "missing_condition_operand",
              ["nodes", index, "config", "conditions", ordinal],
              "This operator requires a comparison value"
            );
          if (!unary && condition.right)
            validateSource(
              condition.right,
              ["nodes", index, "config", "conditions", ordinal, "right"],
              node.id
            );
        });
      }
      const used = new Set([
        ...(outgoing.get(node.id) ?? []).map((edge) => edge.from.port),
        ...definition.nodes.flatMap((candidate) =>
          candidate.kind === "loop"
            ? candidate.config.body.exits
                .filter((exit) => exit.nodeId === node.id)
                .map((exit) => exit.port)
            : []
        )
      ]);
      for (const port of node.config.ports)
        if (!used.has(port))
          add(
            "unrouted_branch",
            ["nodes", index, "config", "ports"],
            `condition port '${port}' has no destination`
          );
      if (node.config.errorPort && !used.has(node.config.errorPort))
        add(
          "unrouted_branch",
          ["nodes", index, "config", "errorPort"],
          `condition error port '${node.config.errorPort}' has no destination`
        );
    }
    if (node.kind === "loop") {
      for (const [outputIndex, output] of (
        node.config.loopOutputs ?? []
      ).entries())
        validateSource(
          output.source,
          ["nodes", index, "config", "loopOutputs", outputIndex, "source"],
          node.config.body.exits[0]?.nodeId
        );
      const names = (node.config.loopOutputs ?? []).map(
        (output) => output.name
      );
      if (
        new Set(names).size !== names.length ||
        names.some((name) =>
          ["iterations", "outcome", "carry", "items", "accumulated"].includes(
            name
          )
        )
      )
        add(
          "invalid_loop_output",
          ["nodes", index, "config", "loopOutputs"],
          "Loop output names must be unique and cannot replace built-in fields"
        );
      const ports = [
        ...new Set([
          node.config.completedPort,
          ...(node.config.mode === "while" && node.config.maxGate
            ? node.config.maxGate.completedResolutions.map(
                (resolution) => resolution.port
              )
            : [node.config.maxReachedPort])
        ])
      ];
      const maximum =
        node.config.mode === "for-each"
          ? node.config.maxItems
          : node.config.maxIterations;
      if (maximum > definition.policies.limits.maxLoopIterations)
        add(
          "limit_exceeded",
          ["nodes", index, "config"],
          "loop maximum exceeds the Run limit"
        );
      if (
        node.config.mode === "for-each" &&
        node.config.concurrency > definition.policies.limits.maxActiveAttempts
      )
        add(
          "limit_exceeded",
          ["nodes", index, "config", "concurrency"],
          "Loop concurrency exceeds maxActiveAttempts"
        );
      const used = new Set([
        ...(outgoing.get(node.id) ?? []).map((edge) => edge.from.port),
        ...definition.nodes.flatMap((candidate) =>
          candidate.kind === "loop"
            ? candidate.config.body.exits
                .filter((exit) => exit.nodeId === node.id)
                .map((exit) => exit.port)
            : []
        )
      ]);
      for (const port of ports)
        if (!used.has(port))
          add(
            "unrouted_loop_outcome",
            ["nodes", index, "config"],
            `loop port '${port}' has no destination`
          );
      if (node.config.mode === "for-each") {
        validateSource(
          node.config.collection,
          ["nodes", index, "config", "collection"],
          node.id
        );
        if (node.config.accumulator) {
          validateSource(
            node.config.accumulator.source,
            ["nodes", index, "config", "accumulator", "source"],
            node.config.body.exits[0]?.nodeId
          );
        }
      }
      if (node.config.mode === "while") {
        const carryIds = new Set<string>();
        for (const [carryIndex, carry] of (node.config.carry ?? []).entries()) {
          if (carryIds.has(carry.inputId))
            add(
              "duplicate_loop_carry",
              ["nodes", index, "config", "carry", carryIndex, "inputId"],
              `Loop carry '${carry.inputId}' is duplicated`
            );
          carryIds.add(carry.inputId);
          validateSource(
            carry.initial,
            ["nodes", index, "config", "carry", carryIndex, "initial"],
            node.id
          );
          validateSource(
            carry.next,
            ["nodes", index, "config", "carry", carryIndex, "next"],
            node.config.body.exits[0]?.nodeId
          );
        }
      }
    }
    if ((incoming.get(node.id)?.length ?? 0) > 1 && !node.joinPolicy)
      add(
        "missing_join_policy",
        ["nodes", index, "joinPolicy"],
        "nodes with multiple incoming edges require an explicit joinPolicy"
      );
    if (node.joinPolicy === "any-successful" && !node.anySuccessfulDisposition)
      add(
        "missing_join_disposition",
        ["nodes", index, "anySuccessfulDisposition"],
        "any-successful joins require an explicit disposition for remaining attempts"
      );
    if (node.joinPolicy !== "any-successful" && node.anySuccessfulDisposition)
      add(
        "invalid_join_disposition",
        ["nodes", index, "anySuccessfulDisposition"],
        "anySuccessfulDisposition is valid only for any-successful joins"
      );
    const mappingTargets = new Set<string>();
    for (const [mappingIndex, mapping] of (
      node.inputMappings ?? []
    ).entries()) {
      if (mappingTargets.has(mapping.target))
        add(
          "duplicate_mapping",
          ["nodes", index, "inputMappings", mappingIndex, "target"],
          `mapping target '${mapping.target}' is duplicated`
        );
      mappingTargets.add(mapping.target);
      validateSource(
        mapping.source,
        ["nodes", index, "inputMappings", mappingIndex, "source"],
        node.id
      );
    }
  }

  for (const [agentRef, binding] of Object.entries(definition.agentBindings)) {
    if (
      binding.agent.kind === "run-input" &&
      !inputIds.has(binding.agent.inputId)
    ) {
      add(
        "unknown_input",
        ["agentBindings", agentRef, "agent", "inputId"],
        `unknown Agent selector input '${binding.agent.inputId}'`
      );
    }
    if (binding.worktreeInput) {
      validateSource(binding.worktreeInput.source, [
        "agentBindings",
        agentRef,
        "worktreeInput",
        "source"
      ]);
    }
    if (binding.scope.kind === "loop-iteration") {
      const owner = nodeById.get(binding.scope.loopNodeId);
      if (owner?.kind !== "loop") {
        add(
          "invalid_binding_scope",
          ["agentBindings", agentRef, "scope", "loopNodeId"],
          `binding scope '${binding.scope.loopNodeId}' is not a Loop`
        );
        continue;
      }
      const users = definition.nodes.filter(
        (node) => node.kind === "agent" && node.config.agentRef === agentRef
      );
      for (const user of users) {
        if (!enclosingLoops(user.id).includes(binding.scope.loopNodeId)) {
          add(
            "invalid_binding_scope",
            ["agentBindings", agentRef, "scope", "loopNodeId"],
            `Loop '${binding.scope.loopNodeId}' does not enclose Agent node '${user.id}'`
          );
        }
      }
    }
  }

  for (const [index, output] of definition.outputs.entries())
    validateSource(output.source, ["outputs", index, "source"]);

  function enclosingLoops(nodeId: string): string[] {
    const loops: string[] = [];
    let current = bodyOwner.get(nodeId);
    while (current && !loops.includes(current)) {
      loops.push(current);
      current = bodyOwner.get(current);
    }
    return loops;
  }

  function validateSource(
    source: WorkflowDefinitionV1["outputs"][number]["source"],
    path: readonly (string | number)[],
    consumerNodeId?: string
  ) {
    if (source.kind === "run-input" && !inputIds.has(source.inputId))
      add("unknown_input", path, `unknown workflow input '${source.inputId}'`);
    if (source.kind === "loop-index") {
      if (
        nodeById.get(source.loopNodeId)?.kind !== "loop" ||
        !consumerNodeId ||
        !enclosingLoops(consumerNodeId).includes(source.loopNodeId)
      )
        add(
          "invalid_loop_index_scope",
          path,
          "Loop index is only available inside its Loop"
        );
    }
    if (source.kind === "loop-item") {
      const loop = nodeById.get(source.loopNodeId);
      if (loop?.kind !== "loop" || loop.config.mode !== "for-each")
        add(
          "invalid_loop_item",
          path,
          `Loop item source '${source.loopNodeId}' is not a for-each Loop`
        );
      if (
        consumerNodeId &&
        !enclosingLoops(consumerNodeId).includes(source.loopNodeId)
      )
        add(
          "invalid_loop_item_scope",
          path,
          `Loop item '${source.loopNodeId}' is not visible to node '${consumerNodeId}'`
        );
    }
    if (source.kind === "loop-carry") {
      const loop = nodeById.get(source.loopNodeId);
      if (loop?.kind !== "loop" || loop.config.mode !== "while")
        add(
          "invalid_loop_carry",
          path,
          `Loop carry source '${source.loopNodeId}' is not a while Loop`
        );
      if (
        consumerNodeId &&
        !enclosingLoops(consumerNodeId).includes(source.loopNodeId)
      )
        add(
          "invalid_loop_carry_scope",
          path,
          `Loop carry '${source.loopNodeId}' is not visible to node '${consumerNodeId}'`
        );
    }
    if (
      (source.kind === "node-result" ||
        source.kind === "node-outcome" ||
        source.kind === "repository-state") &&
      !nodeIds.has(source.nodeId)
    )
      add("unknown_node", path, `unknown source node '${source.nodeId}'`);
  }

  function validateSchemaReference(
    reference: JsonSchemaRef | undefined,
    path: readonly (string | number)[]
  ) {
    if (!reference) return;
    if (reference.ref !== undefined) {
      add(
        "unsupported_schema_ref",
        path,
        `external JSON Schema reference '${reference.ref}' is unsupported in local v1`
      );
      return;
    }
    if (!reference.schema) {
      add("invalid_json_schema", path, "inline JSON Schema is missing");
      return;
    }
    try {
      if (!jsonSchemaValidator.validateSchema(reference.schema)) {
        add(
          "invalid_json_schema",
          path,
          jsonSchemaValidator.errors?.[0]?.message ??
            "invalid inline JSON Schema"
        );
      }
    } catch (error) {
      add(
        "invalid_json_schema",
        path,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const graph = workflowDependencyGraph(definition.nodes, definition.edges);
  const cycle = findCycle(graph);
  if (cycle)
    add(
      "cycle",
      ["edges"],
      `arbitrary graph cycle is unsupported (${cycle.join(" -> ")}); use an explicit loop node`
    );

  const reachable = new Set<string>();
  const queue = starts.map((node) => node.id);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (reachable.has(next)) continue;
    reachable.add(next);
    for (const target of graph.get(next) ?? []) queue.push(target);
  }
  for (const [index, node] of definition.nodes.entries())
    if (!reachable.has(node.id))
      add(
        "unreachable_node",
        ["nodes", index],
        `node '${node.id}' is unreachable from start`
      );

  // Depth is defined only for a DAG. A cycle already has a validation issue;
  // traversing it for depth would recurse indefinitely while reporting it.
  const depth = cycle
    ? 0
    : maximumDepth(
        graph,
        starts.map((node) => node.id)
      );
  if (depth > definition.policies.limits.maxGraphDepth)
    add(
      "limit_exceeded",
      ["policies", "limits", "maxGraphDepth"],
      `graph depth ${depth} exceeds its declared limit`
    );
  for (const [nodeId, targets] of graph)
    if (targets.size > definition.policies.limits.maxFanOut)
      add(
        "limit_exceeded",
        ["nodes", definition.nodes.findIndex((node) => node.id === nodeId)],
        `fan-out ${targets.size} exceeds its declared limit`
      );

  return issues;
}
