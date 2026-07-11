import type { Id, TerminalKeyInput } from "./index";

export const TERMINAL_DATA_PLANE_PROTOCOL_VERSION = 2 as const;
export const TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES = 128 * 1024;
// Credit is a fixed sliding window. A client may start with less, but it may
// never grow the host's outstanding-output allowance beyond the initial cap.
export const TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES =
  TERMINAL_DATA_PLANE_INITIAL_CREDIT_BYTES;
export const TERMINAL_DATA_PLANE_MAX_INPUT_BYTES = 64 * 1024;
// PTY reads are split before sequencing so every committed delta fits inside
// the fixed 128 KiB initial credit window.
export const TERMINAL_DATA_PLANE_MAX_DELTA_BYTES = 64 * 1024;
export const TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
export const TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS = 2_048;
export const TERMINAL_DATA_PLANE_MAX_CWD_RANGES = 32_768;
export const TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES = 64 * 1024;
// Includes output data and repeated per-segment cwd metadata. Telemetry and
// fixed structured-clone overhead remain intentionally outside this estimate.
export const TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES = 256 * 1024;

const MAX_ID_LENGTH = 512;
const MAX_TERMINAL_DIMENSION = 32_767;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;

export interface TerminalSessionRef {
  surfaceId: Id;
  sessionId: Id;
  epoch: Id;
}

export interface TerminalCwdRange {
  startLine: number;
  endLine: number;
  cwd: string;
}

/**
 * Optional profiling timestamps use high-resolution Unix epoch milliseconds
 * so samples remain comparable across the utility and renderer processes.
 * They are omitted unless smoothness profiling is enabled.
 */
export interface TerminalOutputTelemetry {
  ptyReadAt: number;
  headlessCommitAt: number;
  /** True only when a renderer attachment existed at the PTY read boundary. */
  visibleAtPtyRead?: boolean;
  /** Correlates the first PTY read after an accepted input without its data. */
  inputAcceptedAt?: number;
  inputSequence?: number;
}

export interface TerminalDataPlaneHostTelemetry {
  portSentAt: number;
}

export interface TerminalOutputSegment {
  sequence: number;
  data: string;
  byteLength: number;
  cwd?: string;
  telemetry?: TerminalOutputTelemetry;
}

export interface TerminalCheckpoint {
  format: "xterm-vt/1";
  session: TerminalSessionRef;
  sequence: number;
  data: string;
  cols: number;
  rows: number;
  cwd?: string;
  title?: string;
  cwdRanges?: TerminalCwdRange[];
}

export type TerminalDelta =
  | {
      type: "output";
      fromSequence: number;
      sequence: number;
      byteLength: number;
      segments: TerminalOutputSegment[];
    }
  | {
      type: "resize";
      sequence: number;
      cols: number;
      rows: number;
    };

interface TerminalDataPlaneEnvelope {
  protocol: typeof TERMINAL_DATA_PLANE_PROTOCOL_VERSION;
  attachId: Id;
  session: TerminalSessionRef;
}

interface TerminalDataPlaneHostEnvelope extends TerminalDataPlaneEnvelope {
  telemetry?: TerminalDataPlaneHostTelemetry;
}

export type TerminalDataPlaneDetachReason =
  | "hidden"
  | "workspace-inactive"
  | "surface-closed"
  | "renderer-reload"
  | "replaced";

export type TerminalDataPlaneClientMessage =
  | (TerminalDataPlaneEnvelope & {
      type: "attach";
      resumeFromSequence?: number;
      creditBytes: number;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "credit";
      acknowledgedSequence: number;
      bytes: number;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "input:text";
      text: string;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "input:binary";
      data: string;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "input:key";
      input: TerminalKeyInput;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "resize";
      cols: number;
      rows: number;
      requestId?: Id;
      gestureActive?: boolean;
    })
  | (TerminalDataPlaneEnvelope & {
      type: "detach";
      reason: TerminalDataPlaneDetachReason;
    });

export type TerminalDataPlaneErrorCode =
  | "invalid-message"
  | "session-not-found"
  | "stale-session"
  | "stale-attach"
  | "runtime-lost"
  | "checkpoint-too-large"
  | "internal";

