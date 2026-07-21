import { MessageChannelMain } from "electron";
import type { AppState } from "@kmux/core";
import { createInitialState, workspaceLocation } from "@kmux/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalDataPlaneController } from "./terminalDataPlane";
import type { PtyHostManager } from "./ptyHost";

vi.mock("electron", () => ({
  MessageChannelMain: vi.fn()
}));

function visibleState(): AppState {
  return createInitialState("/bin/zsh");
}

function activeSurface(state: AppState) {
  const window = state.windows[state.activeWindowId];
  const workspace = state.workspaces[window.activeWorkspaceId];
  const pane = state.panes[workspace.activePaneId];
  return state.surfaces[pane.activeSurfaceId];
}

function rendererEvent() {
  const postMessage = vi.fn();
  const frame = {
    detached: false,
    isDestroyed: vi.fn(() => false),
    postMessage
  };
  return {
    event: {
      sender: { mainFrame: frame },
      senderFrame: frame
    } as never,
    frame,
    postMessage
  };
}

function streamHost(state: AppState): PtyHostManager {
  const surface = activeSurface(state);
  return {
    sessionRef: vi.fn(() => ({
      surfaceId: surface.id,
      sessionId: surface.content.sessionId,
      epoch: "epoch_1"
    })),
    bindTerminalStream: vi.fn(() => true)
  } as unknown as PtyHostManager;
}

function mockChannel() {
  const port1 = { close: vi.fn() };
  const port2 = { close: vi.fn() };
  vi.mocked(MessageChannelMain).mockImplementation(
    () => ({ port1, port2 }) as never
  );
  return { port1, port2 };
}

