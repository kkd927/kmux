import type {
  AgentHookEnvironment as WireAgentHookEnvironment,
  NormalizedAgentEvent,
  NormalizedHookNotification
} from "@kmux/proto";

import { createBuiltinAgentComposition } from "./composition";
import { createAgentHookRuntime } from "./hookRuntime";

const composition = createBuiltinAgentComposition();
const hooks = composition.resolver("hooks");
const runtime = createAgentHookRuntime({ catalog: composition.catalog, hooks });

export function normalizeAgentHookInvocation(
  agentInput: string,
  hookEventInput: string,
  payload: Record<string, unknown> = {},
  environment: WireAgentHookEnvironment = {}
): NormalizedAgentEvent | null {
  return runtime.normalizeEvent(
    agentInput,
    hookEventInput,
    payload,
    environment
  );
}

export function normalizeHookNotificationInvocation(
  agentInput: string,
  hookEventInput: string,
  payload: Record<string, unknown> = {},
  environment: WireAgentHookEnvironment = {}
): NormalizedHookNotification | null {
  return runtime.normalizeNotification(
    agentInput,
    hookEventInput,
    payload,
    environment
  );
}
