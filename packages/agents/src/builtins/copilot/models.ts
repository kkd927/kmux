import { decodeAgentModelOptions, type AgentModelOptionDto } from "@kmux/proto";
import { modelRecord } from "../../modelRpc";

export async function listCopilotModels(options: {
  command: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentModelOptionDto[]> {
  const { withCopilotMetadataRpc } = await import("./subscription");
  return withCopilotMetadataRpc(options, async (rpc) =>
    parseCopilotModels(await rpc.request("models.list", {}))
  );
}

export function parseCopilotModels(value: unknown): AgentModelOptionDto[] {
  const result = modelRecord(value);
  if (!Array.isArray(result.models))
    throw new TypeError("Copilot model list is missing");
  const models = new Map<string, AgentModelOptionDto>();
  for (const entry of result.models) {
    const model = modelRecord(entry);
    if (model.policy && modelRecord(model.policy).state === "disabled")
      continue;
    const [option] = decodeAgentModelOptions([
      {
        id: model.id,
        displayName: model.name,
        efforts: model.supportedReasoningEfforts ?? [],
        ...(typeof model.defaultReasoningEffort === "string"
          ? { defaultEffort: model.defaultReasoningEffort }
          : {})
      }
    ]);
    // Some CLI versions return the Auto entry twice.
    if (
      models.has(option!.id) &&
      JSON.stringify(models.get(option!.id)) !== JSON.stringify(option)
    )
      throw new TypeError("conflicting Copilot model metadata");
    models.set(option!.id, option!);
  }
  return decodeAgentModelOptions([...models.values()]);
}
