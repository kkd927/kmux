import { describe, expect, it } from "vitest";

import {
  createPlatformRuntime,
  requirePlatformRuntime,
  UnsupportedPlatformError
} from "./runtime";

describe("platform runtime", () => {
  it("keeps macOS desktop behavior as the compatibility baseline", () => {
    const runtime = requirePlatformRuntime({
      platform: "darwin",
      isPackaged: true,
      env: {}
    });

    expect(runtime).toMatchObject({
      supported: true,
      platformId: "darwin",
      desktop: {
        isMac: true,
        supportsDock: true,
        keepProcessAliveWhenLastWindowCloses: true,
        window: {
          isMac: true,
          supportsDock: true,
          windowChrome: "native"
        }
      },
      opener: {
        platform: "darwin",
        useMacTextEditorFirst: true
      },
      shell: {
        platform: "darwin",
        enablePosixShellIntegration: true
      },
      updater: {
        enabled: true
      },
      rendererDescriptor: {
        windowChrome: "native",
        shortcutStyle: "mac-symbols",
        keyboard: {
          platform: "darwin"
        },
        desktop: {
          supportsDock: true,
          keepProcessAliveWhenLastWindowCloses: true
        },
        debugging: {
          surfaceDiagnosticCaptureDefaultEnabled: false
        }
      }
    });
  });

  it("describes Linux as custom chrome with text shortcuts and no Dock lifetime", () => {
    const runtime = requirePlatformRuntime({
      platform: "linux",
      isPackaged: true,
      env: {
        APPIMAGE: "/tmp/kmux-0.3.12-linux-x64.AppImage"
      }
    });

    expect(runtime).toMatchObject({
      supported: true,
      platformId: "linux",
      desktop: {
        isMac: false,
        supportsDock: false,
        keepProcessAliveWhenLastWindowCloses: false,
        window: {
          isMac: false,
          supportsDock: false,
          windowChrome: "custom"
        }
      },
      opener: {
        platform: "linux",
        useMacTextEditorFirst: false
      },
      shell: {
        platform: "linux",
        enablePosixShellIntegration: false
      },
      updater: {
        enabled: true
      },
      rendererDescriptor: {
        windowChrome: "custom",
        shortcutStyle: "text",
        keyboard: {
          platform: "linux"
        },
        desktop: {
          supportsDock: false,
          supportsTray: true,
          keepProcessAliveWhenLastWindowCloses: false
        },
        debugging: {
          surfaceDiagnosticCaptureDefaultEnabled: false
        }
      }
    });
  });

  it("enables diagnostic capture by default only for unpackaged desktop runtimes", () => {
    expect(
      requirePlatformRuntime({
        platform: "darwin",
        isPackaged: false,
        env: {}
      }).rendererDescriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled
    ).toBe(true);
    expect(
      requirePlatformRuntime({
        platform: "linux",
        isPackaged: false,
        env: {}
      }).rendererDescriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled
    ).toBe(true);
    expect(
      requirePlatformRuntime({
        platform: "darwin",
        isPackaged: true,
        env: {}
      }).rendererDescriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled
    ).toBe(false);
  });

  it("disables packaged macOS updater checks under test", () => {
    const runtime = requirePlatformRuntime({
      platform: "darwin",
      isPackaged: true,
      env: {
        NODE_ENV: "test"
      }
    });

    expect(runtime.updater.enabled).toBe(false);
  });

  it("keeps Linux updater disabled for test, unpackaged, and non-AppImage builds", () => {
    expect(
      requirePlatformRuntime({
        platform: "linux",
        isPackaged: true,
        env: {
          APPIMAGE: "/tmp/kmux-0.3.12-linux-x64.AppImage",
          NODE_ENV: "test"
        }
      }).updater.enabled
    ).toBe(false);
    expect(
      requirePlatformRuntime({
        platform: "linux",
        isPackaged: false,
        env: {}
      }).updater.enabled
    ).toBe(false);
    expect(
      requirePlatformRuntime({
        platform: "linux",
        isPackaged: true,
        env: {}
      }).updater.enabled
    ).toBe(false);
    expect(
      requirePlatformRuntime({
        platform: "linux",
        isPackaged: true,
        env: {
          APPIMAGE: "/tmp/kmux-extracted"
        }
      }).updater.enabled
    ).toBe(false);
  });

  it("reports unsupported platforms with a clear message", () => {
    const runtime = createPlatformRuntime({
      platform: "win32",
      isPackaged: true,
      env: {}
    });

    expect(runtime).toEqual({
      supported: false,
      platform: "win32",
      message:
        "kmux desktop does not support win32. Supported desktop platforms: macOS and Linux."
    });
    expect(() =>
      requirePlatformRuntime({
        platform: "win32",
        isPackaged: true,
        env: {}
      })
    ).toThrow(UnsupportedPlatformError);
  });
});
