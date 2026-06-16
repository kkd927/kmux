import { createRendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import type { PlatformRuntime } from "./runtime";
import {
  hasAppImageRuntimeEnv,
  isPackagedDesktopUpdaterEligible
} from "./posix";

export function createLinuxPlatformRuntime(options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): PlatformRuntime {
  const rendererDescriptor = createRendererPlatformDescriptor({
    windowChrome: "custom",
    shortcutStyle: "text",
    keyboardPlatform: "linux",
    supportsDock: false,
    supportsTray: true,
    keepProcessAliveWhenLastWindowCloses: false
  });
  return {
    supported: true,
    platformId: "linux",
    rendererDescriptor,
    desktop: {
      isMac: false,
      supportsDock: false,
      keepProcessAliveWhenLastWindowCloses: false,
      window: {
        isMac: false,
        supportsDock: false,
        windowChrome: rendererDescriptor.windowChrome
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
      enabled:
        isPackagedDesktopUpdaterEligible(options) &&
        hasAppImageRuntimeEnv(options.env)
    }
  };
}
