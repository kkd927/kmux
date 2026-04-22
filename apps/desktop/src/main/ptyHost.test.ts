import { EventEmitter } from "node:events";

import type { ChildProcess, fork } from "node:child_process";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import { PtyHostManager, resolvePtyHostLaunchOptions } from "./ptyHost";

describe("resolvePtyHostLaunchOptions", () => {
  it("uses the unpacked pty-host bundle when running from app.asar", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
      "production",
      "/Applications/kmux.app/Contents/Resources"
    );

    expect(launch).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar.unpacked/dist/pty-host/index.cjs",
      cwd: "/Applications/kmux.app/Contents/Resources",
      execArgv: [],
      enableStdoutLogs: false
    });
  });

  it("uses the production build output when running unpackaged in production", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Users/test/kmux/apps/desktop/out/main",
      "production"
    );

    expect(launch).toEqual({
      entry: "/Users/test/kmux/apps/desktop/dist/pty-host/index.cjs",
      cwd: "/Users/test/kmux",
      execArgv: [],
      enableStdoutLogs: false
    });
  });

  it("uses the tsx source entry during development", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Users/test/kmux/apps/desktop/src/main",
      "development"
    );

    expect(launch).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/pty-host/index.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"],
      enableStdoutLogs: true
    });
  });

  it("passes the resolved env through when starting the pty-host child", () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    (fakeChild as ChildProcess & { send: () => boolean }).send = () => true;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);

    manager.start({ PATH: "/usr/local/bin" });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/index.ts"),
      [],
      expect.objectContaining({
        env: {
          PATH: "/usr/local/bin",
          KMUX_PTY_STDOUT_LOGS: "1"
        }
      })
    );
  });

  it("enables raw PTY stdout logging while running in development", () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    (fakeChild as ChildProcess & { send: () => boolean }).send = () => true;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);

    manager.start({ PATH: "/usr/local/bin" });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/index.ts"),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/usr/local/bin",
          KMUX_PTY_STDOUT_LOGS: "1"
        })
      })
    );
  });

  it("disables raw PTY stdout logging for the production build", () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    (fakeChild as ChildProcess & { send: () => boolean }).send = () => true;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      manager.start({ PATH: "/usr/local/bin" });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/dist/pty-host/index.cjs"),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/usr/local/bin",
          KMUX_PTY_STDOUT_LOGS: "0"
        })
      })
    );
  });

  it("queues text input until the session reports spawned", () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    const send = vi.fn((message: unknown) => Boolean(message));
    (fakeChild as ChildProcess & { send: typeof send }).send = send;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.sendText("session_1", "echo ready\r");

    expect(send).not.toHaveBeenCalled();

    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234
    });

    expect(send).toHaveBeenCalledWith({
      type: "input:text",
      sessionId: "session_1",
      text: "echo ready\r"
    });
  });

  it("does not report an unexpected pty-host exit after an intentional stop", () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    (fakeChild as ChildProcess & { send: () => boolean }).send = () => true;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);
    const onEvent = vi.fn();

    manager.on("event", onEvent);
    manager.start();
    manager.stop();
    fakeChild.emit("exit", 0);

    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "pty-host exited unexpectedly"
      })
    );
  });

  it("forwards settled snapshot requests to the pty-host child", async () => {
    const fakeChild = new EventEmitter() as ChildProcess;
    (fakeChild as ChildProcess & { connected: boolean }).connected = true;
    (fakeChild as ChildProcess & { kill: () => boolean }).kill = () => true;
    const send = vi.fn((message: unknown) => Boolean(message));
    (fakeChild as ChildProcess & { send: typeof send }).send = send;

    const forkProcess = vi.fn(() => fakeChild) as unknown as typeof fork;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234
    });

    const snapshotPromise = manager.snapshot("session_1", "surface_1", {
      settleForMs: 300,
      timeoutMs: 5000
    });

    const snapshotCall = send.mock.calls[send.mock.calls.length - 1];
    expect(snapshotCall).toBeDefined();
    const [snapshotRequest] = snapshotCall ?? [];
    expect(snapshotRequest).toBeDefined();
    if (
      !snapshotRequest ||
      typeof snapshotRequest !== "object" ||
      !("requestId" in snapshotRequest)
    ) {
      throw new Error("expected snapshot request to be sent");
    }
    expect(snapshotRequest).toEqual(
      expect.objectContaining({
        type: "snapshot",
        sessionId: "session_1",
        surfaceId: "surface_1",
        settleForMs: 300
      })
    );

    fakeChild.emit("message", {
      type: "snapshot",
      requestId: snapshotRequest.requestId,
      payload: null
    });

    await expect(snapshotPromise).resolves.toBeNull();
  });
});
