import { createHash } from "node:crypto";

import { uint64 } from "@kmux/proto";

import type { RemoteHostManager } from "../remoteHost";
import { createBoundRemoteTerminalControlProvider } from "./remoteTerminalControlProvider";

describe("bound remote terminal control provider", () => {
  it("routes bounded input and capture to the bound target with stable IDs", async () => {
    const injectTerminal = vi.fn(async (_targetId, request) => ({
      resourceKey: request.resourceKey,
      keeperGeneration: request.expectedKeeperGeneration,
      operationId: request.operationId,
      writerLeaseId: "lease_1",
      byteLength: Buffer.byteLength(request.input, "utf8"),
      boundary: "pty-write" as const
    }));
    const captureSurface = vi.fn(async (_targetId, request) => ({
      captureId: request.captureId,
      resourceKey: request.resourceKey,
      keeperGeneration: request.expectedKeeperGeneration,
      mutationSequence: uint64(8n),
      cols: 80,
      rows: 24,
      text: "tail",
      lineCount: 1,
      byteLength: 4,
      linesTruncated: false,
      bytesTruncated: false,
      retainedRangeTruncated: false
    }));
    const provider = createBoundRemoteTerminalControlProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: { injectTerminal, captureSurface } as unknown as RemoteHostManager,
      isConnected: () => true
    });
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    };

    await provider.sendText({
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      operationId: "operation_1",
      text: "hello"
    });
    expect(injectTerminal).toHaveBeenCalledWith("target_1", {
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      operationId: "operation_1",
      payloadHash: createHash("sha256").update("hello").digest("hex"),
      input: "hello"
    });

    await provider.sendKey({
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      operationId: "operation_2",
      input: { key: "ArrowUp" }
    });
    expect(injectTerminal.mock.calls[1]?.[1].input).toBe("\u001b[A");

    await provider.capture({
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      captureId: "capture_1",
      lineLimit: 20,
      maxBytes: 4096
    });
    expect(captureSurface).toHaveBeenCalledWith("target_1", {
      resourceKey,
      expectedKeeperGeneration: "keeper_1",
      captureId: "capture_1",
      lineLimit: 20,
      maxBytes: 4096
    });
  });

  it("rejects cross-target routes, offline targets, and oversized bounds", async () => {
    const host = {
      injectTerminal: vi.fn(),
      captureSurface: vi.fn()
    } as unknown as RemoteHostManager;
    const provider = createBoundRemoteTerminalControlProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host,
      isConnected: () => true
    });
    const crossTarget = {
      desktopInstallationId: "desktop_1",
      targetId: "target_2",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    };
    await expect(
      provider.sendText({
        resourceKey: crossTarget,
        expectedKeeperGeneration: "keeper_1",
        text: "blocked"
      })
    ).rejects.toThrow(/bound target scope/u);

    await expect(
      provider.capture({
        resourceKey: { ...crossTarget, targetId: "target_1" },
        expectedKeeperGeneration: "keeper_1",
        lineLimit: 65_537
      })
    ).rejects.toThrow(/line limit/u);

    const offline = createBoundRemoteTerminalControlProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host,
      isConnected: () => false
    });
    await expect(
      offline.sendText({
        resourceKey: { ...crossTarget, targetId: "target_1" },
        expectedKeeperGeneration: "keeper_1",
        text: "blocked"
      })
    ).rejects.toThrow(/not connected/u);
  });
});
