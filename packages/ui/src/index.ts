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
  "surface.rename": "Meta+Ctrl+R",
  "surface.close": "Meta+W",
  "surface.closeOthers": "Meta+Ctrl+W",
  "surface.next": "Ctrl+Tab",
  "surface.prev": "Ctrl+Shift+Tab",
  "command.palette": "Meta+Shift+P",
  "notifications.toggle": "Meta+I",
  "settings.toggle": "Meta+,",
  "terminal.search": "Meta+F",
  "terminal.search.next": "Meta+G",
  "terminal.search.prev": "Meta+Shift+G",
  "terminal.copy": "Meta+C",
  "terminal.paste": "Meta+V",
  "terminal.copyMode": "Meta+Shift+M"
};

const THEME_TOKENS = {
  windowBg: "#181818",
  shellBg: "#181818",
  titlebarBg: "#181818",
  titlebarInactiveBg: "#151515",
  titlebarGlow: "rgba(255, 255, 255, 0.04)",
  chromeBg: "#1b1b1b",
  chromeElevated: "#202020",
  panelBg: "#1f1f1f",
  panelMuted: "#181818",
  sidebarBg: "#181818",
  sidebarHeaderBg: "#181818",
  tabBg: "#181818",
  tabInactiveBg: "#181818",
  tabActiveBg: "#1f1f1f",
  tabHoverBg: "#232323",
  tabIndicator: "#0078d4",
  cardBg: "#1f1f1f",
  cardHover: "#232323",
  cardActive: "rgba(0, 120, 212, 0.14)",
  cardActiveBorder: "rgba(0, 120, 212, 0.3)",
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
} as const satisfies Record<keyof typeof THEME_TOKENS, `--${string}`>;

type ThemeTokenName = keyof typeof THEME_TOKENS;

export const THEME = Object.freeze(THEME_TOKENS);

export const THEME_CSS_VARIABLES = Object.freeze(
  Object.fromEntries(
    (
      Object.entries(CSS_VARIABLE_NAMES) as Array<
        [ThemeTokenName, `--${string}`]
      >
    ).map(([tokenName, variableName]) => [variableName, THEME[tokenName]])
  )
) as Readonly<Record<`--${string}`, string>>;

export const XTERM_THEME = Object.freeze({
  background: THEME.panelBg,
  foreground: "#d4d4d4",
  cursor: THEME.textPrimary,
  cursorAccent: THEME.panelBg,
  selectionBackground: THEME.selectionBg,
  selectionForeground: "#ffffff",
  selectionInactiveBackground: THEME.listHover,
  black: "#1e1e1e",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#dcdcaa",
  blue: "#3794ff",
  magenta: "#c586c0",
  cyan: "#29b8db",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5"
});

export const TERMINAL_SEARCH_DECORATIONS = Object.freeze({
  matchBackground: "rgba(210, 153, 34, 0.24)",
  matchBorder: "#b8952f",
  matchOverviewRuler: "#b8952f",
  activeMatchBackground: "rgba(0, 120, 212, 0.32)",
  activeMatchBorder: THEME.accent,
  activeMatchColorOverviewRuler: THEME.accent
});

export function applyThemeVariables(
  target: HTMLElement | Pick<CSSStyleDeclaration, "setProperty">
): void {
  const style = "style" in target ? target.style : target;

  for (const [name, value] of Object.entries(THEME_CSS_VARIABLES)) {
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
