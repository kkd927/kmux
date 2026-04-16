export {
  resolveTerminalEnterRewrite,
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
