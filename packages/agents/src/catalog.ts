import {
  decodeAgentDescriptorCatalogDto,
  decodeAgentId,
  normalizeAgentIdInput,
  type AgentDescriptorDto,
  type AgentId
} from "@kmux/proto";

import type { AgentCatalog } from "./contracts";

export function createAgentCatalog(
  descriptors: readonly AgentDescriptorDto[]
): AgentCatalog {
  const values = decodeAgentDescriptorCatalogDto(structuredClone(descriptors));
  const byId = new Map(values.map((descriptor) => [descriptor.id, descriptor]));
  const operationalIds = new Map<AgentId, AgentId>();
  for (const descriptor of values) {
    operationalIds.set(descriptor.id, descriptor.id);
    for (const alias of descriptor.aliases)
      operationalIds.set(alias, descriptor.id);
  }
  return Object.freeze({
    listDescriptors: () => structuredClone(values),
    descriptor(id: AgentId) {
      const descriptor = byId.get(id);
      return descriptor ? structuredClone(descriptor) : undefined;
    },
    resolveOperationalIngress(input: string) {
      const normalized = normalizeAgentIdInput(input);
      try {
        return operationalIds.get(decodeAgentId(normalized));
      } catch {
        return undefined;
      }
    }
  });
}
