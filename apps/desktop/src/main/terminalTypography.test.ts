import {
  createDefaultTerminalTypographySettings,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY
} from "@kmux/core";

import { TerminalTypographyController } from "./terminalTypography";

describe("terminal typography controller", () => {
  it("builds the stack from the user text font, saved symbol fallbacks, and the built-in glyph font", () => {
    const controller = new TerminalTypographyController({
      initialSettings: {
        ...createDefaultTerminalTypographySettings(),
        preferredTextFontFamily: '"Fira Code", monospace',
        preferredSymbolFallbackFamilies: ["Legacy Nerd Font Mono"]
      }
    });

    expect(controller.getViewModel()).toEqual(
      expect.objectContaining({
        textFontFamily: '"Fira Code", monospace',
        symbolFallbackFamilies: [
          "Legacy Nerd Font Mono",
          KMUX_BUILTIN_SYMBOL_FONT_FAMILY
        ],
        status: "pending",
        issues: []
      })
    );
    expect(controller.getViewModel().resolvedFontFamily).toContain(
      '"Fira Code"'
    );
  });

  it("does not duplicate the text font in the symbol fallback stack", () => {
    const controller = new TerminalTypographyController({
      initialSettings: {
        ...createDefaultTerminalTypographySettings(),
        preferredTextFontFamily: '"Legacy Nerd Font Mono", monospace',
        preferredSymbolFallbackFamilies: ["Legacy Nerd Font Mono"]
      }
    });

    expect(controller.getViewModel().symbolFallbackFamilies).toEqual([
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    ]);
  });

  it("keeps preview side-effect free", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings()
    });
    const initialView = controller.getViewModel();

    const preview = await controller.preview({
      ...createDefaultTerminalTypographySettings(),
      preferredTextFontFamily: '"Fira Code", monospace'
    });

    expect(preview.textFontFamily).toBe('"Fira Code", monospace');
    expect(preview.symbolFallbackFamilies).toContain(
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    );
    expect(controller.getViewModel()).toEqual(initialView);
  });

  it("ignores stale probe reports and applies the current renderer probe", () => {
    const onDidChange = vi.fn();
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      onDidChange
    });
    const initialView = controller.getViewModel();

    controller.reportProbe({
      stackHash: "stale-stack",
      issues: [{ code: "powerline_glyph_missing", severity: "warning" }]
    });
    expect(controller.getViewModel()).toEqual(initialView);
    expect(onDidChange).not.toHaveBeenCalled();

    controller.reportProbe({ stackHash: initialView.stackHash, issues: [] });
    expect(controller.getViewModel().status).toBe("ready");
    expect(onDidChange).toHaveBeenCalledTimes(1);
  });
});
