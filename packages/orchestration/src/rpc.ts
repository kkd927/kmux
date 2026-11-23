import { z } from "zod";
import {
  createAdaptiveRunCommandSchema,
  jsonValueSchema,
  agentLaunchPreferencesSchema,
  agentResultSubmissionSchema
} from "./schema";
import type { OrchestrationResponses } from "./rpcTypes";

const emptyParamsSchema = z.object({}).strict();
const utf8 = new TextEncoder();
const agentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u)
  .refine(
    (value) => value !== "unknown" && utf8.encode(value).byteLength <= 64
  );
const remoteControlIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => utf8.encode(value).byteLength <= 256 && !/\p{Cc}/u.test(value),
    "Expected a control-safe ID no larger than 256 UTF-8 bytes"
  );
const terminalTextSchema = z
  .string()
  .max(64 * 1024)
  .refine(
    (value) => utf8.encode(value).byteLength <= 64 * 1024,
    "Expected terminal input no larger than 64 KiB"
  );

/** Shared validation and defaults for both socket and Renderer IPC callers. */
export const orchestrationParamSchemas = {
  "orchestration.run.create": createAdaptiveRunCommandSchema,
  "orchestration.run.use": z.object({ runId: remoteControlIdSchema }).strict(),
  "orchestration.run.current": emptyParamsSchema,
  "orchestration.task.create": z
    .object({
      runId: remoteControlIdSchema.optional(),
      taskId: remoteControlIdSchema,
      spec: terminalTextSchema,
      title: z.string().trim().min(1).max(256).optional(),
      dependencies: z.array(remoteControlIdSchema).max(64).default([]),
      requestId: remoteControlIdSchema
    })
    .strict(),
  "orchestration.task.list": z
    .object({ runId: remoteControlIdSchema.optional() })
    .strict(),
  "orchestration.worker.start": z
    .object({
      runId: remoteControlIdSchema.optional(),
      taskId: remoteControlIdSchema.optional(),
      spec: terminalTextSchema.optional(),
      title: z.string().trim().min(1).max(256).optional(),
      agentId: agentIdSchema,
      worktree: z.enum(["current", "new-child", "new-top-level"]).optional(),
      coding: z.boolean().default(true),
      reuseDispatchId: remoteControlIdSchema.optional(),
      retryDispatchId: remoteControlIdSchema.optional(),
      allowParallelAgent: z.boolean().default(false),
      preferences: agentLaunchPreferencesSchema,
      requestId: remoteControlIdSchema
    })
    .strict()
    .refine(
      (params) => Boolean(params.spec) !== Boolean(params.taskId),
      "worker-start requires exactly one of spec or taskId"
    )
    .refine(
      (params) => !params.retryDispatchId || Boolean(params.taskId),
      "worker-start --retry-of requires --task"
    )
    .refine(
      (params) => !params.retryDispatchId || !params.reuseDispatchId,
      "worker-start cannot combine retry and reuse"
    ),
  "orchestration.worker.list": z
    .object({
      runId: remoteControlIdSchema.optional(),
      terminalState: z
        .enum([
          "active",
          "reclaimable",
          "retained",
          "release-pending",
          "release-unknown",
          "released"
        ])
        .optional()
    })
    .strict(),
  "orchestration.worker.show": z
    .object({ dispatchId: remoteControlIdSchema })
    .strict(),
  "orchestration.worker.read": z
    .object({
      dispatchId: remoteControlIdSchema,
      lines: z.number().int().min(1).max(65_536).default(200),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024)
        .default(1024 * 1024)
    })
    .strict(),
  "orchestration.worker.done": z
    .object({
      taskId: remoteControlIdSchema,
      dispatchId: remoteControlIdSchema,
      outcome: z.enum(["succeeded", "failed", "canceled"]),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1024),
      data: jsonValueSchema.optional(),
      reportPath: z.string().trim().min(1).max(4096).optional()
    })
    .strict(),
  "orchestration.worker.heartbeat": z
    .object({
      taskId: remoteControlIdSchema,
      dispatchId: remoteControlIdSchema,
      phase: z.string().trim().min(1).max(256)
    })
    .strict(),
  "orchestration.inbox.check": z
    .object({
      runId: remoteControlIdSchema.optional(),
      dispatchId: remoteControlIdSchema.optional(),
      wait: z.boolean().default(false),
      timeoutMs: z.number().int().min(0).max(60_000).default(30_000),
      ack: remoteControlIdSchema.optional(),
      summary: z.string().max(8_192).optional(),
      types: z
        .array(
          z.enum([
            "caller_task",
            "worker_done",
            "question",
            "escalation",
            "guidance",
            "reply"
          ])
        )
        .max(5)
        .optional()
    })
    .strict()
    .refine(
      (params) => !(params.runId && params.dispatchId),
      "runId and dispatchId are mutually exclusive"
    ),
  "orchestration.status": z.object({ runId: remoteControlIdSchema }).strict(),
  "orchestration.run.list": emptyParamsSchema,
  "orchestration.run.get": z.object({ runId: remoteControlIdSchema }).strict(),
  "orchestration.gate.create": z
    .object({
      runId: remoteControlIdSchema.optional(),
      taskId: remoteControlIdSchema,
      question: z.string().trim().min(1).max(8192),
      options: z
        .array(remoteControlIdSchema)
        .min(1)
        .max(32)
        .refine(
          (values) => new Set(values).size === values.length,
          "Gate options must be unique"
        ),
      requestId: remoteControlIdSchema
    })
    .strict(),
  "orchestration.gate.list": z
    .object({
      runId: remoteControlIdSchema.optional(),
      taskId: remoteControlIdSchema.optional(),
      state: z.enum(["open", "resolved", "canceled"]).optional()
    })
    .strict(),
  "orchestration.gate.resolve": z
    .object({
      runId: remoteControlIdSchema,
      gateId: remoteControlIdSchema,
      resolution: z.string().min(1).max(256)
    })
    .strict(),
  "orchestration.message.post": z
    .object({
      runId: remoteControlIdSchema,
      kind: z.enum(["status", "guidance", "question", "reply", "escalation"]),
      body: jsonValueSchema,
      nodeId: remoteControlIdSchema.optional(),
      attemptId: remoteControlIdSchema.optional(),
      replyToMessageId: remoteControlIdSchema.optional()
    })
    .strict(),
  "orchestration.message.send": z
    .object({
      runId: remoteControlIdSchema.optional(),
      dispatchId: remoteControlIdSchema,
      kind: z.enum(["guidance", "reply"]),
      text: terminalTextSchema,
      replyToMessageId: remoteControlIdSchema.optional()
    })
    .strict(),
  "orchestration.message.ask": z
    .object({
      dispatchId: remoteControlIdSchema,
      text: terminalTextSchema
    })
    .strict(),
  "orchestration.message.escalate": z
    .object({
      dispatchId: remoteControlIdSchema,
      text: terminalTextSchema
    })
    .strict(),
  "orchestration.attempt.cancel": z
    .object({
      attemptId: remoteControlIdSchema,
      idempotencyKey: remoteControlIdSchema
    })
    .strict(),
  "orchestration.attempt.recover": z
    .object({
      attemptId: remoteControlIdSchema,
      resolution: z.enum(["mark-failed", "mark-canceled"]),
      summary: z.string().min(1).max(8_192)
    })
    .strict(),
  "orchestration.attempt.retry": z
    .object({
      attemptId: remoteControlIdSchema,
      idempotencyKey: remoteControlIdSchema,
      placementChangeApproved: z.literal(true).optional()
    })
    .strict(),
  "orchestration.input.disposition": z
    .object({
      attemptId: remoteControlIdSchema,
      disposition: z.enum(["retain", "release"]),
      idempotencyKey: remoteControlIdSchema
    })
    .strict(),
  "workflow.list": emptyParamsSchema,
  "workflow.version.get": z
    .object({ workflowVersionId: remoteControlIdSchema })
    .strict(),
  "workflow.template.list": emptyParamsSchema,
  "workflow.template.get": z
    .object({
      templateId: remoteControlIdSchema,
      definitionId: remoteControlIdSchema
    })
    .strict(),
  "workflow.draft.initialize": z
    .object({
      definitionId: remoteControlIdSchema,
      name: z.string().trim().min(1).max(256)
    })
    .strict(),
  "workflow.draft.create_from_template": z
    .object({
      templateId: remoteControlIdSchema,
      draftId: remoteControlIdSchema,
      definitionId: remoteControlIdSchema
    })
    .strict(),
  "workflow.draft.create": z
    .object({
      draftId: remoteControlIdSchema,
      definitionId: remoteControlIdSchema,
      name: z.string().trim().min(1).max(256),
      canonicalDraft: jsonValueSchema.optional(),
      editorDocument: jsonValueSchema.optional()
    })
    .strict(),
  "workflow.draft.get": z.object({ draftId: remoteControlIdSchema }).strict(),
  "workflow.draft.create_from_run": z
    .object({
      runId: remoteControlIdSchema,
      draftId: remoteControlIdSchema,
      definitionId: remoteControlIdSchema,
      name: z.string().trim().min(1).max(256)
    })
    .strict(),
  "workflow.draft.update": z
    .object({
      draftId: remoteControlIdSchema,
      expectedRevision: z.number().int().min(1),
      canonicalDraft: jsonValueSchema,
      editorDocument: jsonValueSchema
    })
    .strict(),
  "workflow.draft.delete": z
    .object({
      draftId: remoteControlIdSchema,
      expectedRevision: z.number().int().min(1)
    })
    .strict(),
  "workflow.draft.validate": z
    .object({
      draftId: remoteControlIdSchema,
      expectedRevision: z.number().int().min(1).optional()
    })
    .strict(),
  "workflow.publish": z
    .object({
      draftId: remoteControlIdSchema,
      expectedRevision: z.number().int().min(1)
    })
    .strict(),
  "workflow.caller.done": z
    .object({
      runId: remoteControlIdSchema,
      attemptId: remoteControlIdSchema,
      requestId: remoteControlIdSchema,
      result: agentResultSubmissionSchema
    })
    .strict(),
  "workflow.run": z
    .object({
      workflow: remoteControlIdSchema.optional(),
      workflowVersionId: remoteControlIdSchema.optional(),
      expectedDraft: z
        .object({
          draftId: remoteControlIdSchema,
          revision: z.number().int().min(1)
        })
        .strict()
        .optional(),
      runId: remoteControlIdSchema,
      inputs: z
        .record(z.string().min(1).max(256), jsonValueSchema)
        .refine((value) => Object.keys(value).length <= 128)
    })
    .strict()
    .refine(
      (value) => !!value.workflow !== !!value.workflowVersionId,
      "Specify exactly one Workflow title/ID or internal version ID"
    )
    .refine(
      (value) => !value.expectedDraft || Boolean(value.workflow),
      "A saved draft revision requires a Workflow title/ID"
    )
} as const;

