import type { RendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import { createDarwinPlatformRuntime } from "./darwin";
import { createLinuxPlatformRuntime } from "./linux";

export type SupportedDesktopPlatform = "darwin" | "linux";

export interface MainWindowPlatformPolicy {
  isMac: boolean;
  supportsDock: boolean;
  windowChrome: RendererPlatformDescriptor["windowChrome"];
}

export interface PlatformRuntime {
  supported: true;
  platformId: SupportedDesktopPlatform;
  rendererDescriptor: RendererPlatformDescriptor;
  desktop: {
    isMac: boolean;
    supportsDock: boolean;
    keepProcessAliveWhenLastWindowCloses: boolean;
    window: MainWindowPlatformPolicy;
  };
  opener: {
    platform: NodeJS.Platform;
    useMacTextEditorFirst: boolean;
  };
  shell: {
    platform: SupportedDesktopPlatform;
    enablePosixShellIntegration: boolean;
  };
  updater: {
    enabled: boolean;
  };
}

export interface UnsupportedPlatformRuntime {
  supported: false;
  platform: NodeJS.Platform;
  message: string;
}

export type PlatformRuntimeResolution =
  | PlatformRuntime
  | UnsupportedPlatformRuntime;

export class UnsupportedPlatformError extends Error {
  constructor(readonly runtime: UnsupportedPlatformRuntime) {
    super(runtime.message);
    this.name = "UnsupportedPlatformError";
  }
}

export function createPlatformRuntime(options: {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): PlatformRuntimeResolution {
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case "darwin":
      return createDarwinPlatformRuntime(options);
    case "linux":
      return createLinuxPlatformRuntime(options);
    default:
      return {
        supported: false,
        platform,
        message: `kmux desktop does not support ${platform}. Supported desktop platforms: macOS and Linux.`
      };
  }
}

export function requirePlatformRuntime(options: {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): PlatformRuntime {
  const runtime = createPlatformRuntime(options);
  if (!runtime.supported) {
    throw new UnsupportedPlatformError(runtime);
  }
  return runtime;
}
