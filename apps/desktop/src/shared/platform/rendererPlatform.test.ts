import { describe, expect, it } from "vitest";

import { DEFAULT_SHORTCUTS, LINUX_DEFAULT_SHORTCUTS } from "@kmux/ui";

import {
  createFallbackRendererPlatformDescriptor,
  createRendererPlatformDescriptor
} from "./rendererPlatform";

describe("renderer platform descriptor", () => {
  it("builds a serializable Linux descriptor with the full text shortcut catalog", () => {
    const descriptor = createRendererPlatformDescriptor({
      windowChrome: "native",
      shortcutStyle: "text",
      keyboardPlatform: "linux",
      supportsDock: false,
      supportsTray: true,
      keepProcessAliveWhenLastWindowCloses: false
    });

    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(descriptor.keyboard.platform).toBe("linux");
    expect(descriptor.keyboard.labelStyle).toBe("text");
    expect(descriptor.keyboard.shortcuts).toEqual(LINUX_DEFAULT_SHORTCUTS);
    expect(descriptor.desktop).toEqual({
      supportsDock: false,
      supportsTray: true,
      keepProcessAliveWhenLastWindowCloses: false
    });
    expect(descriptor.debugging).toEqual({
      surfaceDiagnosticCaptureDefaultEnabled: false
    });
  });

  it("keeps macOS fallback descriptors on the compatibility shortcut catalog", () => {
    const descriptor = createFallbackRendererPlatformDescriptor("darwin");

    expect(descriptor.windowChrome).toBe("native");
    expect(descriptor.desktop.supportsTray).toBe(false);
    expect(descriptor.keyboard.platform).toBe("darwin");
    expect(descriptor.keyboard.labelStyle).toBe("mac-symbols");
    expect(descriptor.keyboard.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(descriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled).toBe(
      false
    );
  });

  it("uses native chrome and Linux keyboard policy for non-macOS fallback descriptors", () => {
    const descriptor = createFallbackRendererPlatformDescriptor("other");

    expect(descriptor.windowChrome).toBe("native");
    expect(descriptor.desktop.supportsTray).toBe(true);
    expect(descriptor.keyboard.platform).toBe("linux");
    expect(descriptor.keyboard.labelStyle).toBe("text");
    expect(descriptor.keyboard.shortcuts).toEqual(LINUX_DEFAULT_SHORTCUTS);
    expect(descriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled).toBe(
      false
    );
  });
});
