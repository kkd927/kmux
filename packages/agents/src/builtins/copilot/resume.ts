const SELECTORS_WITH_OPTIONAL_VALUE = new Set([
  "--resume",
  "-r",
  "--session-id",
  "--connect"
]);

export function buildCopilotResumeArgs(
  commonArgs: readonly string[],
  sessionId: string
): readonly string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < commonArgs.length; index += 1) {
    const argument = commonArgs[index]!;
    if (argument === "--continue") continue;
    if (SELECTORS_WITH_OPTIONAL_VALUE.has(argument)) {
      const value = commonArgs[index + 1];
      if (value !== undefined && !value.startsWith("-")) index += 1;
      continue;
    }
    if (/^--(?:resume|session-id|connect)=/u.test(argument)) continue;
    if (/^-r=?.+/u.test(argument)) continue;
    sanitized.push(argument);
  }
  return [...sanitized, `--resume=${sessionId}`];
}
