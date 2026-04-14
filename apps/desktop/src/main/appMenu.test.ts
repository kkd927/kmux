import type { MenuItemConstructorOptions } from "electron";

import { describe, expect, it, vi } from "vitest";

import { buildApplicationMenuTemplate, getUpdaterMenuLabel } from "./appMenu";
import type { UpdaterState } from "./updater";

function buildTemplate(
  updaterState: UpdaterState
): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "kmux",
    isMac: true,
    isDevelopment: false,
    updaterState,
    actions: {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    }
  });
}

function getAppSubmenu(
  template: MenuItemConstructorOptions[]
): MenuItemConstructorOptions[] {
  return template[0].submenu as MenuItemConstructorOptions[];
}

describe("application menu", () => {
  it("inserts the updater item directly after About and disables it while checking", () => {
    const template = buildTemplate({ status: "checking" });
    const appSubmenu = getAppSubmenu(template);
    const updaterItem = appSubmenu[2];

    expect(appSubmenu[0]).toMatchObject({ role: "about" });
    expect(updaterItem).toMatchObject({
      label: "Checking for Updates…",
      enabled: false
    });
  });

  it("routes available updates to the download action", () => {
    const actions = {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    };
    const template = buildApplicationMenuTemplate({
      appName: "kmux",
      isMac: true,
      isDevelopment: false,
      updaterState: { status: "available", version: "0.1.12" },
      actions
    });
    const updaterItem = getAppSubmenu(template)[2];

    expect(updaterItem).toMatchObject({
      label: "Download Update 0.1.12…",
      enabled: true
    });

    updaterItem.click?.({} as never, undefined, {} as never);

    expect(actions.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(actions.checkForUpdates).not.toHaveBeenCalled();
  });

  it("routes downloaded updates to relaunch installation", () => {
    const actions = {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    };
    const template = buildApplicationMenuTemplate({
      appName: "kmux",
      isMac: true,
      isDevelopment: false,
      updaterState: { status: "downloaded", version: "0.1.12" },
      actions
    });
    const updaterItem = getAppSubmenu(template)[2];

    expect(updaterItem).toMatchObject({
      label: "Install Update 0.1.12 and Relaunch…",
      enabled: true
    });

    updaterItem.click?.({} as never, undefined, {} as never);

    expect(actions.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("uses the default label for idle and error states", () => {
    expect(getUpdaterMenuLabel({ status: "idle" })).toBe("Check for Updates…");
    expect(getUpdaterMenuLabel({ status: "error", errorMessage: "boom" })).toBe(
      "Check for Updates…"
    );
  });
});
