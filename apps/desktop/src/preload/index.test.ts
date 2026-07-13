import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KMUX_TERMINAL_PORT_CHANNEL,
  KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
  type TerminalStreamAttachResult,
  type TerminalStreamGrant
} from "../shared/terminalPort";
import type { TerminalStreamErrorReport } from "../shared/terminalStreamDiagnostics";

type IpcListener = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  listeners: new Map<string, IpcListener>(),
  postWindowMessage: vi.fn()
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      mocks.exposed.set(name, value);
    })
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    off: vi.fn(),
    on: vi.fn((channel: string, listener: IpcListener) => {
      mocks.listeners.set(channel, listener);
    })
  },
  webUtils: {
    getPathForFile: vi.fn()
  }
}));

describe("terminal stream preload bridge", () => {
  beforeAll(async () => {
    vi.stubGlobal("window", { postMessage: mocks.postWindowMessage });
    await import("./index");
  });

  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.postWindowMessage.mockReset();
  });

  it("transfers the native MessagePort into the renderer main world", () => {
    const listener = mocks.listeners.get(KMUX_TERMINAL_PORT_CHANNEL);
    const port = { close: vi.fn(), postMessage: vi.fn() };
    const grant: TerminalStreamGrant = {
      attachId: "attach_1",
      session: {
        surfaceId: "surface_1",
        sessionId: "session_1",
        epoch: "epoch_1"
      }
    };

    listener?.({ ports: [port] }, grant);

    expect(mocks.postWindowMessage).toHaveBeenCalledWith(
      {
        type: KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
        grant
      },
      "*",
      [port]
    );
  });

  it("does not publish a capability without its transferred port", () => {
    const listener = mocks.listeners.get(KMUX_TERMINAL_PORT_CHANNEL);

    listener?.(
      { ports: [] },
      {
        attachId: "attach_1",
        session: {
          surfaceId: "surface_1",
          sessionId: "session_1",
          epoch: "epoch_1"
        }
      }
    );

    expect(mocks.postWindowMessage).not.toHaveBeenCalled();
  });

  it("closes the port if the renderer context can no longer accept it", () => {
    const listener = mocks.listeners.get(KMUX_TERMINAL_PORT_CHANNEL);
    const port = { close: vi.fn(), postMessage: vi.fn() };
    mocks.postWindowMessage.mockImplementation(() => {
      throw new Error("renderer navigated");
    });

    listener?.(
      { ports: [port] },
      {
        attachId: "attach_1",
        session: {
          surfaceId: "surface_1",
          sessionId: "session_1",
          epoch: "epoch_1"
        }
      }
    );

    expect(port.close).toHaveBeenCalledOnce();
  });

  it("requests a stream grant without proxying terminal chunks", async () => {
    const grant: TerminalStreamGrant = {
      attachId: "attach_1",
      session: {
        surfaceId: "surface_1",
        sessionId: "session_1",
        epoch: "epoch_1"
      }
    };
    const result = {
      status: "granted",
      grant
    } satisfies TerminalStreamAttachResult;
    mocks.invoke.mockResolvedValue(result);
    const api = mocks.exposed.get("kmux") as {
      attachTerminalStream(
        surfaceId: string,
        sessionId: string
      ): Promise<TerminalStreamAttachResult>;
    };

    await expect(
      api.attachTerminalStream("surface_1", "session_1")
    ).resolves.toBe(result);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "kmux:terminal-stream:attach",
      "surface_1",
      "session_1"
    );
  });

  it("reports structured terminal stream errors through the dedicated IPC channel", async () => {
    const report = {
      surfaceId: "surface_1",
      sessionId: "session_1",
      error: {
        kind: "sequence-gap",
        expectedSequence: 10,
        receivedSequence: 12,
        message: "expected sequence 10, received 12"
      }
    } satisfies TerminalStreamErrorReport;
    mocks.invoke.mockResolvedValue(undefined);
    const api = mocks.exposed.get("kmux") as {
      reportTerminalStreamError(
        report: TerminalStreamErrorReport
      ): Promise<void>;
    };

    await expect(
      api.reportTerminalStreamError(report)
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "kmux:terminal-stream:report-error",
      report
    );
  });

  it("exposes diagnostics log clearing without accepting a renderer path", async () => {
    mocks.invoke.mockResolvedValue(true);
    const api = mocks.exposed.get("kmux") as {
      clearDiagnosticLog(): Promise<boolean>;
    };

    await expect(api.clearDiagnosticLog()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("kmux:diagnostics:clear-log");
  });
});
