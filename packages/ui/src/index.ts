import type {
  ResolvedTerminalThemeVm,
  TerminalColorPalette,
  TerminalThemeProfile,
  TerminalThemeProfileSource,
  TerminalThemeSettings
} from "@kmux/proto";

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "workspace.create": "Meta+N",
  "workspace.rename": "Meta+Shift+R",
  "workspace.close": "Meta+Shift+W",
  "workspace.next": "Meta+]",
  "workspace.prev": "Meta+[",
  "workspace.sidebar.toggle": "Meta+B",
  "pane.split.right": "Meta+D",
  "pane.split.down": "Meta+Shift+D",
  "pane.focus.left": "Alt+Meta+ArrowLeft",
  "pane.focus.right": "Alt+Meta+ArrowRight",
  "pane.focus.up": "Alt+Meta+ArrowUp",
  "pane.focus.down": "Alt+Meta+ArrowDown",
  "pane.resize.left": "Alt+Shift+Meta+ArrowLeft",
  "pane.resize.right": "Alt+Shift+Meta+ArrowRight",
  "pane.resize.up": "Alt+Shift+Meta+ArrowUp",
  "pane.resize.down": "Alt+Shift+Meta+ArrowDown",
  "pane.close": "Meta+Alt+K",
  "surface.create": "Meta+T",
  "surface.close": "Meta+W",
  "surface.closeOthers": "Meta+Ctrl+W",
  "surface.next": "Ctrl+Tab",
  "surface.prev": "Ctrl+Shift+Tab",
  "command.palette": "Meta+Shift+P",
  "notifications.toggle": "Meta+I",
  "usage.dashboard.toggle": "Meta+Shift+U",
  "settings.toggle": "Meta+,",
  "terminal.search": "Meta+F",
  "terminal.search.next": "Meta+G",
  "terminal.search.prev": "Meta+Shift+G",
  "terminal.copy": "Meta+C",
  "terminal.paste": "Meta+V",
  "terminal.copyMode": "Meta+Shift+M"
};

export type ColorTheme = "dark" | "light";
export type ThemeMode = ColorTheme | "system";

const DARK_THEME_TOKENS = {
  windowBg: "#181818",
  shellBg: "#181818",
  titlebarBg: "#181818",
  titlebarInactiveBg: "#151515",
  titlebarGlow: "rgba(255, 255, 255, 0.04)",
  chromeBg: "#1b1b1b",
  chromeElevated: "#202020",
  panelBg: "#1f1f1f",
  panelMuted: "#1d1d1d",
  sidebarBg: "#181818",
  sidebarHeaderBg: "#181818",
  tabBg: "#181818",
  tabInactiveBg: "#181818",
  tabActiveBg: "#1f1f1f",
  tabHoverBg: "#252526",
  tabIndicator: "#0078d4",
  cardBg: "#1f1f1f",
  cardHover: "#252526",
  cardActive: "rgba(9, 71, 113, 0.9)",
  cardActiveBorder: "#0078d4",
  borderStrong: "#2b2b2b",
  borderSoft: "#303031",
  divider: "#2b2b2b",
  textPrimary: "#cccccc",
  textSecondary: "#9d9d9d",
  textTertiary: "#808080",
  textFaint: "#6b6b6b",
  accent: "#0078d4",
  accentSoft: "rgba(0, 120, 212, 0.16)",
  accentMuted: "rgba(0, 120, 212, 0.1)",
  accentHover: "#1890f1",
  success: "#23a55a",
  warning: "#cca700",
  error: "#f14c4c",
  inputBg: "#313131",
  inputBorder: "#3c3c3c",
  popupBg: "#222222",
  popupBorder: "#2b2b2b",
  selectionBg: "rgba(38, 79, 120, 0.72)",
  listHover: "#232323",
  listActive: "rgba(0, 120, 212, 0.16)",
  listActiveBorder: "rgba(0, 120, 212, 0.3)",
  listInactive: "#202020",
  buttonHover: "#2a2d2e",
  buttonActive: "#313131",
  focusRing: "rgba(0, 120, 212, 0.48)",
  focusRingStrong: "rgba(0, 120, 212, 0.92)",
  overlayBg: "rgba(0, 0, 0, 0.46)",
  shadowStrong:
    "0 20px 48px rgba(0, 0, 0, 0.48), 0 8px 18px rgba(0, 0, 0, 0.28)",
  shadowMedium: "0 12px 32px rgba(0, 0, 0, 0.34)",
  scrollbarThumb: "rgba(121, 121, 121, 0.4)",
  scrollbarThumbHover: "rgba(153, 153, 153, 0.56)"
} as const;

