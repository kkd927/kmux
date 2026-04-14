import {basename} from "node:path";

export function resolveDefaultShellArgs(
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== "darwin" || !shellPath) {
    return [];
  }

  switch (basename(shellPath).toLowerCase()) {
    case "zsh":
    case "sh":
    case "fish":
      return ["-l"];
    case "bash":
      return ["--login"];
    case "pwsh":
    case "pwsh.exe":
      return ["-Login"];
    default:
      return [];
  }
}

export function shouldStripShellManagedEnv(
  shellPath: string | undefined,
  launchArgs: string[] | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    platform === "darwin" &&
    launchArgs === undefined &&
    resolveDefaultShellArgs(shellPath, platform).length > 0
  );
}
