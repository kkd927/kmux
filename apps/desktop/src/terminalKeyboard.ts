import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";

export interface TerminalKeyboardEventLike {
  key: string;
  code?: string;
  keyCode?: number;
  which?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  type?: string;
}

export interface TerminalEnterRewrite {
  sequence: string;
}

function isImeProcessKey(
  event: Pick<TerminalKeyboardEventLike, "keyCode" | "which">
): boolean {
  return event.keyCode === 229 || event.which === 229;
}

function isTerminalEnterKey(
  event: Pick<TerminalKeyboardEventLike, "key" | "code" | "keyCode" | "which">
): boolean {
  if (isImeProcessKey(event)) {
    return false;
  }
  return (
    event.key === "Enter" ||
    event.code === "Enter" ||
    event.code === "NumpadEnter" ||
    event.keyCode === 13 ||
    event.which === 13
  );
}

function resolveModifiedEnterSequence(
  event: Pick<
    TerminalKeyboardEventLike,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >
): string | null {
  if (event.metaKey) {
    return null;
  }
  if (event.altKey) {
    return null;
  }
  if (event.ctrlKey && !event.shiftKey) {
    return TERMINAL_CTRL_ENTER_SEQUENCE;
  }
  if (event.shiftKey && !event.ctrlKey) {
    return TERMINAL_SHIFT_ENTER_SEQUENCE;
  }
  return null;
}

export function resolveTerminalEnterRewrite(
  event: TerminalKeyboardEventLike
): TerminalEnterRewrite | null {
  if (!isTerminalEnterKey(event)) {
    return null;
  }

  const sequence = resolveModifiedEnterSequence(event);
  if (!sequence) {
    return null;
  }

  return { sequence };
}

// xterm.js's CompositionHelper only whitelists keyCodes 16/17/18/20/229 as
// modifier keys to ignore during IME composition. Meta (Cmd on macOS, keyCode
// 91/93/224) is not in that list, so a bare Cmd keydown while composing Hangul
// triggers _finalizeComposition(false) and flushes the partially-composed
// syllable into the PTY. The OS-level IME is still alive and continues to
// update the textarea, producing a second send and visible duplication.
// Swallowing bare Cmd keydowns during composition via
// attachCustomKeyEventHandler keeps xterm from entering that path while
// leaving the DOM/OS free to react to Cmd normally (no preventDefault).
export function shouldSwallowImeCompositionMetaKey(
  event: TerminalKeyboardEventLike,
  isComposing: boolean
): boolean {
  if (!isComposing) {
    return false;
  }
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  if (event.key !== "Meta") {
    return false;
  }
  if (event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  return true;
}
