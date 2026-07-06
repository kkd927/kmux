import { describe, expect, it, vi } from "vitest";

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { buildDefaultShortcuts } from "@kmux/ui";

import type {
  CreateImageAttachmentsResult,
  CreateImageAttachmentPayload,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  SurfaceCapturePayload,
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult
} from "@kmux/proto";
import { createRendererPlatformDescriptor } from "../shared/platform/rendererPlatform";

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
  resolveTerminalFileLinks?: (
    surfaceId: string,
    candidates: TerminalFileLinkResolveCandidate[]
  ) => Promise<TerminalFileLinkResolveResult> | TerminalFileLinkResolveResult;
  isSurfaceDiagnosticsEnabled?: () => boolean;
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
    dispatchAppAction: vi.fn(),
    attachSurface: vi.fn(),
    completeAttachSurface: options.completeAttachSurface ?? vi.fn(),
    snapshotSurface: vi.fn(),
    detachSurface: vi.fn(),
    sendText: vi.fn(),
    sendKeyInput: vi.fn(),
    openExternalUrl: options.openExternalUrl ?? vi.fn(),
    openTerminalFilePath: options.openTerminalFilePath ?? vi.fn(),
    resolveTerminalFileLinks:
      options.resolveTerminalFileLinks ?? vi.fn(() => ({ links: [] })),
    resizeSurface: options.resizeSurface ?? vi.fn(),
    identify: vi.fn(),
    listTerminalFontFamilies: vi.fn(),
    previewTerminalTypography: vi.fn(),
    reportTerminalTypographyProbe: vi.fn(),
    importTerminalThemePalette: vi.fn(),
    exportTerminalThemePalette: vi.fn(),
    openSettingsJson: vi.fn(),
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
        renderer: { ok: false },
        timings: {
          snapshotCompletedAt: "2026-05-27T00:00:00.000Z",
          rendererCompletedAt: "2026-05-27T00:00:00.000Z"
        },
        contentConsistency: {
          verdict: "indeterminate" as const,
          sampledLines: 0,
          matchedLines: 0
        },
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
      renderer: { ok: true },
      timings: {
        snapshotCompletedAt: "2026-05-27T00:00:00.000Z",
        rendererCompletedAt: "2026-05-27T00:00:00.000Z"
      },
      contentConsistency: {
        verdict: "indeterminate" as const,
        sampledLines: 0,
        matchedLines: 0
      },
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
      43,
      undefined
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
});
