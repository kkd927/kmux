import {
  TERMINAL_SEARCH_DECORATIONS,
  THEME,
  THEME_CSS_VARIABLES,
  XTERM_THEME,
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
  });

  it("keeps xterm colors aligned with the semantic shell palette", () => {
    expect(XTERM_THEME.background).toBe(THEME.panelBg);
    expect(XTERM_THEME.cursor).toBe(THEME.textPrimary);
    expect(TERMINAL_SEARCH_DECORATIONS.activeMatchBorder).toBe(THEME.accent);
  });
});