export type OrchestrationMethod = keyof typeof orchestrationParamSchemas;
const rendererOrchestrationMethods = [
  "orchestration.status",
  "orchestration.run.list",
  "orchestration.run.get",
  "orchestration.gate.resolve",
  "orchestration.message.post",
  "orchestration.attempt.cancel",
  "orchestration.attempt.recover",
  "orchestration.attempt.retry",
  "orchestration.input.disposition",
  "workflow.list",
  "workflow.version.get",
  "workflow.template.list",
  "workflow.template.get",
  "workflow.draft.initialize",
  "workflow.draft.create_from_template",
  "workflow.draft.create",
  "workflow.draft.get",
  "workflow.draft.create_from_run",
  "workflow.draft.update",
  "workflow.draft.delete",
  "workflow.draft.validate",
  "workflow.publish",
  "workflow.run"
] as const satisfies readonly OrchestrationMethod[];
export type RendererOrchestrationMethod =
  (typeof rendererOrchestrationMethods)[number];
const rendererMethods = new Set<string>(rendererOrchestrationMethods);

export function isRendererOrchestrationMethod(
  method: string
): method is RendererOrchestrationMethod {
  return rendererMethods.has(method);
}

export type OrchestrationParams<M extends OrchestrationMethod> = z.input<
  (typeof orchestrationParamSchemas)[M]
>;
export type ParsedOrchestrationParams<M extends OrchestrationMethod> = z.output<
  (typeof orchestrationParamSchemas)[M]
>;
export type OrchestrationRequest<
  M extends OrchestrationMethod = OrchestrationMethod
> = {
  [K in M]: { readonly method: K; readonly params: OrchestrationParams<K> };
}[M];
export type ParsedOrchestrationRequest<
  M extends OrchestrationMethod = OrchestrationMethod
> = {
  [K in M]: {
    readonly method: K;
    readonly params: ParsedOrchestrationParams<K>;
  };
}[M];
export type OrchestrationResponse<
  M extends OrchestrationMethod = OrchestrationMethod
> = OrchestrationResponses[M];
export type OrchestrationClientRequest<M extends OrchestrationMethod> = {
  readonly method: M;
} & (Record<string, never> extends OrchestrationParams<M>
  ? { readonly params?: OrchestrationParams<M> }
  : { readonly params: OrchestrationParams<M> });

export function isOrchestrationMethod(
  method: string
): method is OrchestrationMethod {
  return Object.hasOwn(orchestrationParamSchemas, method);
}

export * from "./rpcTypes";
