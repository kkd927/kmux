import { EventEmitter } from "node:events";

import type { MessagePortMain, UtilityProcess } from "electron";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  type ForkPtyHostProcess,
  PtyHostManager,
  resolvePtyHostLaunchOptions
} from "./ptyHost";
import {
  DIAGNOSTICS_LOG_PATH_ENV,
  PTY_STDOUT_LOGS_ENV
} from "../shared/diagnostics";
import {
  KMUX_NATIVE_CACHE_ROOT_ENV,
  KMUX_RAW_OUTPUT_ROOT_ENV
} from "../shared/platform/env";
import { KMUX_PROFILE_LOG_PATH_ENV } from "../shared/smoothnessProfile";

function createFakeUtilityProcess(
  postMessage: (message: unknown) => void = vi.fn()
): UtilityProcess {
  const child = new EventEmitter() as UtilityProcess;
  child.postMessage = postMessage;
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.stdout = null;
  child.stderr = null;
  return child;
}

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

  it("uses the tsx source entry with raw output logging off by default", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Users/test/kmux/apps/desktop/src/main",
      "development"
    );

    expect(launch).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/pty-host/dev-entry.cjs",
      cwd: "/Users/test/kmux",
      execArgv: [],
      enableStdoutLogs: false
    });
  });

  it("allows explicit raw output logging during development", () => {
    expect(
      resolvePtyHostLaunchOptions(
        "/Users/test/kmux/apps/desktop/src/main",
        "development",
        undefined,
        "1"
      )
    ).toMatchObject({ enableStdoutLogs: true });
  });

  it("passes the resolved env through when starting the pty-host child", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({ PATH: "/usr/local/bin" });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
      [],
      expect.objectContaining({
        stdio: ["ignore", "inherit", "inherit"],
        serviceName: "kmux PTY Supervisor",
        env: {
          PATH: "/usr/local/bin",
          KMUX_PTY_STDOUT_LOGS: "0"
        }
      })
    );
  });

  it("forwards explicit storage roots to the pty-host child", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({
      PATH: "/usr/local/bin",
      KMUX_RUNTIME_DIR: "/run/user/1000/kmux",
      [KMUX_RAW_OUTPUT_ROOT_ENV]: "/home/test/.local/state/kmux/pty-raw",
      [KMUX_NATIVE_CACHE_ROOT_ENV]: "/home/test/.cache/kmux/native"
    });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          KMUX_RUNTIME_DIR: "/run/user/1000/kmux",
          [KMUX_RAW_OUTPUT_ROOT_ENV]: "/home/test/.local/state/kmux/pty-raw",
          [KMUX_NATIVE_CACHE_ROOT_ENV]: "/home/test/.cache/kmux/native"
        })
      })
    );
  });

  it("forwards only absolute smoothness profile log paths to the pty-host child", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({
      PATH: "/usr/local/bin",
      [KMUX_PROFILE_LOG_PATH_ENV]: "logs/kmux-smoothness.jsonl"
    });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
      [],
      expect.objectContaining({
        env: expect.not.objectContaining({
          [KMUX_PROFILE_LOG_PATH_ENV]: "logs/kmux-smoothness.jsonl"
        })
      })
    );
    const firstCallEnv = (
      vi.mocked(forkProcess).mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
    )?.env;
    expect(firstCallEnv).not.toHaveProperty(KMUX_PROFILE_LOG_PATH_ENV);

    manager.stop();

    const secondFakeChild = createFakeUtilityProcess();
    const secondForkProcess = vi.fn(
      () => secondFakeChild
    ) as unknown as ForkPtyHostProcess;
    const secondManager = new PtyHostManager(secondForkProcess);

    secondManager.start({
      PATH: "/usr/local/bin",
      [KMUX_PROFILE_LOG_PATH_ENV]: " /tmp/kmux-smoothness.jsonl "
    });

    expect(secondForkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          [KMUX_PROFILE_LOG_PATH_ENV]: "/tmp/kmux-smoothness.jsonl"
        })
      })
    );
  });

  it("forwards only absolute diagnostics log paths to the pty-host child", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({
      PATH: "/usr/local/bin",
      [DIAGNOSTICS_LOG_PATH_ENV]: "logs/kmux-debug.jsonl"
    });

    const firstCallEnv = (
      vi.mocked(forkProcess).mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
    )?.env;
    expect(firstCallEnv).not.toHaveProperty(DIAGNOSTICS_LOG_PATH_ENV);

    manager.stop();

    const secondFakeChild = createFakeUtilityProcess();
    const secondForkProcess = vi.fn(
      () => secondFakeChild
    ) as unknown as ForkPtyHostProcess;
    const secondManager = new PtyHostManager(secondForkProcess);

    secondManager.start({
      PATH: "/usr/local/bin",
      [DIAGNOSTICS_LOG_PATH_ENV]: " /tmp/kmux-debug.jsonl "
    });

    expect(secondForkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          [DIAGNOSTICS_LOG_PATH_ENV]: "/tmp/kmux-debug.jsonl"
        })
      })
    );
  });

  it("waits for pty-host diagnostics batches to flush before configuration completes", async () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({ PATH: "/usr/local/bin" });
    const onDiagnostics = vi.fn();
    manager.on("diagnostics", onDiagnostics);

    const enablePromise = manager.configureDiagnosticsLogPath(
      " /tmp/kmux-debug.log "
    );
    const enableRequest = postMessage.mock.calls.at(-1)?.[0];
    expect(enableRequest).toEqual({
      type: "diagnostics.configure",
      requestId: expect.any(String),
      logPath: "/tmp/kmux-debug.log"
    });
    fakeChild.emit("message", {
      type: "diagnostics.batch",
      records: [
        {
          at: "2026-07-15T00:00:00.000Z",
          pid: 12,
          scope: "pty-host.diagnostics.configuration.changed",
          details: { enabled: true },
          terminalTelemetry: false
        }
      ]
    });
    expect(onDiagnostics).toHaveBeenCalledWith([
      expect.objectContaining({
        scope: "pty-host.diagnostics.configuration.changed"
      })
    ]);
    fakeChild.emit("message", {
      type: "diagnostics.configured",
      requestId: enableRequest.requestId,
      enabled: true
    });
    await expect(enablePromise).resolves.toBe(true);

    const disablePromise = manager.configureDiagnosticsLogPath(undefined);
    const disableRequest = postMessage.mock.calls.at(-1)?.[0];
    expect(disableRequest).toEqual({
      type: "diagnostics.configure",
      requestId: expect.any(String)
    });
    fakeChild.emit("message", {
      type: "diagnostics.configured",
      requestId: disableRequest.requestId,
      enabled: false
    });
    await expect(disablePromise).resolves.toBe(true);
  });

  it("flushes pty-host diagnostic batches before clear can continue", async () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const onDiagnostics = vi.fn();
    manager.on("diagnostics", onDiagnostics);
    manager.start();

    const flushed = manager.flushDiagnostics();
    const request = postMessage.mock.calls.at(-1)?.[0];
    expect(request).toEqual({
      type: "diagnostics.flush",
      requestId: expect.any(String)
    });
    fakeChild.emit("message", {
      type: "diagnostics.batch",
      records: [
        {
          at: "2026-07-15T00:00:00.000Z",
          pid: 12,
          scope: "before-clear",
          details: {},
          terminalTelemetry: false
        }
      ]
    });
    expect(onDiagnostics).toHaveBeenCalledOnce();
    fakeChild.emit("message", {
      type: "diagnostics.flushed",
      requestId: request.requestId
    });

    await expect(flushed).resolves.toBe(true);
  });

  it("does not hang diagnostics configuration when the pty-host omits its acknowledgement", async () => {
    vi.useFakeTimers();
    const fakeChild = createFakeUtilityProcess();
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    try {
      manager.start();
      const configured = manager.configureDiagnosticsLogPath(
        "/tmp/kmux-debug.log"
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(configured).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables raw PTY stdout logging only when explicitly requested in development", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start({
      PATH: "/usr/local/bin",
      [PTY_STDOUT_LOGS_ENV]: "1"
    });

    expect(forkProcess).toHaveBeenCalledWith(
      expect.stringContaining("/apps/desktop/src/pty-host/dev-entry.cjs"),
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
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      manager.start({
        PATH: "/usr/local/bin",
        [PTY_STDOUT_LOGS_ENV]: "1"
      });
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

  it("queues text input until the session reports shell input ready", () => {
    const send = vi.fn((message: unknown) => Boolean(message));
    const fakeChild = createFakeUtilityProcess(send);

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.sendText("session_1", "echo ready\r");

    expect(send).not.toHaveBeenCalled();

    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234,
      shellInputReady: false
    });

    expect(send).not.toHaveBeenCalled();

    fakeChild.emit("message", {
      type: "shell.ready",
      sessionId: "session_1",
      surfaceId: "surface_1"
    });

    expect(send).toHaveBeenCalledWith({
      type: "input:text",
      sessionId: "session_1",
      text: "echo ready\r"
    });
  });

  it("flushes queued text when spawned reports shell input already ready", () => {
    const send = vi.fn((message: unknown) => Boolean(message));
    const fakeChild = createFakeUtilityProcess(send);

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.sendText("session_1", "echo ready\r");

    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234,
      shellInputReady: true
    });

    expect(send).toHaveBeenCalledWith({
      type: "input:text",
      sessionId: "session_1",
      text: "echo ready\r"
    });
  });

  it("does not report an unexpected pty-host exit after an intentional stop", () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
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

  it("waits for the utility host shutdown acknowledgement before killing it", async () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    const stopPromise = manager.stop();

    const shutdownRequest = postMessage.mock.calls[0]?.[0];
    expect(shutdownRequest).toEqual(
      expect.objectContaining({ type: "shutdown" })
    );
    expect(fakeChild.kill).not.toHaveBeenCalled();
    if (
      !shutdownRequest ||
      typeof shutdownRequest !== "object" ||
      !("requestId" in shutdownRequest)
    ) {
      throw new Error("expected shutdown request");
    }

    fakeChild.emit("message", {
      type: "shutdown:ack",
      requestId: shutdownRequest.requestId
    });

    await expect(stopPromise).resolves.toBeUndefined();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
  });

  it("force-stops the utility host when shutdown is not acknowledged", async () => {
    vi.useFakeTimers();
    const fakeChild = createFakeUtilityProcess();
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    try {
      manager.start();
      const stopPromise = manager.stop();

      await vi.advanceTimersByTimeAsync(1999);
      expect(fakeChild.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh host for the next spawn after an unexpected exit", () => {
    const firstChild = createFakeUtilityProcess();
    const secondPostMessage = vi.fn();
    const secondChild = createFakeUtilityProcess(secondPostMessage);
    const forkProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const onEvent = vi.fn();
    manager.on("event", onEvent);
    const spawnRequest = {
      type: "spawn",
      spec: {
        sessionId: "session_2",
        surfaceId: "surface_2",
        runtimeEpoch: "epoch_2"
      }
    } as never;

    manager.start({ PATH: "/usr/local/bin" });
    manager.send(spawnRequest);
    firstChild.emit("exit", 1);
    manager.send(spawnRequest);

    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "pty-host exited unexpectedly"
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "runtime.lost",
      sessions: [
        {
          surfaceId: "surface_2",
          sessionId: "session_2",
          epoch: "epoch_2"
        }
      ]
    });
    expect(forkProcess).toHaveBeenCalledTimes(2);
    expect(secondPostMessage).toHaveBeenCalledWith(spawnRequest);
  });

  it("marks a restored spawn exited when the utility host cannot be started", () => {
    const forkProcess = vi.fn(() => {
      throw new Error("utility unavailable");
    }) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const onEvent = vi.fn();
    manager.on("event", onEvent);
    const spawnRequest = {
      type: "spawn",
      spec: {
        sessionId: "session_restored",
        surfaceId: "surface_restored",
        runtimeEpoch: "epoch_restored"
      }
    } as never;

    manager.start({ PATH: "/usr/local/bin" });
    manager.send(spawnRequest);

    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      sessionId: "session_restored",
      message: "pty-host IPC channel is not available"
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "exit",
      payload: {
        sessionId: "session_restored",
        surfaceId: "surface_restored"
      }
    });
    expect(
      manager.sessionRef("surface_restored", "session_restored")
    ).toBeNull();
  });

  it("marks a spawn exited when utility IPC delivery throws", () => {
    const postMessage = vi.fn(() => {
      throw new Error("utility channel closed");
    });
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const onEvent = vi.fn();
    manager.on("event", onEvent);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_1",
        surfaceId: "surface_1",
        runtimeEpoch: "epoch_1"
      }
    } as never);

    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      sessionId: "session_1",
      message: "pty-host IPC send failed: utility channel closed"
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "exit",
      payload: {
        sessionId: "session_1",
        surfaceId: "surface_1"
      }
    });
    expect(manager.sessionRef("surface_1", "session_1")).toBeNull();
  });

  it("retains a naturally exited session capability for final checkpoint attach", () => {
    const fakeChild = createFakeUtilityProcess();
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const onEvent = vi.fn();
    manager.on("event", onEvent);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_1",
        surfaceId: "surface_1",
        runtimeEpoch: "epoch_1"
      }
    } as never);
    fakeChild.emit("message", {
      type: "exit",
      payload: {
        sessionId: "session_1",
        surfaceId: "surface_1",
        exitCode: 0
      }
    });

    expect(manager.sessionRef("surface_1", "session_1")).toEqual({
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "epoch_1"
    });

    fakeChild.emit("exit", 1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime.lost",
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: "session_1" })
        ])
      })
    );
  });

  it("binds a port only to the current session epoch", () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);
    const spawnRequest = {
      type: "spawn",
      spec: {
        sessionId: "session_1",
        surfaceId: "surface_1",
        runtimeEpoch: "epoch_1"
      }
    } as never;

    manager.start();
    manager.send(spawnRequest);

    const current = manager.sessionRef("surface_1", "session_1");
    expect(current).toEqual({
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "epoch_1"
    });
    if (!current) {
      throw new Error("expected current session ref");
    }
    current.epoch = "epoch_mutated_by_caller";
    expect(manager.sessionRef("surface_1", "session_1")?.epoch).toBe("epoch_1");
    expect(manager.sessionRef("surface_other", "session_1")).toBeNull();

    postMessage.mockClear();
    const port = { close: vi.fn() } as unknown as MessagePortMain;
    expect(
      manager.bindTerminalStream(
        "attach_stale",
        {
          surfaceId: "surface_1",
          sessionId: "session_1",
          epoch: "epoch_stale"
        },
        port
      )
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    const authoritative = manager.sessionRef("surface_1", "session_1");
    if (!authoritative) {
      throw new Error("expected authoritative session ref");
    }
    expect(manager.bindTerminalStream("attach_1", authoritative, port)).toBe(
      true
    );
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "stream.bind",
        attachId: "attach_1",
        session: authoritative
      },
      [port]
    );
  });

  it("revokes the session capability even when close delivery fails", () => {
    const postMessage = vi.fn((message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "close"
      ) {
        throw new Error("utility channel closed");
      }
    });
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_1",
        surfaceId: "surface_1",
        runtimeEpoch: "epoch_1"
      }
    } as never);
    expect(manager.sessionRef("surface_1", "session_1")).not.toBeNull();

    manager.send({ type: "close", sessionId: "session_1" });

    expect(manager.sessionRef("surface_1", "session_1")).toBeNull();
  });

  it("closes only the exact local session generation after its acknowledgement", async () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_conversion",
        surfaceId: "surface_conversion",
        runtimeEpoch: "epoch_conversion"
      }
    } as never);
    const session = manager.sessionRef(
      "surface_conversion",
      "session_conversion"
    );
    if (!session) throw new Error("expected current local session generation");

    postMessage.mockClear();
    const closed = manager.closeSessionGeneration(session);
    const closeRequest = postMessage.mock.calls[0]?.[0];
    expect(closeRequest).toEqual({
      type: "close",
      requestId: expect.any(String),
      sessionId: "session_conversion",
      surfaceId: "surface_conversion",
      expectedRuntimeEpoch: "epoch_conversion"
    });
    if (
      !closeRequest ||
      typeof closeRequest !== "object" ||
      !("requestId" in closeRequest)
    ) {
      throw new Error("expected generation-fenced close request");
    }
    expect(
      manager.sessionRef("surface_conversion", "session_conversion")
    ).toEqual(session);

    fakeChild.emit("message", {
      type: "close.ack",
      requestId: closeRequest.requestId,
      sessionId: "session_conversion",
      surfaceId: "surface_conversion",
      runtimeEpoch: "epoch_conversion",
      outcome: "terminated"
    });

    await expect(closed).resolves.toBe("terminated");
    expect(
      manager.sessionRef("surface_conversion", "session_conversion")
    ).toBeNull();
  });

  it("rejects a generation-mismatched close acknowledgement without revoking the current capability", async () => {
    const postMessage = vi.fn();
    const fakeChild = createFakeUtilityProcess(postMessage);
    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_current",
        surfaceId: "surface_current",
        runtimeEpoch: "epoch_current"
      }
    } as never);
    const session = manager.sessionRef("surface_current", "session_current");
    if (!session) throw new Error("expected current local session generation");

    postMessage.mockClear();
    const closed = manager.closeSessionGeneration(session);
    const closeRequest = postMessage.mock.calls[0]?.[0];
    if (
      !closeRequest ||
      typeof closeRequest !== "object" ||
      !("requestId" in closeRequest)
    ) {
      throw new Error("expected generation-fenced close request");
    }
    fakeChild.emit("message", {
      type: "close.ack",
      requestId: closeRequest.requestId,
      sessionId: "session_current",
      surfaceId: "surface_current",
      runtimeEpoch: "epoch_replacement",
      outcome: "generation-mismatch"
    });

    await expect(closed).rejects.toThrow(
      "local session close acknowledgement generation differs"
    );
    expect(manager.sessionRef("surface_current", "session_current")).toEqual(
      session
    );
  });

  it("fails a generation-fenced close immediately when delivery or the host is lost", async () => {
    const failingPostMessage = vi.fn((message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "close"
      ) {
        throw new Error("utility channel closed");
      }
    });
    const firstChild = createFakeUtilityProcess(failingPostMessage);
    const secondPostMessage = vi.fn();
    const secondChild = createFakeUtilityProcess(secondPostMessage);
    const forkProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_delivery",
        surfaceId: "surface_delivery",
        runtimeEpoch: "epoch_delivery"
      }
    } as never);
    const deliverySession = manager.sessionRef(
      "surface_delivery",
      "session_delivery"
    );
    if (!deliverySession) throw new Error("expected delivery session");
    await expect(
      manager.closeSessionGeneration(deliverySession)
    ).rejects.toThrow("pty-host IPC send failed: utility channel closed");
    expect(
      manager.sessionRef("surface_delivery", "session_delivery")
    ).toEqual(deliverySession);

    firstChild.emit("exit", 1);
    manager.start();
    manager.send({
      type: "spawn",
      spec: {
        sessionId: "session_host_loss",
        surfaceId: "surface_host_loss",
        runtimeEpoch: "epoch_host_loss"
      }
    } as never);
    const hostLossSession = manager.sessionRef(
      "surface_host_loss",
      "session_host_loss"
    );
    if (!hostLossSession) throw new Error("expected host-loss session");
    const pending = manager.closeSessionGeneration(hostLossSession);
    secondChild.emit("exit", 1);

    await expect(pending).rejects.toThrow(
      "pty-host exited before local session close acknowledgement"
    );
  });

  it("forwards settled snapshot requests to the pty-host child", async () => {
    const send = vi.fn((message: unknown) => Boolean(message));
    const fakeChild = createFakeUtilityProcess(send);

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
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

  it("unrefs snapshot timeout handles", async () => {
    const fakeChild = createFakeUtilityProcess();
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((() => ({ unref })) as never);

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    try {
      manager.start();
      fakeChild.emit("message", {
        type: "spawned",
        sessionId: "session_1",
        pid: 1234
      });

      const snapshotPromise = manager.snapshot("session_1", "surface_1", {
        timeoutMs: 5000
      });

      expect(unref).toHaveBeenCalled();
      manager.stop();
      await expect(snapshotPromise).resolves.toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("resolves pending snapshots with null when stopped", async () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234
    });

    const snapshotPromise = manager.snapshot("session_1", "surface_1", {
      timeoutMs: 5000
    });

    manager.stop();

    await expect(snapshotPromise).resolves.toBeNull();
  });

  it("resolves pending snapshots with null when the child exits", async () => {
    const fakeChild = createFakeUtilityProcess();

    const forkProcess = vi.fn(() => fakeChild) as unknown as ForkPtyHostProcess;
    const manager = new PtyHostManager(forkProcess);

    manager.start();
    fakeChild.emit("message", {
      type: "spawned",
      sessionId: "session_1",
      pid: 1234
    });

    const snapshotPromise = manager.snapshot("session_1", "surface_1", {
      timeoutMs: 5000
    });

    fakeChild.emit("exit", 1);

    await expect(snapshotPromise).resolves.toBeNull();
  });
});
