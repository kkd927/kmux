export interface DisposableAddon {
  dispose(): void;
}

export interface AddonHost<TAddon extends DisposableAddon> {
  loadAddon(addon: TAddon): void;
}

interface ApplyTerminalWebglPreferenceOptions<TAddon extends DisposableAddon> {
  terminal: AddonHost<TAddon>;
  currentAddon: TAddon | null;
  useWebgl: boolean;
  createAddon: () => TAddon;
  onLoadError?: (error: unknown) => void;
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
