import { decodeAgentId, type AgentId, type AgentSettings } from "@kmux/proto";

import type { AgentCatalog } from "./contracts";

export function normalizeAgentScopeSettings(options: {
  readonly value: Readonly<Record<string, AgentSettings>> | undefined;
  readonly catalog: AgentCatalog;
}): ReadonlyMap<AgentId, AgentSettings> {
  const executable = new Map<AgentId, AgentSettings>();
  for (const [input, settings] of Object.entries(options.value ?? {})) {
    const id = decodeAgentId(input);
    if (options.catalog.descriptor(id)) {
      executable.set(id, structuredClone(settings));
    }
  }
  return executable;
}
