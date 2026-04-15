export interface DisposableAddon {
  dispose(): void;
}

export interface AddonHost<TAddon extends DisposableAddon> {
  loadAddon(addon: TAddon): void;
}

export interface TerminalPasteHost {
  paste(data: string): void;
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
