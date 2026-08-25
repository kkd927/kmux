import type { AgentProcessDetectionCapability } from "./contracts";

export function createAgentProcessMatcher(
  definition: AgentProcessDetectionCapability
): (commandLine: string) => boolean {
  const executableBasenames = normalizedNames(definition.executableBasenames);
  const wrapperAliases = normalizedNames(definition.wrapperAliases ?? []);
  const packageNames = normalizedNames(definition.packageNames ?? []);
  return (commandLine) => {
    const tokens = tokenizeCommandLine(commandLine);
    for (const token of tokens) {
      const normalized = token.toLowerCase().replace(/\\/gu, "/");
      const basename =
        normalized.split("/").filter(Boolean).at(-1) ?? normalized;
      const withoutScriptExtension = basename.replace(/\.(?:c|m)?js$/u, "");
      if (
        executableBasenames.has(basename) ||
        executableBasenames.has(withoutScriptExtension) ||
        wrapperAliases.has(basename) ||
        [...packageNames].some(
          (name) =>
            normalized === name ||
            normalized.endsWith(`/${name}`) ||
            normalized.includes(`/${name}/`)
        )
      ) {
        return true;
      }
    }
    return false;
  };
}

function normalizedNames(values: readonly string[]): Set<string> {
  return new Set(
    values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  for (const character of commandLine.slice(0, 16 * 1024)) {
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      else token += character;
      continue;
    }
    if (/\s/u.test(character) && quote === undefined) {
      if (token) tokens.push(token);
      token = "";
      if (tokens.length >= 32) break;
      continue;
    }
    token += character;
  }
  if (token && tokens.length < 32) tokens.push(token);
  return tokens;
}
