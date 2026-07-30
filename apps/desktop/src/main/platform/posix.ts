import { isAbsolute } from "node:path";

export function isPackagedDesktopUpdaterEligible(options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return options.isPackaged === true && options.env?.NODE_ENV !== "test";
}

export function hasAppImageRuntimeEnv(env: NodeJS.ProcessEnv = {}): boolean {
  return resolveAppImageRuntimePath(env) !== null;
}

export function resolveAppImageRuntimePath(
  env: NodeJS.ProcessEnv = {}
): string | null {
  return normalizeAppImagePath(env.APPIMAGE);
}

export function normalizeAppImagePath(
  value: string | undefined
): string | null {
  const appImagePath = value?.trim();
  if (
    !appImagePath ||
    !isAbsolute(appImagePath) ||
    !appImagePath.endsWith(".AppImage")
  ) {
    return null;
  }
  return appImagePath;
}
