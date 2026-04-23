import {
  applyAction,
  buildActiveWorkspaceActivityVm,
  buildActiveWorkspacePaneTreeVm,
  buildNotificationsVm,
  buildShellSettingsVm,
  buildShellWindowChromeVm,
  buildWorkspaceRowsVm,
  createPendingResolvedTerminalTypographyVm,
  createInitialState
} from "@kmux/core";
import { describe, expect, it } from "vitest";
import type { ShellStoreSnapshot } from "@kmux/proto";

import { determineSurfaceCloseStrategy } from "./surfaceCloseStrategy";

function buildShellState(state: ReturnType<typeof createInitialState>): ShellStoreSnapshot {
  return {
    version: 0,
    ...buildShellWindowChromeVm(state),
    workspaceRows: buildWorkspaceRowsVm(state),
    activeWorkspace: buildActiveWorkspaceActivityVm(state),
    activeWorkspacePaneTree: buildActiveWorkspacePaneTreeVm(state),
    notifications: buildNotificationsVm(state),
    settings: buildShellSettingsVm(state),
    terminalTypography: createPendingResolvedTerminalTypographyVm(
      state.settings.terminalTypography
    )
  };
}

describe("surface close strategy", () => {
  it("keeps the existing surface close flow when the workspace still has multiple tabs", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const originalSurfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "surface.create", paneId });

    expect(
      determineSurfaceCloseStrategy(buildShellState(state), originalSurfaceId)
    ).toEqual({ kind: "close-surface" });
  });

  it("asks for workspace close confirmation when the last tab belongs to a non-final workspace", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;

    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.select", workspaceId });

    expect(determineSurfaceCloseStrategy(buildShellState(state), surfaceId)).toEqual(
      {
        kind: "confirm-workspace-close",
        workspaceId,
        isLastWorkspace: false
      }
    );
  });

  it("asks for replacement confirmation when the workspace is the app's last workspace", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;
    const surfaceId = state.panes[paneId].activeSurfaceId;

    expect(determineSurfaceCloseStrategy(buildShellState(state), surfaceId)).toEqual(
      {
        kind: "confirm-workspace-close",
        workspaceId,
        isLastWorkspace: true
      }
    );
  });
});
