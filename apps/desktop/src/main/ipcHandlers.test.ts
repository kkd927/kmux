import { describe, expect, it, vi } from "vitest";

import type {
  CreateImageAttachmentsResult,
  CreateImageAttachmentPayload,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  SurfaceCapturePayload
} from "@kmux/proto";
import { createRendererPlatformDescriptor } from "../shared/platform/rendererPlatform";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn()
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
  completeAttachSurface?: (
    contentsId: number,
    surfaceId: string,
    attachId: string,
    expectedSessionId: string
  ) => Promise<{ status: "ready" }>;
  resizeSurface?: (
    contentsId: number,
    surfaceId: string,
    attachId: string | null,
    cols: number,
    rows: number
  ) => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
  openTerminalFilePath?: (
    surfaceId: string,
    rawPath: string,
    baseCwd?: string
  ) => Promise<void>;
  surfaceDiagnosticsEnabled?: boolean;
  captureSurfaceDiagnostics?: (
    surfaceId: string
  ) => Promise<SurfaceCapturePayload>;
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
    dispatchAppAction: vi.fn(),
    attachSurface: vi.fn(),
    completeAttachSurface: options.completeAttachSurface ?? vi.fn(),
    snapshotSurface: vi.fn(),
    detachSurface: vi.fn(),
    sendText: vi.fn(),
    sendKeyInput: vi.fn(),
    openExternalUrl: options.openExternalUrl ?? vi.fn(),
    openTerminalFilePath: options.openTerminalFilePath ?? vi.fn(),
    resizeSurface: options.resizeSurface ?? vi.fn(),
    identify: vi.fn(),
    listTerminalFontFamilies: vi.fn(),
    previewTerminalTypography: vi.fn(),
    reportTerminalTypographyProbe: vi.fn(),
    importTerminalThemePalette: vi.fn(),
    exportTerminalThemePalette: vi.fn(),
    openSettingsJson: vi.fn(),
    surfaceDiagnosticsEnabled: options.surfaceDiagnosticsEnabled ?? false,
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
        renderer: { ok: false }
      })),
    prepareWorktreeConversion: vi.fn(),
    createWorktreeWorkspace: vi.fn(),
    convertDetectedWorktree: vi.fn(),
    removeWorkspaceWorktree: vi.fn(),
    removeWorkspaceWorktrees: vi.fn(),
    setUsageDashboardOpen: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    installDownloadedUpdate: vi.fn(),
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
      renderer: { ok: true }
    }));
    registerTestHandlers({
      snapshot,
      resumeResult,
      surfaceDiagnosticsEnabled: true,
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
      surfaceDiagnosticsEnabled: false,
      captureSurfaceDiagnostics
    });

    await expect(
      Promise.resolve(
        handlers.get("kmux:surface-diagnostics:capture")?.({}, "surface_debug")
      )
    ).rejects.toThrow("development builds");
  });

  it("registers attach completion handler", async () => {
    const completeAttachSurface = vi.fn(async () => ({
      status: "ready" as const
    }));
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      completeAttachSurface
    });

    const handler = handlers.get("kmux:attach-surface-complete");

    expect(handler).toBeTypeOf("function");
    await expect(
      Promise.resolve(
        handler?.({ sender: { id: 44 } }, "surface-1", "attach-1", "session-1")
      )
    ).resolves.toEqual({ status: "ready" });
    expect(completeAttachSurface).toHaveBeenCalledWith(
      44,
      "surface-1",
      "attach-1",
      "session-1"
    );
  });

  it("routes resize requests with sender and attach identity", async () => {
    const resizeSurface = vi.fn(async () => {});
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      resizeSurface
    });

    const handler = handlers.get("kmux:terminal:resize");

    expect(handler).toBeTypeOf("function");
    await Promise.resolve(
      handler?.({ sender: { id: 44 } }, "surface-1", "attach-1", 132, 43)
    );
    expect(resizeSurface).toHaveBeenCalledWith(
      44,
      "surface-1",
      "attach-1",
      132,
      43
    );
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
    await Promise.resolve(handler?.({ sender }, "https://example.com/path"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/path");
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
});
