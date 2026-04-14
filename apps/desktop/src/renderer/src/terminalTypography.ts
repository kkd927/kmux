import { KMUX_BUILTIN_SYMBOL_FONT_FAMILY } from "@kmux/core";
import type {
  ResolvedTerminalTypographyVm,
  TerminalTypographyIssue
} from "@kmux/proto";

const PROBE_FONT_SIZE = 16;
const PROBE_EPSILON = 0.35;
const MISSING_GLYPH_REFERENCE = "\u{10fffd}";
const NERD_GLYPH_SAMPLE = "\uf418";
const POWERLINE_GLYPH_SAMPLE = "\ue0b0";
const BOX_DRAWING_SAMPLE = "\u2500";
const MONO_NARROW_SAMPLE = "i";
const MONO_WIDE_SAMPLE = "W";

interface TerminalTypographyProbeMetrics {
  textNarrowWidth: number;
  textWideWidth: number;
  nerdGlyphMissing: boolean;
  powerlineGlyphMissing: boolean;
  powerlineGlyphWidth: number;
  boxDrawingGlyphMissing: boolean;
}

export function applyProbeIssuesToResolvedTypography(
  terminalTypography: ResolvedTerminalTypographyVm,
  probeIssues: TerminalTypographyIssue[]
): ResolvedTerminalTypographyVm {
  const issues = mergeIssues(terminalTypography.issues, probeIssues);
  return {
    ...terminalTypography,
    status: issues.length > 0 ? "degraded" : "ready",
    issues
  };
}

export function classifyTerminalTypographyProbe(
  metrics: TerminalTypographyProbeMetrics
): TerminalTypographyIssue[] {
  const issues: TerminalTypographyIssue[] = [];

  if (
    Number.isFinite(metrics.textNarrowWidth) &&
    Number.isFinite(metrics.textWideWidth) &&
    Math.abs(metrics.textNarrowWidth - metrics.textWideWidth) > PROBE_EPSILON
  ) {
    issues.push({
      code: "non_monospaced_text_font",
      severity: "warning"
    });
  }

  if (metrics.nerdGlyphMissing) {
    issues.push({
      code: "nerd_glyph_missing",
      severity: "warning"
    });
  }

  if (metrics.powerlineGlyphMissing) {
    issues.push({
      code: "powerline_glyph_missing",
      severity: "warning"
    });
  } else {
    const textCellWidth = Math.max(
      metrics.textNarrowWidth,
      metrics.textWideWidth
    );
    if (
      Number.isFinite(textCellWidth) &&
      Number.isFinite(metrics.powerlineGlyphWidth) &&
      Math.abs(metrics.powerlineGlyphWidth - textCellWidth) > PROBE_EPSILON
    ) {
      issues.push({
        code: "powerline_width_mismatch",
        severity: "warning"
      });
    }
  }

  if (
    metrics.boxDrawingGlyphMissing &&
    !issues.some((issue) => issue.code === "symbol_font_missing")
  ) {
    issues.push({
      code: "symbol_font_missing",
      severity: "warning"
    });
  }

  return issues;
}

export async function probeResolvedTerminalTypography(
  terminalTypography: ResolvedTerminalTypographyVm
): Promise<TerminalTypographyIssue[]> {
  if (typeof document === "undefined") {
    return [];
  }

  await document.fonts.ready;
  await document.fonts.load(
    `${PROBE_FONT_SIZE}px ${terminalTypography.resolvedFontFamily}`,
    `${NERD_GLYPH_SAMPLE}${POWERLINE_GLYPH_SAMPLE}${BOX_DRAWING_SAMPLE}${MONO_NARROW_SAMPLE}${MONO_WIDE_SAMPLE}`
  );

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return [];
  }

  const metrics = collectProbeMetrics(
    context,
    terminalTypography.resolvedFontFamily
  );
  return filterProbeIssuesForFallbackFonts(
    terminalTypography,
    classifyTerminalTypographyProbe(metrics)
  );
}

export function describeTerminalTypographyIssue(
  issue: TerminalTypographyIssue
): string {
  switch (issue.code) {
    case "text_font_missing":
      return "The selected text font is not installed on this Mac.";
    case "symbol_font_missing":
      return "kmux could not load its built-in terminal glyph font.";
    case "non_monospaced_text_font":
      return "The selected text font does not behave like a fixed-width terminal font.";
    case "nerd_glyph_missing":
      return "Some terminal icons are still missing.";
    case "powerline_glyph_missing":
      return "Some Powerline separators are still missing.";
    case "powerline_width_mismatch":
      return "Powerline separators are not fitting cleanly into a single terminal cell.";
    default:
      return "Terminal typography validation found a rendering issue.";
  }
}

export function describeTerminalTypographyStatus(
  terminalTypography: ResolvedTerminalTypographyVm
): string {
  if (terminalTypography.status === "ready") {
    return "Ready";
  }
  if (terminalTypography.status === "pending") {
    return "Checking";
  }
  return "Needs attention";
}

export function describeTerminalTypographyHeadline(
  terminalTypography: ResolvedTerminalTypographyVm
): string {
  if (terminalTypography.status === "ready") {
    return "Glyph support ready";
  }
  if (terminalTypography.status === "pending") {
    return "Checking glyph support";
  }
  return terminalTypography.issues.some(
    (issue) => issue.code === "text_font_missing"
  )
    ? "Text font needs attention"
    : "Glyph support needs attention";
}

