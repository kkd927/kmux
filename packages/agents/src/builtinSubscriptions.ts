import type { AgentId, SubscriptionProviderUsageVm } from "@kmux/proto";

import { createBuiltinAgentComposition } from "./composition";
import type { AgentSubscriptionRuntimeOptions } from "./contracts";

export {
  detectAntigravitySubscriptionAuth,
  fetchAntigravitySubscriptionUsage
} from "./builtins/antigravity/subscription";
export {
  detectClaudeSubscriptionAuth,
  fetchClaudeSubscriptionUsage
} from "./builtins/claude/subscription";
export {
  detectCodexSubscriptionAuth,
  fetchCodexSubscriptionUsage,
  resolveCodexStatusScriptArgs
} from "./builtins/codex/subscription";
export { formatResetLabel } from "./builtins/subscriptionShared";
export type {
  SubscriptionProviderAuthDetector,
  SubscriptionProviderFetcher
} from "./builtins/subscriptionShared";

interface BuiltinSubscriptionSourceRuntime {
  readonly agentId: AgentId;
  readonly fetch: () => Promise<SubscriptionProviderUsageVm | null>;
  readonly detectAuth: () => Promise<boolean>;
}

export function createBuiltinSubscriptionSources(
  options: AgentSubscriptionRuntimeOptions = {}
): readonly BuiltinSubscriptionSourceRuntime[] {
  return createBuiltinAgentComposition()
    .materialize("subscription")
    .map(({ agentId, capability }) => ({
      agentId,
      fetch: capability.createFetcher(options),
      detectAuth: capability.createAuthDetector(options)
    }));
}