type ThemeTokenName = keyof typeof DARK_THEME_TOKENS;
type ThemeTokens = Record<ThemeTokenName, string>;

const LIGHT_THEME_TOKENS: ThemeTokens = {
  windowBg: "#f7f7f5",
  shellBg: "#f7f7f5",
  titlebarBg: "#fbfbfb",
  titlebarInactiveBg: "#eef1f4",
  titlebarGlow: "rgba(255, 255, 255, 0.72)",
  chromeBg: "#f4f6f8",
  chromeElevated: "#eef3f6",
  panelBg: "#ffffff",
  panelMuted: "#f4f6f8",
  sidebarBg: "#e8f1f6",
  sidebarHeaderBg: "#e8f1f6",
  tabBg: "#f5f7f9",
  tabInactiveBg: "#f3f5f7",
  tabActiveBg: "#ffffff",
  tabHoverBg: "#edf2f6",
  tabIndicator: "#0a67d8",
  cardBg: "#ffffff",
  cardHover: "#dfe9f2",
  cardActive: "#d7e6f3",
  cardActiveBorder: "#bfd5e8",
  borderStrong: "#d7dee5",
  borderSoft: "#e1e6eb",
  divider: "#d5dde4",
  textPrimary: "#1f2328",
  textSecondary: "#57606a",
  textTertiary: "#6e7781",
  textFaint: "#8c959f",
  accent: "#0a67d8",
  accentSoft: "rgba(10, 103, 216, 0.1)",
  accentMuted: "rgba(10, 103, 216, 0.08)",
  accentHover: "#0860ca",
  success: "#1a7f37",
  warning: "#9a6700",
  error: "#cf222e",
  inputBg: "#ffffff",
  inputBorder: "#cfd8e1",
  popupBg: "#ffffff",
  popupBorder: "#d7dee5",
  selectionBg: "rgba(10, 103, 216, 0.16)",
  listHover: "#edf2f6",
  listActive: "rgba(10, 103, 216, 0.12)",
  listActiveBorder: "rgba(10, 103, 216, 0.22)",
  listInactive: "#eef2f5",
  buttonHover: "#edf2f6",
  buttonActive: "#e3e9ef",
  focusRing: "rgba(10, 103, 216, 0.24)",
  focusRingStrong: "rgba(10, 103, 216, 0.72)",
  overlayBg: "rgba(36, 44, 52, 0.16)",
  shadowStrong:
    "0 18px 42px rgba(31, 35, 40, 0.12), 0 8px 18px rgba(31, 35, 40, 0.08)",
  shadowMedium: "0 10px 26px rgba(31, 35, 40, 0.1)",
  scrollbarThumb: "rgba(92, 111, 129, 0.35)",
  scrollbarThumbHover: "rgba(92, 111, 129, 0.5)"
};

const CSS_VARIABLE_NAMES = {
  windowBg: "--window-bg",
  shellBg: "--shell-bg",
  titlebarBg: "--titlebar-bg",
  titlebarInactiveBg: "--titlebar-inactive-bg",
  titlebarGlow: "--titlebar-glow",
  chromeBg: "--chrome-bg",
  chromeElevated: "--chrome-elevated",
  panelBg: "--panel-bg",
  panelMuted: "--panel-muted",
  sidebarBg: "--sidebar-bg",
  sidebarHeaderBg: "--sidebar-header-bg",
  tabBg: "--tab-bg",
  tabInactiveBg: "--tab-inactive-bg",
  tabActiveBg: "--tab-active-bg",
  tabHoverBg: "--tab-hover-bg",
  tabIndicator: "--tab-indicator",
  cardBg: "--card-bg",
  cardHover: "--card-hover",
  cardActive: "--card-active",
  cardActiveBorder: "--card-active-border",
  borderStrong: "--border-strong",
  borderSoft: "--border-soft",
  divider: "--divider",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textTertiary: "--text-tertiary",
  textFaint: "--text-faint",
  accent: "--accent",
  accentSoft: "--accent-soft",
  accentMuted: "--accent-muted",
  accentHover: "--accent-hover",
  success: "--success",
  warning: "--warning",
  error: "--danger",
  inputBg: "--input-bg",
  inputBorder: "--input-border",
  popupBg: "--popup-bg",
  popupBorder: "--popup-border",
  selectionBg: "--selection-bg",
  listHover: "--list-hover",
  listActive: "--list-active",
  listActiveBorder: "--list-active-border",
  listInactive: "--list-inactive",
  buttonHover: "--button-hover",
  buttonActive: "--button-active",
  focusRing: "--focus-ring",
  focusRingStrong: "--focus-ring-strong",
  overlayBg: "--overlay-bg",
  shadowStrong: "--shadow-strong",
  shadowMedium: "--shadow-medium",
  scrollbarThumb: "--scrollbar-thumb",
  scrollbarThumbHover: "--scrollbar-thumb-hover"
} as const satisfies Record<ThemeTokenName, `--${string}`>;

