import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  DEFAULT_SMOOTHNESS_PROFILE_FILENAME,
  KMUX_PROFILE_LOG_PATH_ENV,
  type SmoothnessProfileEvent,
  type SmoothnessProfileRecorder,
  isSmoothnessProfileEnabled
} from "./smoothnessProfile";

export function createNodeSmoothnessProfileRecorder(
  env: Partial<Record<string, string | undefined>> = process.env
): SmoothnessProfileRecorder {
  const configuredPath = env[KMUX_PROFILE_LOG_PATH_ENV]?.trim();
  const logPath =
    configuredPath && isSmoothnessProfileEnabled(env)
      ? resolveNodeSmoothnessProfileLogPath(configuredPath)
      : null;

  return {
    enabled: Boolean(logPath),
    record(event: SmoothnessProfileEvent): void {
      if (!logPath) {
        return;
      }
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // Profiling must never affect terminal/runtime behavior.
      }
    }
  };
}

export function resolveNodeSmoothnessProfileLogPath(
  configuredPath: string
): string {
  if (isDirectoryLikeProfilePath(configuredPath)) {
    return join(configuredPath, DEFAULT_SMOOTHNESS_PROFILE_FILENAME);
  }
  return configuredPath;
}

export function profileNowMs(): number {
  return performance.now();
}

function isDirectoryLikeProfilePath(configuredPath: string): boolean {
  if (/[\\/]$/.test(configuredPath)) {
    return true;
  }
  try {
    if (existsSync(configuredPath) && statSync(configuredPath).isDirectory()) {
      return true;
    }
  } catch {
    return false;
  }
  return extname(basename(configuredPath)) === "";
}
