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

export type TerminalImePlatform = "darwin" | "linux";

export type TerminalImeCompositionPhase = "idle" | "composing" | "settling";

export type TerminalImeNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

export type TerminalImeKeyAction =
  | { type: "process" }
  | { type: "suppress" }
  | { type: "defer-navigation"; key: TerminalImeNavigationKey };

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

const IME_NAVIGATION_KEYS = new Set<TerminalImeNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

function isTerminalImeNavigationKey(
  key: string
): key is TerminalImeNavigationKey {
  return IME_NAVIGATION_KEYS.has(key as TerminalImeNavigationKey);
}

// xterm.js's CompositionHelper finalizes composition for keyCodes other than
// 16/17/18/20/229. This function only decides which platform-specific keydowns
// may reach xterm; macOS leaves the commit itself to xterm's delayed finalizer,
// while Linux keeps its explicit commit and duplicate-filtering path.
//
// Linux ibus/fcitx can emit ordinary physical keydowns during composition, so
// all of them stay suppressed as before. On macOS, an unmodified navigation key
// must still reach the PTY, but only after the current composition has settled;
// otherwise xterm can flush a preedit substring and leave it in its textarea.
export function resolveTerminalImeKeyAction(
  event: TerminalKeyboardEventLike,
  phase: TerminalImeCompositionPhase,
  platform: TerminalImePlatform
): TerminalImeKeyAction {
  if (event.type !== undefined && event.type !== "keydown") {
    return { type: "process" };
  }
  const composing =
    phase === "composing" ||
    event.isComposing === true ||
    isImeProcessKey(event) ||
    event.key === "Process";

  if (platform === "linux") {
    return composing ? { type: "suppress" } : { type: "process" };
  }

  if (!composing && phase !== "settling") {
    return { type: "process" };
  }

  if (
    isTerminalImeNavigationKey(event.key) &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return { type: "defer-navigation", key: event.key };
  }

  if (
    event.key === "Meta" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return { type: "suppress" };
  }

  if (
    (event.metaKey || event.altKey) &&
    isTerminalImeNavigationKey(event.key)
  ) {
    return { type: "suppress" };
  }

  return { type: "process" };
}

export function resolveTerminalImeNavigationSequence(
  key: TerminalImeNavigationKey,
  applicationCursorKeysMode: boolean
): string {
  const cursorPrefix = applicationCursorKeysMode ? "\u001bO" : "\u001b[";
  switch (key) {
    case "ArrowUp":
      return `${cursorPrefix}A`;
    case "ArrowDown":
      return `${cursorPrefix}B`;
    case "ArrowRight":
      return `${cursorPrefix}C`;
    case "ArrowLeft":
      return `${cursorPrefix}D`;
    case "Home":
      return `${cursorPrefix}H`;
    case "End":
      return `${cursorPrefix}F`;
    case "PageUp":
      return "\u001b[5~";
    case "PageDown":
      return "\u001b[6~";
  }
}
