import { isAbsolute } from "node:path";

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
  | "terminal.attach.queue.degraded"
  | "terminal.fit"
  | "terminal.resize.request"
  | "terminal.resize.transport"
  | "terminal.resize.ack"
  | "terminal.resize.apply"
  | "terminal.reflow"
  | "terminal.data-plane.receive"
  | "terminal.data-plane.parsed"
  | "terminal.data-plane.render"
  | "terminal.data-plane.paint"
  | "terminal.data-plane.resync"
  | "terminal.data-plane.attach"
  | "terminal.data-plane.cache"
  | "terminal.data-plane.resume-settle"
  | "terminal.data-plane.input"
  | "terminal.data-plane.main-ingress"
  | "terminal.data-plane.supervisor"
  | "pane-divider.drag.start"
  | "pane-divider.drag.end";

export interface SmoothnessProfileEvent {
  source: SmoothnessProfileSource;
  name: SmoothnessProfileEventName;
  at: number;
  details: Record<string, unknown>;
}

export interface SmoothnessProfileRecorder {
  enabled: boolean;
  record(event: SmoothnessProfileEvent): void;
  recordMany?(events: SmoothnessProfileEvent[]): void;
}

export function isSmoothnessProfileEnabled(
  env: Partial<Record<string, string | undefined>> = process.env
): boolean {
  return isSmoothnessProfileLogPathAllowed(env[KMUX_PROFILE_LOG_PATH_ENV]);
}

export function isSmoothnessProfileLogPathAllowed(
  configuredPath: string | undefined
): boolean {
  const normalized = configuredPath?.trim();
  return Boolean(normalized && isAbsolute(normalized));
}
