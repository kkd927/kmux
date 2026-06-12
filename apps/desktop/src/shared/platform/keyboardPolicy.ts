import {
  buildDefaultShortcuts,
  normalizeShortcutBinding,
  type ShortcutCommandId,
  type ShortcutMap,
  type ShortcutPlatform
} from "@kmux/ui";

export type { ShortcutCommandId } from "@kmux/ui";

export type KeyboardShortcutPlatform = ShortcutPlatform;
export type KeyboardShortcutModifier = "Meta" | "Ctrl" | "Alt" | "Shift";
export type KeyChord = string;

export interface PlatformKeyboardPolicy {
  platform: KeyboardShortcutPlatform;
  shortcuts: ShortcutMap;
  reservedSystemChords: KeyChord[];
  labelStyle: "mac-symbols" | "text";
  copyModeSelectAllShortcut: KeyChord;
  workspaceShortcutHintModifier: KeyboardShortcutModifier | null;
  numberRowShortcuts: {
    workspaceModifier: KeyboardShortcutModifier | null;
    surfaceModifier: KeyboardShortcutModifier | null;
  };
}

const DEFAULT_RESERVED_SYSTEM_CHORDS: Record<
  KeyboardShortcutPlatform,
  KeyChord[]
> = {
  darwin: [
    "Meta+Tab",
    "Meta+Space",
    "Meta+Ctrl+F",
    "Meta+Q",
    "Meta+H",
    "Meta+M"
  ],
  linux: [
    "Meta",
    "Meta+Tab",
    "Meta+L",
    "Meta+A",
    "Meta+S",
    "Alt+Tab",
    "Alt+F2",
    "Alt+F4",
    "Ctrl+Alt+T",
    "Ctrl+Alt+Delete",
    "Ctrl+Alt+ArrowLeft",
    "Ctrl+Alt+ArrowRight",
    "Ctrl+Alt+ArrowUp",
    "Ctrl+Alt+ArrowDown",
    "PrintScreen"
  ]
};

const DEFAULT_WORKSPACE_SHORTCUT_HINT_MODIFIER: Record<
  KeyboardShortcutPlatform,
  KeyboardShortcutModifier | null
> = {
  darwin: "Meta",
  linux: null
};

const DEFAULT_COPY_MODE_SELECT_ALL_SHORTCUTS: Record<
  KeyboardShortcutPlatform,
  KeyChord
> = {
  darwin: "Meta+A",
  linux: "Ctrl+A"
};

const DEFAULT_NUMBER_ROW_SHORTCUTS: Record<
  KeyboardShortcutPlatform,
  PlatformKeyboardPolicy["numberRowShortcuts"]
> = {
  darwin: {
    workspaceModifier: "Meta",
    surfaceModifier: "Ctrl"
  },
  linux: {
    workspaceModifier: "Alt",
    surfaceModifier: "Ctrl"
  }
};

export function buildPlatformKeyboardPolicy(options: {
  platform?: KeyboardShortcutPlatform;
  labelStyle: PlatformKeyboardPolicy["labelStyle"];
  reservedSystemChords?: KeyChord[];
  shortcuts?: Partial<Record<ShortcutCommandId, KeyChord>>;
  copyModeSelectAllShortcut?: KeyChord;
  workspaceShortcutHintModifier?: KeyboardShortcutModifier | null;
  numberRowShortcuts?: Partial<PlatformKeyboardPolicy["numberRowShortcuts"]>;
}): PlatformKeyboardPolicy {
  const platform =
    options.platform ??
    (options.labelStyle === "mac-symbols" ? "darwin" : "linux");
  const shortcuts: ShortcutMap = {
    ...buildDefaultShortcuts(platform),
    ...options.shortcuts
  };
  const numberRowShortcuts = {
    ...DEFAULT_NUMBER_ROW_SHORTCUTS[platform],
    ...options.numberRowShortcuts
  };

  return {
    platform,
    shortcuts,
    reservedSystemChords: [
      ...DEFAULT_RESERVED_SYSTEM_CHORDS[platform],
      ...(options.reservedSystemChords ?? [])
    ],
    labelStyle: options.labelStyle,
    copyModeSelectAllShortcut:
      options.copyModeSelectAllShortcut ??
      DEFAULT_COPY_MODE_SELECT_ALL_SHORTCUTS[platform],
    workspaceShortcutHintModifier:
      options.workspaceShortcutHintModifier === undefined
        ? DEFAULT_WORKSPACE_SHORTCUT_HINT_MODIFIER[platform]
        : options.workspaceShortcutHintModifier,
    numberRowShortcuts
  };
}

export function isReservedSystemChordBinding(
  shortcut: KeyChord | undefined,
  reservedSystemChords: KeyChord[]
): boolean {
  if (!shortcut) {
    return false;
  }

  const normalizedShortcut = normalizeShortcutBinding(shortcut);
  return reservedSystemChords.some(
    (reservedShortcut) =>
      normalizeShortcutBinding(reservedShortcut) === normalizedShortcut
  );
}
