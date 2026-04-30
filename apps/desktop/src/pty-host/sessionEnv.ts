const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;
const SHELL_MANAGED_ENV_KEYS = ["PATH", "MANPATH", "INFOPATH"] as const;

interface BuildSessionEnvOptions {
  stripShellManagedEnv?: boolean;
}

export function buildSessionEnv(
  baseEnv: NodeJS.ProcessEnv,
  launchEnv: Record<string, string> | undefined,
  sessionEnv: Record<string, string>,
  options: BuildSessionEnvOptions = {}
): NodeJS.ProcessEnv {
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

  return {
    ...env,
    ...langFallback,
    COLORTERM: "truecolor",
    ...(launchEnv ?? {}),
    ...sessionEnv
  };
}
