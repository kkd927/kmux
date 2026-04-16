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
