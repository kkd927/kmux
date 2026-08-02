import { UPDATE_RELAUNCH_PARENT_TIMEOUT_MS } from "./linuxUpdateTiming";

export const KMUX_UPDATE_RELAUNCH_PARENT_PID =
  "KMUX_UPDATE_RELAUNCH_PARENT_PID";
export { UPDATE_RELAUNCH_PARENT_TIMEOUT_MS } from "./linuxUpdateTiming";
const UPDATE_RELAUNCH_PARENT_POLL_MS = 100;

export type LinuxSingleInstanceStatus =
  | "not-required"
  | "acquired"
  | "denied"
  | "parent-timeout";

export interface LinuxSingleInstanceResult {
  status: LinuxSingleInstanceStatus;
  parentPid?: number;
}

export interface UpdateRelaunchEnvironment {
  restore(): void;
}

export function prepareUpdateRelaunchEnvironment(
  env: NodeJS.ProcessEnv,
  parentPid: number
): UpdateRelaunchEnvironment {
  const previousParentPid = env[KMUX_UPDATE_RELAUNCH_PARENT_PID];
  env[KMUX_UPDATE_RELAUNCH_PARENT_PID] = String(parentPid);
  let active = true;

  return {
    restore(): void {
      if (!active) {
        return;
      }
      active = false;
      if (previousParentPid === undefined) {
        delete env[KMUX_UPDATE_RELAUNCH_PARENT_PID];
        return;
      }
      env[KMUX_UPDATE_RELAUNCH_PARENT_PID] = previousParentPid;
    }
  };
}

interface LinuxSingleInstanceOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  currentPid?: number;
  requestLock(): boolean;
  isProcessRunning?: (pid: number) => boolean;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
}

export async function acquireLinuxSingleInstanceLock(
  options: LinuxSingleInstanceOptions
): Promise<LinuxSingleInstanceResult> {
  if (options.platform !== "linux" || !options.isPackaged) {
    return { status: "not-required" };
  }

  const parentPid = consumeUpdateRelaunchParentPid(
    options.env,
    options.currentPid ?? process.pid
  );
  if (parentPid !== null) {
    const parentExited = await waitForProcessExit(parentPid, options);
    if (!parentExited) {
      return { status: "parent-timeout", parentPid };
    }
  }

  return options.requestLock()
    ? {
        status: "acquired",
        ...(parentPid === null ? {} : { parentPid })
      }
    : {
        status: "denied",
        ...(parentPid === null ? {} : { parentPid })
      };
}

export function consumeUpdateRelaunchParentPid(
  env: NodeJS.ProcessEnv,
  currentPid: number
): number | null {
  const rawValue = env[KMUX_UPDATE_RELAUNCH_PARENT_PID];
  delete env[KMUX_UPDATE_RELAUNCH_PARENT_PID];
  if (!rawValue || !/^\d+$/u.test(rawValue.trim())) {
    return null;
  }
  const parentPid = Number.parseInt(rawValue, 10);
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid === currentPid
  ) {
    return null;
  }
  return parentPid;
}

async function waitForProcessExit(
  parentPid: number,
  options: LinuxSingleInstanceOptions
): Promise<boolean> {
  const isProcessRunning = options.isProcessRunning ?? processIsRunning;
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const timeoutMs = options.timeoutMs ?? UPDATE_RELAUNCH_PARENT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? UPDATE_RELAUNCH_PARENT_POLL_MS;
  const deadline = now() + timeoutMs;

  while (isProcessRunning(parentPid)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      schedule(resolve, Math.min(pollMs, remainingMs));
    });
  }
  return true;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
