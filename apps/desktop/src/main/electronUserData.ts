import { mkdirSync } from "node:fs";

export const KMUX_ELECTRON_USER_DATA_DIR_ENV =
  "KMUX_ELECTRON_USER_DATA_DIR";

export interface ElectronUserDataApp {
  setPath(name: "userData", path: string): void;
}

export function resolveElectronUserDataDir(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env[KMUX_ELECTRON_USER_DATA_DIR_ENV];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function configureElectronUserDataDir({
  app,
  env = process.env,
  mkdir = mkdirSync
}: {
  app: ElectronUserDataApp;
  env?: NodeJS.ProcessEnv;
  mkdir?: (path: string, options: { recursive: true }) => void;
}): string | null {
  const userDataDir = resolveElectronUserDataDir(env);
  if (!userDataDir) {
    return null;
  }
  mkdir(userDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
  return userDataDir;
}
