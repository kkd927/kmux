import rawDefinitions from "../generated/command-wrappers.json";

import type { ResolvedAgentCommandWrapperDefinition } from "./contracts";

export const GENERATED_AGENT_COMMAND_WRAPPERS = Object.freeze(
  rawDefinitions as readonly ResolvedAgentCommandWrapperDefinition[]
);
