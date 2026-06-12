import {
  buildPlatformKeyboardPolicy,
  type KeyboardShortcutPlatform,
  type PlatformKeyboardPolicy
} from "./keyboardPolicy";

export interface RendererPlatformDescriptor {
  windowChrome: "native" | "custom";
  shortcutStyle: "mac-symbols" | "text";
  keyboard: PlatformKeyboardPolicy;
  desktop: {
    supportsDock: boolean;
    supportsTray: boolean;
    keepProcessAliveWhenLastWindowCloses: boolean;
  };
}

export function createRendererPlatformDescriptor(options: {
  windowChrome: RendererPlatformDescriptor["windowChrome"];
  shortcutStyle: RendererPlatformDescriptor["shortcutStyle"];
  supportsDock: boolean;
  supportsTray?: boolean;
  keepProcessAliveWhenLastWindowCloses: boolean;
  keyboardPlatform?: KeyboardShortcutPlatform;
  keyboard?: PlatformKeyboardPolicy;
}): RendererPlatformDescriptor {
  const keyboardPlatform =
    options.keyboardPlatform ??
    (options.shortcutStyle === "mac-symbols" ? "darwin" : "linux");
  return {
    windowChrome: options.windowChrome,
    shortcutStyle: options.shortcutStyle,
    keyboard:
      options.keyboard ??
      buildPlatformKeyboardPolicy({
        platform: keyboardPlatform,
        labelStyle: options.shortcutStyle
      }),
    desktop: {
      supportsDock: options.supportsDock,
      supportsTray: options.supportsTray ?? false,
      keepProcessAliveWhenLastWindowCloses:
        options.keepProcessAliveWhenLastWindowCloses
    }
  };
}

export function createFallbackRendererPlatformDescriptor(
  platformHint: "darwin" | "other"
): RendererPlatformDescriptor {
  const isMac = platformHint === "darwin";
  return createRendererPlatformDescriptor({
    windowChrome: "native",
    shortcutStyle: isMac ? "mac-symbols" : "text",
    supportsDock: isMac,
    supportsTray: !isMac,
    keepProcessAliveWhenLastWindowCloses: isMac
  });
}
