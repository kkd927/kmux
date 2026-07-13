import type { Id, TerminalDataPlaneErrorCode } from "@kmux/proto";

const MAX_ID_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 4 * 1024;
const TERMINAL_DATA_PLANE_ERROR_CODES: Record<
  TerminalDataPlaneErrorCode,
  true
> = {
  "invalid-message": true,
  "session-not-found": true,
  "stale-session": true,
  "stale-attach": true,
  "runtime-lost": true,
  "checkpoint-too-large": true,
  internal: true
};

export type TerminalStreamError =
  | {
      kind: "invalid-message";
      message: string;
    }
  | {
      kind: "sequence-gap";
      expectedSequence: number;
      receivedSequence: number;
      message: string;
    }
  | {
      kind: "host-error";
      code: TerminalDataPlaneErrorCode;
      message: string;
      recoverable: boolean;
    }
  | {
      kind: "sink-error" | "port-error";
      message: string;
    };

export interface TerminalStreamErrorReport {
  surfaceId: Id;
  sessionId: Id;
  error: TerminalStreamError;
}

export function normalizeTerminalStreamErrorReport(
  value: unknown
): TerminalStreamErrorReport | null {
  if (
    !isRecord(value) ||
    !isValidId(value.surfaceId) ||
    !isValidId(value.sessionId)
  ) {
    return null;
  }

  const error = normalizeTerminalStreamError(value.error);
  if (!error) {
    return null;
  }

  return {
    surfaceId: value.surfaceId,
    sessionId: value.sessionId,
    error
  };
}

function normalizeTerminalStreamError(
  value: unknown
): TerminalStreamError | null {
  if (!isRecord(value)) {
    return null;
  }

  const message = normalizeMessage(value.message);
  if (message === null) {
    return null;
  }

  switch (value.kind) {
    case "invalid-message":
      return { kind: value.kind, message };
    case "sequence-gap":
      if (
        !isSequence(value.expectedSequence) ||
        !isSequence(value.receivedSequence)
      ) {
        return null;
      }
      return {
        kind: value.kind,
        expectedSequence: value.expectedSequence,
        receivedSequence: value.receivedSequence,
        message
      };
    case "host-error":
      if (
        !isTerminalDataPlaneErrorCode(value.code) ||
        typeof value.recoverable !== "boolean"
      ) {
        return null;
      }
      return {
        kind: value.kind,
        code: value.code,
        message,
        recoverable: value.recoverable
      };
    case "sink-error":
    case "port-error":
      return { kind: value.kind, message };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is Id {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTerminalDataPlaneErrorCode(
  value: unknown
): value is TerminalDataPlaneErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TERMINAL_DATA_PLANE_ERROR_CODES, value)
  );
}

function normalizeMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}
