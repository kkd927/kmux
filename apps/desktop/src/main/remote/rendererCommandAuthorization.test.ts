import { applyAction, createInitialState, type AppState } from "@kmux/core";

import {
  authorizeRendererAppAction,
  routeRendererAppAction
} from "./rendererCommandAuthorization";

describe("renderer command authorization", () => {
  it("allows existing local reducer actions", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;

    expect(
      authorizeRendererAppAction(
        { type: "workspace.rename", workspaceId, name: "local" },
        state
      )
    ).toEqual({ type: "workspace.rename", workspaceId, name: "local" });
  });

  it("rejects Main-only facts and unknown generic-dispatch messages", () => {
    const state = createInitialState("/bin/zsh");
    expect(() =>
      authorizeRendererAppAction(
        { type: "remote-operation.succeeded", operationId: "forged" },
        state
      )
    ).toThrow(/not allowlisted/);
    expect(() =>
      authorizeRendererAppAction(
        { type: "state.restore", snapshot: state },
        state
      )
    ).toThrow(/not allowlisted/);
  });

  it("rejects structurally valid lifecycle actions when their target is SSH", () => {
    const { state, workspaceId, paneId, surfaceId } = createRemoteState();

    for (const action of [
      { type: "pane.split", paneId, direction: "right" },
      { type: "surface.create", paneId },
      { type: "surface.restartSession", surfaceId },
      { type: "surface.close", surfaceId },
      { type: "workspace.close", workspaceId }
    ]) {
      expect(() => authorizeRendererAppAction(action, state)).toThrow(
        /durable remote operation coordinator/
      );
    }
    expect(() =>
      authorizeRendererAppAction(
        {
          type: "workspace.create",
          target: { kind: "ssh", targetId: "target_1" },
          cwd: "/srv/app"
        },
        state
      )
    ).toThrow(/durable remote operation coordinator/);
  });

  it("routes supported SSH surface lifecycle intents to Main-owned execution", () => {
    const { state, workspaceId, paneId, surfaceId } = createRemoteState();

    expect(
      routeRendererAppAction(
        { type: "pane.split", paneId, direction: "right" },
        state
      )
    ).toEqual({
      kind: "remote-lifecycle",
      action: { type: "pane.split", paneId, direction: "right" }
    });
    expect(
      routeRendererAppAction({ type: "surface.close", surfaceId }, state)
    ).toEqual({
      kind: "remote-lifecycle",
      action: { type: "surface.close", surfaceId }
    });
    expect(() =>
      routeRendererAppAction({ type: "workspace.close", workspaceId }, state)
    ).toThrow(/dedicated Main-owned workflow/u);
    expect(
      routeRendererAppAction(
        {
          type: "surface.moveToSplit",
          surfaceId,
          targetPaneId: paneId,
          direction: "right"
        },
        state
      ).kind
    ).toBe("local");
  });
});

function createRemoteState(): {
  state: AppState;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
} {
  const state = createInitialState("/bin/zsh");
  const priorIds = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !priorIds.has(id)
  )!;
  const paneId = state.workspaces[workspaceId].activePaneId;
  return {
    state,
    workspaceId,
    paneId,
    surfaceId: state.panes[paneId].activeSurfaceId
  };
}