describe("terminal data-plane controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not bind an SSH surface to the local PTY host", () => {
    const state = visibleState();
    const workspace =
      state.workspaces[state.windows[state.activeWindowId].activeWorkspaceId];
    workspace.location = workspaceLocation(
      { kind: "ssh", targetId: "target_1" },
      "/srv/app"
    );
    const surface = activeSurface(state);
    const host = streamHost(state);
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    expect(
      controller.attach(
        rendererEvent().event,
        surface.id,
        surface.content.sessionId
      )
    ).toEqual({
      status: "retryable-not-ready",
      reason: "runtime-not-ready"
    });
    expect(host.sessionRef).not.toHaveBeenCalled();
  });

  it("transfers one attach-scoped port to the utility host and invoking main frame", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const { port1, port2 } = mockChannel();
    const host = streamHost(state);
    const renderer = rendererEvent();
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    const result = controller.attach(
      renderer.event,
      surface.id,
      surface.content.sessionId
    );
    expect(result.status).toBe("granted");
    const grant = result.status === "granted" ? result.grant : null;

    expect(grant).toMatchObject({
      attachId: expect.stringMatching(/^attach_/),
      session: {
        surfaceId: surface.id,
        sessionId: surface.content.sessionId,
        epoch: "epoch_1"
      }
    });
    expect(host.bindTerminalStream).toHaveBeenCalledWith(
      grant?.attachId,
      grant?.session,
      port1
    );
    expect(renderer.postMessage).toHaveBeenCalledWith(
      "kmux:terminal-port",
      grant,
      [port2]
    );
  });

  it("grants a distinct capability and channel for every attach", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const firstPort = { close: vi.fn() };
    const secondPort = { close: vi.fn() };
    vi.mocked(MessageChannelMain)
      .mockImplementationOnce(
        () => ({ port1: firstPort, port2: { close: vi.fn() } }) as never
      )
      .mockImplementationOnce(
        () => ({ port1: secondPort, port2: { close: vi.fn() } }) as never
      );
    const host = streamHost(state);
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    const first = controller.attach(
      rendererEvent().event,
      surface.id,
      surface.content.sessionId
    );
    const second = controller.attach(
      rendererEvent().event,
      surface.id,
      surface.content.sessionId
    );

    expect(first.status).toBe("granted");
    expect(second.status).toBe("granted");
    const firstGrant = first.status === "granted" ? first.grant : null;
    const secondGrant = second.status === "granted" ? second.grant : null;
    expect(firstGrant?.attachId).not.toBe(secondGrant?.attachId);
    expect(host.bindTerminalStream).toHaveBeenNthCalledWith(
      1,
      firstGrant?.attachId,
      firstGrant?.session,
      firstPort
    );
    expect(host.bindTerminalStream).toHaveBeenNthCalledWith(
      2,
      secondGrant?.attachId,
      secondGrant?.session,
      secondPort
    );
  });

  it("rejects inactive workspaces and hidden tabs before allocating a channel", () => {
    const inactiveState = visibleState();
    const inactiveSurface = activeSurface(inactiveState);
    inactiveState.windows[inactiveState.activeWindowId].activeWorkspaceId =
      "workspace_other";
    const inactiveController = createTerminalDataPlaneController({
      getState: () => inactiveState,
      getPtyHost: () => streamHost(inactiveState)
    });

    expect(
      inactiveController.attach(
        rendererEvent().event,
        inactiveSurface.id,
        inactiveSurface.content.sessionId
      )
    ).toEqual({ status: "denied", reason: "not-current-surface" });

    const hiddenState = visibleState();
    const visible = activeSurface(hiddenState);
    const pane = hiddenState.panes[visible.paneId];
    const hiddenSurfaceId = "surface_hidden";
    const hiddenSessionId = "session_hidden";
    hiddenState.surfaces[hiddenSurfaceId] = {
      ...visible,
      id: hiddenSurfaceId,
      content: { kind: "terminal", sessionId: hiddenSessionId }
    };
    hiddenState.sessions[hiddenSessionId] = {
      ...hiddenState.sessions[visible.content.sessionId],
      id: hiddenSessionId,
      surfaceId: hiddenSurfaceId
    };
    pane.surfaceIds.push(hiddenSurfaceId);
    const hiddenController = createTerminalDataPlaneController({
      getState: () => hiddenState,
      getPtyHost: () => streamHost(hiddenState)
    });

    expect(
      hiddenController.attach(
        rendererEvent().event,
        hiddenSurfaceId,
        hiddenSessionId
      )
    ).toEqual({ status: "denied", reason: "not-current-surface" });
    expect(MessageChannelMain).not.toHaveBeenCalled();
  });

  it("rejects stale sessions but lets an exited surface recover its final checkpoint", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const host = streamHost(state);
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    expect(
      controller.attach(rendererEvent().event, surface.id, "session_stale")
    ).toEqual({ status: "denied", reason: "not-current-surface" });
    expect(host.sessionRef).not.toHaveBeenCalled();

    state.sessions[surface.content.sessionId].runtimeStatus.processState =
      "exited";
    mockChannel();
    expect(
      controller.attach(
        rendererEvent().event,
        surface.id,
        surface.content.sessionId
      )
    ).toMatchObject({
      status: "granted",
      grant: {
        session: {
          surfaceId: surface.id,
          sessionId: surface.content.sessionId,
          epoch: "epoch_1"
        }
      }
    });
    expect(host.sessionRef).toHaveBeenCalledWith(
      surface.id,
      surface.content.sessionId
    );
  });

  it("rejects subframes, destroyed frames, and missing current runtime epochs", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const host = streamHost(state);
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });
    const subframe = rendererEvent();
    (subframe.event as { sender: { mainFrame: unknown } }).sender.mainFrame =
      {};

    expect(
      controller.attach(subframe.event, surface.id, surface.content.sessionId)
    ).toEqual({ status: "denied", reason: "invalid-frame" });

    const destroyed = rendererEvent();
    destroyed.frame.isDestroyed.mockReturnValue(true);
    expect(
      controller.attach(destroyed.event, surface.id, surface.content.sessionId)
    ).toEqual({ status: "denied", reason: "invalid-frame" });

    vi.mocked(host.sessionRef).mockReturnValue(null);
    expect(
      controller.attach(
        rendererEvent().event,
        surface.id,
        surface.content.sessionId
      )
    ).toEqual({
      status: "retryable-not-ready",
      reason: "runtime-not-ready"
    });
    expect(MessageChannelMain).not.toHaveBeenCalled();
  });

  it("closes both ports when the utility host rejects the epoch race", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const host = streamHost(state);
    vi.mocked(host.bindTerminalStream).mockReturnValue(false);
    const { port1, port2 } = mockChannel();
    const renderer = rendererEvent();
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    expect(
      controller.attach(renderer.event, surface.id, surface.content.sessionId)
    ).toEqual({
      status: "retryable-not-ready",
      reason: "runtime-bind-race"
    });
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
    expect(renderer.postMessage).not.toHaveBeenCalled();
  });

  it("returns no capability when a channel cannot be allocated", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const host = streamHost(state);
    vi.mocked(MessageChannelMain).mockImplementation(() => {
      throw new Error("app is shutting down");
    });
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    expect(
      controller.attach(
        rendererEvent().event,
        surface.id,
        surface.content.sessionId
      )
    ).toEqual({
      status: "retryable-not-ready",
      reason: "channel-unavailable"
    });
    expect(host.bindTerminalStream).not.toHaveBeenCalled();
  });

  it("closes the renderer endpoint when frame transfer fails", () => {
    const state = visibleState();
    const surface = activeSurface(state);
    const host = streamHost(state);
    const { port2 } = mockChannel();
    const renderer = rendererEvent();
    renderer.postMessage.mockImplementation(() => {
      throw new Error("frame navigated");
    });
    const controller = createTerminalDataPlaneController({
      getState: () => state,
      getPtyHost: () => host
    });

    expect(
      controller.attach(renderer.event, surface.id, surface.content.sessionId)
    ).toEqual({ status: "denied", reason: "renderer-transfer-failed" });
    expect(port2.close).toHaveBeenCalledOnce();
  });
});
