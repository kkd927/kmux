import {
  BUILTIN_TERMINAL_THEME_PROFILES,
  BUILTIN_TERMINAL_THEME_PROFILE,
  INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE,
  THEMES,
  TERMINAL_SEARCH_DECORATIONS,
  THEME,
  THEME_CSS_VARIABLES,
  XTERM_THEME,
  getTerminalSearchDecorations,
  getThemeCssVariables,
  getXtermTheme,
  resolveColorTheme,
  normalizeShortcut
} from "./index";

describe("shortcut normalization", () => {
  it("uses KeyboardEvent.code for option-modified letter shortcuts", () => {
    expect(
      normalizeShortcut({
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        key: "˚",
        code: "KeyK"
      } as KeyboardEvent)
    ).toBe("Meta+Alt+K");
  });

  it("normalizes punctuation shortcuts from KeyboardEvent.code", () => {
    expect(
      normalizeShortcut({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        key: ",",
        code: "Comma"
      } as KeyboardEvent)
    ).toBe("Meta+,");
  });
});

describe("shared theme tokens", () => {
  it("maps exported theme colors into renderer css variables", () => {
    expect(THEME_CSS_VARIABLES["--window-bg"]).toBe(THEME.windowBg);
    expect(THEME_CSS_VARIABLES["--tab-active-bg"]).toBe(THEME.tabActiveBg);
    expect(THEME_CSS_VARIABLES["--list-active"]).toBe(THEME.listActive);
    expect(getThemeCssVariables("light")["--sidebar-bg"]).toBe(THEMES.light.sidebarBg);
  });

  it("keeps xterm colors aligned with the semantic shell palette", () => {
    expect(XTERM_THEME.background).toBe(THEME.panelBg);
    expect(XTERM_THEME.cursor).toBe(BUILTIN_TERMINAL_THEME_PROFILE.variants.dark.cursor);
    expect(TERMINAL_SEARCH_DECORATIONS.activeMatchBorder).toBe(THEME.accent);
    expect(getXtermTheme("light").background).toBe(THEMES.light.panelBg);
    expect(getTerminalSearchDecorations("light").activeMatchBorder).toBe(
      THEMES.light.accent
    );
  });

  it("resolves system color themes from the current OS preference", () => {
    expect(resolveColorTheme("system", true)).toBe("dark");
    expect(resolveColorTheme("system", false)).toBe("light");
    expect(resolveColorTheme("light", true)).toBe("light");
  });

  it("keeps the built-in dark terminal palette legible against the shell background", () => {
    const darkPalette = BUILTIN_TERMINAL_THEME_PROFILE.variants.dark;
    const background = darkPalette.background;
    const ansiBlackContrast = contrastRatio(darkPalette.ansi[0], background);
    const brightBlackContrast = contrastRatio(darkPalette.ansi[8], background);

    expect(BUILTIN_TERMINAL_THEME_PROFILE.minimumContrastRatio).toBe(2.5);
    expect(contrastRatio(darkPalette.foreground, background)).toBeGreaterThan(10);
    expect(ansiBlackContrast).toBeGreaterThan(2);
    expect(brightBlackContrast).toBeGreaterThan(ansiBlackContrast);
  });

  it("keeps the built-in light terminal palette legible against the shell background", () => {
    const lightPalette = BUILTIN_TERMINAL_THEME_PROFILE.variants.light;
    const background = lightPalette.background;

    expect(contrastRatio(lightPalette.foreground, background)).toBeGreaterThan(14);
    expect(contrastRatio(lightPalette.ansi[7], background)).toBeGreaterThan(4);
    expect(contrastRatio(lightPalette.ansi[15], background)).toBeGreaterThan(
      contrastRatio(lightPalette.ansi[7], background)
    );
  });

  it("keeps kmux default and IntelliJ Islands plain-text tones intentionally distinct", () => {
    expect(BUILTIN_TERMINAL_THEME_PROFILE.variants.dark.foreground).toBe("#e3e8ef");
    expect(INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE.variants.dark.foreground).toBe(
      "#cccccc"
    );
    expect(BUILTIN_TERMINAL_THEME_PROFILE.variants.light.foreground).toBe("#232c35");
    expect(INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE.variants.light.foreground).toBe(
      "#080808"
    );
  });

  it("ships both kmux default and IntelliJ Islands terminal presets", () => {
    expect(BUILTIN_TERMINAL_THEME_PROFILES.map((profile) => profile.name)).toEqual([
      "kmux Default",
      "IntelliJ Islands"
    ]);
    expect(INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE.variants.dark.background).toBe(
      "#191a1c"
    );
    expect(INTELLIJ_ISLANDS_TERMINAL_THEME_PROFILE.variants.dark.foreground).toBe(
      "#cccccc"
    );
  });
});

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseHexColor(foreground));
  const bg = relativeLuminance(parseHexColor(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return Number((((lighter + 0.05) / (darker + 0.05)) * 1000).toFixed(0)) / 1000;
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * toLinear(red) +
    0.7152 * toLinear(green) +
    0.0722 * toLinear(blue)
  );
}

function parseHexColor(color: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new Error(`expected 6-digit hex color, received ${color}`);
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ];
}
