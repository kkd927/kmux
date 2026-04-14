import { Menu, type MenuItemConstructorOptions } from "electron";

import type { AppAction } from "@kmux/core";
import type { Id, ShellViewModel } from "@kmux/proto";

import {
  buildWorkspaceContextMenuEntries,
  findWorkspaceContext,
  runWorkspaceContextAction
} from "../shared/workspaceContextMenu";

function toElectronAccelerator(shortcut?: string): string | undefined {
  if (!shortcut) {
    return undefined;
  }

  return shortcut
    .split("+")
    .map((part) => {
      switch (part) {
        case "Meta":
          return "Command";
        case "Ctrl":
          return "Control";
        case "Alt":
          return "Alt";
        case "Shift":
          return "Shift";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join("+");
}

export function buildNativeWorkspaceContextMenu(params: {
  workspaceId: Id;
  getView(): ShellViewModel;
  rename(workspaceId: Id): void;
  dispatch(action: AppAction): void;
}): Menu | null {
  const initialContext = findWorkspaceContext(params.getView(), params.workspaceId);
  if (!initialContext) {
    return null;
  }

  const menuTemplate: MenuItemConstructorOptions[] =
    buildWorkspaceContextMenuEntries(initialContext).map((item) =>
      item.kind === "separator"
        ? { type: "separator" }
        : {
            label: item.label,
            type: typeof item.checked === "boolean" ? "checkbox" : "normal",
            checked: item.checked,
            enabled: !item.disabled,
            accelerator: toElectronAccelerator(item.shortcut),
            click: () => {
              void runWorkspaceContextAction(
                params.workspaceId,
                item.action,
                () => findWorkspaceContext(params.getView(), params.workspaceId),
                {
                  rename: params.rename,
                  dispatch: params.dispatch
                }
              );
            }
          }
    );

  return Menu.buildFromTemplate(menuTemplate);
}
