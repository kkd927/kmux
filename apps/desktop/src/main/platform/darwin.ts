import { createRendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import type { PlatformRuntime } from "./runtime";
import { isPackagedDesktopUpdaterEligible } from "./posix";

export function createDarwinPlatformRuntime(options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): PlatformRuntime {
  const rendererDescriptor = createRendererPlatformDescriptor({
    windowChrome: "native",
    shortcutStyle: "mac-symbols",
    keyboardPlatform: "darwin",
    supportsDock: true,
    keepProcessAliveWhenLastWindowCloses: true,
    surfaceDiagnosticCaptureDefaultEnabled: options.isPackaged === false
  });
  return {
    supported: true,
    platformId: "darwin",
    rendererDescriptor,
    desktop: {
      isMac: true,
      supportsDock: true,
      keepProcessAliveWhenLastWindowCloses: true,
      window: {
        isMac: true,
        supportsDock: true,
        windowChrome: rendererDescriptor.windowChrome
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
      enabled: isPackagedDesktopUpdaterEligible(options)
    }
  };
}
