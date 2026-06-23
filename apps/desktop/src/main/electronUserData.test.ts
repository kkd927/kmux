import { describe, expect, it, vi } from "vitest";

import {
  configureElectronUserDataDir,
  resolveElectronUserDataDir
} from "./electronUserData";

describe("Electron user data override", () => {
  it("treats blank overrides as absent", () => {
    expect(resolveElectronUserDataDir({})).toBeNull();
    expect(
      resolveElectronUserDataDir({ KMUX_ELECTRON_USER_DATA_DIR: "   " })
    ).toBeNull();
  });

  it("trims and applies an explicit user data directory before app startup", () => {
    const setPath = vi.fn();
    const mkdir = vi.fn();

    const result = configureElectronUserDataDir({
      app: { setPath },
      env: {
        KMUX_ELECTRON_USER_DATA_DIR: " /repo/.kmux/dev/runtime/electron-user-data "
      },
      mkdir
    });

    expect(result).toBe("/repo/.kmux/dev/runtime/electron-user-data");
    expect(mkdir).toHaveBeenCalledWith(
      "/repo/.kmux/dev/runtime/electron-user-data",
      { recursive: true }
    );
    expect(setPath).toHaveBeenCalledWith(
      "userData",
      "/repo/.kmux/dev/runtime/electron-user-data"
    );
  });
});
