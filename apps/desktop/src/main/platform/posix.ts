export function isPackagedDesktopUpdaterEligible(options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return options.isPackaged === true && options.env?.NODE_ENV !== "test";
}
