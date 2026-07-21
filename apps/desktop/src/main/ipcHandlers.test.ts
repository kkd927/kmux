import { describe, expect, it, vi } from "vitest";

import {
  BrowserWindow,
  Menu,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { buildDefaultShortcuts } from "@kmux/ui";
import type { RemoteOperationCommandResult } from "@kmux/core";

import type {
  CreateImageAttachmentsResult,
  CreateImageAttachmentPayload,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  RetainedRemoteSessionResourceKey,
  RetainedRemoteSessionsSnapshot,
  SshAskpassResponseRequest,
  SurfaceCapturePayload,
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult
} from "@kmux/proto";
import { createRendererPlatformDescriptor } from "../shared/platform/rendererPlatform";
import type {
  TerminalStreamAttachResult,
  TerminalStreamGrant
} from "../shared/terminalPort";
import type { TerminalStreamErrorReport } from "../shared/terminalStreamDiagnostics";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn()
  },
  clipboard: {
    availableFormats: vi.fn(() => []),
    read: vi.fn(() => ""),
    readBookmark: vi.fn(() => ({ title: "", url: "" })),
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    readImage: vi.fn(() => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0)
    })),
    readText: vi.fn(() => ""),
    writeText: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }
    )
  },
  Menu: {
    buildFromTemplate: vi.fn()
  }
}));

import { registerIpcHandlers } from "./ipcHandlers";

