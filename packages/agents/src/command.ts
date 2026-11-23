import { decodeAgentId, type AgentId } from "@kmux/proto";

import type {
  AgentCommandDefinition,
  AgentLaunchPreferences,
  AgentLaunchPreferencesCapability,
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
  readonly preferenceArgs?: readonly string[];
  readonly agentDescriptorRevision?: string;
  readonly launchPreferences?: {
    readonly requested: AgentLaunchPreferences;
    readonly effective: AgentLaunchPreferences;
    readonly evidence: "executor-applied";
  };
}

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_EXECUTABLE_BYTES = 4 * 1024;

export function resolveAgentLaunchPolicy(options: {
  agentId: AgentId;
  command: AgentCommandDefinition;
  settings?: AgentCommandSettings;
  defaultArgs?: readonly string[];
  preferences?: AgentLaunchPreferences;
  preferencesCapability?: AgentLaunchPreferencesCapability;
}): ResolvedAgentLaunchPolicy {
  const preferences = normalizeLaunchPreferences(options.preferences);
  if (preferences && !options.preferencesCapability) {
    throw new TypeError(
      `agent ${options.agentId} does not support model or effort launch preferences`
    );
  }
  if (preferences?.effort && !preferences.model) {
    throw new TypeError("agent launch effort requires a model");
  }
  if (
    preferences?.effort &&
    !options.preferencesCapability?.supportedEfforts.includes(
      preferences.effort
    )
  ) {
    throw new TypeError(
      `agent ${options.agentId} does not support effort '${preferences.effort}'`
    );
  }
  const preferenceArgs = preferences
    ? options.preferencesCapability!.buildArgs(preferences)
    : [];
  return checkedPolicy(
    options.agentId,
    boundedExecutable(options.settings?.command ?? options.command.executable),
    [
      ...(options.settings?.args ?? options.defaultArgs ?? []),
      ...preferenceArgs
    ],
    preferenceArgs,
    preferences
  );
}

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
    args,
    []
  );
}

function checkedPolicy(
  agentId: AgentId,
  command: string,
  args: readonly string[],
  preferenceArgs: readonly string[],
  preferences?: AgentLaunchPreferences
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
  const normalizedPreferenceArgs = preferenceArgs.map((argument) =>
    boundedArgument(argument)
  );
  return {
    agentId,
    command,
    args: normalizedArgs,
    ...(normalizedPreferenceArgs.length > 0
      ? { preferenceArgs: normalizedPreferenceArgs }
      : {}),
    ...(preferences
      ? {
          launchPreferences: {
            requested: { ...preferences },
            effective: { ...preferences },
            evidence: "executor-applied" as const
          }
        }
      : {})
  };
}

function normalizeLaunchPreferences(
  input: AgentLaunchPreferences | undefined
): AgentLaunchPreferences | undefined {
  if (!input || (input.model === undefined && input.effort === undefined)) {
    return undefined;
  }
  return {
    ...(input.model === undefined
      ? {}
      : { model: boundedPreference(input.model, "model") }),
    ...(input.effort === undefined
      ? {}
      : { effort: boundedPreference(input.effort, "effort") })
  };
}

function boundedPreference(value: string, label: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value) ||
    new TextEncoder().encode(value).byteLength > 256
  ) {
    throw new TypeError(
      `agent launch ${label} must be an opaque provider identifier`
    );
  }
  return value;
}

function boundedArgument(argument: string): string {
  if (
    typeof argument !== "string" ||
    argument.includes("\0") ||
    new TextEncoder().encode(argument).byteLength > MAX_ARGUMENT_BYTES
  ) {
    throw new TypeError("agent argument is invalid");
  }
  return argument;
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