export type TerminalDataPlaneHostMessage =
  | (TerminalDataPlaneHostEnvelope & {
      type: "attached";
      mode: "checkpoint";
      checkpoint: TerminalCheckpoint;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "attached";
      mode: "resume";
      resumedFromSequence: number;
      sequence: number;
      cols: number;
      rows: number;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "delta";
      delta: TerminalDelta;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "resync-required";
      missingFromSequence: number;
      retainedFromSequence: number;
      checkpoint: TerminalCheckpoint;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "resize:ack";
      requestId: Id;
      sequence: number;
      cols: number;
      rows: number;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "exit";
      afterSequence: number;
      exitCode?: number;
    })
  | (TerminalDataPlaneHostEnvelope & {
      type: "error";
      code: TerminalDataPlaneErrorCode;
      message: string;
      recoverable: boolean;
    });

export interface TerminalDataPlaneValidationContext {
  attachId?: Id;
  session?: TerminalSessionRef;
}

export type TerminalDataPlaneValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateTerminalDataPlaneClientMessage(
  value: unknown,
  context: TerminalDataPlaneValidationContext = {}
): TerminalDataPlaneValidationResult<TerminalDataPlaneClientMessage> {
  const envelopeError = validateEnvelope(value, context);
  if (envelopeError) {
    return invalid(envelopeError);
  }

  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "attach": {
      const sequenceError = validateOptionalSequence(
        message.resumeFromSequence,
        "resumeFromSequence"
      );
      if (sequenceError) {
        return invalid(sequenceError);
      }
      if (!isPositiveInteger(message.creditBytes)) {
        return invalid("creditBytes must be a positive integer");
      }
      if (message.creditBytes > TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES) {
        return invalid(
          `creditBytes exceeds ${TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES} bytes`
        );
      }
      break;
    }
    case "credit": {
      const sequenceError = validateSequence(
        message.acknowledgedSequence,
        "acknowledgedSequence"
      );
      if (sequenceError) {
        return invalid(sequenceError);
      }
      if (!isPositiveInteger(message.bytes)) {
        return invalid("bytes must be a positive integer");
      }
      if (message.bytes > TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES) {
        return invalid(
          `bytes exceeds ${TERMINAL_DATA_PLANE_MAX_CREDIT_BYTES} bytes`
        );
      }
      break;
    }
    case "input:text": {
      const error = validateBoundedString(
        message.text,
        "text",
        TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
      );
      if (error) {
        return invalid(error);
      }
      break;
    }
    case "input:binary": {
      const error = validateBinaryString(message.data);
      if (error) {
        return invalid(error);
      }
      break;
    }
    case "input:key": {
      const error = validateTerminalKeyInput(message.input);
      if (error) {
        return invalid(error);
      }
      break;
    }
    case "resize": {
      const dimensionError = validateDimensions(message.cols, message.rows);
      if (dimensionError) {
        return invalid(dimensionError);
      }
      const requestIdError = validateOptionalId(message.requestId, "requestId");
      if (requestIdError) {
        return invalid(requestIdError);
      }
      if (
        message.gestureActive !== undefined &&
        typeof message.gestureActive !== "boolean"
      ) {
        return invalid("gestureActive must be a boolean when provided");
      }
      break;
    }
    case "detach":
      if (!isDetachReason(message.reason)) {
        return invalid("reason is not a supported detach reason");
      }
      break;
    default:
      return invalid("type is not a supported client message type");
  }

  return valid(value as TerminalDataPlaneClientMessage);
}

