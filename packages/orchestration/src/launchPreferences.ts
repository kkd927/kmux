import type { AgentLaunchPreferences } from "./types";

/** Effort defaults belong to their model; an explicit different model resets them. */
export function resolveWorkflowAgentLaunchPreferences(
  inherited: AgentLaunchPreferences | undefined,
  override: AgentLaunchPreferences | undefined
): AgentLaunchPreferences {
  if (override?.model && override.model !== inherited?.model)
    return { ...override };
  return { ...inherited, ...override };
}