export function describeTerminalTypographySupportLines(
  terminalTypography: ResolvedTerminalTypographyVm
): string[] {
  const lines: string[] = [];
  const hasGlyphRenderingIssue = terminalTypography.issues.some(
    (issue) =>
      issue.code === "symbol_font_missing" ||
      issue.code === "nerd_glyph_missing" ||
      issue.code === "powerline_glyph_missing" ||
      issue.code === "powerline_width_mismatch"
  );

  if (usesBuiltInGlyphFont(terminalTypography) && !hasGlyphRenderingIssue) {
    lines.push("Using built-in kmux glyph font.");
  }

  const installedGlyphFont = findDetectedInstalledGlyphFont(terminalTypography);
  if (installedGlyphFont) {
    lines.push(`Compatible installed font detected: ${installedGlyphFont}`);
  }

  if (terminalTypography.issues.length > 0) {
    lines.push(
      ...terminalTypography.issues.map((issue) =>
        describeTerminalTypographyIssue(issue)
      )
    );
  }

  if (lines.length === 0) {
    lines.push("Glyph support looks healthy for this terminal stack.");
  }

  return lines;
}

function collectProbeMetrics(
  context: CanvasRenderingContext2D,
  fontFamily: string
): TerminalTypographyProbeMetrics {
  const textNarrowWidth = measureGlyphWidth(
    context,
    fontFamily,
    MONO_NARROW_SAMPLE
  );
  const textWideWidth = measureGlyphWidth(
    context,
    fontFamily,
    MONO_WIDE_SAMPLE
  );
  const powerlineGlyphWidth = measureGlyphWidth(
    context,
    fontFamily,
    POWERLINE_GLYPH_SAMPLE
  );

  return {
    textNarrowWidth,
    textWideWidth,
    nerdGlyphMissing: glyphLooksMissing(context, fontFamily, NERD_GLYPH_SAMPLE),
    powerlineGlyphMissing: glyphLooksMissing(
      context,
      fontFamily,
      POWERLINE_GLYPH_SAMPLE
    ),
    powerlineGlyphWidth,
    boxDrawingGlyphMissing: glyphLooksMissing(
      context,
      fontFamily,
      BOX_DRAWING_SAMPLE
    )
  };
}

function glyphLooksMissing(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  glyph: string
): boolean {
  const glyphPixels = rasterizeGlyph(context, fontFamily, glyph);
  const missingPixels = rasterizeGlyph(
    context,
    fontFamily,
    MISSING_GLYPH_REFERENCE
  );
  return glyphPixels.every((value, index) => value === missingPixels[index]);
}

function rasterizeGlyph(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  glyph: string
): Uint8ClampedArray {
  context.save();
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.font = `${PROBE_FONT_SIZE}px ${fontFamily}`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = "#ffffff";
  context.fillText(glyph, 8, 32);
  const imageData = context.getImageData(
    0,
    0,
    context.canvas.width,
    context.canvas.height
  );
  context.restore();
  return imageData.data;
}

function measureGlyphWidth(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  glyph: string
): number {
  context.save();
  context.font = `${PROBE_FONT_SIZE}px ${fontFamily}`;
  const width = context.measureText(glyph).width;
  context.restore();
  return width;
}

function mergeIssues(
  left: TerminalTypographyIssue[],
  right: TerminalTypographyIssue[]
): TerminalTypographyIssue[] {
  const merged = new Map<string, TerminalTypographyIssue>();
  for (const issue of [...left, ...right]) {
    merged.set(issue.code, issue);
  }
  return [...merged.values()];
}

export function filterProbeIssuesForFallbackFonts(
  terminalTypography: ResolvedTerminalTypographyVm,
  issues: TerminalTypographyIssue[]
): TerminalTypographyIssue[] {
  if (terminalTypography.symbolFallbackFamilies.length === 0) {
    return issues;
  }

  // Canvas width measurements are not reliable once the browser resolves the
  // glyph from a fallback font, so keep missing-glyph detection but suppress
  // width-mismatch warnings for fallback-driven symbol rendering.
  return issues.filter((issue) => issue.code !== "powerline_width_mismatch");
}

function usesBuiltInGlyphFont(
  terminalTypography: ResolvedTerminalTypographyVm
): boolean {
  return terminalTypography.symbolFallbackFamilies.some(
    (fontFamily) =>
      normalizeFontFamilyName(fontFamily) ===
      normalizeFontFamilyName(KMUX_BUILTIN_SYMBOL_FONT_FAMILY)
  );
}

function findDetectedInstalledGlyphFont(
  terminalTypography: ResolvedTerminalTypographyVm
): string | null {
  return (
    terminalTypography.symbolFallbackFamilies.find(
      (fontFamily) =>
        /Nerd Font|Powerline/i.test(fontFamily) &&
        normalizeFontFamilyName(fontFamily) !==
          normalizeFontFamilyName(KMUX_BUILTIN_SYMBOL_FONT_FAMILY)
    ) ?? null
  );
}

function normalizeFontFamilyName(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim().toLowerCase();
  }
  return trimmed.toLowerCase();
}
