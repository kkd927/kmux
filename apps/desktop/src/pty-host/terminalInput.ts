import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE,
  type TerminalKeyInput
} from "@kmux/proto";

export function encodeTerminalKeyInput(input: TerminalKeyInput): string {
  switch (input.key) {
    case "Enter":
      if (
        input.ctrlKey &&
        !input.altKey &&
        !input.metaKey &&
        !input.shiftKey
      ) {
        return TERMINAL_CTRL_ENTER_SEQUENCE;
      }
      if (
        input.shiftKey &&
        !input.altKey &&
        !input.ctrlKey &&
        !input.metaKey
      ) {
        return TERMINAL_SHIFT_ENTER_SEQUENCE;
      }
      return "\r";
    case "Backspace":
      return "\u007f";
    case "Tab":
      return "\t";
    case "ArrowUp":
      return "\u001b[A";
    case "ArrowDown":
      return "\u001b[B";
    case "ArrowRight":
      return "\u001b[C";
    case "ArrowLeft":
      return "\u001b[D";
    case "Escape":
      return "\u001b";
    default:
      return input.text ?? input.key;
  }
}
