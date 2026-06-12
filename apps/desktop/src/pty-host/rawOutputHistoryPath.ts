import { isAbsolute, join } from "node:path";

import type { Id } from "@kmux/proto";

import { KMUX_RAW_OUTPUT_ROOT_ENV } from "../shared/platform/env";

export function resolveRawOutputHistoryDir(
  sessionId: Id,
  surfaceId: Id,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const explicitRoot = env[KMUX_RAW_OUTPUT_ROOT_ENV]?.trim();
  const root =
    explicitRoot && isAbsolute(explicitRoot)
      ? explicitRoot
      : join(cwd, ".kmux/dev/state/pty-raw");
  return join(
    root,
    `${safePathSegment(sessionId)}-${safePathSegment(surfaceId)}`
  );
}

function safePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
