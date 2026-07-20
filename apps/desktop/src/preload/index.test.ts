import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uint64 } from "@kmux/proto";

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
  off: vi.fn(),
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
    off: mocks.off,
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
    mocks.off.mockReset();
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

  it("uses dedicated IPC for retained-session inventory and termination", async () => {
    const snapshot = {
      sessions: [],
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
    const result = {
      operationId: "retained_termination_1",
      outcome: { status: "pending", reason: "offline" }
    };
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    };
    const api = mocks.exposed.get("kmux") as {
      getRetainedRemoteSessions(): Promise<unknown>;
      terminateRetainedRemoteSession(resourceKey: unknown): Promise<unknown>;
    };
    mocks.invoke.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(result);

    await expect(api.getRetainedRemoteSessions()).resolves.toBe(snapshot);
    await expect(api.terminateRetainedRemoteSession(resourceKey)).resolves.toBe(
      result
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "kmux:remote-retained-sessions:get"
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "kmux:remote-retained-sessions:terminate",
      resourceKey
    );
  });

  it("uses dedicated prepare, commit, and cancel IPC for SSH workspace opening", async () => {
    const prepareRequest = {
      requestId: "request_1",
      sourceWorkspaceId: "workspace_1",
      profileId: "profile_1",
      continuation: "create"
    };
    const prepared = { preparationId: "preparation_1" };
    const committed = {
      workspaceId: "workspace_created",
      targetId: "target_1",
      continuation: "create"
    };
    const api = mocks.exposed.get("kmux") as {
      prepareSshWorkspace(request: unknown): Promise<unknown>;
      commitSshWorkspace(request: unknown): Promise<unknown>;
      cancelSshWorkspacePreparation(request: unknown): Promise<void>;
    };
    mocks.invoke
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce(undefined);

    await expect(api.prepareSshWorkspace(prepareRequest)).resolves.toBe(
      prepared
    );
    await expect(
      api.commitSshWorkspace({ preparationId: "preparation_1" })
    ).resolves.toBe(committed);
    await expect(
      api.cancelSshWorkspacePreparation({ requestId: "request_1" })
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "kmux:ssh-workspace:prepare",
      prepareRequest
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "kmux:ssh-workspace:commit",
      { preparationId: "preparation_1" }
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      3,
      "kmux:ssh-workspace:cancel",
      { requestId: "request_1" }
    );
  });

  it("keeps explicit SSH authority rebind on its own IPC command", async () => {
    const snapshot = {
      profiles: [],
      updatedAt: "2026-07-19T00:00:00.000Z"
    };
    const api = mocks.exposed.get("kmux") as {
      rebindSshProfile(profileId: string): Promise<unknown>;
    };
    mocks.invoke.mockResolvedValue(snapshot);

    await expect(api.rebindSshProfile("profile_1")).resolves.toBe(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "kmux:ssh-connections:rebind",
      "profile_1"
    );
  });

  it("keeps runtime clean and reset on explicit maintenance IPC", async () => {
    const cleanReport = {
      inspected: 2,
      removed: [],
      live: [],
      incompleteOrCorrupt: []
    };
    const resetReport = {
      generation: `1+${"c".repeat(64)}`,
      status: "reset"
    };
    const api = mocks.exposed.get("kmux") as {
      cleanSshRuntime(profileId: string): Promise<unknown>;
      resetSshRuntime(profileId: string): Promise<unknown>;
    };
    mocks.invoke
      .mockResolvedValueOnce(cleanReport)
      .mockResolvedValueOnce(resetReport);

    await expect(api.cleanSshRuntime("profile_1")).resolves.toBe(cleanReport);
    await expect(api.resetSshRuntime("profile_1")).resolves.toBe(resetReport);
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "kmux:ssh-connections:runtime-clean",
      "profile_1"
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "kmux:ssh-connections:runtime-reset",
      "profile_1"
    );
  });

  it("relays bounded SSH askpass prompts and responses on dedicated IPC", async () => {
    const prompt = {
      requestId: "prompt_1",
      profileId: "profile_1",
      profileName: "Development",
      prompt: "Password:"
    };
    const response = {
      requestId: "prompt_1",
      cancelled: false,
      response: "one-time-secret"
    };
    const listener = vi.fn();
    const api = mocks.exposed.get("kmux") as {
      respondSshAskpass(request: unknown): Promise<void>;
      subscribeSshAskpassPrompt(
        listener: (prompt: unknown) => void
      ): () => void;
    };
    mocks.invoke.mockResolvedValue(undefined);

    const unsubscribe = api.subscribeSshAskpassPrompt(listener);
    mocks.listeners.get("kmux:ssh-askpass-prompt")?.({}, prompt);
    await expect(api.respondSshAskpass(response)).resolves.toBeUndefined();

    expect(listener).toHaveBeenCalledWith(prompt);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "kmux:ssh-askpass:respond",
      response
    );
    unsubscribe();
    expect(mocks.off).toHaveBeenCalledWith(
      "kmux:ssh-askpass-prompt",
      mocks.listeners.get("kmux:ssh-askpass-prompt")
    );
  });

  it("routes workspace close choices through Main-owned lifecycle commands", async () => {
    const api = mocks.exposed.get("kmux") as {
      closeWorkspaceSafely(workspaceId: string): Promise<void>;
      closeOtherWorkspacesSafely(workspaceId: string): Promise<void>;
    };
    mocks.invoke.mockResolvedValue(undefined);

    await api.closeWorkspaceSafely("workspace_1");
    await api.closeOtherWorkspacesSafely("workspace_1");
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "kmux:workspace:close-safely",
      "workspace_1"
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "kmux:workspace:close-others-safely",
      "workspace_1"
    );
  });

  it("reports structured terminal stream errors through the dedicated IPC channel", async () => {
    const report = {
      surfaceId: "surface_1",
      sessionId: "session_1",
      error: {
        kind: "sequence-gap",
        expectedSequence: uint64(10n),
        receivedSequence: uint64(12n),
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
