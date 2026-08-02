import { LINUX_SHUTDOWN_TIMEOUT_MS } from "./linuxUpdateTiming";

export { LINUX_SHUTDOWN_TIMEOUT_MS } from "./linuxUpdateTiming";

export interface ShutdownTask {
  name: string;
  stop(): void | Promise<void>;
}

export interface ShutdownTaskFailure {
  name: string;
  error: unknown;
}

export interface ShutdownTaskOutcome {
  failures: ShutdownTaskFailure[];
  timedOut: string[];
}

interface ShutdownTaskOptions {
  timeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export async function settleShutdownTasks(
  tasks: ShutdownTask[],
  options: ShutdownTaskOptions = {}
): Promise<ShutdownTaskOutcome> {
  const timeoutMs = options.timeoutMs ?? LINUX_SHUTDOWN_TIMEOUT_MS;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const pending = new Set(tasks.map((task) => task.name));
  const failures: ShutdownTaskFailure[] = [];

  const taskPromises = tasks.map((task) =>
    Promise.resolve()
      .then(() => task.stop())
      .catch((error) => {
        failures.push({ name: task.name, error });
        throw error;
      })
      .finally(() => {
        pending.delete(task.name);
      })
  );
  const settled = Promise.allSettled(taskPromises).then(
    () => "settled" as const
  );

  let deadline: NodeJS.Timeout | null = null;
  const timedOut = new Promise<"timeout">((resolve) => {
    deadline = schedule(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([settled, timedOut]);
  if (deadline) {
    cancel(deadline);
  }

  return {
    failures: [...failures],
    timedOut: result === "timeout" ? [...pending] : []
  };
}