export function validateTerminalDataPlaneHostMessage(
  value: unknown,
  context: TerminalDataPlaneValidationContext = {}
): TerminalDataPlaneValidationResult<TerminalDataPlaneHostMessage> {
  const envelopeError = validateEnvelope(value, context);
  if (envelopeError) {
    return invalid(envelopeError);
  }

  const message = value as Record<string, unknown>;
  const telemetryError = validateHostTelemetry(message.telemetry);
  if (telemetryError) {
    return invalid(telemetryError);
  }
  const envelopeSession = message.session as TerminalSessionRef;
  switch (message.type) {
    case "attached": {
      if (message.mode === "checkpoint") {
        const checkpointError = validateTerminalCheckpoint(
          message.checkpoint,
          envelopeSession
        );
        if (checkpointError) {
          return invalid(checkpointError);
        }
        break;
      }
      if (message.mode === "resume") {
        const resumedError = validateSequence(
          message.resumedFromSequence,
          "resumedFromSequence"
        );
        const sequenceError = validateSequence(message.sequence, "sequence");
        const dimensionError = validateDimensions(message.cols, message.rows);
        if (resumedError || sequenceError || dimensionError) {
          return invalid(resumedError ?? sequenceError ?? dimensionError ?? "");
        }
        if (
          (message.resumedFromSequence as number) > (message.sequence as number)
        ) {
          return invalid("resumedFromSequence must not exceed sequence");
        }
        break;
      }
      return invalid("attached mode must be checkpoint or resume");
    }
    case "delta": {
      const error = validateTerminalDelta(message.delta);
      if (error) {
        return invalid(error);
      }
      break;
    }
    case "resync-required": {
      const missingError = validateSequence(
        message.missingFromSequence,
        "missingFromSequence"
      );
      const retainedError = validateSequence(
        message.retainedFromSequence,
        "retainedFromSequence"
      );
      const checkpointError = validateTerminalCheckpoint(
        message.checkpoint,
        envelopeSession
      );
      if (missingError || retainedError || checkpointError) {
        return invalid(missingError ?? retainedError ?? checkpointError ?? "");
      }
      if (
        (message.missingFromSequence as number) >=
        (message.retainedFromSequence as number)
      ) {
        return invalid(
          "retainedFromSequence must be newer than missingFromSequence"
        );
      }
      if (
        (message.retainedFromSequence as number) >
        (message.checkpoint as TerminalCheckpoint).sequence + 1
      ) {
        return invalid(
          "checkpoint.sequence must not precede retainedFromSequence"
        );
      }
      break;
    }
    case "resize:ack": {
      const requestIdError = validateId(message.requestId, "requestId");
      const sequenceError = validateSequence(message.sequence, "sequence");
      const dimensionError = validateDimensions(message.cols, message.rows);
      if (requestIdError || sequenceError || dimensionError) {
        return invalid(requestIdError ?? sequenceError ?? dimensionError ?? "");
      }
      break;
    }
    case "exit": {
      const sequenceError = validateSequence(
        message.afterSequence,
        "afterSequence"
      );
      if (sequenceError) {
        return invalid(sequenceError);
      }
      if (
        message.exitCode !== undefined &&
        !Number.isSafeInteger(message.exitCode)
      ) {
        return invalid("exitCode must be a safe integer when provided");
      }
      break;
    }
    case "error":
      if (!isErrorCode(message.code)) {
        return invalid("code is not a supported terminal data plane error");
      }
      {
        const messageError = validateBoundedString(
          message.message,
          "message",
          MAX_ERROR_MESSAGE_BYTES
        );
        if (messageError) {
          return invalid(messageError);
        }
      }
      if (typeof message.recoverable !== "boolean") {
        return invalid("recoverable must be a boolean");
      }
      break;
    default:
      return invalid("type is not a supported host message type");
  }

  return valid(value as TerminalDataPlaneHostMessage);
}

export function isTerminalDataPlaneClientMessage(
  value: unknown,
  context: TerminalDataPlaneValidationContext = {}
): value is TerminalDataPlaneClientMessage {
  return validateTerminalDataPlaneClientMessage(value, context).ok;
}

export function isTerminalDataPlaneHostMessage(
  value: unknown,
  context: TerminalDataPlaneValidationContext = {}
): value is TerminalDataPlaneHostMessage {
  return validateTerminalDataPlaneHostMessage(value, context).ok;
}

function validateEnvelope(
  value: unknown,
  context: TerminalDataPlaneValidationContext
): string | null {
  if (!isRecord(value)) {
    return "message must be an object";
  }
  if (value.protocol !== TERMINAL_DATA_PLANE_PROTOCOL_VERSION) {
    return `protocol must be ${TERMINAL_DATA_PLANE_PROTOCOL_VERSION}`;
  }
  const attachIdError = validateId(value.attachId, "attachId");
  if (attachIdError) {
    return attachIdError;
  }
  const sessionError = validateSessionRef(value.session);
  if (sessionError) {
    return sessionError;
  }
  if (context.attachId !== undefined && value.attachId !== context.attachId) {
    return "attachId does not match the port capability";
  }
  if (
    context.session !== undefined &&
    !sameSessionRef(value.session as TerminalSessionRef, context.session)
  ) {
    return "session does not match the port capability";
  }
  return null;
}

