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

// xterm.js's CompositionHelper only whitelists keyCodes 16/17/18/20/229 as
// modifier keys to ignore during IME composition. Anything else received while
// composing triggers _finalizeComposition(false), which flushes a substring of
// the textarea to the PTY but does not clear the textarea. macOS IMEs stay
// alive across that flush, so on the next input the residual text is combined
// with the new composition and re-sent — visible as the previous syllable
// repeating. Two real-world cases reach xterm in this state:
//   1) bare Cmd keydown — Meta (keyCode 91/93/224) isn't in xterm's whitelist.
//   2) modifier + navigation keys (Cmd/Alt + Arrow/Home/End/PageUp/Down) — the
//      OS IME routinely consumes these for line edits, word jumps, or pane
//      shortcuts, but xterm treats the navigation key as ordinary input and
//      finalizes composition.
// Returning true here lets attachCustomKeyEventHandler short-circuit xterm
// without preventDefault, so the DOM/OS still routes the key to the IME.
export function shouldSuppressXtermDuringIme(
  event: TerminalKeyboardEventLike,
  isComposing: boolean
): boolean {
  if (!isComposing) {
    return false;
  }
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
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
