import { decodeAgentModelOptions, type AgentModelOptionDto } from "@kmux/proto";
import { modelRecord, withAgentModelRpc } from "../../modelRpc";

export async function listCodexModels(options: {
  command: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentModelOptionDto[]> {
  return withAgentModelRpc({
    ...options,
    args: ["app-server"],
    decodeResponse(message) {
      if (typeof message.id !== "number") return;
      return {
        id: message.id,
        result: message.result,
        ...(message.error ? { error: "Codex model query failed" } : {})
      };
    },
    async query(rpc) {
      await rpc.request(1, {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "kmux-models", version: "1.0" } }
      });
      rpc.notify({ method: "initialized", params: {} });
      let cursor: string | undefined;
      let requestId = 2;
      const cursors = new Set<string>();
      const models: AgentModelOptionDto[] = [];
      do {
        const id = requestId++;
        const result = modelRecord(
          await rpc.request(id, {
            id,
            method: "model/list",
            params: {
              limit: 100,
              includeHidden: false,
              ...(cursor ? { cursor } : {})
            }
          })
        );
        models.push(...parseCodexModels(result));
        if (models.length > 256) throw new Error("Too many Codex models");
        cursor =
          typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Codex model cursor did not advance");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return decodeAgentModelOptions(models);
    }
  });
}

export function parseCodexModels(value: unknown): AgentModelOptionDto[] {
  const result = modelRecord(value);
  if (!Array.isArray(result.data))
    throw new TypeError("Codex model list is missing");
  return decodeAgentModelOptions(
    result.data.flatMap((entry) => {
      const model = modelRecord(entry);
      if (model.hidden === true) return [];
      if (!Array.isArray(model.supportedReasoningEfforts))
        throw new TypeError("Codex model efforts are missing");
      return [
        {
          id: model.model,
          displayName: model.displayName,
          efforts: model.supportedReasoningEfforts.map(
            (effort) => modelRecord(effort).reasoningEffort
          ),
          ...(typeof model.defaultReasoningEffort === "string"
            ? { defaultEffort: model.defaultReasoningEffort }
            : {})
        }
      ];
    })
  );
}
