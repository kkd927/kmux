export const KMUX_RAW_OUTPUT_ROOT_ENV = "KMUX_RAW_OUTPUT_ROOT";
export const KMUX_NATIVE_CACHE_ROOT_ENV = "KMUX_NATIVE_CACHE_ROOT";

export function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}

export function mergeEnv(
  ...sources: Array<NodeJS.ProcessEnv | Record<string, string | undefined>>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}
