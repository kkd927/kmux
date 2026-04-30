import {
  createXtermTheme,
  THEMES,
  type ColorTheme
} from "@kmux/ui";

export {
  resolveTerminalEnterRewrite,
  shouldSwallowImeCompositionMetaKey,
  type TerminalEnterRewrite,
  type TerminalKeyboardEventLike
} from "../../terminalKeyboard";

export interface DisposableAddon {
  dispose(): void;
}

export interface AddonHost<TAddon extends DisposableAddon> {
  loadAddon(addon: TAddon): void;
}

export interface TerminalPasteHost {
  paste(data: string): void;
}

export interface PendingTerminalEnterRewrite {
  surfaceId: string;
  sequence: string;
}

export interface TerminalEnterRewriteResult {
  data: string;
  clearPending: boolean;
}

export type TerminalWebglRecoveryReason = "hydrate" | "resize";

export interface TerminalWebglRecoveryInput {
  webglActive: boolean;
  reason: TerminalWebglRecoveryReason;
  resized: boolean;
  previousCols: number;
  previousRows: number;
  cols: number;
  rows: number;
  resizeBurstCount: number;
}

export interface TerminalWebglRecoveryAction {
  refresh: boolean;
  recreate: boolean;
}

const TERMINAL_WEBGL_LARGE_COL_DELTA = 8;
const TERMINAL_WEBGL_LARGE_ROW_DELTA = 2;
const TERMINAL_WEBGL_TINY_COLS = 20;
const TERMINAL_WEBGL_TINY_ROWS = 2;

export function createTerminalPaneXtermTheme(
  palette: Parameters<typeof createXtermTheme>[0],
  colorTheme: ColorTheme
): ReturnType<typeof createXtermTheme> {
  return {
    ...createXtermTheme(palette, colorTheme),
    background: THEMES[colorTheme].windowBg
  };
}

interface ApplyTerminalWebglPreferenceOptions<TAddon extends DisposableAddon> {
  terminal: AddonHost<TAddon>;
  currentAddon: TAddon | null;
  useWebgl: boolean;
  createAddon: () => TAddon;
  onLoadError?: (error: unknown) => void;
}

interface PasteClipboardIntoTerminalOptions {
  terminal: TerminalPasteHost;
  readClipboardText: () => string;
}

export function applyTerminalWebglPreference<TAddon extends DisposableAddon>(
  options: ApplyTerminalWebglPreferenceOptions<TAddon>
): TAddon | null {
  if (!options.useWebgl) {
    options.currentAddon?.dispose();
    return null;
  }

  if (options.currentAddon) {
    return options.currentAddon;
  }

  try {
    const addon = options.createAddon();
    options.terminal.loadAddon(addon);
    return addon;
  } catch (error) {
    options.onLoadError?.(error);
    return null;
  }
}

export function resolveTerminalWebglRecovery(
  input: TerminalWebglRecoveryInput
): TerminalWebglRecoveryAction {
  if (!input.webglActive) {
    return { refresh: false, recreate: false };
  }

  if (input.reason === "hydrate") {
    return { refresh: true, recreate: true };
  }

  const largeResize =
    Math.abs(input.cols - input.previousCols) >=
      TERMINAL_WEBGL_LARGE_COL_DELTA ||
    Math.abs(input.rows - input.previousRows) >=
      TERMINAL_WEBGL_LARGE_ROW_DELTA;
  const tinyViewport =
    input.cols <= TERMINAL_WEBGL_TINY_COLS ||
    input.rows <= TERMINAL_WEBGL_TINY_ROWS;
  const resizeChurn = input.resizeBurstCount > 1;

  return {
    refresh: true,
    recreate: input.resized && (largeResize || tinyViewport || resizeChurn)
  };
}

export function pasteClipboardIntoTerminal(
  options: PasteClipboardIntoTerminalOptions
): boolean {
  const text = options.readClipboardText();
  if (!text) {
    return false;
  }

  options.terminal.paste(text);
  return true;
}

export function applyPendingTerminalEnterRewrite(
  surfaceId: string,
  data: string,
  pending: PendingTerminalEnterRewrite | null
): TerminalEnterRewriteResult {
  if (!pending) {
    return { data, clearPending: false };
  }
  if (pending.surfaceId !== surfaceId) {
    return { data, clearPending: true };
  }
  const carriageReturnIndex = data.indexOf("\r");
  if (carriageReturnIndex < 0) {
    return { data, clearPending: false };
  }
  const escapeIndex = data.indexOf("\u001b");
  if (escapeIndex >= 0 && escapeIndex < carriageReturnIndex) {
    return { data, clearPending: true };
  }
  return {
    data:
      data.slice(0, carriageReturnIndex) +
      pending.sequence +
      data.slice(carriageReturnIndex + 1),
    clearPending: true
  };
}
