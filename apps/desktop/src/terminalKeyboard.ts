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

export type TerminalImeKeySuppressionPlatform = "darwin" | "linux";

export interface TerminalEnterRewrite {
  sequence: string;
}

function isImeProcessKey(
  event: Pick<TerminalKeyboardEventLike, "keyCode" | "which">
): boolean {
  return event.keyCode === 229 || event.which === 229;
}

export function shouldDeferTerminalShortcutToIme(
  event: Pick<TerminalKeyboardEventLike, "isComposing" | "keyCode" | "which">,
  isComposing: boolean
): boolean {
  return isComposing || event.isComposing === true || isImeProcessKey(event);
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
  if (shouldDeferTerminalShortcutToIme(event, false)) {
    return null;
  }
  if (!isTerminalEnterKey(event)) {
    return null;
  }

  const sequence = resolveModifiedEnterSequence(event);
  if (!sequence) {
    return null;
  }

  return { sequence };
}

const IME_NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

// xterm.js's CompositionHelper only keeps composition alive for keyCodes
// 16/17/18/20/229. Linux ibus/fcitx can deliver ordinary physical keydown
// events while KeyboardEvent.isComposing is true; if those reach xterm,
// CompositionHelper calls _finalizeComposition(false) and flushes the current
// preedit substring to the PTY before the IME commit. That is visible as
// repeated Korean syllables. macOS does not need that broad suppression, but it
// still needs the narrower Meta/navigation guards below for xterm's whitelist.
export function shouldSuppressXtermDuringIme(
  event: TerminalKeyboardEventLike,
  isComposing: boolean,
  platform: TerminalImeKeySuppressionPlatform
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  const composing =
    isComposing ||
    event.isComposing === true ||
    isImeProcessKey(event) ||
    event.key === "Process";
  if (!composing) {
    return false;
  }

  if (platform === "linux") {
    return true;
  }

  if (
    event.key === "Meta" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return true;
  }

  if (
    (event.metaKey || event.altKey) &&
    IME_NAVIGATION_KEYS.has(event.key)
  ) {
    return true;
  }

  return false;
}
