import { TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES } from "@kmux/proto";

export function isTerminalMetadataWithinProtocolLimit(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <=
    TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES
  );
}

export function parseOsc7Cwd(data: string): string | undefined {
  if (!data.startsWith("file://")) {
    return undefined;
  }

  try {
    const cwd = decodeURIComponent(new URL(data).pathname);
    return isTerminalMetadataWithinProtocolLimit(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOsc7Cwd(
  _currentCwd: string | undefined,
  data: string
): string | undefined {
  const nextCwd = parseOsc7Cwd(data);
  if (!nextCwd) {
    return undefined;
  }
  return nextCwd;
}