export const THEMES = Object.freeze({
  dark: Object.freeze(DARK_THEME_TOKENS),
  light: Object.freeze(LIGHT_THEME_TOKENS)
}) as Readonly<Record<ColorTheme, Readonly<ThemeTokens>>>;

export const THEME = THEMES.dark;

const THEME_CSS_VARIABLE_MAP = Object.freeze({
  dark: Object.freeze(
    Object.fromEntries(
      (
        Object.entries(CSS_VARIABLE_NAMES) as Array<
          [ThemeTokenName, `--${string}`]
        >
      ).map(([tokenName, variableName]) => [
        variableName,
        THEMES.dark[tokenName]
      ])
    )
  ),
  light: Object.freeze(
    Object.fromEntries(
      (
        Object.entries(CSS_VARIABLE_NAMES) as Array<
          [ThemeTokenName, `--${string}`]
        >
      ).map(([tokenName, variableName]) => [
        variableName,
        THEMES.light[tokenName]
      ])
    )
  )
}) as Readonly<Record<ColorTheme, Readonly<Record<`--${string}`, string>>>>;

export const THEME_CSS_VARIABLES = THEME_CSS_VARIABLE_MAP.dark;

export const DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO = 1;
export const KMUX_DEFAULT_TERMINAL_THEME_PROFILE_ID =
  "terminal_theme_kmux_default";
export const BUILTIN_TERMINAL_THEME_PROFILE_ID =
  KMUX_DEFAULT_TERMINAL_THEME_PROFILE_ID;
export const INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE_ID =
  "terminal_theme_intellij_islands";
const KMUX_DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO = 2.5;
const INTELLIJ_ISLANDS_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO = 1;

function createTerminalColorPalette(
  palette: TerminalColorPalette
): TerminalColorPalette {
  return {
    ...palette,
    ansi: [...palette.ansi]
  };
}

const KMUX_DEFAULT_TERMINAL_COLOR_PALETTES = Object.freeze({
  dark: createTerminalColorPalette({
    background: THEMES.dark.panelBg,
    foreground: "#e3e8ef",
    cursor: "#ffffff",
    cursorText: THEMES.dark.panelBg,
    selectionBackground: THEMES.dark.selectionBg,
    selectionForeground: "#ffffff",
    ansi: [
      "#566070",
      "#e05b66",
      "#2fb36f",
      "#c89b3c",
      "#4c9ffe",
      "#ba8cf5",
      "#35bac4",
      "#e3e8ef",
      "#8c98a8",
      "#f14c4c",
      "#4fd08b",
      "#e1b954",
      "#79b8ff",
      "#d670d6",
      "#56d4dd",
      "#ffffff"
    ]
  }),
  light: createTerminalColorPalette({
    background: THEMES.light.panelBg,
    foreground: "#232c35",
    cursor: "#232c35",
    cursorText: THEMES.light.panelBg,
    selectionBackground: "rgba(10, 103, 216, 0.22)",
    selectionForeground: "#080808",
    ansi: [
      "#4b5563",
      "#cf222e",
      "#1a7f37",
      "#9a6700",
      "#0550ae",
      "#8250df",
      "#1b7c83",
      "#6e7781",
      "#6e7781",
      "#a40e26",
      "#116329",
      "#7d4e00",
      "#033d8b",
      "#6639ba",
      "#176c73",
      "#232c35"
    ]
  })
}) as Readonly<Record<ColorTheme, TerminalColorPalette>>;

