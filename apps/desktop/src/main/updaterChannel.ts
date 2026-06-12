export function resolveAutoUpdaterChannel(options: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): string | null {
  if (options.platform === "darwin" && options.arch === "arm64") {
    return "latest-arm64";
  }
  return null;
}
