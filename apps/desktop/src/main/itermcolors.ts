import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";
import { basename, extname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";
import plist from "plist";

import type {
  ImportedTerminalThemePalette,
  TerminalColorPalette
} from "@kmux/proto";

const { build: buildPlist, parse: parsePlist } = plist;

const COLOR_DICT_SCHEMA = z.object({
  "Red Component": z.number(),
  "Green Component": z.number(),
  "Blue Component": z.number(),
  "Alpha Component": z.number().optional()
});

const ANSI_COLOR_KEYS = Array.from(
  { length: 16 },
  (_value, index) => `Ansi ${index} Color`
);

const REQUIRED_COLOR_KEYS = [
  "Foreground Color",
  "Background Color",
  ...ANSI_COLOR_KEYS
] as const;

export async function importItermcolorsPalette(
  window: BrowserWindow | null
): Promise<ImportedTerminalThemePalette | null> {
  const dialogOptions: OpenDialogOptions = {
    title: "Import iTerm2 Color Preset",
    filters: [{ name: "iTerm2 Color Presets", extensions: ["itermcolors"] }],
    properties: ["openFile"]
  };
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) {
    return null;
  }

  const contents = readFileSync(filePath, "utf8");
  return parseItermcolorsPalette(
    contents,
    basename(filePath, extname(filePath)) || "Imported Theme"
  );
}

export async function exportItermcolorsPalette(
  window: BrowserWindow | null,
  suggestedName: string,
  palette: TerminalColorPalette
): Promise<boolean> {
  const dialogOptions: SaveDialogOptions = {
    title: "Export iTerm2 Color Preset",
    defaultPath: `${sanitizeSuggestedName(suggestedName)}.itermcolors`,
    filters: [{ name: "iTerm2 Color Presets", extensions: ["itermcolors"] }]
  };
  const result = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) {
    return false;
  }

  writeFileSync(result.filePath, serializeItermcolorsPalette(palette), "utf8");
  return true;
}

export function parseItermcolorsPalette(
  contents: string,
  suggestedName = "Imported Theme"
): ImportedTerminalThemePalette {
  let preset: unknown;
  try {
    preset = parsePlist(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid iTerm2 color preset: ${message}`);
  }

  if (!isRecord(preset)) {
    throw new Error("Invalid iTerm2 color preset: root plist must be a dictionary");
  }

  for (const key of REQUIRED_COLOR_KEYS) {
    if (!(key in preset)) {
      throw new Error(`Invalid iTerm2 color preset: missing ${key}`);
    }
  }

  const foreground = readRequiredColor(preset, "Foreground Color");
  const background = readRequiredColor(preset, "Background Color");
  const ansi = ANSI_COLOR_KEYS.map((key) => readRequiredColor(preset, key));
  const warnings: string[] = [];

  const cursor = readOptionalColor(preset, "Cursor Color");
  if (!cursor) {
    warnings.push("Cursor Color missing; using foreground");
  }

  const cursorText = readOptionalColor(preset, "Cursor Text Color");
  if (!cursorText) {
    warnings.push("Cursor Text Color missing; using background");
  }

  const selectionBackground = readOptionalColor(preset, "Selection Color");
  if (!selectionBackground) {
    warnings.push("Selection Color missing; deriving a translucent selection");
  }

  const selectionForeground = readOptionalColor(preset, "Selected Text Color");
  if (!selectionForeground) {
    warnings.push("Selected Text Color missing; using foreground");
  }

  return {
    suggestedName: sanitizeSuggestedName(suggestedName) || "Imported Theme",
    warnings,
    palette: {
      foreground,
      background,
      cursor: cursor ?? foreground,
      cursorText: cursorText ?? background,
      selectionBackground:
        selectionBackground ?? withAlpha(foreground, 0.28),
      selectionForeground: selectionForeground ?? foreground,
      ansi
    }
  };
}

export function serializeItermcolorsPalette(
  palette: TerminalColorPalette
): string {
  const root: Record<string, ReturnType<typeof colorToItermDict>> = {
    "Foreground Color": colorToItermDict(palette.foreground),
    "Background Color": colorToItermDict(palette.background),
    "Cursor Color": colorToItermDict(palette.cursor),
    "Cursor Text Color": colorToItermDict(palette.cursorText),
    "Selection Color": colorToItermDict(palette.selectionBackground),
    "Selected Text Color": colorToItermDict(palette.selectionForeground)
  };

  ANSI_COLOR_KEYS.forEach((key, index) => {
    root[key] = colorToItermDict(palette.ansi[index] ?? palette.foreground);
  });

  return buildPlist(root);
}

function readRequiredColor(root: Record<string, unknown>, key: string): string {
  const value = COLOR_DICT_SCHEMA.safeParse(root[key]);
  if (!value.success) {
    throw new Error(`Invalid iTerm2 color preset: ${key} is not a color dictionary`);
  }
  return formatCssColor(value.data);
}

function readOptionalColor(
  root: Record<string, unknown>,
  key: string
): string | null {
  if (!(key in root)) {
    return null;
  }
  return readRequiredColor(root, key);
}

function formatCssColor(
  color: z.infer<typeof COLOR_DICT_SCHEMA>
): string {
  const red = componentToByte(color["Red Component"]);
  const green = componentToByte(color["Green Component"]);
  const blue = componentToByte(color["Blue Component"]);
  const alpha = normalizeAlpha(color["Alpha Component"]);

  if (alpha >= 1) {
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${trimAlpha(alpha)})`;
}

function componentToByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function normalizeAlpha(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function trimAlpha(alpha: number): string {
  return Number(alpha.toFixed(4)).toString();
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function withAlpha(color: string, alpha: number): string {
  const rgba = parseCssColor(color);
  return `rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, ${trimAlpha(alpha)})`;
}

function colorToItermDict(color: string): {
  "Red Component": number;
  "Green Component": number;
  "Blue Component": number;
  "Alpha Component": number;
} {
  const parsed = parseCssColor(color);
  return {
    "Red Component": parsed.red / 255,
    "Green Component": parsed.green / 255,
    "Blue Component": parsed.blue / 255,
    "Alpha Component": parsed.alpha
  };
}

function parseCssColor(color: string): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  const value = color.trim();
  if (value.startsWith("#")) {
    return parseHexColor(value);
  }

  const rgbaMatch = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([01]?(?:\.\d+)?))?\s*\)$/i
  );
  if (rgbaMatch) {
    return {
      red: clampChannel(Number(rgbaMatch[1])),
      green: clampChannel(Number(rgbaMatch[2])),
      blue: clampChannel(Number(rgbaMatch[3])),
      alpha: normalizeAlpha(
        rgbaMatch[4] ? Number(rgbaMatch[4]) : 1
      )
    };
  }

  throw new Error(`Unsupported CSS color for iTerm2 export: ${color}`);
}

function parseHexColor(hexColor: string): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  const hex = hexColor.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const expanded = hex
      .split("")
      .map((part) => `${part}${part}`)
      .join("");
    return parseHexColor(`#${expanded}`);
  }

  if (hex.length !== 6 && hex.length !== 8) {
    throw new Error(`Unsupported CSS color for iTerm2 export: ${hexColor}`);
  }

  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
    alpha:
      hex.length === 8
        ? normalizeAlpha(Number.parseInt(hex.slice(6, 8), 16) / 255)
        : 1
  };
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sanitizeSuggestedName(name: string): string {
  return name.replace(/\.itermcolors$/i, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
