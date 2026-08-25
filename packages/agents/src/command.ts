import { decodeAgentId, type AgentId } from "@kmux/proto";

import type {
  AgentCommandDefinition,
  AgentResumeCapability
} from "./contracts";

export interface AgentCommandSettings {
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface ResolvedAgentLaunchPolicy {
  readonly agentId: AgentId;
  readonly command: string;
  readonly args: readonly string[];
}

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_EXECUTABLE_BYTES = 4 * 1024;

export function resolveAgentResumePolicy(options: {
  agentId: AgentId;
  command: AgentCommandDefinition;
  resume: AgentResumeCapability;
  sessionId: string;
  settings?: AgentCommandSettings;
  fork?: boolean;
}): ResolvedAgentLaunchPolicy {
  const commonArgs = options.settings?.args ?? [];
  const args = options.resume.build(
    commonArgs,
    boundedSessionId(options.sessionId),
    {
      fork: options.fork
    }
  );
  return checkedPolicy(
    options.agentId,
    boundedExecutable(options.settings?.command ?? options.command.executable),
    args
  );
}

function checkedPolicy(
  agentId: AgentId,
  command: string,
  args: readonly string[]
): ResolvedAgentLaunchPolicy {
  decodeAgentId(agentId);
  if (args.length > MAX_ARGUMENTS)
    throw new TypeError("too many agent arguments");
  const normalizedArgs = args.map((argument) => {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      new TextEncoder().encode(argument).byteLength > MAX_ARGUMENT_BYTES
    ) {
      throw new TypeError("agent argument is invalid");
    }
    return argument;
  });
  return { agentId, command, args: normalizedArgs };
}

function boundedExecutable(value: string): string {
  const command = value.trim();
  if (
    !command ||
    command.includes("\0") ||
    /[\r\n]/u.test(command) ||
    new TextEncoder().encode(command).byteLength > MAX_EXECUTABLE_BYTES
  ) {
    throw new TypeError("agent executable is invalid");
  }
  return command;
}

function boundedSessionId(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    throw new TypeError("agent session id is invalid");
  }
  return value;
}
