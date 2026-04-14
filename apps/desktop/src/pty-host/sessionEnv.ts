const BLOCKED_INHERITED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"] as const;

export function buildSessionEnv(
  baseEnv: NodeJS.ProcessEnv,
  launchEnv: Record<string, string> | undefined,
  sessionEnv: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  for (const key of BLOCKED_INHERITED_ENV_KEYS) {
    delete env[key];
  }

  return {
    ...env,
    COLORTERM: "truecolor",
    ...(launchEnv ?? {}),
    ...sessionEnv
  };
}
