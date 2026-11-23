import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeAgentModelOptions, type AgentModelOptionDto } from "@kmux/proto";
import type { AgentLaunchPreferences } from "../../contracts";

const execFileAsync = promisify(execFile);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TIER_SUFFIX = /-(low|medium|high|xhigh|max)$/u;

export async function listAntigravityModels(options: {
  command: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentModelOptionDto[]> {
  const { stdout } = await execFileAsync(options.command, ["models"], {
    cwd: options.homeDir,
    env: options.env,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  return parseAntigravityModels(stdout);
}

/** The CLI enumerates tiered IDs; the common picker displays model + effort. */
export function parseAntigravityModels(text: string): AgentModelOptionDto[] {
  const groups = new Map<string, AgentModelOptionDto>();
  for (const line of text.split(/\r?\n/u).filter((value) => value.trim())) {
    const [id, label] = line.split("\t");
    if (!id || !label) throw new TypeError("AGY model list is malformed");
    const tier = id.match(TIER_SUFFIX)?.[1];
    const groupId = tier ? id.replace(TIER_SUFFIX, "") : id;
    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        displayName: tier
          ? label.replace(/\s*\((?:Low|Medium|High|Xhigh|Max)\)$/iu, "")
          : label,
        efforts: [],
        ...(tier
          ? { effortRequired: true, defaultEffort: tier, variants: [] }
          : {})
      };
      groups.set(groupId, group);
    }
    if (tier) {
      if (group.efforts.includes(tier))
        throw new TypeError("duplicate AGY model tier");
      group.efforts.push(tier);
      group.variants!.push({ model: id, effort: tier });
    }
  }
  for (const model of groups.values())
    model.efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return decodeAgentModelOptions([...groups.values()]);
}

export function resolveAntigravityPreferences(
  preferences: AgentLaunchPreferences
): AgentLaunchPreferences {
  if (!preferences.model || !preferences.effort) return preferences;
  // A tiered model already identifies its effort. Passing --effort alongside
  // that ID is rejected by AGY; select the requested sibling ID instead.
  return {
    model: `${preferences.model.replace(TIER_SUFFIX, "")}-${preferences.effort}`
  };
}
