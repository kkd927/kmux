import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { stringifyJson } from "./json";

export const DIAGNOSTICS_LOG_PATH_ENV = "KMUX_DEBUG_LOG_PATH";
export const PTY_STDOUT_LOGS_ENV = "KMUX_PTY_STDOUT_LOGS";
export const DEFAULT_DIAGNOSTICS_LOG_FILE_NAME = "kmux-debug.log";
export const MAX_DIAGNOSTICS_LOG_BYTES = 20 * 1024 * 1024;

export interface DiagnosticsRecord {
  at: string;
  pid: number;
  scope: string;
  details: Record<string, unknown>;
  terminalTelemetry: boolean;
}

export type DiagnosticsRecordSink = (record: DiagnosticsRecord) => boolean;

let diagnosticsRecordSink: DiagnosticsRecordSink | null = null;

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
  } ${stringifyJson(record)}\n`;
}

export function formatStructuredDiagnosticsRecord(
  record: DiagnosticsRecord
): string {
  return `${record.at} pid=${record.pid} ${stringifyJson({
    scope: record.scope,
    ...record.details
  })}\n`;
}

export function setDiagnosticsRecordSink(
  sink: DiagnosticsRecordSink | null
): void {
  diagnosticsRecordSink = sink;
}

export function logDiagnostics(
  scope: string,
  details: Record<string, unknown> = {},
  logPath: string | undefined = process.env[DIAGNOSTICS_LOG_PATH_ENV]
): boolean {
  return recordDiagnostics(scope, details, false, logPath);
}

export function logTerminalDiagnostics(
  scope: string,
  details: Record<string, unknown> = {}
): boolean {
  return recordDiagnostics(scope, details, true);
}

function recordDiagnostics(
  scope: string,
  details: Record<string, unknown>,
  terminalTelemetry: boolean,
  logPath: string | undefined = process.env[DIAGNOSTICS_LOG_PATH_ENV]
): boolean {
  const sink = diagnosticsRecordSink;
  const resolvedLogPath = sink ? undefined : resolveDiagnosticsLogPath(logPath);
  if (!sink && !resolvedLogPath) {
    return false;
  }

  const structuredRecord: DiagnosticsRecord = {
    at: new Date().toISOString(),
    pid: process.pid,
    scope,
    details,
    terminalTelemetry
  };

  try {
    stringifyJson({ scope, ...details });
  } catch {
    return false;
  }

  if (sink) {
    try {
      return sink(structuredRecord);
    } catch {
      return false;
    }
  }
  if (!resolvedLogPath) {
    return false;
  }

  let fileDescriptor: number | undefined;

  try {
    const formattedRecord = formatDiagnosticsRecord(scope, details);
    const originalRecordBytes = Buffer.byteLength(formattedRecord);
    const record =
      originalRecordBytes <= MAX_DIAGNOSTICS_LOG_BYTES
        ? formattedRecord
        : formatDiagnosticsRecord(scope, {
            diagnosticRecordTruncated: true,
            originalRecordBytes
          });
    const recordBytes = Buffer.byteLength(record);
    mkdirSync(dirname(resolvedLogPath), { recursive: true, mode: 0o700 });
    fileDescriptor = openSync(resolvedLogPath, "a", 0o600);
    fchmodSync(fileDescriptor, 0o600);
    if (
      fstatSync(fileDescriptor).size + recordBytes >
      MAX_DIAGNOSTICS_LOG_BYTES
    ) {
      ftruncateSync(fileDescriptor, 0);
    }
    writeSync(fileDescriptor, record, null, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Diagnostics must never interfere with app behavior.
      }
    }
  }
}

export function prepareExistingDiagnosticsLogFile(
  logPath: string | undefined
): boolean {
  const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
  if (!resolvedLogPath) {
    return false;
  }

  let fileDescriptor: number | undefined;
  try {
    chmodSync(resolvedLogPath, 0o600);
    fileDescriptor = openSync(resolvedLogPath, "r+");
    if (fstatSync(fileDescriptor).size > MAX_DIAGNOSTICS_LOG_BYTES) {
      ftruncateSync(fileDescriptor, 0);
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Diagnostics maintenance must never interfere with app startup.
      }
    }
  }
}

export function clearDiagnosticsLog(logPath: string | undefined): boolean {
  const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
  if (!resolvedLogPath) {
    return false;
  }

  try {
    rmSync(resolvedLogPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function clearDiagnosticsLogForEnableTransition(options: {
  previouslyEnabled: boolean;
  nextEnabled: boolean;
  logPath: string;
}): boolean | undefined {
  return options.nextEnabled && !options.previouslyEnabled
    ? clearDiagnosticsLog(options.logPath)
    : undefined;
}

export function resolveDiagnosticsLogPath(
  logPath: string | undefined
): string | undefined {
  const normalized = logPath?.trim();
  return normalized && isAbsolute(normalized) ? normalized : undefined;
}

export function resolveEffectiveDiagnosticsLogPath(options: {
  settingsEnabled: boolean;
  settingsLogPath: string;
}): string | undefined {
  return options.settingsEnabled
    ? resolveDiagnosticsLogPath(options.settingsLogPath)
    : undefined;
}

export function applyDiagnosticsLogPath(
  env: NodeJS.ProcessEnv,
  logPath: string | undefined
): string | undefined {
  const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
  if (resolvedLogPath) {
    env[DIAGNOSTICS_LOG_PATH_ENV] = resolvedLogPath;
  } else {
    delete env[DIAGNOSTICS_LOG_PATH_ENV];
  }
  return resolvedLogPath;
}
