import type { AgentModule } from "../contracts";
import { antigravityAgent } from "./antigravity";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { copilotAgent } from "./copilot";

export const builtinAgentModules = Object.freeze([
  claudeAgent,
  codexAgent,
  copilotAgent,
  antigravityAgent
] satisfies readonly AgentModule[]);
