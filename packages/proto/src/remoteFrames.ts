import { uint64FromBytes, uint64ToBytes, type Uint64 } from "./uint64";

export const REMOTE_FRAME_HARD_MAX_BYTES = 1024 * 1024;
export const REMOTE_CONTROL_HARD_MAX_BYTES = 256 * 1024;
export const REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES = 256 * 1024;
export const REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES = 256 * 1024;
export const REMOTE_CHECKPOINT_HARD_MAX_CHUNKS = 1_024;
export const REMOTE_CHECKPOINT_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_METADATA_CHUNK_HARD_MAX_BYTES = 256 * 1024;
export const REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES = 64 * 1024;

export type RemoteFrameKind = 1 | 2 | 3 | 4 | 5;

export interface RemoteFrame {
  kind: RemoteFrameKind;
  payload: Uint8Array;
}

export type RemoteTerminalWireMessage =
  | { kind: "output"; sequence: Uint64; data: Uint8Array }
  | { kind: "resize"; sequence: Uint64; cols: number; rows: number }
  | { kind: "exit"; sequence: Uint64; exitCode?: number }
  | {
      kind: "input";
      writerLeaseId: string;
      attachmentId: string;
      inputSequence: Uint64;
      data: Uint8Array;
    }
  | {
      kind: "resize-request";
      writerLeaseId: string;
      attachmentId: string;
      cols: number;
      rows: number;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeRemoteFrame(
  kind: RemoteFrameKind,
  payload: Uint8Array
): Uint8Array {
  validateFramePayload(kind, payload.byteLength);
  const frameLength = payload.byteLength + 1;
  const encoded = new Uint8Array(frameLength + 4);
  new DataView(encoded.buffer).setUint32(0, frameLength, false);
  encoded[4] = kind;
  encoded.set(payload, 5);
  return encoded;
}

export class RemoteFrameDecoder {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): RemoteFrame[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("remote frame chunks must be Uint8Array values");
    }
    if (
      this.pending.byteLength + chunk.byteLength >
      REMOTE_FRAME_HARD_MAX_BYTES + 4
    ) {
      throw new RangeError("remote frame buffer exceeds its hard limit");
    }
    const joined = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    joined.set(this.pending);
    joined.set(chunk, this.pending.byteLength);

    const frames: RemoteFrame[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= 4) {
      const frameLength = new DataView(
        joined.buffer,
        joined.byteOffset + offset,
        4
      ).getUint32(0, false);
      if (frameLength === 0 || frameLength > REMOTE_FRAME_HARD_MAX_BYTES) {
        throw new RangeError("remote frame length is outside its hard bound");
      }
      if (joined.byteLength - offset < frameLength + 4) break;
      const kind = requireFrameKind(joined[offset + 4]);
      const payloadLength = frameLength - 1;
      validateFramePayload(kind, payloadLength);
      const payload = joined.slice(offset + 5, offset + 4 + frameLength);
      frames.push({ kind, payload });
      offset += frameLength + 4;
    }
    this.pending = joined.slice(offset);
    return frames;
  }

  finish(): void {
    if (this.pending.byteLength !== 0) {
      throw new TypeError("remote frame stream ended with a truncated frame");
    }
  }
}

export function encodeRemoteTerminalWireMessage(
  message: RemoteTerminalWireMessage
): Uint8Array {
  switch (message.kind) {
    case "output": {
      if (message.data.byteLength > REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES - 9) {
        throw new RangeError("remote terminal output chunk exceeds its limit");
      }
      const payload = new Uint8Array(9 + message.data.byteLength);
      payload[0] = 1;
      payload.set(uint64ToBytes(message.sequence), 1);
      payload.set(message.data, 9);
      return payload;
    }
    case "resize": {
      const payload = new Uint8Array(13);
      payload[0] = 2;
      payload.set(uint64ToBytes(message.sequence), 1);
      const view = new DataView(payload.buffer);
      view.setUint16(9, requireDimension(message.cols), false);
      view.setUint16(11, requireDimension(message.rows), false);
      return payload;
    }
    case "exit": {
      const payload = new Uint8Array(message.exitCode === undefined ? 10 : 14);
      payload[0] = 3;
      payload.set(uint64ToBytes(message.sequence), 1);
      payload[9] = message.exitCode === undefined ? 0 : 1;
      if (message.exitCode !== undefined) {
        if (!Number.isSafeInteger(message.exitCode)) {
          throw new TypeError("remote terminal exit code must be an integer");
        }
        new DataView(payload.buffer).setInt32(10, message.exitCode, false);
      }
      return payload;
    }
    case "input": {
      if (message.data.byteLength > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES) {
        throw new RangeError("remote terminal input exceeds its limit");
      }
      const writerLeaseId = encodeWireId(message.writerLeaseId);
      const attachmentId = encodeWireId(message.attachmentId);
      const payload = new Uint8Array(
        1 +
          2 +
          writerLeaseId.byteLength +
          2 +
          attachmentId.byteLength +
          8 +
          message.data.byteLength
      );
      let offset = 0;
      payload[offset++] = 16;
      offset = writeLengthPrefixed(payload, offset, writerLeaseId);
      offset = writeLengthPrefixed(payload, offset, attachmentId);
      payload.set(uint64ToBytes(message.inputSequence), offset);
      offset += 8;
      payload.set(message.data, offset);
      return payload;
    }
    case "resize-request": {
      const writerLeaseId = encodeWireId(message.writerLeaseId);
      const attachmentId = encodeWireId(message.attachmentId);
      const payload = new Uint8Array(
        1 + 2 + writerLeaseId.byteLength + 2 + attachmentId.byteLength + 4
      );
      let offset = 0;
      payload[offset++] = 17;
      offset = writeLengthPrefixed(payload, offset, writerLeaseId);
      offset = writeLengthPrefixed(payload, offset, attachmentId);
      const view = new DataView(payload.buffer);
      view.setUint16(offset, requireDimension(message.cols), false);
      view.setUint16(offset + 2, requireDimension(message.rows), false);
      return payload;
    }
  }
}

