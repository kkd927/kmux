import { decodeAgentModelOptions, type AgentModelOptionDto } from "@kmux/proto";
import { modelRecord, withAgentModelRpc } from "../../modelRpc";

export async function listClaudeModels(options: {
  command: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentModelOptionDto[]> {
  return withAgentModelRpc({
    ...options,
    args: [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--tools",
      "",
      "--setting-sources",
      "user"
    ],
    decodeResponse(message) {
      if (message.type !== "control_response") return;
      const response = modelRecord(message.response);
      if (typeof response.request_id !== "string") return;
      return {
        id: response.request_id,
        result: response.response,
        ...(response.subtype === "error"
          ? { error: "Claude model query failed" }
          : {})
      };
    },
    async query(rpc) {
      return parseClaudeModels(
        await rpc.request("models", {
          type: "control_request",
          request_id: "models",
          request: { subtype: "initialize" }
        })
      );
    }
  });
}

export function parseClaudeModels(value: unknown): AgentModelOptionDto[] {
  const result = modelRecord(value);
  if (!Array.isArray(result.models))
    throw new TypeError("Claude model list is missing");
  return decodeAgentModelOptions(
    result.models.map((entry) => {
      const model = modelRecord(entry);
      return {
        id: model.value,
        displayName: model.displayName,
        efforts:
          model.supportsEffort === true
            ? (model.supportedEffortLevels ?? [])
            : []
      };
    })
  );
}
