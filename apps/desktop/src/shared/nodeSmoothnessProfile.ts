import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { stringifyJson } from "./json";

import {
  DEFAULT_SMOOTHNESS_PROFILE_FILENAME,
  KMUX_PROFILE_LOG_PATH_ENV,
  type SmoothnessProfileEvent,
  type SmoothnessProfileRecorder,
  isSmoothnessProfileEnabled,
  isSmoothnessProfileLogPathAllowed
} from "./smoothnessProfile";

export function createNodeSmoothnessProfileRecorder(
  env: Partial<Record<string, string | undefined>> = process.env
): SmoothnessProfileRecorder {
  const configuredPath = env[KMUX_PROFILE_LOG_PATH_ENV]?.trim();
  const logPath =
    configuredPath && isSmoothnessProfileEnabled(env)
      ? resolveNodeSmoothnessProfileLogPath(configuredPath)
      : null;

  const recordMany = (events: SmoothnessProfileEvent[]): void => {
    if (!logPath || events.length === 0) {
      return;
    }
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `${events.map((event) => stringifyJson(event)).join("\n")}\n`,
        "utf8"
      );
    } catch {
      // Profiling must never affect terminal/runtime behavior.
    }
  };

  return {
    enabled: Boolean(logPath),
    record(event: SmoothnessProfileEvent): void {
      recordMany([event]);
    },
    recordMany
  };
}

export function resolveNodeSmoothnessProfileLogPath(
  configuredPath: string
): string | null {
  const normalized = configuredPath.trim();
  if (!isSmoothnessProfileLogPathAllowed(normalized)) {
    return null;
  }
  if (isDirectoryLikeProfilePath(normalized)) {
    return join(normalized, DEFAULT_SMOOTHNESS_PROFILE_FILENAME);
  }
  return normalized;
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
