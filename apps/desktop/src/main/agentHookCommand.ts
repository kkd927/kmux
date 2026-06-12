import { isAbsolute } from "node:path";

export type AgentHookPathEnvName = "KMUX_SOCKET_PATH" | "KMUX_AGENT_BIN_DIR";

export function shellAbsolutePathAssignment(
  targetName: string,
  envName: AgentHookPathEnvName,
  fallback: string | undefined
): string {
  const envValueName = `${targetName}_env`;
  const fallbackPath = normalizedAbsolutePath(fallback);
  const fallbackExpression = fallbackPath ? shellSingleQuote(fallbackPath) : '""';
  return [
    `${envValueName}=\${${envName}:-};`,
    `if [ "\${${envValueName}#/}" != "$${envValueName}" ]; then`,
    `${targetName}="$${envValueName}";`,
    "else",
    `${targetName}=${fallbackExpression};`,
    "fi;"
  ].join(" ");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizedAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}
