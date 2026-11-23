import {
  decodeAgentId,
  decodeAgentModelOptions,
  type AgentModelOptionDto
} from "@kmux/proto";

/** One in-flight query per provider/configuration, with short-lived metadata. */
export function createAgentModelCatalog(options: {
  load: (agentId: string) => Promise<readonly AgentModelOptionDto[]>;
  contextKey?: (agentId: string) => string;
  now?: () => number;
  ttlMs?: number;
}): { list: (agentId: string) => Promise<AgentModelOptionDto[]> } {
  const cache = new Map<
    string,
    { expiresAt: number; result: Promise<AgentModelOptionDto[]> }
  >();
  const now = options.now ?? Date.now;
  return {
    list(input) {
      const agentId = decodeAgentId(input);
      const key = `${agentId}:${options.contextKey?.(agentId) ?? ""}`;
      const previous = cache.get(key);
      if (previous && previous.expiresAt > now()) return previous.result;
      // Capture configuration synchronously with the cache key; do not defer
      // loading until after a settings update could change the command.
      let query: Promise<readonly AgentModelOptionDto[]>;
      try {
        query = options.load(agentId);
      } catch (error) {
        query = Promise.reject(error);
      }
      const entry = {
        expiresAt: Number.POSITIVE_INFINITY,
        result: query
          .then((models) => {
            entry.expiresAt = now() + (options.ttlMs ?? 120_000);
            return decodeAgentModelOptions(models);
          })
          .catch(() => {
            if (cache.get(key) === entry) cache.delete(key);
            throw new Error(
              "Could not load models. Check the Agent CLI and sign-in, then retry."
            );
          })
      };
      cache.set(key, entry);
      return entry.result;
    }
  };
}
