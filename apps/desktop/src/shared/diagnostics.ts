import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const DIAGNOSTICS_LOG_PATH_ENV = "KMUX_DEBUG_LOG_PATH";
export const PTY_STDOUT_LOGS_ENV = "KMUX_PTY_STDOUT_LOGS";

interface DiagnosticsFormatOptions {
  now?: Date;
  pid?: number;
}

export function formatLocalLogTimestamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const milliseconds = String(now.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
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
  const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
  if (!resolvedLogPath) {
    return false;
  }

  try {
    mkdirSync(dirname(resolvedLogPath), { recursive: true });
    appendFileSync(
      resolvedLogPath,
      formatDiagnosticsRecord(scope, details),
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

export function resolveDiagnosticsLogPath(
  logPath: string | undefined
): string | undefined {
  const normalized = logPath?.trim();
  return normalized && isAbsolute(normalized) ? normalized : undefined;
}
