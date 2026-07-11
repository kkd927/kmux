import type { Terminal } from "@xterm/xterm";

/** Redraws a terminal after its DOM host moves between surface wrappers. */
export function refreshTerminalRenderer(terminal: Terminal): void {
  if (terminal.rows > 0) {
    terminal.refresh(0, terminal.rows - 1);
  }
}
