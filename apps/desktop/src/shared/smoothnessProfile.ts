export const KMUX_PROFILE_LOG_PATH_ENV = "KMUX_PROFILE_LOG_PATH";
export const DEFAULT_SMOOTHNESS_PROFILE_FILENAME = "kmux-smoothness.jsonl";

export type SmoothnessProfileSource = "main" | "renderer" | "pty-host";

export type SmoothnessProfileEventName =
  | "shell.patch.emit"
  | "shell.patch.apply"
  | "shell.selector.notify"
  | "pane-tree.render"
  | "pane-tree.memo-skip"
  | "terminal-pane.render"
  | "terminal.write.bucket"
  | "terminal.ipc.bucket"
  | "terminal.pty.bucket"
  | "terminal.attach.queue"
  | "terminal.fit"
  | "terminal.resize.request"
  | "terminal.resize.ack"
  | "terminal.resize.apply"
  | "terminal.reflow";

export interface SmoothnessProfileEvent {
  source: SmoothnessProfileSource;
  name: SmoothnessProfileEventName;
  at: number;
  details: Record<string, unknown>;
}

export interface SmoothnessProfileRecorder {
  enabled: boolean;
  record(event: SmoothnessProfileEvent): void;
}

export function isSmoothnessProfileEnabled(
  env: Partial<Record<string, string | undefined>> = process.env
): boolean {
  return Boolean(env[KMUX_PROFILE_LOG_PATH_ENV]?.trim());
}
