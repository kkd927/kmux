import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DIAGNOSTICS_LOG_PATH_ENV = "KMUX_DEBUG_LOG_PATH";
export const PTY_STDOUT_LOGS_ENV = "KMUX_PTY_STDOUT_LOGS";

interface DiagnosticsFormatOptions {
  now?: Date;
  pid?: number;
}

export function formatDiagnosticsRecord(
  scope: string,
  details: Record<string, unknown> = {},
  options: DiagnosticsFormatOptions = {}
): string {
  const record = {
    scope,
    ...details
  };
  return `${(options.now ?? new Date()).toISOString()} pid=${
    options.pid ?? process.pid
  } ${JSON.stringify(record)}\n`;
}

export function logDiagnostics(
  scope: string,
  details: Record<string, unknown> = {},
  logPath: string | undefined = process.env[DIAGNOSTICS_LOG_PATH_ENV]
): boolean {
  if (!logPath) {
    return false;
  }

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, formatDiagnosticsRecord(scope, details), "utf8");
    return true;
  } catch {
    return false;
  }
}
