import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";

/** Replays serialized display state into headless xterm, never into PTY stdin. */
export async function restoreTerminalHistory(
  terminal: Terminal,
  vt: string
): Promise<void> {
  const write = (text: string) =>
    new Promise<void>((resolve) => terminal.write(text, resolve));
  await write(vt);
  // Older checkpoints include live input modes. Re-serialize display content
  // before handing the emulator to a different process.
  const display = new SerializeAddon();
  terminal.loadAddon(display);
  const displayVt = display.serialize({ excludeModes: true });
  display.dispose();
  terminal.reset();
  await write(displayVt);
  const active = terminal.buffer.active;
  const alternateScreen =
    active.type === "alternate"
      ? Array.from(
          { length: active.length },
          (_, row) => active.getLine(row)?.translateToString(true) ?? ""
        ).join("\r\n")
      : "";
  // Keep the last full-screen UI as readable history, then let the new process
  // start with normal input modes and scrollback rather than inherited TUI modes.
  await write(
    (active.type === "alternate" ? "\u001b[?1049l" : "") +
      "\u001b[0m\u001b[?2004l\u001b[?1l\u001b[?25h\u001b[r"
  );
  const normal = terminal.buffer.active;
  let lastRow = normal.cursorY;
  for (let row = terminal.rows - 1; row > lastRow; row--) {
    if (normal.getLine(normal.baseY + row)?.translateToString(true)) {
      lastRow = row;
      break;
    }
  }
  await write(
    `\u001b[${lastRow + 1};1H\r\n` +
      (alternateScreen ? `${alternateScreen}\r\n` : "") +
      "[Restored output. New terminal session.]\r\n"
  );
}
