import rawResponses from "../generated/hook-responses.json";

import { normalizeAgentIdInput } from "@kmux/proto";

interface GeneratedAgentHookResponsePolicy {
  readonly success: Readonly<Record<string, unknown>>;
  readonly fallback: Readonly<Record<string, unknown>>;
  readonly fallbackByEvent: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

export const GENERATED_AGENT_HOOK_RESPONSES = Object.freeze(
  rawResponses as Readonly<Record<string, GeneratedAgentHookResponsePolicy>>
);

export function generatedAgentHookResponse(
  agentInput: string,
  hookEventInput: string,
  outcome: "success" | "fallback" = "success"
): Record<string, unknown> {
  const agentId = normalizeAgentIdInput(agentInput);
  const policy = Object.hasOwn(GENERATED_AGENT_HOOK_RESPONSES, agentId)
    ? GENERATED_AGENT_HOOK_RESPONSES[agentId]
    : undefined;
  if (!policy) return {};
  const normalizedEvent = normalizeHookEvent(hookEventInput);
  const eventResponse = Object.entries(policy.fallbackByEvent).find(
    ([event]) => normalizeHookEvent(event) === normalizedEvent
  )?.[1];
  return {
    ...(eventResponse ??
      (outcome === "success" ? policy.success : policy.fallback))
  };
}

function normalizeHookEvent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}