function validateSessionRef(value: unknown): string | null {
  if (!isRecord(value)) {
    return "session must be an object";
  }
  return (
    validateId(value.surfaceId, "session.surfaceId") ??
    validateId(value.sessionId, "session.sessionId") ??
    validateId(value.epoch, "session.epoch")
  );
}

function validateTerminalCheckpoint(
  value: unknown,
  expectedSession: TerminalSessionRef
): string | null {
  if (!isRecord(value)) {
    return "checkpoint must be an object";
  }
  if (value.format !== "xterm-vt/1") {
    return 'checkpoint.format must be "xterm-vt/1"';
  }
  const sessionError = validateSessionRef(value.session);
  if (sessionError) {
    return sessionError;
  }
  if (!sameSessionRef(value.session as TerminalSessionRef, expectedSession)) {
    return "checkpoint.session does not match the message session";
  }
  const sequenceError = validateSequence(value.sequence, "checkpoint.sequence");
  if (sequenceError) {
    return sequenceError;
  }
  const dataError = validateStringWithinBytes(
    value.data,
    "checkpoint.data",
    TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES
  );
  if (dataError) {
    return dataError;
  }
  const dimensionError = validateDimensions(value.cols, value.rows);
  if (dimensionError) {
    return `checkpoint.${dimensionError}`;
  }
  for (const field of ["cwd", "title"] as const) {
    if (value[field] !== undefined) {
      const metadataError = validateStringWithinBytes(
        value[field],
        `checkpoint.${field}`,
        TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
      );
      if (metadataError) {
        return metadataError;
      }
    }
  }
  if (value.cwdRanges !== undefined) {
    if (!Array.isArray(value.cwdRanges)) {
      return "checkpoint.cwdRanges must be an array when provided";
    }
    if (value.cwdRanges.length > TERMINAL_DATA_PLANE_MAX_CWD_RANGES) {
      return `checkpoint.cwdRanges exceeds ${TERMINAL_DATA_PLANE_MAX_CWD_RANGES} entries`;
    }
    for (let index = 0; index < value.cwdRanges.length; index += 1) {
      const range = value.cwdRanges[index];
      if (!isRecord(range)) {
        return `checkpoint.cwdRanges[${index}] must be an object`;
      }
      const rangeInvalid =
        !isNonNegativeInteger(range.startLine) ||
        !isNonNegativeInteger(range.endLine) ||
        (range.endLine as number) < (range.startLine as number) ||
        typeof range.cwd !== "string";
      if (rangeInvalid) {
        return `checkpoint.cwdRanges[${index}] is invalid`;
      }
      if (
        utf8ByteLength(range.cwd as string) >
        TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
      ) {
        return `checkpoint.cwdRanges[${index}].cwd exceeds ${TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES} bytes`;
      }
    }
  }
  return null;
}