const INTELLIJ_ISLANDS_TERMINAL_COLOR_PALETTES = Object.freeze({
  dark: createTerminalColorPalette({
    background: "#191a1c",
    foreground: "#cccccc",
    cursor: "#bcbec4",
    cursorText: "#191a1c",
    selectionBackground: "rgba(255, 255, 255, 0.25)",
    selectionForeground: "#ffffff",
    ansi: [
      "#000000",
      "#cd3131",
      "#0dbc79",
      "#e5e510",
      "#2472c8",
      "#bc3fbc",
      "#11a8cd",
      "#e5e5e5",
      "#666666",
      "#f14c4c",
      "#23d18b",
      "#f5f543",
      "#3b8eea",
      "#d670d6",
      "#29b8db",
      "#e5e5e5"
    ]
  }),
  light: createTerminalColorPalette({
    background: "#ffffff",
    foreground: "#080808",
    cursor: "#080808",
    cursorText: "#ffffff",
    selectionBackground: "#a6d2ff",
    selectionForeground: "#080808",
    ansi: [
      "#000000",
      "#de1b2e",
      "#067d17",
      "#9e880d",
      "#0033b3",
      "#871094",
      "#007e8a",
      "#6c707e",
      "#8c8c8c",
      "#e53935",
      "#2e9f43",
      "#c28f16",
      "#1750eb",
      "#a333c8",
      "#286d73",
      "#080808"
    ]
  })
}) as Readonly<Record<ColorTheme, TerminalColorPalette>>;

export const BUILTIN_TERMINAL_THEME_PROFILE: Readonly<TerminalThemeProfile> =
  Object.freeze({
    id: KMUX_DEFAULT_TERMINAL_THEME_PROFILE_ID,
    name: "kmux Default",
    source: "builtin",
    minimumContrastRatio: KMUX_DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO,
    variants: {
      dark: createTerminalColorPalette(KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.dark),
      light: createTerminalColorPalette(KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.light)
    }
  });

export const KMUX_DEFAULT_TERMINAL_THEME_PROFILE = BUILTIN_TERMINAL_THEME_PROFILE;

export const INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE: Readonly<TerminalThemeProfile> =
  Object.freeze({
    id: INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE_ID,
    name: "IntelliJ Islands",
    source: "builtin",
    minimumContrastRatio: INTELLIJ_ISLANDS_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO,
    variants: {
      dark: createTerminalColorPalette(
        INTELLIJ_ISLANDS_TERMINAL_COLOR_PALETTES.dark
      ),
      light: createTerminalColorPalette(
        INTELLIJ_ISLANDS_TERMINAL_COLOR_PALETTES.light
      )
    }
  });

export const BUILTIN_TERMINAL_THEME_PROFILES = Object.freeze([
  BUILTIN_TERMINAL_THEME_PROFILE,
  INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE
]) as ReadonlyArray<Readonly<TerminalThemeProfile>>;

export function cloneTerminalColorPalette(
  palette: TerminalColorPalette
): TerminalColorPalette {
  return createTerminalColorPalette(palette);
}

export function cloneTerminalThemeProfile(
  profile: TerminalThemeProfile
): TerminalThemeProfile {
  return {
    ...profile,
    variants: {
      dark: cloneTerminalColorPalette(profile.variants.dark),
      light: cloneTerminalColorPalette(profile.variants.light)
    }
  };
}

export function isBuiltinTerminalThemeProfileId(profileId: string): boolean {
  return BUILTIN_TERMINAL_THEME_PROFILES.some(
    (profile) => profile.id === profileId
  );
}

export function createDefaultTerminalThemeSettings(): TerminalThemeSettings {
  return {
    activeProfileId: KMUX_DEFAULT_TERMINAL_THEME_PROFILE_ID,
    profiles: BUILTIN_TERMINAL_THEME_PROFILES.map((profile) =>
      cloneTerminalThemeProfile(profile)
    )
  };
}

function sanitizeTerminalThemeSource(
  source: TerminalThemeProfileSource | undefined
): TerminalThemeProfileSource {
  if (source === "itermcolors") {
    return source;
  }
  return "custom";
}

function sanitizeTerminalThemeName(name: string | undefined): string {
  const nextName = typeof name === "string" ? name.trim() : "";
  return nextName || "Custom theme";
}

