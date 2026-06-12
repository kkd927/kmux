import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true)
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    dock: {
      setIcon: vi.fn()
    }
  },
  BrowserWindow: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true
    }))
  },
  shell: {
    openExternal: vi.fn()
  }
}));

import { existsSync } from "node:fs";
import { app, nativeImage } from "electron";

import {
  buildMainWindowBrowserOptions,
  setDevelopmentDockIcon
} from "./windowLifecycle";

describe("window lifecycle platform options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(nativeImage.createFromPath).mockReturnValue({
      isEmpty: () => true
    } as ReturnType<typeof nativeImage.createFromPath>);
    (app as typeof app & { isPackaged: boolean }).isPackaged = false;
  });

  it("sets the development Dock icon only when the platform supports Dock", () => {
    const icon = {
      isEmpty: () => false
    } as ReturnType<typeof nativeImage.createFromPath>;
    vi.mocked(nativeImage.createFromPath).mockReturnValueOnce(icon);

    setDevelopmentDockIcon("/Users/test/kmux/apps/desktop/out/main", {
      supportsDock: true
    });

    expect(nativeImage.createFromPath).toHaveBeenCalled();
    expect(app.dock?.setIcon).toHaveBeenCalledWith(icon);
  });

  it("does not probe development Dock icons for platforms without Dock support", () => {
    setDevelopmentDockIcon("/home/test/kmux/apps/desktop/out/main", {
      supportsDock: false
    });

    expect(nativeImage.createFromPath).not.toHaveBeenCalled();
    expect(app.dock?.setIcon).not.toHaveBeenCalled();
  });

  it("keeps macOS hidden inset chrome behavior", () => {
    const options = buildMainWindowBrowserOptions({
      currentDir: "/Users/test/kmux/apps/desktop/out/main",
      savedWindowState: {
        width: 1440,
        height: 960,
        x: 20,
        y: 30,
        maximized: false
      },
      platform: {
        isMac: true,
        supportsDock: true,
        windowChrome: "native"
      },
      env: {}
    });

    expect(options).toMatchObject({
      width: 1440,
      height: 960,
      x: 20,
      y: 30,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 11,
        y: 10
      }
    });
  });

  it("uses a native BrowserWindow frame for Linux native chrome", () => {
    const options = buildMainWindowBrowserOptions({
      currentDir: "/home/test/kmux/apps/desktop/out/main",
      savedWindowState: null,
      platform: {
        isMac: false,
        supportsDock: false,
        windowChrome: "native"
      },
      env: {}
    });

    expect(options.frame).toBe(true);
    expect(options.titleBarStyle).toBeUndefined();
    expect(options.trafficLightPosition).toBeUndefined();
  });

  it("preserves custom frameless options for non-mac custom chrome", () => {
    const options = buildMainWindowBrowserOptions({
      currentDir: "/home/test/kmux/apps/desktop/out/main",
      savedWindowState: null,
      platform: {
        isMac: false,
        supportsDock: false,
        windowChrome: "custom"
      },
      env: {}
    });

    expect(options.frame).toBe(false);
    expect(options.titleBarStyle).toBe("hidden");
  });
});
