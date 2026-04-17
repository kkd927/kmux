import { z } from "zod";

const emptyParamsSchema = z.object({}).strict();
const splitDirectionSchema = z.enum(["left", "right", "up", "down"]);
const logLevelSchema = z.enum(["info", "warn", "error"]);
const sidebarStatusVariantSchema = z.enum([
  "info",
  "attention",
  "muted",
  "error"
]);
const agentEventSchema = z.enum([
  "session_start",
  "running",
  "needs_input",
  "turn_complete",
  "idle",
  "session_end"
]);

const socketEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional()
});

const socketParamSchemas = {
  "workspace.list": emptyParamsSchema,
  "workspace.create": z
    .object({
      name: z.string().optional(),
      cwd: z.string().optional()
    })
    .strict(),
  "workspace.select": z
    .object({
      workspaceId: z.string().min(1)
    })
    .strict(),
  "workspace.current": emptyParamsSchema,
  "workspace.close": z
    .object({
      workspaceId: z.string().min(1)
    })
    .strict(),
  "surface.list": z
    .object({
      workspaceId: z.string().min(1).optional()
    })
    .strict(),
  "surface.split": z
    .object({
      paneId: z.string().min(1),
      direction: splitDirectionSchema
    })
    .strict(),
  "surface.focus": z
    .object({
      surfaceId: z.string().min(1).optional()
    })
    .strict(),
  "surface.send_text": z
    .object({
      surfaceId: z.string().min(1).optional(),
      text: z.string()
    })
    .strict(),
  "surface.send_key": z
    .object({
      surfaceId: z.string().min(1).optional(),
      key: z.string().min(1)
    })
    .strict(),
  "notification.create": z
    .object({
      workspaceId: z.string().min(1).optional(),
      paneId: z.string().min(1).optional(),
      surfaceId: z.string().min(1).optional(),
      title: z.string(),
      message: z.string()
    })
    .strict(),
  "notification.list": emptyParamsSchema,
  "notification.clear": z
    .object({
      notificationId: z.string().min(1).optional()
    })
    .strict(),
  "sidebar.set_status": z
    .object({
      workspaceId: z.string().min(1).optional(),
      surfaceId: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      label: z.string().optional(),
      text: z.string(),
      variant: sidebarStatusVariantSchema.optional()
    })
    .strict(),
  "sidebar.clear_status": z
    .object({
      workspaceId: z.string().min(1).optional(),
      key: z.string().min(1).optional()
    })
    .strict(),
  "agent.event": z
    .object({
      workspaceId: z.string().min(1).optional(),
      paneId: z.string().min(1).optional(),
      surfaceId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      agent: z.string().min(1),
      event: agentEventSchema,
      title: z.string().optional(),
      message: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional()
    })
    .strict(),
  "sidebar.set_progress": z
    .object({
      workspaceId: z.string().min(1).optional(),
      value: z.coerce.number(),
      label: z.string().optional()
    })
    .strict(),
  "sidebar.clear_progress": z
    .object({
      workspaceId: z.string().min(1).optional()
    })
    .strict(),
  "sidebar.log": z
    .object({
      workspaceId: z.string().min(1).optional(),
      level: logLevelSchema.optional(),
      message: z.string()
    })
    .strict(),
  "sidebar.clear_log": z
    .object({
      workspaceId: z.string().min(1).optional()
    })
    .strict(),
  "sidebar.state": emptyParamsSchema,
  sidebar_state: emptyParamsSchema,
  "system.ping": emptyParamsSchema,
  "system.capabilities": emptyParamsSchema,
  "system.identify": emptyParamsSchema
} as const;

export type SocketRpcMethod = keyof typeof socketParamSchemas;
export type ParsedSocketRequest = {
  [TMethod in SocketRpcMethod]: {
    id?: string;
    method: TMethod;
    params: z.infer<(typeof socketParamSchemas)[TMethod]>;
    authToken?: string;
  };
}[SocketRpcMethod];

export class UnknownSocketMethodError extends Error {
  constructor(method: string) {
    super(`Unknown method: ${method}`);
    this.name = "UnknownSocketMethodError";
  }
}

export function parseSocketEnvelope(line: string): {
  id?: string;
  method: string;
  params: Record<string, unknown>;
  authToken?: string;
} {
  const envelope = socketEnvelopeSchema.parse(JSON.parse(line));
  const params = envelope.params ?? {};
  return {
    id: envelope.id,
    method: envelope.method,
    params,
    authToken:
      typeof params.authToken === "string" ? params.authToken : undefined
  };
}

export function parseSocketRequest(
  method: string,
  params: Record<string, unknown>,
  id?: string,
  authToken?: string
): ParsedSocketRequest {
  if (!isSocketRpcMethod(method)) {
    throw new UnknownSocketMethodError(method);
  }

  const { authToken: _authToken, ...methodParams } = params;
  return {
    id,
    method,
    params: socketParamSchemas[method].parse(methodParams),
    authToken
  } as ParsedSocketRequest;
}

function isSocketRpcMethod(method: string): method is SocketRpcMethod {
  return Object.hasOwn(socketParamSchemas, method);
}
