import {
  applyAction,
  buildActiveWorkspaceActivityVm,
  buildActiveWorkspacePaneTreeVm,
  buildAllWorkspacePaneTreesVm,
  buildNotificationsVm,
  buildShellSettingsVm,
  buildShellWindowChromeVm,
  buildWorkspaceRowsVm,
  createPendingResolvedTerminalTypographyVm,
  createInitialState
} from "@kmux/core";
import { describe, expect, it } from "vitest";
import type { ShellStoreSnapshot } from "@kmux/proto";

import {
  determinePaneCloseStrategy,
  determineSurfaceCloseStrategy
} from "./surfaceCloseStrategy";

function buildShellState(state: ReturnType<typeof createInitialState>): ShellStoreSnapshot {
  return {
    version: 0,
    ...buildShellWindowChromeVm(state),
    workspaceRows: buildWorkspaceRowsVm(state),
    activeWorkspace: buildActiveWorkspaceActivityVm(state),
    activeWorkspacePaneTree: buildActiveWorkspacePaneTreeVm(state),
    workspacePaneTrees: buildAllWorkspacePaneTreesVm(state),
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

  it("asks for workspace close confirmation when closing the app's last pane surface", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;

    expect(determinePaneCloseStrategy(buildShellState(state), paneId)).toEqual({
      kind: "confirm-workspace-close",
      workspaceId,
      isLastWorkspace: true
    });
  });

  it("closes a split pane directly when other workspace panes remain", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, { type: "pane.split", paneId, direction: "right" });

    expect(determinePaneCloseStrategy(buildShellState(state), paneId)).toEqual({
      kind: "close-pane"
    });
  });

  it("closes the active tab before removing a split pane that still has multiple tabs", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, { type: "surface.create", paneId });
    const activeSurfaceId = state.panes[paneId].activeSurfaceId;
    applyAction(state, { type: "pane.split", paneId, direction: "right" });

    expect(determinePaneCloseStrategy(buildShellState(state), paneId)).toEqual({
      kind: "close-surface",
      surfaceId: activeSurfaceId
    });
  });

  it("reuses active tab close behavior when closing an unsplit pane with multiple tabs", () => {
    const state = createInitialState();
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
    const paneId = state.workspaces[workspaceId].activePaneId;

    applyAction(state, { type: "surface.create", paneId });

    expect(determinePaneCloseStrategy(buildShellState(state), paneId)).toEqual({
      kind: "close-surface",
      surfaceId: state.panes[paneId].activeSurfaceId
    });
  });
});
