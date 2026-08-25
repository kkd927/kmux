import { isAbsolute, join, resolve } from "node:path";

import type { AgentPortablePathRootDefinition } from "./contracts";

export function resolveAgentPortablePath(options: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pathRoot?: AgentPortablePathRootDefinition;
  readonly relativePath: string;
}): string {
  const override = options.pathRoot
    ? absoluteEnvironmentPath(
        options.env?.[options.pathRoot.environmentVariable]
      )
    : undefined;
  const base =
    override ??
    (options.pathRoot
      ? join(options.homeDir, options.pathRoot.defaultHomeRelativePath)
      : options.homeDir);
  return resolve(base, options.relativePath);
}

function absoluteEnvironmentPath(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isAbsolute(trimmed) ? resolve(trimmed) : undefined;
}
