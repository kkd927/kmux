import type {
  AgentHookEnvironment as WireAgentHookEnvironment,
  NormalizedAgentEvent,
  NormalizedHookNotification
} from "@kmux/proto";

import type { AgentCatalog, CapabilityResolver } from "./contracts";

export interface AgentHookRuntime {
  normalizeEvent(
    agentInput: string,
    hookEventInput: string,
    payload?: Record<string, unknown>,
    environment?: WireAgentHookEnvironment
  ): NormalizedAgentEvent | null;
  normalizeNotification(
    agentInput: string,
    hookEventInput: string,
    payload?: Record<string, unknown>,
    environment?: WireAgentHookEnvironment
  ): NormalizedHookNotification | null;
}

export function createAgentHookRuntime(options: {
  readonly catalog: AgentCatalog;
  readonly hooks: CapabilityResolver<"hooks">;
}): AgentHookRuntime {
  return Object.freeze({
    normalizeEvent(
      agentInput: string,
      hookEventInput: string,
      payload: Record<string, unknown> = {},
      environment: WireAgentHookEnvironment = {}
    ): NormalizedAgentEvent | null {
      const agentId = options.catalog.resolveOperationalIngress(agentInput);
      if (!agentId) return null;
      const capability = options.hooks.resolve(agentId);
      if (!capability) return null;
      const rawEvent =
        hookEventInput || stringField(payload, "hook_event_name") || "";
      const normalized = capability.normalize(rawEvent, payload);
      if (!normalized) return null;
      const explicitHookEvent = hookEventInput.trim();
      const details = {
        ...(normalized.details ?? {}),
        ...(explicitHookEvent
          ? { kmux_hook_event_arg: explicitHookEvent.slice(0, 160) }
          : {})
      };
      return {
        ...hookTarget(payload, environment),
        ...(normalized.vendorSessionId
          ? { vendorSessionId: normalized.vendorSessionId }
          : {}),
        agent: agentId,
        event: normalized.event,
        ...(normalized.title ? { title: normalized.title } : {}),
        ...(normalized.message ? { message: normalized.message } : {}),
        ...(normalized.details !== undefined || explicitHookEvent
          ? { details }
          : {})
      };
    },
    normalizeNotification(
      agentInput: string,
      hookEventInput: string,
      payload: Record<string, unknown> = {},
      environment: WireAgentHookEnvironment = {}
    ): NormalizedHookNotification | null {
      const agentId = options.catalog.resolveOperationalIngress(agentInput);
      if (!agentId) return null;
      const capability = options.hooks.resolve(agentId);
      if (!capability?.normalizeNotification) return null;
      const rawEvent =
        hookEventInput || stringField(payload, "hook_event_name") || "";
      const normalized = capability.normalizeNotification(
        normalizeHookEventName(rawEvent),
        payload
      );
      if (!normalized) return null;
      return {
        ...hookTarget(payload, environment),
        agent: agentId,
        source: "agent",
        title: normalized.title,
        message: normalized.message
      };
    }
  });
}

function normalizeHookEventName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
}

function hookTarget(
  payload: Record<string, unknown>,
  environment: WireAgentHookEnvironment
): {
  workspaceId?: string;
  paneId?: string;
  surfaceId?: string;
  sessionId?: string;
} {
  const surfaceId = firstString(
    stringField(payload, "surface_id"),
    stringField(payload, "surfaceId"),
    environment.KMUX_SURFACE_ID
  );
  return {
    workspaceId: firstString(
      stringField(payload, "workspace_id"),
      stringField(payload, "workspaceId"),
      environment.KMUX_WORKSPACE_ID
    ),
    paneId: firstString(
      stringField(payload, "pane_id"),
      stringField(payload, "paneId")
    ),
    surfaceId,
    sessionId: firstString(
      environment.KMUX_SESSION_ID,
      stringField(payload, "kmux_session_id"),
      stringField(payload, "kmuxSessionId"),
      surfaceId
    )
  };
}
