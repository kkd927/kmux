import { describe, expect, it, vi } from "vitest";

import { Menu, type MenuItemConstructorOptions } from "electron";

import { buildDefaultShortcuts, LINUX_DEFAULT_SHORTCUTS } from "@kmux/ui";

import { buildPlatformKeyboardPolicy } from "../shared/platform/keyboardPolicy";
import type { WorkspaceContextView } from "../shared/workspaceContextMenu";

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: vi.fn()
  }
}));

import {
  buildNativeSurfaceContextMenu,
  buildNativeWorkspaceContextMenu,
  toElectronAccelerator
} from "./workspaceContextMenu";

describe("native workspace context menu", () => {
  it("converts Linux policy shortcuts to Electron accelerators", () => {
    expect(
      toElectronAccelerator(LINUX_DEFAULT_SHORTCUTS["workspace.rename"])
    ).toBe("Control+Shift+R");
    expect(
      toElectronAccelerator(LINUX_DEFAULT_SHORTCUTS["workspace.close"])
    ).toBe("Control+Alt+W");
  });

  it("does not register Electron accelerators for reserved Linux system chords", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });

    expect(
      toElectronAccelerator("Ctrl+Alt+T", {
        reservedSystemChords: policy.reservedSystemChords
      })
    ).toBeUndefined();
    expect(
      toElectronAccelerator("Alt+F4", {
        reservedSystemChords: policy.reservedSystemChords
      })
    ).toBeUndefined();
    expect(
      toElectronAccelerator(LINUX_DEFAULT_SHORTCUTS["workspace.close"], {
        reservedSystemChords: policy.reservedSystemChords
      })
    ).toBe("Control+Alt+W");
  });

  it("omits reserved accelerators from the native workspace context menu template", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const view: WorkspaceContextView = {
      workspaceRows: [
        createWorkspaceRow("workspace_1", true),
        createWorkspaceRow("workspace_2", false)
      ],
      settings: {
        shortcuts: {
          "workspace.rename": "Ctrl+Alt+T",
          "workspace.close": "Alt+F4"
        }
      }
    };
    const buildFromTemplate = vi.mocked(Menu.buildFromTemplate);
    buildFromTemplate.mockClear();

    buildNativeWorkspaceContextMenu({
      workspaceId: "workspace_1",
      getContextView: () => view,
      reservedSystemChords: policy.reservedSystemChords,
      convertToWorktree: vi.fn(),
      closeWorkspace: vi.fn(),
      closeOtherWorkspaces: vi.fn(),
      rename: vi.fn(),
      dispatch: vi.fn()
    });

    const template = buildFromTemplate.mock
      .calls[0]?.[0] as MenuItemConstructorOptions[];

    expect(
      template.find((item) => item.label === "Rename Workspace…")
    ).toMatchObject({ accelerator: undefined });
    expect(
      template.find((item) => item.label === "Close Workspace")
    ).toMatchObject({ accelerator: undefined });
  });

  it("builds native surface menu items and routes actions back to the renderer", () => {
    const buildFromTemplate = vi.mocked(Menu.buildFromTemplate);
    const popup = vi.fn();
    buildFromTemplate.mockClear();
    buildFromTemplate.mockReturnValue({ popup } as unknown as Menu);
    const onAction = vi.fn();

    buildNativeSurfaceContextMenu({
      surfaceId: "surface_1",
      context: {
        canCopy: true,
        canPaste: true,
        canRestart: true,
        sessionState: "running",
        settings: {
          shortcuts: buildDefaultShortcuts("darwin")
        }
      },
      onAction
    });

    const template = buildFromTemplate.mock
      .calls[0]?.[0] as MenuItemConstructorOptions[];
    const splitHorizontally = template.find(
      (item) => item.label === "Split Horizontally"
    );

    expect(splitHorizontally).toMatchObject({
      accelerator: "Command+Shift+D"
    });
    splitHorizontally?.click?.({} as never, {} as never, {} as never);

    expect(onAction).toHaveBeenCalledWith("surface_1", "split-horizontally");
  });
});

function createWorkspaceRow(workspaceId: string, isActive: boolean) {
  return {
    workspaceId,
    name: workspaceId,
    nameLocked: false,
    summary: "",
    ports: [],
    statusEntries: [],
    unreadCount: 0,
    attention: false,
    pinned: false,
    isActive
  };
}
