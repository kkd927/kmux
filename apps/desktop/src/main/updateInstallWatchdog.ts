import { UPDATE_INSTALL_EXIT_TIMEOUT_MS } from "./linuxUpdateTiming";

export { UPDATE_INSTALL_EXIT_TIMEOUT_MS } from "./linuxUpdateTiming";

interface UpdateInstallWatchdogOptions {
  exit(code: number): void;
  onTimeout(timeoutMs: number): void;
  timeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface UpdateInstallWatchdog {
  arm(): void;
  disarm(): void;
}

export function createUpdateInstallWatchdog(
  options: UpdateInstallWatchdogOptions
): UpdateInstallWatchdog {
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const timeoutMs = options.timeoutMs ?? UPDATE_INSTALL_EXIT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;

  return {
    arm(): void {
      if (timer) {
        return;
      }
      timer = schedule(() => {
        timer = null;
        try {
          options.onTimeout(timeoutMs);
        } finally {
          options.exit(0);
        }
      }, timeoutMs);
      timer.unref?.();
    },
    disarm(): void {
      if (!timer) {
        return;
      }
      cancel(timer);
      timer = null;
    }
  };
}
