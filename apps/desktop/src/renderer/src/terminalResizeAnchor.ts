interface AnchorableTerminal {
  buffer: { active: { viewportY: number; baseY: number } };
  resize(cols: number, rows: number): void;
  scrollToBottom(): void;
}

// xterm's reflow tries to preserve the viewport position, but wrap-count
// changes and interleaved TUI re-prints can leave the viewport floating
// above the live output after a resize. When the user was following the
// bottom, pin the viewport back to it; when they scrolled up to read, leave
// the viewport alone.
export function resizeTerminalKeepingBottomAnchor(
  terminal: AnchorableTerminal,
  cols: number,
  rows: number
): void {
  const wasAtBottom =
    terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
  terminal.resize(cols, rows);
  if (
    wasAtBottom &&
    terminal.buffer.active.viewportY !== terminal.buffer.active.baseY
  ) {
    terminal.scrollToBottom();
  }
}
