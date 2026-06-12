export function isPackagedDesktopUpdaterEligible(options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return options.isPackaged === true && options.env?.NODE_ENV !== "test";
}

export function hasAppImageRuntimeEnv(env: NodeJS.ProcessEnv = {}): boolean {
  const appImagePath = env.APPIMAGE?.trim();
  return typeof appImagePath === "string" && appImagePath.endsWith(".AppImage");
}