function registerTestHandlers(options: {
  snapshot: ExternalAgentSessionsSnapshot;
  resumeResult: ExternalAgentSessionResumeResult;
  attachmentResult?: CreateImageAttachmentsResult;
  attachTerminalStream?: (
    event: IpcMainInvokeEvent,
    surfaceId: string,
    expectedSessionId: string
  ) => TerminalStreamAttachResult;
  reportTerminalStreamError?: (report: TerminalStreamErrorReport) => void;
  openExternalUrl?: (surfaceId: string, url: string) => Promise<void>;
  openTerminalFilePath?: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  resolveTerminalFileLinks?: (
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult> | TerminalFileLinkResolveResult;
  activateTerminalFileLink?: (
    sender: { id: number },
    request: unknown
  ) => Promise<void>;
  isSurfaceDiagnosticsEnabled?: () => boolean;
  clearDiagnosticLog?: () => boolean;
  dispatchRendererAction?: (action: unknown) => void | Promise<void>;
  getRetainedRemoteSessions?: () => RetainedRemoteSessionsSnapshot;
  terminateRetainedRemoteSession?: (
    resourceKey: RetainedRemoteSessionResourceKey
  ) => Promise<RemoteOperationCommandResult>;
  respondSshAskpass?: (request: SshAskpassResponseRequest) => void;
  cleanSshRuntime?: (profileId: string) => Promise<{
    inspected: number;
    removed: string[];
    live: string[];
    incompleteOrCorrupt: string[];
  }>;
  resetSshRuntime?: (profileId: string) => Promise<{
    generation: string;
    status: "reset" | "already-absent";
  }>;
  closeWorkspaceSafely?: (workspaceId: string) => void | Promise<void>;
  closeOtherWorkspacesSafely?: (workspaceId: string) => void | Promise<void>;
  captureSurfaceDiagnostics?: (
    surfaceId: string
  ) => Promise<SurfaceCapturePayload>;
  clipboard?: {
    readText: () => string;
    writeText: (text: string) => void;
    readImages: () => CreateImageAttachmentPayload[];
    hasPasteableContent: () => boolean;
  };
}): void {
  handlers.clear();
  registerIpcHandlers({
    getPlatformDescriptor: () =>
      createRendererPlatformDescriptor({
        windowChrome: "native",
        shortcutStyle: "mac-symbols",
        supportsDock: true,
        keepProcessAliveWhenLastWindowCloses: true
      }),
    getShellState: vi.fn(),
    getWorkspaceContextView: vi.fn(),
    getUsageView: vi.fn(),
    getUpdaterState: vi.fn(),
    subscribeDocument: vi.fn(),
    unsubscribeDocument: vi.fn(),
    dispatchRendererAction: options.dispatchRendererAction ?? vi.fn(),
    getRetainedRemoteSessions:
      options.getRetainedRemoteSessions ??
      vi.fn(() => ({
        sessions: [],
        updatedAt: "2026-07-18T00:00:00.000Z"
      })),
    terminateRetainedRemoteSession:
      options.terminateRetainedRemoteSession ??
      vi.fn(async () => ({
        operationId: "retained_termination_test",
        outcome: { status: "pending" as const, reason: "offline" as const }
      })),
    getSshConnections: vi.fn(async () => ({
      profiles: [],
      updatedAt: "2026-07-19T00:00:00.000Z"
    })),
    listSshConfigAliases: vi.fn(() => []),
    importSshConfigAliases: vi.fn(async () => ({
      profiles: [],
      updatedAt: "2026-07-19T00:00:00.000Z"
    })),
    saveSshProfile: vi.fn(),
    duplicateSshProfile: vi.fn(),
    deleteSshProfile: vi.fn(),
    testSshProfile: vi.fn(async () => ({
      profiles: [],
      updatedAt: "2026-07-19T00:00:00.000Z"
    })),
    rebindSshProfile: vi.fn(async () => ({
      profiles: [],
      updatedAt: "2026-07-19T00:00:00.000Z"
    })),
    cleanSshRuntime:
      options.cleanSshRuntime ??
      vi.fn(async () => ({
        inspected: 0,
        removed: [],
        live: [],
        incompleteOrCorrupt: []
      })),
    resetSshRuntime:
      options.resetSshRuntime ??
      vi.fn(async () => ({
        generation: `1+${"c".repeat(64)}`,
        status: "reset" as const
      })),
    prepareSshWorkspace: vi.fn(async () => ({
      preparationId: "preparation_test"
    })),
    commitSshWorkspace: vi.fn(async () => ({
      workspaceId: "workspace_1",
      targetId: "target_test",
      continuation: "convert" as const
    })),
    cancelSshWorkspacePreparation: vi.fn(),
    respondSshAskpass: options.respondSshAskpass ?? vi.fn(),
    closeWorkspaceSafely: options.closeWorkspaceSafely ?? vi.fn(),
    closeOtherWorkspacesSafely: options.closeOtherWorkspacesSafely ?? vi.fn(),
    attachTerminalStream: options.attachTerminalStream ?? vi.fn(),
    reportTerminalStreamError: options.reportTerminalStreamError ?? vi.fn(),
    snapshotSurface: vi.fn(),
    sendText: vi.fn(),
    sendKeyInput: vi.fn(),
    openExternalUrl: options.openExternalUrl ?? vi.fn(),
    openTerminalFilePath: options.openTerminalFilePath ?? vi.fn(),
    resolveTerminalFileLinks:
      options.resolveTerminalFileLinks ?? vi.fn(() => ({ links: [] })),
    activateTerminalFileLink:
      options.activateTerminalFileLink ?? vi.fn(async () => undefined),
    identify: vi.fn(),
    previewTerminalTypography: vi.fn(),
    reportTerminalTypographyProbe: vi.fn(),
    importTerminalThemePalette: vi.fn(),
    exportTerminalThemePalette: vi.fn(),
    openSettingsJson: vi.fn(),
    clearDiagnosticLog: options.clearDiagnosticLog ?? vi.fn(() => true),
    isSurfaceDiagnosticsEnabled:
      options.isSurfaceDiagnosticsEnabled ?? vi.fn(() => false),
    captureSurfaceDiagnostics:
      options.captureSurfaceDiagnostics ??
      vi.fn(async () => ({
        surfaceId: "surface_1",
        capturedAt: "2026-05-27T00:00:00.000Z",
        outDir: "/tmp/kmux-capture",
        files: {
          json: "/tmp/kmux-capture/capture.json",
          text: "/tmp/kmux-capture/terminal.txt"
        },
        snapshot: null,
        snapshotDiagnostics: {
          selected: "unavailable" as const,
          attempts: []
        },
        diagnosticsHealth: { mainWriter: null, ptyHost: null },
        renderer: { ok: false },
        timings: {
          snapshotCompletedAt: "2026-05-27T00:00:00.000Z",
          rendererCompletedAt: "2026-05-27T00:00:00.000Z"
        },
        screenshotDiagnostics: {
          sourceSurfaceId: null,
          trusted: null,
          skippedReason: "renderer-unavailable" as const
        },
        contentConsistency: {
          verdict: "indeterminate" as const,
          sampledLines: 0,
          matchedLines: 0
        },
        rendererBufferTrusted: null,
        rendererTrusted: null
      })),
    prepareWorktreeConversion: vi.fn(),
    createWorktreeWorkspace: vi.fn(),
    convertDetectedWorktree: vi.fn(),
    removeWorkspaceWorktree: vi.fn(),
    removeWorkspaceWorktrees: vi.fn(),
    setUsageDashboardOpen: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    installDownloadedUpdate: vi.fn(),
    clipboard: options.clipboard,
    getExternalAgentSessions: () => options.snapshot,
    resumeExternalAgentSession: () => options.resumeResult,
    createImageAttachments: async (
      _surfaceId: string,
      _payloads: CreateImageAttachmentPayload[]
    ) => {
      return (
        options.attachmentResult ?? {
          attachments: [],
          promptText: "",
          skippedCount: 0,
          status: "empty",
          message: "No supported image found"
        }
      );
    }
  });
}

describe("ipc handlers", () => {
  it("accepts renderer dispatch only from the trusted main frame", async () => {
    const dispatchRendererAction = vi.fn(async () => undefined);
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      dispatchRendererAction
    });
    const handler = handlers.get("kmux:dispatch")!;
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const event = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;
    const action = { type: "surface.close", surfaceId: "surface_1" };

    await expect(
      Promise.resolve(handler(event, action))
    ).resolves.toBeUndefined();
    expect(dispatchRendererAction).toHaveBeenCalledWith(action);
    expect(() =>
      handler(
        {
          senderFrame: { ...mainFrame },
          sender: { mainFrame }
        } as unknown as IpcMainInvokeEvent,
        action
      )
    ).toThrow(/trusted main frame/u);
    expect(handlers.has("kmux:remote-operation")).toBe(false);
  });

  it("lists and terminates retained sessions only through the trusted main frame", async () => {
    const retainedSnapshot: RetainedRemoteSessionsSnapshot = {
      sessions: [],
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
    const terminateRetainedRemoteSession = vi.fn(async () => ({
      operationId: "retained_termination_1",
      outcome: { status: "pending" as const, reason: "offline" as const }
    }));
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      getRetainedRemoteSessions: () => retainedSnapshot,
      terminateRetainedRemoteSession
    });
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const event = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;
    const resourceKey: RetainedRemoteSessionResourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    };

    expect(handlers.get("kmux:remote-retained-sessions:get")!(event)).toBe(
      retainedSnapshot
    );
    await expect(
      Promise.resolve(
        handlers.get("kmux:remote-retained-sessions:terminate")!(
          event,
          resourceKey
        )
      )
    ).resolves.toMatchObject({ operationId: "retained_termination_1" });
    expect(terminateRetainedRemoteSession).toHaveBeenCalledWith(resourceKey);

    expect(() =>
      handlers.get("kmux:remote-retained-sessions:get")!({
        senderFrame: { ...mainFrame },
        sender: { mainFrame }
      } as unknown as IpcMainInvokeEvent)
    ).toThrow(/trusted main frame/u);
  });

  it("routes profile-backed SSH workspace preparation, commit, and cancellation through trusted boundaries", async () => {
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      }
    });
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const event = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;
    const request = {
      requestId: "request_1",
      sourceWorkspaceId: "workspace_1",
      profileId: "profile_1",
      continuation: "convert"
    };

    await expect(
      Promise.resolve(
        handlers.get("kmux:ssh-workspace:prepare")!(event, request)
      )
    ).resolves.toEqual({ preparationId: "preparation_test" });
    await expect(
      Promise.resolve(
        handlers.get("kmux:ssh-workspace:commit")!(event, {
          preparationId: "preparation_test"
        })
      )
    ).resolves.toEqual({
      workspaceId: "workspace_1",
      targetId: "target_test",
      continuation: "convert"
    });
    expect(
      handlers.get("kmux:ssh-workspace:cancel")!(event, {
        requestId: "request_1"
      })
    ).toBeUndefined();
    expect(() =>
      handlers.get("kmux:ssh-workspace:prepare")!({
        senderFrame: { ...mainFrame },
        sender: { mainFrame }
      } as unknown as IpcMainInvokeEvent)
    ).toThrow(/trusted main frame/u);
  });

  it("routes runtime clean and reset only through the trusted main frame", async () => {
    const cleanReport = {
      inspected: 3,
      removed: [`1+${"a".repeat(64)}`],
      live: [`1+${"b".repeat(64)}`],
      incompleteOrCorrupt: []
    };
    const resetReport = {
      generation: `1+${"b".repeat(64)}`,
      status: "reset" as const
    };
    const cleanSshRuntime = vi.fn(async () => cleanReport);
    const resetSshRuntime = vi.fn(async () => resetReport);
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      cleanSshRuntime,
      resetSshRuntime
    });
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const trustedEvent = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;

    await expect(
      Promise.resolve(
        handlers.get("kmux:ssh-connections:runtime-clean")!(
          trustedEvent,
          "profile_1"
        )
      )
    ).resolves.toEqual(cleanReport);
    await expect(
      Promise.resolve(
        handlers.get("kmux:ssh-connections:runtime-reset")!(
          trustedEvent,
          "profile_1"
        )
      )
    ).resolves.toEqual(resetReport);
    expect(cleanSshRuntime).toHaveBeenCalledWith("profile_1");
    expect(resetSshRuntime).toHaveBeenCalledWith("profile_1");

    expect(() =>
      handlers.get("kmux:ssh-connections:runtime-reset")!(
        {
          senderFrame: { ...mainFrame },
          sender: { mainFrame }
        } as unknown as IpcMainInvokeEvent,
        "profile_1"
      )
    ).toThrow(/trusted main frame/u);
  });

  it("accepts SSH askpass responses only from the trusted renderer", () => {
    const respondSshAskpass = vi.fn();
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      respondSshAskpass
    });
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const event = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;
    const response: SshAskpassResponseRequest = {
      requestId: "prompt_1",
      cancelled: false,
      response: "one-time-secret"
    };

    expect(
      handlers.get("kmux:ssh-askpass:respond")!(event, response)
    ).toBeUndefined();
    expect(respondSshAskpass).toHaveBeenCalledWith(response);
    expect(() =>
      handlers.get("kmux:ssh-askpass:respond")!(
        {
          senderFrame: { ...mainFrame },
          sender: { mainFrame }
        } as unknown as IpcMainInvokeEvent,
        response
      )
    ).toThrow(/trusted main frame/u);
  });

  it("routes workspace close and close-others through Main-owned lifecycle checks", async () => {
    const closeWorkspaceSafely = vi.fn();
    const closeOtherWorkspacesSafely = vi.fn();
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      closeWorkspaceSafely,
      closeOtherWorkspacesSafely
    });
    const mainFrame = {
      detached: false,
      isDestroyed: () => false
    };
    const event = {
      senderFrame: mainFrame,
      sender: { mainFrame }
    } as unknown as IpcMainInvokeEvent;

    handlers.get("kmux:workspace:close-safely")!(event, "workspace_1");
    handlers.get("kmux:workspace:close-others-safely")!(event, "workspace_1");
    expect(closeWorkspaceSafely).toHaveBeenCalledWith("workspace_1");
    expect(closeOtherWorkspacesSafely).toHaveBeenCalledWith("workspace_1");
  });

  it("registers a dedicated renderer platform descriptor handler", async () => {
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      }
    });

    const handler = handlers.get("kmux:platform:get");

    expect(handler).toBeTypeOf("function");
    await expect(Promise.resolve(handler?.({}))).resolves.toMatchObject({
      windowChrome: "native",
      shortcutStyle: "mac-symbols",
      desktop: {
        supportsDock: true,
        keepProcessAliveWhenLastWindowCloses: true
      }
    });
  });

  it("passes the invoking frame through when requesting a terminal stream", () => {
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
    const attachTerminalStream = vi.fn(() => result);
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      attachTerminalStream
    });
    const handler = handlers.get("kmux:terminal-stream:attach");
    const event = {
      sender: { id: 7 },
      senderFrame: { routingId: 9 }
    } as unknown as IpcMainInvokeEvent;

    expect(handler?.(event, "surface_1", "session_1")).toBe(result);
    expect(attachTerminalStream).toHaveBeenCalledWith(
      event,
      "surface_1",
      "session_1"
    );
  });

  it("forwards only validated terminal stream error reports", () => {
    const reportTerminalStreamError = vi.fn();
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-06-10T00:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      reportTerminalStreamError
    });
    const handler = handlers.get("kmux:terminal-stream:report-error");

    expect(
      handler?.(
        {},
        {
          surfaceId: "surface_1",
          sessionId: "session_1",
          error: {
            kind: "host-error",
            code: "runtime-lost",
            message: "PTY runtime disconnected",
            recoverable: true
          }
        }
      )
    ).toBeUndefined();
    expect(reportTerminalStreamError).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_1",
      error: {
        kind: "host-error",
        code: "runtime-lost",
        message: "PTY runtime disconnected",
        recoverable: true
      }
    });

    expect(() =>
      handler?.(
        {},
        {
          surfaceId: "surface_1",
          sessionId: "session_1",
          error: { kind: "unknown", message: "bad payload" }
        }
      )
    ).toThrow("Invalid terminal stream error report");
    expect(reportTerminalStreamError).toHaveBeenCalledTimes(1);
  });

  it("registers external session list and resume handlers", async () => {
    const snapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-04-26T12:00:00.000Z",
      sessions: []
    };
    const resumeResult = {
      workspaceId: "workspace-1",
      surfaceId: "surface-1"
    };
    registerTestHandlers({ snapshot, resumeResult });

    const listHandler = handlers.get("kmux:external-sessions:get");
    const resumeHandler = handlers.get("kmux:external-sessions:resume");

    expect(listHandler).toBeTypeOf("function");
    expect(resumeHandler).toBeTypeOf("function");
    await expect(Promise.resolve(listHandler?.({}))).resolves.toBe(snapshot);
    await expect(
      Promise.resolve(resumeHandler?.({}, "codex:session"))
    ).resolves.toBe(resumeResult);
  });

  it("registers image attachment creation handler", async () => {
    const snapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-05-07T12:00:00.000Z",
      sessions: []
    };
    const resumeResult = {
      workspaceId: "workspace-1",
      surfaceId: "surface-1"
    };
    const attachmentResult: CreateImageAttachmentsResult = {
      attachments: [],
      promptText: "@/tmp/kmux/image.png",
      skippedCount: 0,
      status: "attached",
      message: "Attached image.png"
    };
    registerTestHandlers({ snapshot, resumeResult, attachmentResult });

    const attachmentHandler = handlers.get("kmux:image-attachments:create");

    expect(attachmentHandler).toBeTypeOf("function");
    await expect(
      Promise.resolve(
        attachmentHandler?.({}, "surface-1", [
          {
            source: "drop",
            originalName: "image.png",
            mimeType: "image/png",
            bytes: new Uint8Array([1, 2, 3])
          }
        ])
      )
    ).resolves.toBe(attachmentResult);
  });

  it("registers clipboard handlers through the main clipboard service", async () => {
    const imagePayload: CreateImageAttachmentPayload = {
      source: "clipboard",
      originalName: "clipboard.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    };
    const clipboard = {
      readText: vi.fn(() => "copied text"),
      writeText: vi.fn(),
      readImages: vi.fn(() => [imagePayload]),
      hasPasteableContent: vi.fn(() => true)
    };
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-07T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      clipboard
    });

    await expect(
      Promise.resolve(handlers.get("kmux:clipboard:read-text")?.({}))
    ).resolves.toBe("copied text");
    await Promise.resolve(
      handlers.get("kmux:clipboard:write-text")?.({}, "new text")
    );
    await expect(
      Promise.resolve(handlers.get("kmux:clipboard:read-images")?.({}))
    ).resolves.toEqual([imagePayload]);
    await expect(
      Promise.resolve(
        handlers.get("kmux:clipboard:has-pasteable-content")?.({})
      )
    ).resolves.toBe(true);

    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith("new text");
    expect(clipboard.readImages).toHaveBeenCalledTimes(1);
    expect(clipboard.hasPasteableContent).toHaveBeenCalledTimes(1);
  });

  it("clears the fixed diagnostics log through a pathless IPC action", async () => {
    const clearDiagnosticLog = vi.fn(() => true);
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-27T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      clearDiagnosticLog
    });

    await expect(
      Promise.resolve(handlers.get("kmux:diagnostics:clear-log")?.({}))
    ).resolves.toBe(true);
    expect(clearDiagnosticLog).toHaveBeenCalledOnce();
  });

  it("captures surface diagnostics only when enabled", async () => {
    const snapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-05-27T12:00:00.000Z",
      sessions: []
    };
    const resumeResult = {
      workspaceId: "workspace-1",
      surfaceId: "surface-1"
    };
    const captureSurfaceDiagnostics = vi.fn(async (surfaceId: string) => ({
      surfaceId,
      capturedAt: "2026-05-27T00:00:00.000Z",
      outDir: "/tmp/kmux-capture",
      files: {
        json: "/tmp/kmux-capture/capture.json",
        text: "/tmp/kmux-capture/terminal.txt"
      },
      snapshot: null,
      snapshotDiagnostics: {
        selected: "unavailable" as const,
        attempts: []
      },
      diagnosticsHealth: { mainWriter: null, ptyHost: null },
      renderer: { ok: true },
      timings: {
        snapshotCompletedAt: "2026-05-27T00:00:00.000Z",
        rendererCompletedAt: "2026-05-27T00:00:00.000Z"
      },
      screenshotDiagnostics: {
        sourceSurfaceId: null,
        trusted: null,
        skippedReason: "renderer-unavailable" as const
      },
      contentConsistency: {
        verdict: "indeterminate" as const,
        sampledLines: 0,
        matchedLines: 0
      },
      rendererBufferTrusted: null,
      rendererTrusted: null
    }));
    registerTestHandlers({
      snapshot,
      resumeResult,
      isSurfaceDiagnosticsEnabled: vi.fn(() => true),
      captureSurfaceDiagnostics
    });

    const handler = handlers.get("kmux:surface-diagnostics:capture");

    await expect(
      Promise.resolve(handler?.({}, "surface_debug"))
    ).resolves.toMatchObject({
      surfaceId: "surface_debug",
      files: {
        json: "/tmp/kmux-capture/capture.json"
      }
    });
    expect(captureSurfaceDiagnostics).toHaveBeenCalledWith("surface_debug");

    registerTestHandlers({
      snapshot,
      resumeResult,
      isSurfaceDiagnosticsEnabled: vi.fn(() => false),
      captureSurfaceDiagnostics
    });

    await expect(
      Promise.resolve(
        handlers.get("kmux:surface-diagnostics:capture")?.({}, "surface_debug")
      )
    ).rejects.toThrow("Surface diagnostic capture is disabled");
  });

  it("uses the current diagnostics getter value when building surface context menus", async () => {
    const popup = vi.fn();
    const sender = {};
    const isSurfaceDiagnosticsEnabled = vi.fn((): boolean => false);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(
      {} as ReturnType<typeof BrowserWindow.fromWebContents>
    );
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({
      popup
    } as unknown as Menu);
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-27T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      isSurfaceDiagnosticsEnabled
    });
    const handler = handlers.get("kmux:surface-context-menu");
    const payload = {
      surfaceId: "surface_debug",
      x: 4,
      y: 8,
      context: {
        canCopy: true,
        canPaste: true,
        canRestart: true,
        sessionState: "running",
        settings: {
          shortcuts: buildDefaultShortcuts("darwin")
        }
      }
    };

    try {
      await expect(
        Promise.resolve(handler?.({ sender }, payload))
      ).resolves.toBeUndefined();
      expect(
        (
          vi.mocked(Menu.buildFromTemplate).mock
            .calls[0]?.[0] as MenuItemConstructorOptions[]
        ).map((item) => item.label)
      ).not.toContain("Capture Diagnostics");

      isSurfaceDiagnosticsEnabled.mockReturnValue(true);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      await expect(
        Promise.resolve(handler?.({ sender }, payload))
      ).resolves.toBeUndefined();
      expect(
        (
          vi.mocked(Menu.buildFromTemplate).mock
            .calls[0]?.[0] as MenuItemConstructorOptions[]
        ).map((item) => item.label)
      ).toContain("Capture Diagnostics");
    } finally {
      vi.mocked(BrowserWindow.fromWebContents).mockReset();
      vi.mocked(Menu.buildFromTemplate).mockReset();
    }
  });

  it("registers external URL open handler", async () => {
    const openExternalUrl = vi.fn(async () => {});
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      openExternalUrl
    });

    const handler = handlers.get("kmux:external-url:open");
    const sender = { send: vi.fn() };

    expect(handler).toBeTypeOf("function");
    await Promise.resolve(
      handler?.({ sender }, "surface_1", "https://example.com/path")
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "surface_1",
      "https://example.com/path"
    );
    expect(sender.send).toHaveBeenCalledWith(
      "kmux:external-url:opened",
      "https://example.com/path"
    );
  });

  it("registers terminal file open handler", async () => {
    const openTerminalFilePath = vi.fn(async () => {});
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      openTerminalFilePath
    });

    const handler = handlers.get("kmux:terminal-file:open");

    expect(handler).toBeTypeOf("function");
    await Promise.resolve(
      handler?.({}, "surface-1", "src/App.tsx:12:3", "/repo/old")
    );
    expect(openTerminalFilePath).toHaveBeenCalledWith(
      "surface-1",
      "src/App.tsx:12:3",
      "/repo/old"
    );
  });

  it("registers terminal file link resolve handler", async () => {
    const resolveResult: TerminalFileLinkResolveResult = {
      links: [
        {
          id: "candidate-1",
          openRawPath: "src/App.tsx",
          resolvedPath: "/repo/old/src/App.tsx",
          linkText: "src/App.tsx:12",
          startIndex: 0,
          endIndex: "src/App.tsx:12".length
        }
      ]
    };
    const resolveTerminalFileLinks = vi.fn(() => resolveResult);
    const candidates: TerminalFileLinkResolveCandidate[] = [
      {
        id: "candidate-1",
        rawPath: "src/App.tsx",
        linkText: "src/App.tsx:12",
        startIndex: 0,
        endIndex: "src/App.tsx:12".length,
        hasSuffix: true,
        baseCwd: "/repo/old"
      }
    ];
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      resolveTerminalFileLinks
    });

    const handler = handlers.get("kmux:terminal-file-links:resolve");

    expect(handler).toBeTypeOf("function");
    await expect(
      Promise.resolve(handler?.({}, "surface-1", candidates))
    ).resolves.toBe(resolveResult);
    expect(resolveTerminalFileLinks).toHaveBeenCalledWith(
      "surface-1",
      candidates
    );
  });

  it("activates terminal file links only from the trusted main frame", async () => {
    const activateTerminalFileLink = vi.fn(async () => undefined);
    registerTestHandlers({
      snapshot: { updatedAt: "2026-05-13T12:00:00.000Z", sessions: [] },
      resumeResult: { workspaceId: "workspace-1", surfaceId: "surface-1" },
      activateTerminalFileLink
    });
    const handler = handlers.get("kmux:resource:activate-terminal-file-link")!;
    const mainFrame = { detached: false, isDestroyed: () => false };
    const event = {
      senderFrame: mainFrame,
      sender: { id: 7, mainFrame }
    } as unknown as IpcMainInvokeEvent;
    const request = {
      sourceSurfaceId: "surface-1",
      rawPath: "README.md"
    };

    await expect(
      Promise.resolve(handler(event, request))
    ).resolves.toBeUndefined();
    expect(activateTerminalFileLink).toHaveBeenCalledWith(
      event.sender,
      request
    );
    expect(() =>
      handler(
        {
          senderFrame: { ...mainFrame },
          sender: { id: 7, mainFrame }
        } as unknown as IpcMainInvokeEvent,
        request
      )
    ).toThrow(/trusted main frame/u);
  });
});
