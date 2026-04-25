export function parseOsc7Cwd(data: string): string | undefined {
  if (!data.startsWith("file://")) {
    return undefined;
  }

  try {
    return decodeURIComponent(new URL(data).pathname);
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
