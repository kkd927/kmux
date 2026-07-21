import { MessageChannelMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import {
  terminalSessionForSurface,
  type AppState,
  type RemoteResourceKey
} from "@kmux/core";
import type { Id } from "@kmux/proto";
import { makeId } from "@kmux/proto";

import type { PtyHostManager } from "./ptyHost";
import type { RemoteHostManager } from "./remoteHost";
import {
  KMUX_TERMINAL_PORT_CHANNEL,
  type TerminalStreamAttachResult,
  type TerminalStreamGrant
} from "../shared/terminalPort";

export interface TerminalDataPlaneControllerOptions {
  getState: () => AppState;
  getPtyHost: () => PtyHostManager | null;
  getRemoteTerminal?: (
    surfaceId: Id,
    sessionId: Id
  ) => {
    host: RemoteHostManager;
    resourceKey: RemoteResourceKey & { sessionId: Id };
    keeperGeneration: Id;
  } | null;
}

export interface TerminalDataPlaneController {
  attach(
    event: IpcMainInvokeEvent,
    surfaceId: Id,
    expectedSessionId: Id
  ): TerminalStreamAttachResult;
}

export function createTerminalDataPlaneController(
  options: TerminalDataPlaneControllerOptions
): TerminalDataPlaneController {
  return {
    attach(event, surfaceId, expectedSessionId) {
      const state = options.getState();
      const surface = state.surfaces[surfaceId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
      const productSession = state.sessions[expectedSessionId];
      const activeWindow = state.windows[state.activeWindowId];
      if (
        !surface ||
        !pane ||
        !workspace ||
        !productSession ||
        terminalSessionForSurface(state, surfaceId)?.id !== expectedSessionId ||
        productSession.surfaceId !== surfaceId ||
        pane.activeSurfaceId !== surfaceId ||
        activeWindow?.activeWorkspaceId !== workspace.id ||
        workspace.windowId !== activeWindow.id ||
        !Object.values(workspace.nodeMap).some(
          (node) => node.kind === "leaf" && node.paneId === pane.id
        )
      ) {
        return { status: "denied", reason: "not-current-surface" };
      }
      const targetFrame = event.senderFrame;
      if (
        !targetFrame ||
        targetFrame !== event.sender.mainFrame ||
        targetFrame.detached ||
        targetFrame.isDestroyed()
      ) {
        return { status: "denied", reason: "invalid-frame" };
      }

      const remote =
        workspace.location.target.kind === "ssh"
          ? options.getRemoteTerminal?.(surfaceId, expectedSessionId)
          : null;
      const localHost =
        workspace.location.target.kind === "local"
          ? options.getPtyHost()
          : null;
      const session = remote
        ? {
            surfaceId,
            sessionId: expectedSessionId,
            epoch: remote.keeperGeneration
          }
        : localHost?.sessionRef(surfaceId, expectedSessionId);
      if (
        !session ||
        (workspace.location.target.kind === "ssh" &&
          (!remote ||
            remote.resourceKey.targetId !==
              workspace.location.target.targetId ||
            remote.resourceKey.workspaceId !== workspace.id ||
            remote.resourceKey.sessionId !== expectedSessionId))
      ) {
        return { status: "retryable-not-ready", reason: "runtime-not-ready" };
      }

      const attachId = makeId("attach");
      const grant: TerminalStreamGrant = { attachId, session };
      const channel = (() => {
        try {
          return new MessageChannelMain();
        } catch {
          return null;
        }
      })();
      if (!channel) {
        return {
          status: "retryable-not-ready",
          reason: "channel-unavailable"
        };
      }
      const { port1, port2 } = channel;
      const bound = remote
        ? remote.host.bindTerminalStream(
            {
              targetId: remote.resourceKey.targetId,
              attachId,
              session,
              resourceKey: remote.resourceKey,
              expectedKeeperGeneration: remote.keeperGeneration
            },
            port1
          )
        : localHost?.bindTerminalStream(attachId, session, port1) === true;
      if (!bound) {
        port1.close();
        port2.close();
        return {
          status: "retryable-not-ready",
          reason: "runtime-bind-race"
        };
      }
      try {
        targetFrame.postMessage(KMUX_TERMINAL_PORT_CHANNEL, grant, [port2]);
      } catch {
        port2.close();
        return { status: "denied", reason: "renderer-transfer-failed" };
      }
      return { status: "granted", grant };
    }
  };
}
