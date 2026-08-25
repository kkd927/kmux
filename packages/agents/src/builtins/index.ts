import type { AgentModule } from "../contracts";
import { antigravityAgent } from "./antigravity";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";

export const builtinAgentModules = Object.freeze([
  claudeAgent,
  codexAgent,
  antigravityAgent
] satisfies readonly AgentModule[]);
