import {
  createDefaultTerminalTypographySettings,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY
} from "@kmux/core";

import {
  TerminalTypographyController,
  createStaticFontInventoryProvider
} from "./terminalTypography";

describe("terminal typography controller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always includes the built-in glyph font and appends compatible installed fonts", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: createStaticFontInventoryProvider([
        "JetBrains Mono",
        "Symbols Nerd Font Mono",
        "Hack Nerd Font Mono"
      ])
    });

    await controller.listFontFamilies();

    expect(controller.getViewModel().symbolFallbackFamilies).toEqual([
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY,
      "Symbols Nerd Font Mono",
      "Hack Nerd Font Mono"
    ]);
    expect(controller.getViewModel().autoFallbackApplied).toBe(true);
    expect(controller.getViewModel().status).toBe("pending");
  });

  it("detects JetBrainsMono Nerd Font Mono on the first resolution pass", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: createStaticFontInventoryProvider([
        "JetBrains Mono",
        "JetBrainsMono Nerd Font Mono"
      ])
    });

    await controller.listFontFamilies();
    const resolvedView = controller.getViewModel();

    expect(resolvedView.symbolFallbackFamilies).toEqual([
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY,
      "JetBrainsMono Nerd Font Mono"
    ]);
    expect(resolvedView.status).toBe("pending");

    controller.reportProbe({
      stackHash: resolvedView.stackHash,
      issues: []
    });

    expect(controller.getViewModel().status).toBe("ready");
  });

  it("keeps legacy symbol fallback preferences ahead of the built-in glyph font", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: {
        ...createDefaultTerminalTypographySettings(),
        preferredSymbolFallbackFamilies: ["Legacy Nerd Font Mono"]
      },
      fontInventoryProvider: createStaticFontInventoryProvider([
        "JetBrains Mono"
      ])
    });

    await controller.listFontFamilies();

    expect(controller.getViewModel().symbolFallbackFamilies).toEqual([
      "Legacy Nerd Font Mono",
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    ]);
  });

  it("does not reintroduce system monospace fonts as symbol fallbacks", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: createStaticFontInventoryProvider([
        "JetBrains Mono",
        "Menlo"
      ])
    });

    await controller.listFontFamilies();

    expect(controller.getViewModel().symbolFallbackFamilies).toEqual([
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    ]);
  });

  it("keeps preview side-effect free and ignores stale probe reports", async () => {
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: createStaticFontInventoryProvider([
        "JetBrains Mono",
        "Symbols Nerd Font Mono"
      ])
    });

    await controller.listFontFamilies();
    const initialView = controller.getViewModel();

    const preview = await controller.preview({
      ...createDefaultTerminalTypographySettings(),
      preferredTextFontFamily: '"Fira Code", monospace'
    });

    expect(preview.textFontFamily).toBe('"Fira Code", monospace');
    expect(preview.symbolFallbackFamilies).toContain(
      KMUX_BUILTIN_SYMBOL_FONT_FAMILY
    );
    expect(controller.getViewModel().textFontFamily).toBe(
      initialView.textFontFamily
    );

    controller.reportProbe({
      stackHash: "stale-stack",
      issues: [
        {
          code: "powerline_glyph_missing",
          severity: "warning"
        }
      ]
    });

    expect(controller.getViewModel()).toEqual(initialView);
  });

  it("suppresses font inventory warnings once shutdown has started", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: {
        async listFontFamilies() {
          throw new Error("system profiler unavailable");
        }
      },
      shouldLogInventoryErrors: () => false
    });

    await expect(controller.listFontFamilies()).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("swallows broken-pipe logging failures while falling back to pending typography state", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    });
    const controller = new TerminalTypographyController({
      initialSettings: createDefaultTerminalTypographySettings(),
      fontInventoryProvider: {
        async listFontFamilies() {
          throw new Error("system profiler unavailable");
        }
      }
    });

    await expect(controller.listFontFamilies()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to load terminal font inventory",
      expect.any(Error)
    );
    expect(controller.getViewModel().status).toBe("pending");
  });
});
