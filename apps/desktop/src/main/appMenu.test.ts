import type { MenuItemConstructorOptions } from "electron";

import { describe, expect, it, vi } from "vitest";

import { buildApplicationMenuTemplate, getUpdaterMenuLabel } from "./appMenu";
import type { UpdaterState } from "./updater";

function buildTemplate(
  updaterState: UpdaterState,
  options: { isMac?: boolean } = {}
): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "kmux",
    isMac: options.isMac ?? true,
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

function getFileSubmenu(
  template: MenuItemConstructorOptions[],
  isMac = true
): MenuItemConstructorOptions[] {
  return template[isMac ? 1 : 0].submenu as MenuItemConstructorOptions[];
}

describe("application menu", () => {
  it("inserts the updater item directly after About and disables it while checking", () => {
    const template = buildTemplate({ status: "checking" });
    const appSubmenu = getAppSubmenu(template);
    const fileSubmenu = getFileSubmenu(template);
    const updaterItem = appSubmenu[2];

    expect(appSubmenu[0]).toMatchObject({ role: "about" });
    expect(updaterItem).toMatchObject({
      label: "Checking for Updates…",
      enabled: false
    });
    expect(fileSubmenu).toEqual([{ role: "close" }]);
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

  it("exposes update actions in the File menu on Linux and other non-macOS desktops", () => {
    const actions = {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    };
    const template = buildApplicationMenuTemplate({
      appName: "kmux",
      isMac: false,
      isDevelopment: false,
      updaterState: { status: "idle" },
      actions
    });
    const fileSubmenu = getFileSubmenu(template, false);
    const updaterItem = fileSubmenu[0];

    expect(template[0]).toMatchObject({ label: "File" });
    expect(updaterItem).toMatchObject({
      label: "Check for Updates…",
      enabled: true
    });
    expect(fileSubmenu[1]).toMatchObject({ type: "separator" });
    expect(fileSubmenu[2]).toMatchObject({ role: "quit" });

    updaterItem.click?.({} as never, undefined, {} as never);

    expect(actions.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(actions.downloadUpdate).not.toHaveBeenCalled();
    expect(actions.quitAndInstall).not.toHaveBeenCalled();
  });

  it("routes Linux File menu update states to download and install actions", () => {
    const availableActions = {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    };
    const availableTemplate = buildApplicationMenuTemplate({
      appName: "kmux",
      isMac: false,
      isDevelopment: false,
      updaterState: { status: "available", version: "0.1.12" },
      actions: availableActions
    });

    getFileSubmenu(availableTemplate, false)[0].click?.(
      {} as never,
      undefined,
      {} as never
    );

    expect(availableActions.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(availableActions.checkForUpdates).not.toHaveBeenCalled();

    const downloadedActions = {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(() => undefined)
    };
    const downloadedTemplate = buildApplicationMenuTemplate({
      appName: "kmux",
      isMac: false,
      isDevelopment: false,
      updaterState: { status: "downloaded", version: "0.1.12" },
      actions: downloadedActions
    });

    getFileSubmenu(downloadedTemplate, false)[0].click?.(
      {} as never,
      undefined,
      {} as never
    );

    expect(downloadedActions.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(downloadedActions.downloadUpdate).not.toHaveBeenCalled();
  });

  it("disables the Linux File menu updater item while busy or unavailable", () => {
    const checkingItem = getFileSubmenu(
      buildTemplate({ status: "checking" }, { isMac: false }),
      false
    )[0];
    const disabledItem = getFileSubmenu(
      buildTemplate({ status: "disabled" }, { isMac: false }),
      false
    )[0];

    expect(checkingItem).toMatchObject({
      label: "Checking for Updates…",
      enabled: false
    });
    expect(disabledItem).toMatchObject({
      label: "Check for Updates…",
      enabled: false
    });
  });

  it("uses the default label for idle and error states", () => {
    expect(getUpdaterMenuLabel({ status: "idle" })).toBe("Check for Updates…");
    expect(getUpdaterMenuLabel({ status: "error", errorMessage: "boom" })).toBe(
      "Check for Updates…"
    );
  });
});