export function decodeRemoteTerminalWireMessage(
  payload: Uint8Array
): RemoteTerminalWireMessage {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
    throw new TypeError("remote terminal payload is empty or invalid");
  }
  switch (payload[0]) {
    case 1:
      if (payload.byteLength < 9) {
        throw new TypeError("remote output payload is truncated");
      }
      return {
        kind: "output",
        sequence: uint64FromBytes(payload.subarray(1, 9)),
        data: payload.slice(9)
      };
    case 2:
      if (payload.byteLength !== 13) {
        throw new TypeError("remote resize mutation has an invalid length");
      }
      return {
        kind: "resize",
        sequence: uint64FromBytes(payload.subarray(1, 9)),
        cols: requireDimension(
          new DataView(payload.buffer, payload.byteOffset).getUint16(9, false)
        ),
        rows: requireDimension(
          new DataView(payload.buffer, payload.byteOffset).getUint16(11, false)
        )
      };
    case 3: {
      if (
        (payload.byteLength !== 10 && payload.byteLength !== 14) ||
        (payload[9] !== 0 && payload[9] !== 1) ||
        (payload[9] === 0 && payload.byteLength !== 10) ||
        (payload[9] === 1 && payload.byteLength !== 14)
      ) {
        throw new TypeError("remote exit mutation has an invalid payload");
      }
      return {
        kind: "exit",
        sequence: uint64FromBytes(payload.subarray(1, 9)),
        ...(payload[9] === 1
          ? {
              exitCode: new DataView(
                payload.buffer,
                payload.byteOffset
              ).getInt32(10, false)
            }
          : {})
      };
    }
    case 16: {
      let offset = 1;
      const writerLease = readLengthPrefixed(payload, offset);
      offset = writerLease.nextOffset;
      const attachment = readLengthPrefixed(payload, offset);
      offset = attachment.nextOffset;
      if (payload.byteLength - offset < 8) {
        throw new TypeError("remote input payload is truncated");
      }
      const inputSequence = uint64FromBytes(
        payload.subarray(offset, offset + 8)
      );
      offset += 8;
      const data = payload.slice(offset);
      if (data.byteLength > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES) {
        throw new RangeError("remote terminal input exceeds its limit");
      }
      return {
        kind: "input",
        writerLeaseId: decodeWireId(writerLease.value),
        attachmentId: decodeWireId(attachment.value),
        inputSequence,
        data
      };
    }
    case 17: {
      let offset = 1;
      const writerLease = readLengthPrefixed(payload, offset);
      offset = writerLease.nextOffset;
      const attachment = readLengthPrefixed(payload, offset);
      offset = attachment.nextOffset;
      if (payload.byteLength - offset !== 4) {
        throw new TypeError("remote resize request has an invalid length");
      }
      const view = new DataView(payload.buffer, payload.byteOffset);
      return {
        kind: "resize-request",
        writerLeaseId: decodeWireId(writerLease.value),
        attachmentId: decodeWireId(attachment.value),
        cols: requireDimension(view.getUint16(offset, false)),
        rows: requireDimension(view.getUint16(offset + 2, false))
      };
    }
    default:
      throw new TypeError("remote terminal message kind is unknown");
  }
}

function requireFrameKind(value: number): RemoteFrameKind {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 5) {
    throw new TypeError("remote frame kind is unknown");
  }
  return value;
}

function validateFramePayload(kind: RemoteFrameKind, bytes: number): void {
  const maximum =
    kind === 1
      ? REMOTE_CONTROL_HARD_MAX_BYTES
      : kind === 2
        ? REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES
        : kind === 3
          ? REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES
          : kind === 4
            ? REMOTE_METADATA_CHUNK_HARD_MAX_BYTES
            : REMOTE_CONTROL_HARD_MAX_BYTES;
  if (bytes < 0 || bytes > maximum || bytes + 1 > REMOTE_FRAME_HARD_MAX_BYTES) {
    throw new RangeError("remote frame payload exceeds its kind limit");
  }
}

function requireDimension(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32_767) {
    throw new RangeError("remote terminal dimension is outside 1..32767");
  }
  return value;
}

function encodeWireId(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError("remote terminal identity is invalid");
  }
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength > 256) {
    throw new RangeError("remote terminal identity exceeds 256 bytes");
  }
  return encoded;
}

function decodeWireId(value: Uint8Array): string {
  return textDecoder.decode(value);
}

function writeLengthPrefixed(
  target: Uint8Array,
  offset: number,
  value: Uint8Array
): number {
  new DataView(target.buffer).setUint16(offset, value.byteLength, false);
  target.set(value, offset + 2);
  return offset + 2 + value.byteLength;
}

function readLengthPrefixed(
  payload: Uint8Array,
  offset: number
): { value: Uint8Array; nextOffset: number } {
  if (payload.byteLength - offset < 2) {
    throw new TypeError("remote terminal identity length is truncated");
  }
  const length = new DataView(payload.buffer, payload.byteOffset).getUint16(
    offset,
    false
  );
  if (
    length === 0 ||
    length > 256 ||
    payload.byteLength - offset - 2 < length
  ) {
    throw new TypeError("remote terminal identity length is invalid");
  }
  return {
    value: payload.slice(offset + 2, offset + 2 + length),
    nextOffset: offset + 2 + length
  };
}