function sanitizeTerminalThemeId(id: string | undefined, fallback: string): string {
  const nextId = typeof id === "string" ? id.trim() : "";
  return nextId || fallback;
}

function sanitizeCssColor(color: string | undefined, fallback: string): string {
  const nextColor = typeof color === "string" ? color.trim() : "";
  return nextColor || fallback;
}

function sanitizeAnsiPalette(
  ansi: string[] | undefined,
  fallback: string[]
): string[] {
  const nextAnsi = Array.isArray(ansi) ? ansi : [];
  return fallback.map((fallbackColor, index) =>
    sanitizeCssColor(nextAnsi[index], fallbackColor)
  );
}

function sanitizeMinimumContrastRatio(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO;
  }
  return Math.max(1, Math.min(21, Number(value.toFixed(2))));
}

export function sanitizeTerminalColorPalette(
  palette: Partial<TerminalColorPalette> | undefined,
  fallback: TerminalColorPalette
): TerminalColorPalette {
  return {
    foreground: sanitizeCssColor(palette?.foreground, fallback.foreground),
    background: sanitizeCssColor(palette?.background, fallback.background),
    cursor: sanitizeCssColor(palette?.cursor, fallback.cursor),
    cursorText: sanitizeCssColor(palette?.cursorText, fallback.cursorText),
    selectionBackground: sanitizeCssColor(
      palette?.selectionBackground,
      fallback.selectionBackground
    ),
    selectionForeground: sanitizeCssColor(
      palette?.selectionForeground,
      fallback.selectionForeground
    ),
    ansi: sanitizeAnsiPalette(palette?.ansi, fallback.ansi)
  };
}

function sanitizeTerminalThemeProfile(
  profile: Partial<TerminalThemeProfile>,
  index: number
): TerminalThemeProfile {
  const darkFallback = KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.dark;
  const lightFallback = KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.light;

  return {
    id: sanitizeTerminalThemeId(profile.id, `terminal_theme_custom_${index + 1}`),
    name: sanitizeTerminalThemeName(profile.name),
    source: sanitizeTerminalThemeSource(profile.source),
    minimumContrastRatio: sanitizeMinimumContrastRatio(
      profile.minimumContrastRatio
    ),
    variants: {
      dark: sanitizeTerminalColorPalette(profile.variants?.dark, darkFallback),
      light: sanitizeTerminalColorPalette(
        profile.variants?.light,
        lightFallback
      )
    }
  };
}

export function sanitizeTerminalThemeSettings(
  terminalThemes: Partial<TerminalThemeSettings> | undefined,
  current: TerminalThemeSettings = createDefaultTerminalThemeSettings()
): TerminalThemeSettings {
  const inputProfiles = Array.isArray(terminalThemes?.profiles)
    ? terminalThemes.profiles
    : current.profiles;
  const profiles = BUILTIN_TERMINAL_THEME_PROFILES.map((profile) =>
    cloneTerminalThemeProfile(profile)
  );
  const profileIds = new Set<string>(profiles.map((profile) => profile.id));

  for (const [index, profile] of inputProfiles.entries()) {
    if (
      !profile ||
      (typeof profile.id === "string" && isBuiltinTerminalThemeProfileId(profile.id))
    ) {
      continue;
    }

    const nextProfile = sanitizeTerminalThemeProfile(profile, index);
    if (profileIds.has(nextProfile.id)) {
      continue;
    }
    profileIds.add(nextProfile.id);
    profiles.push(nextProfile);
  }

  const requestedActiveProfileId = sanitizeTerminalThemeId(
    terminalThemes?.activeProfileId,
    current.activeProfileId
  );
  const activeProfileId = profileIds.has(requestedActiveProfileId)
    ? requestedActiveProfileId
    : KMUX_DEFAULT_TERMINAL_THEME_PROFILE_ID;

  return {
    activeProfileId,
    profiles
  };
}

export function resolveTerminalTheme(
  terminalThemes: TerminalThemeSettings | undefined,
  theme: ColorTheme = "dark"
): ResolvedTerminalThemeVm {
  const settings = sanitizeTerminalThemeSettings(terminalThemes);
  const profile =
    settings.profiles.find(
      (candidate) => candidate.id === settings.activeProfileId
    ) ?? settings.profiles[0] ?? BUILTIN_TERMINAL_THEME_PROFILE;

  return {
    profileId: profile.id,
    profileName: profile.name,
    source: profile.source,
    minimumContrastRatio: sanitizeMinimumContrastRatio(
      profile.minimumContrastRatio
    ),
    variant: theme,
    palette: cloneTerminalColorPalette(profile.variants[theme])
  };
}

