import type { MenuItemConstructorOptions } from "electron";

import type { UpdaterState } from "./updater";

interface AppMenuActions {
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
}

interface BuildApplicationMenuTemplateOptions {
  appName: string;
  isMac: boolean;
  isDevelopment: boolean;
  updaterState: UpdaterState;
  actions: AppMenuActions;
}

export function buildApplicationMenuTemplate(
  options: BuildApplicationMenuTemplateOptions
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (options.isMac) {
    template.push({
      label: options.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        buildUpdaterMenuItem(options.updaterState, options.actions),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  template.push(
    {
      label: "File",
      submenu: [options.isMac ? { role: "close" } : { role: "quit" }]
    },
    {
      label: "Edit",
      submenu: buildEditMenu(options.isMac)
    },
    {
      label: "View",
      submenu: buildViewMenu(options.isDevelopment)
    },
    {
      label: "Window",
      submenu: buildWindowMenu(options.isMac)
    }
  );

  return template;
}

export function getUpdaterMenuLabel(state: UpdaterState): string {
  switch (state.status) {
    case "checking":
      return "Checking for Updates…";
    case "available":
      return formatUpdaterLabel("Download Update", state.version);
    case "downloading":
      return formatUpdaterLabel("Downloading Update", state.version);
    case "downloaded":
      return formatUpdaterLabel(
        "Install Update",
        state.version,
        " and Relaunch"
      );
    case "disabled":
    case "error":
    case "idle":
    default:
      return "Check for Updates…";
  }
}

function buildUpdaterMenuItem(
  state: UpdaterState,
  actions: AppMenuActions
): MenuItemConstructorOptions {
  return {
    label: getUpdaterMenuLabel(state),
    enabled: state.status !== "disabled" && !isBusy(state),
    click: () => {
      if (state.status === "available") {
        void actions.downloadUpdate();
        return;
      }
      if (state.status === "downloaded") {
        actions.quitAndInstall();
        return;
      }
      void actions.checkForUpdates();
    }
  };
}

function buildEditMenu(isMac: boolean): MenuItemConstructorOptions[] {
  return [
    roleItem("undo"),
    roleItem("redo"),
    separatorItem(),
    roleItem("cut"),
    roleItem("copy"),
    roleItem("paste"),
    ...(isMac
      ? [
          roleItem("pasteAndMatchStyle"),
          roleItem("delete"),
          roleItem("selectAll"),
          separatorItem(),
          {
            label: "Speech",
            submenu: [roleItem("startSpeaking"), roleItem("stopSpeaking")]
          }
        ]
      : [roleItem("delete"), separatorItem(), roleItem("selectAll")])
  ];
}

function buildViewMenu(isDevelopment: boolean): MenuItemConstructorOptions[] {
  return [
    ...(isDevelopment
      ? [
          roleItem("reload"),
          roleItem("forceReload"),
          roleItem("toggleDevTools"),
          separatorItem()
        ]
      : []),
    roleItem("resetZoom"),
    roleItem("zoomIn"),
    roleItem("zoomOut"),
    separatorItem(),
    roleItem("togglefullscreen")
  ];
}

function buildWindowMenu(isMac: boolean): MenuItemConstructorOptions[] {
  return [
    roleItem("minimize"),
    roleItem("zoom"),
    ...(isMac
      ? [
          separatorItem(),
          roleItem("front"),
          separatorItem(),
          roleItem("window")
        ]
      : [roleItem("close")])
  ];
}

function isBusy(state: UpdaterState): boolean {
  return state.status === "checking" || state.status === "downloading";
}

function formatUpdaterLabel(
  prefix: string,
  version?: string,
  suffix = ""
): string {
  if (version) {
    return `${prefix} ${version}${suffix}…`;
  }
  return `${prefix}${suffix}…`;
}

function roleItem(
  role: NonNullable<MenuItemConstructorOptions["role"]>
): MenuItemConstructorOptions {
  return { role };
}

function separatorItem(): MenuItemConstructorOptions {
  return { type: "separator" };
}
