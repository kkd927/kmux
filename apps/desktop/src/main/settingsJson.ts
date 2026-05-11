import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface SettingsJsonShell {
  openPath: (path: string) => Promise<string>;
  showItemInFolder: (path: string) => void;
}

export type SettingsJsonOpenResult =
  | { action: "skipped-test" }
  | { action: "opened" }
  | { action: "revealed"; error: string };

type OpenSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export async function openSettingsJsonFile(options: {
  nodeEnv: string | undefined;
  platform: NodeJS.Platform;
  settingsPath: string;
  shell: SettingsJsonShell;
  openWithTextEditor?: (path: string) => Promise<string>;
}): Promise<SettingsJsonOpenResult> {
  if (options.nodeEnv === "test") {
    return { action: "skipped-test" };
  }

  if (options.platform === "darwin" && options.openWithTextEditor) {
    const textEditorError = await options.openWithTextEditor(
      options.settingsPath
    );
    if (!textEditorError) {
      return { action: "opened" };
    }
  }

  const openPathError = await options.shell.openPath(options.settingsPath);
  if (!openPathError) {
    return { action: "opened" };
  }

  options.shell.showItemInFolder(options.settingsPath);
  return { action: "revealed", error: openPathError };
}

export function openWithMacTextEditor(
  path: string,
  spawnProcess: OpenSpawner = spawn
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnProcess("open", ["-t", path], {
      detached: true,
      stdio: "ignore"
    });

    const settle = (error: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(error);
    };

    child.once("error", (error) => {
      settle(error.message);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        settle("");
        return;
      }
      settle(
        code !== null
          ? `open -t exited with code ${code}`
          : `open -t exited with signal ${signal ?? "unknown"}`
      );
    });
  });
}
