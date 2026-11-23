import { join } from "node:path";

import type { AgentSkillPlacementCapability } from "./contracts";

export function createGlobalAgentSkillPlacement(options: {
  readonly defaultHomeRelativePath: string;
  readonly environmentVariable?: string;
}): AgentSkillPlacementCapability {
  return Object.freeze({
    supportedScopes: ["global"] as const,
    resolveRoot(
      input: Parameters<AgentSkillPlacementCapability["resolveRoot"]>[0]
    ) {
      if (input.scope !== "global") return undefined;
      const configuredRoot = options.environmentVariable
        ? input.env?.[options.environmentVariable]
        : undefined;
      const agentRoot =
        configuredRoot && configuredRoot.length > 0
          ? configuredRoot
          : join(input.homeDir, options.defaultHomeRelativePath);
      return join(agentRoot, "skills");
    }
  });
}