function validateTerminalDelta(value: unknown): string | null {
  if (!isRecord(value)) {
    return "delta must be an object";
  }
  if (value.type === "resize") {
    return (
      validateSequence(value.sequence, "delta.sequence") ??
      validateDimensions(value.cols, value.rows)
    );
  }
  if (value.type !== "output") {
    return "delta.type must be output or resize";
  }
  const fromError = validateSequence(value.fromSequence, "delta.fromSequence");
  const sequenceError = validateSequence(value.sequence, "delta.sequence");
  if (fromError || sequenceError) {
    return fromError ?? sequenceError;
  }
  if ((value.sequence as number) <= (value.fromSequence as number)) {
    return "delta.sequence must be newer than delta.fromSequence";
  }
  if (
    !isPositiveInteger(value.byteLength) ||
    value.byteLength > TERMINAL_DATA_PLANE_MAX_DELTA_BYTES
  ) {
    return `delta.byteLength must be between 1 and ${TERMINAL_DATA_PLANE_MAX_DELTA_BYTES}`;
  }
  if (
    !Array.isArray(value.segments) ||
    value.segments.length === 0 ||
    value.segments.length > TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS
  ) {
    return `delta.segments must contain between 1 and ${TERMINAL_DATA_PLANE_MAX_OUTPUT_SEGMENTS} entries`;
  }

  let previousSequence = value.fromSequence as number;
  let declaredBytes = 0;
  let retainedBytes = 0;
  for (let index = 0; index < value.segments.length; index += 1) {
    const segment = value.segments[index];
    if (!isRecord(segment)) {
      return `delta.segments[${index}] must be an object`;
    }
    const segmentSequenceError = validateSequence(
      segment.sequence,
      `delta.segments[${index}].sequence`
    );
    if (segmentSequenceError) {
      return segmentSequenceError;
    }
    if ((segment.sequence as number) <= previousSequence) {
      return "delta segment sequences must be strictly increasing";
    }
    if (typeof segment.data !== "string" || segment.data.length === 0) {
      return `delta.segments[${index}].data must be a non-empty string`;
    }
    if (
      !isPositiveInteger(segment.byteLength) ||
      segment.byteLength > TERMINAL_DATA_PLANE_MAX_DELTA_BYTES
    ) {
      return `delta.segments[${index}].byteLength is invalid`;
    }
    if (utf8ByteLength(segment.data) !== segment.byteLength) {
      return `delta.segments[${index}].byteLength does not match its UTF-8 data`;
    }
    if (segment.cwd !== undefined) {
      const cwdError = validateStringWithinBytes(
        segment.cwd,
        `delta.segments[${index}].cwd`,
        TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
      );
      if (cwdError) {
        return cwdError;
      }
    }
    retainedBytes +=
      (segment.byteLength as number) +
      (typeof segment.cwd === "string" ? utf8ByteLength(segment.cwd) : 0);
    if (retainedBytes > TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES) {
      return `delta retained bytes exceed ${TERMINAL_DATA_PLANE_MAX_DELTA_RETAINED_BYTES}`;
    }
    const telemetryError = validateOutputTelemetry(
      segment.telemetry,
      `delta.segments[${index}].telemetry`
    );
    if (telemetryError) {
      return telemetryError;
    }
    previousSequence = segment.sequence as number;
    declaredBytes += segment.byteLength as number;
    if (declaredBytes > TERMINAL_DATA_PLANE_MAX_DELTA_BYTES) {
      return `delta segment bytes exceed ${TERMINAL_DATA_PLANE_MAX_DELTA_BYTES}`;
    }
  }
  if (previousSequence !== value.sequence) {
    return "the final delta segment sequence must equal delta.sequence";
  }
  if (declaredBytes !== value.byteLength) {
    return "delta.byteLength must equal the sum of segment byteLength values";
  }
  return null;
}

function validateHostTelemetry(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return "telemetry must be an object when provided";
  }
  return validateTimestamp(value.portSentAt, "telemetry.portSentAt");
}

function validateOutputTelemetry(value: unknown, path: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return `${path} must be an object when provided`;
  }
  const readError = validateTimestamp(value.ptyReadAt, `${path}.ptyReadAt`);
  const commitError = validateTimestamp(
    value.headlessCommitAt,
    `${path}.headlessCommitAt`
  );
  if (readError || commitError) {
    return readError ?? commitError;
  }
  if ((value.headlessCommitAt as number) < (value.ptyReadAt as number)) {
    return `${path}.headlessCommitAt must not precede ptyReadAt`;
  }
  if (
    value.visibleAtPtyRead !== undefined &&
    typeof value.visibleAtPtyRead !== "boolean"
  ) {
    return `${path}.visibleAtPtyRead must be a boolean when provided`;
  }
  const hasInputAcceptedAt = value.inputAcceptedAt !== undefined;
  const hasInputSequence = value.inputSequence !== undefined;
  if (hasInputAcceptedAt !== hasInputSequence) {
    return `${path}.inputAcceptedAt and inputSequence must be provided together`;
  }
  if (hasInputAcceptedAt) {
    const acceptedError = validateTimestamp(
      value.inputAcceptedAt,
      `${path}.inputAcceptedAt`
    );
    if (acceptedError) {
      return acceptedError;
    }
    if (
      typeof value.inputSequence !== "number" ||
      !Number.isSafeInteger(value.inputSequence) ||
      value.inputSequence < 0
    ) {
      return `${path}.inputSequence must be a non-negative safe integer`;
    }
    if ((value.inputAcceptedAt as number) > (value.ptyReadAt as number)) {
      return `${path}.inputAcceptedAt must not follow ptyReadAt`;
    }
  }
  return null;
}

