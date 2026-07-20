import { createHash } from "node:crypto";

import type { RemoteResourceKey } from "@kmux/core";
import {
  REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES,
  makeId,
  type Id,
  type TerminalKeyInput
} from "@kmux/proto";

import type {
  RemoteSurfaceCaptureResult,
  RemoteTerminalInputAcknowledgement
} from "../../remote-host/linuxX64RemoteRuntime";
import { encodeTerminalKeyInput } from "../../pty-host/terminalInput";
import type { RemoteHostManager } from "../remoteHost";

export interface BoundRemoteTerminalControlProvider {
  readonly targetId: Id;
  sendText(request: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
    expectedKeeperGeneration: Id;
    text: string;
    operationId?: Id;
  }): Promise<RemoteTerminalInputAcknowledgement>;
  sendKey(request: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
    expectedKeeperGeneration: Id;
    input: TerminalKeyInput;
    operationId?: Id;
  }): Promise<RemoteTerminalInputAcknowledgement>;
  capture(request: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
    expectedKeeperGeneration: Id;
    captureId?: Id;
    lineLimit?: number;
    maxBytes?: number;
  }): Promise<RemoteSurfaceCaptureResult>;
}

export function createBoundRemoteTerminalControlProvider(options: {
  desktopInstallationId: Id;
  targetId: Id;
  host: RemoteHostManager;
  isConnected: () => boolean;
}): BoundRemoteTerminalControlProvider {
  const requireRoute = (
    resourceKey: RemoteResourceKey & { sessionId: Id }
  ): void => {
    if (
      resourceKey.desktopInstallationId !== options.desktopInstallationId ||
      resourceKey.targetId !== options.targetId
    ) {
      throw new Error("remote terminal route is outside its bound target scope");
    }
    if (!options.isConnected()) {
      throw new Error("remote terminal target is not connected");
    }
  };

  const sendText: BoundRemoteTerminalControlProvider["sendText"] = async (
    request
  ) => {
    requireRoute(request.resourceKey);
    const byteLength = Buffer.byteLength(request.text, "utf8");
    if (byteLength > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES) {
      throw new RangeError("remote terminal input exceeds the 64 KiB limit");
    }
    return options.host.injectTerminal(options.targetId, {
      resourceKey: structuredClone(request.resourceKey),
      expectedKeeperGeneration: request.expectedKeeperGeneration,
      operationId: request.operationId ?? makeId("remote-terminal-input"),
      payloadHash: createHash("sha256")
        .update(request.text, "utf8")
        .digest("hex"),
      input: request.text
    });
  };

  return Object.freeze({
    targetId: options.targetId,
    sendText,
    sendKey(
      request: Parameters<BoundRemoteTerminalControlProvider["sendKey"]>[0]
    ) {
      return sendText({
        resourceKey: request.resourceKey,
        expectedKeeperGeneration: request.expectedKeeperGeneration,
        text: encodeTerminalKeyInput(request.input),
        operationId: request.operationId
      });
    },
    capture(
      request: Parameters<BoundRemoteTerminalControlProvider["capture"]>[0]
    ) {
      requireRoute(request.resourceKey);
      const lineLimit = request.lineLimit ?? 200;
      const maxBytes = request.maxBytes ?? 1024 * 1024;
      if (
        !Number.isSafeInteger(lineLimit) ||
        lineLimit < 1 ||
        lineLimit > 65_536
      ) {
        return Promise.reject(
          new RangeError("remote surface capture line limit is invalid")
        );
      }
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1024 * 1024
      ) {
        return Promise.reject(
          new RangeError("remote surface capture byte limit is invalid")
        );
      }
      return options.host.captureSurface(options.targetId, {
        resourceKey: structuredClone(request.resourceKey),
        expectedKeeperGeneration: request.expectedKeeperGeneration,
        captureId: request.captureId ?? makeId("remote-surface-capture"),
        lineLimit,
        maxBytes
      });
    }
  });
}
