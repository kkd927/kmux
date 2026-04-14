import { KMUX_BUILTIN_SYMBOL_FONT_FAMILY } from "@kmux/core";
import type { ResolvedTerminalTypographyVm } from "@kmux/proto";

import {
  applyProbeIssuesToResolvedTypography,
  classifyTerminalTypographyProbe,
  describeTerminalTypographyHeadline,
  describeTerminalTypographyStatus,
  describeTerminalTypographySupportLines,
  filterProbeIssuesForFallbackFonts
} from "./terminalTypography";

describe("terminal typography probe helpers", () => {
  it("flags monospacing and symbol issues from probe metrics", () => {
    const issues = classifyTerminalTypographyProbe({
      textNarrowWidth: 5,
      textWideWidth: 9,
      nerdGlyphMissing: true,
      powerlineGlyphMissing: false,
      powerlineGlyphWidth: 14,
      boxDrawingGlyphMissing: true
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_monospaced_text_font" }),
        expect.objectContaining({ code: "nerd_glyph_missing" }),
        expect.objectContaining({ code: "powerline_width_mismatch" }),
        expect.objectContaining({ code: "symbol_font_missing" })
      ])
    );
  });

  it("marks a resolved stack as ready only when no probe issues remain", () => {
    const baseVm: ResolvedTerminalTypographyVm = {
      stackHash: "abc123",
      resolvedFontFamily: `"JetBrains Mono", ${KMUX_BUILTIN_SYMBOL_FONT_FAMILY}`,
      textFontFamily: '"JetBrains Mono"',
      symbolFallbackFamilies: [KMUX_BUILTIN_SYMBOL_FONT_FAMILY],
      autoFallbackApplied: true,
      status: "pending",
      issues: []
    };

    const readyVm = applyProbeIssuesToResolvedTypography(baseVm, []);
    expect(readyVm.status).toBe("ready");

    const degradedVm = applyProbeIssuesToResolvedTypography(baseVm, [
      {
        code: "powerline_glyph_missing",
        severity: "warning"
      }
    ]);
    expect(degradedVm.status).toBe("degraded");
    expect(degradedVm.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "powerline_glyph_missing" })
      ])
    );
  });

  it("describes ready glyph support in user-facing language", () => {
    const readyVm: ResolvedTerminalTypographyVm = {
      stackHash: "ready",
      resolvedFontFamily: `"JetBrains Mono", ${KMUX_BUILTIN_SYMBOL_FONT_FAMILY}, "JetBrainsMono Nerd Font Mono"`,
      textFontFamily: '"JetBrains Mono"',
      symbolFallbackFamilies: [
        KMUX_BUILTIN_SYMBOL_FONT_FAMILY,
        "JetBrainsMono Nerd Font Mono"
      ],
      autoFallbackApplied: true,
      status: "ready",
      issues: []
    };

    expect(describeTerminalTypographyStatus(readyVm)).toBe("Ready");
    expect(describeTerminalTypographyHeadline(readyVm)).toBe(
      "Glyph support ready"
    );
    expect(describeTerminalTypographySupportLines(readyVm)).toEqual([
      "Using built-in kmux glyph font.",
      "Compatible installed font detected: JetBrainsMono Nerd Font Mono"
    ]);
  });

  it("suppresses fallback font width mismatch probe noise", () => {
    const vm: ResolvedTerminalTypographyVm = {
      stackHash: "fallback",
      resolvedFontFamily: `"JetBrains Mono", ${KMUX_BUILTIN_SYMBOL_FONT_FAMILY}`,
      textFontFamily: '"JetBrains Mono"',
      symbolFallbackFamilies: [KMUX_BUILTIN_SYMBOL_FONT_FAMILY],
      autoFallbackApplied: true,
      status: "pending",
      issues: []
    };

    expect(
      filterProbeIssuesForFallbackFonts(vm, [
        {
          code: "powerline_width_mismatch",
          severity: "warning"
        },
        {
          code: "nerd_glyph_missing",
          severity: "warning"
        }
      ])
    ).toEqual([
      {
        code: "nerd_glyph_missing",
        severity: "warning"
      }
    ]);
  });
});
