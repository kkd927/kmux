import { isAbsolute } from "node:path";

import type { PtyRequest } from "../shared/ptyProtocol";
import {
  resolvePolicyShellArgs,
  resolvePolicyShellPath
} from "../shared/ptyProtocol";
import { prepareShellIntegrationLaunch } from "./shellIntegration";
import { buildSessionEnv } from "./sessionEnv";

export interface PtySpawnLaunch {
  shellPath: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  requiresShellReady: boolean;
}

export function resolvePtySpawnLaunch(
  request: Extract<PtyRequest, { type: "spawn" }>,
  baseEnv: NodeJS.ProcessEnv = process.env
): PtySpawnLaunch {
  const shellPolicy = request.shellLaunchPolicy;
  const shell = resolvePolicyShellPath(shellPolicy, request.spec.launch);
  const args = resolvePolicyShellArgs(shellPolicy, request.spec.launch);
  const env = buildSessionEnv({
    baseEnv,
    launchEnv: request.spec.launch.env,
    hookEnv: shellPolicy.hookEnv,
    sessionEnv: request.spec.env,
    options: {
      stripShellManagedEnv: shellPolicy.stripManagedEnv,
      agentPath: shellPolicy.agentPath
    }
  });
  const preparedLaunch = prepareShellIntegrationLaunch(shell, args, env, {
    enabled:
      shellPolicy.integration.enabled &&
      shellPolicy.integration.mode === "posix-wrapper",
    agentPath: shellPolicy.agentPath
  });

  return {
    shellPath: preparedLaunch.shellPath,
    args: preparedLaunch.args,
    cwd: resolvePtySpawnCwd(request.spec.launch.cwd, baseEnv),
    env: preparedLaunch.env,
    requiresShellReady: preparedLaunch.requiresShellReady
  };
}

function resolvePtySpawnCwd(
  launchCwd: string | undefined,
  baseEnv: NodeJS.ProcessEnv
): string | undefined {
  const explicitCwd = nonBlankAbsolutePath(launchCwd);
  if (explicitCwd) {
    return explicitCwd;
  }
  return nonBlankAbsolutePath(baseEnv.HOME) ?? undefined;
}

function nonBlankAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}
