import plist from "plist";

import {
  parseItermcolorsPalette,
  serializeItermcolorsPalette
} from "./itermcolors";

const { build: buildPlist } = plist;

describe("iTerm2 color preset codec", () => {
  it("round-trips a terminal palette through .itermcolors", () => {
    const palette = {
      foreground: "#d4d4d4",
      background: "#1f1f1f",
      cursor: "#d4d4d4",
      cursorText: "#1f1f1f",
      selectionBackground: "rgba(212, 212, 212, 0.28)",
      selectionForeground: "#ffffff",
      ansi: [
        "#1e1e1e",
        "#f14c4c",
        "#23d18b",
        "#dcdcaa",
        "#3794ff",
        "#c586c0",
        "#29b8db",
        "#d4d4d4",
        "#808080",
        "#f14c4c",
        "#23d18b",
        "#f5f543",
        "#3b8eea",
        "#d670d6",
        "#29b8db",
        "#e5e5e5"
      ]
    };

    const imported = parseItermcolorsPalette(
      serializeItermcolorsPalette(palette),
      "Noctis"
    );

    expect(imported.suggestedName).toBe("Noctis");
    expect(imported.warnings).toEqual([]);
    expect(imported.palette).toEqual(palette);
  });

  it("fills missing cursor and selection colors with fallbacks", () => {
    const preset = buildPlist({
      "Foreground Color": hexColor("#d4d4d4"),
      "Background Color": hexColor("#1f1f1f"),
      ...Object.fromEntries(
        Array.from({ length: 16 }, (_value, index) => [
          `Ansi ${index} Color`,
          hexColor(`#${index.toString(16).repeat(6)}`)
        ])
      )
    });

    const imported = parseItermcolorsPalette(preset, "Fallbacks");

    expect(imported.palette.cursor).toBe("#d4d4d4");
    expect(imported.palette.cursorText).toBe("#1f1f1f");
    expect(imported.palette.selectionBackground).toBe(
      "rgba(212, 212, 212, 0.28)"
    );
    expect(imported.palette.selectionForeground).toBe("#d4d4d4");
    expect(imported.warnings).toEqual([
      "Cursor Color missing; using foreground",
      "Cursor Text Color missing; using background",
      "Selection Color missing; deriving a translucent selection",
      "Selected Text Color missing; using foreground"
    ]);
  });

  it("rejects presets that omit required ANSI slots", () => {
    const preset = buildPlist({
      "Foreground Color": hexColor("#d4d4d4"),
      "Background Color": hexColor("#1f1f1f")
    });

    expect(() => parseItermcolorsPalette(preset)).toThrow(
      "Invalid iTerm2 color preset: missing Ansi 0 Color"
    );
  });
});

function hexColor(value: string): {
  "Red Component": number;
  "Green Component": number;
  "Blue Component": number;
  "Alpha Component": number;
} {
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);

  return {
    "Red Component": red / 255,
    "Green Component": green / 255,
    "Blue Component": blue / 255,
    "Alpha Component": 1
  };
}
