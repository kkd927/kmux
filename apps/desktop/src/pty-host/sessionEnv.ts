import { delimiter } from "node:path";

import type { ShellLaunchPolicy } from "../shared/ptyProtocol";

const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;
const SHELL_MANAGED_ENV_KEYS = ["PATH", "MANPATH", "INFOPATH"] as const;

interface BuildSessionEnvOptions {
  stripShellManagedEnv?: boolean;
  agentPath?: ShellLaunchPolicy["agentPath"];
}

export interface BuildSessionEnvInput {
  baseEnv: NodeJS.ProcessEnv;
  launchEnv?: Record<string, string>;
  hookEnv: ShellLaunchPolicy["hookEnv"];
  sessionEnv: Record<string, string>;
  options?: BuildSessionEnvOptions;
}

export function buildSessionEnv(input: BuildSessionEnvInput): NodeJS.ProcessEnv {
  const {
    baseEnv,
    launchEnv,
    hookEnv,
    sessionEnv,
    options = {}
  } = input;
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  for (const key of BLOCKED_INHERITED_ENV_KEYS) {
    delete env[key];
  }

  if (options.stripShellManagedEnv) {
    for (const key of SHELL_MANAGED_ENV_KEYS) {
      delete env[key];
    }
  }

  const langFallback: NodeJS.ProcessEnv =
    !env.LANG && !env.LC_ALL && !env.LC_CTYPE
      ? { LANG: "en_US.UTF-8" }
      : {};

  const mergedEnv: NodeJS.ProcessEnv = {
    ...env,
    ...langFallback,
    COLORTERM: "truecolor",
    ...(launchEnv ?? {}),
    ...sessionEnv,
    // Hook runtime values come from ShellLaunchPolicy and must remain
    // authoritative for CLI/socket/wrapper continuity.
    ...hookEnv
  };

  if (options.agentPath?.prependWrapperToPath) {
    mergedEnv.PATH = prependPathSegment(
      mergedEnv.PATH,
      options.agentPath.wrapperBinDir
    );
  }

  return mergedEnv;
}

function prependPathSegment(
  pathValue: string | undefined,
  segment: string | undefined
): string | undefined {
  const normalizedSegment = segment?.trim();
  if (!normalizedSegment) {
    return pathValue;
  }
  const parts = (pathValue ?? "")
    .split(delimiter)
    .filter((part) => part && part !== normalizedSegment);
  return [normalizedSegment, ...parts].join(delimiter);
}