function validateTimestamp(value: unknown, path: string): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? null
    : `${path} must be a finite non-negative number`;
}

function validateTerminalKeyInput(value: unknown): string | null {
  if (!isRecord(value) || typeof value.key !== "string") {
    return "input must contain a string key";
  }
  const keyError = validateBoundedString(
    value.key,
    "input.key",
    TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
  );
  if (keyError) {
    return keyError;
  }
  if (value.text !== undefined) {
    const textError = validateBoundedString(
      value.text,
      "input.text",
      TERMINAL_DATA_PLANE_MAX_INPUT_BYTES
    );
    if (textError) {
      return textError;
    }
  }
  const combinedBytes =
    utf8ByteLength(value.key) +
    (typeof value.text === "string" ? utf8ByteLength(value.text) : 0);
  if (combinedBytes > TERMINAL_DATA_PLANE_MAX_INPUT_BYTES) {
    return `input exceeds ${TERMINAL_DATA_PLANE_MAX_INPUT_BYTES} bytes`;
  }
  for (const field of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      return `input.${field} must be a boolean when provided`;
    }
  }
  return null;
}

function validateBinaryString(value: unknown): string | null {
  if (typeof value !== "string") {
    return "data must be a string";
  }
  if (value.length === 0) {
    return "data must not be empty";
  }
  if (value.length > TERMINAL_DATA_PLANE_MAX_INPUT_BYTES) {
    return `data exceeds ${TERMINAL_DATA_PLANE_MAX_INPUT_BYTES} bytes`;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) {
      return "binary input must contain only byte-valued code units";
    }
  }
  return null;
}

function validateDimensions(cols: unknown, rows: unknown): string | null {
  if (!isPositiveInteger(cols) || cols > MAX_TERMINAL_DIMENSION) {
    return `cols must be between 1 and ${MAX_TERMINAL_DIMENSION}`;
  }
  if (!isPositiveInteger(rows) || rows > MAX_TERMINAL_DIMENSION) {
    return `rows must be between 1 and ${MAX_TERMINAL_DIMENSION}`;
  }
  return null;
}

function validateBoundedString(
  value: unknown,
  field: string,
  maxBytes: number
): string | null {
  if (typeof value !== "string") {
    return `${field} must be a string`;
  }
  if (value.length === 0) {
    return `${field} must not be empty`;
  }
  if (utf8ByteLength(value) > maxBytes) {
    return `${field} exceeds ${maxBytes} bytes`;
  }
  return null;
}

function validateStringWithinBytes(
  value: unknown,
  field: string,
  maxBytes: number
): string | null {
  if (typeof value !== "string") {
    return `${field} must be a string`;
  }
  if (utf8ByteLength(value) > maxBytes) {
    return `${field} exceeds ${maxBytes} bytes`;
  }
  return null;
}

function validateOptionalSequence(
  value: unknown,
  field: string
): string | null {
  return value === undefined ? null : validateSequence(value, field);
}

function validateSequence(value: unknown, field: string): string | null {
  return isNonNegativeInteger(value)
    ? null
    : `${field} must be a non-negative safe integer`;
}

function validateOptionalId(value: unknown, field: string): string | null {
  return value === undefined ? null : validateId(value, field);
}

function validateId(value: unknown, field: string): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
    ? null
    : `${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`;
}

function isDetachReason(
  value: unknown
): value is TerminalDataPlaneDetachReason {
  return (
    value === "hidden" ||
    value === "workspace-inactive" ||
    value === "surface-closed" ||
    value === "renderer-reload" ||
    value === "replaced"
  );
}

function isErrorCode(value: unknown): value is TerminalDataPlaneErrorCode {
  return (
    value === "invalid-message" ||
    value === "session-not-found" ||
    value === "stale-session" ||
    value === "stale-attach" ||
    value === "runtime-lost" ||
    value === "checkpoint-too-large" ||
    value === "internal"
  );
}

function sameSessionRef(
  left: TerminalSessionRef,
  right: TerminalSessionRef
): boolean {
  return (
    left.surfaceId === right.surfaceId &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function valid<T>(value: T): TerminalDataPlaneValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): TerminalDataPlaneValidationResult<T> {
  return { ok: false, error };
}
