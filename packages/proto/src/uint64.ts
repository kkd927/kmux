declare const uint64Brand: unique symbol;

export type Uint64 = bigint & { readonly [uint64Brand]: true };

export const UINT64_MAX = (1n << 64n) - 1n;
const CANONICAL_UINT64_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

export function uint64(value: bigint): Uint64 {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new RangeError("uint64 must be between 0 and 2^64 - 1");
  }
  return value as Uint64;
}

export function parseUint64Decimal(value: unknown): Uint64 {
  if (typeof value !== "string" || !CANONICAL_UINT64_DECIMAL.test(value)) {
    throw new TypeError("uint64 JSON value must be a canonical decimal string");
  }
  return uint64(BigInt(value));
}

export function formatUint64Decimal(value: Uint64): string {
  return value.toString(10);
}

export function incrementUint64(value: Uint64): Uint64 {
  return uint64(value + 1n);
}

export function uint64FromBytes(bytes: Uint8Array): Uint64 {
  if (bytes.byteLength !== 8) {
    throw new RangeError("network uint64 must contain exactly eight bytes");
  }
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return uint64(value);
}

export function uint64ToBytes(value: Uint64): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining: bigint = value;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}
