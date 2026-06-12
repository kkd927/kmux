import { homedir } from "node:os";
import { env as processEnv } from "node:process";

import { resolveAppPaths } from "@kmux/persistence";

export interface ResolveCliSocketPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  uid?: number;
}

export function resolveCliSocketPath({
  env = processEnv,
  homeDir = env.HOME ?? homedir(),
  platform = process.platform,
  uid = process.getuid?.()
}: ResolveCliSocketPathOptions = {}): string {
  const explicitSocketPath = env.KMUX_SOCKET_PATH?.trim();
  if (explicitSocketPath) {
    return explicitSocketPath;
  }
  return resolveAppPaths({
    homeDir,
    env,
    platform,
    uid
  }).socketPath;
}
