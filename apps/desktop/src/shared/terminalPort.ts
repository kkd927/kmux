import type { Id, TerminalSessionRef } from "@kmux/proto";

export const KMUX_TERMINAL_PORT_CHANNEL = "kmux:terminal-port";
export const KMUX_TERMINAL_PORT_WINDOW_MESSAGE = "kmux:terminal-port-transfer";

export interface TerminalStreamGrant {
  attachId: Id;
  session: TerminalSessionRef;
}

export type TerminalStreamAttachResult =
  | {
      status: "granted";
      grant: TerminalStreamGrant;
    }
  | {
      status: "retryable-not-ready";
      reason: "runtime-not-ready" | "runtime-bind-race" | "channel-unavailable";
    }
  | {
      status: "denied";
      reason:
        | "not-current-surface"
        | "invalid-frame"
        | "renderer-transfer-failed";
    };

export interface TerminalPortWindowMessage {
  type: typeof KMUX_TERMINAL_PORT_WINDOW_MESSAGE;
  grant: TerminalStreamGrant;
}