export function createXtermTheme(
  palette: TerminalColorPalette,
  theme: ColorTheme = "dark"
) {
  const normalizedPalette = sanitizeTerminalColorPalette(
    palette,
    KMUX_DEFAULT_TERMINAL_COLOR_PALETTES[theme]
  );
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  ] = normalizedPalette.ansi;

  return {
    background: normalizedPalette.background,
    foreground: normalizedPalette.foreground,
    cursor: normalizedPalette.cursor,
    cursorAccent: normalizedPalette.cursorText,
    selectionBackground: normalizedPalette.selectionBackground,
    selectionForeground: normalizedPalette.selectionForeground,
    selectionInactiveBackground: THEMES[theme].listHover,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  };
}

const XTERM_THEMES = Object.freeze({
  dark: Object.freeze(createXtermTheme(KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.dark)),
  light: Object.freeze(
    createXtermTheme(KMUX_DEFAULT_TERMINAL_COLOR_PALETTES.light, "light")
  )
});

export const XTERM_THEME = XTERM_THEMES.dark;

const TERMINAL_SEARCH_DECORATIONS_MAP = Object.freeze({
  dark: Object.freeze({
    matchBackground: "rgba(210, 153, 34, 0.24)",
    matchBorder: "#b8952f",
    matchOverviewRuler: "#b8952f",
    activeMatchBackground: "rgba(0, 120, 212, 0.32)",
    activeMatchBorder: THEMES.dark.accent,
    activeMatchColorOverviewRuler: THEMES.dark.accent
  }),
  light: Object.freeze({
    matchBackground: "rgba(185, 137, 43, 0.2)",
    matchBorder: "#a17118",
    matchOverviewRuler: "#a17118",
    activeMatchBackground: "rgba(10, 103, 216, 0.18)",
    activeMatchBorder: THEMES.light.accent,
    activeMatchColorOverviewRuler: THEMES.light.accent
  })
});

export const TERMINAL_SEARCH_DECORATIONS = TERMINAL_SEARCH_DECORATIONS_MAP.dark;

export function getThemeTokens(theme: ColorTheme = "dark"): Readonly<ThemeTokens> {
  return THEMES[theme];
}

export function getThemeCssVariables(
  theme: ColorTheme = "dark"
): Readonly<Record<`--${string}`, string>> {
  return THEME_CSS_VARIABLE_MAP[theme];
}

export function getXtermTheme(theme: ColorTheme = "dark") {
  return XTERM_THEMES[theme];
}

export function getTerminalSearchDecorations(theme: ColorTheme = "dark") {
  return TERMINAL_SEARCH_DECORATIONS_MAP[theme];
}

export function resolveColorTheme(
  mode: ThemeMode,
  prefersDark: boolean
): ColorTheme {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}

export function applyThemeVariables(
  target: HTMLElement | Pick<CSSStyleDeclaration, "setProperty">,
  theme: ColorTheme = "dark"
): void {
  const style = "style" in target ? target.style : target;

  for (const [name, value] of Object.entries(getThemeCssVariables(theme))) {
    style.setProperty(name, value);
  }
}

export function normalizeShortcut(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
  >
): string {
  const parts: string[] = [];

  if (event.metaKey) {
    parts.push("Meta");
  }
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  const key = normalizeShortcutKey(event);
  parts.push(key);
  return parts.join("+");
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcuts: Record<string, string>,
  commandId: string
): boolean {
  return normalizeShortcut(event) === shortcuts[commandId];
}

function normalizeShortcutKey(
  event: Pick<KeyboardEvent, "key" | "code">
): string {
  const fromCode = shortcutKeyFromCode(event.code);
  if (fromCode) {
    return fromCode;
  }
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function shortcutKeyFromCode(code: string): string | null {
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3);
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }

  switch (code) {
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Backquote":
      return "`";
    case "Backslash":
      return "\\";
    case "Enter":
    case "Tab":
    case "Space":
    case "Escape":
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
      return code;
    default:
      return null;
  }
}
